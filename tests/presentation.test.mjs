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
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    dispatch(name, event = {}) { for (const listener of listeners.get(name) || []) listener({ pointerId: 1, button: 0, clientY: 100, preventDefault() {}, target: { closest: selector => selector.includes('.sheet-header') ? {} : null }, ...event }); },
    setPointerCapture() {}, releasePointerCapture() {},
    removeAttribute(name) { delete this.dataset[property(name.replace('data-', ''))]; },
    showModal() { this.open = true; }, close() { this.open = false; this.closeCount++; },
    getBoundingClientRect: () => ({ left: 0, top: 12, width: 390, height: 832 }),
    animate(frames, options) {
      let finish, reject;
      const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
      const animation = { frames, options, finished, finish, cancel: () => { animation.cancelled = true; reject(new Error('cancelled')); } };
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

function lifecycleFixture({ reducedMotion = () => false, matches = false } = {}) {
  const events = values => {
    const listeners = new Map();
    return { ...values,
      addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
      removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
      dispatch(name) { for (const handler of listeners.get(name) || []) handler({ matches: this.matches }); },
      listenerCount(name) { return listeners.get(name)?.size || 0; },
    };
  };
  const preference = events({ matches });
  const window = events({ matchMedia: () => preference });
  const document = events({ ...globalThis.document, hidden: false, defaultView: window });
  return { preference, window, document, presentation: createPresentations({ reducedMotion, document }) };
}

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

test('detail refreshes wait for entrance cleanup and apply only the newest result', async () => {
  const { view, trigger, title } = cardFixture();
  const presentation = createPresentations();
  const applied = [];
  presentation.show(view, { source: trigger, kind: 'detail' });
  assert.equal(presentation.deferUpdate(view, () => applied.push('stale')), true);
  assert.equal(presentation.deferUpdate(view, () => {
    assert.equal(view.dataset.cardMotion, undefined);
    applied.push('latest');
  }), true);
  assert.deepEqual(applied, []);

  view.animations[0].finish();
  await Promise.resolve();

  assert.deepEqual(applied, ['latest']);
  await assert.rejects(title.animations[0].finished, /cancelled/);
  assert.equal(presentation.deferUpdate(view, () => applied.push('not-queued')), false);
  assert.deepEqual(applied, ['latest']);
});

test('dismissal drops a queued refresh and ignores refreshes received while closing', async () => {
  const { view, trigger } = cardFixture();
  const presentation = createPresentations();
  const applied = [];
  presentation.show(view, { source: trigger, kind: 'detail' });
  const entrance = view.animations[0];
  assert.equal(presentation.deferUpdate(view, () => applied.push('before-close')), true);

  const closing = presentation.dismiss(view);
  assert.equal(presentation.deferUpdate(view, () => applied.push('during-close')), true);
  entrance.finish();
  await Promise.resolve();
  assert.deepEqual(applied, []);
  view.animations.at(-1).finish();
  await closing;

  assert.equal(view.open, false);
  assert.deepEqual(applied, []);
  assert.equal(presentation.deferUpdate(view, () => applied.push('after-close')), false);
  assert.deepEqual(applied, []);
});

test('settling for nested navigation discards the old refresh and leaves a clean open page', async () => {
  const { view, trigger, title, art, reveal } = cardFixture();
  const presentation = createPresentations();
  let oldPageRestored = false;
  presentation.show(view, { source: trigger, kind: 'detail' });
  const entrance = view.animations[0];
  presentation.deferUpdate(view, () => { oldPageRestored = true; });

  presentation.settle(view);

  assert.equal(view.open, true);
  assert.equal(view.closeCount, 0);
  assert.equal(view.dataset.cardMotion, undefined);
  for (const element of [view, title, art, reveal]) await assert.rejects(element.animations[0].finished, /cancelled/);
  assert.equal(presentation.deferUpdate(view, () => { oldPageRestored = true; }), false);
  entrance.finish();
  await Promise.resolve();
  assert.equal(oldPageRestored, false);
});

test('a reduced-motion page never holds a refresh behind an absent entrance', () => {
  const view = dialog(), presentation = createPresentations({ reducedMotion: () => true });
  presentation.show(view, { source: source(), kind: 'detail' });
  assert.equal(presentation.deferUpdate(view, () => assert.fail('The caller applies an unqueued refresh')), false);
  presentation.settle(view);
  assert.equal(view.open, true);
  assert.equal(view.animations.length, 0);
});

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

test('a forecast entrance respects its rail clipping edge instead of revealing the hidden gutter', () => {
  const bounds = { left: -40, top: 180, right: 300, bottom: 480, width: 340, height: 300 };
  const { view, trigger } = cardFixture({ bounds, kind: '.forecast-card' });
  trigger.parentElement = {
    computed: { overflowX: 'hidden', overflowY: 'visible' },
    getBoundingClientRect: () => ({ left: 24, right: 366, top: 160, bottom: 500 }),
  };
  createPresentations().show(view, { source: trigger, kind: 'detail' });
  assert.equal(view.animations[0].frames[0].transform, 'translate(24px, 168px)');
  assert.match(view.animations[0].frames[0].clipPath, /inset\(0px 114px 532px 0px/);
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

function replacementFixture() {
  const view = dialog();
  view.clientLeft = 1; view.clientTop = 1; view.layers = [];
  view.append = node => { view.layers.push(node); node.attached = true; };
  const computed = getComputedStyle;
  globalThis.getComputedStyle = element => element.frozenStyle ? Object.assign(Object.keys(element.frozenStyle), {
    getPropertyValue: name => element.frozenStyle[name] || '',
  }) : computed(element);
  function node({ tag = 'DIV', attrs = {}, children = [], css = {}, svg = false } = {}) {
    const attributes = new Map(Object.entries(attrs)), values = new Map(), priorities = new Map();
    const element = {
      tagName: tag, children, ownerSVGElement: svg ? {} : null, frozenStyle: { display: 'block', opacity: '1', 'font-size': '16px', ...css },
      scrollTop: 0, scrollLeft: 0, animations: [], attached: false, removed: false,
      style: {
        setProperty(name, value, priority = '') { values.set(name, value); priorities.set(name, priority); },
        getPropertyValue: name => values.get(name) || '', getPropertyPriority: name => priorities.get(name) || '',
        set cssText(value) { values.clear(); for (const declaration of value.split(';')) { const at = declaration.indexOf(':'); if (at > 0) values.set(declaration.slice(0, at), declaration.slice(at + 1)); } },
      },
      get attributes() { return [...attributes].map(([name, value]) => ({ name, value })); },
      getAttribute: name => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
      classList: { add: name => attributes.set('class', `${attributes.get('class') || ''} ${name}`.trim()) },
      closest: selector => selector === 'dialog' ? view : null,
      matches: selector => selector.startsWith('.') ? (attributes.get('class') || '').split(/\s+/).includes(selector.slice(1)) : selector.startsWith('#') ? attributes.get('id') === selector.slice(1) : tag.toLowerCase() === selector.toLowerCase(),
      querySelectorAll(selector = '*') { return children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.matches(selector)); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      appendChild(child) { children.push(child); return child; },
      getBoundingClientRect: () => ({ left: 1, top: 78, width: 388, height: 720 }),
      cloneNode(deep = false) { const copy = node({ tag, attrs: Object.fromEntries(attributes), children: deep ? children.map(child => child.cloneNode(true)) : [], css: this.frozenStyle, svg }); if ('value' in this) { copy.value = ''; copy.disabled = false; } return copy; },
      getAnimations() { return this.animations; }, animate: dialog().animate,
      remove() { this.removed = true; this.attached = false; },
    };
    return element;
  }
  const input = node({ tag: 'INPUT', attrs: { id: 'title', name: 'title', form: 'editor', autofocus: '', tabindex: '0', 'data-countdown': 'live', oninput: 'oldHook()' } });
  input.value = '작성 중인 메모'; input.disabled = false;
  const gradient = node({ tag: 'linearGradient', attrs: { id: 'price-gradient' }, svg: true });
  const path = node({ tag: 'path', attrs: { fill: 'url(#price-gradient)', 'data-live': 'price' }, css: { fill: 'url("http://localhost/#price-gradient")' }, svg: true });
  const image = node({ tag: 'svg', attrs: { id: 'price-chart' }, children: [gradient, path] });
  const content = node({ attrs: { id: 'sheet-content' }, children: [node({ tag: 'FORM', attrs: { id: 'editor', action: '/save' }, children: [input] }), image], css: { 'font-size': '15px', 'line-height': '24px' } });
  content.scrollTop = 185; input.scrollLeft = 36;
  return { view, content, input, gradient, path, node };
}

test('outgoing views preserve typography, unsaved values and scroll without live controls or original SVG ids', () => {
  const { view, content, input } = replacementFixture();
  const presentation = createPresentations();
  view.open = true;
  const previous = presentation.captureReplacement(content);
  assert.equal(previous.root.style.getPropertyValue('font-size'), '15px');
  assert.equal(previous.root.style.getPropertyValue('line-height'), '24px');
  assert.equal(previous.root.getAttribute('aria-hidden'), 'true');
  assert.equal(previous.root.getAttribute('inert'), '');
  assert.equal(previous.root.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(previous.root.style.top, '65px');
  assert.equal(previous.root.style.width, '388px');
  const copies = previous.root.querySelectorAll('*');
  for (const element of [previous.root, ...copies]) {
    assert.ok(element.attributes.every(({ name }) => !name.startsWith('data-') && !name.startsWith('on') && !['tabindex', 'autofocus', 'form', 'name', 'action'].includes(name)));
    assert.equal(element.style.getPropertyValue('animation'), 'none');
    assert.equal(element.style.getPropertyValue('transition'), 'none');
  }
  const copiedInput = copies.find(element => element.tagName === 'INPUT');
  assert.equal(copiedInput.value, input.value);
  assert.equal(copiedInput.disabled, true);
  assert.equal(copiedInput.getAttribute('id'), null);
  const gradient = copies.find(element => element.tagName === 'linearGradient'), path = copies.find(element => element.tagName === 'path');
  assert.match(gradient.getAttribute('id'), /^mori-view-/);
  assert.notEqual(gradient.getAttribute('id'), 'price-gradient');
  assert.equal(path.getAttribute('fill'), `url("#${gradient.getAttribute('id')}")`);
  assert.equal(path.style.getPropertyValue('fill'), `url("#${gradient.getAttribute('id')}")`);
  presentation.replace(content, { previous });
  assert.equal(previous.root.scrollTop, 185);
  assert.equal(copiedInput.scrollLeft, 36);
  assert.equal(previous.root.attached, true);
  assert.equal(input.getAttribute('id'), 'title');
  assert.equal(input.disabled, false);
});

test('internal navigation shows both views together and removes the snapshot when both animations finish', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  const previous = presentation.captureReplacement(content);
  presentation.replace(content, { previous });
  const incoming = content.animations[0], outgoing = previous.root.animations[0];
  assert.equal(incoming.options.duration, 320);
  assert.equal(outgoing.options.duration, 320);
  assert.equal(incoming.frames[0].transform, 'translateX(388px)');
  assert.equal(outgoing.frames.at(-1).transform, `translateX(${-388 * .24}px)`);
  assert.equal(incoming.frames[0].opacity, 1);
  assert.equal(content.style.zIndex, '2');
  assert.equal(previous.root.style.zIndex, '1');
  assert.ok([...incoming.frames, ...outgoing.frames].every(frame => !frame.transform.includes('scale')));
  incoming.finish(); await Promise.resolve();
  assert.equal(previous.root.removed, false);
  outgoing.finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(previous.root.removed, true);
  assert.equal(content.style.zIndex, '');
  assert.equal(previous.removed, true);
});

test('an outgoing view retains its viewport position when the sheet frame changes', () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  const previous = presentation.captureReplacement(content);
  view.getBoundingClientRect = () => ({ left: 24, top: 32, width: 640, height: 820 });
  presentation.replace(content, { previous });
  assert.equal(previous.root.style.left, '-24px');
  assert.equal(previous.root.style.top, '45px');
});

test('a mobile task sheet enters from its lower edge while a tablet uses a centered presentation', () => {
  const mobile = dialog(), presentation = createPresentations();
  mobile.dataset.sheetSurface = 'sheet';
  presentation.show(mobile);
  assert.equal(mobile.animations[0].frames[0].transform, `translateY(${mobile.getBoundingClientRect().height}px)`);
  assert.equal(mobile.animations[0].frames[0].opacity, 1);
  assert.equal(mobile.animations[0].options.duration, 400);
  globalThis.innerWidth = 1024;
  const tablet = dialog(); tablet.dataset.sheetSurface = 'sheet';
  presentation.show(tablet);
  assert.equal(tablet.animations[0].frames[0].transform, 'translateY(18px) scale(.98)');
  assert.equal(tablet.animations[0].frames[0].opacity, 0);
});

test('a full-width picker keeps its bottom edge presentation on tablet and returns the same way', async () => {
  globalThis.innerWidth = 1024;
  const picker = dialog(), presentation = createPresentations();
  picker.dataset.sheetSurface = 'sheet'; picker.dataset.pickerPresentation = 'bottom';
  presentation.show(picker);
  const entering = picker.animations.at(-1);
  assert.equal(entering.frames[0].transform, 'translateY(832px)');
  assert.equal(entering.frames[0].opacity, 1);
  entering.finish(); await entering.finished; await Promise.resolve();
  const dismissed = presentation.dismiss(picker);
  const exiting = picker.animations.at(-1);
  assert.equal(exiting.frames.at(-1).transform, 'translateY(832px)');
  exiting.finish(); await dismissed;
  assert.equal(picker.open, false);
});

test('cancelling a view animation also removes its outgoing layer', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  const previous = presentation.captureReplacement(content);
  presentation.replace(content, { previous });
  content.animations[0].cancel();
  await assert.rejects(content.animations[0].finished, /cancelled/);
  await Promise.resolve();
  assert.equal(previous.root.removed, true);
  await assert.rejects(previous.root.animations[0].finished, /cancelled/);
});

test('selected file inputs are frozen without assigning their protected value', () => {
  const { view, content, input } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  input.type = 'file'; input.value = 'C:\\fakepath\\meeting.txt';
  const clone = input.cloneNode;
  input.cloneNode = function () {
    const copy = clone.call(this);
    Object.defineProperty(copy, 'value', { get: () => '', set: () => assert.fail('A snapshot must not assign a selected file value') });
    return copy;
  };
  const previous = presentation.captureReplacement(content);
  assert.equal(previous.root.querySelectorAll('*').find(element => element.tagName === 'INPUT').value, '');
  presentation.settle(view);
  assert.equal(previous.root.removed, true);
});

test('rapid internal navigation cancels the preceding pair and starts the back direction from a fresh snapshot', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  const previous = presentation.captureReplacement(content);
  presentation.replace(content, { previous });
  const next = presentation.captureReplacement(content);
  assert.equal(previous.root.removed, true);
  await assert.rejects(previous.animations[0].finished, /cancelled/);
  await assert.rejects(previous.animations[1].finished, /cancelled/);
  presentation.replace(content, { previous: next, back: true });
  assert.equal(content.animations.at(-1).frames[0].transform, `translateX(${-388 * .24}px)`);
  assert.equal(next.root.animations[0].frames.at(-1).transform, 'translateX(388px)');
  assert.equal(content.style.zIndex, '1');
  assert.equal(next.root.style.zIndex, '2');
  presentation.settle(view);
  assert.equal(next.root.removed, true);
});

test('dismissal and reduced motion dispose outgoing views instead of leaving invisible input copies', async () => {
  const { view, content } = replacementFixture();
  let reduced = true;
  const presentation = createPresentations({ reducedMotion: () => reduced });
  presentation.show(view, { source: source() });
  assert.equal(presentation.captureReplacement(content), null);
  reduced = false;
  const previous = presentation.captureReplacement(content);
  reduced = true;
  presentation.replace(content, { previous });
  assert.equal(previous.root.removed, true);
  assert.equal(content.animations.length, 0);
  reduced = false;
  const next = presentation.captureReplacement(content);
  presentation.replace(content, { previous: next });
  reduced = true;
  await presentation.dismiss(view);
  assert.equal(next.root.removed, true);
  assert.equal(view.open, false);
});

test('settled internal screens update presentation kind without replacing the original return target', async () => {
  const view = dialog(), trigger = source(), nested = source(), presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'sheet' });
  presentation.show(view, { source: nested, kind: 'voice' });
  assert.equal(view.dataset.presentation, 'sheet');
  presentation.settle(view);
  presentation.show(view, { source: nested, kind: 'voice' });
  assert.equal(view.dataset.presentation, 'voice');
  const closing = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translateY(28px) scale(.98)');
  view.animations.at(-1).finish(); await closing;
  assert.deepEqual(trigger.focused, { preventScroll: true });
  assert.equal(nested.focused, null);
});

