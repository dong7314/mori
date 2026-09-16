import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateConcierge, nextRunAt, buildBrief, matchConciergeRequest } from '../src/concierge-model.mjs';

test('기존 기록과 직접 바꾼 취향·반복 설정을 보존한다', () => {
  const first = hydrateConcierge({notes:[{content:'남겨둔 기억'}]});
  first.concierge.preferences.reply='짧게 한 문장';
  first.concierge.jobs[0].enabled=false;
  const next = hydrateConcierge(first);
  assert.equal(next.notes[0].content,'남겨둔 기억');
  assert.equal(next.concierge.preferences.reply,'짧게 한 문장');
  assert.equal(next.concierge.jobs[0].enabled,false);
});
test('지난 실행 시각과 주말을 건너뛰고 중지한 일은 다음 실행이 없다', () => {
  const job=hydrateConcierge({}).concierge.jobs[0];
  const next=nextRunAt(job,new Date('2026-09-18T08:00:00'));
  assert.equal(next.getDay(),1); assert.equal(next.getDate(),21);
  assert.equal(next.getHours(),7); assert.equal(next.getMinutes(),20);
  const weekly={...job,days:[0],time:'20:00'};
  assert.equal(nextRunAt(weekly,new Date('2026-09-20T20:00:00')).getDate(),27);
  assert.equal(nextRunAt({...job,enabled:false}),null);
});
test('브리핑은 실제 로컬 기록만 모으며 주간 범위 밖의 기록은 섞지 않는다', () => {
  const state=hydrateConcierge({events:[{date:'2026-09-16',time:'18:00',title:'오늘 약속'},{date:'2026-09-17',time:'10:00',title:'미래 약속'}],notes:[{content:'이번 주 메모',createdAt:'2026-09-12'},{content:'오래된 메모',createdAt:'2026-08-01'}],parking:null});
  const morning=buildBrief(state,'morning',new Date('2026-09-16T08:00:00'));
  assert.equal(morning.items[0].value,'1개의 약속');
  assert.equal(morning.items[1].value,'아직 남긴 위치가 없어요');
  const weekly=buildBrief(state,'weekly',new Date('2026-09-16T08:00:00'));
  assert.equal(weekly.items[1].detail,'이번 주 메모');
  assert.ok(!weekly.items[0].detail.includes('미래 약속'));
  assert.equal(matchConciergeRequest('매일 아침 8시에 브리핑해 줘'),'morning');
  assert.equal(matchConciergeRequest('일요일에 한 주를 정리해 줘'),'weekly');
});
