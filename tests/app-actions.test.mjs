import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { commitStateChange } from '../src/state-change.mjs';
import { parkingAttempt } from '../src/ui-model.mjs';
import { calendarDates, calendarEventContext, dayDate, moveDate, eventsOn, eventKind, eventEnd, eventDaySpan, timelineHours, EVENT_KINDS } from '../src/calendar-model.mjs';
import { dateKey, esc } from '../src/experience.mjs';
import { normalizeCustomSchedule } from '../src/experience-library.mjs';
import { createSearchUpdates } from '../src/search-updates.mjs';
import { sheetLayout, sheetPresentation } from '../src/sheet-layout.mjs';

// Exercise the actual delegated handlers without starting a browser or server.
const source = readFileSync(new URL('../src/app-experience.js', import.meta.url), 'utf8');
function appFunction(name, context, endMarker) {
  const signature = source.indexOf(`function ${name}(`);
  assert.notEqual(signature, -1, `The app must define ${name}`);
  const start = source.slice(0, signature).endsWith('async ') ? signature - 6 : signature;
  const boundary = source.slice(signature + 1).search(/\n(?:async )?function /);
  const next = endMarker ? source.indexOf(endMarker, start) : boundary < 0 ? source.length : signature + 1 + boundary;
  return vm.runInNewContext(`(${source.slice(start, next).trim()})`, context);
}
function handler(type, context) {
  const start = source.indexOf(`document.addEventListener('${type}', async event => {`);
  const end = source.indexOf('\n});', start) + 4;
  let listener;
  vm.runInNewContext(source.slice(start, end), { ...context, document: { addEventListener: (_, callback) => { listener = callback; } } });
  return listener;
}

function detailPageFixture(openerKind = 'brief-card') {
  const node = () => ({ children: [], dataset: {}, attributes: {}, style: { setProperty() {} },
    isConnected: true, scrollTop: 0, focus() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
  });
  const dialog = node(), content = node(), title = node(), back = node(), actions = node(), headerActions = node();
  dialog.open = false;
  content.contains = control => control?.scope === 'sheet';
  content.querySelector = () => content.form || null;
  const opener = node(); opener.dataset = { action: 'detail', ref: 'parking' };
  opener.matches = selector => selector.includes(`.${openerKind}`);
  opener.closest = selector => selector === '.brief-card, .forecast-card' && ['brief-card', 'forecast-card'].includes(openerKind) ? opener : null;
  const nodes = { '#sheet': dialog, '#sheet-content': content, '#sheet-title': title, '#sheet-back': back,
    '#sheet-actions': actions, '#sheet-header-actions': headerActions, '#main': { contains: () => true } };
  const context = { ui: { sheetEpoch: 0, detail: null }, detailRequest: null, sheetCurrent: null, sheetTrail: [],
    sheetOrigin: null, sheetCardOrigin: null, returningSheet: false, restoringNavigation: false,
    presentationSource: opener, document: { activeElement: opener },
    $: selector => { assert.ok(nodes[selector], `Unknown detail host ${selector}`); return nodes[selector]; },
    sheetLayout, sheetPresentation, captureDraft() {}, syncNavigation() {}, moveToast() {},
    cardDetailHero: () => '<article class="card-detail-hero">원래 카드 요약</article>',
    cardDetailBody: markup => markup,
    captureControl: control => control, resolveControl: (_root, control) => control,
    formDrafts: { restore: () => false }, draftForm: () => null,
    presentations: { show() { dialog.open = true; }, settle() {}, deferUpdate: () => false,
      captureReplacement: () => ({}), replace() {} }, motion: { swapTitle() {} },
  };
  context.openSheet = appFunction('openSheet', context);
  return { context, dialog, content, title, back, headerActions, node };
}

test('dashboard entries retain their expanded card shell while feature entries retain page navigation', () => {
  for (const opener of ['brief-card', 'forecast-card', 'feature-tile']) {
    for (const ref of ['parking', 'news', 'stock', 'note:1', 'event:1', 'reminder:1', 'custom:1']) {
      const { context, dialog, content, title, back } = detailPageFixture(opener);
      const markup = '<div class="detail-title"><h2>제목과 현재 값</h2></div><p>원본 상세 정보</p>';
      context.openSheet('상세', markup, '', { ref });
      const card = opener !== 'feature-tile';
      assert.ok(content.innerHTML.includes(markup), `${opener}/${ref} retains its detail information`);
      assert.equal(dialog.dataset.sheetSurface, card ? 'card' : 'sheet');
      assert.equal(dialog.dataset.sheetPresentation, card ? 'card' : 'page');
      assert.equal(dialog.dataset.sheetSize, 'page');
      assert.equal(dialog.className.includes('has-card-hero'), card);
      assert.equal(content.innerHTML.includes('<article class="card-detail-hero">'), card);
      assert.equal(title.textContent, '상세');
      assert.equal(back.hidden, card);
      assert.equal(back.attributes['aria-label'], '이전 화면으로 돌아가기');
    }
  }
});

