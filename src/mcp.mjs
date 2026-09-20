import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { search } from './search.mjs';
import { present } from './output.mjs';

export async function startMcp(root) {
  root = await realpath(root);
  const server = new McpServer({ name: 'jevgrep', version: '0.4.1' }, { instructions: 'Use search_code to locate code by behavior when exact names are unknown. Use ripgrep for exact symbols, regex, and exhaustive references. Read returned source before editing. Shortlisted or skipped coverage cannot establish absence; use all=true to evaluate every eligible snippet, or narrow paths. Source snippets go to the configured hosted Jev service.' });
  server.registerTool('search_code', {
    title: 'Search code by intent',
    description: 'Find current workspace source snippets matching a behavior or concept. Returns exact paths and ranges, compact excerpts, and coverage. Reads current working files including uncommitted edits. Sends source to the hosted Jev service. Does not prove absence or correctness.',
    inputSchema: { query: z.string().min(1).max(2000), paths: z.array(z.string()).min(1).max(20).default(['.']), limit: z.number().int().min(1).max(100).default(5), threshold: z.number().min(0).max(1).default(0.5), broad: z.boolean().default(false), all: z.boolean().default(false).describe('Evaluate every eligible snippet in the scoped paths without lexical shortlisting; may take minutes.'), max_evaluations: z.number().int().min(1).max(20000).optional(), dry_run: z.boolean().default(false), no_cache: z.boolean().default(false), max_output: z.number().int().min(1024).max(64000).default(8000), debug: z.boolean().default(false), full: z.boolean().default(false), dump_candidates: z.boolean().default(false) },
    outputSchema: {
      schemaVersion: z.literal(1),
      matches: z.array(z.object({ path: z.string(), startLine: z.number().int(), endLine: z.number().int(), symbol: z.string().optional(), text: z.string(), excerptTruncated: z.boolean().optional(), sourceEndLine: z.number().int().optional(), probability: z.number().optional() })),
      coverage: z.object({ mode: z.enum(['all', 'broad', 'shortlist']), files: z.number(), evaluated: z.number(), eligible: z.number(), selected: z.number(), skipped: z.number(), selectionComplete: z.boolean(), evaluationComplete: z.boolean() }),
      truncated: z.boolean(), omittedMatches: z.number(), dryRun: z.boolean().optional(),
      plan: z.object({ requests: z.number(), minimumRequestSpanMs: z.number(), excluded: z.array(z.string()) }).optional(),
      diagnostics: z.record(z.string(), z.unknown()).optional(), candidates: z.array(z.record(z.string(), z.unknown())).optional(), omittedCandidates: z.number().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, paths, limit, threshold, broad, all, max_evaluations, dry_run, no_cache, max_output, debug, full, dump_candidates }, extra) => {
    try {
      if (dump_candidates && !dry_run) throw new Error('dump_candidates requires dry_run.');
      const resolved = [];
      for (const path of paths) {
        const full = await realpath(resolve(root, path));
        const rel = relative(root, full);
        if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Search paths must stay inside the configured workspace root.');
        resolved.push(full);
      }
      const result = await search(query, resolved, { limit, threshold, broad, all, maxEvaluations: max_evaluations, dryRun: dry_run, useCache: !no_cache, signal: extra.signal });
      result.matches = result.matches.map(m => ({ ...m, path: relative(root, m.path) }));
      if (result.candidates) result.candidates = result.candidates.map(m => ({ ...m, path: relative(root, m.path) }));
      result.coverage.skippedFiles = result.coverage.skippedFiles.map(m => ({ ...m, path: relative(root, m.path) }));
      const output = present(result, { maxOutput: max_output, debug, full, dryRun: dry_run, dumpCandidates: dump_candidates });
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] }; }
  });
  await server.connect(new StdioServerTransport());
}
