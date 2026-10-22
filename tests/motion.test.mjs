import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion } from '../src/motion.mjs';

// Native dialog/WAAPI events are queued: synchronous stubs hide reopen races.
class AnimationStub extends EventTarget {
  constructor() { super(); this.state = 'running'; }
  cancel() {
    if (this.state !== 'running') return;
    this.state = 'cancelled';
    queueMicrotask(() => this.dispatchEvent(new Event('cancel')));
  }
  finish() {
    if (this.state !== 'running') return;
    this.state = 'finished';
    queueMicrotask(() => this.dispatchEvent(new Event('finish')));
  }
}

class ElementStub extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { isConnected: true, style: {}, dataset: {}, items: [], parentElement: null, open: false, openCount: 0, closeCount: 0, animationCount: 0 });
    const classes = new Set();
    this.classList = { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value) };
  }
  querySelector() { return null; }
  querySelectorAll(selector) { return selector === '.motion-pending' ? this.items.filter(item => item.classList.contains('motion-pending')) : this.items; }
  contains(element) { return element.parentElement === this; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600 }; }
  animate(frames, options) { this.animationCount++; this.frames = frames; this.options = options; return this.animation = new AnimationStub(); }
  showModal() { this.open = true; this.openCount++; }
  close(returnValue = '') {
    if (!this.open) return;
    this.open = false; this.returnValue = returnValue; this.closeCount++;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
}

function fixture(t, { nav = null } = {}) {
  const preference = Object.assign(new EventTarget(), { matches: false });
  const view = Object.assign(new EventTarget(), { matchMedia: () => preference, innerWidth: 1200, innerHeight: 900 });
  const doc = Object.assign(new EventTarget(), { defaultView: view, documentElement: new ElementStub(), hidden: false });
  const main = Object.assign(new ElementStub(), { ownerDocument: doc });
  const section = new ElementStub(); main.items = [section];
  const dialog = new ElementStub();
  const motion = createMotion(main, { nav });
  t.after(() => motion.destroy());
  return { motion, main, section, dialog, preference, doc };
}

test('clock refresh and replaced dashboard nodes do not replay route entrance', t => {
  const { motion, main, section } = fixture(t);
  motion.render('dashboard', { clock: '09:00' });
  assert.equal(section.animationCount, 1);
  const replacement = new ElementStub(); main.items = [replacement];
  motion.render('dashboard', { clock: '09:01' });
  assert.equal(replacement.animationCount, 0);
  motion.render('features');
  assert.equal(replacement.animationCount, 1);
  assert.equal(replacement.classList.contains('motion-pending'), false);
});

for (const source of ['system', 'application']) {
  test(`${source} reduced motion preserves dialog open and dismiss behavior`, async t => {
    const { motion, main, section, dialog, preference, doc } = fixture(t);
    if (source === 'system') preference.matches = true;
    else doc.documentElement.classList.add('reduce-motion');
    motion.render('dashboard');
    assert.equal(section.animationCount, 0);
    motion.openDialog(dialog);
    assert.equal(dialog.open, true);
    assert.equal(dialog.animationCount, 0);
    await motion.closeDialog(dialog, { returnValue: 'saved' });
    assert.equal(dialog.open, false);
    assert.equal(dialog.returnValue, 'saved');
    motion.openDialog(dialog);
    assert.equal(dialog.open, true);
    assert.equal(main.items.some(item => item.classList.contains('motion-pending')), false);
  });
}

test('dismissal resolves after its animation and preserves the return value', async t => {
  const { motion, dialog } = fixture(t);
  motion.openDialog(dialog);
  const openedAnimations = dialog.animationCount;
  motion.openDialog(dialog);
  assert.equal(dialog.animationCount, openedAnimations, 'updating an open sheet does not replay its entrance');
  const dismissal = motion.closeDialog(dialog, { returnValue: 'done' });
  assert.equal(dialog.open, true);
  assert.equal(motion.closeDialog(dialog), dismissal, 'repeated dismissals share completion');
  dialog.animation.finish();
  await dismissal;
  assert.equal(dialog.open, false);
  assert.equal(dialog.returnValue, 'done');
});

