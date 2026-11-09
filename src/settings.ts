import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { safeRelativePath } from './vault/policy';

const schema = z.object({
  port: z.number().int().min(1024).max(65535).default(27124),
  token: z.string().regex(/^[a-f0-9]{64}$/, 'Token must contain 64 lowercase hex characters'),
  allowedFolders: z.array(z.string().refine(p => {
    try { safeRelativePath(p); return true; } catch { return false; }
  }, 'Use explicit relative folders without hidden or traversal components')).default(['MCP']),
}).strict();
export type Settings = z.infer<typeof schema>;
export function loadSettings(data: unknown): Settings {
  if (data == null) return schema.parse({ token: randomBytes(32).toString('hex') });
  return schema.parse(data);
}