test('navigation pages push from their actual width and return horizontally without fading', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations();
  view.dataset.sheetPresentation = 'page';
  view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 768, height: 1024 });
  presentation.show(view, { source: trigger, kind: 'detail' });
  const entering = view.animations[0];
  assert.equal(entering.frames[0].transform, 'translateX(768px)');
  assert.equal(entering.frames[1].transform, 'translateX(0px)');
  assert.deepEqual(entering.frames.map(frame => frame.opacity), [1, 1]);
  assert.equal(view.dataset.cardMotion, undefined);
  entering.finish(); await Promise.resolve();
  const closing = presentation.dismiss(view);
  const returning = view.animations.at(-1);
  assert.equal(returning.frames[0].transform, 'none');
  assert.equal(returning.frames[1].transform, 'translateX(768px)');
  assert.deepEqual(returning.frames.map(frame => Number(frame.opacity)), [1, 1]);
  returning.finish(); await closing;
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('changing a settled selection sheet to a navigation page uses the current presentation on return', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations();
  view.dataset.sheetPresentation = 'sheet';
  presentation.show(view, { source: trigger });
  view.animations[0].finish(); await Promise.resolve();
  presentation.settle(view);
  view.dataset.sheetPresentation = 'page';
  presentation.show(view, { source: source(), kind: 'detail' });
  const closing = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translateX(390px)');
  view.animations.at(-1).finish(); await closing;
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('navigation pages ignore vertical pull gestures rather than behaving like modal sheets', () => {
  const view = dialog(), presentation = createPresentations();
  let dismissed = 0, prevented = 0, captured = 0;
  view.dataset.sheetPresentation = 'page';
  view.setPointerCapture = () => { captured++; };
  presentation.pullToDismiss(view, () => { dismissed++; });
  presentation.show(view, { source: source(), kind: 'detail' });
  view.dispatch('pointerdown', { preventDefault() { prevented++; } });
  view.dispatch('pointermove', { clientY: 360 });
  view.dispatch('pointerup', { clientY: 360 });
  assert.equal(dismissed, 0);
  assert.equal(prevented, 0);
  assert.equal(captured, 0);
  assert.equal(view.style.transform, undefined);
  assert.equal(view.open, true);
});

test('card hero pages keep their expansion and pull behavior even when a page presentation flag remains', async () => {
  const { view, trigger } = cardFixture(), presentation = createPresentations();
  view.dataset.sheetPresentation = 'page';
  presentation.pullToDismiss(view, () => assert.fail('A short pull must return to its card page'));
  presentation.show(view, { source: trigger, kind: 'detail' });
  assert.equal(view.animations[0].frames[0].transform, 'translate(20px, 168px)');
  assert.equal(view.dataset.cardMotion, 'true');
  view.dispatch('pointerdown');
  view.dispatch('pointermove', { clientY: 125 });
  assert.match(view.style.transform, /^translateY\(20px\)/);
  view.dispatch('pointercancel');
  view.animations.at(-1).finish(); await Promise.resolve();
  assert.equal(view.open, true);
});

test('reduced-motion navigation pages appear and return without horizontal animation', async () => {
  const view = dialog(), presentation = createPresentations({ reducedMotion: () => true });
  view.dataset.sheetPresentation = 'page';
  presentation.show(view, { source: source(), kind: 'detail' });
  await presentation.dismiss(view);
  assert.equal(view.animations.length, 0);
  assert.equal(view.open, false);
});

test('a list conversation returns horizontally and the same dialog can reopen vertically from the dock', async () => {
  const view = dialog(), listTrigger = source(), dockTrigger = source(), presentation = createPresentations();
  view.dataset.chatPresentation = 'page';
  presentation.show(view, { source: listTrigger, kind: 'chat' });
  assert.equal(view.animations.at(-1).frames[0].transform, 'translateX(390px)');
  view.animations.at(-1).finish(); await Promise.resolve();
  // A new conversation inside the open page must retain its return route.
  presentation.show(view, { source: source(), kind: 'chat' });
  view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 430, height: 844 });
  const closingPage = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translateX(430px)');
  assert.deepEqual(view.animations.at(-1).frames.map(frame => Number(frame.opacity)), [1, 1]);
  view.animations.at(-1).finish(); await closingPage;
  assert.deepEqual(listTrigger.focused, { preventScroll: true });
  view.dataset.chatPresentation = 'composer';
  presentation.show(view, { source: dockTrigger, kind: 'chat' });
  assert.equal(view.animations.at(-1).frames[0].transform, 'translateY(844px)');
  view.animations.at(-1).finish(); await Promise.resolve();
  const closingDock = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translateY(844px)');
  view.animations.at(-1).finish(); await closingDock;
  assert.deepEqual(dockTrigger.focused, { preventScroll: true });
});

