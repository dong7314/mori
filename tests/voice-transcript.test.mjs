import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTranscript } from '../src/voice-transcript.mjs';

test('recording again preserves the previous dictated and corrected text', () => {
  assert.equal(appendTranscript('지하 3층 B16에 주차했어.', '내일 출근할 때 알려줘.'), '지하 3층 B16에 주차했어.\n내일 출근할 때 알려줘.');
});

test('interim recognition updates replace this session without repeating earlier words', () => {
  const previous = '내일 일정에 추가해줘.';
  assert.equal(appendTranscript(previous, '오후 두'), '내일 일정에 추가해줘.\n오후 두');
  assert.equal(appendTranscript(previous, '오후 두 시 회의'), '내일 일정에 추가해줘.\n오후 두 시 회의');
});

test('an empty recognition session leaves manually edited text intact', () => {
  assert.equal(appendTranscript('메모 내용\n', ' '), '메모 내용\n');
  assert.equal(appendTranscript('', ' 새 메모 '), '새 메모');
});
