// Keep successful object identities alive for pending chat requests. Roll back
// all related records together when persisting a user action fails.
export function commitStateChange(state, mutate, persist) {
  const previous = structuredClone(state);
  let value;
  try { value = mutate(state); }
  catch (error) { return { ok: false, state: previous, error }; }
  try {
    if (persist(state) !== false) return { ok: true, state, value };
  } catch { /* The caller presents one consistent save failure. */ }
  return { ok: false, state: previous, error: new Error('저장하지 못했어요. 작성한 내용은 유지됩니다. 저장 공간을 확보한 뒤 다시 시도해 주세요.') };
}
