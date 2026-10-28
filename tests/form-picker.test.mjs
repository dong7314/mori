import test from 'node:test';
import assert from 'node:assert/strict';
import { pickerField, pickerValueLabel, validPickerValue, createFormPickers, syncPickerFields } from '../src/form-picker.mjs';

test('picker values preserve leap dates, midnight, minute precision and existing custom durations', () => {
  assert.equal(validPickerValue('date', '2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', 'not-a-date']) assert.equal(validPickerValue('date', value), false);
  for (const value of ['00:00', '12:01', '23:59']) assert.equal(validPickerValue('time', value), true);
  for (const value of ['24:00', '12:60', '9:30', '']) assert.equal(validPickerValue('time', value), false);
  const durations = [{ value: 117, label: '1시간 57분' }];
  assert.equal(validPickerValue('duration', '117', durations), true);
  assert.equal(validPickerValue('duration', '60', durations), false);
  assert.equal(pickerValueLabel('duration', '117', durations), '1시간 57분');
  assert.equal(pickerValueLabel('time', '00:00'), '오전 12:00');
  assert.equal(pickerValueLabel('time', '12:01'), '오후 12:01');
});

test('custom field controls retain original native types, required constraints and safe display labels', () => {
  const date = pickerField('날짜', 'date', '2026-10-27', 'date', { required: true });
  assert.match(date, /type="date" name="date" value="2026-10-27"[^>]*required/);
  assert.match(date, /aria-haspopup="dialog"/); assert.match(date, /aria-describedby="picker-required-date"/);
  assert.doesNotMatch(date, /data-choice/);
  assert.match(pickerField('시작 시간', 'time', '23:59', 'time'), /type="time"/);
  const optionalTime = pickerField('실행 시간 · 선택', 'time', '', 'time', { clearable: true, describedBy: 'custom-schedule-help' });
  assert.match(optionalTime, /data-picker-clearable="true"/);
  assert.match(optionalTime, /aria-describedby="custom-schedule-help"/);
  assert.match(optionalTime, /data-picker-display>선택해 주세요</);
  const scheduledTime = pickerField('실행 시간', 'time', '19:00', 'time', { required: true, clearable: true, describedBy: 'custom-schedule-help' });
  assert.match(scheduledTime, /aria-describedby="picker-required-time custom-schedule-help"/);
  const duration = pickerField('소요 시간', 'duration', 60, 'duration', { options: [{ value: 60, label: '<img onerror=bad>' }] });
  assert.match(duration, /type="hidden" name="duration"/);
  assert.doesNotMatch(duration, /<img/); assert.match(duration, /&lt;img/);
});

