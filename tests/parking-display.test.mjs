import test from 'node:test';
import assert from 'node:assert/strict';
import { parkingWindows, parkingOptions, parkingDescription } from '../src/parking-display.mjs';
import { parkingAttempt } from '../src/ui-model.mjs';
import { dashboardTimeline } from '../src/dashboard-timeline.mjs';
import { seed } from '../src/experience.mjs';

const at = date => Date.parse(date);
test('always parking has one stable card across midnight and forecast windows', () => {
  const saved = at('2026-10-01T09:00:00+09:00'), p = { at: saved, spot: 'C36', ...parkingOptions({}) };
  const first = parkingWindows(p, {}, saved), later = parkingWindows(p, {}, saved + 86400000);
  assert.equal(first.length, 1); assert.equal(first[0].end, null);
  assert.equal(first[0].key, later[0].key);
  assert.equal(parkingWindows(p, {}, saved - 1).length, 0);
  const state = seed(saved); state.parking = p;
  assert.equal(dashboardTimeline(state, 24, saved).groups.flatMap(g => g.items).filter(i => i.ref === 'parking').length, 1);
});
test('scheduled parking respects timezone, weekday, midnight, saved time and exclusive end', () => {
  const p = { at: at('2026-10-01T12:00:00+09:00'), ...parkingOptions({ display_mode: 'scheduled', time: '23:30', days: [3], duration_minutes: 120 }) };
  assert.equal(parkingWindows(p, {}, at('2026-10-01T23:29:00+09:00')).length, 0);
  assert.equal(parkingWindows(p, {}, at('2026-10-02T00:30:00+09:00')).length, 1);
  assert.equal(parkingWindows(p, {}, at('2026-10-02T01:30:00+09:00')).length, 0);
  assert.equal(parkingWindows(p, {}, at('2026-10-02T23:30:00+09:00')).length, 0);
  p.at = at('2026-10-02T00:00:00+09:00');
  assert.equal(parkingWindows(p, {}, p.at).length, 1);
});
test('display changes get new retry keys, while reordered weekdays preserve a retry', () => {
  const a = parkingAttempt(null, { spot: 'B16', display_mode: 'scheduled', time: '08:30', days: [4, 0] });
  const retry = parkingAttempt(a, { spot: 'B16', display_mode: 'scheduled', time: '08:30', days: [0, 4] });
  assert.equal(retry.key, a.key);
  assert.notEqual(parkingAttempt(a, { spot: 'B16', display_mode: 'always' }).key, a.key);
  assert.throws(() => parkingOptions({ display_mode: 'scheduled', time: '08:30', days: [] }));
  assert.throws(() => parkingOptions({ display_mode: 'scheduled', time: '25:30', days: [0] }));
  assert.throws(() => parkingOptions({ display_mode: 'scheduled', time: '08:30', days: [0, 0] }));
  assert.match(parkingDescription(a.payload), /월·금 08:30/);
});
