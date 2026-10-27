import test from 'node:test';
import assert from 'node:assert/strict';
import { commitStateChange } from '../src/state-change.mjs';

test('a failed write rolls back all related records and supplies one save error', () => {
  const state = { parking: { spot: 'A1' }, news: { topic: '기존' }, events: [{ id: 'e1' }] };
  const result = commitStateChange(state, draft => { draft.parking.spot = 'B2'; draft.news.topic = '수정'; draft.events = []; }, () => { throw new Error('QuotaExceededError'); });
  assert.equal(result.ok, false);
  assert.deepEqual(result.state, { parking: { spot: 'A1' }, news: { topic: '기존' }, events: [{ id: 'e1' }] });
  assert.match(result.error.message, /저장하지 못/);
});

test('successful writes preserve pending chat object identities and return the action result', () => {
  const conversation = { id: 'c1', messages: [] }, state = { conversations: [conversation] };
  const result = commitStateChange(state, draft => { draft.conversations[0].messages.push('확인'); return 'done'; }, () => true);
  assert.equal(result.ok, true);
  assert.equal(result.state.conversations[0], conversation);
  assert.equal(result.value, 'done');
});

test('business validation rolls back partial mutations and retains the target field', () => {
  const result = commitStateChange({ events: [] }, state => { state.events.push('partial'); throw Object.assign(new Error('요일 선택'), { field: 'days' }); }, () => assert.fail('Must not persist invalid input'));
  assert.deepEqual(result.state.events, []);
  assert.equal(result.error.field, 'days');
});
