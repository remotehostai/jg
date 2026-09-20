import { rank } from './retrieve.mjs';
// Shared presentation contract for CLI JSON, terminal output and MCP.
export const DEFAULT_OUTPUT_BYTES = 8000;
export const MAX_OUTPUT_BYTES = 64000;
const clean = text => String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const bytes = value => Buffer.byteLength(value, 'utf8');
const prefix = (text, count) => {
  let end = Math.min(text.length, count);
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
};
// A test that exercises the requested behaviour is real evidence and is ranked
// on its own merit, but an agent asking where something is implemented should
// not have to guess which result is the implementation. Label the result from
// its path only; nothing here changes which snippets matched or their order.
const testPath = /(^|\/)(tests?|specs?|__tests__|testdata|fixtures?)\/|[._-](test|spec)\.[a-z]+$|(^|\/)(test|spec)_[^/]*$|(^|[/._-])smoke\.[a-z]+$/i;
export const evidenceKind = path => (testPath.test(String(path)) ? 'test' : undefined);
function excerpt(item, full, debug, query) {
  const lines = item.text.split('\n');
  let offset = 0;
  if (!full && lines.length > 12) {
    // Prefer the narrower block the model itself judged relevant; search only
    // inside it. Lexical scores localize within that block and never change
    // which snippets matched.
    let first = 0, last = lines.length - 1;
    if (item.evidence) {
      first = Math.max(0, Math.min(lines.length - 1, item.evidence.line - item.line));
      last = Math.max(first, Math.min(lines.length - 1, item.evidence.endLine - item.line));
      offset = first;
    }
    if (query && last - first >= 12) {
      const windows = [];
      for (let i = first; i + 12 <= last + 1 || i === first; i++) windows.push({ path: '', line: i, text: prefix(lines.slice(i, i + 12).join('\n'), 1200) });
      const best = rank(query, windows)[0];
      if (best.retrievalScore > 0) offset = best.line;
    }
  }
  const text = full ? item.text : prefix(lines.slice(offset, offset + 12).join('\n'), 1200);
  const kind = evidenceKind(item.path);
  return { path: item.path, startLine: item.line + offset, endLine: item.line + offset + text.split('\n').length - 1,
    ...(item.symbol ? { symbol: item.symbol } : {}), ...(kind ? { kind } : {}), text,
    ...(text !== item.text ? { excerptTruncated: true, sourceEndLine: item.endLine } : {}),
    ...(debug && item.probability !== undefined ? { probability: item.probability } : {}) };
}
// Source lines are routinely longer than a terminal. Soft-wrapping them breaks
// the gutter, so a wrapped line runs underneath the next line number and the
// two collide. Clip to the terminal instead and mark it, so one source line is
// always one row. Redirected output passes no width and stays byte-for-byte
// complete, which also keeps the output budget independent of the terminal.
const clip = (line, width) => {
  if (!width || line.length <= width) return line;
  const kept = prefix(line, Math.max(1, width - 1));
  return `${kept}…`;
};
export function renderText(result, { width } = {}) {
  width = Number.isSafeInteger(width) && width >= 40 ? width : 0;
  const lines = [];
  for (const match of result.matches) {
    lines.push(clip(`${match.path}:${match.startLine}–${match.endLine}${match.symbol ? `  ${match.symbol}` : ''}${match.kind ? `  [${match.kind}]` : ''}${match.probability !== undefined ? ` (${match.probability.toFixed(3)})` : ''}`, width));
    const gutter = String(match.endLine).length;
    lines.push(...match.text.split('\n').map((line, i) => clip(`  ${String(match.startLine + i).padStart(gutter)} │ ${line}`, width)));
    if (match.excerptTruncated) lines.push(`… excerpt shortened; source ends at line ${match.sourceEndLine}`);
    lines.push('');
  }
  const c = result.coverage;
  if (result.dryRun) {
    lines.push(`preview: ${c.files} files · ${c.selected}/${c.eligible} snippets selected · ${result.plan.requests} estimated API batches`);
    lines.push('No model calls made. Ignored and hidden files are excluded.');
  } else if (!result.matches.length) lines.push(result.omittedMatches ? 'Matches found; none fit the output budget.' : 'No matches. This does not establish absence.');
  lines.push(`coverage: ${c.evaluated}/${c.eligible} snippets evaluated · ${c.mode}${c.skipped ? ` · ${c.skipped} files skipped` : ''}`);
  if (result.truncated) lines.push(`output shortened${result.omittedMatches ? ` · ${result.omittedMatches} matches omitted` : ''}; use --full, raise --limit/--max-output, or read the source`);
  if (result.candidates) lines.push(clip(`candidates: ${JSON.stringify(result.candidates)}`, width));
  if (result.diagnostics) lines.push(clip(`debug: ${JSON.stringify(result.diagnostics)}`, width));
  return clean(lines.join('\n'));
}
export function present(raw, { maxOutput = DEFAULT_OUTPUT_BYTES, full = false, debug = false, dryRun = false, dumpCandidates = false } = {}) {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 1024 || maxOutput > MAX_OUTPUT_BYTES) throw new Error('--max-output must be an integer between 1024 and 64000 bytes.');
  if (dumpCandidates && !dryRun) throw new Error('--dump-candidates requires --dry-run.');
  const c = raw.coverage;
  const result = { schemaVersion: 1, matches: raw.matches.map(m => excerpt(m, full, debug, raw.query)), coverage: {
    mode: c.mode, files: c.files, evaluated: c.evaluated, eligible: c.snippets, selected: c.selected,
    skipped: c.skippedFiles.length, selectionComplete: c.selectedAll, evaluationComplete: c.exhaustive,
  }, truncated: false, omittedMatches: Math.max(0, c.matchingSnippets - raw.matches.length) };
  if (dryRun) {
    result.dryRun = true;
    result.plan = { requests: raw.stats.plannedRequests, minimumRequestSpanMs: raw.stats.minimumRequestSpanMs, excluded: ['ignored files', 'hidden files'] };
  }
  let diagnosticsShortened = false;
  if (debug) {
    result.diagnostics = { stats: raw.stats, parsers: c.parsers, warnings: raw.warnings.slice(0, 5), skippedFiles: c.skippedFiles.slice(0, 5) };
    diagnosticsShortened = raw.warnings.length > 5 || c.skippedFiles.length > 5;
  }
  const update = () => {
    result.omittedMatches = Math.max(0, c.matchingSnippets - result.matches.length);
    result.truncated = diagnosticsShortened || result.omittedMatches > 0 || result.matches.some(m => m.excerptTruncated) || (result.omittedCandidates || 0) > 0;
  };
  const fits = () => { update(); return Math.max(bytes(JSON.stringify(result)), bytes(renderText(result))) + 1 <= maxOutput; };
  // Preserve useful source evidence before optional diagnostic detail.
  if (!fits() && result.diagnostics) { delete result.diagnostics; diagnosticsShortened = true; }
  while (!fits() && result.matches.length) {
    const longest = result.matches.reduce((a, b) => a.text.length > b.text.length ? a : b);
    if (longest.text.length > 160) {
      longest.sourceEndLine ??= longest.endLine;
      longest.text = prefix(longest.text, Math.floor(longest.text.length / 2));
      longest.endLine = longest.startLine + longest.text.split('\n').length - 1;
      longest.excerptTruncated = true;
    } else result.matches.pop();
  }
  if (dumpCandidates) {
    result.candidates = [];
    result.omittedCandidates = raw.candidates?.length || 0;
    for (const item of raw.candidates || []) {
      result.candidates.push(item); result.omittedCandidates--;
      if (!fits()) { result.candidates.pop(); result.omittedCandidates++; break; }
    }
  }
  if (!fits()) throw new Error('Output metadata exceeds --max-output. Raise the output budget.');
  return result;
}