test('list conversations respect reduced motion and ignore the modal vertical pull gesture', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations({ reducedMotion: () => true });
  view.dataset.chatPresentation = 'page';
  presentation.pullToDismiss(view, () => assert.fail('A navigation conversation must not dismiss vertically'));
  presentation.show(view, { source: trigger, kind: 'chat' });
  view.dispatch('pointerdown', { preventDefault() { assert.fail('Navigation must not capture a vertical drag'); } });
  view.dispatch('pointermove', { clientY: 360 });
  view.dispatch('pointerup', { clientY: 360 });
  assert.equal(view.style.transform, undefined);
  assert.equal(view.open, true);
  await presentation.dismiss(view);
  assert.equal(view.animations.length, 0);
  assert.equal(view.open, false);
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('mobile chat enters and returns through the viewport edge without fading its text', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'chat' });
  const entering = view.animations.at(-1);
  assert.equal(entering.frames[0].transform, 'translateY(832px)');
  assert.deepEqual(entering.frames.map(frame => frame.opacity), [1, 1]);
  assert.equal(entering.options.duration, 420);
  entering.finish(); await Promise.resolve();
  const closing = presentation.dismiss(view), exiting = view.animations.at(-1);
  assert.equal(view.open, true, 'the conversation remains visible until its return completes');
  assert.equal(trigger.focused, null);
  assert.equal(exiting.frames.at(-1).transform, 'translateY(832px)');
  assert.deepEqual(exiting.frames.map(frame => Number(frame.opacity)), [1, 1]);
  assert.equal(exiting.options.duration, 320);
  exiting.finish(); await closing;
  assert.equal(view.closeCount, 1);
  assert.deepEqual(trigger.focused, { preventScroll: true });
  assert.equal(view.dataset.closing, undefined);
});

