import test from 'node:test';
import assert from 'node:assert/strict';
import { patchLiveView } from '../src/live-view.mjs';

const HTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

// A small DOM harness records real mutation operations and simulates the
// browser losing focus whenever a focused subtree is detached or moved.
class Node {
  constructor(doc, type, value = null) {
    this.ownerDocument = doc; this.nodeType = type; this._nodeValue = value;
    this.childNodes = []; this.parentNode = null; this.mutations = [];
  }
  get nodeValue() { return this._nodeValue; }
  set nodeValue(value) { this._nodeValue = value; this.mutations.push(['text', value]); }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  append(...nodes) { nodes.forEach(node => this.insertBefore(node, null)); }
  insertBefore(node, anchor) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = anchor ? this.childNodes.indexOf(anchor) : this.childNodes.length;
    assert.ok(index >= 0, 'insertion anchor is attached');
    this.childNodes.splice(index, 0, node); node.parentNode = this;
    this.mutations.push(['insert', node]); return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node); assert.ok(index >= 0);
    if (node.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    this.childNodes.splice(index, 1); node.parentNode = null;
    this.mutations.push(['remove', node]); return node;
  }
}
class Element extends Node {
  constructor(doc, tag, attrs = {}, namespace = HTML) {
    super(doc, 1); this.localName = tag; this.namespaceURI = namespace;
    this.attrs = new Map(); this.listeners = new Map(); this.scrollTop = 0; this.scrollLeft = 0;
    Object.entries(attrs).forEach(([name, value]) => this.setAttribute(name, String(value)));
    this.mutations.length = 0;
  }
  get attributes() { return [...this.attrs.values()]; }
  getAttribute(name) { return this.attributes.find(attribute => attribute.name === name)?.value ?? null; }
  getAttributeNS(namespace, name) { return this.attrs.get(`${namespace}:${name}`)?.value ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  setAttribute(name, value) { this.setAttributeNS(null, name, value); }
  setAttributeNS(namespace, name, value) {
    const localName = namespace ? name.split(':').at(-1) : name;
    this.attrs.set(`${namespace}:${localName}`, { name, localName, namespaceURI: namespace, value: String(value) });
    this.mutations.push(['attribute', name, String(value)]);
  }
  removeAttribute(name) {
    const attribute = this.attributes.find(item => item.name === name);
    if (attribute) this.removeAttributeNS(attribute.namespaceURI, attribute.localName);
  }
  removeAttributeNS(namespace, name) { this.attrs.delete(`${namespace}:${name}`); this.mutations.push(['removeAttribute', name]); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.localName === 'select') return this.childNodes.find(node => node.selected)?.value || this.childNodes[0]?.value || '';
    if (this.localName === 'textarea') return this.childNodes.map(node => node.nodeValue || '').join('');
    return this.getAttribute('value') || '';
  }
  set value(value) { this._value = value; this.selectionStart = this.selectionEnd = 0; this.mutations.push(['value', value]); }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(value) { this._checked = value; this.mutations.push(['checked', value]); }
  get selected() { return this._selected ?? this.hasAttribute('selected'); }
  set selected(value) { this._selected = value; this.mutations.push(['selected', value]); }
  get multiple() { return this.hasAttribute('multiple'); }
  get isContentEditable() { return this.getAttribute('contenteditable') === 'true'; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  dispatch(name) { this.listeners.get(name)?.(); }
  focus() { this.ownerDocument.activeElement = this; }
}
function fixture() {
  const doc = { activeElement: null };
  const text = value => new Node(doc, 3, value);
  const el = (tag, attrs = {}, ...children) => {
    const node = new Element(doc, tag, attrs);
    node.append(...children.map(child => typeof child === 'string' ? text(child) : child));
    node.mutations.length = 0; return node;
  };
  const fragment = (...children) => { const node = new Node(doc, 11); node.append(...children); return node; };
  const clear = node => { node.mutations.length = 0; node.childNodes.forEach(clear); };
  return { doc, text, el, fragment, clear };
}

test('a background search refresh keeps its live input, value, caret, listeners and scroll offsets', () => {
  const { doc, el, fragment, clear } = fixture();
  const input = el('input', { name: 'search', type: 'search', value: 'old' });
  const form = el('form', { class: 'record-search' }, input);
  const root = el('main', {}, form, el('div', { class: 'records' }, 'old results'));
  let calls = 0; input.addEventListener('input', () => calls++);
  root.scrollTop = 90; form.scrollLeft = 14; input.focus();
  input.value = '한글 입력 중'; input.selectionStart = 3; input.selectionEnd = 5;
  clear(root);
  patchLiveView(root, fragment(
    el('form', { class: 'record-search' }, el('input', { name: 'search', type: 'search', value: 'stale' })),
    el('div', { class: 'records' }, 'new results'),
  ));
  assert.equal(root.childNodes[0], form); assert.equal(form.childNodes[0], input);
  assert.equal(doc.activeElement, input); assert.equal(input.value, '한글 입력 중');
  assert.equal(input.getAttribute('value'), 'old');
  assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 5);
  assert.deepEqual(input.mutations, []); assert.equal(root.scrollTop, 90); assert.equal(form.scrollLeft, 14);
  input.dispatch('input'); assert.equal(calls, 1);
  assert.equal(root.childNodes[1].childNodes[0].nodeValue, 'new results');
});

