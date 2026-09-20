import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const cacheDirectory = () => process.env.JEVGREP_CACHE_DIR || join(homedir(), '.cache', 'jevgrep');
export async function cached(key, directory = cacheDirectory()) {
  try {
    const entry = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'));
    if (entry.expires > Date.now()) return entry.value;
  } catch { /* A damaged/unavailable cache is just a miss. */ }
}
export async function cache(key, value, ttl = 600000, directory = cacheDirectory()) {
  const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ expires: Date.now() + ttl, value }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, `${key}.json`));
  } catch { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function prune(directory = cacheDirectory()) {
  try {
    const files = (await readdir(directory)).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
    // Bound the cache without storing source code or queries in it.
    for (const file of files.slice(0, 64)) {
      try { const entry = JSON.parse(await readFile(join(directory, file), 'utf8')); if (entry.expires <= Date.now()) await rm(join(directory, file), { force: true }); } catch { /* race */ }
    }
    if (files.length > 5000) for (const file of files.slice(0, files.length - 5000)) await rm(join(directory, file), { force: true });
  } catch { /* optional */ }
}