test('tablet chat uses a bounded panel transition and an exact reversed return', async () => {
  globalThis.innerWidth = 1024; globalThis.innerHeight = 1024;
  const view = dialog(), presentation = createPresentations();
  presentation.show(view, { source: source(), kind: 'chat' });
  const entering = view.animations.at(-1);
  assert.equal(entering.frames[0].transform, 'translateY(28px) scale(.985)');
  assert.equal(entering.frames[0].opacity, 0);
  assert.equal(entering.options.duration, 300);
  entering.finish(); await Promise.resolve();
  const closing = presentation.dismiss(view), exiting = view.animations.at(-1);
  assert.deepEqual(exiting.frames.at(-1), entering.frames[0]);
  assert.equal(exiting.options.duration, 220);
  exiting.finish(); await closing;
});

test('chat recalculates its return endpoint after a viewport change during entrance', async () => {
  const view = dialog(), presentation = createPresentations();
  presentation.show(view, { source: source(), kind: 'chat' });
  view.computed = { transform: 'matrix(1, 0, 0, 1, 0, 220)', opacity: '1' };
  globalThis.innerHeight = 1000;
  const closing = presentation.dismiss(view), exiting = view.animations.at(-1);
  assert.equal(exiting.frames[0].transform, view.computed.transform);
  assert.equal(exiting.frames.at(-1).transform, 'translateY(988px)');
  exiting.finish(); await closing;
});

