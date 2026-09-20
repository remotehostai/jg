import { setTimeout as delay } from 'node:timers/promises';
import { credentials, validEndpoint } from './auth.mjs';
import { execFileSync } from 'node:child_process';
import { readFile, stat, realpath } from 'node:fs/promises';
import { chunks, sourceChunks } from './chunks.mjs';
import { rank } from './retrieve.mjs';
import { digest, cached, cache, prune } from './cache.mjs';
export { chunks };

export async function collect(paths, { maxChunks = 20000, chunkLines, globs = [], maxFiles = 20000, maxBytes = 32 * 1024 * 1024, signal } = {}) {
  const files = new Map();
  const add = async path => { files.set(await realpath(path), path); if (files.size > maxFiles) throw new Error(`Search exceeds ${maxFiles} files. Narrow the paths.`); };
  for (const path of paths) {
    signal?.throwIfAborted();
    const info = await stat(path);
    if (info.isFile()) await add(path);
    else if (info.isDirectory()) {
      let output;
      try { output = execFileSync('rg', ['--files', '-0', ...globs.flatMap(g => ['-g', g]), '--', path], { maxBuffer: 16 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (err) {
        if (err.status === 1) continue;
        throw new Error(err.code === 'ENOENT' ? 'ripgrep is required for directory searches (install rg).' : 'ripgrep discovery failed (permissions, timeout or output limit). Narrow the paths.');
      }
      for (const file of output.toString().split('\0').filter(Boolean)) await add(file);
    } else throw new Error(`Not a regular file or directory: ${path}`);
  }
  const candidates = [], skippedFiles = [], parsers = {};
  let bytesRead = 0;
  for (const path of [...files.values()].sort()) {
    signal?.throwIfAborted();
    if ((await stat(path)).size > 1024 * 1024) { skippedFiles.push({ path, reason: 'larger than 1 MiB' }); continue; }
    const bytes = await readFile(path);
    bytesRead += bytes.length;
    if (bytesRead > maxBytes) throw new Error(`Search exceeds ${maxBytes} source bytes. Narrow the paths.`);
    if (bytes.includes(0)) { skippedFiles.push({ path, reason: 'binary' }); continue; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { skippedFiles.push({ path, reason: 'not UTF-8' }); continue; }
    let parsed;
    try { parsed = await sourceChunks(text, path, { chunkLines }); }
    catch (err) { if (!err.message.startsWith('Line exceeds')) throw err; skippedFiles.push({ path, reason: err.message }); continue; }
    parsers[parsed.parser] = (parsers[parsed.parser] || 0) + 1;
    candidates.push(...parsed.chunks);
    if (candidates.length > maxChunks) throw new Error(`Search exceeds ${maxChunks} chunks. Narrow the paths or raise --max-chunks.`);
  }
  return { candidates, skipped: skippedFiles.length, skippedFiles, files: files.size, bytesRead, parsers };
}

export async function score(query, candidates, { token, endpoint, fetchImpl = fetch, useCache = false, concurrency = 3, signal, stats = {} } = {}) {
  if (!query.trim() || query.length > 2000) throw new Error('Query must contain 1–2000 characters.');
  const saved = await credentials();
  token ??= saved.token;
  endpoint = validEndpoint(endpoint ?? saved.endpoint);
  if (!token) throw new Error('Run jg login before searching (or use --dry-run).');
  Object.assign(stats, { requests: 0, retries: 0, cacheHits: 0 });
  const results = [], pending = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const key = digest(['jevgrep-relevance-v3', endpoint, digest(token), query, candidate.text, candidate.context || '']);
    const value = useCache ? await cached(key) : undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) { results.push({ ...candidate, probability: value }); stats.cacheHits++; }
    else pending.push({ candidate, key });
  }
  const batches = [];
  for (let offset = 0; offset < pending.length;) {
    const batch = []; let chars = 0;
    while (offset < pending.length && batch.length < 16) {
      const entry = pending[offset];
      if (entry.candidate.text.length + (entry.candidate.context?.length || 0) > 24000) throw new Error(`Chunk too large: ${entry.candidate.path}:${entry.candidate.line}. Use --chunk-lines 1.`);
      if (chars + entry.candidate.text.length + (entry.candidate.context?.length || 0) > 24000) break;
      batch.push(entry); chars += entry.candidate.text.length + (entry.candidate.context?.length || 0); offset++;
    }
    batches.push(batch);
  }
  let next = 0, failed;
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length && !failed) {
      const batch = batches[next++];
      try {
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          requestSignal.throwIfAborted(); stats.requests++;
          try {
            response = await fetchImpl(`${endpoint}/api/v1/grep`, {
              method: 'POST', signal: AbortSignal.any([requestSignal, AbortSignal.timeout(30000)]), redirect: 'error',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({ query, snippets: batch.map(({ candidate }) => ({ text: candidate.text, ...(candidate.context ? { context: candidate.context } : {}) })) }),
            });
            if (attempt === 1 || ![502, 504].includes(response.status)) break;
          } catch (err) {
            if (attempt === 1 || err.name !== 'TypeError' || requestSignal.aborted) throw err;
          }
          stats.retries++;
          await delay(300, undefined, { signal: requestSignal });
        }
        if (!response.ok) {
          const hints = { 401: 'Run jg login again.', 403: 'Your account needs jevgrep preview access.', 404: 'The search endpoint has not been deployed.', 429: 'Search rate limit reached; wait a minute or narrow the scope.', 503: 'Search preview is not enabled on this server.' };
          throw new Error(`Search failed (HTTP ${response.status}). ${hints[response.status] || 'Try again later.'}`);
        }
        const body = await response.json();
        if (!Array.isArray(body.probabilities) || body.probabilities.length !== batch.length) throw new Error('Invalid Jev answer count.');
        for (let i = 0; i < batch.length; i++) {
          const probability = body.probabilities[i];
          if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Invalid Jev probability for match_${i}.`);
        }
        for (let i = 0; i < batch.length; i++) {
          const probability = body.probabilities[i];
          results.push({ ...batch[i].candidate, probability });
          if (useCache) await cache(batch[i].key, probability);
        }
      } catch (err) { failed ||= err; controller.abort(); }
    }
  }));
  if (failed) throw failed;
  if (useCache) await prune();
  return results.sort((a, b) => b.probability - a.probability || a.path.localeCompare(b.path) || a.line - b.line);
}

export async function search(query, paths, options = {}) {
  const start = performance.now();
  const { limit = 10, threshold = 0.7, candidateLimit = 48, broad = false, dryRun = false, useCache = true } = options;
  if (!query?.trim() || query.length > 2000) throw new Error('Query must contain 1–2000 characters.');
  const source = options.input !== undefined ? { candidates: chunks(options.input, '<stdin>', options.chunkLines || 1), skipped: 0, skippedFiles: [], files: 1, parsers: { lines: 1 } } : await collect(paths, options);
  if (source.candidates.length > (options.maxChunks || 20000)) throw new Error('Input exceeds discovery chunk limit. Narrow the input.');
  const ranked = rank(query, source.candidates);
  const selected = broad ? ranked : ranked.slice(0, candidateLimit);
  if (selected.length > (options.maxEvaluations || 256)) throw new Error('Broad scan exceeds 256 snippets. Narrow the paths. No model calls were made.');
  const stats = {};
  const evaluated = dryRun || !selected.length ? [] : await score(query, selected, { ...options, useCache, stats });
  // Collapse overlapping windows; never merge source text from different regions.
  const matches = [];
  for (const item of evaluated.filter(v => v.probability >= threshold)) {
    if (!matches.some(v => v.path === item.path && v.line <= item.endLine && item.line <= v.endLine)) matches.push(item);
  }
  const warnings = [];
  if (!dryRun && evaluated.length && !matches.length) warnings.push(`No snippet reached threshold ${threshold}; this does not establish absence. Inspect a narrower scope or lower --threshold to review less certain candidates.`);
  if (selected.length < ranked.length) warnings.push(`Shortlisted ${selected.length} of ${ranked.length} snippets using local lexical retrieval. Other snippets were not judged; use --broad or narrower paths when recall matters.`);
  if (source.skipped) warnings.push(`${source.skipped} files skipped; see coverage.skippedFiles.`);
  if (source.parsers['overlapping-lines']) warnings.push('Some files use overlapping line windows because no supported syntax parser was available.');
  return { query, matches: matches.slice(0, limit).map(({ context, retrievalScore, ...match }) => match), coverage: { files: source.files, snippets: ranked.length, evaluated: dryRun ? 0 : selected.length, selected: selected.length, exhaustive: selected.length === ranked.length && !source.skipped, skippedFiles: source.skippedFiles, parsers: source.parsers, matchingSnippets: matches.length, returned: Math.min(matches.length, limit) }, stats: { ...stats, elapsedMs: Math.round(performance.now() - start) }, warnings, ...(dryRun ? { candidates: selected } : {}) };
}