for (const interruption of ['cancel', 'reset']) {
  test(`${interruption} during dismissal releases modal focus and resolves`, async t => {
    const { motion, dialog } = fixture(t);
    motion.openDialog(dialog);
    const dismissal = motion.closeDialog(dialog);
    if (interruption === 'cancel') dialog.animation.cancel();
    else motion.reset();
    await dismissal;
    assert.equal(dialog.open, false);
    assert.equal(dialog.closeCount, 1);
  });
}

test('reopening during dismissal ignores queued close and stale animation events', async t => {
  const { motion, dialog } = fixture(t);
  motion.openDialog(dialog);
  const dismissal = motion.closeDialog(dialog);
  const oldExit = dialog.animation;
  motion.openDialog(dialog);
  await dismissal;
  await Promise.resolve();
  assert.equal(dialog.open, true);
  assert.equal(dialog.openCount, 2);
  assert.equal(dialog.closeCount, 1);
  oldExit.dispatchEvent(new Event('finish'));
  await Promise.resolve();
  assert.equal(dialog.open, true, 'stale exit completion cannot dismiss the reopened modal');
  assert.equal(dialog.animation.state, 'running', 'queued native close cannot cancel the new entrance');
});

test('navigation indicator adopts final geometry and animates transforms only', t => {
  const nav = Object.assign(new ElementStub(), { scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 });
  const indicator = new ElementStub();
  const first = new ElementStub(), second = new ElementStub();
  first.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 44 });
  second.getBoundingClientRect = () => ({ left: 120, top: 0, width: 96, height: 48 });
  let selected = first;
  nav.querySelector = selector => selector === '[aria-current="page"]' ? selected : indicator;
  const { motion } = fixture(t, { nav });
  motion.render('dashboard');
  selected = second;
  motion.render('features');
  assert.equal(indicator.style.width, '96px');
  assert.equal(indicator.style.height, '48px');
  assert.equal(indicator.style.transformOrigin, '0 0');
  assert.equal(indicator.style.transform, 'translate3d(120px, 0px, 0)');
  assert.deepEqual(indicator.frames.map(frame => Object.keys(frame)), [['transform'], ['transform']]);
  assert.equal(indicator.frames[0].transform, `translate3d(0px, 0px, 0) scale(1.25, ${44 / 48})`);
  assert.equal(indicator.frames[1].transform, 'translate3d(120px, 0px, 0) scale(1, 1)');
});

test('disclosure makes opening focusable immediately and hides only after exit', async t => {
  const { motion } = fixture(t);
  const menu = Object.assign(new ElementStub(), { hidden: true, inert: true });
  const opening = motion.disclosure(menu, true);
  assert.equal(menu.hidden, false);
  assert.equal(menu.inert, false);
  assert.equal(menu.options.duration, 160);
  assert.equal(motion.disclosure(menu, true), opening);
  menu.animation.finish();
  await opening;
  const closing = motion.disclosure(menu, false);
  assert.equal(menu.hidden, false, 'exit remains painted until completion');
  assert.equal(menu.inert, true, 'closing content cannot take focus');
  assert.equal(menu.options.duration, 120);
  assert.equal(motion.disclosure(menu, false), closing);
  menu.animation.finish();
  await closing;
  assert.equal(menu.hidden, true);
  assert.equal(menu.inert, true);
});

test('autofocus preserves disclosure entrance while settling generic ancestor motion', async t => {
  const { motion, main, section } = fixture(t);
  section.parentElement = main;
  motion.render('dashboard');
  const routeAnimation = section.animation;
  const menu = Object.assign(new ElementStub(), { hidden: true, inert: true, parentElement: section });
  const option = Object.assign(new ElementStub(), { parentElement: menu });
  const opening = motion.disclosure(menu, true), entrance = menu.animation;
  const focus = new Event('focusin');
  Object.defineProperty(focus, 'target', { value: option });
  main.dispatchEvent(focus);
  await Promise.resolve();
  assert.equal(entrance.state, 'running', 'required menu autofocus does not consume its entrance');
  assert.equal(routeAnimation.state, 'cancelled', 'generic ancestor motion still settles for keyboard access');
  assert.equal(menu.hidden, false);
  assert.equal(menu.inert, false);
  entrance.finish();
  await opening;
});

