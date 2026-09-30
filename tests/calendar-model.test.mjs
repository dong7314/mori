import test from 'node:test';
import assert from 'node:assert/strict';
import { moveDate, calendarDates, eventsOn, eventEnd, eventDaySpan, timelineHours, hasOverlap } from '../src/calendar-model.mjs';

test('월말 이동은 말일로 보정하고 윤년과 연도 경계를 지킨다', () => {
  assert.equal(moveDate('2026-01-31', 1, 'month'), '2026-02-28');
  assert.equal(moveDate('2024-01-31', 1, 'month'), '2024-02-29');
  assert.equal(moveDate('2026-12-31', 1, 'day'), '2027-01-01');
  assert.equal(moveDate('2026-12-29', 1, 'week'), '2027-01-05');
});

test('달력과 주 보기는 경계일을 포함한 완전한 주를 만든다', () => {
  const month = calendarDates('2026-09-30');
  assert.equal(month[0], '2026-08-30');
  assert.equal(month.at(-1), '2026-10-03');
  assert.equal(month.length % 7, 0);
  assert.deepEqual(calendarDates('2026-12-31', 'week'), ['2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02']);
});

test('일 보기에서 새벽·야간 일정이 빠지지 않는다', () => {
  const events = [{ date: '2026-09-30', time: '03:15' }, { date: '2026-09-30', time: '23:30', duration: 90 }];
  const hours = timelineHours(events, '2026-09-30');
  assert.equal(hours[0], 3); assert.equal(hours.at(-1), 23);
  assert.equal(eventEnd(events[0]), '04:15');
  assert.equal(eventEnd(events[1]), '다음 날 01:00');
});

test('자정을 넘긴 약속은 다음 날에도 이어서 표시하되 자정에 끝나면 제외한다', () => {
  const events = [{ id: 'night', date: '2026-09-30', time: '23:30', duration: 90 }, { id: 'midnight', date: '2026-09-30', time: '23:00', duration: 60 }];
  assert.deepEqual(eventsOn(events, '2026-10-01').map(event => event.id), ['night']);
  assert.deepEqual(eventDaySpan(events[0], '2026-10-01'), { start: 0, end: 60, startLabel: '00:00', endLabel: '01:00', continuation: '전날부터' });
  assert.equal(timelineHours(eventsOn(events, '2026-10-01'), '2026-10-01')[0], 0);
});

test('겹침 안내는 자신을 제외하고 연속된 일정과 날짜 경계를 구분한다', () => {
  const events = [{ id: 'meeting', date: '2026-09-30', time: '10:30', duration: 60 }, { id: 'night', date: '2026-09-30', time: '23:30', duration: 90 }];
  assert.equal(hasOverlap(events, { date: '2026-09-30', time: '11:00', duration: 30 }), true);
  assert.equal(hasOverlap(events, { date: '2026-09-30', time: '11:30', duration: 30 }), false);
  assert.equal(hasOverlap(events, events[0]), false);
  assert.equal(hasOverlap(events, { date: '2026-10-01', time: '00:30', duration: 30 }), true);
});
