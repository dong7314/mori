// Each live search field owns its pending work. Composition replaces earlier
// work without publishing partial IME text; clearing remains immediate.
export function createSearchUpdates({ delay = 120, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new WeakMap();
  function cancel(input) {
    const job = pending.get(input);
    if (!job) return;
    pending.delete(input);
    clearTimer(job.timer);
  }
  function schedule(input, update, { composing = false, immediate = false } = {}) {
    cancel(input);
    if (composing) return;
    if (immediate || input.value === '') return update();
    const job = {};
    pending.set(input, job);
    job.timer = setTimer(() => {
      if (pending.get(input) !== job) return;
      pending.delete(input);
      if (input.isConnected !== false) update();
    }, delay);
  }
  return { schedule, cancel };
}
