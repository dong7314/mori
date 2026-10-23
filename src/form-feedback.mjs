// The save action can sit in a fixed header while the form itself scrolls.
// Keep validation next to the field, and let save failures focus the summary.
const feedback = new WeakMap();
let errorSequence = 0;

function available(control, form) {
  return Boolean(control && form.contains(control) && !control.disabled &&
    control.type !== 'hidden' && !control.closest('[hidden], [inert]') &&
    control.getClientRects().length);
}

function resolveField(form, field) {
  const controls = Array.from(form.elements || []);
  const explicit = typeof field === 'string'
    ? controls.find(control => control.name === field && available(control, form))
    : available(field, form) ? field : null;
  return explicit || controls.find(control => available(control, form) &&
    control.willValidate && control.validity?.valid === false) || null;
}

function errorElement(form) {
  let error = form.querySelector('.form-error');
  if (!error) {
    error = form.ownerDocument.createElement('p');
    error.className = 'form-error';
    form.prepend(error);
  }
  if (!error.id) {
    let id;
    do { id = `form-error-${++errorSequence}`; }
    while (form.ownerDocument.getElementById(id));
    error.id = id;
  }
  error.hidden = false;
  error.setAttribute('role', 'alert');
  return error;
}

/** Show a field validation error, or a form-level save/server failure. */
export function showFormError(form, message, { field = null } = {}) {
  if (!form?.isConnected) return null;
  clearFormError(form);
  const error = errorElement(form), control = resolveField(form, field);
  const state = { error, control, invalid: control?.getAttribute('aria-invalid') ?? null,
    tabIndex: error.getAttribute('tabindex') };
  error.textContent = String(message || '입력한 내용을 확인해 주세요.');
  if (control) {
    const descriptions = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    state.addedDescription = !descriptions.has(error.id);
    descriptions.add(error.id);
    control.setAttribute('aria-describedby', [...descriptions].join(' '));
    control.setAttribute('aria-invalid', 'true');
    const wrapper = control.closest('.field, [data-choice], fieldset');
    if (wrapper && form.contains(wrapper)) wrapper.after(error);
  } else {
    form.prepend(error);
    error.setAttribute('tabindex', '-1');
  }
  feedback.set(form, state);
  (control || error).focus({ preventScroll: true });
  error.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  return control || error;
}

/** Clear on edits to the affected field (or any edit after a form-level failure). */
export function clearFormError(form, changedControl = null) {
  const state = feedback.get(form);
  if (!state) return false;
  const { error, control, invalid, tabIndex, addedDescription } = state;
  if (changedControl && (!form.contains(changedControl) ||
    control && changedControl !== control && (!control.name || changedControl.name !== control.name))) return false;
  if (control) {
    const descriptions = (control.getAttribute('aria-describedby') || '').split(/\s+/)
      .filter(id => id && (!addedDescription || id !== error.id));
    if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '));
    else control.removeAttribute('aria-describedby');
    if (invalid === null) control.removeAttribute('aria-invalid');
    else control.setAttribute('aria-invalid', invalid);
  }
  error.textContent = '';
  if (tabIndex === null) error.removeAttribute('tabindex');
  else error.setAttribute('tabindex', tabIndex);
  feedback.delete(form);
  return true;
}
