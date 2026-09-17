import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParking, parkingAttempt, phaseAt, parkingLabel, escapeHTML } from '../src/ui-model.mjs';

test('parking retries preserve the exact idempotency key after an uncertain response', () => {
  const first = parkingAttempt(null, { floor: ' B2 ', zone: 'C', spot: 'C36' }, () => 'first-key');
  const retry = parkingAttempt(first, { floor: 'B2', zone: 'C ', spot: 'C36' }, () => 'wrong-key');
  assert.equal(retry, first);
  assert.equal(parkingAttempt(first, { floor: 'B3' }, () => 'new-key').key, 'new-key');
});
test('parking uses structured backend fields without invented floor conversions', () => {
  assert.deepEqual(normalizeParking({ floor: ' 지하 2층 ' }), { floor: '지하 2층', zone: null, spot: null });
  assert.throws(() => normalizeParking({ floor: ' ', zone: '', spot: '' }));
  assert.throws(() => normalizeParking({ spot: 'C\0' }));
  assert.throws(() => normalizeParking({ floor: 'a'.repeat(33) }));
  assert.equal(parkingLabel({ floor: 'B2', zone: 'C', spot: 'C36' }), 'B2 · C · C36');
});
test('time context changes at commute and evening boundaries', () => {
  const at = h => new Date(2026, 8, 17, h);
  assert.equal(phaseAt(at(5)), 'evening');
  assert.equal(phaseAt(at(6)), 'morning');
  assert.equal(phaseAt(at(9)), 'morning');
  assert.equal(phaseAt(at(10)), 'day');
  assert.equal(phaseAt(at(18)), 'evening');
});
test('user content is escaped before it becomes UI markup', () => {
  assert.equal(escapeHTML('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});