test('editing a dashboard detail uses its editor header then restores the expanded card and scroll', () => {
  const { context, dialog, content, headerActions, node } = detailPageFixture();
  const original = '<h2>주차 위치</h2><p>지하 3층 B16</p>';
  context.openSheet('주차 기록', original, '', { ref: 'parking' });
  context.ui.detail = 'parking'; content.scrollTop = 124;
  const edit = node(); edit.scope = 'sheet'; edit.dataset.action = 'edit-parking';
  edit.closest = selector => ['dialog', '#sheet'].includes(selector) ? dialog : null;
  context.presentationSource = edit;
  const submit = node(); submit.textContent = '위치 저장';
  content.form = { id: 'parking-form', querySelector: () => submit };
  context.openSheet('위치 편집', '<form id="parking-form"></form>');
  assert.equal(dialog.dataset.sheetPresentation, 'page');
  assert.equal(dialog.dataset.sheetSurface, 'sheet');
  assert.equal(headerActions.children[0], submit);
  assert.equal(submit.textContent, '저장');
  assert.equal(context.sheetTrail.length, 1);
  content.form = null;
  context.openDetail = ref => { assert.equal(ref, 'parking'); context.openSheet('주차 기록', original, '', { ref }); };
  appFunction('backSheet', context)();
  assert.equal(context.sheetTrail.length, 0);
  assert.ok(content.innerHTML.includes(original));
  assert.equal(content.scrollTop, 124);
  assert.equal(dialog.dataset.sheetPresentation, 'card');
  assert.match(dialog.className, /has-card-hero/);
});

for (const formId of ['parking-form', 'news-form']) test(`${formId} never navigates or announces success after a failed write`, async () => {
  let state = { parking: { spot: 'A1' }, news: { topic: '기존', time: '08:00' } };
  const previous = structuredClone(state), errors = [];
  const submit = handler('submit', {
    validateForm: () => true,
    FormData: class { *[Symbol.iterator]() { yield ['topic', '변경']; yield ['time', '09:00']; } },
    parkingAttempt, parkingValues: () => ({ floor: 'B2', spot: 'C3' }), current: () => 1,
    changeState: mutate => { const result = commitStateChange(state, mutate, () => { throw new Error('full'); }); state = result.state; errors.push(result.error.message); return result.ok; },
    render: () => assert.fail('Must keep the current form'), openDetail: () => assert.fail('Must not leave failed input'),
    toast: () => assert.fail('Must not show a success toast'),
    formDrafts: { commit: () => assert.fail('Must retain the draft') },
    showFormError: (_, message) => errors.push(message),
  });
  await submit({ preventDefault() {}, target: { id: formId, dataset: {} } });
  assert.deepEqual(state, previous);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /저장하지 못/);
});

test('record filtering keeps the same input and filter controls while updating results', async () => {
  const controls = ['all', 'note', 'document'].map(value => ({ dataset: { value }, classList: { toggle() {} }, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }));
  const input = { value: '회의', focus: true }, list = { innerHTML: '' }, count = { innerHTML: '' }, clear = {};
  const nodes = { '.library-sheet .filter-chips': { children: controls }, '.library-sheet .record-list': list, '.library-count': count, '.library-sheet .search-clear': clear, '#record-search': input };
  const ui = { recordFilter: 'all', recordSearch: '회의' };
  const context = { ui, $: selector => nodes[selector], resultMarkup: new WeakMap(), motion: { result() {} },
    syncNavigation() {}, matchingRecords: () => [{ id: 'doc' }], recordResults: () => 'filtered result' };
  context.updateSearchResults = appFunction('updateSearchResults', context);
  context.refreshRecords = appFunction('refreshRecords', context);
  const click = handler('click', context), selected = controls[2]; selected.dataset.action = 'record-filter';
  await click({ target: { closest: selector => selector === '[data-action]' ? selected : null } });
  assert.equal(nodes['#record-search'], input);
  assert.equal(nodes['.library-sheet .filter-chips'].children[2], selected);
  assert.equal(ui.recordFilter, 'document');
  assert.equal(selected.attributes['aria-pressed'], 'true');
  assert.equal(controls[0].attributes['aria-pressed'], 'false');
  assert.equal(input.value, '회의');
  assert.equal(list.innerHTML, 'filtered result');
});

for (const kind of ['filter']) test(`${kind} switches preserve the toolbar and content host through rapid selections`, () => {
  const values = kind === 'calendar' ? ['month', 'week', 'day'] : ['all', 'builtin', 'custom'];
  const ui = { [kind]: values[0], view: kind === 'calendar' ? 'schedule' : 'features' };
  const controls = values.map(value => ({ dataset: { value }, classList: { toggle() {} }, setAttribute(name, value) { this[name] = value; } }));
  const segments = { querySelectorAll: () => controls, style: { setProperty(name, value) { this[name] = value; } } };
  const content = { replaceChildren(...nodes) { this.nodes = nodes; } }, summary = { replaceChildren() {} }, transitions = [];
  const context = {
    ui, $: selector => selector === '#main [data-motion-segments]' ? segments : selector === '.schedule-summary' ? summary : content,
    document: { createElement: () => ({ content: { querySelector: () => ({ childNodes: [ui[kind]] }) } }) },
    schedule: () => '', features: () => '',
    motion: { switchContent(host, update, options) { assert.equal(host, content); transitions.push(options); update(); } },
  };
  const start = source.indexOf('function switchViewContent('), end = source.indexOf('function my()', start);
  const select = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  select(kind, values[1]); assert.equal(content.nodes[0], values[1], 'each selection updates the content immediately');
  select(kind, values[2]); assert.equal(content.nodes[0], values[2]);
  select(kind, values[0]); select(kind, values[0]); select(kind, 'unknown');
  assert.equal(transitions.length, 3, 'reselecting a tab never replays its transition');
  assert.ok(transitions.every(item => item.scene === ui.view));
  assert.equal(ui[kind], values[0]);
  assert.equal(content.nodes[0], values[0]);
  assert.equal(segments.querySelectorAll()[0], controls[0]);
  assert.equal(controls[0]['aria-pressed'], 'true');
  assert.equal(controls[2]['aria-pressed'], 'false');
});

