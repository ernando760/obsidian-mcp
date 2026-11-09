import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const expectedRepository = 'ernando760/obsidian-mcp';
export async function command(file, args, options = {}) {
  return (await execute(file, args, { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024, ...options })).stdout;
}
export function sensitiveContent(content) {
  const checks = [
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/],
    ['API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
    ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b/],
    ['URL credentials', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
    ['personal local path', /\/home\/ernandomfr|\/Users\/ernandomfr/],
  ];
  for (const [category, pattern] of checks) if (pattern.test(content)) return category;
  for (const match of content.matchAll(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g)) {
    if (match[0] !== 'noreply@openai.com' && match[0] !== 'git@github.com' && !match[0].endsWith('@users.noreply.github.com')) return 'email requiring review';
  }
  return undefined;
}
export async function verifyIndex(manifest, git = args => command('git', args)) {
  const index = (await git(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) ([a-f0-9]+) 0\t(.+)$/s);
    if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Index contains an unsupported entry; review it before publishing.');
    return { path: match[3], hash: match[2] };
  });
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(index.map(entry => entry.path).sort()) !== JSON.stringify(expected)) throw new Error('Staged file list differs from the audited publication manifest.');
  for (const entry of index) {
    const content = await git(['cat-file', 'blob', entry.hash]);
    if (content.includes('\0')) throw new Error(`Binary file requires manual review: ${entry.path}`);
    if (createHash('sha256').update(content).digest('hex') !== manifest.files[entry.path]) throw new Error(`Staged content changed after the audit: ${entry.path}`);
    const category = sensitiveContent(content);
    if (category) throw new Error(`Sensitive content requires review: ${entry.path} (${category}). No value is printed.`);
  }
  return index.length;
}
export async function verifyCommit(manifest, git = args => command('git', args)) {
  const tree = (await git(['ls-tree', '-r', '-z', 'HEAD'])).split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]+)\t(.+)$/s);
    if (!match) throw new Error('Committed tree contains an unsupported entry.');
    return `${match[1]} ${match[2]} 0\t${match[3]}\0`;
  }).join('');
  return verifyIndex(manifest, args => args[0] === 'ls-files' ? Promise.resolve(tree) : git(args));
}
export async function verifyRepositoryRoot(top, cwd = process.cwd()) {
  const canonical = path => realpath(path).then(value => process.platform === 'win32' ? value.toLowerCase() : value);
  if (await canonical(top) !== await canonical(cwd)) throw new Error('Refusing to operate on a parent repository.');
}
export async function setup() {
  const manifest = JSON.parse(await readFile('artifacts/publication-manifest.json', 'utf8'));
  const top = (await command('git', ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
  if (top) await verifyRepositoryRoot(top);
  const history = (await command('git', ['rev-list', '--all', '--count']).catch(() => '0')).trim();
  if (!['0', '1'].includes(history)) throw new Error('Existing history requires a separate audit. Nothing was pushed.');
  if (process.argv.includes('--check')) {
    console.log(`Verified ${await verifyIndex(manifest)} staged files; ${history} commits in local history.`);
    return;
  }
  const profile = JSON.parse(await command('gh', ['api', 'user', '--jq', '{login,id,name}']));
  if (`${profile.login}/obsidian-mcp` !== expectedRepository || !Number.isSafeInteger(profile.id)) throw new Error('Authenticated account does not match the intended repository.');
  await command('git', ['init', '--initial-branch=main']);
  if (history === '0') await command('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const name = (await command('git', ['config', '--get', 'user.name']).catch(() => '')).trim() || profile.name || profile.login;
  await command('git', ['config', '--local', 'user.name', name]);
  // GitHub's verified ID+login noreply form keeps the personal email private.
  await command('git', ['config', '--local', 'user.email', `${profile.id}+${profile.login}@users.noreply.github.com`]);
  const remote = (await command('git', ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const url = `https://github.com/${expectedRepository}.git`;
  if (remote && remote !== url) throw new Error('Existing origin differs from the intended repository; it was not replaced.');
  if (!remote) await command('git', ['remote', 'add', 'origin', url]);
  if (history === '0') await command('git', ['add', '--all']);
  else {
    if ((await command('git', ['branch', '--show-current'])).trim() !== 'main') throw new Error('Existing branch must be main.');
    await command('git', ['diff', '--quiet']);
    await command('git', ['diff', '--cached', '--quiet', 'HEAD']);
  }
  console.log(`Audited ${await verifyIndex(manifest)} staged files; no sensitive patterns detected.`);
  const message = 'feat: initialize Obsidian MCP\n\nAdd the Obsidian MCP plugin, authenticated local server and cross-platform\ninstallers. Include release checks, documentation and automated tests.\n\nCo-authored-by: Codex <noreply@openai.com>\n';
  await writeFile('artifacts/initial-commit-message.txt', message, { mode: 0o600 });
  if (history === '0') await command('git', ['commit', '--file', 'artifacts/initial-commit-message.txt']);
  if ((await command('git', ['rev-list', '--all', '--count'])).trim() !== '1') throw new Error('Expected exactly one initial commit. Nothing was pushed.');
  await verifyIndex(manifest);
  await verifyCommit(manifest);
  const body = (await command('git', ['log', '-1', '--format=%B'])).trimEnd();
  if (!/^[^\n]{1,72}\n\n[\s\S]+\n\nCo-authored-by: Codex <noreply@openai\.com>$/.test(body)) throw new Error('Initial commit does not follow AGENTS.md. Nothing was pushed.');
  const identity = await command('git', ['log', '-1', '--format=%ae%n%ce%n%B']);
  if (sensitiveContent(identity)) throw new Error('Commit metadata requires privacy review. Nothing was pushed.');
  const metadata = await command('gh', ['repo', 'view', expectedRepository, '--json', 'isPrivate,isEmpty']).catch(() => undefined);
  if (metadata) {
    const repo = JSON.parse(metadata);
    if (repo.isPrivate) throw new Error('Remote is private. It was not made public.');
    if (!repo.isEmpty) {
      const current = (await command('git', ['rev-parse', 'HEAD'])).trim();
      const published = (await command('gh', ['api', `repos/${expectedRepository}/commits/main`, '--jq', '.sha'])).trim();
      if (current !== published) throw new Error('Remote contains a different history. Nothing was pushed.');
    }
  } else await command('gh', ['repo', 'create', expectedRepository, '--public', '--description', 'Authenticated local MCP access to authorized Obsidian notes.']);
  await command('git', ['-c', 'credential.https://github.com.helper=!gh auth git-credential', '-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', '--set-upstream', 'origin', 'refs/heads/main:refs/heads/main']);
  const localHead = (await command('git', ['rev-parse', 'HEAD'])).trim();
  const remoteHead = (await command('gh', ['api', `repos/${expectedRepository}/commits/main`, '--jq', '.sha'])).trim();
  if (localHead !== remoteHead) throw new Error('Push verification failed. Check the remote branch before retrying.');
  console.log(`Initial main branch pushed to https://github.com/${expectedRepository}. No tags or releases were created.`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  setup().catch(error => { console.error(`Setup stopped: ${error.message}`); process.exitCode = 1; });
}