// Exercise the actual controller's transaction/history contract without relying
// on browser popup UI. Calendar/wheel geometry is a separate visual QA concern.
function fixture(type = 'date', originalValue = '2026-10-27', options = [], { required = false, clearable = false, describedBy = '', label = '날짜' } = {}) {
  const events = [], changes = [], focused = [], listeners = new Map(), attributes = new Map();
  if (describedBy) attributes.set('aria-describedby', describedBy);
  const trigger = { isConnected: true, setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name), focus: options => focused.push(options) };
  const name = type === 'date' ? 'date' : type === 'time' ? 'time' : 'duration';
  const display = { textContent: '' }, summary = { textContent: '' }, owner = { open: true };
  const requiredLabel = { id: `picker-required-${name}`, textContent: '' };
  const field = { isConnected: true, dataset: { formPicker: type, pickerOptions: JSON.stringify(options), pickerClearable: String(clearable) },
    closest: () => owner,
    querySelector: selector => ({ '[data-picker-input]': input, '[data-picker-trigger]': trigger,
      '[data-picker-display]': display, '[data-picker-required]': requiredLabel, ':scope > span': { textContent: label } })[selector] || null,
  };
  const form = { id: 'event-form', isConnected: true, querySelectorAll: () => [field] };
  const input = { name, value: originalValue, required, isConnected: true, form, closest: () => field, dispatchEvent: event => events.push(event.type) };
  form.elements = [input];
  // Materialize only the scrollable option interface from the controller's
  // rendered markup; business values and fallback selection come from production.
  const wheels = [];
  function readWheels(html) {
    wheels.length = 0;
    for (const [, attrs, body] of html.matchAll(/<div class="picker-wheel"([^>]*)>(.*?)<\/div>/gs)) {
      const callbacks = new Map(), name = attrs.match(/data-picker-wheel="([^"]+)"/)[1];
      const wheel = { dataset: { pickerWheel: name }, scrollTop: 0, setAttribute() {}, focus() {} };
      const items = [...body.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].map(([, attrs, text]) => ({
        id: attrs.match(/id="([^"]+)"/)[1], selected: attrs.includes('aria-selected="true"'), textContent: text,
        dataset: { pickerValue: attrs.match(/data-picker-value="([^"]+)"/)[1], pickerIndex: attrs.match(/data-picker-index="([^"]+)"/)[1] },
        setAttribute(_name, value) { this.selected = value === 'true'; },
      }));
      wheel.querySelectorAll = () => items; wheel.querySelector = () => items.find(item => item.selected);
      wheel.addEventListener = (name, fn) => callbacks.set(name, fn);
      wheel.scrollTo = ({ top }) => { wheel.scrollTop = top; callbacks.get('scroll')?.(); };
      wheels.push(wheel);
    }
  }
  let html = '';
  const dialog = { open: false, dataset: {}, setAttribute() {},
    get innerHTML() { return html; }, set innerHTML(value) { html = value; readWheels(value); },
    addEventListener: (type, fn) => listeners.set(type, fn),
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector: selector => selector === '[data-picker-summary]' ? summary : selector === '[data-picker-wheel]' ? wheels[0] : selector === '[aria-pressed=true]' ? trigger : null,
    querySelectorAll: () => wheels,
  };
  const doc = { body: { append() {} }, createElement: () => dialog, addEventListener() {}, getElementById: () => form };
  const picker = createFormPickers(doc, { now: () => new Date(2026, 9, 27).getTime(), onChange: () => changes.push(picker.snapshot()) });
  const action = (pickerAction, data = {}) => {
    const target = { dataset: { pickerAction, ...data } };
    target.closest = selector => selector === '[data-picker-action]' ? target : null;
    return listeners.get('click')({ target });
  };
  const choose = date => action('date', { date });
  return { picker, input, dialog, events, changes, choose, action, field, form, display, trigger, requiredLabel, focused, wheels };
}

test('calendar choices stay drafts until Done, while cancel preserves the form and emits no edits', async () => {
  const { picker, field, input, choose, events, changes, display, focused } = fixture();
  await picker.open(field); choose('2026-11-03');
  const saved = picker.snapshot();
  assert.equal(saved.value, '2026-11-03'); assert.equal(input.value, '2026-10-27');
  await picker.close();
  assert.equal(input.value, '2026-10-27'); assert.deepEqual(events, []);
  await picker.restore(saved); assert.equal(picker.snapshot().value, '2026-11-03');
  await picker.close({ commit: true });
  assert.equal(input.value, '2026-11-03'); assert.deepEqual(events, ['input', 'change']);
  assert.match(display.textContent, /11월 3일/);
  assert.equal(changes.at(-1), null); assert.ok(focused.every(value => value.preventScroll));
});

test('a disconnected form cannot receive a late picker confirmation', async () => {
  const { picker, field, input, choose, events } = fixture();
  await picker.open(field); choose('2026-11-03'); input.isConnected = false;
  await picker.close({ commit: true });
  assert.equal(input.value, '2026-10-27'); assert.deepEqual(events, []); assert.equal(picker.snapshot(), null);
});

test('time wheels center the existing hour/minute and retain one-minute precision across midnight', async () => {
  const { picker, field, input, wheels, display } = fixture('time', '23:17');
  await picker.open(field);
  assert.equal(wheels[0].scrollTop, 23 * 44); assert.equal(wheels[1].scrollTop, 17 * 44);
  wheels[0].scrollTo({ top: 0 }); wheels[1].scrollTo({ top: 59 * 44 });
  assert.equal(picker.snapshot().value, '00:59'); assert.equal(input.value, '23:17');
  await picker.close({ commit: true });
  assert.equal(input.value, '00:59'); assert.equal(display.textContent, '오전 12:59');
});

