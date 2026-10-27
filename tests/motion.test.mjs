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
  contains(element) {
    for (let parent = element?.parentElement; parent; parent = parent.parentElement) if (parent === this) return true;
    return false;
  }
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
  assert.equal(section.options.duration, 380, 'the first page keeps its existing lighter introduction');
  const replacement = new ElementStub(); main.items = [replacement];
  motion.render('dashboard', { clock: '09:01' });
  assert.equal(replacement.animationCount, 0);
  motion.render('features');
  assert.equal(replacement.animationCount, 1, 'a root tab starts a wave on the new visible content');
  assert.equal(main.animationCount, 0, 'the whole page never stacks a second fade over the cards');
  assert.equal(replacement.options.duration, 520);
  assert.deepEqual(replacement.frames, [{ opacity: 0, translate: '0 20px', scale: '.985' }, { opacity: 1, translate: '0 0', scale: '1' }]);
  assert.equal(replacement.classList.contains('motion-pending'), false);
});

test('background refresh and resize preserve a connected root wave without replaying it', t => {
  const { motion, main, section } = fixture(t);
  motion.render('dashboard'); motion.render('features');
  const entrance = section.animation, count = section.animationCount;
  motion.reset({ preserveScene: true });
  motion.render('features', { clock: '09:01' });
  assert.equal(section.animation, entrance);
  assert.equal(entrance.state, 'running');
  assert.equal(section.animationCount, count);
  assert.equal(main.animationCount, 0);
  assert.notEqual(main.inert, true);
});

test('a background replacement cancels detached root targets and does not replay the wave on new nodes', t => {
  const { motion, main, section } = fixture(t);
  motion.render('dashboard'); motion.render('features');
  const entrance = section.animation;
  section.isConnected = false;
  const replacement = new ElementStub(); main.items = [replacement];
  motion.render('features', { clock: '09:01' });
  assert.equal(entrance.state, 'cancelled');
  assert.equal(replacement.animationCount, 0);
  assert.equal(main.animationCount, 0);
});

test('root content cascades in document order with bounded delay and only visible independent targets', t => {
  const { motion, main } = fixture(t);
  motion.render('dashboard');
  const cards = Array.from({ length: 9 }, () => new ElementStub());
  const nested = Object.assign(new ElementStub(), { parentElement: cards[0] });
  const offscreen = new ElementStub();
  offscreen.getBoundingClientRect = () => ({ top: 700, bottom: 750, left: 0, right: 100, width: 100, height: 50 });
  main.items = [cards[0], nested, offscreen, ...cards.slice(1)];
  motion.render('features');
  assert.equal(nested.animationCount, 0, 'a child never fades and moves twice inside an animated parent');
  assert.equal(offscreen.animationCount, 0, 'scrolling later cannot reveal a delayed hidden target');
  assert.deepEqual(cards.map(card => card.options.delay), [0, 42, 84, 126, 168, 210, 252, 252, 252]);
  for (const card of cards) {
    assert.equal(card.options.duration, 520);
    assert.equal(card.options.fill, 'backwards', 'delayed cards start hidden without an initial flash');
    assert.equal(card.options.easing, 'cubic-bezier(.22, 1, .36, 1)');
  }
  assert.equal(main.animationCount, 0);
});

test('a feature filter reveals its cards independently and settles only the root wave inside its content', async t => {
  const { motion, main } = fixture(t), content = new ElementStub();
  const heading = new ElementStub(), card = Object.assign(new ElementStub(), { parentElement: content });
  content.parentElement = main; content.items = [card];
  motion.render('dashboard'); main.items = [heading, card]; motion.render('features');
  const root = card.animation, headingEntrance = heading.animation;
  let committed = 0;
  const completion = motion.switchContent(content, () => { committed++; }, { scene: 'features' });
  assert.equal(committed, 1, 'the new filter is painted before returning');
  assert.equal(root.state, 'cancelled');
  assert.equal(headingEntrance.state, 'running', 'the page heading can finish while the filter changes');
  assert.equal(content.animationCount, 0, 'the result background stays still');
  assert.deepEqual(card.frames, [{ opacity: 0, translate: '0 18px', scale: '.98' }, { opacity: 1, translate: '0 0', scale: '1' }]);
  assert.equal(card.options.duration, 460);
  assert.notEqual(content.inert, true);
  card.animation.finish(); await completion;
});