class CalendarNode {
  constructor(className, children = []) {
    this.className = className; this.children = children; this.dataset = {}; this.attributes = {}; this.mutations = [];
    const values = new Map();
    this.style = { setProperty: (name, value) => values.set(name, String(value)), getPropertyValue: name => values.get(name) || '' };
    this.inert = false;
    for (const child of children) child.parentElement = this;
  }
  get inert() { return this._inert; }
  set inert(value) { this._inert = Boolean(value); if (this._inert) this.attributes.inert = ''; else delete this.attributes.inert; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'inert') this._inert = true; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'inert') this._inert = false; }
  toggleAttribute(name, force = !this.hasAttribute(name)) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); return force; }
  get childNodes() { return this.children; }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') && child.className.split(/\s+/).includes(selector.slice(1))) return child;
      if (selector.startsWith('#') && child.id === selector.slice(1)) return child;
      const nested = child.querySelector(selector); if (nested) return nested;
    }
    return null;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
    parent.mutations.push({ type: 'remove', node: this });
  }
  insertBefore(node, reference) {
    if (node.parentElement) {
      const previous = node.parentElement;
      previous.children.splice(previous.children.indexOf(node), 1);
    }
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    assert.notEqual(index, -1, 'insertBefore requires a current child');
    this.children.splice(index, 0, node); node.parentElement = this;
    this.mutations.push({ type: 'insert', node });
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const node of nodes) {
      if (node.parentElement) {
        const previous = node.parentElement;
        previous.children.splice(previous.children.indexOf(node), 1);
      }
      node.parentElement = this; this.children.push(node);
    }
    this.mutations.push({ type: 'replace', nodes });
  }
}
function calendarTree(mode, date = '2026-10-24') {
  const dates = calendarDates(date, 'month'), scopeDates = calendarDates(date, mode), week = new Set(calendarDates(date, 'week'));
  const cells = dates.map(key => {
    const cell = new CalendarNode(key === date ? 'selected' : '');
    cell.dataset.date = key;
    cell.attributes = { 'aria-pressed': String(key === date), tabindex: key === date ? '0' : '-1' };
    cell.inert = mode !== 'month' && !week.has(key);
    if (cell.inert) cell.setAttribute('aria-hidden', 'true');
    return cell;
  });
  const grid = new CalendarNode(`calendar-grid${mode === 'month' ? '' : ' week-strip'}`, cells);
  grid.dataset.period = `${scopeDates[0]}/${scopeDates.at(-1)}`;
  const viewport = new CalendarNode('calendar-grid-viewport', [grid]);
  viewport.dataset.calendarRows = String(mode === 'month' ? dates.length / 7 : 1);
  viewport.dataset.calendarFullRows = String(dates.length / 7);
  viewport.dataset.calendarOffset = String(Math.floor(dates.indexOf(date) / 7));
  // CSP-blocked template style attributes expose no usable CSS declarations.
  // Calendar reconciliation must read semantic attributes instead of CSSOM.
  viewport.style.getPropertyValue = () => '';
  viewport.style.setProperty = () => assert.fail('calendar geometry must work without inline style permissions');
  const header = new CalendarNode('month-header'), weekdays = new CalendarNode('weekdays'), legend = new CalendarNode('calendar-legend');
  const paper = new CalendarNode('calendar-surface', [header, weekdays, viewport, legend]);
  const agendaHeading = new CalendarNode('agenda-heading'), agendaBody = new CalendarNode('agenda-body');
  agendaHeading.label = mode; agendaBody.label = mode;
  const panel = new CalendarNode('agenda-panel', [agendaHeading, agendaBody]);
  const layout = new CalendarNode(`schedule-layout ${mode}`, [paper, panel]), quiet = new CalendarNode('brand-footer');
  const content = new CalendarNode('view-content', [layout, quiet]); content.id = 'schedule-view-content';
  const summaryValue = new CalendarNode('summary-value'); summaryValue.label = mode;
  const summary = new CalendarNode('schedule-summary', [summaryValue]);
  const template = new CalendarNode('template', [content, summary]);
  return { template, content, layout, viewport, grid, cells, paper, header, weekdays, legend, panel, quiet, summary };
}
function calendarPatch() {
  const start = source.indexOf('function patchCalendarContent('), end = source.indexOf('function switchViewContent(', start);
  return vm.runInNewContext(`(${source.slice(start, end).trim()})`);
}
function assertCalendarShell(actual, original) {
  for (const [selector, node] of [
    ['.schedule-layout', original.layout], ['.calendar-surface', original.paper], ['.month-header', original.header],
    ['.weekdays', original.weekdays], ['.calendar-grid-viewport', original.viewport], ['.calendar-grid', original.grid], ['.calendar-legend', original.legend],
    ['.agenda-panel', original.panel], ['.brand-footer', original.quiet],
  ]) assert.equal(actual.content.querySelector(selector), node, `${selector} must keep its live identity`);
  assert.equal(actual.content.mutations.length, 0, 'the content host must never replace the calendar surface');
}
function assertCalendarVisibility(live, mode, date = '2026-10-24') {
  const week = new Set(calendarDates(date, 'week'));
  assert.equal(live.viewport.dataset.calendarRows, String(mode === 'month' ? live.cells.length / 7 : 1));
  assert.equal(live.viewport.dataset.calendarFullRows, String(live.grid.children.length / 7));
  assert.equal(live.viewport.dataset.calendarOffset, String(Math.floor(live.cells.findIndex(cell => cell.dataset.date === date) / 7)));
  for (const cell of live.grid.children) {
    const hidden = mode !== 'month' && !week.has(cell.dataset.date);
    assert.equal(cell.inert, hidden, `${cell.dataset.date} must match the visible week`);
    assert.equal(cell.getAttribute('aria-hidden'), hidden ? 'true' : null);
  }
  const selected = live.grid.children.find(cell => cell.dataset.date === date);
  assert.equal(selected.inert, false);
  assert.equal(selected.getAttribute('aria-hidden'), null);
  assert.equal(selected.getAttribute('aria-pressed'), 'true');
  assert.equal(selected.getAttribute('tabindex'), '0');
}

