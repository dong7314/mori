const fields = form => [...form.elements].filter(field => field.name && !['submit', 'button', 'file'].includes(field.type));
const snapshot = form => fields(form).map(field => ({ name: field.name, type: field.type, value: field.value, checked: field.checked }));
const keyOf = form => `${form.id}:${form.dataset.draftKey || form.dataset.id || 'new'}`;

// Unsaved edits belong to the form/record being edited, not the saved record.
export function createFormDrafts({ storage = null, key = 'mori.form-drafts.v1' } = {}) {
  let stored;
  try { stored = JSON.parse(storage?.getItem(key) || '[]'); } catch { stored = []; }
  const drafts = new Map(Array.isArray(stored) ? stored.filter(item => Array.isArray(item) && typeof item[0] === 'string' && Array.isArray(item[1])) : []), baselines = new WeakMap();
  const persist = () => {
    try { storage?.setItem(key, JSON.stringify([...drafts])); return true; }
    catch { return false; }
  };
  function restore(form) {
    if (!form) return false;
    const baseline = snapshot(form), draft = drafts.get(keyOf(form));
    baselines.set(form, baseline);
    if (!draft) return false;
    if (JSON.stringify(draft) === JSON.stringify(baseline)) { drafts.delete(keyOf(form)); persist(); return false; }
    for (const field of fields(form)) {
      const value = draft.find(item => item.name === field.name && item.type === field.type &&
        (!['radio', 'checkbox'].includes(field.type) || item.value === field.value));
      if (!value) continue;
      if (['radio', 'checkbox'].includes(field.type)) field.checked = value.checked;
      else field.value = value.value;
    }
    return true;
  }
  function capture(form) {
    if (!form || !baselines.has(form)) return true;
    const value = snapshot(form);
    if (JSON.stringify(value) === JSON.stringify(baselines.get(form))) drafts.delete(keyOf(form));
    else drafts.set(keyOf(form), value);
    return persist();
  }
  function commit(form) {
    if (!form) return;
    drafts.delete(keyOf(form));
    baselines.set(form, snapshot(form));
    persist();
  }
  function discard(form) {
    if (!form) return;
    const original = baselines.get(form);
    if (original) {
      drafts.set(keyOf(form), original);
      restore(form);
      baselines.set(form, original);
    }
    drafts.delete(keyOf(form));
    persist();
  }
  function remove(formId, record) {
    drafts.delete(`${formId}:${record}`); persist();
  }
  return { restore, capture, commit, discard, remove };
}
