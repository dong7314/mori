import test from 'node:test';
import assert from 'node:assert/strict';
import { showFormError, clearFormError, validateForm } from '../src/form-feedback.mjs';

function fixture(fields = [], sharedDocument = null) {
  const document = sharedDocument || { nodes: [], getElementById(id) { return this.nodes.find(node => node.id === id) || null; } };
  const form = { isConnected: true, elements: [], nodes: [], ownerDocument: document,
    contains(node) { return this.nodes.includes(node); },
    querySelector(selector) { return this.nodes.find(node => selector === '.form-error' && node.className === 'form-error') || null; },
    prepend(node) { this.nodes = [node, ...this.nodes.filter(item => item !== node)]; node.placement = 'first'; },
  };
  function element(properties = {}) {
    const attributes = new Map();
    const node = { id: '', name: '', type: 'text', hidden: false, disabled: false,
      className: '', textContent: '', willValidate: false, validity: { valid: true },
      getAttribute: key => attributes.get(key) ?? null,
      hasAttribute: key => attributes.has(key),
      setAttribute: (key, value) => attributes.set(key, String(value)),
      removeAttribute: key => attributes.delete(key),
      closest(selector) { return selector.startsWith('[hidden]') ? this.hidden ? {} : null : this.wrapper || null; },
      getClientRects() { return this.noLayout ? [] : [{}]; },
      focus(options) { this.focusOptions = options; },
      scrollIntoView(options) { this.scrollOptions = options; },
      after(other) { other.placement = this; if (!form.contains(other)) form.nodes.push(other); },
      ...properties,
    };
    document.nodes.push(node); form.nodes.push(node);
    return node;
  }
  document.createElement = () => element();
  for (const properties of fields) {
    const wrapper = element();
    form.elements.push(element({ wrapper, ...properties }));
  }
  const error = element({ className: 'form-error' });
  return { form, error, controls: form.elements, document, element };
}

test('an explicit business validation target wins over native-invalid fields and has visible adjacent feedback', () => {
  const { form, error, controls: [title, spot] } = fixture([
    { name: 'title', willValidate: true, validity: { valid: false } }, { name: 'spot' },
  ]);
  const focused = showFormError(form, '구역이나 자리를 입력해 주세요.', { field: 'spot' });
  assert.equal(focused, spot);
  assert.equal(title.focusOptions, undefined);
  assert.deepEqual(spot.focusOptions, { preventScroll: true });
  assert.equal(error.placement, spot.wrapper);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.textContent, '구역이나 자리를 입력해 주세요.');
  assert.equal(spot.getAttribute('aria-invalid'), 'true');
  assert.equal(spot.getAttribute('aria-describedby'), error.id);
  assert.deepEqual(error.scrollOptions, { block: 'nearest', inline: 'nearest', behavior: 'instant' });
});

test('native-invalid fallback skips disabled, hidden, and non-rendered controls', () => {
  const invalid = { willValidate: true, validity: { valid: false } };
  const { form, controls } = fixture([
    { name: 'off', disabled: true, ...invalid }, { name: 'secret', type: 'hidden', ...invalid },
    { name: 'collapsed', hidden: true, ...invalid }, { name: 'not-rendered', noLayout: true, ...invalid },
    { name: 'date', ...invalid },
  ]);
  assert.equal(showFormError(form, '날짜를 확인해 주세요.', { field: 'off' }), controls.at(-1));
});

test('save failures focus the form summary without wrongly marking a valid field invalid', () => {
  const { form, error, controls: [title] } = fixture([{ name: 'title' }]);
  assert.equal(showFormError(form, '저장 공간이 부족해요.'), error);
  assert.equal(error.placement, 'first');
  assert.equal(error.getAttribute('tabindex'), '-1');
  assert.deepEqual(error.focusOptions, { preventScroll: true });
  assert.equal(title.getAttribute('aria-invalid'), null);
  assert.equal(clearFormError(form, title), true);
  assert.equal(error.textContent, '');
  assert.equal(error.getAttribute('tabindex'), null);
});

test('unrelated edits keep field feedback, while editing the target restores its original ARIA', () => {
  const { form, error, controls: [title, body] } = fixture([{ name: 'title' }, { name: 'body' }]);
  title.setAttribute('aria-describedby', 'title-help');
  title.setAttribute('aria-invalid', 'false');
  showFormError(form, '제목을 입력해 주세요.', { field: title });
  title.setAttribute('aria-describedby', `${title.getAttribute('aria-describedby')} new-help`);
  assert.equal(clearFormError(form, body), false);
  assert.notEqual(error.textContent, '');
  assert.equal(clearFormError(form, title), true);
  assert.equal(title.getAttribute('aria-describedby'), 'title-help new-help');
  assert.equal(title.getAttribute('aria-invalid'), 'false');
  assert.equal(error.textContent, '');
});

