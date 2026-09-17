import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from '../scripts/server.mjs';
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const result = (data, status = 200) => new Response(JSON.stringify(data), { status });

async function fixture(t, { origin = 'http://localhost:4173', shortAccess = false } = {}) {
  const codes = new Map(), tokenUsers = new Map(), refreshUsers = new Map(), parking = new Map();
  const calls = [], counters = { refresh: 0 };
  let refreshFailure = false;
  const pair = user => {
    const tokens = { access_token: 'private-access-' + random(), refresh_token: 'private-refresh-' + random(), expires_in: shortAccess ? 1 : 900, refresh_expires_in: 86400 };
    tokenUsers.set(tokens.access_token, user); refreshUsers.set(tokens.refresh_token, user); return tokens;
  };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || 'GET', headers: options.headers, body: options.body });
    if (path === '/v1/auth/providers') return result([{ provider: 'naver', enabled: true }, { provider: 'kakao', enabled: true }]);
    if (path === '/v1/auth/exchange') {
      const input = JSON.parse(options.body), grant = codes.get(input.code);
      if (!grant || digest(input.code_verifier) !== grant.challenge) return result({ error: { code: 'INVALID_LOGIN_CODE' } }, 401);
      codes.delete(input.code); return result(pair(grant.user));
    }
    if (path === '/v1/auth/refresh') {
      counters.refresh++;
      if (refreshFailure) throw new Error('uncertain network outcome');
      const token = JSON.parse(options.body).refresh_token, user = refreshUsers.get(token);
      refreshUsers.delete(token);
      if (!user) return result({ error: { code: 'INVALID_REFRESH_TOKEN' } }, 401);
      await new Promise(resolve => setTimeout(resolve, 20));
      return result(pair(user));
    }
    const user = tokenUsers.get(options.headers?.Authorization?.replace('Bearer ', ''));
    if (!user) return result({ error: { code: 'UNAUTHORIZED' } }, 401);
    if (path === '/v1/me') return result(user);
    if (path === '/v1/auth/logout') { for (const [key, value] of tokenUsers) if (value === user) tokenUsers.delete(key); return new Response(null, { status: 204 }); }
    if (path === '/v1/parking-records/latest') return parking.has(user.id) ? result(parking.get(user.id)) : result({ error: { code: 'PARKING_NOT_FOUND', message: '아직 기록이 없어요.' } }, 404);
    if (path === '/v1/parking-records') { const record = { id: random(), ...JSON.parse(options.body), recorded_at: '2026-09-17T01:00:00Z' }; parking.set(user.id, record); return result(record, 201); }
    throw new Error('Unexpected upstream path ' + path);
  };
  const server = createServer({ origin, fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie = '', method = 'GET', data, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers: { Host: new URL(origin).host, Origin: origin, Cookie: cookie, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject);
    req.end(data !== undefined ? JSON.stringify(data) : undefined);
  });
  const begin = async (provider = 'naver') => {
    const response = await request('/api/auth/start', { method: 'POST', data: { provider } });
    assert.equal(response.status, 200);
    const loginUrl = new URL((await response.json()).url);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const user = { id: random(), display_name: '테스트 사용자', providers: [provider], tier: 'free', role: 'user' };
    const code = random(); codes.set(code, { challenge: loginUrl.searchParams.get('code_challenge'), user });
    return { cookie, code, state: loginUrl.searchParams.get('client_state'), user, response, loginUrl };
  };
  const finish = flow => request(`/auth/callback?code=${flow.code}&state=${flow.state}`, { cookie: flow.cookie });
  const login = async provider => {
    const flow = await begin(provider), completed = await finish(flow);
    assert.equal(completed.headers.get('location'), '/?login=success');
    const cookie = completed.headers.getSetCookie().find(c => c.startsWith('mori_poc_session=')).split(';')[0];
    return { cookie, user: flow.user, completed };
  };
  return { request, begin, finish, login, calls, counters, failRefresh: () => { refreshFailure = true; } };
}
for (const provider of ['naver', 'kakao']) test(`${provider}: OAuth handoff keeps tokens server-side and binds the login cookie to PKCE`, async t => {
  const f = await fixture(t), { cookie, user, completed } = await f.login(provider);
  const response = await f.request('/api/session', { cookie });
  assert.deepEqual(await response.json(), { user });
  assert.ok(completed.headers.getSetCookie().some(c => c.includes('HttpOnly') && c.includes('SameSite=Lax')));
  assert.ok(!cookie.includes('private-access-') && !cookie.includes('private-refresh-'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('missing/tampered callback proof never exchanges provider grants', async t => {
  const f = await fixture(t), flow = await f.begin();
  const missing = await f.request(`/auth/callback?code=${flow.code}&state=${flow.state}`);
  assert.equal(missing.headers.get('location'), '/?login=expired');
  const bad = await f.finish({ ...flow, state: random() });
  assert.equal(bad.headers.get('location'), '/?login=expired');
  assert.equal(f.calls.filter(c => c.path === '/v1/auth/exchange').length, 0);
  assert.equal((await f.finish(flow)).headers.get('location'), '/?login=expired');
  const unicode = await f.begin();
  assert.equal((await f.finish({ ...unicode, state: encodeURIComponent('가'.repeat(43)) })).headers.get('location'), '/?login=expired');
});
test('cancelled OAuth returns a clean URL without credentials', async t => {
  const f = await fixture(t), flow = await f.begin();
  const response = await f.request(`/auth/callback?error=oauth_denied&state=${flow.state}`, { cookie: flow.cookie });
  assert.equal(response.headers.get('location'), '/?login=cancelled');
  assert.ok(response.headers.get('set-cookie').includes('Max-Age=0'));
});
test('cross-origin mutation, unexpected host, arbitrary proxy and local source paths are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/start', { method: 'POST', data: { provider: 'naver' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request('/api/session', { headers: { Host: 'attacker.example' } })).status, 400);
  assert.equal((await f.request('/api/proxy?url=https://attacker.example')).status, 404);
  for (const path of ['/.env', '/src/missing.mjs', '/scripts/server.mjs', '/package.json', '/tests/server.test.mjs']) assert.equal((await f.request(path)).status, 404);
  assert.equal((await f.request('/api/auth/start', { method: 'POST', data: { provider: 'google' } })).status, 400);
  assert.equal(f.calls.length, 0);
});
test('guest cannot store parking and signed-in parking forwards the exact idempotency key', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/parking/latest')).status, 401);
  const { cookie } = await f.login();
  const key = '082fe0ad-4a37-41f1-a955-62f5c74b22e6';
  const response = await f.request('/api/parking', { cookie, method: 'POST', data: { floor: 'B2', zone: 'C', spot: 'C36' }, headers: { 'Idempotency-Key': key } });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.deepEqual(await (await f.request('/api/parking/latest', { cookie })).json(), saved);
  const forwarded = f.calls.find(c => c.path === '/v1/parking-records');
  assert.equal(forwarded.headers['Idempotency-Key'], key);
  assert.ok(forwarded.headers.Authorization.startsWith('Bearer private-access-'));
  const other = await f.login('kakao');
  assert.equal((await f.request('/api/parking/latest', { cookie: other.cookie })).status, 404);
});
test('expired tokens refresh once even when requests arrive concurrently', async t => {
  const f = await fixture(t, { shortAccess: true }), { cookie } = await f.login();
  const responses = await Promise.all([f.request('/api/session', { cookie }), f.request('/api/session', { cookie })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(f.counters.refresh, 1);
});
test('uncertain refresh discards the session rather than reusing a rotated token', async t => {
  const f = await fixture(t, { shortAccess: true }), { cookie } = await f.login();
  f.failRefresh();
  assert.equal((await f.request('/api/session', { cookie })).status, 401);
  assert.deepEqual(await (await f.request('/api/session', { cookie })).json(), { user: null });
  assert.equal(f.counters.refresh, 1);
});
test('logout revokes server session and removes the browser cookie', async t => {
  const f = await fixture(t), { cookie } = await f.login();
  const response = await f.request('/api/logout', { cookie, method: 'POST', data: {} });
  assert.deepEqual(await response.json(), { loggedOut: true, revoked: true });
  assert.ok(response.headers.get('set-cookie').includes('Max-Age=0'));
  assert.deepEqual(await (await f.request('/api/session', { cookie })).json(), { user: null });
  assert.ok(f.calls.some(c => c.path === '/v1/auth/logout'));
});
test('HTTPS app sessions use Secure cookies', async t => {
  const f = await fixture(t, { origin: 'https://mori.example' }), { completed } = await f.login();
  assert.ok(completed.headers.getSetCookie().every(cookie => cookie.includes('Secure')));
});
test('public HTTP and URLs containing credentials are rejected at configuration time', () => {
  assert.throws(() => createServer({ origin: 'http://public.example' }));
  assert.throws(() => createServer({ apiBaseUrl: 'https://secret:password@api.example' }));
  assert.throws(() => createServer({ apiBaseUrl: 'https://api.example/prefix' }));
});
