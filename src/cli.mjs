#!/usr/bin/env node
import { login, logout, status } from './auth.mjs';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { search } from './search.mjs';

const help = `jevgrep — semantic code search for agents and humans

Usage: jg [options] "search intent" [paths...]
       cat file | jg "search intent" -
       jg exact [ripgrep arguments...]
       jg mcp [workspace-root]
       jg login | logout | status

  --threshold N    Minimum match probability (default 0.7; not calibrated)
  --limit N        Maximum results (default 10)
  --candidates N   Locally ranked snippets to judge (default 48, max 256)
  --all            Judge every eligible snippet in the paths (no shortlist)
  --max-evaluations N  Fail before requests if scan exceeds budget (all: 20000; otherwise: 256)
  --broad          Judge all discovered snippets, up to 256; no shortlist
  --chunk-lines N  Use line windows instead of syntax-aware chunks
  --max-chunks N   Discovery ceiling (default 20000)
  -g, --glob GLOB  Ripgrep file glob, repeatable (directory searches)
  --no-cache       Bypass the ten-minute probability cache
  --json          Full results plus coverage and timing as JSON
  --full          Print complete matching snippets (default: 20-line excerpts)
  --files         Print unique matching filenames
  --dry-run       Preview selected snippets; no login or API call
  -h, --help      Show help

JS/TS and Python use syntax boundaries; other files use overlapping windows.
Stdin defaults to individual lines. Directories respect rg ignore rules.
Source is sent through jevgate and Vercel AI Gateway to Jev.
Use exact/ripgrep for exhaustive literal/regex matches. Semantic absence is uncertain.
Exit codes: 0 matches/preview, 1 no matches, 2 error, 130 interrupted.
`;
const clean = text => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
async function main() {
  const command = process.argv[2];
  if (command === 'exact') {
    const child = spawn('rg', process.argv.slice(3), { stdio: 'inherit' });
    child.on('error', () => { console.error('jg: install ripgrep (rg) to use exact search.'); process.exitCode = 2; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 2); });
    return;
  }
  if (command === 'mcp') {
    if (process.argv.length > 4) throw new Error('jg mcp accepts one workspace root.');
    return (await import('./mcp.mjs')).startMcp(process.argv[3] || process.cwd());
  }
  if (['login', 'logout', 'status'].includes(command)) {
    if (process.argv.length !== 3) throw new Error(`jg ${command} takes no arguments. Put -- before a query named ${command}.`);
    return ({ login, logout, status })[command]();
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, full: { type: 'boolean' }, files: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, broad: { type: 'boolean' }, all: { type: 'boolean' }, 'max-evaluations': { type: 'string' }, 'no-cache': { type: 'boolean' },
    glob: { type: 'string', short: 'g', multiple: true }, threshold: { type: 'string', default: '0.7' }, limit: { type: 'string', default: '10' }, candidates: { type: 'string', default: '48' }, 'chunk-lines': { type: 'string' }, 'max-chunks': { type: 'string', default: '20000' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.json && values.files) throw new Error('Choose --json or --files.');
  const [query, ...paths] = positionals;
  if (!query?.trim()) throw new Error('Provide a search intent. Run jg --help for usage.');
  const threshold = Number(values.threshold);
  if (!values.threshold.trim() || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('--threshold must be between 0 and 1.');
  const positive = name => {
    const n = Number(values[name]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer.`);
    return n;
  };
  if (values.all && values.broad) throw new Error('Choose --all or --broad.');
  if (values.all && values.candidates !== '48') throw new Error('--candidates does not apply to --all. Use --max-evaluations as a budget.');
  const candidateLimit = positive('candidates');
  if (candidateLimit > 256) throw new Error('--candidates must be at most 256.');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const options = { threshold, limit: positive('limit'), candidateLimit, chunkLines: values['chunk-lines'] ? positive('chunk-lines') : undefined, maxChunks: positive('max-chunks'), globs: values.glob, broad: values.broad, all: values.all, maxEvaluations: values['max-evaluations'] ? positive('max-evaluations') : undefined, dryRun: values['dry-run'], useCache: !values['no-cache'], signal: controller.signal };
  if (paths.includes('-') || (!values.all && !paths.length && !process.stdin.isTTY)) {
    if (paths.length > 1) throw new Error('Use stdin alone; do not mix - with paths.');
    let bytes = 0; const parts = [];
    for await (const part of process.stdin) { bytes += part.length; if (bytes > 1024 * 1024) throw new Error('stdin exceeds 1 MiB; narrow the input.'); parts.push(part); }
    const data = Buffer.concat(parts);
    if (data.includes(0)) throw new Error('stdin contains binary data.');
    options.input = new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  if (values.all && !values['dry-run']) options.onProgress = ({ completed, total, requests, cacheHits }) => console.error(`jg: ${completed}/${total} snippets evaluated, ${cacheHits} cached, ${requests} requests`);
  const result = await search(query, paths.length ? paths : ['.'], options);
  if (values.json || values['dry-run']) console.log(JSON.stringify(result, null, 2));
  else if (values.files) for (const path of new Set(result.matches.map(m => m.path))) console.log(clean(path));
  else for (const match of result.matches) {
    console.log(clean(`${match.path}:${match.line}-${match.endLine} (${match.probability.toFixed(3)})${match.symbol ? ` ${match.symbol}` : ''}`));
    const lines = match.text.split('\n');
    console.log(clean((values.full ? lines : lines.slice(0, 20)).map((line, i) => `${match.line + i}: ${line}`).join('\n')));
    if (!values.full && lines.length > 20) console.log('… use --full or read the source range');
    console.log();
  }
  if (!values['dry-run']) console.error(`jg: ${result.coverage.evaluated}/${result.coverage.snippets} snippets judged, ${result.stats.cacheHits || 0} cached, ${result.stats.requests || 0} requests, ${result.stats.elapsedMs}ms`);
  for (const warning of result.warnings) console.error(`jg: ${warning}`);
  if (!values['dry-run'] && !result.matches.length) process.exitCode = 1;
}
main().catch(err => { console.error(`jg: ${err.message}`); process.exitCode = err.name === 'AbortError' ? 130 : 2; });