test('catching a returning chat keeps the painted position and cannot close the reopened view', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'chat' });
  view.animations.at(-1).finish(); await Promise.resolve();
  const closing = presentation.dismiss(view);
  view.computed = { transform: 'matrix(1, 0, 0, 1, 0, 350)', opacity: '1' };
  presentation.show(view, { source: trigger, kind: 'chat' });
  const resumed = view.animations.at(-1);
  await closing;
  assert.equal(resumed.frames[0].transform, view.computed.transform);
  assert.equal(resumed.frames.at(-1).transform, 'translateY(0px)');
  assert.equal(view.open, true);
  assert.equal(view.closeCount, 0);
  assert.equal(view.dataset.closing, undefined);
  assert.equal(trigger.focused, null);
  resumed.finish(); await Promise.resolve();
});

test('cancelled chat exit releases modal state unless a new presentation owns the dialog', async () => {
  const view = dialog(), trigger = source(), presentation = createPresentations();
  presentation.show(view, { source: trigger, kind: 'chat' });
  const closing = presentation.dismiss(view);
  view.animations.at(-1).cancel(); await closing;
  assert.equal(view.open, false);
  assert.equal(view.closeCount, 1);
  assert.equal(view.dataset.closing, undefined);
  assert.equal(view.style.getPropertyValue('transform'), '');
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('settling an exiting chat completes its lifecycle when reduced motion becomes active', async () => {
  let reduced = false;
  const view = dialog(), presentation = createPresentations({ reducedMotion: () => reduced });
  presentation.show(view, { source: source(), kind: 'chat' });
  const closing = presentation.dismiss(view);
  reduced = true;
  presentation.settle(view); await closing;
  assert.equal(view.open, false);
  assert.equal(view.closeCount, 1);
  assert.equal(presentation.topDialog(), null);
  assert.equal(view.dataset.closing, undefined);
});

test('composer expansion reveals final geometry while the outgoing layout keeps its original height', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  content.getBoundingClientRect = () => ({ left: 1, top: 700, width: 388, height: 72 });
  const previous = presentation.captureReplacement(content, { settle: true });
  content.getBoundingClientRect = () => ({ left: 1, top: 300, width: 388, height: 472 });
  presentation.replace(content, { previous, vertical: true });
  const entering = content.animations.at(-1);
  assert.equal(entering.frames[0].clipPath, 'inset(400px 0px 0px 0px round 0px)');
  assert.equal(entering.frames.at(-1).clipPath, 'inset(0px 0px 0px 0px round 0px)');
  assert.equal(previous.root.style.height, '72px');
  for (const animation of previous.animations) for (const frame of animation.frames) {
    assert.ok(!Object.keys(frame).some(key => ['height', 'width', 'transform', 'scale'].includes(key)));
  }
  previous.animations.forEach(animation => animation.finish()); await Promise.resolve(); await Promise.resolve();
  assert.equal(previous.root.removed, true);
  assert.equal(content.style.zIndex, '');
});

test('composer dismissal clips the old panel into the final editor before removing it', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  content.getBoundingClientRect = () => ({ left: 1, top: 300, width: 388, height: 472 });
  const previous = presentation.captureReplacement(content);
  content.getBoundingClientRect = () => ({ left: 1, top: 700, width: 388, height: 72 });
  presentation.replace(content, { previous, vertical: true, back: true });
  const outgoing = previous.root.animations.at(-1);
  assert.equal(previous.root.style.height, '472px');
  assert.equal(previous.root.style.zIndex, '2');
  assert.equal(outgoing.frames[0].clipPath, 'inset(0px 0px 0px 0px round 0px)');
  assert.equal(outgoing.frames.at(-1).clipPath, 'inset(400px 0px 0px 0px round 0px)');
  assert.equal(outgoing.frames.at(-1).opacity, 0);
  assert.deepEqual(content.animations.at(-1).frames.map(frame => frame.opacity), [0, 0, 1]);
  presentation.settle(view);
  assert.equal(previous.root.removed, true);
  assert.equal(content.style.zIndex, '');
});

test('same-size composer updates leave no unnecessary transition layer or animation', () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  const previous = presentation.captureReplacement(content);
  presentation.replace(content, { previous, vertical: true });
  assert.equal(previous.root.removed, true);
  assert.equal(content.animations.length, 0);
});

test('dictation completion uses the collapse direction even while voice mode remains open', () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  content.getBoundingClientRect = () => ({ left: 1, top: 300, width: 388, height: 472 });
  const previous = presentation.captureReplacement(content);
  content.getBoundingClientRect = () => ({ left: 1, top: 620, width: 388, height: 152 });
  presentation.replace(content, { previous, vertical: true, back: false });
  assert.equal(previous.root.style.zIndex, '2');
  assert.equal(content.animations.at(-1).options.duration, 240);
  assert.equal(previous.root.animations.at(-1).frames.at(-1).clipPath, 'inset(320px 0px 0px 0px round 0px)');
  presentation.settle(view);
  assert.equal(previous.root.removed, true);
});

test('composer-only settled capture does not freeze an unfinished invisible entrance', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  view.open = true;
  content.frozenStyle.opacity = '0';
  const incomplete = content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280 });
  const rejected = assert.rejects(incomplete.finished, /cancelled/);
  const cancel = incomplete.cancel;
  incomplete.cancel = () => { content.frozenStyle.opacity = '1'; cancel(); };
  const previous = presentation.captureReplacement(content, { settle: true });
  await rejected;
  assert.equal(previous.root.style.getPropertyValue('opacity'), '1');
  presentation.replace(content, { previous, vertical: true });
  assert.equal(previous.root.removed, true);
});

