// Local BM25 with identifier splitting and a small, deterministic vocabulary.
// This is a shortlist, not an exhaustive semantic decision; coverage is reported.
const stop = new Set('a an the is are was were to of in on for from with where how does do this that it and or code function files file find which'.split(' '));
const groups = ['auth authentication authenticate login signin session', 'retry retries backoff attempt', 'cache cached caching memo memoize', 'delete remove cleanup unlink', 'permission permissions authorization authorize access allowed', 'expire expired expires expiration expiry timeout ttl', 'save persist persistence storage store write', 'error errors failure failed exception throw catch', 'payment payments billing subscription invoice charge', 'cancel abort cancellation', 'parallel concurrent concurrency simultaneous', 'duplicate duplicates deduplicate dedup unique'];
const vocabulary = new Map(groups.flatMap(group => { const terms = group.split(' '); return terms.map(t => [t, terms]); }));
export function terms(text) {
  return text.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(t => t.length > 1 && !stop.has(t)) || [];
}
export function rank(query, candidates) {
  const original = new Set(terms(query));
  const weights = new Map([...original].map(t => [t, 1]));
  for (const t of original) for (const synonym of vocabulary.get(t) || []) if (!weights.has(synonym)) weights.set(synonym, 0.3);
  const docs = candidates.map(c => {
    const body = terms(c.text), meta = terms(`${c.path} ${c.symbol || ''}`);
    const frequency = new Map();
    for (const word of body) frequency.set(word, (frequency.get(word) || 0) + 1);
    for (const word of meta) frequency.set(word, (frequency.get(word) || 0) + 3);
    return { frequency, length: body.length + meta.length };
  });
  const average = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1) || 1;
  const df = new Map();
  for (const d of docs) for (const t of weights.keys()) if (d.frequency.has(t)) df.set(t, (df.get(t) || 0) + 1);
  return candidates.map((c, i) => {
    let retrievalScore = 0;
    for (const [word, weight] of weights) {
      const tf = docs[i].frequency.get(word) || 0;
      const idf = Math.log(1 + (docs.length - (df.get(word) || 0) + 0.5) / ((df.get(word) || 0) + 0.5));
      retrievalScore += weight * idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * docs[i].length / average));
    }
    return { ...c, retrievalScore };
  }).sort((a, b) => b.retrievalScore - a.retrievalScore || a.path.localeCompare(b.path) || a.line - b.line);
}
