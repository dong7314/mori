import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/experience.mjs';
import { dashboardTimeline } from '../src/dashboard-timeline.mjs';

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const flatten = result => result.groups.flatMap(group => group.items);

test('3/5/24 hour windows include actual occurrences without executing or changing state', () => {
  const state = seed(at(30, 10, 33)), before = structuredClone(state);
  state.events.push({ id: 'later', title: '오후 약속', date: '2026-09-30', time: '14:00' });
  const expected = structuredClone(state);
  const three = flatten(dashboardTimeline(state, 3, at(30, 10, 33)));
  assert.ok(three.some(item => item.ref === 'event:event-lunch'));
  assert.ok(!three.some(item => item.ref === 'event:later'));
  assert.ok(flatten(dashboardTimeline(state, 5, at(30, 10, 33))).some(item => item.ref === 'event:later'));
  assert.ok(flatten(dashboardTimeline(state, 24, at(30, 10, 33))).some(item => item.ref === 'custom:custom-evening'));
  assert.deepEqual(state, expected);
  assert.deepEqual(state.clock, before.clock);
});

test('next-day repetitions are distinct and no occurrence appears twice', () => {
  const state = seed(at(30, 10, 33));
  const result = dashboardTimeline(state, 24, at(30, 10, 33)), items = flatten(result);
  assert.ok(result.groups.some(group => group.label === '내일 아침'));
  assert.equal(items.filter(item => item.ref === 'news').length, 2);
  assert.equal(new Set(items.map(item => item.key)).size, items.length);
  assert.equal(items.find(item => item.ref === 'parking').at, new Date(2026, 9, 1, 8, 30).getTime());
});

test('cancelled, disabled, untimed and completed one-off work is excluded; weekends are respected', () => {
  const state = seed(at(25, 20)); // Friday evening; next evening is Saturday.
  state.parking.enabled = false; state.news.active = false; state.stock.active = false;
  state.events = [];
  state.customs.push({ id: 'draft', active: true, time: '21:00', work: '' }, { id: 'untimed', active: true, work: '메모' }, { id: 'once', active: true, work: '실행', time: '21:00', repeat: '한 번', occurrence: '2026-09-25:21:00' });
  state.reminders.push({ id: 'cancelled', target: at(25, 21), cancelled: true });
  const items = flatten(dashboardTimeline(state, 24, at(25, 20)));
  assert.equal(items.length, 1); // Friday's active 19:00 card only, not Saturday.
  assert.equal(items[0].ref, 'custom:custom-evening');
  assert.equal(items[0].current, true);
});

test('cross-midnight work remains current; expired events and the exclusive window end do not', () => {
  const state = seed(at(30, 0, 10));
  state.parking.enabled = false; state.news.active = false; state.stock.active = false; state.customs = [];
  state.events = [{ id: 'overnight', title: '야간 약속', date: '2026-09-29', time: '23:30', duration: 60 }, { id: 'expired', title: '끝난 약속', date: '2026-09-29', time: '23:10', duration: 60 }, { id: 'edge', title: '범위 밖', date: '2026-09-30', time: '03:10' }];
  const items = flatten(dashboardTimeline(state, 3, at(30, 0, 10)));
  assert.deepEqual(items.map(item => item.ref), ['event:overnight']);
  assert.equal(items[0].current, true);
});

test('one-off has one next occurrence and reminders belong to their actual target time', () => {
  const state = seed(at(30, 8, 40));
  state.customs = [{ id: 'once', title: '한 번', active: true, time: '08:30', repeat: '한 번', work: '메모 확인' }];
  state.reminders = [{ id: 'soon', title: '곧', target: at(30, 9) }, { id: 'later', title: '나중', target: at(30, 15) }];
  const three = flatten(dashboardTimeline(state, 3, at(30, 8, 40)));
  assert.ok(three.some(item => item.ref === 'reminder:soon'));
  assert.ok(!three.some(item => item.ref === 'reminder:later'));
  const once = flatten(dashboardTimeline(state, 24, at(30, 8, 40))).filter(item => item.ref === 'custom:once');
  assert.equal(once.length, 1);
  assert.equal(once[0].at, new Date(2026, 9, 1, 8, 30).getTime());
});

test('previous-day repeating cards and empty or invalid ranges are safe', () => {
  const state = seed(at(30, 0, 10));
  state.news.time = '23:00';
  assert.ok(flatten(dashboardTimeline(state, 3, at(30, 0, 10))).some(item => item.ref === 'news' && item.current));
  state.news.active = false; state.stock.active = false; state.parking.enabled = false; state.events = []; state.customs = []; state.reminders = [];
  assert.equal(dashboardTimeline(state, 24).count, 0);
  assert.deepEqual(dashboardTimeline(state, 0).groups, []);
  assert.deepEqual(dashboardTimeline(state, 1000).groups, []);
});
