import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { search } from './search.mjs';

export async function startMcp(root) {
  root = await realpath(root);
  const server = new McpServer({ name: 'jevgrep', version: '0.3.0' }, { instructions: 'Use search_code to locate code by behavior when exact names are unknown. Use ripgrep for exact symbols, regex, and exhaustive references. Read returned source before editing. Shortlisted or skipped coverage cannot establish absence; use all=true to evaluate every eligible snippet, or narrow paths. Source snippets go to the configured hosted Jev service.' });
  server.registerTool('search_code', {
    title: 'Search code by intent',
    description: 'Find current workspace source snippets matching a behavior or concept. Returns exact paths and ranges, probabilities, and coverage. Reads current working files including uncommitted edits. Sends source to the hosted Jev service. Does not prove absence or correctness.',
    inputSchema: { query: z.string().min(1).max(2000), paths: z.array(z.string()).min(1).max(20).default(['.']), limit: z.number().int().min(1).max(10).default(5), threshold: z.number().min(0).max(1).default(0.7), broad: z.boolean().default(false), all: z.boolean().default(false).describe('Evaluate every eligible snippet in the scoped paths without lexical shortlisting; may take minutes.'), max_evaluations: z.number().int().min(1).max(20000).optional(), dry_run: z.boolean().default(false), no_cache: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, paths, limit, threshold, broad, all, max_evaluations, dry_run, no_cache }, extra) => {
    try {
      const resolved = [];
      for (const path of paths) {
        const full = await realpath(resolve(root, path));
        const rel = relative(root, full);
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Search paths must stay inside the configured workspace root.');
        resolved.push(full);
      }
      const result = await search(query, resolved, { limit, threshold, broad, all, maxEvaluations: max_evaluations, dryRun: dry_run, useCache: !no_cache, signal: extra.signal });
      result.matches = result.matches.map(m => ({ ...m, path: relative(root, m.path), text: m.text.slice(0, 1800), excerptTruncated: m.text.length > 1800 }));
      if (result.candidates) result.candidates = result.candidates.map(m => ({ ...m, path: relative(root, m.path), text: m.text.slice(0, 1800), excerptTruncated: m.text.length > 1800 }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] }; }
  });
  await server.connect(new StdioServerTransport());
}