test('week and day preserve every live date without touching grid children or stable calendar surfaces', () => {
  const patch = calendarPatch(), live = calendarTree('week'), cells = [...live.grid.children];
  const selected = cells.find(cell => cell.dataset.date === '2026-10-24'), attributes = selected.attributes;
  for (const mode of ['day', 'week', 'day']) {
    const next = calendarTree(mode); patch(live.content, next.content);
    assertCalendarShell(live, live);
    assert.equal(live.layout.className, `schedule-layout ${mode}`);
    assert.equal(live.grid.className, 'calendar-grid week-strip');
    assert.equal(live.grid.dataset.period, next.grid.dataset.period);
    live.grid.children.forEach((cell, index) => assert.equal(cell, cells[index]));
    assert.equal(live.grid.mutations.length, 0, 'identical week/day dates need no insert, removal or replacement');
    assert.equal(live.panel.childNodes[0].label, mode);
    assert.equal(selected.attributes, attributes);
    assert.equal(selected.attributes['aria-pressed'], 'true');
    assert.equal(selected.attributes.tabindex, '0');
    assertCalendarVisibility(live, mode);
  }
});

test('month, week and day keep the entire live month while viewport values and hidden-week accessibility change', () => {
  const patch = calendarPatch(), live = calendarTree('month'), cells = [...live.grid.children];
  for (const mode of ['week', 'day', 'month', 'day', 'week', 'month']) {
    const next = calendarTree(mode); patch(live.content, next.content);
    assertCalendarShell(live, live);
    assert.equal(live.layout.className, `schedule-layout ${mode}`);
    assert.equal(live.grid.dataset.period, next.grid.dataset.period);
    assert.equal(live.grid.className, next.grid.className);
    assert.equal(live.grid.children.length, cells.length);
    live.grid.children.forEach((cell, index) => assert.equal(cell, cells[index]));
    assert.equal(live.grid.mutations.length, 0, 'mode changes must never insert, remove, move or replace date buttons');
    assertCalendarVisibility(live, mode);
    assert.equal(live.panel.childNodes[0].label, mode);
  }
});

test('the live viewport preserves dates through reversals in four-, five- and six-row months', () => {
  const patch = calendarPatch();
  for (const [date, rows] of [['2026-02-14', 4], ['2026-10-24', 5], ['2026-08-15', 6]]) {
    const live = calendarTree('month', date), cells = [...live.grid.children];
    assert.equal(cells.length, rows * 7);
    for (const mode of ['week', 'month', 'day', 'month']) {
      patch(live.content, calendarTree(mode, date).content);
      assertCalendarVisibility(live, mode, date);
      live.grid.children.forEach((cell, index) => assert.equal(cell, cells[index]));
      assert.equal(live.grid.mutations.length, 0);
    }
  }
});

test('a changed month reconciles dates and copies incoming hidden-week state before template nodes move', () => {
  const patch = calendarPatch(), live = calendarTree('month', '2026-09-20'), next = calendarTree('week', '2026-10-24');
  const retained = new Map(live.grid.children.map(cell => [cell.dataset.date, cell]));
  const expected = next.grid.children.map(cell => ({
    date: cell.dataset.date, inert: cell.inert, hidden: cell.getAttribute('aria-hidden'), node: cell,
  }));
  const period = next.grid.dataset.period;
  patch(live.content, next.content);
  assertCalendarShell(live, live);
  assert.equal(live.grid.dataset.period, period);
  assert.deepEqual(live.grid.children.map(cell => cell.dataset.date), expected.map(cell => cell.date));
  for (const [index, cell] of live.grid.children.entries()) {
    const incoming = expected[index];
    assert.equal(cell, retained.get(incoming.date) || incoming.node);
    assert.equal(cell.inert, incoming.inert, `${incoming.date} must use its new month's visibility`);
    assert.equal(cell.getAttribute('aria-hidden'), incoming.hidden);
  }
  assertCalendarVisibility(live, 'week', '2026-10-24');
});

