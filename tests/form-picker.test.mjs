import test from 'node:test';
import assert from 'node:assert/strict';
import { pickerField, pickerValueLabel, validPickerValue, createFormPickers } from '../src/form-picker.mjs';

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
  const duration = pickerField('소요 시간', 'duration', 60, 'duration', { options: [{ value: 60, label: '<img onerror=bad>' }] });
  assert.match(duration, /type="hidden" name="duration"/);
  assert.doesNotMatch(duration, /<img/); assert.match(duration, /&lt;img/);
});

// Exercise the actual controller's transaction/history contract without relying
// on browser popup UI. Calendar/wheel geometry is a separate visual QA concern.
function fixture(type = 'date', originalValue = '2026-10-27', options = []) {
  const events = [], changes = [], focused = [], listeners = new Map();
  const trigger = { isConnected: true, setAttribute() {}, focus: options => focused.push(options) };
  const display = { textContent: '' }, summary = { textContent: '' }, owner = { open: true };
  const field = { isConnected: true, dataset: { formPicker: type, pickerOptions: JSON.stringify(options) },
    closest: () => owner,
    querySelector: selector => selector === '[data-picker-input]' ? input : selector === '[data-picker-trigger]' ? trigger : selector === '[data-picker-display]' ? display : { textContent: '날짜' },
  };
  const form = { id: 'event-form', isConnected: true, querySelectorAll: () => [field] };
  const input = { name: type === 'date' ? 'date' : type === 'time' ? 'time' : 'duration', value: originalValue, isConnected: true, form, closest: () => field, dispatchEvent: event => events.push(event.type) };
  form.elements = [input];
  const makeWheel = (name, values, selected) => {
    const callbacks = new Map(), wheel = { dataset: { pickerWheel: name }, scrollTop: 0, setAttribute() {}, focus() {} };
    const items = values.map((value, index) => ({ id: `picker-${name}-${index}`, selected: String(value) === String(selected), dataset: { pickerValue: String(value), pickerIndex: String(index) },
      setAttribute(_name, value) { this.selected = value === 'true'; } }));
    wheel.querySelectorAll = () => items; wheel.querySelector = () => items.find(item => item.selected);
    wheel.addEventListener = (name, fn) => callbacks.set(name, fn);
    wheel.scrollTo = ({ top }) => { wheel.scrollTop = top; callbacks.get('scroll')?.(); };
    return wheel;
  };
  const wheels = type === 'time' ? [makeWheel('hour', Array.from({ length: 24 }, (_, i) => i), Number(originalValue.split(':')[0])), makeWheel('minute', Array.from({ length: 60 }, (_, i) => i), Number(originalValue.split(':')[1]))]
    : type === 'duration' ? [makeWheel('duration', options.map(option => option.value), originalValue)] : [];
  const dialog = { open: false, dataset: {}, setAttribute() {}, innerHTML: '',
    addEventListener: (type, fn) => listeners.set(type, fn),
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector: selector => selector === '[data-picker-summary]' ? summary : selector === '[data-picker-wheel]' ? wheels[0] : selector === '[aria-pressed=true]' ? trigger : null,
    querySelectorAll: () => wheels,
  };
  const doc = { body: { append() {} }, createElement: () => dialog, addEventListener() {}, getElementById: () => form };
  const picker = createFormPickers(doc, { now: () => new Date(2026, 9, 27).getTime(), onChange: () => changes.push(picker.snapshot()) });
  const choose = date => listeners.get('click')({ target: { dataset: { pickerAction: 'date', date }, closest: selector => selector === '[data-picker-action]' ? { dataset: { pickerAction: 'date', date } } : null } });
  return { picker, input, dialog, events, changes, choose, field, display, focused, wheels };
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
