import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Notes } from '../vault/notes';

const path = z.string().min(1).max(1024).describe('Vault-relative Markdown path, e.g. MCP/example.md');
const limit = z.number().int().min(1).max(200);
export function createMcpServer(notes: Notes, version: string): McpServer {
  const server = new McpServer({ name: 'obsidian-mcp', version }, { maxToolInputElements: 10_000 });
  const run = async (action: () => Promise<unknown>, failure = 'Operation failed. Check the authorized folder, Markdown path, note size and whether the note or parent folder exists.') => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
    catch { return { isError: true, content: [{ type: 'text' as const, text: failure }] }; }
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('list_notes', {
    description: 'List authorized Markdown notes in path order, with pagination.',
    inputSchema: { offset: z.number().int().min(0).default(0), limit: limit.default(100) }, annotations: readOnly,
  }, ({ offset, limit }) => run(() => notes.list(offset, limit)));
  server.registerTool('read_note', {
    description: 'Read an authorized Markdown note (maximum 1 MiB).', inputSchema: { path }, annotations: readOnly,
  }, ({ path }) => run(() => notes.read(path)));
  server.registerTool('search_notes', {
    description: 'Find a literal case-insensitive substring in authorized note paths or contents. Skips notes over 1 MiB.',
    inputSchema: { query: z.string().trim().min(1).max(500), limit: limit.default(50) }, annotations: readOnly,
  }, ({ query, limit }) => run(() => notes.search(query, limit)));
  server.registerTool('create_note', {
    description: 'Create a new authorized Markdown note. Parent folder must exist. Never overwrites. Maximum 1 MiB.',
    inputSchema: { path, content: z.string().max(1024 * 1024) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ path, content }) => run(() => notes.create(path, content)));
  server.registerTool('create_folder', {
    description: 'Create an authorized folder. Parent folder must exist. Returns created: false if the folder already exists.',
    inputSchema: { path: z.string().min(1).max(1024).describe('Vault-relative folder path, e.g. MCP/projects') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ path }) => run(() => notes.createFolder(path), 'Operation failed. Check the authorized folder, folder path and whether the parent folder exists or the path is occupied by a file.'));
  return server;
}