test('rapid calendar selections patch dates synchronously while preserving controls and updating the summary', () => {
  const ui = { calendar: 'month', view: 'schedule' }, live = calendarTree('month'), transitions = [];
  const values = ['month', 'week', 'day'];
  const controls = values.map(value => ({ dataset: { value }, classList: { toggle() {} }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }));
  const segments = { querySelectorAll: () => controls };
  const selectedCell = live.grid.children.find(cell => cell.dataset.date === '2026-10-24'), cells = [...live.grid.children];
  const context = {
    ui, patchCalendarContent: calendarPatch(),
    $: selector => selector === '#main [data-motion-segments]' ? segments : selector === '.schedule-summary' ? live.summary : live.content,
    document: { createElement: () => ({ set innerHTML(mode) { this.content = calendarTree(mode).template; } }) },
    schedule: () => ui.calendar,
    motion: { switchContent(host, update, options) { assert.equal(host, live.content); transitions.push(options); update(); } },
  };
  const start = source.indexOf('function switchViewContent('), end = source.indexOf('function my()', start);
  const select = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  for (const mode of ['week', 'month', 'day', 'week', 'month']) {
    select('calendar', mode);
    assert.equal(ui.calendar, mode);
    assert.equal(live.layout.className, `schedule-layout ${mode}`);
    assert.equal(live.summary.childNodes[0].label, mode);
    assert.equal(controls.find(control => control.dataset.value === mode).attributes['aria-pressed'], 'true');
    assert.equal(live.grid.children.find(cell => cell.dataset.date === '2026-10-24'), selectedCell);
    live.grid.children.forEach((cell, index) => assert.equal(cell, cells[index]));
    assertCalendarShell(live, live);
    assertCalendarVisibility(live, mode);
    assert.equal(live.grid.mutations.length, 0);
  }
  select('calendar', 'month'); select('calendar', 'unknown');
  assert.equal(transitions.length, 5);
  assert.ok(transitions.every(options => options.scene === 'schedule'));
  assert.equal(selectedCell.attributes['aria-pressed'], 'true');
  assert.equal(selectedCell.attributes.tabindex, '0');
  assert.equal(controls[0].attributes['aria-pressed'], 'true');
  assert.equal(controls[2].attributes['aria-pressed'], 'false');
});

test('root rendering paints the selected page synchronously without a separate exit phase', () => {
  const ui = { view: 'features' }, main = { dataset: { page: 'dashboard' }, scrollTop: 180 }, calls = [];
  const context = { ui, $: () => main, pageScroll: new Map([['features', 25]]),
    composingInputs: new Set(), pendingBackgroundRender: false,
    syncRootTabs() { calls.push('tabs'); }, renderPage({ scrollTop }) { calls.push(`page:${ui.view}:${scrollTop}`); } };
  const render = appFunction('render', context);
  render();
  assert.deepEqual(calls, ['tabs', 'page:features:25']);
});

test('rapid root routes retain the scroll position of each immediately displayed page', () => {
  const ui = { view: 'dashboard' }, pageScroll = new Map([['features', 25], ['my', 0]]);
  const main = { dataset: { page: 'dashboard' }, scrollTop: 180 }, location = { hash: '#features' }, renders = [];
  const context = { ui, pageScroll, location, $: () => main, navigation: { route() {} }, restoringNavigation: false,
    activeDialog: () => false, restoreNavigation() {}, render: options => { renders.push(options.scrollTop); main.scrollTop = options.scrollTop; main.dataset.page = ui.view; } };
  const start = source.indexOf('function route()'), end = source.indexOf('async function go(', start);
  const route = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  route(); location.hash = '#my'; route();
  assert.equal(pageScroll.get('dashboard'), 180);
  assert.equal(pageScroll.get('features'), 25);
  assert.deepEqual(renders, [25, 0]);
});

function backgroundFixture(view = 'schedule') {
  const ui = { view, windowMenu: false, search: '' }, calls = [], input = { id: 'conversation-search', value: '', isConnected: true };
  const main = { dataset: { page: view }, scrollTop: 180, contains: element => element === input };
  const list = {}, clear = {}, frames = [], listeners = {};
  const context = {
    ui, composingInputs: new Set(), pendingBackgroundRender: false, resultMarkup: new WeakMap(), pageScroll: new Map([['features', 25]]),
    $: selector => selector === '#conversation-content' ? list : selector === '#main .search-clear' ? clear : main,
    document: {
      createElement: () => ({ content: {}, set innerHTML(value) { this.content.markup = value; } }),
      addEventListener: (type, callback) => { listeners[type] = callback; },
    },
    dashboard: () => 'dashboard', schedule: () => 'schedule', features: () => 'features', my: () => 'my',
    conversations: () => `results:${ui.search}`, conversationContent: () => `results:${ui.search}`,
    patchLiveView(host, template) { assert.equal(host, main); calls.push(`patch:${template.markup}`); },
    syncForecastRails() { calls.push('rails'); }, syncRootTabs() { calls.push('tabs'); },
    renderPage({ scrollTop }) { calls.push(`page:${ui.view}:${scrollTop}`); },
    motion: { render() { assert.fail('a background patch must not reset or replay motion'); } },
    positionWindowMenu() { calls.push('window'); }, requestAnimationFrame: callback => frames.push(callback),
    searchUpdates: { schedule() {}, cancel() {} },
  };
  context.render = appFunction('render', context);
  context.queueSearchUpdate = appFunction('queueSearchUpdate', context, "document.addEventListener('compositionstart'");
  return { context, ui, calls, main, input, list, frames, listeners };
}

test('a same-page background update patches live content without touching tabs, scroll or root motion', () => {
  const f = backgroundFixture();
  f.context.render({ background: true });
  assert.deepEqual(f.calls, ['patch:schedule', 'rails']);
  assert.equal(f.main.scrollTop, 180);
  assert.equal(f.main.dataset.page, 'schedule');
  assert.equal(f.context.pendingBackgroundRender, false);
  f.ui.view = 'features';
  f.context.render({ background: true });
  assert.deepEqual(f.calls.slice(2), ['tabs', 'page:features:25'], 'a different selected page still uses foreground navigation');
});

