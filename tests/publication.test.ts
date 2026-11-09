import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { verifyIndex, verifyCommit, sensitiveContent } = await import(pathToFileURL(resolve('scripts/setup-github.mjs')).href);
const execute = promisify(execFile);
let root: string;
const git = async (args: string[]) => (await execute('git', args, { cwd: root })).stdout;
async function snapshot() {
  const names = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
  return { files: Object.fromEntries(await Promise.all(names.map(async name => [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])))};
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-publication-test-'));
  await git(['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(root, '.gitignore'), 'credentials.json\nartifacts/\n');
  await writeFile(join(root, 'README.md'), '# Public source\n');
  await git(['add', '--all']);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('initial-publication guard', () => {
  it('validates the exact index and ignores local credentials', async () => {
    await writeFile(join(root, 'credentials.json'), JSON.stringify({ token: 'ghp_' + 'a'.repeat(36) }));
    await git(['add', '--all']);
    const manifest = await snapshot();
    expect(await verifyIndex(manifest, git)).toBe(2);
    expect(manifest.files['credentials.json']).toBeUndefined();
  });
  it('stops if content or the file list changes after review', async () => {
    const manifest = await snapshot();
    await writeFile(join(root, 'README.md'), 'changed');
    await git(['add', '--all']);
    await expect(verifyIndex(manifest, git)).rejects.toThrow('changed after the audit');
    await writeFile(join(root, 'unreviewed.md'), 'extra');
    await git(['add', '--all']);
    await expect(verifyIndex(manifest, git)).rejects.toThrow('file list differs');
  });
  it('refuses sensitive staged content even if its hash was included', async () => {
    await writeFile(join(root, 'README.md'), 'ghp_' + 'a'.repeat(36));
    await git(['add', '--all']);
    await expect(verifyIndex(await snapshot(), git)).rejects.toThrow('GitHub token');
  });
  it('audits committed bytes separately from the staging area', async () => {
    const manifest = await snapshot();
    await git(['-c', 'user.name=Codex', '-c', 'user.email=noreply@openai.com', 'commit', '-m', 'test: create publication fixture', '-m', 'Exercise committed-tree auditing without publishing data.', '-m', 'Co-authored-by: Codex <noreply@openai.com>']);
    expect(await verifyCommit(manifest, git)).toBe(2);
    await writeFile(join(root, 'README.md'), 'uncommitted change');
    await git(['add', '--all']);
    const modified = await snapshot();
    expect(await verifyIndex(modified, git)).toBe(2);
    await expect(verifyCommit(modified, git)).rejects.toThrow('changed after the audit');
  });
  it('runs the check-only command without creating a commit or accessing GitHub', async () => {
    await mkdir(join(root, 'artifacts'));
    await writeFile(join(root, 'artifacts/publication-manifest.json'), JSON.stringify(await snapshot()));
    await execute(process.execPath, [resolve('scripts/setup-github.mjs'), '--check'], { cwd: root });
    await expect(git(['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
    expect(await git(['remote'])).toBe('');
  });
  it('permits verified noreply attribution and SSH examples', () => {
    expect(sensitiveContent('Co-authored-by: Codex <noreply@openai.com>')).toBeUndefined();
    expect(sensitiveContent('git@github.com:owner/repository.git')).toBeUndefined();
    expect(sensitiveContent('71451529+ernando760@users.noreply.github.com')).toBeUndefined();
  });
});
