import { esc, dateKey } from './experience.mjs';
import { calendarDates, dayDate, moveDate } from './calendar-model.mjs';

export function validPickerValue(type, value, options = []) {
  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = dayDate(value);
    return Number.isFinite(date.getTime()) && dateKey(date) === value;
  }
  if (type === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  return type === 'duration' && options.some(option => String(option.value) === String(value));
}

export function pickerValueLabel(type, value, options = []) {
  if (!validPickerValue(type, String(value), options)) return '선택해 주세요';
  if (type === 'date') return dayDate(value).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  if (type === 'time') {
    const [hour, minute] = value.split(':').map(Number);
    return `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${String(minute).padStart(2, '0')}`;
  }
  return options.find(option => String(option.value) === String(value)).label;
}

export function pickerField(label, name, value, type, { required = false, options = [], describedBy = '', clearable = false } = {}) {
  const nativeType = type === 'duration' ? 'hidden' : type;
  const description = [required ? `picker-required-${name}` : '', describedBy].filter(Boolean).join(' ');
  return `<div class="field picker-field" data-form-picker="${type}" data-picker-options="${esc(JSON.stringify(options))}" ${clearable ? 'data-picker-clearable="true"' : ''}>
    <span id="picker-label-${name}">${esc(label)}</span>
    <input class="picker-native" data-picker-input type="${nativeType}" name="${name}" value="${esc(value)}" tabindex="-1" aria-hidden="true" ${required ? 'required' : ''}>
    <span class="sr-only" id="picker-required-${name}" data-picker-required>${required ? '필수 항목' : ''}</span>
    <button type="button" id="picker-trigger-${name}" class="picker-trigger" data-picker-trigger aria-haspopup="dialog" aria-expanded="false" aria-controls="form-picker" aria-labelledby="picker-label-${name} picker-value-${name}" ${description ? `aria-describedby="${esc(description)}"` : ''}>
      <span id="picker-value-${name}" data-picker-display>${esc(pickerValueLabel(type, String(value), options))}</span><svg class="icon" aria-hidden="true"><use href="#i-${type === 'date' ? 'calendar' : 'clock'}"/></svg>
    </button></div>`;
}

export function syncPickerFields(root) {
  root?.querySelectorAll('[data-form-picker]').forEach(field => {
    const input = field.querySelector('[data-picker-input]');
    const display = field.querySelector('[data-picker-display]');
    display.textContent = pickerValueLabel(field.dataset.formPicker, input.value, JSON.parse(field.dataset.pickerOptions || '[]'));
    field.dataset.pickerEmpty = String(!input.value);
    const trigger = field.querySelector('[data-picker-trigger]');
    const required = field.querySelector('[data-picker-required]');
    required.textContent = input.required ? '필수 항목' : '';
    const descriptions = new Set((trigger.getAttribute?.('aria-describedby') || '').split(/\s+/).filter(Boolean));
    if (input.required) descriptions.add(required.id); else descriptions.delete(required.id);
    if (descriptions.size) trigger.setAttribute('aria-describedby', [...descriptions].join(' '));
    else trigger.removeAttribute?.('aria-describedby');
  });
}

