import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContext, defaultParkingRule, classify, readTime, readDate, updateParkingRule } from '../src/assistant-model.mjs';
const data = { parking: { location: '지하 3층 B12' }, parkingRule: defaultParkingRule(), events: [
  { id: 'past', title: '점심', date: '2026-09-16', time: '12:00' },
  { id: 'next', title: '산책', date: '2026-09-16', time: '19:00' },
] };
test('출근 위젯은 평일 시간 구간에만 우선하고 최신 기록을 사용한다', () => {
  assert.equal(selectContext(data, new Date('2026-09-16T07:00:00')).kind, 'parking');
  assert.equal(selectContext(data, new Date('2026-09-16T08:59:00')).kind, 'parking');
  assert.equal(selectContext(data, new Date('2026-09-16T09:00:00')).kind, 'event');
  assert.equal(selectContext(data, new Date('2026-09-19T07:30:00')).kind, 'rest');
  assert.equal(selectContext({ ...data, parking: { location: '지하 1층 A08' } }, new Date('2026-09-16T08:00:00')).title, '지하 1층 A08');
});
test('중지한 규칙과 지난 약속은 최상단에 표시하지 않는다', () => {
  assert.equal(selectContext({ ...data, parkingRule: { ...data.parkingRule, enabled: false } }, new Date('2026-09-16T08:00:00')).kind, 'event');
  assert.equal(selectContext(data, new Date('2026-09-16T14:00:00')).event.id, 'next');
});
test('음성·텍스트 요청은 같은 분류를 사용하며 주차 저장과 조회를 구분한다', () => {
  assert.equal(classify('지하 2층 C18에 주차했어').kind, 'parking-save');
  assert.equal(classify('내 차 어디에 주차했지?').kind, 'parking-read');
  assert.equal(classify('평일 아침 8시에 주차 위치를 보여줘').kind, 'rule');
  assert.equal(classify('제주 2박 3일 여행 계획을 짜줘').destination, '제주');
  assert.equal(classify('이번 달 지출을 엑셀로 정리해 줘').format, 'sheet');
});
test('약속의 모호한 시간과 잘못된 날짜는 추측해 저장하지 않는다', () => {
  const now = new Date('2026-09-16T14:00:00');
  assert.equal(readTime('6시에 만남').ambiguous, true);
  assert.equal(readTime('오후 6시 30분').value, '18:30');
  assert.equal(readTime('25:80'), null);
  assert.equal(readDate('내일', now), '2026-09-17');
  assert.equal(readDate('2026-02-31', now), null);
  assert.equal(readDate('다음 주 월요일', now), '2026-09-21');
});

test('대화로 바꾼 요일과 시작·종료 시각이 실제 위젯 선택에 적용된다', () => {
  const parkingRule = updateParkingRule('주말 아침 8시부터 9시까지 주차 위치를 보여줘', defaultParkingRule());
  assert.deepEqual(parkingRule.weekdays, [0,6]);
  assert.equal(parkingRule.start, '08:00');
  assert.equal(parkingRule.end, '09:00');
  assert.equal(selectContext({ ...data, parkingRule }, new Date('2026-09-19T08:30:00')).kind, 'parking');
  assert.notEqual(selectContext({ ...data, parkingRule }, new Date('2026-09-16T08:30:00')).kind, 'parking');
});