test('IME composition delays a background patch until the final input and flushes without replacing controls', () => {
  const f = backgroundFixture('conversations');
  f.input.value = '회'; f.context.composingInputs.add(f.input);
  f.context.render({ background: true });
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.pendingBackgroundRender, true);
  const start = source.indexOf("document.addEventListener('compositionstart'");
  const end = source.indexOf("document.addEventListener('input', event => {", start);
  vm.runInNewContext(source.slice(start, end), f.context);
  f.listeners.compositionend({ target: f.input });
  assert.deepEqual(f.calls, [], 'compositionend waits for the IME final input event');
  f.input.value = '회의'; f.context.queueSearchUpdate(f.input);
  f.frames.shift()();
  assert.deepEqual(f.calls, ['patch:results:회의', 'rails']);
  assert.equal(f.context.resultMarkup.get(f.list), 'results:회의');
  assert.equal(f.context.pendingBackgroundRender, false);
  assert.equal(f.main.scrollTop, 180);
});

test('unchanged search markup preserves result nodes and avoids replaying their entrance', () => {
  let markup = '', writes = 0, animations = 0;
  const list = { get innerHTML() { return markup; }, set innerHTML(value) { ++writes; markup = value; } };
  const context = { resultMarkup: new WeakMap(), motion: { result(target) { assert.equal(target, list); ++animations; } } };
  const update = appFunction('updateSearchResults', context);
  update(list, '<p>회의</p>', true);
  update(list, '<p>회의</p>', true);
  assert.equal(writes, 1); assert.equal(animations, 1);
  update(list, '<p>다른 기록</p>');
  assert.equal(writes, 2); assert.equal(animations, 1);
  assert.equal(markup, '<p>다른 기록</p>');
});

test('the actual search queue defers IME text, delivers only the latest query and clears immediately', () => {
  const timers = new Map(), pending = new Set(); let nextTimer = 0, writes = 0, animations = 0;
  const searchUpdates = createSearchUpdates({ setTimer(callback, delay) {
    assert.equal(delay, 120); const id = ++nextTimer; timers.set(id, callback); pending.add(id); return id;
  }, clearTimer: id => pending.delete(id) });
  let markup = 'initial';
  const list = { get innerHTML() { return markup; }, set innerHTML(value) { ++writes; markup = value; } }, clear = {};
  const ui = { search: '' }, input = { id: 'conversation-search', value: 'ㅎ', isConnected: true };
  const context = { ui, searchUpdates, resultMarkup: new WeakMap(),
    $: selector => selector === '#conversation-content' ? list : clear,
    conversationContent: () => `results:${ui.search.trim()}`, motion: { result() { ++animations; } } };
  context.updateSearchResults = appFunction('updateSearchResults', context);
  const queue = appFunction('queueSearchUpdate', context, "document.addEventListener('compositionstart'");
  queue(input, true);
  assert.equal(timers.size, 0); assert.equal(writes, 0);
  input.value = '회의'; queue(input);
  input.value = '회의실'; queue(input);
  assert.equal(pending.size, 1); assert.equal(writes, 0);
  timers.get(1)(); assert.equal(writes, 0, 'a superseded timer cannot publish an earlier query');
  timers.get(2)();
  assert.equal(markup, 'results:회의실'); assert.equal(writes, 1); assert.equal(animations, 1);
  input.value = ''; queue(input);
  assert.equal(markup, 'results:'); assert.equal(ui.search, ''); assert.equal(clear.hidden, true);
  assert.equal(writes, 2); assert.equal(animations, 2);
  input.isConnected = false; input.value = '제거된 입력'; queue(input);
  assert.equal(ui.search, '', 'detached inputs cannot overwrite the live search state');
});

test('custom scheduling synchronizes visible choices, required state, help and drafts before saving', () => {
  const label = {}, help = { textContent: '' }, choice = {}, captured = [], selected = [], listeners = {};
  const time = { name: 'time', value: '', required: false, closest: () => ({ querySelector: () => label }) };
  const repeat = { name: 'repeat', value: '필요할 때', closest: () => choice };
  choice.querySelector = () => repeat;
  const form = { id: 'custom-form', elements: { time, repeat }, querySelector: () => help, querySelectorAll: () => [choice] };
  time.form = form; repeat.form = form;
  const context = { clockLabel: value => value,
    setChoice(target, value) { assert.equal(target, choice); selected.push(value); repeat.value = value; },
    clearFormError() {}, updateCustomPreview() {}, draftForm: () => form,
    captureDraft(target) { assert.equal(target, form); captured.push([time.value, repeat.value, time.required]); },
    document: { addEventListener: (type, callback) => { listeners[type] = callback; } },
  };
  context.syncCustomSchedule = appFunction('syncCustomSchedule', context);
  const start = source.indexOf("for (const type of ['input', 'change']) document.addEventListener");
  const end = source.indexOf("window.addEventListener('pagehide'", start);
  vm.runInNewContext(source.slice(start, end), context);
  time.value = '19:00'; listeners.input({ target: time });
  assert.equal(repeat.value, '매일'); assert.equal(time.required, true);
  assert.equal(label.textContent, '실행 시간'); assert.match(help.textContent, /매일 19:00/);
  assert.deepEqual(captured.at(-1), ['19:00', '매일', true]);
  repeat.value = '필요할 때'; listeners.change({ target: repeat });
  assert.equal(time.value, ''); assert.equal(time.required, false);
  assert.equal(label.textContent, '실행 시간 · 선택'); assert.equal(help.textContent, '필요할 때 직접 실행해요.');
  assert.deepEqual(captured.at(-1), ['', '필요할 때', false]);
  time.value = '20:30'; repeat.value = '평일';
  appFunction('syncDraftForm', context, '\nconst field')();
  assert.equal(time.required, true); assert.match(help.textContent, /평일 20:30/);
  assert.deepEqual(selected, ['매일', '평일']);
  assert.equal(time.value, '20:30'); assert.equal(repeat.value, '평일');
});

