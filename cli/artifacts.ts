import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readOptional } from './files';
import type { Runtime } from './runtime';
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const manifestSchema = z.object({
  id: z.literal('obsidian-mcp'), name: z.string().min(1), version: z.string().regex(versionPattern),
  minAppVersion: z.string().regex(versionPattern), isDesktopOnly: z.literal(true),
}).passthrough();
export type Manifest = z.infer<typeof manifestSchema>;
export interface Artifacts { main: Buffer; manifest: Buffer; info: Manifest; source: 'local' | 'remote'; project?: string; repo?: string; tag?: string }
export function manifest(data: Buffer): Manifest {
  try { return manifestSchema.parse(JSON.parse(data.toString('utf8'))); }
  catch { throw new Error('manifest.json inválido ou não pertence ao plugin Obsidian MCP Desktop.'); }
}
export function compareVersion(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const diff = a[i]! - b[i]!; if (diff) return diff; }
  return 0;
}
export async function localArtifacts(project: string): Promise<Artifacts> {
  project = resolve(project);
  const [main, data] = await Promise.all([readOptional(join(project, 'main.js'), 20 * 1024 * 1024), readOptional(join(project, 'manifest.json'))]);
  if (!main?.length || !data) throw new Error('Artefatos locais ausentes. Execute npm run build no projeto ou use --source remote --repo dono/repositorio.');
  return { main, manifest: data, info: manifest(data), source: 'local', project };
}
async function download(rt: Runtime, url: string, max: number): Promise<Buffer> {
  const response = await rt.fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'obsidian-mcp-installer', Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`Falha no download (${response.status}). Confira o repositório, a release e o limite da API do GitHub.`);
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Download deve usar HTTPS.');
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Download excede o limite permitido.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Resposta vazia do GitHub.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('Download excede o limite permitido.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function remoteArtifacts(rt: Runtime, repo: string | undefined, version?: string): Promise<Artifacts> {
  if (!repo || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) throw new Error('Informe --repo dono/repositorio para uma release pública do GitHub.');
  if (version && !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('--version deve ser uma versão estável, como 0.1.0 ou v0.1.0.');
  const endpoint = version ? `tags/${encodeURIComponent(version)}` : 'latest';
  let release: z.infer<typeof releaseSchema>;
  try { release = releaseSchema.parse(JSON.parse((await download(rt, `https://api.github.com/repos/${repo}/releases/${endpoint}`, 1024 * 1024)).toString('utf8'))); }
  catch (error) { if (error instanceof SyntaxError || error instanceof z.ZodError) throw new Error('Metadados da release inválidos.'); throw error; }
  if (release.draft || release.prerelease) throw new Error('Somente releases estáveis publicadas são aceitas.');
  const asset = (name: string) => {
    const matches = release.assets.filter(a => a.name === name);
    const item = matches[0];
    if (matches.length !== 1 || !item || item.browser_download_url !== `https://github.com/${repo}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`) {
      throw new Error(`Asset ausente, duplicado ou URL inválida: ${name}`);
    }
    return item;
  };
  const mainAsset = asset('main.js'), manifestAsset = asset('manifest.json');
  let sums = '';
  if (![mainAsset, manifestAsset].every(a => /^sha256:[a-f0-9]{64}$/.test(a.digest ?? ''))) {
    sums = (await download(rt, asset('SHA256SUMS').browser_download_url, 16384)).toString('utf8');
  }
  const checked = async (item: typeof mainAsset, max: number) => {
    const data = await download(rt, item.browser_download_url, max);
    const lines = sums.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64}) [ *](\S+)$/)).filter(Boolean);
    const sum = lines.find(line => line![2] === item.name)?.[1];
    const expected = item.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1] ?? sum;
    if (!expected || createHash('sha256').update(data).digest('hex') !== expected) throw new Error(`Checksum inválido: ${item.name}`);
    return data;
  };
  const [main, data] = await Promise.all([checked(mainAsset, 20 * 1024 * 1024), checked(manifestAsset, 65536)]);
  const info = manifest(data);
  if (!main.length || release.tag_name.replace(/^v/, '') !== info.version || (version && release.tag_name !== version)) throw new Error('A versão do manifesto não corresponde à tag da release.');
  return { main, manifest: data, info, source: 'remote', repo, tag: release.tag_name };
}
const releaseSchema = z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(), assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), digest: z.string().nullable().optional() })) });
