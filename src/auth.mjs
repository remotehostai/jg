import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const configPath = () => join(process.env.JEVGREP_CONFIG_DIR || join(homedir(), '.jevgrep'), 'config.json');
export function validEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Endpoint must be an HTTPS origin (or localhost for development).');
  return url.origin;
}
export async function credentials() {
  let config = {};
  try { config = JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw new Error('Cannot read jevgrep config.'); }
  const savedEndpoint = config.endpoint === 'https://jevgate.dev' ? undefined : config.endpoint;
  const endpoint = validEndpoint(process.env.JEVGREP_ENDPOINT || savedEndpoint || 'https://jevgrep.com');
  // Saved credentials are bound to their origin, including when overriding endpoints.
  return { endpoint, token: process.env.JEVGREP_TOKEN || (config.endpoint === endpoint ? config.token : undefined), email: config.endpoint === endpoint ? config.email : undefined };
}
async function save(config) {
  const path = configPath();
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
async function request(url, init = {}, fetchImpl = fetch) {
  return fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
}
export async function login({ fetchImpl = fetch, open = openBrowser, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const { endpoint } = await credentials();
  const response = await request(`${endpoint}/api/v1/device/start`, { method: 'POST' }, fetchImpl);
  if (!response.ok) throw new Error(`Login failed (HTTP ${response.status}).`);
  const start = await response.json();
  const url = new URL(start.url);
  if (url.origin !== endpoint || typeof start.code !== 'string' || typeof start.poll !== 'string' || !Number.isFinite(start.expires_in) || start.expires_in <= 0) throw new Error('Invalid device login response.');
  console.error(`Sign in to Jevgrep: ${url.href}\nDevice code: ${start.code}`);
  open(url.href);
  const deadline = Date.now() + Math.min(start.expires_in, 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await request(`${endpoint}/api/v1/device/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: start.code, poll: start.poll }) }, fetchImpl);
    if (res.status === 403 || res.status === 410) throw new Error('Login expired. Run jg login again.');
    if (!res.ok) throw new Error(`Login polling failed (HTTP ${res.status}).`);
    const state = await res.json();
    if (state.status === 'done' && typeof state.token === 'string' && state.token) {
      await save({ endpoint, token: state.token, email: state.email });
      console.error(`Signed in${state.email ? ` as ${state.email}` : ''}.`);
      return;
    }
    if (!['pending', 'emailed'].includes(state.status)) throw new Error('Invalid login status.');
  }
  throw new Error('Login timed out. Run jg login again.');
}
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
export async function logout({ fetchImpl = fetch } = {}) {
  const { endpoint, token } = await credentials();
  if (token) {
    const res = await request(`${endpoint}/api/v1/token/revoke`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }, fetchImpl);
    if (!res.ok && res.status !== 401) throw new Error(`Could not revoke login (HTTP ${res.status}). Login retained so you can retry.`);
  }
  await rm(configPath(), { force: true });
  console.error('Signed out of Jevgrep. This CLI token is revoked and the local login is removed.');
}
export async function status() {
  const { endpoint, token, email } = await credentials();
  console.log(`Endpoint: ${endpoint}\nAccount: ${email || 'unknown'}\nLogin: ${token ? 'saved' : 'run jg login'}`);
  if (token) {
    const res = await request(`${endpoint}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Account check failed (HTTP ${res.status}).`);
    console.log('Jevgrep account authenticated.');
  }
}