function anchoredComposerFixture() {
  const fixture = replacementFixture();
  const { view, content, input, node } = fixture;
  const editor = node({ attrs: { class: 'composer-editor' }, children: [input] });
  const voice = node({ attrs: { class: 'inline-voice' }, children: [node({ tag: 'H3' })] });
  content.children.splice(0, content.children.length, editor, voice);
  let bounds = { left: 1, top: 700, width: 388, height: 72 };
  const rail = { left: 13, top: 708, width: 364, height: 52 };
  content.frozenStyle['border-radius'] = '28px';
  content.getBoundingClientRect = () => ({ ...bounds });
  editor.getBoundingClientRect = () => ({ ...rail });
  voice.getBoundingClientRect = () => ({ left: 13, top: bounds.top + 12, width: 364, height: Math.max(0, rail.top - bounds.top - 24) });
  const setExpanded = expanded => {
    bounds = expanded ? { left: 1, top: 300, width: 388, height: 472 } : { left: 1, top: 700, width: 388, height: 72 };
    voice.hidden = !expanded;
  };
  setExpanded(false); view.open = true;
  return { ...fixture, editor, voice, rail, setExpanded };
}

test('anchored voice expansion never clones, fades or translates the live editor', async () => {
  const { view, content, editor, input, voice, rail, setExpanded } = anchoredComposerFixture();
  const presentation = createPresentations();
  input.selectionStart = 3; input.selectionEnd = 8;
  document.activeElement = input;
  editor.cloneNode = () => assert.fail('The editor subtree must never be cloned');
  input.cloneNode = () => assert.fail('There must be only one draft textarea');
  const previous = presentation.captureReplacement(content, { settle: true, anchor: '.composer-editor' });
  assert.equal(previous.root.querySelector('.composer-editor'), null);
  assert.equal(previous.root.querySelector('input'), null);
  assert.equal(previous.root.children.length, 0, 'A hidden voice pane needs no frozen controls');
  setExpanded(true);
  presentation.replace(content, { previous, vertical: true });
  const incoming = content.animations.at(-1);
  assert.deepEqual(incoming.frames, [
    { clipPath: 'inset(400px 0px 0px 0px round 28px)' },
    { clipPath: 'inset(0px 0px 0px 0px round 28px)' },
  ]);
  assert.equal(previous.root.style.clipPath, 'inset(0px 0px 64px 0px)');
  assert.equal(editor.animations.length, 0);
  assert.equal(input.animations.length, 0);
  assert.deepEqual(editor.getBoundingClientRect(), rail);
  assert.equal(input.disabled, false);
  assert.equal(input.value, '작성 중인 메모');
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 8);
  assert.deepEqual(voice.animations[0].frames, [
    { transform: 'translateY(400px)', clipPath: 'inset(0px 0px 400px 0px)' },
    { transform: 'translateY(0px)', clipPath: 'inset(0px 0px 0px 0px)' },
  ]);
  assert.ok(incoming.frames.every(frame => !('transform' in frame) && !('opacity' in frame)));
  for (const animation of previous.animations) for (const frame of animation.frames) {
    assert.ok(!Object.keys(frame).some(key => ['height', 'width', 'scale'].includes(key)));
  }
  previous.animations.forEach(animation => animation.finish());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(previous.root.removed, true);
  assert.equal(content.style.zIndex, '');
  assert.deepEqual(editor.getBoundingClientRect(), rail);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 8);
  presentation.settle(view);
});

test('anchored voice collapse preserves the old pane viewport and cannot cover the real editor', async () => {
  const { content, editor, voice, rail, setExpanded } = anchoredComposerFixture();
  const presentation = createPresentations();
  setExpanded(true); voice.scrollTop = 70;
  const previous = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  const frozenVoice = previous.root.querySelector('.inline-voice');
  assert.equal(frozenVoice.style.position, 'absolute');
  assert.equal(frozenVoice.style.height, '384px');
  assert.equal(frozenVoice.style.top, '12px');
  setExpanded(false);
  presentation.replace(content, { previous, vertical: true, back: true });
  assert.equal(content.animations.length, 0, 'The live composer stays fully painted on collapse');
  assert.equal(editor.animations.length, 0);
  assert.equal(frozenVoice.scrollTop, 70);
  assert.equal(previous.root.style.clipPath, 'inset(0px 0px 64px 0px)');
  assert.deepEqual(previous.animations[0].frames, [
    { clipPath: 'inset(0px 0px 64px 0px)', opacity: 1 },
    { clipPath: 'inset(400px 0px 64px 0px)', opacity: 0 },
  ]);
  assert.deepEqual(frozenVoice.animations[0].frames, [
    { transform: 'translateY(0px)', clipPath: 'inset(0px 0px 0px 0px)' },
    { transform: 'translateY(400px)', clipPath: 'inset(0px 0px 400px 0px)' },
  ]);
  assert.equal(voice.animations.length, 0, 'Collapse moves only the outgoing frozen voice pane');
  assert.deepEqual(editor.getBoundingClientRect(), rail);
  previous.animations.forEach(animation => animation.finish()); await Promise.resolve(); await Promise.resolve();
  assert.equal(previous.root.removed, true);
});

test('rapid voice reversal, dialog close and reduced motion release only their owned surfaces', async () => {
  const { view, content, editor, setExpanded } = anchoredComposerFixture();
  let reduced = false;
  const presentation = createPresentations({ reducedMotion: () => reduced });
  const first = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true); presentation.replace(content, { previous: first, vertical: true });
  const next = presentation.captureReplacement(content, { settle: true, anchor: '.composer-editor' });
  assert.equal(first.root.removed, true);
  setExpanded(false); presentation.replace(content, { previous: next, vertical: true, back: true });
  view.close(); view.dispatch('close');
  assert.equal(next.root.removed, true);
  assert.equal(content.style.zIndex, '');
  await Promise.resolve();
  view.showModal();
  const third = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true); reduced = true;
  presentation.replace(content, { previous: third, vertical: true });
  assert.equal(third.root.removed, true);
  assert.equal(presentation.captureReplacement(content, { anchor: '.composer-editor' }), null);
  assert.equal(editor.animations.length, 0);
});