test('feature cards and custom rows cascade while headings remain lighter and offscreen cards stay visible', async t => {
  const { motion } = fixture(t), content = new ElementStub(), heading = new ElementStub();
  heading.classList.add('section-heading');
  const cards = Array.from({ length: 7 }, () => new ElementStub()), offscreen = new ElementStub();
  offscreen.getBoundingClientRect = () => ({ top: 700, bottom: 750, left: 0, right: 100, width: 100, height: 50 });
  content.items = [heading, cards[0], offscreen, ...cards.slice(1)];
  const completion = motion.switchContent(content, () => {}, { scene: 'features' });
  assert.equal(heading.frames[0].scale, '1');
  assert.equal(heading.frames[0].opacity, .25);
  assert.equal(heading.options.duration, 360);
  assert.deepEqual(cards.map(card => card.options.delay), [34, 68, 102, 136, 170, 180, 180]);
  assert.equal(offscreen.animationCount, 0);
  assert.equal(content.animationCount, 0);
  heading.animation.finish(); cards.forEach(card => card.animation.finish()); await completion;
});

test('calendar modes leave the folding grid to CSS and clarify the agenda without moving its rows', async t => {
  const { motion } = fixture(t), content = new ElementStub(), paper = new ElementStub(), toolbar = new ElementStub();
  const grid = new ElementStub(), heading = new ElementStub(), agenda = new ElementStub(), dates = Array.from({ length: 42 }, () => new ElementStub());
  const rows = Array.from({ length: 6 }, () => new ElementStub());
  content.querySelector = selector => selector === '.agenda-body' ? agenda : null;
  content.querySelectorAll = () => [paper, toolbar, grid, ...dates, heading, agenda, ...rows];
  const completion = motion.switchContent(content, () => {}, { scene: 'schedule' });
  assert.equal(content.animationCount, 0);
  assert.equal(paper.animationCount, 0);
  assert.equal(toolbar.animationCount, 0);
  assert.equal(grid.animationCount, 0);
  assert.ok(dates.every(date => date.animationCount === 0), 'date labels and selection discs never fade or scale');
  assert.equal(heading.animationCount, 0);
  assert.ok(rows.every(row => row.animationCount === 0), 'agenda rows do not fade again inside their parent');
  assert.deepEqual(agenda.frames, [{ opacity: .94, translate: '0 0px', scale: '1' }, { opacity: 1, translate: '0 0', scale: '1' }]);
  assert.equal(agenda.options.delay, 0);
  assert.equal(agenda.options.duration, 280);
  agenda.animation.finish(); await completion;
});

test('resizing preserves a connected local cascade while root navigation cancels its old targets', async t => {
  const { motion, main } = fixture(t), content = new ElementStub(), card = new ElementStub();
  content.items = [card];
  motion.render('features');
  const completion = motion.switchContent(content, () => {}, { scene: 'features' });
  const cascade = card.animation;
  motion.render('features');
  assert.equal(cascade.state, 'running');
  assert.equal(card.animation, cascade);
  main.items = [new ElementStub()]; motion.render('my');
  assert.equal(cascade.state, 'cancelled');
  await completion;
});

test('changing reduced motion settles a local entrance without repeating its immediate update', async t => {
  const { motion, preference } = fixture(t), content = new ElementStub();
  let committed = 0;
  const completion = motion.switchContent(content, () => { committed++; });
  preference.matches = true; preference.dispatchEvent(new Event('change'));
  await completion;
  assert.equal(committed, 1);
  assert.notEqual(content.inert, true);
  content.animation.dispatchEvent(new Event('finish')); await Promise.resolve();
  assert.equal(committed, 1);
});

