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
  animate() { this.animationCount++; return this.animation = new AnimationStub(); }
  showModal() { this.open = true; this.openCount++; }
  close(returnValue = '') {
    if (!this.open) return;
    this.open = false; this.returnValue = returnValue; this.closeCount++;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
}

function fixture(t) {
  const preference = Object.assign(new EventTarget(), { matches: false });
  const view = Object.assign(new EventTarget(), { matchMedia: () => preference, innerWidth: 1200, innerHeight: 900 });
  const doc = Object.assign(new EventTarget(), { defaultView: view, documentElement: new ElementStub(), hidden: false });
  const main = Object.assign(new ElementStub(), { ownerDocument: doc });
  const section = new ElementStub(); main.items = [section];
  const dialog = new ElementStub();
  const motion = createMotion(main, { nav: null });
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
