import { appendTranscript } from './voice-transcript.mjs';

const activePhases = new Set(['requesting', 'listening', 'processing']);

// A recognition result is a snapshot of this recording, not a chunk to append.
// Keeping the draft separate means cancellation and late browser callbacks can
// never erase typed text or add the same recording twice.
export function createVoiceSession({ limit = 4000 } = {}) {
  let generation = 0;
  let value = idle('');
  function idle(draft) {
    return { id: generation, phase: 'idle', base: draft, draft, transcript: '', finalText: '', interim: '', error: null };
  }
  const accepts = id => value.id === id && activePhases.has(value.phase);
  function begin(draft) {
    generation += 1;
    value = { ...idle(draft), phase: 'requesting' };
    return generation;
  }
  function update(id, results) {
    if (!accepts(id)) return value;
    const parts = results.map(result => ({ text: String(result.text || '').trim(), final: Boolean(result.final) })).filter(result => result.text);
    value = { ...value, transcript: parts.map(result => result.text).join(' '), finalText: parts.filter(result => result.final).map(result => result.text).join(' '), interim: parts.filter(result => !result.final).map(result => result.text).join(' ') };
    return value;
  }
  function fail(id, error) {
    if (accepts(id)) value = { ...value, phase: 'error', draft: value.base, error };
    return value;
  }
  function finish(id) {
    if (!accepts(id)) return value;
    if (!value.transcript.trim()) return fail(id, 'no-speech');
    const draft = appendTranscript(value.base, value.transcript);
    if (draft.length > limit) return fail(id, 'limit');
    value = { ...value, phase: 'ready', draft, error: null };
    return value;
  }
  function cancel() {
    const draft = value.phase === 'ready' ? value.draft : value.base;
    generation += 1;
    value = idle(draft);
    return value;
  }
  return {
    get state() { return value; },
    begin, update, finish, fail, cancel,
    reset(draft) { generation += 1; value = idle(draft); return value; },
    listening(id) { if (accepts(id) && value.phase === 'requesting') value = { ...value, phase: 'listening' }; return value; },
    processing(id) { if (accepts(id)) value = { ...value, phase: 'processing' }; return value; },
    accept(text, draft) { const id = begin(draft); update(id, [{ text, final: true }]); return finish(id); },
  };
}