test('calendar period changes keep the paper, toolbar and date grid stationary while results gain clarity', t => {
  const { motion, main } = fixture(t);
  const paper = new ElementStub(), viewport = new ElementStub(), grid = new ElementStub(), agenda = new ElementStub(), number = new ElementStub();
  main.items = [paper, agenda]; grid.parentElement = paper;
  main.querySelector = selector => ({ '.calendar-grid-viewport': viewport, '.calendar-grid': grid, '.agenda-body': agenda,
    '.agenda-body, .calendar-layout > section:last-child': agenda,
    '.calendar-grid [aria-pressed="true"] .calendar-date-number': number })[selector] || null;
  motion.render('schedule', { month: '2026-09', period: '2026-08-30/2026-10-03', date: '2026-09-30', calendar: 'month' });
  const initialPaperAnimations = paper.animationCount;
  motion.render('schedule', { month: '2026-10', period: '2026-09-27/2026-10-31', date: '2026-10-30', calendar: 'month' });
  assert.equal(paper.animationCount, initialPaperAnimations, 'the calendar surface never moves behind hover targets');
  assert.equal(grid.animationCount, 0, 'period motion must never override the inner grid CSS week offset');
  assert.equal(viewport.animationCount, 0);
  assert.deepEqual(agenda.frames, [{ opacity: .9 }, { opacity: 1 }]);
  assert.equal(agenda.options.duration, 260);
  assert.equal(number.animationCount, 0, 'the selected date never changes its circle size');
  motion.render('schedule', { month: '2026-09', period: '2026-08-30/2026-10-03', date: '2026-09-30', calendar: 'month' });
  assert.equal(viewport.animationCount, 0, 'reversing months must not introduce an opposite nudge');
});

test('changing a week or date never nudges the grid or agenda', t => {
  const { motion, main, preference } = fixture(t);
  const viewport = new ElementStub(), grid = new ElementStub(), agenda = new ElementStub(), number = new ElementStub();
  main.items = [];
  main.querySelector = selector => ({ '.calendar-grid-viewport': viewport, '.calendar-grid': grid, '.agenda-body': agenda,
    '.agenda-body, .calendar-layout > section:last-child': agenda,
    '.calendar-grid [aria-pressed="true"] .calendar-date-number': number })[selector] || null;
  const state = { month: '2026-10', calendar: 'week', date: '2026-10-24', period: '2026-10-18/2026-10-24' };
  motion.render('schedule', state);
  motion.render('schedule', { ...state, date: '2026-10-25', period: '2026-10-25/2026-10-31' });
  assert.equal(viewport.animationCount, 0);
  assert.equal(grid.animationCount, 0);
  const agendaAnimations = agenda.animationCount;
  motion.render('schedule', { ...state, date: '2026-10-26', period: '2026-10-25/2026-10-31' });
  assert.equal(viewport.animationCount, 0);
  assert.equal(agenda.animationCount, agendaAnimations + 1);
  assert.equal(agenda.options.duration, 260);
  assert.ok(agenda.frames.every(frame => !('translate' in frame) && !('scale' in frame)));
  assert.equal(number.animationCount, 0);
  preference.matches = true;
  motion.render('schedule', { ...state, date: '2026-10-19' });
  assert.equal(viewport.animationCount, 0, 'reduced motion changes the period immediately');
});