test('rapid disclosure reversal ignores queued cancel and stale finish events', async t => {
  const { motion, doc } = fixture(t);
  doc.defaultView.getComputedStyle = () => ({ opacity: '0.4', translate: '0 -2px' });
  const menu = Object.assign(new ElementStub(), { hidden: true, inert: true });
  const opening = motion.disclosure(menu, true), entrance = menu.animation;
  const closing = motion.disclosure(menu, false), exit = menu.animation;
  const reopening = motion.disclosure(menu, true), latest = menu.animation;
  assert.deepEqual(menu.frames[0], { opacity: '0.4', translate: '0 -2px' }, 'reversal continues from the painted state');
  await Promise.all([opening, closing]);
  entrance.dispatchEvent(new Event('finish'));
  exit.dispatchEvent(new Event('finish'));
  await Promise.resolve();
  assert.equal(menu.hidden, false);
  assert.equal(menu.inert, false);
  assert.equal(latest.state, 'running');
  latest.finish();
  await reopening;
  assert.equal(menu.hidden, false);
});

test('reset settles disclosure to its last requested state without stale completion', async t => {
  const { motion } = fixture(t);
  const menu = Object.assign(new ElementStub(), { hidden: true, inert: true });
  const opening = motion.disclosure(menu, true), entrance = menu.animation;
  motion.reset();
  await opening;
  assert.equal(menu.hidden, false);
  assert.equal(menu.inert, false);
  const closing = motion.disclosure(menu, false), exit = menu.animation;
  motion.reset();
  await closing;
  assert.equal(menu.hidden, true);
  assert.equal(menu.inert, true);
  entrance.dispatchEvent(new Event('finish'));
  exit.dispatchEvent(new Event('finish'));
  await Promise.resolve();
  assert.equal(menu.hidden, true);
});

test('changing motion preference during exit completes disclosure immediately', async t => {
  const { motion, preference } = fixture(t);
  const menu = Object.assign(new ElementStub(), { hidden: false, inert: false });
  const closing = motion.disclosure(menu, false);
  preference.matches = true;
  preference.dispatchEvent(new Event('change'));
  assert.equal(menu.hidden, true);
  assert.equal(menu.inert, true);
  await closing;
});

for (const source of ['system', 'application']) {
  test(`${source} reduced motion applies disclosure state synchronously`, async t => {
    const { motion, preference, doc } = fixture(t);
    if (source === 'system') preference.matches = true;
    else doc.documentElement.classList.add('reduce-motion');
    const menu = Object.assign(new ElementStub(), { hidden: true, inert: true });
    const opening = motion.disclosure(menu, true);
    assert.equal(menu.hidden, false);
    assert.equal(menu.inert, false);
    await opening;
    const closing = motion.disclosure(menu, false);
    assert.equal(menu.hidden, true);
    assert.equal(menu.inert, true);
    await closing;
    assert.equal(menu.animationCount, 0);
  });
}

test('search result motion stays local and respects reduced motion', t => {
  const { motion, section, preference } = fixture(t);
  motion.render('conversations');
  const routeAnimation = section.animation;
  const results = new ElementStub();
  motion.result(results);
  assert.equal(results.options.duration, 160);
  assert.equal(results.frames[0].translate, '0 3px');
  assert.equal(routeAnimation.state, 'running', 'search updates do not reset unrelated entrance motion');
  preference.matches = true;
  const reducedResults = new ElementStub();
  motion.result(reducedResults);
  assert.equal(reducedResults.animationCount, 0);
});
