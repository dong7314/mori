import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()]; }));
const body = async req => {
  if (!req.headers['content-type']?.startsWith('application/json')) throw error(415, 'JSON_REQUIRED', '요청 형식을 확인해 주세요.');
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 8192) throw error(413, 'BODY_TOO_LARGE', '입력 내용이 너무 길어요.'); }
  try { return JSON.parse(data); } catch { throw error(400, 'INVALID_JSON', '입력 내용을 확인해 주세요.'); }
};

export function createServer({ root = resolve(import.meta.dirname, '..'), origin = 'http://localhost:4173', apiBaseUrl = 'http://localhost:8000', fetchImpl = fetch } = {}) {
  const appUrl = new URL(origin), backend = new URL(apiBaseUrl);
  for (const url of [appUrl, backend]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Configure API and app origins without credentials, paths, queries or fragments');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS outside localhost');
  }
  origin = appUrl.origin;
  apiBaseUrl = backend.origin;
  const sessions = new Map(), flows = new Map();
  const secure = appUrl.protocol === 'https:' ? '; Secure' : '';
  const setCookie = (res, name, value, seconds) => res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure}`);
  const cleanup = () => {
    for (const [id, s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
    for (const [id, f] of flows) if (f.expires <= Date.now()) flows.delete(id);
  };
  const upstream = async (path, options = {}) => {
    try { return await fetchImpl(apiBaseUrl + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
    catch { throw error(503, 'CONNECTION_UNAVAILABLE', '모리와 연결이 잠시 끊겼어요. 잠시 후 다시 시도해 주세요.'); }
  };
  const dataOf = async response => {
    let data;
    try { data = await response.json(); } catch { throw error(502, 'INVALID_RESPONSE', '서버 응답을 확인할 수 없어요.'); }
    if (!response.ok) throw error(response.status, data.error?.code || 'REQUEST_FAILED', data.error?.message || '요청을 처리하지 못했어요.');
    return data;
  };
  const applyTokens = (session, pair) => {
    if (typeof pair.access_token !== 'string' || typeof pair.refresh_token !== 'string' || !Number.isFinite(pair.expires_in) || !Number.isFinite(pair.refresh_expires_in)) throw error(502, 'INVALID_RESPONSE', '로그인을 다시 시도해 주세요.');
    session.access = pair.access_token;
    session.refresh = pair.refresh_token;
    session.accessExpires = Date.now() + pair.expires_in * 1000;
    session.expires = Math.min(session.expires || Infinity, Date.now() + pair.refresh_expires_in * 1000);
  };
  const refresh = async session => {
    if (!session.refreshing) session.refreshing = (async () => {
      try {
        const pair = await dataOf(await upstream('/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh }) }));
        applyTokens(session, pair);
      } catch { sessions.delete(session.id); throw error(401, 'LOGIN_REQUIRED', '안전한 이용을 위해 다시 로그인해 주세요.'); }
      finally { session.refreshing = null; }
    })();
    await session.refreshing;
  };
  const authorized = async (session, path, options = {}) => {
    if (!session || sessions.get(session.id) !== session) throw error(401, 'LOGIN_REQUIRED', '로그인하면 나의 기억을 저장할 수 있어요.');
    if (session.accessExpires < Date.now() + 5000) await refresh(session);
    const request = () => {
      if (sessions.get(session.id) !== session) throw error(401, 'LOGIN_REQUIRED', '다시 로그인해 주세요.');
      return upstream(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${session.access}` } });
    };
    const used = session.access;
    let response = await request();
    if (response.status === 401) {
      if (used === session.access) await refresh(session);
      response = await request();
    }
    if (response.status === 401) { sessions.delete(session.id); throw error(401, 'LOGIN_REQUIRED', '다시 로그인해 주세요.'); }
    return response;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      cleanup();
      if (req.headers.host !== appUrl.host) throw error(400, 'INVALID_HOST', `이 미리보기는 ${origin}에서 열어 주세요.`);
      const url = new URL(req.url, origin), path = url.pathname;
      const jar = cookies(req);
      const session = sessions.get(jar.mori_poc_session);
      if (req.method === 'POST' && req.headers.origin !== origin) throw error(403, 'ORIGIN_REJECTED', '이 화면에서 다시 시도해 주세요.');
      if (req.method === 'GET' && path === '/api/config') return json(res, 200, { apiBaseUrl, callbackUrl: origin + '/auth/callback', preview: true });
      if (req.method === 'GET' && path === '/api/providers') return json(res, 200, await dataOf(await upstream('/v1/auth/providers')));
      if (req.method === 'GET' && path === '/api/session') {
        if (!session) return json(res, 200, { user: null });
        return json(res, 200, { user: await dataOf(await authorized(session, '/v1/me')) });
      }
      if (req.method === 'POST' && path === '/api/auth/start') {
        const { provider } = await body(req);
        if (!['naver', 'kakao'].includes(provider)) throw error(400, 'INVALID_PROVIDER', '로그인 방법을 확인해 주세요.');
        const available = await dataOf(await upstream('/v1/auth/providers'));
        if (!available.some(p => p.provider === provider && p.enabled)) throw error(503, 'SOCIAL_LOGIN_NOT_CONFIGURED', '아직 소셜 로그인 연결을 준비하고 있어요.');
        if (flows.size >= 500) throw error(503, 'BUSY', '잠시 후 다시 시도해 주세요.');
        if (jar.mori_poc_login) flows.delete(jar.mori_poc_login);
        const id = random(), state = random(), verifier = random();
        flows.set(id, { state, verifier, expires: Date.now() + 600000 });
        const login = new URL(`/v1/auth/${provider}/login`, apiBaseUrl);
        login.search = new URLSearchParams({ return_url: origin + '/auth/callback', code_challenge: hash(verifier), client_state: state });
        setCookie(res, 'mori_poc_login', id, 600);
        return json(res, 200, { url: login.href });
      }
      if (req.method === 'GET' && path === '/auth/callback') {
        const flow = flows.get(jar.mori_poc_login);
        flows.delete(jar.mori_poc_login);
        setCookie(res, 'mori_poc_login', '', 0);
        let result = 'expired';
        if (flow && equal(flow.state, url.searchParams.get('state'))) {
          if (url.searchParams.has('error')) result = 'cancelled';
          else if (/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code') || '')) {
            try {
              if (sessions.size >= 1000) throw error(503, 'BUSY', '잠시 후 다시 시도해 주세요.');
              const pair = await dataOf(await upstream('/v1/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: url.searchParams.get('code'), code_verifier: flow.verifier }) }));
              const entry = { id: random() };
              applyTokens(entry, pair);
              const profile = await dataOf(await upstream('/v1/me', { headers: { Authorization: `Bearer ${entry.access}` } }));
              entry.userId = profile.id;
              if (session) {
                // End an old local session when switching accounts; never reuse its tokens or data.
                try { await authorized(session, '/v1/auth/logout', { method: 'POST' }); } catch { /* Old tokens are discarded locally. */ }
                sessions.delete(session.id);
              }
              sessions.set(entry.id, entry);
              const expiredLogin = res.getHeader('Set-Cookie');
              setCookie(res, 'mori_poc_session', entry.id, Math.max(1, Math.floor((entry.expires - Date.now()) / 1000)));
              res.setHeader('Set-Cookie', [expiredLogin, res.getHeader('Set-Cookie')]);
              result = 'success';
            } catch { result = 'failed'; }
          }
        }
        res.writeHead(302, { Location: '/?login=' + result, 'Cache-Control': 'no-store' }); return res.end();
      }
      if (req.method === 'POST' && path === '/api/logout') {
        await body(req);
        let revoked = true;
        if (session) {
          try { const response = await authorized(session, '/v1/auth/logout', { method: 'POST' }); revoked = response.ok; } catch { revoked = false; }
          sessions.delete(session.id);
        }
        setCookie(res, 'mori_poc_session', '', 0);
        return json(res, 200, { loggedOut: true, revoked });
      }
      if (req.method === 'GET' && path === '/api/parking/latest') return json(res, 200, await dataOf(await authorized(session, '/v1/parking-records/latest')));
      if (req.method === 'POST' && path === '/api/parking') {
        const payload = await body(req);
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) throw error(422, 'INVALID_KEY', '저장 요청을 다시 시작해 주세요.');
        const response = await authorized(session, '/v1/parking-records', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
        const data = await dataOf(response);
        return json(res, response.status, data);
      }
      if (path.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) throw error(404, 'NOT_FOUND', '요청한 화면을 찾을 수 없어요.');
      const pathname = decodeURIComponent(path);
      const allowed = pathname === '/' || pathname === '/index.html' || pathname === '/preview.html' || /^(\/src\/[^/]+\.(js|mjs)|\/styles\/main.css|\/assets\/(mori.svg|fonts\/PretendardVariable.woff2))$/.test(pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!allowed || !file.startsWith(root + sep) || !(await stat(file).catch(() => null))?.isFile()) throw error(404, 'NOT_FOUND', '요청한 화면을 찾을 수 없어요.');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (err) { json(res, err.status || 503, { error: { code: err.code || 'UNAVAILABLE', message: err.status ? err.message : '화면을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' } }); }
  });
  return server;
}
