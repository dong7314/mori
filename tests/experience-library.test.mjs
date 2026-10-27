import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsOf, conversationGroups, customPreview, normalizeCustomSchedule } from '../src/experience-library.mjs';

test('record library merges types in recent order without changing saved arrays', () => {
  const state = { notes: [{ id: 'n', body: 'note', at: 20 }], documents: [{ id: 'd', filename: 'doc.txt', at: 30 }], customs: [{ id: 'c', result: { at: 40, items: [{ done: true }, { done: false }] } }, { id: 'draft' }] };
  const before = structuredClone(state);
  assert.deepEqual(recordsOf(state).map(r => r.id), ['c', 'd', 'n']);
  assert.equal(recordsOf(state)[0].excerpt, '할 일 2개 · 1개 완료');
  assert.deepEqual(recordsOf(state, 'document').map(r => r.id), ['d']);
  assert.deepEqual(state, before);
});

test('pinned conversations appear once; grouping handles month boundaries', () => {
  const now = new Date(2026, 9, 1, 8).getTime();
  const rows = [{ id: 'yesterday', title: 'AI', at: new Date(2026, 8, 30, 23).getTime(), messages: [] }, { id: 'pinned', title: '주차', pinned: true, at: now, messages: [] }, { id: 'today', title: '부탁', at: now, messages: [{ text: 'EXCEL 정리' }] }];
  assert.deepEqual(conversationGroups(rows, '', now).map(([label, items]) => [label, items.map(c => c.id)]), [['고정한 대화', ['pinned']], ['오늘', ['today']], ['어제', ['yesterday']]]);
  assert.equal(conversationGroups(rows, ' excel ', now)[0][1][0].id, 'today');
  assert.deepEqual(conversationGroups(rows, '없는 검색어', now), []);
  assert.equal(rows[0].id, 'yesterday');
});

test('custom preview preserves the visible schedule choices and allowed icons', () => {
  const values = { title: '', work: ' 메모를 정리해줘 ', description: '', time: '19:00', repeat: '필요할 때', icon: 'leaf' };
  assert.deepEqual(customPreview(values), { title: '메모를 정리해줘', work: '메모를 정리해줘', description: '나에게 맞춰 기억하는 작은 부탁', time: '19:00', repeat: '필요할 때', icon: 'leaf' });
  assert.equal(customPreview({ ...values, time: '', repeat: '평일' }).repeat, '평일');
  assert.equal(customPreview({ ...values, icon: 'unknown' }).icon, 'spark');
});

test('manual and scheduled custom requests retain their chosen execution policy', () => {
  assert.deepEqual(normalizeCustomSchedule({ time: '', repeat: '필요할 때' }), { time: '', repeat: '필요할 때' });
  for (const repeat of ['매일', '평일', '한 번']) {
    const values = { time: '19:00', repeat, title: '정리' }, original = structuredClone(values);
    assert.deepEqual(normalizeCustomSchedule(values), { time: '19:00', repeat });
    assert.deepEqual(values, original);
  }
  assert.deepEqual(normalizeCustomSchedule(), { time: '', repeat: '필요할 때' });
});

test('contradictory custom schedule choices require a correction instead of silent conversion', () => {
  assert.throws(() => normalizeCustomSchedule({ time: '19:00', repeat: '필요할 때' }), error =>
    error.field === 'repeat' && /반복 방식/.test(error.message));
  for (const repeat of ['매일', '평일', '한 번']) {
    assert.throws(() => normalizeCustomSchedule({ time: '', repeat }), error =>
      error.field === 'time' && /시간/.test(error.message));
  }
});

test('custom schedule validation rejects unsupported recurrence and invalid clock values', () => {
  assert.throws(() => normalizeCustomSchedule({ time: '19:00', repeat: '매주' }), error => error.field === 'repeat');
  for (const time of ['24:00', '23:60', '9:00', 'noon']) {
    assert.throws(() => normalizeCustomSchedule({ time, repeat: '매일' }), error => error.field === 'time');
  }
  for (const time of ['00:00', '23:59']) {
    assert.deepEqual(normalizeCustomSchedule({ time, repeat: '매일' }), { time, repeat: '매일' });
  }
});