for (const [time, repeat, field] of [['19:00', '필요할 때', 'repeat'], ['', '매일', 'time']]) {
  test(`custom submission rejects inconsistent scheduling (${time || 'no time'}, ${repeat}) without silently changing it`, async () => {
    const values = { time, repeat }, form = { id: 'custom-form', dataset: {}, values }, errors = [];
    const submit = handler('submit', {
      validateForm: () => true, normalizeCustomSchedule,
      FormData: class { constructor(target) { this.values = target.values; } *[Symbol.iterator]() { yield* Object.entries(this.values); } },
      showFormError(target, message, options) { assert.equal(target, form); errors.push({ message, field: options.field }); },
      save() { assert.fail('inconsistent scheduling must never be written'); },
      render() { assert.fail('invalid scheduling must stay in the form'); },
      formDrafts: { commit() { assert.fail('invalid input must retain its draft'); } },
      openDetail() { assert.fail('invalid scheduling must never navigate'); },
    });
    await submit({ preventDefault() {}, target: form });
    assert.equal(errors.length, 1); assert.equal(errors[0].field, field);
    assert.deepEqual(values, { time, repeat });
  });
}

function scheduleHTML(events, now, calendar = 'month') {
  const ui = { date: dateKey(now), calendar };
  const context = { ui, data: { events }, current: () => now,
    dateKey, esc, calendarDates, calendarEventContext, dayDate, eventsOn, eventKind, eventEnd, eventDaySpan, timelineHours, EVENT_KINDS,
    icon: name => `<i>${name}</i>`, mark: name => `<span>${name}</span>`, arrow: '',
    button: (action, content, cls = '', attrs = '') => `<button class="${cls}" data-action="${action}" ${attrs}>${content}</button>`,
    shortDate: date => dateKey(date), dateLabel: date => dateKey(date),
  };
  context.heading = appFunction('heading', context);
  context.scheduleEvent = appFunction('scheduleEvent', context);
  return appFunction('schedule', context)();
}
function scheduleSummary(events, now) {
  const html = scheduleHTML(events, now);
  return html.slice(html.indexOf('<div class="schedule-summary"'), html.indexOf('<div class="segmented calendar-modes"'));
}

test('calendar geometry is rendered without inline styles so strict CSP can apply the folding rules', () => {
  const now = new Date(2026, 9, 24, 10, 30).getTime();
  for (const mode of ['month', 'week', 'day']) {
    const html = scheduleHTML([], now, mode);
    const attributes = html.match(/<div class="calendar-grid-viewport"([^>]*)>/)[1];
    assert.doesNotMatch(attributes, /\bstyle=/);
    assert.match(attributes, new RegExp(`data-calendar-rows="${mode === 'month' ? 5 : 1}"`));
    assert.match(attributes, /data-calendar-full-rows="5"/);
    assert.match(attributes, /data-calendar-offset="3"/);
  }
});

test('date selection patches the live schedule and avoids replaying an unchanged day or visible week', () => {
  const ui = { view: 'schedule', calendar: 'week', date: '2026-10-24' }, patches = [], transitions = [], focus = [];
  const select = appFunction('selectScheduleDate', {
    ui, dayDate, calendarDates, $: () => ({}),
    render: options => patches.push(options),
    motion: { updateSchedule(update, options) { transitions.push(options); update(); } },
    document: { querySelector: selector => ({ focus: options => focus.push({ selector, ...options }) }) },
  });
  select('2026-10-24'); assert.equal(patches.length, 0);
  select('2026-10-23'); assert.equal(transitions.at(-1).animateAgenda, false);
  select('2026-10-25'); assert.equal(transitions.at(-1).animateAgenda, true);
  ui.calendar = 'month'; select('2026-10-26');
  assert.equal(transitions.at(-1).animateAgenda, true);
  ui.calendar = 'day'; select('2026-10-27', '[data-action=calendar-today]');
  assert.equal(ui.date, '2026-10-27');
  assert.equal(dateKey(ui.month), ui.date);
  assert.ok(patches.every(options => options.background === true), 'selection must never replace the full page');
  assert.ok(focus.every(options => options.preventScroll));
  assert.equal(focus.at(-1).selector, '[data-action=calendar-today]');
});

test('month picker closes before selecting the clamped date through the same live-update path', async () => {
  const calls = [], ui = { date: '2026-10-31', calendar: 'month', jumpYear: 2027 };
  const click = handler('click', {
    ui, dayDate, moveDate,
    closeSheet: async () => { await Promise.resolve(); calls.push('closed'); },
    selectScheduleDate: (date, selector) => calls.push({ date, selector }),
    render: () => assert.fail('month choices must use the live date-selection path'),
  });
  const control = { dataset: { action: 'jump-month', month: '1' } };
  await click({ target: { closest: selector => selector === '[data-action]' ? control : null } });
  assert.deepEqual(calls, ['closed', { date: '2027-02-28', selector: '[data-action=calendar-jump]' }]);
});

test('a form picker adds one Back level above its form and closing it restores the parent depth', () => {
  const seen = [], snapshot = { sheet: { trail: [] }, chat: null, picker: null };
  const sync = appFunction('syncNavigation', {
    restoringNavigation: false, navigationSnapshot: () => snapshot,
    navigation: { sync: (depth, value) => seen.push({ depth, value }) },
  });
  sync(); snapshot.picker = { formId: 'event-form', name: 'time', value: '23:59' }; sync();
  snapshot.picker = null; sync();
  assert.deepEqual(seen.map(item => item.depth), [1, 2, 1]);
});

