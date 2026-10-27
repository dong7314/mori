// The save action can sit in a fixed header while the form itself scrolls.
// Keep validation next to the field, and let save failures focus the summary.
const feedback = new WeakMap();
let errorSequence = 0;

function presentedControl(control) {
  return control?.hasAttribute?.('data-picker-input')
    ? control.closest('[data-form-picker]')?.querySelector('[data-picker-trigger]') || control : control;
}

function available(control, form) {
  if (!control || control.disabled) return false;
  control = presentedControl(control);
  return Boolean(control && form.contains(control) && !control.disabled &&
    control.type !== 'hidden' && !control.closest('[hidden], [inert]') &&
    control.getClientRects().length);
}

// Use the same messages for native constraints and application validation.
export function validationMessage(control) {
  const names = { title: control.form?.id === 'event-form' ? '일정 이름' : '제목', name: '이름', topic: '관심 주제', date: '날짜', time: '시간' };
  const label = names[control.name] || control.labels?.[0]?.querySelector('span')?.textContent?.replace(/ · 선택$/, '').trim() || '이 항목';
  const consonant = (label.charCodeAt(label.length - 1) - 0xac00) % 28 > 0;
  if (control.validity?.valueMissing || control.required && typeof control.value === 'string' && !control.value.trim()) return `${label}${consonant ? '을' : '를'} 입력해 주세요.`;
  if (control.validity?.tooLong) return `${label}${consonant ? '은' : '는'} ${control.maxLength}자 이내로 입력해 주세요.`;
  return `${label}${consonant ? '을' : '를'} 확인해 주세요.`;
}

export function validateForm(form) {
  const invalid = Array.from(form.elements || []).find(control => available(control, form) && control.willValidate &&
    (control.validity?.valid === false || control.required && typeof control.value === 'string' && !control.value.trim()));
  if (!invalid) return true;
  showFormError(form, validationMessage(invalid), { field: invalid });
  return false;
}

function resolveField(form, field) {
  const controls = Array.from(form.elements || []);
  const explicit = typeof field === 'string'
    ? controls.map(control => control.name === field ? presentedControl(control) !== control ? presentedControl(control) : control.type === 'hidden' ? control.closest('[data-choice]')?.querySelector('.choice-trigger') : control : null)
      .find(control => available(control, form))
    : available(field, form) ? presentedControl(field) : null;
  return explicit || presentedControl(controls.find(control => available(control, form) &&
    control.willValidate && control.validity?.valid === false)) || null;
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
export function showFormError(form, message, { field = null, relatedFields = [] } = {}) {
  if (!form?.isConnected) return null;
  clearFormError(form);
  const error = errorElement(form), control = resolveField(form, field);
  const state = { error, control, relatedFields, fieldName: typeof field === 'string' ? field : field?.name || control?.name, invalid: control?.getAttribute('aria-invalid') ?? null,
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
  const { error, control, fieldName, relatedFields, invalid, tabIndex, addedDescription } = state;
  if (changedControl && (!form.contains(changedControl) ||
    control && changedControl !== control && (!fieldName || changedControl.name !== fieldName) && !relatedFields.includes(changedControl.name))) return false;
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
