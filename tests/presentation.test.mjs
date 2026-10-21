import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPresentations, cardGeometry } from '../src/presentation.mjs';

let originals, replacement;
const rect = { left: 20, top: 180, width: 340, height: 300, bottom: 480, right: 360 };
function source({ scope = null, hidden = false, bounds = rect, card = '', parts = [], ref = 'parking', cardKind = '' } = {}) {
  const attributes = { 'data-action': 'detail', 'data-ref': ref, ...(cardKind ? { 'data-card-kind': cardKind } : {}) };
  return { dataset: { action: 'detail', ref, ...(cardKind ? { cardKind } : {}) }, tagName: 'BUTTON', id: '', isConnected: true, focused: null,
    attributes: Object.keys(attributes).map(name => ({ name })),
    getAttribute: name => attributes[name] ?? null, hasAttribute: name => Object.hasOwn(attributes, name),
    getClientRects: () => [bounds],
    matches: selector => Boolean(card && selector.includes(card)),
    querySelectorAll: () => parts,
    getBoundingClientRect: () => bounds, closest: selector => selector === 'dialog' ? scope : hidden ? {} : null,
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
    for (const name of ['transform', 'opacity', 'clipPath', 'fontSize', 'transformOrigin']) if (element.style?.[name]) style[name] = element.style[name];
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
  sourceArtwork.dataset = { cardPart: 'bays' };
  trigger.querySelectorAll = () => [sourceArtwork];
  view.querySelector = selector => selector === '.parking-detail' ? { querySelectorAll: () => [artwork] } : selector === '#sheet-content' ? { scrollTop: 0 } : null;
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

function visualPart(name, bounds, computed = {}) {
  const element = dialog();
  element.isConnected = true;
  element.dataset.cardPart = name;
  element.getBoundingClientRect = () => bounds;
  element.computed = { fontSize: '16px', ...computed };
  return element;
}
function cardFixture({ bounds = rect, kind = '.brief-card', scrollTop = 0, ref = 'parking', cardKind = '', scope = null } = {}) {
  const sourceTitle = visualPart('title', { left: 40, top: bounds.top + 70, width: 170, height: 32 }, { fontSize: '20px' });
  const sourceArt = visualPart('art', { left: 220, top: bounds.top + 60, width: 100, height: 80 }, { opacity: '.8' });
  const trigger = source({ card: kind, bounds, parts: [sourceTitle, sourceArt], ref, cardKind, scope });
  const title = visualPart('title', { left: 24, top: 120, width: 240, height: 40 }, { fontSize: '28px' });
  const art = visualPart('art', { left: 220, top: 172, width: 140, height: 112 }, { opacity: '.8' });
  const reveal = visualPart('body', { left: 0, top: 350, width: 390, height: 450 });
  reveal.hasAttribute = name => name === 'data-card-reveal';
  const hero = { querySelectorAll: () => [title, art] }, scroller = { scrollTop };
  const view = dialog();
  view.classList = { contains: name => name === 'card-page' };
  view.querySelector = selector => selector === '.card-detail-hero' ? hero : selector === '#sheet-content' ? scroller : null;
  view.querySelectorAll = () => [reveal];
  return { view, trigger, title, art, sourceTitle, sourceArt, reveal, scroller };
}

test('real dashboard cards expand their surface and matched content from the pre-modal origin', () => {
  const { view, trigger, title, art } = cardFixture();
  const originalModal = view.showModal;
  view.showModal = function () {
    originalModal.call(this);
    // A background card cannot be rediscovered as an available control after
    // showModal. The entrance must already have captured its visual origin.
    trigger.getClientRects = () => [];
  };
  const presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  assert.equal(view.dataset.cardMotion, 'true');
  assert.equal(view.animations[0].frames[0].transform, 'translate(20px, 168px)');
  assert.ok(view.animations[0].frames.every(frame => !frame.transform.includes('scale')));
  assert.equal(title.animations[0].frames[0].transform, 'translate(-4px, -38px)');
  assert.equal(title.animations[0].frames[0].fontSize, '20px');
  assert.equal(title.animations[0].frames[1].fontSize, '28px');
  assert.ok(title.animations[0].frames.every(frame => !frame.transform.includes('scale')));
  assert.match(art.animations[0].frames[0].transform, /scale\(0\.7142857142857143\)/);
  assert.deepEqual(art.animations[0].frames.map(frame => frame.opacity), ['.8', '.8']);
  view.animations[0].finish();
});

test('a partly visible forecast card uses its visible intersection rather than a slide-up fallback', () => {
  const bounds = { left: 20, top: -45, right: 360, bottom: 255, width: 340, height: 300 };
  const { view, trigger } = cardFixture({ bounds, kind: '.forecast-card' });
  createPresentations().show(view, { source: trigger, kind: 'detail' });
  assert.equal(view.dataset.cardMotion, 'true');
  assert.equal(view.animations[0].frames[0].transform, 'translate(20px, -12px)');
  assert.match(view.animations[0].frames[0].clipPath, /inset\(0px 50px 577px 0px/);
  view.animations[0].finish();
});

test('closing an expanded card from its scroll position returns the surface to its card', async () => {
  const { view, trigger, scroller, reveal, title } = cardFixture();
  const presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  view.animations[0].finish(); await Promise.resolve();
  scroller.scrollTop = 320;
  const closing = presentation.dismiss(view);
  assert.equal(scroller.scrollTop, 0);
  assert.equal(title.animations.at(-1).frames[0].transform, 'translateY(-320px)');
  assert.equal(title.animations.at(-1).frames.at(-1).transform, 'translate(-4px, -38px)');
  assert.equal(reveal.animations.at(-1).frames[0].transform, 'translateY(-320px)');
  assert.equal(reveal.animations.at(-1).frames.at(-1).transform, 'translateY(-320px) translateY(16px)');
  assert.equal(reveal.animations.at(-1).frames.at(-1).opacity, 0);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translate(20px, 168px)');
  assert.match(view.animations.at(-1).frames.at(-1).clipPath, /round 30px/);
  view.animations.at(-1).finish(); await closing;
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('catching an expanding card mid-flight reverses its current clip without snapping to full size', async () => {
  const { view, trigger, title } = cardFixture();
  const presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  view.computed = { transform: 'matrix(1, 0, 0, 1, 12, 96)', clipPath: 'inset(0px 30px 330px 0px round 18px)', opacity: '1' };
  title.computed.transform = 'matrix(1, 0, 0, 1, -2, -20)';
  const closing = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames[0].transform, view.computed.transform);
  assert.equal(view.animations.at(-1).frames[0].clipPath, view.computed.clipPath);
  assert.equal(title.animations.at(-1).frames[0].transform, title.computed.transform);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translate(20px, 168px)');
  view.animations.at(-1).finish(); await closing;
});

test('a removed origin falls back safely, while a rerendered card retains the return destination', async () => {
  const first = cardFixture(), presentation = createPresentations();
  presentation.show(first.view, { source: first.trigger, kind: 'detail' });
  first.view.animations[0].finish(); await Promise.resolve();
  first.trigger.isConnected = false;
  const next = cardFixture({ bounds: { ...rect, left: 12, right: 352 } });
  replacement = next.trigger;
  const returning = presentation.dismiss(first.view);
  assert.equal(first.view.animations.at(-1).frames.at(-1).transform, 'translate(12px, 168px)');
  first.view.animations.at(-1).finish(); await returning;
  assert.deepEqual(next.trigger.focused, { preventScroll: true });

  replacement = null;
  const removed = cardFixture();
  presentation.show(removed.view, { source: removed.trigger, kind: 'detail' });
  removed.view.animations[0].finish(); await Promise.resolve();
  removed.trigger.isConnected = false;
  const fallback = presentation.dismiss(removed.view);
  assert.equal(removed.view.animations.at(-1).frames.at(-1).transform, 'translateY(28px)');
  removed.view.animations.at(-1).finish(); await fallback;
  assert.equal(removed.view.closeCount, 1);
  assert.equal(removed.trigger.focused, null);
});

test('a nested card page still returns its surface when shared hero content has been replaced', async () => {
  const { view, trigger } = cardFixture();
  const presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  view.animations[0].finish(); await Promise.resolve();
  view.querySelector = () => null;
  view.querySelectorAll = () => [];
  const closing = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translate(20px, 168px)');
  view.animations.at(-1).finish(); await closing;
  assert.equal(view.closeCount, 1);
});

test('reopening an expanding card during its return cancels the close and continues the same surface', async () => {
  const { view, trigger } = cardFixture();
  const presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'detail' });
  const closing = presentation.dismiss(view);
  view.computed = { transform: 'matrix(1, 0, 0, 1, 8, 70)', clipPath: 'inset(0px 20px 220px 0px round 12px)', opacity: '1' };
  presentation.show(view, { source: trigger, kind: 'detail' });
  await closing;
  assert.equal(view.open, true);
  assert.equal(view.closeCount, 0);
  assert.equal(view.dataset.closing, undefined);
  assert.equal(view.animations.at(-1).frames[0].clipPath, view.computed.clipPath);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translate(0px, 0px)');
  view.animations.at(-1).finish();
});

test('a cancelled card drag restores shared type styles as well as the surface', async () => {
  const { view, trigger, title } = cardFixture();
  const presentation = createPresentations();
  presentation.pullToDismiss(view, () => assert.fail('A short cancelled pull must not dismiss the card'));
  presentation.show(view, { source: trigger, kind: 'detail' });
  title.computed = { ...title.computed, fontSize: '24px', transformOrigin: '0px 0px' };
  view.dispatch('pointerdown');
  view.dispatch('pointermove', { clientY: 140 });
  assert.equal(title.style.fontSize, '24px');
  view.dispatch('pointercancel');
  assert.equal(title.animations.at(-1).frames[0].fontSize, '24px');
  assert.equal(title.style.getPropertyValue('font-size'), '');
  view.animations.at(-1).finish(); await Promise.resolve();
  assert.equal(view.dataset.cardMotion, undefined);
  assert.equal(title.style.getPropertyValue('transform-origin'), '');
  assert.equal(view.open, true);
});

test('a generic reminder returns to its newly created record inside the original source scope', async () => {
  const scope = { controls: [], contains(element) { return this.controls.includes(element); }, querySelectorAll() { return this.controls; } };
  const original = cardFixture({ ref: 'reminder', cardKind: 'reminder', scope });
  scope.controls = [original.trigger];
  const presentation = createPresentations();
  presentation.show(original.view, { source: original.trigger, kind: 'detail' });
  original.view.animations[0].finish(); await Promise.resolve();
  original.trigger.isConnected = false;
  const created = cardFixture({ ref: 'reminder:new-id', cardKind: 'reminder', scope, bounds: { ...rect, left: 10, right: 350 } });
  const otherScope = cardFixture({ ref: 'reminder:other-user', cardKind: 'reminder' });
  scope.controls = [created.trigger];
  replacement = [otherScope.trigger, created.trigger];
  const closing = presentation.dismiss(original.view);
  assert.equal(original.view.animations.at(-1).frames.at(-1).transform, 'translate(10px, 168px)');
  original.view.animations.at(-1).finish(); await closing;
  assert.deepEqual(created.trigger.focused, { preventScroll: true });
  assert.equal(otherScope.trigger.focused, null);
});

test('deleting a specific reminder never redirects its return or focus to another reminder', async () => {
  const original = cardFixture({ ref: 'reminder:deleted-id', cardKind: 'reminder' });
  const presentation = createPresentations();
  presentation.show(original.view, { source: original.trigger, kind: 'detail' });
  original.view.animations[0].finish(); await Promise.resolve();
  original.trigger.isConnected = false;
  const unrelated = cardFixture({ ref: 'reminder:another-id', cardKind: 'reminder' });
  replacement = unrelated.trigger;
  const closing = presentation.dismiss(original.view);
  assert.equal(original.view.animations.at(-1).frames.at(-1).transform, 'translateY(28px)');
  original.view.animations.at(-1).finish(); await closing;
  assert.equal(unrelated.trigger.focused, null);
});

test('touching a scrolled card header does not reset it, and the fixed header stays put on close', async () => {
  const { view, trigger, scroller, title, reveal } = cardFixture();
  const header = visualPart('header', { left: 0, top: 0, width: 390, height: 60 });
  view.querySelectorAll = () => [reveal, header];
  const presentation = createPresentations();
  presentation.pullToDismiss(view, () => assert.fail('A tap must not dismiss the page'));
  presentation.show(view, { source: trigger, kind: 'detail' });
  view.animations[0].finish(); await Promise.resolve();
  scroller.scrollTop = 180;
  view.dispatch('pointerdown');
  assert.equal(scroller.scrollTop, 180);
  view.dispatch('pointerup');
  const closing = presentation.dismiss(view);
  assert.equal(scroller.scrollTop, 0);
  assert.equal(title.animations.at(-1).frames[0].transform, 'translateY(-180px)');
  assert.equal(header.animations.at(-1).frames[0].transform, 'none');
  view.animations.at(-1).finish(); await closing;
});
