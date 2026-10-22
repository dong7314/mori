import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardCards, seed, visibleCards } from '../src/experience.mjs';

const at = (hour, minute = 0) => new Date(2026, 8, 29, hour, minute).getTime();
const fresh = () => seed(at(8, 40));
const withoutTimedItems = () => {
  const state = fresh();
  Object.assign(state, { parking: null, events: [], reminders: [], customs: [] });
  state.news.active = false;
  state.stock.active = false;
  return state;
};

test('메모만 있거나 모든 기록이 비어 있으면 시간 카드와 빈 기본 기능 카드를 만들지 않는다', () => {
  const state = withoutTimedItems();
  const notes = structuredClone(state.notes);

  assert.ok(notes.length > 0);
  assert.deepEqual(dashboardCards(state, at(8, 40)), []);
  assert.deepEqual(state.notes, notes);
  state.notes = [];
  assert.deepEqual(dashboardCards(state, at(23)), []);
  assert.equal(state.parking, null);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.reminders, []);
});

test('현재 표시 구간의 일정·알림과 예약된 뉴스·주가·사용자 기능만 표시한다', () => {
  const state = fresh();
  state.customs = [{ id: 'morning', title: '아침 정리', work: '메모 확인', time: '09:30', repeat: '평일', active: true }];
  state.reminders = [{ id: 'water', title: '물 마시기', target: at(10), cancelled: false }];

  const cards = dashboardCards(state, at(9, 40));
  assert.deepEqual(new Set(cards), new Set(['parking', 'news', 'stock', 'schedule', 'reminder:water', 'custom:morning']));
  assert.ok(!cards.includes('note'));
  assert.ok(!cards.includes('reminder'));
  assert.equal(cards.length, new Set(cards).size);
});

test('주가 카드는 설정한 표시 시작부터 종료 직전까지만 나타난다', () => {
  const state = withoutTimedItems();
  state.stock.active = true;

  assert.deepEqual(dashboardCards(state, at(9, 29)), []);
  assert.deepEqual(dashboardCards(state, at(9, 30)), ['stock']);
  assert.deepEqual(dashboardCards(state, at(15, 59)), ['stock']);
  assert.deepEqual(dashboardCards(state, at(16)), []);
});

test('상시 주차 기록은 제외하고 지정한 요일·시간 구간의 주차 기록만 표시한다', () => {
  const state = withoutTimedItems();
  state.parking = { floor: '지하 3층', spot: 'B16', at: at(8), enabled: true, display_mode: 'always', display_schedule: null };
  assert.deepEqual(dashboardCards(state, at(8, 40)), []);

  Object.assign(state.parking, { display_mode: 'scheduled', display_schedule: {
    time: '08:30', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: [1], duration_minutes: 90,
  } });
  assert.deepEqual(dashboardCards(state, at(8, 29)), []);
  assert.deepEqual(dashboardCards(state, at(8, 30)), ['parking']);
  assert.deepEqual(dashboardCards(state, at(9, 59)), ['parking']);
  assert.deepEqual(dashboardCards(state, at(10)), []);
  state.parking.display_schedule.days = [0];
  assert.deepEqual(dashboardCards(state, at(8, 40)), []);
});

test('가까운 개별 알림을 유지하되 취소·완료·먼 미래의 알림과 중복은 제외한다', () => {
  const state = withoutTimedItems();
  const first = { id: 'first', title: '물 마시기', target: at(9), cancelled: false };
  state.reminders = [first, { id: 'second', title: '휴식', target: at(9, 10), cancelled: false }, { ...first },
    { id: 'later', title: '저녁', target: at(18), cancelled: false },
    { id: 'cancelled', title: '취소', target: at(9), cancelled: true },
    { id: 'finished', title: '완료', target: at(8, 30), cancelled: false }];

  const cards = dashboardCards(state, at(8, 40));
  assert.deepEqual(new Set(cards), new Set(['reminder:first', 'reminder:second']));
  assert.equal(cards.length, 2);
  assert.ok(!cards.includes('reminder'));
});

test('활성 상태이며 시간이 지정된 사용자 기능만 해당 표시 구간에 나타난다', () => {
  const state = withoutTimedItems();
  state.customs = [
    { id: 'evening', title: '퇴근 정리', work: '오늘 메모 정리', time: '19:00', repeat: '평일', active: true },
    { id: 'disabled', work: '중지된 기능', time: '19:00', repeat: '매일', active: false },
    { id: 'untimed', work: '필요할 때 실행', time: '', repeat: '매일', active: true },
    { id: 'later', work: '밤에 실행', time: '23:00', repeat: '매일', active: true },
  ];
  assert.deepEqual(dashboardCards(state, at(19)), ['custom:evening']);
  assert.deepEqual(dashboardCards(state, at(12)), []);
});

test('중지된 뉴스·주가·주차는 기본 카드로 보충하지 않는다', () => {
  const state = withoutTimedItems();
  state.parking = { ...fresh().parking, enabled: false };
  assert.deepEqual(dashboardCards(state, at(9, 40)), []);
});

test('시간이 없거나 잘못된 시각의 뉴스·주가·사용자 기능은 제외한다', () => {
  for (const time of ['', '9am', '09:70', '25:00']) {
    const state = withoutTimedItems();
    Object.assign(state.news, { active: true, time });
    Object.assign(state.stock, { active: true, time });
    state.customs = [{ id: 'invalid', work: '메모 확인', active: true, time, repeat: '매일' }];
    assert.deepEqual(dashboardCards(state, at(9, 40)), [], time);
  }
});

test('완료한 한 번 작업은 제외하고 실행된 반복 작업은 표시 구간 동안 결과 확인용으로 유지한다', () => {
  const state = withoutTimedItems();
  state.customs = [
    { id: 'once', work: '한 번 실행', active: true, time: '19:00', repeat: '한 번', occurrence: '2026-09-29:19:00' },
    { id: 'daily', work: '매일 정리', active: true, time: '19:00', repeat: '매일', occurrence: '2026-09-29:19:00', result: { at: at(19), items: [] } },
  ];
  assert.deepEqual(dashboardCards(state, at(19, 20)), ['custom:daily']);
  assert.deepEqual(dashboardCards(state, at(21)), []);
});

test('카드를 계산해도 저장된 상태와 기존 시간별 표시 결과는 변경되지 않는다', () => {
  const state = fresh();
  state.reminders.push({ id: 'water', title: '물 마시기', target: at(9), cancelled: false });
  const before = structuredClone(state);
  const visibleBefore = visibleCards(state, at(8, 40));

  const cards = dashboardCards(state, at(8, 40));
  cards.push('test-only');

  assert.deepEqual(state, before);
  assert.deepEqual(visibleCards(state, at(8, 40)), visibleBefore);
  assert.ok(!dashboardCards(state, at(8, 40)).includes('test-only'));
  assert.ok(!dashboardCards(state, at(8, 40)).some(ref => ref.split(':')[0] === 'note'));
});