test('unchanged calendar viewport and inline variables incur no mutation or animation replacement', () => {
  const { el, fragment, clear } = fixture();
  const attrs = { id: 'calendar-viewport', style: '--calendar-row: 2; --calendar-rows: 6' };
  const viewport = el('div', attrs, el('button', { 'data-date': '2026-10-24' }, '24'));
  const root = el('main', {}, viewport); const animation = {};
  viewport.runningAnimation = animation; viewport.scrollTop = 130;
  clear(root);
  patchLiveView(root, fragment(el('div', attrs, el('button', { 'data-date': '2026-10-24' }, '24'))));
  assert.equal(root.childNodes[0], viewport); assert.equal(viewport.runningAnimation, animation);
  assert.equal(viewport.scrollTop, 130);
  const mutations = node => node.mutations.length + node.childNodes.reduce((sum, child) => sum + mutations(child), 0);
  assert.equal(mutations(root), 0);
});

test('equivalent CSSOM calendar variables do not rewrite differently formatted inline styles', () => {
  const { el, fragment, clear } = fixture();
  const css = entries => ({
    length: entries.length,
    *[Symbol.iterator]() { yield* entries.map(([property]) => property); },
    getPropertyValue: property => entries.find(([name]) => name === property)?.[1] || '',
    getPropertyPriority: () => '',
  });
  const viewport = el('div', { class: 'calendar-grid-viewport', style: '--calendar-rows: 1; --calendar-offset: 3;' });
  viewport.style = css([['--calendar-rows', '1'], ['--calendar-offset', '3']]);
  const next = el('div', { class: 'calendar-grid-viewport', style: '--calendar-offset:3;--calendar-rows:1' });
  next.style = css([['--calendar-offset', '3'], ['--calendar-rows', '1']]);
  const root = el('main', {}, viewport); clear(root);
  patchLiveView(root, fragment(next));
  assert.equal(root.childNodes[0], viewport); assert.deepEqual(viewport.mutations, []);
});

test('inserting a labelled forecast group preserves the previous shelf, rail and scroll position', () => {
  const { el, fragment } = fixture();
  const shelf = group => el('section', { class: 'forecast-shelf', 'aria-labelledby': `shelf-heading-${group}` },
    el('h3', { id: `shelf-heading-${group}` }, group), el('div', { id: `forecast-${group}`, class: 'forecast-rail' }));
  const future = shelf('future'), rail = future.childNodes[1]; rail.scrollLeft = 140;
  const root = el('main', {}, future);
  patchLiveView(root, fragment(shelf('current'), shelf('future')));
  assert.equal(root.childNodes[1], future); assert.equal(future.childNodes[1], rail); assert.equal(rail.scrollLeft, 140);
});

test('keyed cards insert, remove and reorder with the focused branch attached and listener identity intact', () => {
  const { doc, el, fragment } = fixture();
  const card = (id, label) => el('button', { class: 'forecast-card', 'data-ref': `event:${id}`, 'data-occurrence': `${id}:today` }, label);
  const a = card('a', 'A'), b = card('b', 'B'), c = card('c', 'C');
  const root = el('main', {}, a, b, c); b.focus(); let clicks = 0; b.addEventListener('click', () => clicks++);
  patchLiveView(root, fragment(card('c', 'C updated'), card('b', 'B updated'), card('d', 'D')));
  assert.equal(root.childNodes[0], c); assert.equal(root.childNodes[1], b);
  assert.equal(root.childNodes[2].getAttribute('data-ref'), 'event:d');
  assert.equal(a.parentNode, null); assert.equal(doc.activeElement, b);
  assert.equal(b.childNodes[0].nodeValue, 'B updated'); b.dispatch('click'); assert.equal(clicks, 1);
});

test('reordering around an input also preserves focus inside a nested keyed branch', () => {
  const { doc, el, fragment } = fixture();
  const focused = el('input', { name: 'search' });
  const middle = el('section', { id: 'search-area' }, focused);
  const left = el('section', { id: 'left' }), right = el('section', { id: 'right' });
  const root = el('main', {}, left, middle, right); focused.focus();
  patchLiveView(root, fragment(el('section', { id: 'right' }), el('section', { id: 'search-area' }, el('input', { name: 'search' })), el('section', { id: 'left' })));
  assert.deepEqual(root.childNodes, [right, middle, left]); assert.equal(doc.activeElement, focused);
});

