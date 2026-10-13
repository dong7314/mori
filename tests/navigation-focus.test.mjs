import test from 'node:test';
import assert from 'node:assert/strict';
import { captureControl, resolveControl, isAvailableControl } from '../src/navigation-focus.mjs';

function control(attributes, { hidden = false, tag = 'BUTTON' } = {}) {
  return {
    tagName: tag, isConnected: true, disabled: false, id: attributes.id || '',
    attributes: Object.keys(attributes).map(name => ({ name })),
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => Object.hasOwn(attributes, name),
    closest: () => hidden ? {} : null,
    getClientRects: () => [{ width: 100, height: 44 }],
  };
}
const rootOf = elements => ({ contains: element => elements.includes(element), querySelectorAll: () => elements });

test('rerendered checklist restores the clicked item, not the first matching action', () => {
  const attrs = { 'data-action': 'check-item', 'data-id': 'daily-notes', 'data-index': '2', 'aria-pressed': 'false' };
  const original = control(attrs), bookmark = captureControl(original);
  original.isConnected = false;
  const first = control({ ...attrs, 'data-index': '0' });
  const clicked = control({ ...attrs, 'aria-pressed': 'true' });
  assert.equal(resolveControl(rootOf([first, clicked]), bookmark), clicked);
});

test('a surviving control is preferred over another control with the same action', () => {
  const original = control({ 'data-action': 'new-chat' });
  const duplicate = control({ 'data-action': 'new-chat' });
  assert.equal(resolveControl(rootOf([duplicate, original]), captureControl(original)), original);
});

test('closing a guide can resolve its visible originating control after the page rerenders', () => {
  const original = control({ 'data-action': 'guide' }), bookmark = captureControl(original);
  original.isConnected = false;
  const hidden = control({ 'data-action': 'guide' }, { hidden: true });
  const visible = control({ 'data-action': 'guide' });
  assert.equal(resolveControl(rootOf([hidden, visible]), bookmark, { visible: true }), visible);
  assert.equal(resolveControl(rootOf([hidden]), bookmark, { visible: true }), null);
});

test('closed dialogs, disabled buttons, and removed controls cannot become return targets', () => {
  const hidden = control({ 'data-action': 'new-chat' }, { hidden: true });
  const disabled = control({ 'data-action': 'new-chat' }); disabled.disabled = true;
  const removed = control({ 'data-action': 'new-chat' }); removed.isConnected = false;
  for (const element of [hidden, disabled, removed, null]) assert.equal(isAvailableControl(element), false);
});

test('a replaced navigation tab retains its identity as the current page changes', () => {
  const original = control({ 'data-view': 'conversations' });
  const bookmark = captureControl(original); original.isConnected = false;
  const dashboard = control({ 'data-view': 'dashboard' });
  const current = control({ 'data-view': 'conversations', 'aria-current': 'page' });
  assert.equal(resolveControl(rootOf([dashboard, current]), bookmark, { visible: true }), current);
});
