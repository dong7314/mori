import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchUpdates } from '../src/search-updates.mjs';

function fixture(options = {}) {
  let sequence = 0;
  const active = new Map(), callbacks = new Map(), cleared = [];
  const updates = createSearchUpdates({ ...options,
    setTimer(callback, delay) {
      const id = ++sequence;
      active.set(id, { callback, delay }); callbacks.set(id, callback);
      return id;
    },
    clearTimer(id) { cleared.push(id); active.delete(id); },
  });
  return { ...updates, active, cleared,
    fire(id) { const job = active.get(id); active.delete(id); job?.callback(); },
    stale(id) { callbacks.get(id)?.(); },
  };
}

test('search changes wait for the configured delay and publish once', () => {
  const f = fixture(), input = { value: '메모', isConnected: true };
  let count = 0;
  f.schedule(input, () => count++);
  assert.equal(count, 0);
  assert.equal(f.active.get(1).delay, 120);
  f.fire(1); f.stale(1);
  assert.equal(count, 1);
  const custom = fixture({ delay: 80 });
  custom.schedule(input, () => {});
  assert.equal(custom.active.get(1).delay, 80);
});

test('rapid typing cancels earlier work and ignores even a queued stale callback', () => {
  const f = fixture(), input = { value: '메' }, published = [];
  f.schedule(input, () => published.push('old'));
  input.value = '메모';
  f.schedule(input, () => published.push('latest'));
  assert.deepEqual(f.cleared, [1]);
  f.stale(1);
  assert.deepEqual(published, []);
  f.fire(2);
  assert.deepEqual(published, ['latest']);
});

test('composition cancels pending search without publishing intermediate text', () => {
  const f = fixture(), input = { value: 'ㅁ' }, published = [];
  f.schedule(input, () => published.push('before composition'));
  f.schedule(input, () => published.push('composing'), { composing: true, immediate: true });
  f.stale(1);
  assert.equal(f.active.size, 0);
  assert.deepEqual(published, []);
  input.value = '메모';
  f.schedule(input, () => published.push('complete'));
  f.fire(2);
  assert.deepEqual(published, ['complete']);
});

test('empty searches and explicit immediate requests replace pending work synchronously', () => {
  const f = fixture(), input = { value: '메모' }, published = [];
  f.schedule(input, () => published.push('old'));
  input.value = '';
  f.schedule(input, () => published.push('cleared'));
  assert.deepEqual(published, ['cleared']);
  f.stale(1);
  input.value = '새 검색';
  f.schedule(input, () => published.push('immediate'), { immediate: true });
  assert.deepEqual(published, ['cleared', 'immediate']);
  assert.equal(f.active.size, 0);
});

test('separate search fields keep independent timers', () => {
  const f = fixture(), first = { value: '대화' }, second = { value: '기록' }, published = [];
  f.schedule(first, () => published.push('first-old'));
  f.schedule(second, () => published.push('second'));
  f.schedule(first, () => published.push('first-latest'));
  f.fire(2); f.stale(1); f.fire(3);
  assert.deepEqual(published, ['second', 'first-latest']);
});

test('cancel removes pending work and remains safe after completion or repeated calls', () => {
  const f = fixture(), input = { value: '메모' };
  let count = 0;
  f.cancel(input);
  f.schedule(input, () => count++);
  f.cancel(input); f.cancel(input); f.stale(1);
  assert.deepEqual(f.cleared, [1]);
  assert.equal(count, 0);
  f.schedule(input, () => count++);
  f.fire(2); f.cancel(input);
  assert.equal(count, 1);
  assert.deepEqual(f.cleared, [1]);
});

test('a detached input discards deferred work while minimal connected substitutes still work', () => {
  const f = fixture(), detached = { value: '메모', isConnected: true }, minimal = { value: '대화' };
  let count = 0;
  f.schedule(detached, () => count++);
  detached.isConnected = false;
  f.fire(1);
  assert.equal(count, 0);
  f.schedule(minimal, () => count++);
  f.fire(2);
  assert.equal(count, 1);
});

test('an update may schedule its next search without the completed job cancelling it', () => {
  const f = fixture(), input = { value: '메모' }, published = [];
  f.schedule(input, () => {
    published.push('first');
    f.schedule(input, () => published.push('second'));
  });
  f.fire(1); f.stale(1); f.fire(2);
  assert.deepEqual(published, ['first', 'second']);
});
