import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession } from '../src/voice-session.mjs';
import { createVoicePreview } from '../src/voice-preview.mjs';

function rehearsal() {
  const session = createVoiceSession(), jobs = [], phases = [];
  let open = true, completions = 0;
  const preview = createVoicePreview({ session, onChange: () => phases.push(session.state.phase), onFinish: () => completions++, isOpen: () => open, schedule: (fn, delay) => { jobs.push({ fn, delay }); return jobs.length; }, unschedule: () => {} });
  return { session, preview, phases, jobs, close: () => { open = false; }, get completions() { return completions; } };
}

test('voice rehearsal completes in the draft without sending and merges the existing text once', () => {
  const r = rehearsal(); r.preview.start('원래 메모');
  r.jobs.forEach(job => job.fn());
  assert.equal(r.session.state.draft, '원래 메모\n내일 아침에 산책하는 거 기억해 줘.');
  assert.equal(r.session.state.phase, 'ready');
  assert.equal(r.completions, 1);
  assert.equal(r.preview.active, false);
  assert.deepEqual(r.phases, ['requesting', 'listening', 'listening', 'listening', 'listening', 'processing']);
  r.jobs.forEach(job => job.fn());
  assert.equal(r.completions, 1);
});

test('closing or cancelling a rehearsal rejects queued callbacks even if the timer already fired', () => {
  for (const action of ['cancel', 'close']) {
    const r = rehearsal(); r.preview.start('유지할 초안');
    action === 'cancel' ? r.preview.cancel() : r.close();
    const state = r.session.state;
    r.jobs.forEach(job => job.fn());
    assert.equal(r.session.state, state);
    assert.equal(r.completions, 0);
  }
});

test('restarting ignores the old rehearsal and manual finish commits only the current caption', () => {
  const r = rehearsal(); r.preview.start('첫 초안');
  const oldJobs = [...r.jobs];
  r.preview.start('수정한 초안');
  oldJobs.forEach(job => job.fn());
  assert.equal(r.session.state.phase, 'requesting');
  r.jobs[oldJobs.length + 1].fn();
  r.preview.finish();
  assert.equal(r.session.state.draft, '수정한 초안\n내일 아침');
  r.jobs.forEach(job => job.fn());
  assert.equal(r.completions, 1);
});
