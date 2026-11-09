import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
await build({
  entryPoints: ['cli/entry.ts'], outfile: 'dist/obsidian-mcp-cli.mjs',
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  minify: true, sourcemap: false, logLevel: 'info',
});
await chmod('dist/obsidian-mcp-cli.mjs', 0o755);