test('duplicate keys match distinct siblings in order instead of reusing the same live element', () => {
  const { el, fragment } = fixture();
  const row = label => el('button', { 'data-action': 'same', class: 'row' }, label);
  const first = row('one'), second = row('two'), root = el('main', {}, first, second);
  patchLiveView(root, fragment(row('first update'), row('second update'), row('three')));
  assert.equal(root.childNodes[0], first); assert.equal(root.childNodes[1], second);
  assert.notEqual(root.childNodes[2], second);
  assert.equal(first.childNodes[0].nodeValue, 'first update'); assert.equal(second.childNodes[0].nodeValue, 'second update');
});

test('SVG child identity and namespaced attributes synchronize without dropping the namespace', () => {
  const { doc, el, fragment } = fixture();
  const make = href => {
    const svg = new Element(doc, 'svg', { viewBox: '0 0 24 24' }, SVG);
    const use = new Element(doc, 'use', {}, SVG); use.setAttributeNS(XLINK, 'xlink:href', href); svg.append(use);
    return svg;
  };
  const svg = make('#old'), use = svg.childNodes[0], root = el('main', {}, svg);
  const next = make('#new'); next.setAttribute('aria-hidden', 'true');
  patchLiveView(root, fragment(next));
  assert.equal(root.childNodes[0], svg); assert.equal(svg.childNodes[0], use);
  assert.equal(use.getAttributeNS(XLINK, 'href'), '#new'); assert.equal(svg.getAttribute('aria-hidden'), 'true');
  const finalSvg = make('#discard'); finalSvg.childNodes[0].removeAttributeNS(XLINK, 'href');
  patchLiveView(root, fragment(finalSvg)); assert.equal(use.getAttributeNS(XLINK, 'href'), null);
});

test('existing calendar dates update visibility and selection attributes in place', () => {
  const { el, fragment } = fixture();
  const date = el('button', { 'data-action': 'select-date', 'data-date': '2026-10-24', inert: '', 'aria-hidden': 'true', tabindex: '-1' }, '24');
  const root = el('main', {}, date);
  patchLiveView(root, fragment(el('button', { 'data-action': 'select-date', 'data-date': '2026-10-24', 'aria-pressed': 'true', tabindex: '0' }, '24')));
  assert.equal(root.childNodes[0], date); assert.equal(date.hasAttribute('inert'), false);
  assert.equal(date.hasAttribute('aria-hidden'), false); assert.equal(date.getAttribute('aria-pressed'), 'true');
  assert.equal(date.getAttribute('tabindex'), '0');
});

test('runtime overlay tracks, their styles and transient classes survive a background patch', () => {
  const { el, fragment, clear } = fixture();
  const track = el('div', { 'data-overlay-scrollbar': '', class: 'overlay-scrollbar is-active', style: 'top: 20px; height: 200px' }, el('i', { style: 'height: 24px' }));
  const area = el('section', { class: 'records overlay-scroll-target motion-pending' }, el('p', {}, 'old'), track);
  const root = el('main', {}, area); clear(root);
  patchLiveView(root, fragment(el('section', { class: 'records' }, el('p', {}, 'new'))));
  assert.equal(root.childNodes[0], area); assert.equal(track.parentNode, area);
  assert.equal(area.getAttribute('class'), 'records overlay-scroll-target motion-pending');
  assert.deepEqual(track.mutations, []); assert.deepEqual(track.childNodes[0].mutations, []);
  assert.equal(area.mutations.some(change => change[0] === 'attribute' && change[1] === 'class'), false);
});

test('unfocused dirty controls receive fresh values, while focused checkbox and textarea state survive', () => {
  const { el, fragment } = fixture();
  const input = el('input', { name: 'title', value: 'initial' }); input.value = 'dirty';
  const check = el('input', { name: 'active', type: 'checkbox' }); check.checked = true; check.focus();
  const root = el('main', {}, input, check);
  patchLiveView(root, fragment(el('input', { name: 'title', value: 'updated' }), el('input', { name: 'active', type: 'checkbox' })));
  assert.equal(input.value, 'updated'); assert.equal(check.checked, true);
  const textarea = el('textarea', { name: 'notes' }, 'initial'); textarea.value = 'editing'; textarea.focus();
  const notesRoot = el('main', {}, textarea);
  patchLiveView(notesRoot, fragment(el('textarea', { name: 'notes' }, 'server text')));
  assert.equal(textarea.value, 'editing'); assert.equal(textarea.childNodes[0].nodeValue, 'initial');
});

test('focused select options retain live selection while other page content can update', () => {
  const { el, fragment } = fixture();
  const select = el('select', { name: 'mode' }, el('option', { value: 'daily', selected: '' }, 'Daily'), el('option', { value: 'manual' }, 'Manual'));
  const option = select.childNodes[1]; select.value = 'manual'; select.focus();
  const root = el('main', {}, select, el('p', {}, 'old'));
  patchLiveView(root, fragment(el('select', { name: 'mode' }, el('option', { value: 'daily', selected: '' }, 'Changed')), el('p', {}, 'new')));
  assert.equal(select.value, 'manual'); assert.equal(select.childNodes[1], option);
  assert.equal(select.childNodes[0].childNodes[0].nodeValue, 'Daily');
  assert.equal(root.childNodes[1].childNodes[0].nodeValue, 'new');
});
