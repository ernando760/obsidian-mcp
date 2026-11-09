import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (manifest.version !== pkg.version || (tag && tag.replace(/^v/, '') !== manifest.version)) throw new Error('Release tag, package and manifest versions must match');
const configured = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
const repository = configured?.replace(/^git\+/, '').replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '');
if (!repository || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) || /\/(?:\.|\.\.)$/.test(repository)) {
  throw new Error('Release blocked: configure the confirmed official GitHub repository in package.json.repository. No repository URL is inferred or invented.');
}
await mkdir('release', { recursive: true });
const files = [['main.js', 'main.js'], ['manifest.json', 'manifest.json'], ['dist/obsidian-mcp-cli.mjs', 'obsidian-mcp-cli.mjs'], ['install.sh', 'install.sh'], ['install.ps1', 'install.ps1']];
const sums = [];
for (const [source, name] of files) {
  if (name === 'install.sh') {
    const script = (await readFile(source, 'utf8')).replace(/^official_repo='[^']*'$/m, `official_repo='${repository}'`);
    if (!script.includes(`official_repo='${repository}'`)) throw new Error('POSIX default repository marker is missing');
    await writeFile(`release/${name}`, script, { mode: 0o755 });
  } else if (name === 'install.ps1') {
    const script = (await readFile(source, 'utf8')).replace(/else \{ '[^']*' \}\),/, `else { '${repository}' }),`);
    if (!script.includes(`else { '${repository}' }),`)) throw new Error('PowerShell default repository marker is missing');
    await writeFile(`release/${name}`, script);
  } else await copyFile(source, `release/${name}`);
  sums.push(`${createHash('sha256').update(await readFile(`release/${name}`)).digest('hex')}  ${name}`);
}
await writeFile('release/SHA256SUMS', sums.join('\n') + '\n');
console.log(`Release ${manifest.version} prepared in release/`);