test('Back dismisses the field picker before restoring its parent form, while Forward restores the picker afterward', async () => {
  const calls = [], sheet = { open: true, dataset: {} }, content = { scrollTop: 0 }, title = { focus() {} };
  const context = { restoringNavigation: false, presentationSource: null, returningSheet: false,
    captureDraft: () => calls.push('draft'),
    formPickers: { close: async options => { assert.equal(options.notify, false); calls.push('picker-close'); }, restore: async value => calls.push(`picker-restore:${value.name}`) },
    $: selector => selector === '#sheet' ? sheet : selector === '#sheet-content' ? content : selector === '#sheet-title' ? title : { open: false },
    activeDialog: () => false, data: { notes: [], events: [], customs: [], documents: [], reminders: [] },
    eventForm: () => calls.push('event-form'), resolveControl: () => null,
    closeSheet: () => assert.fail('Back from a field picker must retain its parent form'),
  };
  const restore = appFunction('restoreNavigation', context);
  const snapshot = { sheet: { current: {}, trail: [], presentation: 'page', scroll: 120, form: { id: 'event-form', date: '2026-10-27', time: '14:00' } } };
  await restore(snapshot);
  assert.deepEqual(calls, ['draft', 'picker-close', 'event-form']);
  assert.equal(content.scrollTop, 120);
  calls.length = 0;
  await restore({ ...snapshot, picker: { name: 'time' } });
  assert.deepEqual(calls, ['draft', 'picker-close', 'event-form', 'picker-restore:time']);
});

test('the rendered schedule distinguishes an ongoing appointment, its next start and an empty remainder', () => {
  const now = new Date(2026, 9, 24, 10, 30).getTime(), today = dateKey(now);
  const current = { id: 'current', date: today, time: '10:00', duration: 90, title: '진행 회의', place: '회의실' };
  const next = { id: 'next', date: today, time: '12:00', duration: 60, title: '다음 약속', place: '카페' };
  const ongoing = scheduleSummary([current, next], now);
  assert.match(ongoing, /지금 진행 중 <b>진행 회의<\/b>/);
  assert.match(ongoing, /11:30까지/); assert.doesNotMatch(ongoing, /다음은|오늘 남은 일정이 없어요/);
  const upcoming = scheduleSummary([next], now);
  assert.match(upcoming, /다음은 <b>다음 약속<\/b>/); assert.match(upcoming, /오늘 12:00/);
  const finished = scheduleSummary([current], new Date(2026, 9, 24, 13, 0).getTime());
  assert.match(finished, /오늘 남은 일정이 없어요/); assert.doesNotMatch(finished, /지금 진행 중|다음은/);
});

test('the rendered overnight appointment shows its real next-day end and remains ongoing after midnight', () => {
  const event = { id: 'overnight', date: '2026-10-24', time: '23:30', duration: 90, title: '야간 작업', place: '작업실' };
  const tonight = scheduleSummary([event], new Date(2026, 9, 24, 23, 45).getTime());
  assert.match(tonight, /지금 진행 중 <b>야간 작업<\/b>/);
  assert.match(tonight, /다음 날 01:00까지/); assert.doesNotMatch(tonight, /24:00까지/);
  const tomorrow = scheduleSummary([event], new Date(2026, 9, 25, 0, 30).getTime());
  assert.match(tomorrow, /지금 진행 중 <b>야간 작업<\/b>/); assert.match(tomorrow, /01:00까지/);
  assert.doesNotMatch(tomorrow, /오늘 남은 일정이 없어요/);
});

test('the actual resize handler uses the isolated motion resize API without rerendering the page', () => {
  const calls = []; let resize;
  const start = source.indexOf("window.addEventListener('resize', () => {");
  const end = source.indexOf('\n});', start) + 4;
  vm.runInNewContext(source.slice(start, end), {
    window: { addEventListener(type, callback) { assert.equal(type, 'resize'); resize = callback; } },
    ui: { windowMenu: false }, $: () => ({ open: false }),
    motion: { resize() { calls.push('resize'); }, render() { assert.fail('resize must preserve existing scene effects'); } },
  });
  resize();
  assert.deepEqual(calls, ['resize']);
});

test('forecast rail edge fades and paging buttons follow clipped content through scrolling and resizing', () => {
  const nav = {}, controls = [-1, 1].map(direction => ({ dataset: { direction } }));
  const shelf = { querySelector: () => nav, querySelectorAll: () => controls };
  const rail = { scrollWidth: 800, clientWidth: 350, scrollLeft: 0, dataset: {}, closest: () => shelf };
  const sync = appFunction('syncForecastRail', {});
  for (const [position, start, end] of [[0, false, true], [140, true, true], [450, true, false], [451, true, false], [-15, false, true], [449.5, true, false], [0, false, true]]) {
    rail.scrollLeft = position; sync(rail);
    assert.equal(rail.dataset.fadeStart, String(start));
    assert.equal(rail.dataset.fadeEnd, String(end));
    assert.equal(controls[0].disabled, !start);
    assert.equal(controls[1].disabled, !end);
    assert.equal(nav.hidden, false);
  }
  // A wider viewport (or fewer cards) no longer needs either fade.
  rail.clientWidth = 900; sync(rail);
  assert.equal(rail.dataset.fadeStart, 'false');
  assert.equal(rail.dataset.fadeEnd, 'false');
  assert.equal(nav.hidden, true);
  assert.ok(controls.every(control => control.disabled));
  rail.clientWidth = 350; rail.scrollWidth = 351.5; sync(rail);
  assert.equal(nav.hidden, true, 'subpixel overflow must not leave a fading strip');
  assert.equal(rail.dataset.fadeEnd, 'false');
});