test('rapid schedule patches preserve the scene wave and continue result brightness without translation', t => {
  const { motion, main, section, preference } = fixture(t);
  const agenda = new ElementStub();
  main.querySelector = selector => selector === '.agenda-body' ? agenda : null;
  motion.render('dashboard'); motion.render('schedule');
  const sceneWave = section.animation;
  let patches = 0;
  motion.updateSchedule(() => { patches++; });
  const first = agenda.animation;
  assert.deepEqual(agenda.frames, [{ opacity: .9 }, { opacity: 1 }]);
  main.ownerDocument.defaultView.getComputedStyle = () => ({ opacity: '.965', translate: 'none' });
  motion.updateSchedule(() => { patches++; });
  assert.equal(first.state, 'cancelled');
  assert.deepEqual(agenda.frames, [{ opacity: .965 }, { opacity: 1 }]);
  assert.equal(sceneWave.state, 'running', 'date selection must not reset the root tab entrance');
  const count = agenda.animationCount;
  motion.updateSchedule(() => { patches++; }, { animateAgenda: false });
  assert.equal(agenda.animationCount, count, 'selecting another day in the visible week does not restart its result motion');
  preference.matches = true; preference.dispatchEvent(new Event('change'));
  motion.updateSchedule(() => { patches++; });
  assert.equal(agenda.animationCount, count);
  assert.equal(patches, 4, 'reduced motion still updates the latest date immediately');
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
  assert.equal(indicator.options.duration, 430, 'the footer selection keeps its established timing');
});

test('rapid tab changes and a clock refresh continue from the painted indicator', t => {
  const nav = Object.assign(new ElementStub(), { scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 });
  const indicator = new ElementStub();
  let x = 0;
  const selected = new ElementStub();
  selected.getBoundingClientRect = () => ({ left: x, top: 0, width: 100, height: 48 });
  nav.querySelector = selector => selector === '[aria-current="page"]' ? selected : indicator;
  const { motion, doc, main } = fixture(t, { nav });
  motion.render('dashboard');
  x = 100; motion.render('features');
  const original = indicator.animation;
  let painted = 36;
  doc.defaultView.getComputedStyle = () => ({ width: '100px', height: '48px', transform: `matrix(1, 0, 0, 1, ${painted}, 0)` });
  x = 200; motion.render('my');
  assert.equal(original.state, 'cancelled');
  assert.equal(indicator.frames[0].transform, 'matrix(1, 0, 0, 1, 36, 0) scale(1, 1)');
  const entrances = main.animationCount;
  painted = 82; motion.render('my', { clock: '09:01' });
  assert.equal(indicator.frames[0].transform, 'matrix(1, 0, 0, 1, 82, 0) scale(1, 1)');
  assert.equal(main.animationCount, entrances, 'background updates do not replay the root scene');
  assert.equal(indicator.style.transform, 'translate3d(200px, 0px, 0)');
});

test('a rapid second root navigation cancels the old wave and ignores its queued completion', async t => {
  const { motion, main, section } = fixture(t);
  motion.render('dashboard'); motion.render('features');
  const previous = section.animation;
  motion.render('my');
  const latest = section.animation, count = section.animationCount;
  assert.equal(previous.state, 'cancelled');
  assert.notEqual(latest, previous);
  previous.dispatchEvent(new Event('finish')); await Promise.resolve();
  assert.equal(latest.state, 'running');
  motion.render('my', { clock: '09:01' });
  assert.equal(section.animation, latest);
  assert.equal(section.animationCount, count, 'an old callback cannot untrack the new wave');
  assert.equal(latest.state, 'running');
  assert.equal(main.animationCount, 0);
});

test('changing reduced motion cancels the root wave and leaves later root targets immediately visible', t => {
  const { motion, main, section, preference } = fixture(t);
  motion.render('dashboard'); motion.render('features');
  const wave = section.animation;
  preference.matches = true; preference.dispatchEvent(new Event('change'));
  assert.equal(wave.state, 'cancelled');
  const replacement = new ElementStub(); main.items = [replacement];
  motion.render('my');
  assert.equal(replacement.animationCount, 0);
  assert.equal(replacement.classList.contains('motion-pending'), false);
  assert.equal(main.animationCount, 0);
});

