import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountLoader } from '../src/account-session.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const initial = () => ({ liveUser: null, accountState: 'checking', settingsRevision: 0, settingsState: 'idle' });

test('moving between sheets does not invalidate an account refresh', async () => {
  const session = deferred(), settings = deferred(), state = initial(), applied = [];
  let changes = 0;
  const load = createAccountLoader({ state, request: path => path === '/session' ? session.promise : settings.promise,
    onSettings: value => applied.push(value), onChange: () => changes++ });
  const loading = load();
  state.accountEpoch = 5;
  session.resolve({ user: { id: 'member' } });
  await Promise.resolve();
  state.accountEpoch = 6;
  settings.resolve({ theme: 'dark', revision: 8 });
  assert.equal(await loading, true);
  assert.equal(state.liveUser.id, 'member');
  assert.equal(state.accountState, 'signed-in');
  assert.equal(state.settingsState, 'ready');
  assert.equal(state.settingsRevision, 8);
  assert.deepEqual(applied, [{ theme: 'dark', revision: 8 }]);
  assert.equal(changes, 1);
});

test('the newest refresh wins even when an older settings response arrives last', async () => {
  const sessions = [deferred(), deferred()], settings = [deferred(), deferred()];
  const state = initial(), applied = [], changed = [];
  let sessionIndex = 0, settingsIndex = 0;
  const load = createAccountLoader({ state,
    request: path => path === '/session' ? sessions[sessionIndex++].promise : settings[settingsIndex++].promise,
    onSettings: value => applied.push(value.theme), onChange: () => changed.push(state.liveUser.id) });
  const older = load(); sessions[0].resolve({ user: { id: 'older' } });
  await Promise.resolve();
  const newer = load(); sessions[1].resolve({ user: { id: 'newer' } });
  await Promise.resolve();
  settings[1].resolve({ theme: 'light', revision: 4 });
  assert.equal(await newer, true);
  settings[0].resolve({ theme: 'dark', revision: 99 });
  assert.equal(await older, null);
  assert.equal(state.liveUser.id, 'newer');
  assert.equal(state.settingsRevision, 4);
  assert.deepEqual(applied, ['light']);
  assert.deepEqual(changed, ['newer']);
});

test('invalidating a pending refresh prevents the old session from returning after logout', async () => {
  const session = deferred(), state = initial();
  let requests = 0, changes = 0;
  const load = createAccountLoader({ state, request: () => { requests++; return session.promise; },
    onSettings: () => assert.fail('An invalidated request must not apply settings'), onChange: () => changes++ });
  const loading = load();
  load.invalidate();
  state.accountState = 'guest';
  session.resolve({ user: { id: 'signed-out-member' } });
  assert.equal(await loading, null);
  assert.equal(state.liveUser, null);
  assert.equal(state.accountState, 'guest');
  assert.equal(requests, 1);
  assert.equal(changes, 0);
});

test('invalidation while settings are loading prevents the session and theme from returning', async () => {
  const settings = deferred(), state = initial();
  let changes = 0;
  const load = createAccountLoader({ state,
    request: async path => path === '/session' ? { user: { id: 'member' } } : settings.promise,
    onSettings: () => assert.fail('Invalidated settings must not be applied'), onChange: () => changes++ });
  const loading = load(); await Promise.resolve();
  load.invalidate(); state.accountState = 'guest';
  settings.resolve({ theme: 'dark', revision: 5 });
  assert.equal(await loading, null);
  assert.equal(state.liveUser, null);
  assert.equal(state.accountState, 'guest');
  assert.equal(changes, 0);
});

test('a refresh started during a profile save cannot replace the newer successful write', async () => {
  const settings = deferred(), state = { ...initial(), liveUser: { id: 'member', display_name: 'Before', revision: 1 }, accountState: 'signed-in' };
  let changedName;
  const load = createAccountLoader({ state,
    request: async path => path === '/session' ? { user: { ...state.liveUser } } : settings.promise,
    onChange: () => { changedName = state.liveUser.display_name; } });
  const loading = load(); await Promise.resolve();
  state.liveUser = { id: 'member', display_name: 'Saved name', revision: 2 };
  settings.resolve({ theme: 'system', revision: 1 });
  assert.equal(await loading, true, 'The waiting account sheet must leave its loading state');
  assert.equal(state.liveUser.display_name, 'Saved name');
  assert.equal(state.liveUser.revision, 2);
  assert.equal(changedName, 'Saved name');
});