test('repeated validation moves the association and never leaves the previous field invalid', () => {
  const { form, error, controls: [title, body] } = fixture([{ name: 'title' }, { name: 'body' }]);
  showFormError(form, '제목 확인', { field: title });
  const id = error.id;
  showFormError(form, '내용 확인', { field: body });
  assert.equal(error.id, id);
  assert.equal(title.getAttribute('aria-invalid'), null);
  assert.equal(title.getAttribute('aria-describedby'), null);
  assert.equal(body.getAttribute('aria-describedby'), id);
  clearFormError(form);
  assert.equal(body.getAttribute('aria-invalid'), null);
  assert.equal(body.getAttribute('aria-describedby'), null);
});

test('error IDs remain distinct across open forms and a removed form is not focused', () => {
  const first = fixture([{ name: 'title' }]), second = fixture([{ name: 'title' }], first.document);
  showFormError(first.form, '첫 오류', { field: 'title' });
  showFormError(second.form, '다음 오류', { field: 'title' });
  assert.notEqual(first.error.id, second.error.id);
  const removed = fixture([{ name: 'title' }]); removed.form.isConnected = false;
  assert.equal(showFormError(removed.form, '오류'), null);
  assert.equal(removed.error.focusOptions, undefined);
  assert.equal(removed.error.textContent, '');
});

test('clearing an error preserves a description link that was present before validation', () => {
  const { form, error, controls: [title] } = fixture([{ name: 'title' }]);
  error.id = 'existing-error';
  title.setAttribute('aria-describedby', 'title-help existing-error');
  showFormError(form, '확인해 주세요.', { field: title });
  clearFormError(form);
  assert.equal(title.getAttribute('aria-describedby'), 'title-help existing-error');
});

test('a form without an error element gets an alert, and editing another member clears group feedback', () => {
  const { form, controls: [monday, tuesday] } = fixture([
    { name: 'days', type: 'checkbox' }, { name: 'days', type: 'checkbox' },
  ]);
  form.nodes = form.nodes.filter(node => node.className !== 'form-error');
  showFormError(form, '요일을 하나 이상 선택해 주세요.', { field: 'days' });
  const error = form.querySelector('.form-error');
  assert.ok(error);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(monday.getAttribute('aria-invalid'), 'true');
  assert.equal(clearFormError(form, tuesday), true);
  assert.equal(monday.getAttribute('aria-invalid'), null);
  assert.equal(error.textContent, '');
});

test('required and whitespace-only fields use the same inline alert and focus', () => {
  const { form, error, controls: [title] } = fixture([{ name: 'title', value: '', required: true, willValidate: true, validity: { valid: false, valueMissing: true } }]);
  assert.equal(validateForm(form), false);
  assert.equal(error.textContent, '제목을 입력해 주세요.');
  assert.equal(title.getAttribute('aria-invalid'), 'true');
  title.value = '  '; title.validity = { valid: true };
  assert.equal(validateForm(form), false);
  title.value = '회의'; clearFormError(form, title);
  assert.equal(validateForm(form), true);
});

test('hidden choice values associate feedback with their visible trigger and clear on selection', () => {
  const { form, element, error } = fixture();
  const trigger = element(), wrapper = element({ querySelector: () => trigger });
  const hidden = element({ name: 'duration_minutes', type: 'hidden', wrapper });
  form.elements.push(hidden);
  assert.equal(showFormError(form, '표시 기간을 확인해 주세요.', { field: 'duration_minutes' }), trigger);
  assert.equal(trigger.getAttribute('aria-describedby'), error.id);
  assert.equal(clearFormError(form, hidden), true);
  assert.equal(trigger.getAttribute('aria-invalid'), null);
});

test('picker validation keeps native date constraints but focuses and clears the visible trigger', () => {
  const { form, element, error } = fixture();
  const trigger = element({ type: 'button' }), wrapper = element({ querySelector: () => trigger });
  trigger.wrapper = wrapper;
  const input = element({ name: 'date', type: 'date', wrapper, noLayout: true, value: '', required: true,
    willValidate: true, validity: { valid: false, valueMissing: true } });
  input.setAttribute('data-picker-input', '');
  form.elements.push(input, trigger);
  assert.equal(validateForm(form), false);
  assert.equal(trigger.getAttribute('aria-invalid'), 'true'); assert.equal(input.focusOptions, undefined);
  assert.match(error.textContent, /날짜/);
  input.value = '2026-10-27'; input.validity = { valid: true };
  assert.equal(clearFormError(form, input), true); assert.equal(trigger.getAttribute('aria-invalid'), null);
  assert.equal(validateForm(form), true);
});

test('either parking location field can resolve a missing-location error', () => {
  const { form, error, controls: [floor] } = fixture([{ name: 'floor' }, { name: 'spot' }]);
  showFormError(form, '위치를 입력해 주세요.', { field: 'spot', relatedFields: ['floor'] });
  assert.equal(clearFormError(form, floor), true);
  assert.equal(error.textContent, '');
});
