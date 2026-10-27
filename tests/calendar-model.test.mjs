import test from 'node:test';
import assert from 'node:assert/strict';
import { moveDate, calendarDates, eventsOn, eventEnd, eventDaySpan, calendarEventContext, timelineHours, hasOverlap } from '../src/calendar-model.mjs';

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

test('진행 중인 약속과 다음 약속을 구분하고 종료 시각은 포함하지 않는다', () => {
  const events = [
    { id: 'later', date: '2026-10-01', time: '16:00', duration: 30 },
    { id: 'meeting', date: '2026-10-01', time: '14:00', duration: 60 },
    { id: 'past', date: '2026-10-01', time: '12:00', duration: 60 },
  ], original = structuredClone(events);
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 14, 30)), {
    ongoing: events[1], next: events[0],
  });
  assert.equal(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 14)).ongoing, events[1]);
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 15)), {
    ongoing: null, next: events[0],
  });
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 17)), { ongoing: null, next: null });
  assert.deepEqual(events, original);
});

test('여러 약속이 진행 중이면 가장 최근에 시작한 약속을 선택하고 동률은 기존 순서를 유지한다', () => {
  const events = [
    { id: 'early', date: '2026-10-01', time: '13:00', duration: 180 },
    { id: 'first-tie', date: '2026-10-01', time: '14:00', duration: 60 },
    { id: 'second-tie', date: '2026-10-01', time: '14:00', duration: 60 },
  ];
  assert.equal(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 14, 30)).ongoing, events[1]);
});

test('자정 이후에도 전날부터 이어지는 약속을 진행 중으로 보고 새 약속의 실제 시작 순서를 지킨다', () => {
  const events = [
    { id: 'night', date: '2026-09-30', time: '23:30', duration: 90 },
    { id: 'midnight-end', date: '2026-09-30', time: '23:00', duration: 60 },
    { id: 'new-day', date: '2026-10-01', time: '00:15', duration: 30 },
  ];
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 0)), {
    ongoing: events[0], next: events[2],
  });
  assert.equal(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 0, 30)).ongoing, events[2]);
  assert.equal(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 0, 45)).ongoing, events[0]);
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 1, 1)), { ongoing: null, next: null });
});

test('지난 날짜와 미래 날짜를 현재 진행 중으로 오인하지 않는다', () => {
  const events = [{ id: 'meeting', date: '2026-10-01', time: '14:00', duration: 60 }];
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 8, 30, 14, 30)), { ongoing: null, next: events[0] });
  assert.deepEqual(calendarEventContext(events, '2026-10-01', new Date(2026, 9, 2, 14, 30)), { ongoing: null, next: null });
});
