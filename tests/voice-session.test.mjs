import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession } from '../src/voice-session.mjs';

test('permission-pending cancellation retains the exact draft and ignores late callbacks', () => {
  const voice = createVoiceSession(), original = '적어 둔 문장\n';
  const id = voice.begin(original);
  assert.equal(voice.state.phase, 'requesting');
  voice.cancel(); voice.listening(id); voice.update(id, [{ text: '늦게 들어온 말', final: true }]); voice.finish(id);
  assert.equal(voice.state.phase, 'idle');
  assert.equal(voice.state.draft, original);
});

test('interim snapshots replace earlier text and merge once only when recording ends', () => {
  const voice = createVoiceSession(), id = voice.begin('기존 메모');
  voice.listening(id);
  voice.update(id, [{ text: '내일', final: true }, { text: '오후 두', final: false }]);
  assert.equal(voice.state.draft, '기존 메모');
  assert.equal(voice.state.finalText, '내일');
  assert.equal(voice.state.interim, '오후 두');
  voice.update(id, [{ text: '내일', final: true }, { text: '오후 두 시 회의', final: true }]);
  voice.processing(id); voice.finish(id);
  assert.equal(voice.state.draft, '기존 메모\n내일 오후 두 시 회의');
  const completed = voice.state;
  voice.finish(id); voice.update(id, [{ text: '중복 문장', final: true }]); voice.fail(id, 'network');
  assert.equal(voice.state, completed);
});

test('a new recording appends to the corrected draft and ignores the previous session', () => {
  const voice = createVoiceSession();
  const first = voice.begin(''); voice.update(first, [{ text: 'B16', final: true }]); voice.finish(first);
  const second = voice.begin('B17로 수정했어');
  voice.update(first, [{ text: '늦은 B16', final: true }]);
  voice.update(second, [{ text: '내일 알려줘', final: true }]); voice.finish(second);
  assert.equal(voice.state.draft, 'B17로 수정했어\n내일 알려줘');
});

test('cancelled partial recording and recognition errors never change typed text', () => {
  const voice = createVoiceSession(), id = voice.begin(' 원래 초안  ');
  voice.update(id, [{ text: '중간에 멈춘 문장', final: false }]); voice.fail(id, 'network');
  assert.equal(voice.state.draft, ' 원래 초안  ');
  assert.equal(voice.state.transcript, '중간에 멈춘 문장');
  voice.cancel(); assert.equal(voice.state.draft, ' 원래 초안  ');
});

test('overflow preserves the whole transcript for correction without silent truncation', () => {
  const voice = createVoiceSession({ limit: 12 });
  const state = voice.accept('새로 인식한 아주 긴 문장', '기존 초안');
  assert.equal(state.error, 'limit');
  assert.equal(state.draft, '기존 초안');
  assert.equal(state.transcript, '새로 인식한 아주 긴 문장');
  assert.equal(voice.accept('짧은 말', '기존 초안').draft, '기존 초안\n짧은 말');
});

test('empty recordings report no speech and keep the existing draft', () => {
  const voice = createVoiceSession(), id = voice.begin('남겨 둔 글');
  voice.finish(id);
  assert.equal(voice.state.error, 'no-speech');
  assert.equal(voice.state.draft, '남겨 둔 글');
});

test('keyboard continuation after a successful merge retains dictated text', () => {
  const voice = createVoiceSession(); voice.accept('주차했어', 'B3 B16');
  assert.equal(voice.cancel().draft, 'B3 B16\n주차했어');
});