test('in-flow choices animate occupied height and reverse without a layout jump', async t => {
  const { motion, doc } = fixture(t);
  const menu = Object.assign(new ElementStub(), { hidden: true, inert: true, matches: selector => selector === '.choice-options' });
  menu.getBoundingClientRect = () => ({ height: 254 });
  const opening = motion.disclosure(menu, true);
  assert.equal(menu.frames[0].height, '0px');
  assert.equal(menu.frames[1].height, '254px');
  doc.defaultView.getComputedStyle = () => ({ opacity: '.6', translate: '0 -1px', height: '96px' });
  const closing = motion.disclosure(menu, false);
  assert.equal(menu.frames[0].height, '96px');
  assert.equal(menu.frames[1].height, '0px');
  assert.equal(menu.inert, true);
  menu.animation.finish(); await Promise.all([opening, closing]);
  assert.equal(menu.hidden, true);
});

function titleFixture(t) {
  const { motion, preference } = fixture(t);
  const parent = { layers: [], append(layer) { this.layers.push(layer); } };
  const dialog = Object.assign(new ElementStub(), { open: true });
  const title = Object.assign(new ElementStub(), { parentElement: parent, textContent: '새 메모', offsetLeft: 52, offsetTop: 16, offsetWidth: 240, offsetHeight: 24 });
  title.closest = selector => selector === 'dialog' ? dialog : null;
  title.cloneNode = () => {
    const layer = new ElementStub(); layer.attributes = new Map([['id', 'sheet-title'], ['tabindex', '-1'], ['autofocus', '']]);
    layer.removeAttribute = name => layer.attributes.delete(name);
    layer.setAttribute = (name, value) => layer.attributes.set(name, value);
    layer.remove = () => { parent.layers = parent.layers.filter(item => item !== layer); };
    return layer;
  };
  return { motion, preference, parent, dialog, title };
}

test('page titles crossfade in the navigation direction without duplicate focus targets', async t => {
  const { motion, parent, title } = titleFixture(t);
  motion.swapTitle(title, '보관함');
  const old = parent.layers[0];
  assert.equal(old.textContent, '보관함');
  assert.equal(old.attributes.has('id'), false);
  assert.equal(old.attributes.has('tabindex'), false);
  assert.equal(old.attributes.get('aria-hidden'), 'true');
  assert.equal(old.attributes.has('inert'), true);
  assert.equal(title.frames[0].translate, '14px 0');
  old.animation.finish(); await Promise.resolve();
  assert.equal(parent.layers.length, 0);
  motion.swapTitle(title, '보관함', { back: true });
  assert.equal(title.frames[0].translate, '-14px 0');
});

