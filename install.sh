#!/bin/sh
# Download a verified CLI; all vault/plugin/Codex operations belong to the CLI.
set -eu

usage() {
  cat <<'HELP'
Obsidian MCP — Linux/macOS bootstrap (Node.js 22.12+)
Usage: sh install.sh --repo owner/repository [options]
  --repo <owner/repository>  Official release repository (or OBSIDIAN_MCP_REPOSITORY)
  --version <tag>            Exact stable release tag; defaults to latest
  --vault <path>             Vault path; omitted: CLI discovery/prompt
  --update                   Run CLI update instead of install
  --manual                   Generate manual Codex configuration
  --config-dir <name>        Vault configuration directory
  --port <number>            Port for a new installation
  --name <name>              Codex MCP server name
  --no-enable                Keep the activation list unchanged
  --install-dir <path>       CLI directory (default: per-user application data)
  --bin-dir <path>           Launcher directory (default: ~/.local/bin)
  --help                     Show help
HELP
}
# Filled from package.json.repository when release assets are prepared.
official_repo='ernando760/obsidian-mcp'
repo=${OBSIDIAN_MCP_REPOSITORY:-$official_repo}
version= vault= config_dir= port= name= install_dir= bin_dir=
command=install
manual=false
no_enable=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --update) command=update; shift ;;
    --manual) manual=true; shift ;;
    --no-enable) no_enable=true; shift ;;
    --repo|--version|--vault|--config-dir|--port|--name|--install-dir|--bin-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'Missing value: %s\n' "$1" >&2; exit 1; }
      case "$1" in
        --repo) repo=$2 ;; --version) version=$2 ;; --vault) vault=$2 ;;
        --config-dir) config_dir=$2 ;; --port) port=$2 ;; --name) name=$2 ;;
        --install-dir) install_dir=$2 ;; --bin-dir) bin_dir=$2 ;;
      esac
      shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done
command -v node >/dev/null 2>&1 || { printf 'Install Node.js 22.12+ and rerun this script.\n' >&2; exit 1; }
# This subprocess only bootstraps the CLI. The final exec below retains the
# original terminal input, so the CLI can perform interactive vault selection.
bootstrap_cli() {
node --input-type=module - "$repo" "$version" "$install_dir" "$bin_dir" <<'NODE'
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12+ is required.');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Use install.ps1 on Windows.');
  const [repo, requested, customDir, customBin] = process.argv.slice(2);
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || /\/(?:\.|\.\.)$/.test(repo)) throw new Error('Provide --repo owner/repository (the official release repository).');
  if (requested && !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(requested)) throw new Error('Provide an exact stable --version tag.');
  const download = async (url, max) => {
    for (let hop = 0; hop < 6; hop++) {
      if (new URL(url).protocol !== 'https:') throw new Error('Downloads require HTTPS.');
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'obsidian-mcp-bootstrap' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Invalid download redirect.');
        url = new URL(location, url).href; continue;
      }
      if (!response.ok) throw new Error(`GitHub download failed (${response.status}). Check the repository, tag and API rate limit.`);
      if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Download exceeds size limit.'); }
      if (!response.body) throw new Error('Empty download.');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error('Download exceeds size limit.'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    }
    throw new Error('Too many download redirects.');
  };
  const release = JSON.parse((await download(`https://api.github.com/repos/${repo}/releases/${requested ? `tags/${requested}` : 'latest'}`, 1024 * 1024)).toString('utf8'));
  const tag = release.tag_name;
  if (release.draft !== false || release.prerelease !== false || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || (requested && requested !== tag) || !Array.isArray(release.assets)) throw new Error('Invalid or non-stable release.');
  const asset = name => {
    const matches = release.assets.filter(item => item.name === name);
    if (matches.length !== 1 || matches[0].browser_download_url !== `https://github.com/${repo}/releases/download/${tag}/${name}`) throw new Error(`Missing or invalid release asset: ${name}`);
    return matches[0];
  };
  const cliAsset = asset('obsidian-mcp-cli.mjs');
  const [cli, sums] = await Promise.all([download(cliAsset.browser_download_url, 20 * 1024 * 1024), download(asset('SHA256SUMS').browser_download_url, 65536)]);
  if (!cli.length) throw new Error('The CLI download is empty.');
  const entries = sums.toString('utf8').split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64}) [ *]obsidian-mcp-cli\.mjs$/)).filter(Boolean);
  const hash = createHash('sha256').update(cli).digest('hex');
  if (entries.length !== 1 || entries[0][1] !== hash || (cliAsset.digest != null && cliAsset.digest !== `sha256:${hash}`)) throw new Error('CLI checksum verification failed. Nothing was executed.');
  const dataHome = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
  const installDir = resolve(customDir || join(dataHome, 'obsidian-mcp'));
  const binDir = resolve(customBin || join(homedir(), '.local/bin'));
  if (/[\r\n]/.test(installDir + binDir)) throw new Error('Installation paths cannot contain line breaks.');
  const safe = async path => {
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          if (process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current) && await realpath(current) === `/private${current}`) continue;
          throw new Error(`Symlink installation destination is forbidden: ${current}`);
        }
        if (current !== path && !stat.isDirectory()) throw new Error(`Invalid destination: ${current}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const cliPath = join(installDir, 'obsidian-mcp-cli.mjs'), launcher = join(binDir, 'obsidian-mcp');
  await safe(cliPath); await safe(launcher);
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const atomic = async (target, data, mode) => {
    const temporary = join(dirname(target), `.obsidian-mcp-${randomUUID()}.tmp`);
    try { await writeFile(temporary, data, { flag: 'wx', mode }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  };
  await atomic(cliPath, cli, 0o600);
  const quoted = `'${cliPath.replace(/'/g, `'\\''`)}'`;
  await atomic(launcher, `#!/bin/sh\nexec node ${quoted} "$@"\n`, 0o755);
  console.error(`Verified CLI ${tag} installed. Launcher: ${launcher}`);
  console.error('If the launcher directory is not on PATH, use its full path.');
  process.stdout.write(JSON.stringify({ path: cliPath, tag }));
} catch (error) { console.error(`Installation failed: ${error.message}`); process.exitCode = 1; }
NODE
}
bootstrap=$(bootstrap_cli)
cli_path=$(printf '%s' "$bootstrap" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).path))')
release_tag=$(printf '%s' "$bootstrap" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).tag))')
set -- "$command" --source remote --repo "$repo" --version "$release_tag"
[ -z "$vault" ] || set -- "$@" --vault "$vault"
[ -z "$config_dir" ] || set -- "$@" --config-dir "$config_dir"
[ -z "$port" ] || set -- "$@" --port "$port"
[ -z "$name" ] || set -- "$@" --name "$name"
[ "$manual" = false ] || set -- "$@" --manual
[ "$no_enable" = false ] || set -- "$@" --no-enable
exec node "$cli_path" "$@"