test('a missing or zero-area anchor skips replacement instead of making a duplicate editor', () => {
  const { content, editor } = anchoredComposerFixture();
  const presentation = createPresentations();
  assert.equal(presentation.captureReplacement(content, { anchor: '.missing-editor' }), null);
  editor.cloneNode = () => assert.fail('An unsupported anchor must not be cloned');
  editor.getBoundingClientRect = () => ({ left: 13, top: 708, width: 364, height: 0 });
  assert.equal(presentation.captureReplacement(content, { anchor: '.composer-editor' }), null);
});

test('rounded voice reveals reduce the starting radius when the editor touches the reveal edge', () => {
  const { content, rail, setExpanded } = anchoredComposerFixture();
  const presentation = createPresentations();
  rail.left = 1; rail.top = 700;
  const previous = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true);
  presentation.replace(content, { previous, vertical: true });
  assert.equal(content.animations[0].frames[0].clipPath, 'inset(400px 0px 0px 0px round 0px)');
  assert.equal(content.animations[0].frames.at(-1).clipPath, 'inset(0px 0px 0px 0px round 28px)');
});

test('the voice header follows the expanding edge while the moving pane never paints over the editor', () => {
  const { content, voice, rail, setExpanded } = anchoredComposerFixture();
  const presentation = createPresentations();
  const previous = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true);
  presentation.replace(content, { previous, vertical: true });
  const surface = content.animations[0], pane = voice.animations[0];
  const insetTop = frame => Number(frame.clipPath.match(/inset\(([-\d.]+)px/)[1]);
  const insetBottom = frame => Number(frame.clipPath.match(/inset\([^ ]+ [^ ]+ ([-\d.]+)px/)[1]);
  const translate = frame => Number(frame.transform.match(/translateY\(([-\d.]+)px/)[1]);
  const between = (a, b, progress) => a + (b - a) * progress;
  const bounds = voice.getBoundingClientRect();
  for (const progress of [0, .25, .5, .75, 1]) {
    const edge = content.getBoundingClientRect().top + between(insetTop(surface.frames[0]), insetTop(surface.frames[1]), progress);
    const offset = between(translate(pane.frames[0]), translate(pane.frames[1]), progress);
    const clippedBottom = between(insetBottom(pane.frames[0]), insetBottom(pane.frames[1]), progress);
    assert.equal(bounds.top + offset - edge, 12, 'The header keeps its original inset below the moving surface edge');
    assert.ok(bounds.top + bounds.height + offset - clippedBottom <= rail.top, 'Translated voice content stays above the editor');
  }
  assert.equal(surface.options.duration, pane.options.duration);
  assert.equal(surface.options.easing, pane.options.easing);
  presentation.settle(previous.dialog);
});

test('voice pane animation ownership survives rapid reversal, dialog closure and reduced motion', async () => {
  const { view, content, voice, editor, setExpanded } = anchoredComposerFixture();
  let reduced = false;
  const presentation = createPresentations({ reducedMotion: () => reduced });
  const watch = animation => {
    const cancel = animation.cancel;
    animation.cancel = () => { animation.cancelled = true; cancel(); };
    return animation;
  };
  const opening = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true); presentation.replace(content, { previous: opening, vertical: true });
  const liveTrack = watch(voice.animations.at(-1));
  const closing = presentation.captureReplacement(content, { settle: true, anchor: '.composer-editor' });
  assert.equal(liveTrack.cancelled, true);
  setExpanded(false); presentation.replace(content, { previous: closing, vertical: true, back: true });
  const frozenTrack = watch(closing.anchor.pane.element.animations[0]);
  view.close(); view.dispatch('close');
  assert.equal(frozenTrack.cancelled, true);
  assert.equal(closing.root.removed, true);
  view.showModal();
  const next = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true); presentation.replace(content, { previous: next, vertical: true });
  const reducedTrack = watch(voice.animations.at(-1));
  reduced = true; presentation.settle(view);
  assert.equal(reducedTrack.cancelled, true);
  assert.equal(next.root.removed, true);
  assert.equal(content.style.zIndex, '');
  assert.equal(editor.animations.length, 0);
  await Promise.resolve();
});

test('cancelling a voice pane reveal releases the paired surface animation and its snapshot', async () => {
  const { content, voice, editor, setExpanded } = anchoredComposerFixture();
  const presentation = createPresentations();
  const previous = presentation.captureReplacement(content, { anchor: '.composer-editor' });
  setExpanded(true); presentation.replace(content, { previous, vertical: true });
  const surface = content.animations[0], pane = voice.animations[0];
  const rejectedSurface = assert.rejects(surface.finished, /cancelled/);
  pane.cancel(); await Promise.resolve(); await Promise.resolve();
  await rejectedSurface;
  assert.equal(previous.root.removed, true);
  assert.equal(content.style.zIndex, '');
  assert.equal(editor.animations.length, 0);
});

test('the system motion preference applies before opening even without an app preference callback', async () => {
  const { presentation } = lifecycleFixture({ matches: true });
  const view = dialog(), trigger = source();
  presentation.show(view, { source: trigger });
  assert.equal(view.open, true);
  assert.equal(view.animations.length, 0);
  await presentation.dismiss(view);
  assert.deepEqual(trigger.focused, { preventScroll: true });
});

test('enabling reduced motion settles card parts, nested pickers and outgoing content together', async () => {
  const { presentation, preference } = lifecycleFixture();
  const card = cardFixture(), picker = dialog();
  const { view: contentDialog, content } = replacementFixture();
  presentation.show(card.view, { source: card.trigger, kind: 'detail' });
  presentation.show(picker, { source: source() });
  contentDialog.open = true;
  const previous = presentation.captureReplacement(content);
  presentation.replace(content, { previous });
  preference.matches = true; preference.dispatch('change');

  for (const element of [card.view, card.title, card.art, card.reveal, picker]) assert.equal(element.animations[0].cancelled, true);
  assert.equal(card.view.dataset.cardMotion, undefined);
  assert.equal(card.view.open, true);
  assert.equal(picker.open, true);
  assert.equal(previous.root.removed, true);
  assert.equal(previous.animations.every(animation => animation.cancelled), true);
  assert.equal(content.style.zIndex, '');
  await Promise.resolve();
  assert.equal(presentation.topDialog(), picker);
  const later = dialog();
  presentation.show(later, { source: source() });
  assert.equal(later.animations.length, 0);
});