for (const settingsFail of [false, true]) {
  test(`a newer settings save survives a delayed refresh ${settingsFail ? 'failure' : 'response'}`, async () => {
    const settings = deferred(), state = { ...initial(), liveUser: { id: 'member', revision: 1 }, accountState: 'signed-in', settingsRevision: 1, settingsState: 'ready' };
    const applied = [];
    const load = createAccountLoader({ state,
      request: async path => path === '/session' ? { user: { id: 'member', revision: 1 } } : settings.promise,
      onSettings: value => applied.push(value.theme) });
    const loading = load(); await Promise.resolve();
    state.settingsRevision = 2;
    if (settingsFail) settings.reject({ status: 503 });
    else settings.resolve({ theme: 'system', revision: 1 });
    assert.equal(await loading, true);
    assert.equal(state.settingsRevision, 2);
    assert.equal(state.settingsState, 'ready');
    assert.deepEqual(applied, []);
  });
}

test('revision protection never carries profile or settings across different accounts', async () => {
  const state = { ...initial(), liveUser: { id: 'previous', revision: 99 }, settingsRevision: 99, settingsState: 'ready' }, applied = [];
  const load = createAccountLoader({ state,
    request: async path => path === '/session' ? { user: { id: 'next', revision: 1 } } : { theme: 'light', revision: 1 },
    onSettings: value => applied.push(value.theme) });
  assert.equal(await load(), true);
  assert.equal(state.liveUser.id, 'next');
  assert.equal(state.liveUser.revision, 1);
  assert.equal(state.settingsRevision, 1);
  assert.deepEqual(applied, ['light']);
});

test('a settings service failure preserves the confirmed session without retaining a stale revision', async () => {
  const state = { ...initial(), settingsRevision: 99 };
  let changes = 0;
  const load = createAccountLoader({ state,
    request: async path => { if (path === '/session') return { user: { id: 'member' } }; throw { status: 503 }; },
    onSettings: () => assert.fail('Failed settings must not be applied'), onChange: () => changes++ });
  assert.equal(await load(), true);
  assert.equal(state.liveUser.id, 'member');
  assert.equal(state.accountState, 'signed-in');
  assert.equal(state.settingsState, 'error');
  assert.equal(state.settingsRevision, 0);
  assert.equal(changes, 1);
});

for (const failedPath of ['/session', '/settings']) {
  test(`an authentication failure from ${failedPath} clears the prior session`, async () => {
    const state = { ...initial(), liveUser: { id: 'previous' }, settingsRevision: 9 };
    let changes = 0;
    const load = createAccountLoader({ state,
      request: async path => { if (path === failedPath) throw { status: 401 }; return { user: { id: 'member' } }; },
      onSettings: () => assert.fail('Invalid authentication must not apply settings'), onChange: () => changes++ });
    assert.equal(await load(), false);
    assert.equal(state.liveUser, null);
    assert.equal(state.accountState, 'error');
    assert.equal(state.settingsRevision, 0);
    assert.equal(state.settingsState, 'idle');
    assert.equal(changes, 1);
  });
}

test('a guest response clears previous account settings without requesting authenticated settings', async () => {
  const state = { ...initial(), liveUser: { id: 'previous' }, settingsRevision: 9 }, requests = [];
  const load = createAccountLoader({ state, request: async path => { requests.push(path); return { user: null }; } });
  assert.equal(await load(), true);
  assert.deepEqual(requests, ['/session']);
  assert.equal(state.liveUser, null);
  assert.equal(state.accountState, 'guest');
  assert.equal(state.settingsRevision, 0);
  assert.equal(state.settingsState, 'idle');
});
