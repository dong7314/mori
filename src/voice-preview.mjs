// A visible, opt-in design rehearsal for device-preview frames. It never opens a
// microphone, sends a message, or replaces the browser's recognition API.
export function createVoicePreview({ session, onChange, onFinish, isOpen, schedule = setTimeout, unschedule = clearTimeout }) {
  let currentId = null, timers = [];
  const valid = id => currentId === id && session.state.id === id && isOpen();
  function cancel() {
    currentId = null;
    timers.forEach(unschedule); timers = [];
  }
  function finish() {
    const id = currentId;
    if (!valid(id)) { cancel(); return; }
    cancel(); session.finish(id); onFinish();
  }
  function start(draft) {
    cancel();
    const id = session.begin(draft); currentId = id; onChange();
    const at = (delay, change) => timers.push(schedule(() => { if (valid(id)) change(id); }, delay));
    at(400, id => { session.listening(id); onChange(); });
    at(1600, id => { session.update(id, [{ text: '내일 아침', final: false }]); onChange(); });
    at(2900, id => { session.update(id, [{ text: '내일 아침에 산책하는 거', final: false }]); onChange(); });
    at(4200, id => { session.update(id, [{ text: '내일 아침에 산책하는 거 기억해 줘.', final: true }]); onChange(); });
    at(5500, id => { session.processing(id); onChange(); });
    at(6600, finish);
  }
  return { start, finish, cancel, get active() { return currentId !== null; } };
}