test('rapid title changes, dialog close and reduced motion clean up old labels', async t => {
  const { motion, preference, parent, dialog, title } = titleFixture(t);
  motion.swapTitle(title, '보관함'); const old = parent.layers[0];
  title.textContent = '파일 가져오기'; motion.swapTitle(title, '새 메모');
  await Promise.resolve();
  assert.equal(parent.layers.length, 1);
  assert.equal(parent.layers[0].textContent, '새 메모');
  old.animation.dispatchEvent(new Event('finish'));
  assert.equal(parent.layers.length, 1, 'a stale completion cannot remove the new transition');
  dialog.close(); await Promise.resolve();
  assert.equal(parent.layers.length, 0);
  dialog.open = true; preference.matches = true;
  motion.swapTitle(title, '보관함');
  assert.equal(parent.layers.length, 0);
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

test('inline voice examples grow locally and reverse from their painted height', async t => {
  const { motion, dialog, doc } = fixture(t);
  const list = Object.assign(new ElementStub(), { hidden: true, inert: true, parentElement: dialog });
  list.getBoundingClientRect = () => ({ height: 96 });
  doc.defaultView.getComputedStyle = () => ({ height: '36px', opacity: '.6', translate: '0 -1px' });
  const opening = motion.disclosure(list, true, { inFlow: true }), first = list.animation;
  assert.equal(list.frames[0].height, '0px');
  assert.equal(list.frames.at(-1).height, '96px');
  const closing = motion.disclosure(list, false, { inFlow: true }), second = list.animation;
  assert.equal(list.frames[0].height, '36px');
  assert.equal(list.frames.at(-1).height, '0px');
  const reopening = motion.disclosure(list, true, { inFlow: true });
  assert.equal(list.frames[0].height, '36px');
  await Promise.all([opening, closing]);
  first.dispatchEvent(new Event('finish')); second.dispatchEvent(new Event('finish'));
  await Promise.resolve();
  assert.equal(list.hidden, false);
  assert.equal(list.inert, false);
  assert.equal(dialog.animationCount, 0, 'expanding examples never re-presents the voice panel');
  list.animation.finish(); await reopening;
});

test('inline examples close immediately when reduced motion interrupts their height transition', async t => {
  const { motion, preference } = fixture(t);
  const list = Object.assign(new ElementStub(), { hidden: false, inert: false });
  const closing = motion.disclosure(list, false, { inFlow: true });
  assert.equal(list.hidden, false);
  preference.matches = true; preference.dispatchEvent(new Event('change'));
  await closing;
  assert.equal(list.hidden, true);
  assert.equal(list.inert, true);
  await motion.disclosure(list, true, { inFlow: true });
  assert.equal(list.hidden, false);
  assert.equal(list.inert, false);
  assert.equal(list.animationCount, 1);
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
  assert.deepEqual(results.frames, [{ opacity: .85, translate: '0 2px' }, { opacity: 1, translate: '0 0' }]);
  assert.equal(routeAnimation.state, 'running', 'search updates do not reset unrelated entrance motion');
  preference.matches = true;
  const reducedResults = new ElementStub();
  motion.result(reducedResults);
  assert.equal(reducedResults.animationCount, 0);
});

test('rapid search updates continue from the painted results and ignore old animation callbacks', async t => {
  const { motion, doc, preference } = fixture(t), results = new ElementStub();
  const first = motion.result(results);
  let painted = { opacity: '.94', translate: '0 .8px' };
  doc.defaultView.getComputedStyle = element => { assert.equal(element, results); return painted; };
  const second = motion.result(results);
  assert.equal(first.state, 'cancelled');
  assert.deepEqual(results.frames[0], painted);
  assert.equal(second.state, 'running');
  first.dispatchEvent(new Event('finish')); await Promise.resolve();
  painted = { opacity: '.98', translate: 'none' };
  const latest = motion.result(results);
  assert.deepEqual(results.frames[0], { opacity: '.98', translate: '0 0' });
  assert.equal(second.state, 'cancelled');
  assert.equal(latest.state, 'running');
  assert.equal(results.options.duration, 160);
  preference.matches = true; preference.dispatchEvent(new Event('change'));
  assert.equal(latest.state, 'cancelled');
  motion.result(results);
  assert.equal(results.animationCount, 3, 'reduced motion cannot start another result entrance');
});

test('search rendering uses a visible result entrance and tolerates unavailable painted styles', t => {
  const { motion, main, doc } = fixture(t), results = new ElementStub();
  main.querySelector = selector => selector === '.conversation-groups' ? results : null;
  motion.render('conversations', { search: '' });
  motion.render('conversations', { search: '회의' });
  assert.deepEqual(results.frames[0], { opacity: .85, translate: '0 2px' });
  const previous = results.animation;
  doc.defaultView.getComputedStyle = () => { throw new Error('unavailable painted style'); };
  assert.doesNotThrow(() => motion.result(results));
  assert.equal(previous.state, 'cancelled');
  assert.deepEqual(results.frames[0], { opacity: .85, translate: '0 2px' });
});

test('calendar resize finishes the shared fold progress and legacy geometry transitions only', async t => {
  const { motion, main, section } = fixture(t), viewport = new ElementStub(), grid = new ElementStub();
  main.querySelector = selector => selector === '.calendar-grid-viewport' ? viewport : null;
  viewport.querySelector = selector => selector === '.calendar-grid' ? grid : null;
  const height = Object.assign(new AnimationStub(), { transitionProperty: 'height' });
  const fold = Object.assign(new AnimationStub(), { transitionProperty: '--calendar-fold' });
  const translate = Object.assign(new AnimationStub(), { transitionProperty: 'translate' });
  const opacity = Object.assign(new AnimationStub(), { transitionProperty: 'opacity' });
  const gridHeight = Object.assign(new AnimationStub(), { transitionProperty: 'height' });
  const viewportTranslate = Object.assign(new AnimationStub(), { transitionProperty: 'translate' });
  const viewportWaapi = new AnimationStub(), gridWaapi = new AnimationStub(), options = [];
  viewport.getAnimations = value => { options.push(value); return [fold, height, opacity, viewportTranslate, viewportWaapi]; };
  grid.getAnimations = value => { options.push(value); return [translate, gridHeight, gridWaapi]; };
  motion.render('dashboard'); motion.render('schedule');
  const rootWave = section.animation;
  const local = new ElementStub();
  const localCompletion = motion.switchContent(local, () => {});
  const localEntrance = local.animation;
  assert.equal(motion.settleCalendarLayout(), 3);
  assert.deepEqual(options, [{ subtree: false }, { subtree: false }]);
  assert.equal(fold.state, 'finished'); assert.equal(height.state, 'finished'); assert.equal(translate.state, 'finished');
  for (const animation of [opacity, gridHeight, viewportTranslate, viewportWaapi, gridWaapi, rootWave, localEntrance]) {
    assert.equal(animation.state, 'running', 'resizing must not settle unrelated CSS, root waves or local entrances');
  }
  localEntrance.finish(); await localCompletion;
});

test('calendar resize handles absent animation inspection and inactive CSS timelines without resetting motion', t => {
  const { motion, main, section } = fixture(t);
  motion.render('dashboard'); motion.render('features');
  const rootWave = section.animation;
  assert.equal(motion.settleCalendarLayout(), 0, 'other pages need no calendar work');
  const viewport = new ElementStub(), grid = new ElementStub();
  main.querySelector = selector => selector === '.calendar-grid-viewport' ? viewport : null;
  viewport.querySelector = () => grid;
  viewport.getAnimations = () => { throw new Error('unsupported animation inspection'); };
  grid.getAnimations = () => [{ transitionProperty: 'translate', finish() { throw new Error('inactive timeline'); } }];
  assert.equal(motion.settleCalendarLayout(), 0);
  assert.equal(rootWave.state, 'running');
});

test('resize retargets the footer indicator to its new geometry while preserving the running root wave', t => {
  const nav = Object.assign(new ElementStub(), { scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 });
  const indicator = new ElementStub(), selected = new ElementStub();
  let x = 0, width = 100, height = 48;
  selected.getBoundingClientRect = () => ({ left: x, top: 0, width, height });
  nav.querySelector = selector => selector === '[aria-current="page"]' ? selected : indicator;
  const { motion, main, section, doc } = fixture(t, { nav });
  motion.render('dashboard'); x = 100; motion.render('features');
  const previousIndicator = indicator.animation, rootWave = section.animation, entrances = section.animationCount;
  doc.defaultView.getComputedStyle = element => {
    assert.equal(element, indicator);
    return { width: '100px', height: '48px', transform: 'matrix(1, 0, 0, 1, 35, 0)' };
  };
  x = 140; width = 120; height = 50;
  assert.equal(motion.resize(), 0);
  assert.equal(indicator.style.width, '120px');
  assert.equal(indicator.style.height, '50px');
  assert.equal(indicator.style.transform, 'translate3d(140px, 0px, 0)');
  assert.equal(indicator.frames[0].transform, `matrix(1, 0, 0, 1, 35, 0) scale(${100 / 120}, ${48 / 50})`);
  assert.equal(previousIndicator.state, 'cancelled');
  assert.equal(section.animation, rootWave);
  assert.equal(rootWave.state, 'running');
  assert.equal(section.animationCount, entrances);
  assert.equal(main.animationCount, 0);
});