test('hiding the document finishes dismissal once and applies only a live screen refresh', async () => {
  const { presentation, document } = lifecycleFixture();
  const reading = dialog(), leaving = dialog(), trigger = source(), applied = [];
  presentation.show(reading, { source: source() });
  const entrance = reading.animations[0];
  presentation.deferUpdate(reading, () => applied.push('superseded'));
  presentation.deferUpdate(reading, () => applied.push('current'));
  presentation.show(leaving, { source: trigger });
  presentation.deferUpdate(leaving, () => applied.push('closed'));
  const closed = presentation.dismiss(leaving);
  document.hidden = true; document.dispatch('visibilitychange');

  assert.deepEqual(applied, ['current']);
  assert.equal(reading.open, true);
  assert.equal(leaving.open, false);
  assert.equal(leaving.dataset.closing, undefined);
  assert.deepEqual(trigger.focused, { preventScroll: true });
  entrance.finish(); leaving.animations.at(-1).finish();
  await closed;
  assert.equal(leaving.closeCount, 1);
  assert.deepEqual(applied, ['current']);
  document.hidden = false; document.dispatch('visibilitychange');
  assert.equal(reading.animations.length, 1);
});

test('resize releases an active card drag and cannot resume it from the old pointer', async () => {
  const { presentation, window } = lifecycleFixture();
  const { view, trigger, title } = cardFixture();
  let captured = false, released = 0;
  view.setPointerCapture = () => { captured = true; };
  view.hasPointerCapture = () => captured;
  view.releasePointerCapture = () => { captured = false; released++; };
  presentation.pullToDismiss(view, () => assert.fail('The old pointer must not dismiss after resize'));
  presentation.show(view, { source: trigger, kind: 'detail' });
  view.dispatch('pointerdown'); view.dispatch('pointermove', { clientY: 150 });
  assert.notEqual(view.style.getPropertyValue('transform'), '');
  assert.notEqual(title.style.getPropertyValue('transform'), '');
  window.dispatch('resize');
  assert.equal(released, 1);
  assert.equal(view.style.getPropertyValue('transform'), '');
  assert.equal(title.style.getPropertyValue('transform'), '');
  assert.equal(view.dataset.cardMotion, undefined);
  view.dispatch('pointermove', { clientY: 400 }); view.dispatch('pointerup', { clientY: 400 });
  assert.equal(view.style.getPropertyValue('transform'), '');
  assert.equal(view.open, true);
  await Promise.resolve();
});

test('resize settles snapshot-free replacements and uses new bounds for the next return', async () => {
  const { presentation, window } = lifecycleFixture();
  const view = dialog(); view.dataset.sheetPresentation = 'page';
  presentation.show(view, { source: source() });
  const content = { ...dialog(), closest: () => view, getAnimations() { return this.animations; } };
  presentation.replace(content);
  view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 900 });
  window.dispatch('resize');
  assert.equal(content.animations[0].cancelled, true);
  const closed = presentation.dismiss(view);
  assert.equal(view.animations.at(-1).frames.at(-1).transform, 'translateX(700px)');
  view.animations.at(-1).finish(); await closed;
});

test('a lifecycle change removes the frozen dashboard card without replaying its entrance', async () => {
  const { presentation, window } = lifecycleFixture();
  const { view, node } = replacementFixture();
  const trigger = node({ tag: 'BUTTON', attrs: { class: 'brief-card', 'data-action': 'detail', 'data-ref': 'parking' } });
  trigger.dataset = {}; trigger.isConnected = true;
  trigger.getClientRects = () => [rect]; trigger.getBoundingClientRect = () => rect;
  trigger.matches = selector => selector.includes('.brief-card'); trigger.closest = () => null;
  const hero = node();
  view.querySelector = selector => selector === '.card-detail-hero' ? hero : null;
  view.querySelectorAll = () => [];
  presentation.show(view, { source: trigger, kind: 'detail' });
  const snapshot = view.layers[0];
  assert.ok(snapshot);
  window.dispatch('resize');
  assert.equal(snapshot.removed, true);
  assert.equal(view.dataset.cardMotion, undefined);
  view.animations[0].finish(); await Promise.resolve();
  assert.equal(view.open, true);
  assert.equal(view.layers.length, 1);
});

test('a queued native close cannot clear the replacement of a reopened dialog', async () => {
  const { view, content } = replacementFixture(), presentation = createPresentations();
  presentation.show(view, { source: source() });
  const closed = presentation.dismiss(view);
  presentation.settleAll();
  presentation.show(view, { source: source() });
  const previous = presentation.captureReplacement(content);
  presentation.replace(content, { previous });
  view.dispatch('close');
  assert.equal(view.open, true);
  assert.equal(previous.root.removed, false);
  assert.equal(view.animations.at(-1).cancelled, undefined);
  await closed;
  assert.equal(view.open, true);
  presentation.settleAll();
  assert.equal(previous.root.removed, true);
});

test('app-triggered settling honors its preference and teardown drops pending work and listeners', async () => {
  let reduced = false;
  const { presentation, preference, window, document } = lifecycleFixture({ reducedMotion: () => reduced });
  const view = dialog();
  presentation.pullToDismiss(view, () => assert.fail('Destroyed gestures must not dismiss'));
  presentation.show(view, { source: source() });
  reduced = true; presentation.settleAll();
  assert.equal(view.animations[0].cancelled, true);
  reduced = false;
  const next = dialog(); presentation.show(next, { source: source() });
  presentation.deferUpdate(next, () => assert.fail('Teardown must not restore a pending page'));
  presentation.destroy();
  assert.equal(preference.listenerCount('change'), 0);
  assert.equal(window.listenerCount('resize'), 0);
  assert.equal(document.listenerCount('visibilitychange'), 0);
  assert.equal(next.animations[0].cancelled, true);
  view.dispatch('pointerdown'); view.dispatch('pointermove', { clientY: 400 }); view.dispatch('pointerup', { clientY: 400 });
  assert.equal(view.style.getPropertyValue('transform'), '');
  next.animations[0].finish();
  await Promise.resolve();
  assert.equal(next.open, true);
});
