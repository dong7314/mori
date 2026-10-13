import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPresentations, cardGeometry } from '../src/presentation.mjs';

let originals, replacement;
const rect = { left: 20, top: 180, width: 340, height: 300, bottom: 480, right: 360 };
function source({ scope = null, hidden = false } = {}) {
  const attributes = { 'data-action': 'detail', 'data-ref': 'parking' };
  return { dataset: { action: 'detail', ref: 'parking' }, tagName: 'BUTTON', id: '', isConnected: true, focused: null,
    attributes: Object.keys(attributes).map(name => ({ name })),
    getAttribute: name => attributes[name] ?? null, hasAttribute: name => Object.hasOwn(attributes, name),
    getClientRects: () => [rect],
    getBoundingClientRect: () => rect, closest: selector => selector === 'dialog' ? scope : hidden ? {} : null,
    focus(options) { this.focused = options; } };
}
function dialog() {
  const listeners = new Map();
  const property = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return { open: false, dataset: {}, animations: [], closeCount: 0,
    style: {
      setProperty(name, value) { this[property(name)] = value; },
      getPropertyValue(name) { return this[property(name)] || ''; },
      removeProperty(name) { delete this[property(name)]; },
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    dispatch(name, event = {}) { listeners.get(name)?.({ pointerId: 1, button: 0, clientY: 100, preventDefault() {}, target: { closest: selector => selector.includes('.sheet-header') ? {} : null }, ...event }); },
    setPointerCapture() {}, releasePointerCapture() {},
    removeAttribute(name) { delete this.dataset[property(name.replace('data-', ''))]; },
    showModal() { this.open = true; }, close() { this.open = false; this.closeCount++; },
    getBoundingClientRect: () => ({ left: 0, top: 12, width: 390, height: 832 }),
    animate(frames, options) {
      let finish, reject;
      const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
      const animation = { frames, options, finished, finish, cancel: () => reject(new Error('cancelled')) };
      this.animations.push(animation); return animation;
    } };
}
beforeEach(() => {
  originals = new Map(['CSS', 'document', 'innerHeight', 'innerWidth', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.CSS = { escape: value => value };
  globalThis.document = { activeElement: null, contains: element => element.isConnected,
    querySelectorAll: () => replacement ? [replacement].flat() : [] };
  globalThis.innerHeight = 844; globalThis.innerWidth = 390;
  globalThis.getComputedStyle = element => {
    const style = { borderRadius: '30px', transform: 'none', opacity: '1', clipPath: 'none', ...element.computed };
    for (const name of ['transform', 'opacity', 'clipPath']) if (element.style?.[name]) style[name] = element.style[name];
    return { ...style, getPropertyValue: name => element.style?.getPropertyValue(name) || element.custom?.[name] || '1' };
  };
  replacement = null;
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

test('reduced motion opens and closes immediately, restoring focus without scrolling', async () => {
  const view = dialog(), trigger = source();
  const presentation = createPresentations({ reducedMotion: () => true });
  presentation.show(view, { source: trigger, kind: 'detail' });
  assert.equal(view.open, true);
  await presentation.dismiss(view);
  assert.equal(view.open, false);
  assert.equal(view.animations.length, 0);
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('reopening during dismissal cancels the old close, so the new view stays open', async () => {
  const view = dialog(), presentation = createPresentations();
  presentation.show(view, { source: source(), kind: 'detail' });
  const closing = presentation.dismiss(view);
  presentation.show(view, { source: source(), kind: 'detail' });
  await closing;
  assert.equal(view.open, true);
  assert.equal(view.closeCount, 0);
  assert.equal(view.dataset.closing, undefined);
  view.animations.at(-1).finish();
});

test('repeated dismiss requests share a completion and close exactly once', async () => {
  const view = dialog(), presentation = createPresentations();
  presentation.show(view, { source: source() });
  const first = presentation.dismiss(view), second = presentation.dismiss(view);
  assert.equal(first, second);
  view.animations.at(-1).finish();
  await first;
  assert.equal(view.closeCount, 1);
  assert.equal(view.dataset.closing, undefined);
});

test('toast hosts follow the modal opening order and skip a dismissing detail', async () => {
  const chat = dialog(), detail = dialog(), voice = dialog(), presentation = createPresentations();
  presentation.show(chat, { source: source(), kind: 'chat' });
  presentation.show(detail, { source: source(), kind: 'detail' });
  assert.equal(presentation.topDialog(), detail);
  const closingDetail = presentation.dismiss(detail);
  assert.equal(presentation.topDialog(), chat);
  detail.animations.at(-1).finish(); await closingDetail;
  presentation.show(voice, { source: source(), kind: 'voice' });
  assert.equal(presentation.topDialog(), voice);
  const closingVoice = presentation.dismiss(voice);
  assert.equal(presentation.topDialog(), chat);
  voice.animations.at(-1).finish(); await closingVoice;
  const closingChat = presentation.dismiss(chat);
  assert.equal(presentation.topDialog(), null);
  chat.animations.at(-1).finish(); await closingChat;
});

test('a rerendered card regains focus instead of the removed source element', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  trigger.isConnected = false;
  replacement = source();
  const closing = presentation.dismiss(view);
  view.animations.at(-1).finish();
  await closing;
  assert.equal(trigger.focused, null);
  assert.deepEqual(replacement.focused, { preventScroll: true });
});

test('closing a nested detail returns to the replacement inside its originating dialog', async () => {
  const chat = { controls: [], contains(element) { return this.controls.includes(element); }, querySelectorAll() { return this.controls; } };
  const trigger = source({ scope: chat }); chat.controls = [trigger];
  const view = dialog(), presentation = createPresentations({ reducedMotion: () => true });
  presentation.show(view, { source: trigger, kind: 'detail' });
  trigger.isConnected = false;
  const dashboardCard = source(), chatResult = source({ scope: chat });
  replacement = [dashboardCard, chatResult]; chat.controls = [chatResult];
  await presentation.dismiss(view);
  assert.equal(dashboardCard.focused, null);
  assert.deepEqual(chatResult.focused, { preventScroll: true });
});

test('focus restoration skips hidden and disabled duplicates after a rerender', async () => {
  const trigger = source(), view = dialog(), presentation = createPresentations({ reducedMotion: () => true });
  presentation.show(view, { source: trigger });
  trigger.isConnected = false;
  const hidden = source({ hidden: true }), disabled = source(), visible = source();
  disabled.disabled = true; replacement = [hidden, disabled, visible];
  await presentation.dismiss(view);
  assert.equal(hidden.focused, null);
  assert.equal(disabled.focused, null);
  assert.deepEqual(visible.focused, { preventScroll: true });
});


test('card geometry expands the surface without scaling or distorting text', () => {
  const motion = cardGeometry(rect, { left: 0, top: 0, width: 390, height: 844 });
  assert.equal(motion.frames[0].transform, 'translate(20px, 180px)');
  assert.equal(motion.frames[0].clipPath, 'inset(0px 50px 544px 0px round 28px)');
  assert.equal(motion.frames[1].clipPath, 'inset(0px 0px 0px 0px round 0px)');
  assert.equal(motion.frames.every(frame => !frame.transform.includes('scale')), true);
  assert.equal(motion.frames[0].opacity, 1);
});

test('a larger source does not get stretched into a smaller destination', () => {
  assert.equal(cardGeometry(rect, { left: 0, top: 0, width: 300, height: 844 }), null);
  assert.equal(cardGeometry(null, { width: 390, height: 844 }), null);
});

test('closing during entrance starts at the currently rendered position', async () => {
  const view = dialog(), presentation = createPresentations();
  presentation.show(view, { source: source(), kind: 'detail' });
  view.computed = { transform: 'matrix(1, 0, 0, 1, 0, 14)', opacity: '.65' };
  const closing = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames[0].transform, view.computed.transform);
  assert.equal(view.animations.at(-1).frames[0].opacity, '.65');
  view.animations.at(-1).finish();
  await closing;
  assert.equal(view.closeCount, 1);
});

test('catching a fading entrance preserves opacity and recovers when pointer capture is lost', async () => {
  const view = dialog(), presentation = createPresentations();
  presentation.pullToDismiss(view, () => assert.fail('A cancelled drag must not dismiss the sheet'));
  presentation.show(view, { source: source() });
  view.computed = { transform: 'matrix(1, 0, 0, 1, 0, 14)', opacity: '.45' };
  view.custom = { '--detail-progress': '0' };
  view.dispatch('pointerdown');
  view.dispatch('pointermove', { clientY: 140 });
  assert.equal(view.style.opacity, '.45');
  assert.equal(view.style.getPropertyValue('--detail-progress'), '0');
  view.dispatch('lostpointercapture');
  assert.equal(view.animations.at(-1).frames[0].opacity, '.45');
  assert.equal(view.style.getPropertyValue('opacity'), '');
  view.animations.at(-1).finish();
  await Promise.resolve();
  assert.equal(view.open, true);
  assert.equal(view.style.getPropertyValue('transform'), '');
});

test('cancelling a drag after reduced motion is enabled clears temporary presentation styles', () => {
  let reduced = false;
  const view = dialog(), presentation = createPresentations({ reducedMotion: () => reduced });
  presentation.pullToDismiss(view, () => assert.fail('A cancelled drag must not dismiss the sheet'));
  presentation.show(view, { source: source() });
  view.dataset.cardMotion = 'true';
  view.dispatch('pointerdown');
  view.dispatch('pointermove', { clientY: 140 });
  reduced = true;
  view.dispatch('pointercancel');
  assert.equal(view.animations.length, 1);
  assert.equal(view.dataset.cardMotion, undefined);
  assert.equal(view.style.getPropertyValue('opacity'), '');
  assert.equal(view.style.getPropertyValue('transform'), '');
  assert.equal(view.style.getPropertyValue('clip-path'), '');
  assert.equal(view.open, true);
});

test('shared artwork keeps its designed opacity throughout the transition', () => {
  const view = dialog(), trigger = source(), artwork = dialog();
  artwork.isConnected = true;
  artwork.dataset.cardPart = 'bays';
  artwork.computed = { opacity: '.5', fontSize: '13px' };
  artwork.getBoundingClientRect = () => ({ left: 170, top: 200, width: 210, height: 72 });
  const sourceArtwork = { getBoundingClientRect: () => ({ left: 140, top: 310, width: 210, height: 72 }), computed: { opacity: '.5', fontSize: '13px' } };
  trigger.matches = () => true;
  trigger.querySelector = () => sourceArtwork;
  view.querySelector = selector => selector === '.parking-detail' ? { querySelectorAll: () => [artwork] } : { scrollTop: 0 };
  view.querySelectorAll = () => [];
  const presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  assert.equal(view.dataset.cardMotion, 'true');
  assert.deepEqual(artwork.animations[0].frames.map(frame => frame.opacity), ['.5', '.5']);
  view.animations[0].finish();
});

test('peer destinations cancel earlier motion and fade without changing position', () => {
  let cancelled = 0, observed;
  const content = {
    getAnimations: () => [{ cancel() { cancelled++; } }],
    animate(frames, options) { observed = { frames, options }; },
  };
  createPresentations().replace(content, { level: true });
  assert.equal(cancelled, 1);
  assert.equal(observed.frames.every(frame => !Object.hasOwn(frame, 'transform')), true);
  assert.ok(observed.frames[0].opacity > 0 && observed.frames[0].opacity < 1);
  assert.equal(observed.frames.at(-1).opacity, 1);
  assert.ok(observed.options.duration >= 140 && observed.options.duration <= 160);
});

test('nested navigation retains opposite forward and back directions', () => {
  const motions = [];
  const content = { getAnimations: () => [], animate(frames, options) { motions.push({ frames, options }); } };
  const presentation = createPresentations();
  presentation.replace(content);
  presentation.replace(content, { back: true });
  assert.match(motions[0].frames[0].transform, /^translateX\(\d/);
  assert.match(motions[1].frames[0].transform, /^translateX\(-\d/);
  for (const motion of motions) {
    assert.equal(motion.frames.at(-1).transform, 'translateX(0)');
    assert.equal(motion.frames.at(-1).opacity, 1);
  }
});

test('reduced motion cancels an existing replacement without starting another', () => {
  let cancelled = 0;
  const content = {
    getAnimations: () => [{ cancel() { cancelled++; } }],
    animate() { assert.fail('Reduced motion must not animate content replacement'); },
  };
  const presentation = createPresentations({ reducedMotion: () => true });
  presentation.replace(content, { level: true });
  presentation.replace(content, { back: true });
  assert.equal(cancelled, 2);
});
