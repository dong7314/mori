// Dialog destinations share browser history with tabs. Snapshots stay in this
// page's memory; history.state contains only an opaque id, never form content.
export function createScreenHistory({ history, location, events, restore, session = crypto.randomUUID() }) {
  const key = 'moriScreen', entries = new Map();
  let sequence = 0, current, applying = false, pending = null;
  const marker = () => history.state?.[key];
  const write = (entry, push = false) => {
    entries.set(entry.id, entry); current = entry;
    history[push ? 'pushState' : 'replaceState']({ ...history.state, [key]: { session, id: entry.id, depth: entry.depth } }, '', location.href);
  };
  function route() {
    if (pending?.startup) return;
    const state = marker(), known = state?.session === session && entries.get(state.id);
    if (known?.hash === location.hash) { current = known; return; }
    write({ id: ++sequence, depth: 0, snapshot: null, hash: location.hash });
  }
  function sync(depth, snapshot) {
    if (applying) return Promise.resolve();
    if (pending) return pending.done.then(() => sync(depth, snapshot));
    if (!current) route();
    if (depth < current.depth) {
      let resolve;
      const done = new Promise(finish => { resolve = finish; });
      pending = { depth, snapshot, done, resolve };
      history.go(depth - current.depth);
      return done;
    }
    // Each depth is a real Back destination, including a sheet over a chat.
    while (current.depth < depth) write({ id: ++sequence, depth: current.depth + 1, snapshot, hash: location.hash }, true);
    write({ ...current, snapshot });
    return Promise.resolve();
  }
  let restoring = Promise.resolve();
  events.addEventListener('popstate', event => {
    const state = event.state?.[key];
    const entry = state?.session === session && entries.get(state.id);
    current = entry || { id: ++sequence, depth: 0, snapshot: null, hash: location.hash };
    if (pending && current.depth === pending.depth) {
      const operation = pending; pending = null;
      write({ ...current, snapshot: operation.snapshot }); operation.resolve();
      return;
    }
    if (pending) { const operation = pending; pending = null; operation.resolve(); }
    const snapshot = current.snapshot;
    restoring = restoring.then(async () => {
      applying = true;
      try { await restore(snapshot); }
      finally { applying = false; }
    });
  });
  const staleDepth = marker()?.depth;
  if (Number.isSafeInteger(staleDepth) && staleDepth > 0) {
    // A reloaded document has no in-memory dialog snapshots. Return to its
    // existing tab entry instead of leaving invisible Back steps behind.
    let resolve;
    const done = new Promise(finish => { resolve = finish; });
    pending = { depth: 0, snapshot: null, done, resolve, startup: true };
    history.go(-staleDepth);
  } else route();
  return { sync, route, get restoring() { return applying; }, settled: () => restoring };
}
