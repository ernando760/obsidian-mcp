import metadata from '../package.json';

export function repositoryName(repository: unknown): string | undefined {
  if (repository === undefined || repository === null) return undefined;
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown }).url;
  if (typeof url !== 'string') throw new Error('package.json.repository deve identificar o repositório oficial no GitHub.');
  const name = url.replace(/^git\+/, '').replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(name) || /\/(?:\.|\.\.)$/.test(name)) throw new Error('Repositório oficial inválido em package.json.repository.');
  return name;
}
export const officialRepository = repositoryName((metadata as { repository?: unknown }).repository);
export function releaseRepository(explicit?: string, environment?: string, previous?: string): string | undefined {
  return explicit ?? (environment || undefined) ?? previous ?? officialRepository;
}
