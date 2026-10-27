import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentTransitions } from '../src/content-transition.mjs';

class Animation extends EventTarget {
  constructor(frames, options) { super(); this.frames = frames; this.options = options; this.cancellations = 0; }
  cancel() { ++this.cancellations; queueMicrotask(() => this.dispatchEvent(new Event('cancel'))); }
  finish() { queueMicrotask(() => this.dispatchEvent(new Event('finish'))); }
}
class Element extends EventTarget {
  constructor(parentElement = null) {
    super(); this.isConnected = true; this.animations = []; this.parentElement = parentElement; this.listeners = new Set();
    Object.defineProperty(this, 'inert', { value: false, writable: false });
    this.style = Object.freeze({ height: '' }); this.dataset = Object.freeze({});
  }
  addEventListener(type, listener, options) { if (type === 'focusin') this.listeners.add(listener); super.addEventListener(type, listener, options); }
  removeEventListener(type, listener, options) { if (type === 'focusin') this.listeners.delete(listener); super.removeEventListener(type, listener, options); }
  contains(element) { for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent === this) return true; return false; }
  cloneNode() { assert.fail('a switch must not duplicate content'); }
  getBoundingClientRect() { assert.fail('a switch must not measure layout'); }
  animate(frames, options) { const animation = new Animation(frames, options); this.animations.push(animation); return animation; }
}
function fixture() {
  let reduced = false;
  const content = new Element(), painted = new Map(), reads = [];
  const view = { getComputedStyle: element => { reads.push(element); return painted.get(element); } };
  const transitions = createContentTransitions({ view, reduced: () => reduced });
  return { content, transitions, view, reads, painted, reduce: () => { reduced = true; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const targets = elements => () => elements.map(element => ({ element }));

test('a selection paints once synchronously before cascading its live children without animating the host', async () => {
  const f = fixture(), children = Array.from({ length: 8 }, () => new Element(f.content));
  let updates = 0, complete = false;
  const completion = f.transitions.transition(f.content, () => { ++updates; }, { targets: content => {
    assert.equal(content, f.content); assert.equal(updates, 1); return children.map(element => ({ element }));
  } });
  completion.then(() => { complete = true; });
  assert.equal(updates, 1);
  assert.equal(f.content.animations.length, 0);
  assert.deepEqual(children.map(element => element.animations[0].options.delay), [0, 32, 64, 96, 128, 160, 180, 180]);
  for (const element of children) {
    const animation = element.animations[0];
    assert.deepEqual(animation.frames, [{ opacity: 0, translate: '0 14px', scale: '.985' }, { opacity: 1, translate: '0 0', scale: '1' }]);
    assert.deepEqual(animation.options, { duration: 440, delay: animation.options.delay, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' });
    assert.equal(element.inert, false);
    assert.equal(element.style.height, '');
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.content.listeners.size, 1);
  children[0].animations[0].finish(); await flush();
  assert.equal(complete, false, 'completion waits for the whole cascade');
  children.slice(1).forEach(element => element.animations[0].finish()); await completion; await flush();
  assert.equal(complete, true); assert.equal(updates, 1);
  assert.equal(f.content.listeners.size, 0);
  assert.equal(f.content.style.height, ''); assert.deepEqual(f.content.dataset, {});
});

test('per-item motion descriptors override common timing and entry values', async () => {
  const f = fixture(), first = new Element(f.content), second = new Element(f.content);
  const completion = f.transitions.transition(f.content, () => {}, {
    duration: 500, opacity: .2, distance: 10, scale: '.99', stagger: 40, maxDelay: 90,
    targets: () => [{ element: first }, { element: second, duration: 320, delay: 120, opacity: .6, distance: 4, scale: '1' }],
  });
  assert.deepEqual(first.animations[0].frames[0], { opacity: .2, translate: '0 10px', scale: '.99' });
  assert.equal(first.animations[0].options.duration, 500);
  assert.deepEqual(second.animations[0].frames[0], { opacity: .6, translate: '0 4px', scale: '1' });
  assert.equal(second.animations[0].options.duration, 320);
  assert.equal(second.animations[0].options.delay, 120);
  first.animations[0].finish(); second.animations[0].finish(); await completion;
});

test('duplicate targets and nested children cannot receive overlapping entrances', async () => {
  const f = fixture(), parent = new Element(f.content), nested = new Element(parent), sibling = new Element(f.content);
  const completion = f.transitions.transition(f.content, () => {}, { targets: targets([nested, sibling, parent, parent]) });
  assert.equal(nested.animations.length, 0);
  assert.equal(parent.animations.length, 1);
  assert.equal(sibling.animations.length, 1);
  assert.equal(sibling.animations[0].options.delay, 0);
  assert.equal(parent.animations[0].options.delay, 32);
  sibling.animations[0].finish(); parent.animations[0].finish(); await completion;
});

test('rapid selections continue reused DOM from its painted state and start replaced nodes fresh', async () => {
  const f = fixture(), reused = new Element(f.content), removed = new Element(f.content), replacement = new Element(f.content), selected = [];
  const firstCompletion = f.transitions.transition(f.content, () => selected.push('first'), { targets: targets([reused, removed]) });
  const oldReused = reused.animations[0], oldRemoved = removed.animations[0];
  f.painted.set(reused, { opacity: '.74', translate: '0 3px', scale: '.993' });
  f.painted.set(removed, { opacity: '.51', translate: '0 7px', scale: '.99' });
  const latestCompletion = f.transitions.transition(f.content, () => { selected.push('latest'); removed.isConnected = false; }, { targets: targets([reused, replacement]) });
  assert.deepEqual(selected, ['first', 'latest']);
  assert.deepEqual(reused.animations[1].frames[0], { opacity: '.74', translate: '0 3px', scale: '.993' });
  assert.deepEqual(replacement.animations[0].frames[0], { opacity: 0, translate: '0 14px', scale: '.985' });
  assert.equal(oldReused.cancellations, 1); assert.equal(oldRemoved.cancellations, 1);
  let complete = false; latestCompletion.then(() => { complete = true; });
  oldReused.finish(); oldRemoved.finish(); await firstCompletion; await flush();
  assert.equal(complete, false);
  assert.equal(reused.animations[1].cancellations, 0);
  reused.animations[1].finish(); await flush(); assert.equal(complete, false);
  replacement.animations[0].finish(); await latestCompletion;
  assert.deepEqual(selected, ['first', 'latest']);
  assert.equal(f.content.listeners.size, 0);
});

test('one unsupported or canceled item does not prevent the other items from entering', async () => {
  const f = fixture(), missing = new Element(f.content), throws = new Element(f.content), canceled = new Element(f.content), last = new Element(f.content);
  missing.animate = undefined; throws.animate = () => { throw new Error('unsupported'); };
  let updates = 0, complete = false;
  const completion = f.transitions.transition(f.content, () => { ++updates; }, { targets: targets([missing, throws, canceled, last]) });
  completion.then(() => { complete = true; });
  canceled.animations[0].cancel(); await flush();
  assert.equal(last.animations[0].cancellations, 0);
  assert.equal(complete, false); assert.equal(updates, 1);
  last.animations[0].finish(); await completion;
  assert.equal(f.content.listeners.size, 0);
});

test('focus inside the host exposes every item immediately and removes the focus listener', async () => {
  const f = fixture(), children = [new Element(f.content), new Element(f.content)];
  let updates = 0;
  const completion = f.transitions.transition(f.content, () => { ++updates; }, { targets: targets(children) });
  f.content.dispatchEvent(new Event('focusin')); await completion; await flush();
  for (const element of children) assert.equal(element.animations[0].cancellations, 1);
  assert.equal(f.content.listeners.size, 0); assert.equal(updates, 1);
  f.content.dispatchEvent(new Event('focusin'));
  assert.equal(updates, 1);
});

test('reset preserves connected hosts when requested and cancels detached hosts without replaying updates', async () => {
  const f = fixture(), detached = new Element(), keptChild = new Element(f.content), droppedChild = new Element(detached), selected = [];
  const kept = f.transitions.transition(f.content, () => selected.push('kept'), { targets: targets([keptChild]) });
  const dropped = f.transitions.transition(detached, () => selected.push('dropped'), { targets: targets([droppedChild]) });
  detached.isConnected = false;
  f.transitions.reset({ preserveConnected: true }); await dropped; await flush();
  assert.equal(keptChild.animations[0].cancellations, 0);
  assert.equal(droppedChild.animations[0].cancellations, 1);
  assert.equal(f.content.listeners.size, 1); assert.equal(detached.listeners.size, 0);
  f.transitions.reset(); await kept; await flush();
  assert.equal(keptChild.animations[0].cancellations, 1);
  assert.equal(f.content.listeners.size, 0);
  assert.deepEqual(selected, ['kept', 'dropped']);
});

test('old reset and focus callbacks cannot settle a replacement cascade', async () => {
  const f = fixture(), child = new Element(f.content);
  const old = f.transitions.transition(f.content, () => {}, { targets: targets([child]) });
  const oldAnimation = child.animations[0], oldFocus = [...f.content.listeners][0];
  f.transitions.reset();
  const latest = f.transitions.transition(f.content, () => {}, { targets: targets([child]) });
  const newAnimation = child.animations[1];
  oldFocus(); oldAnimation.finish(); await old; await flush();
  assert.equal(newAnimation.cancellations, 0);
  assert.equal(f.content.listeners.size, 1);
  newAnimation.finish(); await latest;
});

test('reduced motion, disconnected hosts and empty or unsupported targets still update immediately', async () => {
  for (const mode of ['reduced', 'disconnected', 'empty', 'missing', 'throws']) {
    const f = fixture(), child = new Element(f.content); let updates = 0;
    if (mode === 'reduced') f.reduce();
    if (mode === 'disconnected') f.content.isConnected = false;
    if (mode === 'missing') child.animate = undefined;
    if (mode === 'throws') child.animate = () => { throw new Error('unsupported'); };
    const completion = f.transitions.transition(f.content, () => { ++updates; }, { targets: targets(mode === 'empty' ? [] : [child]) });
    assert.equal(updates, 1, mode); assert.equal(child.animations.length, 0, mode);
    await completion; assert.equal(f.content.listeners.size, 0, mode);
  }
});

test('turning on reduced motion during a cascade settles it and applies the next choice once', async () => {
  const f = fixture(), child = new Element(f.content), selected = [];
  const previous = f.transitions.transition(f.content, () => selected.push('first'), { targets: targets([child]) });
  f.reduce();
  const latest = f.transitions.transition(f.content, () => selected.push('latest'), { targets: targets([child]) });
  await Promise.all([previous, latest]); await flush();
  assert.deepEqual(selected, ['first', 'latest']);
  assert.equal(child.animations.length, 1); assert.equal(child.animations[0].cancellations, 1);
  assert.equal(f.content.listeners.size, 0);
});

test('failed painted-state reads do not block reuse or repeat selected updates', async () => {
  const f = fixture(), child = new Element(f.content); let updates = 0;
  const first = f.transitions.transition(f.content, () => { ++updates; }, { targets: targets([child]) });
  f.view.getComputedStyle = () => { throw new Error('unavailable painted state'); };
  const latest = f.transitions.transition(f.content, () => { ++updates; }, { targets: targets([child]) });
  assert.equal(updates, 2);
  assert.deepEqual(child.animations[1].frames[0], { opacity: 0, translate: '0 14px', scale: '.985' });
  child.animations[1].finish(); await Promise.all([first, latest]);
});

test('a failed synchronous update rejects completion and cleans up the old cascade', async () => {
  const f = fixture(), child = new Element(f.content), failure = new Error('render failed');
  const previous = f.transitions.transition(f.content, () => {}, { targets: targets([child]) });
  const rejected = f.transitions.transition(f.content, () => { throw failure; });
  await assert.rejects(rejected, error => error === failure); await previous; await flush();
  assert.equal(child.animations[0].cancellations, 1);
  assert.equal(child.animations.length, 1); assert.equal(f.content.listeners.size, 0);
});
