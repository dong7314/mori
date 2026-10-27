import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenHistory } from '../src/screen-history.mjs';

function fixture() {
  const listeners = new Map(), stack = [{ state: { unrelated: 'retained' }, hash: '#features' }], restored = [];
  let cursor = 0;
  const location = { href: 'http://localhost/#features', hash: '#features' };
  const events = { addEventListener: (type, listener) => listeners.set(type, listener) };
  const history = {
    get state() { return stack[cursor].state; },
    replaceState(state) { stack[cursor] = { state, hash: location.hash }; },
    pushState(state) { stack.splice(cursor + 1); stack.push({ state, hash: location.hash }); cursor++; },
    go(delta) { queueMicrotask(() => { cursor += delta; assert.ok(cursor >= 0 && cursor < stack.length); location.hash = stack[cursor].hash; listeners.get('popstate')({ state: history.state }); }); },
  };
  const navigation = createScreenHistory({ history, location, events, session: 'test', restore: async value => { restored.push(value); } });
  const travel = async delta => { history.go(delta); await new Promise(resolve => setImmediate(resolve)); await navigation.settled(); };
  return { navigation, history, location, events, stack, restored, travel };
}

test('browser Back and Forward traverse detail and editing without changing the tab', async () => {
  const f = fixture();
  await f.navigation.sync(1, 'detail'); await f.navigation.sync(2, 'edit');
  await f.travel(-1); assert.deepEqual(f.restored, ['detail']);
  assert.equal(f.location.hash, '#features');
  await f.travel(-1); assert.equal(f.restored.at(-1), null);
  await f.travel(1); assert.equal(f.restored.at(-1), 'detail');
  await f.travel(1); assert.equal(f.restored.at(-1), 'edit');
  assert.equal(f.history.state.unrelated, 'retained');
});

test('header Back consumes history once and a new action removes the old forward branch', async () => {
  const f = fixture();
  await f.navigation.sync(1, 'detail'); await f.navigation.sync(2, 'edit');
  await f.navigation.sync(1, 'saved detail');
  assert.deepEqual(f.restored, []);
  await f.navigation.sync(2, 'another editor');
  assert.equal(f.stack.length, 3);
  await f.travel(-1); assert.equal(f.restored.at(-1), 'saved detail');
  await f.travel(-1); assert.equal(f.restored.at(-1), null);
});

test('closing a sheet and chat returns to the tab in one operation', async () => {
  const f = fixture();
  await f.navigation.sync(1, 'chat'); await f.navigation.sync(2, 'sheet'); await f.navigation.sync(3, 'editor');
  await f.navigation.sync(0, null);
  assert.deepEqual(f.restored, []);
  await f.travel(1); assert.equal(f.restored.at(-1), 'chat');
});

test('same-level refreshes and filters replace snapshots without creating Back steps', async () => {
  const f = fixture();
  await f.navigation.sync(1, 'all'); await f.navigation.sync(1, 'notes'); await f.navigation.sync(1, 'searched');
  assert.equal(f.stack.length, 2);
  await f.travel(-1); await f.travel(1);
  assert.equal(f.restored.at(-1), 'searched');
});

test('tab navigation creates a distinct root while browser Back can restore the preceding root', async () => {
  const f = fixture();
  await f.navigation.sync(1, 'detail'); await f.navigation.sync(0, null);
  f.location.hash = '#my'; f.history.pushState(f.history.state); f.navigation.route();
  await f.navigation.sync(1, 'theme'); await f.travel(-1); await f.travel(-1);
  assert.equal(f.location.hash, '#features');
  assert.equal(f.restored.at(-1), null);
});

test('a navigation restore cannot push a duplicate entry while rendering its destination', async () => {
  const f = fixture();
  // A second controller models a renderer that calls sync during restoration.
  let navigation;
  const listeners = new Map();
  const events = { addEventListener: (type, callback) => listeners.set(type, callback) };
  navigation = createScreenHistory({ history: f.history, location: f.location, events, session: 'render', restore: async () => navigation.sync(3, 'must not push') });
  await navigation.sync(1, 'detail');
  const root = f.stack[0].state;
  listeners.get('popstate')({ state: root });
  await navigation.settled();
  assert.equal(f.stack.length, 2);
});

test('reload collapses old dialog entries before accepting a new destination', async () => {
  const f = fixture();
  await f.navigation.sync(1, { title: 'private note' }); await f.navigation.sync(2, { title: 'private edit' });
  const reloaded = createScreenHistory({ history: f.history, location: f.location, events: f.events, session: 'reloaded', restore: () => {} });
  await reloaded.sync(1, 'new destination');
  assert.equal(f.stack.length, 2);
  assert.equal(f.history.state.moriScreen.depth, 1);
  assert.equal(f.history.state.moriScreen.session, 'reloaded');
  assert.doesNotMatch(JSON.stringify(f.stack), /private/);
});
