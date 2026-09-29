import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, applyRequest, visibleCards, setClock, nowOf, tickScheduled, runCustom } from '../src/experience.mjs';

const start = new Date(2026, 8, 29, 8, 40).getTime();
const fresh = () => seed(start);
test('일반 대화는 기능을 만들지 않고 주차는 가장 최근 위치로 교체한다', () => {
  const s = fresh(); applyRequest(s, '안녕', start);
  assert.equal(s.customs.length, 1);
  applyRequest(s, '지하 2층 C36에 주차했어', start);
  assert.equal(s.parking.floor, '지하 2층'); assert.equal(s.parking.spot, 'C36');
  assert.equal(s.parking.show, '08:30');
  assert.match(applyRequest(s, '주차 어디였지?', start).text, /C36/);
});
test('현재 표시 시간에만 카드가 나타나며 미래 예약을 모두 노출하지 않는다', () => {
  const s = fresh(); assert.ok(visibleCards(s, start).includes('parking'));
  assert.ok(!visibleCards(s, start).includes('custom:custom-evening'));
  const evening = new Date(2026, 8, 29, 19).getTime();
  assert.ok(!visibleCards(s, evening).includes('parking'));
  assert.ok(visibleCards(s, evening).includes('custom:custom-evening'));
});
test('주차 카드의 표시 간격과 일시 중지 설정을 적용한다', () => {
  const s = fresh();
  s.profile.parkingLead = 60;
  applyRequest(s, '지하 2층 C36에 주차했어', start);
  assert.equal(s.parking.show, '08:00');
  s.parking.enabled = false;
  assert.ok(!visibleCards(s, start).includes('parking'));
});
test('알림의 목표 시각은 직렬화와 새로고침 후에도 유지된다', () => {
  const s = fresh(); applyRequest(s, '30분 뒤에 물 마시라고 알림 줘', start);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(restored.reminders[0].target, start + 1800000);
  assert.equal(restored.reminders[0].title, '물 한 잔 마시기');
});
test('대시보드에는 먼 미래 알림을 올리지 않고 기한이 가까우면 표시한다', () => {
  const s = fresh();
  applyRequest(s, '오후 6시에 알림 줘', start);
  assert.ok(!visibleCards(s, start).some(card => card.startsWith('reminder:')));
  const near = new Date(2026, 8, 29, 17).getTime();
  assert.ok(visibleCards(s, near).some(card => card.startsWith('reminder:')));
});
test('시간이 없는 일정은 임의 시각으로 저장하지 않는다', () => {
  const s = fresh(), before = s.events.length;
  assert.match(applyRequest(s, '내일 디자인 미팅 일정 추가해줘', start).text, /몇 시/);
  assert.equal(s.events.length, before);
});
test('대화로 메모와 내일 일정을 저장하고 기존 기능을 실행한다', () => {
  const s = fresh(); applyRequest(s, '우산 챙기기 메모해줘', start);
  assert.equal(s.notes[0].title, '우산 챙기기');
  applyRequest(s, '내일 오후 2시 디자인 미팅 일정 추가해줘', start);
  assert.equal(s.events.at(-1).date, '2026-09-30');
  assert.equal(s.events.at(-1).time, '14:00');
  applyRequest(s, '퇴근 정리 실행해줘', start);
  assert.equal(s.customs.length, 1); assert.equal(s.customs[0].runs, 1);
  s.customs[0].active = false; assert.equal(runCustom(s, s.customs[0].id), null);
});
test('명시적으로 요청한 커스텀 기능만 만들고 이름 중복을 방지한다', () => {
  const s = fresh(), request = '매일 저녁 8시에 오늘 메모를 모아서 정리하는 기능 만들어줘. 제목은 하루 마무리로 해줘';
  applyRequest(s, request, start); applyRequest(s, request, start);
  assert.equal(s.customs.length, 2); assert.equal(s.customs[1].title, '하루 마무리');
  assert.equal(s.customs[1].time, '20:00');
});
test('예약 실행은 수집 중과 완료를 구분하며 같은 날짜에 중복 실행하지 않는다', () => {
  const s = fresh(); setClock(s, 9, 0, start); const t = nowOf(s, start);
  tickScheduled(s, t); assert.equal(s.news.status, 'loading');
  tickScheduled(s, t + 1800); assert.equal(s.news.status, 'ready');
  const evening = new Date(2026, 8, 29, 19).getTime();
  tickScheduled(s, evening); assert.equal(s.customs[0].runs, 1);
  tickScheduled(JSON.parse(JSON.stringify(s)), evening + 1000);
  tickScheduled(s, evening + 1000); assert.equal(s.customs[0].runs, 1);
});
