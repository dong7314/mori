import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTINS, dashboardCards, seed, visibleCards } from '../src/experience.mjs';

const at = (hour, minute = 0) => new Date(2026, 8, 29, hour, minute).getTime();
const fresh = () => seed(at(8, 40));
const kind = ref => ref.split(':')[0];

test('저장된 기록이나 예약이 없어도 기본 기능 여섯 개를 표시한다', () => {
  const state = fresh();
  Object.assign(state, { parking: null, notes: [], events: [], reminders: [], customs: [] });
  state.news.active = false;
  state.stock.active = false;

  assert.deepEqual(dashboardCards(state, at(23)), BUILTINS.map(feature => feature.id));
  assert.deepEqual(visibleCards(state, at(23)), []);
  assert.equal(state.parking, null);
  assert.deepEqual(state.notes, []);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.reminders, []);
});

test('현재 표시 시간에 해당하는 항목을 앞에 두고 나머지는 기본 기능 순서를 따른다', () => {
  const state = fresh();
  const current = visibleCards(state, at(8, 40));
  const cards = dashboardCards(state, at(8, 40));

  assert.deepEqual(cards.slice(0, current.length), current);
  assert.deepEqual(cards.slice(current.length), BUILTINS.map(feature => feature.id).filter(id => !current.includes(id)));
  assert.deepEqual(new Set(cards.map(kind)), new Set(BUILTINS.map(feature => feature.id)));
});

test('주가 표시 시작과 종료 경계에는 우선순위만 바뀌고 기본 기능은 사라지지 않는다', () => {
  const state = fresh();
  state.parking = null;
  state.news.active = false;
  state.events = [];
  state.customs = [];

  assert.deepEqual(visibleCards(state, at(9, 29)), []);
  assert.deepEqual(visibleCards(state, at(9, 30)), ['stock']);
  assert.deepEqual(visibleCards(state, at(15, 59)), ['stock']);
  assert.deepEqual(visibleCards(state, at(16)), []);
  assert.equal(dashboardCards(state, at(9, 30))[0], 'stock');
  assert.equal(dashboardCards(state, at(16))[0], 'parking');
  for (const now of [at(9, 29), at(9, 30), at(15, 59), at(16)]) {
    const cards = dashboardCards(state, now);
    assert.equal(cards.length, 6);
    assert.equal(cards.filter(ref => ref === 'stock').length, 1);
  }
});

test('가까운 개별 알림을 모두 유지하고 일반 알림 카드나 같은 알림을 중복하지 않는다', () => {
  const state = fresh();
  const first = { id: 'first', title: '물 마시기', target: at(9), cancelled: false };
  state.reminders = [first, { id: 'second', title: '휴식', target: at(9, 10), cancelled: false }, { ...first },
    { id: 'later', title: '저녁', target: at(18), cancelled: false },
    { id: 'cancelled', title: '취소', target: at(9), cancelled: true }];

  const cards = dashboardCards(state, at(8, 40));
  assert.deepEqual(cards.filter(ref => kind(ref) === 'reminder'), ['reminder:first', 'reminder:second']);
  assert.ok(!cards.includes('reminder'));
  assert.equal(cards.length, new Set(cards).size);
});

test('표시 시간이 된 사용자 기능을 보존하고 중지되거나 먼 미래의 기능은 추가하지 않는다', () => {
  const state = fresh();
  state.events = [];
  state.customs.push({ ...state.customs[0] }, { id: 'disabled', time: '19:00', repeat: '매일', active: false },
    { id: 'later', time: '23:00', repeat: '매일', active: true });

  const cards = dashboardCards(state, at(19));
  assert.deepEqual(cards.filter(ref => kind(ref) === 'custom'), ['custom:custom-evening']);
  assert.equal(cards[0], 'custom:custom-evening');
  assert.ok(cards.includes('reminder'));
  assert.deepEqual(new Set(cards.filter(ref => kind(ref) !== 'custom')), new Set(BUILTINS.map(feature => feature.id)));
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
});