// A picker owns a draft, not a second form. Only Done writes to the original
// input, preserving native constraints, FormData, drafts and change listeners.
export function createFormPickers(root = document, { now = () => Date.now(), show, dismiss, onChange = () => {}, onCreate = () => {} } = {}) {
  const doc = root.ownerDocument || root;
  let dialog, active = null, closing = null, wheelObserver = null;
  const wheelHeights = new WeakMap();
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const button = (action, label, attrs = '') => `<button type="button" data-picker-action="${action}" ${attrs}>${label}</button>`;
  const optionsOf = field => JSON.parse(field.dataset.pickerOptions || '[]');
  const snapshot = () => active && dialog?.open && !closing ? {
    formId: active.input.form.id, name: active.input.name, value: active.value, month: active.month, view: active.view,
  } : null;

  function summary() {
    if (active) dialog.querySelector('[data-picker-summary]').textContent = pickerValueLabel(active.type, active.value, active.options);
  }
  function wheel(name, label, values, selected) {
    const selectedIndex = Math.max(0, values.findIndex(option => String(option.value) === String(selected)));
    return `<div class="picker-wheel" role="listbox" tabindex="0" aria-label="${esc(label)}" aria-activedescendant="picker-${name}-${selectedIndex}" data-picker-wheel="${name}">${values.map((option, index) =>
      `<button type="button" id="picker-${name}-${index}" role="option" tabindex="-1" data-picker-index="${index}" data-picker-value="${esc(option.value)}" aria-selected="${String(option.value) === String(selected)}">${esc(option.label)}</button>`).join('')}</div>`;
  }
  function calendar() {
    const month = dayDate(active.month), monthMode = active.view === 'months';
    const header = `<div class="picker-calendar-header">${button('previous', icon('back'), `aria-label="${monthMode ? '이전 연도' : '이전 달'}"`)}${button('view', `${month.getFullYear()}년 ${monthMode ? '' : month.getMonth() + 1 + '월'} ${icon('chevron')}`, `aria-label="연도와 월 선택" aria-expanded="${monthMode}"`)}${button('next', icon('chevron'), `aria-label="${monthMode ? '다음 연도' : '다음 달'}"`)}</div>`;
    if (monthMode) return `${header}<div class="picker-month-grid">${Array.from({ length: 12 }, (_, index) => button('month', `${index + 1}월`, `data-month="${index}" aria-pressed="${index === month.getMonth()}"`)).join('')}</div>`;
    const today = dateKey(now());
    // Keep the sheet height stable when moving between four-, five- and six-week months.
    const first = calendarDates(active.month, 'month')[0];
    const dates = Array.from({ length: 42 }, (_, index) => moveDate(first, index));
    const tabDate = dates.includes(active.value) ? active.value : dateKey(new Date(month.getFullYear(), month.getMonth(), 1));
    return `${header}<div class="picker-weekdays" aria-hidden="true">${['일', '월', '화', '수', '목', '금', '토'].map(day => `<span>${day}</span>`).join('')}</div><div class="picker-date-grid" role="group" aria-label="날짜 선택">${dates.map(key => {
      const date = dayDate(key);
      return button('date', date.getDate(), `data-date="${key}" tabindex="${key === tabDate ? 0 : -1}" class="${date.getMonth() !== month.getMonth() ? 'outside' : ''}" aria-label="${esc(pickerValueLabel('date', key))}" aria-pressed="${key === active.value}" ${key === today ? 'aria-current="date"' : ''}`);
    }).join('')}</div><div class="picker-shortcuts">${button('today', '오늘')}${button('tomorrow', '내일')}</div>`;
  }
  function content() {
    if (active.type === 'date') return calendar();
    if (active.type === 'duration') return `<div class="picker-wheels">${wheel('duration', active.label, active.options, active.value)}</div>`;
    const [hour, minute] = active.value.split(':').map(Number);
    const hours = Array.from({ length: 24 }, (_, value) => ({ value, label: String(value).padStart(2, '0') }));
    const minutes = Array.from({ length: 60 }, (_, value) => ({ value, label: String(value).padStart(2, '0') }));
    return `<div class="picker-wheels picker-wheels--time">${wheel('hour', '시 · 24시간 기준', hours, hour)}${wheel('minute', '분', minutes, minute)}</div>`;
  }
  function wheelRowHeight(wheel) {
    return wheel.querySelector('[role=option]')?.getBoundingClientRect().height || 44;
  }
  function alignWheel(wheel) {
    const height = wheelRowHeight(wheel);
    wheelHeights.set(wheel, height);
    wheel.scrollTop = Number(wheel.querySelector('[aria-selected=true]')?.dataset.pickerIndex || 0) * height;
  }
  function positionWheels() {
    wheelObserver?.disconnect();
    if (typeof ResizeObserver === 'function') wheelObserver = new ResizeObserver(entries => {
      if (!active || !dialog.open) return;
      for (const entry of entries) alignWheel(entry.target.closest('[data-picker-wheel]'));
    });
    dialog.querySelectorAll('[data-picker-wheel]').forEach(wheel => {
      alignWheel(wheel);
      const firstOption = wheel.querySelector('[role=option]');
      if (firstOption) wheelObserver?.observe(firstOption);
      wheel.addEventListener('scroll', () => {
        const height = wheelRowHeight(wheel);
        // A text-size change must retain the draft selection, not interpret its
        // old pixel offset as a different time before the resize callback runs.
        if (height !== wheelHeights.get(wheel)) return alignWheel(wheel);
        selectWheel(wheel, Math.round(wheel.scrollTop / height));
      }, { passive: true });
    });
  }
  function paint() {
    wheelObserver?.disconnect();
    dialog.dataset.pickerType = active.type;
    dialog.innerHTML = `<header class="picker-header sheet-header">${button('cancel', '취소')}<h2 id="form-picker-title">${esc(active.label)}</h2>${button('done', '완료')}</header><div class="picker-content"><p class="picker-summary" data-picker-summary aria-live="polite" aria-atomic="true"></p>${content()}${active.clearable ? `<div class="picker-clear">${button('clear', '시간 지정 안 함')}</div>` : ''}</div>`;
    summary();
  }
  function selectWheel(wheel, index, move = false) {
    if (!active) return;
    const items = [...wheel.querySelectorAll('[role=option]')];
    const option = items[Math.max(0, Math.min(items.length - 1, index))];
    if (!option) return;
    items.forEach(item => item.setAttribute('aria-selected', String(item === option)));
    wheel.setAttribute('aria-activedescendant', option.id);
    const value = option.dataset.pickerValue;
    if (wheel.dataset.pickerWheel === 'duration') active.value = value;
    else {
      const parts = active.value.split(':'); parts[wheel.dataset.pickerWheel === 'hour' ? 0 : 1] = String(value).padStart(2, '0');
      active.value = parts.join(':');
    }
    if (move) {
      const height = wheelRowHeight(wheel);
      wheelHeights.set(wheel, height);
      wheel.scrollTo({ top: Number(option.dataset.pickerIndex) * height, behavior: 'instant' });
    }
    summary();
  }
  async function close({ commit = false, clear = false, notify = true, restoreFocus = true } = {}) {
    if (closing) return closing;
    if (!active) return;
    const state = active;
    if (clear && !state.clearable) return;
    if (commit && !clear && !validPickerValue(state.type, state.value, state.options)) return;
    active = null;
    wheelObserver?.disconnect();
    state.trigger.setAttribute('aria-expanded', 'false');
    if (commit && state.input.isConnected && state.input.form?.isConnected) {
      state.input.value = clear ? '' : state.value;
      syncPickerFields(state.input.form);
      state.input.dispatchEvent(new Event('input', { bubbles: true }));
      state.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closing = Promise.resolve(dismiss ? dismiss(dialog) : dialog.close());
    try { await closing; }
    finally {
      closing = null;
      if (restoreFocus && state.trigger.isConnected && state.field.closest('dialog')?.open) state.trigger.focus({ preventScroll: true });
      if (notify) onChange();
    }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = doc.createElement('dialog'); dialog.id = 'form-picker'; dialog.className = 'form-picker';
    dialog.dataset.sheetSurface = 'sheet'; dialog.setAttribute('aria-labelledby', 'form-picker-title');
    dialog.dataset.pickerPresentation = 'bottom';
    doc.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
    dialog.addEventListener('click', event => {
      const target = event.target.closest('[data-picker-action]'), option = event.target.closest('[data-picker-index]');
      if (!active) return;
      if (option) return selectWheel(option.closest('[data-picker-wheel]'), Number(option.dataset.pickerIndex), true);
      if (!target) {
        if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientY < r.top || event.clientY > r.bottom || event.clientX < r.left || event.clientX > r.right) close(); }
        return;
      }
      const action = target.dataset.pickerAction;
      if (action === 'cancel' || action === 'done') return close({ commit: action === 'done' });
      if (action === 'clear') return close({ commit: true, clear: true });
      if (action === 'view') active.view = active.view === 'months' ? 'dates' : 'months';
      if (action === 'previous' || action === 'next') active.month = moveDate(active.month, (action === 'next' ? 1 : -1) * (active.view === 'months' ? 12 : 1), 'month');
      if (action === 'month') { const date = dayDate(active.month); date.setDate(1); date.setMonth(Number(target.dataset.month)); active.month = dateKey(date); active.view = 'dates'; }
      if (action === 'date' || action === 'today' || action === 'tomorrow') {
        active.value = action === 'date' ? target.dataset.date : moveDate(dateKey(now()), action === 'tomorrow' ? 1 : 0);
        active.month = active.value;
      }
      paint();
      dialog.querySelector(action === 'date' || action === 'today' || action === 'tomorrow' ? '[aria-pressed=true]' : `[data-picker-action=${action === 'month' ? 'view' : action}]`)?.focus({ preventScroll: true });
    });
    dialog.addEventListener('keydown', event => {
      const date = event.target.closest('[data-picker-action=date]');
      if (date && active?.type === 'date' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        event.preventDefault();
        const key = date.dataset.date, weekday = dayDate(key).getDay();
        const days = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
        active.value = event.key.startsWith('Page') ? moveDate(key, (event.key === 'PageDown' ? 1 : -1) * (event.shiftKey ? 12 : 1), 'month') : moveDate(key, days[event.key]);
        active.month = active.value; paint(); dialog.querySelector(`[data-date="${active.value}"]`)?.focus({ preventScroll: true });
        return;
      }
      const wheel = event.target.closest('[data-picker-wheel]');
      if (!wheel || !active || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = Number(wheel.querySelector('[aria-selected=true]')?.dataset.pickerIndex || 0);
      selectWheel(wheel, event.key === 'Home' ? 0 : event.key === 'End' ? Infinity : index + (event.key === 'ArrowDown' ? 1 : -1), true);
    });
    onCreate(dialog);
  }
  async function open(field, saved = null, notify = true) {
    if (!field?.isConnected || closing) return;
    if (active) await close({ notify: false });
    ensureDialog();
    const input = field.querySelector('[data-picker-input]'), trigger = field.querySelector('[data-picker-trigger]');
    if (input.disabled || !input.form?.isConnected) return;
    const type = field.dataset.formPicker, options = optionsOf(field);
    const fallback = type === 'date' ? dateKey(now()) : type === 'time' ? '09:00' : String(options[0]?.value || '60');
    const value = validPickerValue(type, saved?.value || input.value, options) ? saved?.value || input.value : fallback;
    active = { field, input, trigger, owner: field.closest('dialog'), type, options, value,
      label: field.querySelector(':scope > span').textContent,
      clearable: type === 'time' && field.dataset.pickerClearable === 'true',
      month: saved?.month || value, view: saved?.view || 'dates' };
    trigger.setAttribute('aria-expanded', 'true');
    paint();
    if (show) show(dialog, trigger); else dialog.showModal();
    // Layout is available only after showModal; initialize the wheel centers now.
    positionWheels();
    (dialog.querySelector('[data-picker-wheel]') || dialog.querySelector('[aria-pressed=true]') || dialog.querySelector('[data-picker-action=date][tabindex="0"]') || dialog.querySelector('[data-picker-action=done]'))?.focus({ preventScroll: true });
    if (notify) onChange();
  }
  root.addEventListener('click', event => {
    const trigger = event.target.closest('[data-picker-trigger]');
    if (trigger) { event.preventDefault(); open(trigger.closest('[data-form-picker]')); }
  });
  const sync = event => { const field = event.target.closest('[data-form-picker]'); if (field) syncPickerFields(field.parentElement); };
  root.addEventListener('input', sync); root.addEventListener('change', sync);
  root.addEventListener('close', event => { if (active?.owner === event.target && !event.target.open) close({ restoreFocus: false }); }, true);
  return { open, close, snapshot, restore: saved => {
    const form = doc.getElementById(saved.formId), input = [...(form?.elements || [])].find(input => input.name === saved.name);
    return open(input?.closest('[data-form-picker]'), saved, false);
  } };
}