test('duration wheels preserve existing non-preset values and cancel without modifying the input', async () => {
  const { picker, field, input, wheels, events } = fixture('duration', '117', [{ value: 30, label: '30분' }, { value: 117, label: '1시간 57분' }]);
  await picker.open(field); assert.equal(wheels[0].scrollTop, 44);
  wheels[0].scrollTo({ top: 0 }); assert.equal(picker.snapshot().value, '30');
  await picker.close(); assert.equal(input.value, '117'); assert.deepEqual(events, []);
});


test('an optional empty time remains empty on cancel and only Done publishes its selected value', async () => {
  const { picker, field, input, action, events, wheels, display, dialog } = fixture('time', '', [], { clearable: true });
  await picker.open(field);
  assert.equal(input.value, '');
  assert.ok(validPickerValue('time', picker.snapshot().value));
  assert.equal(wheels[0].scrollTop, Number(picker.snapshot().value.slice(0, 2)) * 44);
  wheels[0].scrollTo({ top: 17 * 44 }); wheels[1].scrollTo({ top: 42 * 44 });
  await action('cancel');
  assert.equal(dialog.open, false); assert.equal(input.value, ''); assert.deepEqual(events, []);
  await picker.open(field);
  wheels[0].scrollTo({ top: 17 * 44 }); wheels[1].scrollTo({ top: 42 * 44 });
  assert.equal(input.value, '');
  await action('done');
  assert.equal(input.value, '17:42'); assert.equal(display.textContent, '오후 5:42');
  assert.deepEqual(events, ['input', 'change']); assert.equal(picker.snapshot(), null);
});

test('clearing a scheduled time requires explicit support even when the field is currently required', async () => {
  for (const required of [false, true]) {
    const { picker, field, action, input, events, dialog } = fixture('time', '19:30', [], { required });
    await picker.open(field); await action('clear');
    assert.equal(input.value, '19:30'); assert.deepEqual(events, []); assert.equal(dialog.open, true);
    await action('cancel');
  }
  const { picker, field, input, action, events, display, dialog } = fixture('time', '19:30', [], { required: true, clearable: true });
  await picker.open(field); await action('clear');
  assert.equal(input.value, ''); assert.equal(display.textContent, '선택해 주세요');
  assert.equal(dialog.open, false); assert.equal(picker.snapshot(), null);
  assert.deepEqual(events, ['input', 'change']);
  // Form listeners own the corresponding repeat-mode/required change.
  assert.equal(input.required, true);
});

test('required changes retain helper and error descriptions while keeping empty state accurate', () => {
  const { form, input, trigger, requiredLabel, field, display } = fixture('time', '', [], {
    describedBy: 'custom-schedule-help form-error-7',
  });
  const descriptions = () => new Set((trigger.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  syncPickerFields(form);
  assert.equal(display.textContent, '선택해 주세요'); assert.equal(field.dataset.pickerEmpty, 'true');
  input.required = true; syncPickerFields(form);
  assert.equal(requiredLabel.textContent, '필수 항목');
  assert.deepEqual(descriptions(), new Set(['custom-schedule-help', 'form-error-7', requiredLabel.id]));
  input.value = '08:30'; syncPickerFields(form);
  assert.equal(field.dataset.pickerEmpty, 'false'); assert.equal(display.textContent, '오전 8:30');
  input.required = false; syncPickerFields(form);
  assert.equal(requiredLabel.textContent, '');
  assert.deepEqual(descriptions(), new Set(['custom-schedule-help', 'form-error-7']));

  const plain = fixture('time', '09:00', [], { required: true });
  syncPickerFields(plain.form); plain.input.required = false; syncPickerFields(plain.form);
  assert.equal(plain.trigger.getAttribute('aria-describedby'), null);
});

test('parking duration announces its own field label and retains the full-day option', async () => {
  const { picker, field, dialog, wheels, action, input } = fixture('duration', '90', [
    { value: 90, label: '90분' }, { value: 1440, label: '24시간' },
  ], { label: '표시 기간' });
  await picker.open(field);
  assert.match(dialog.innerHTML, /role="listbox"[^>]*aria-label="표시 기간"/);
  assert.doesNotMatch(dialog.innerHTML, /aria-label="소요 시간"/);
  wheels[0].scrollTo({ top: 44 }); await action('done');
  assert.equal(input.value, '1440');
});
