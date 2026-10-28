import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceField, setChoice, choiceMenuGeometry, installChoices } from '../src/choice-field.mjs';

test('choice markup keeps the named form value and exposes a top-layer listbox', () => {
  const html = choiceField('반복', 'repeat', '평일', ['필요할 때', '매일', '평일', '한 번']);
  assert.match(html, /type="hidden" name="repeat" value="평일"/);
  assert.match(html, /role="listbox"[^>]*popover="auto" hidden/);
  assert.match(html, /aria-haspopup="listbox"/);
  const escaped = choiceField('종류', 'kind', 'x', [{ value: 'x', label: '<img onerror=bad>' }]);
  assert.doesNotMatch(escaped, /<img/);
});

test('menu placement respects narrow screens, visual viewport offsets and available space', () => {
  const nearBottom = choiceMenuGeometry({ left: 176, top: 430, bottom: 482, width: 124 }, { width: 320, height: 568 }, 216);
  assert.equal(nearBottom.placement, 'top');
  assert.ok(nearBottom.left >= 12 && nearBottom.left + nearBottom.width <= 308);
  assert.ok(nearBottom.top + 216 <= 430 - 8);
  const shifted = choiceMenuGeometry({ left: 22, top: 120, bottom: 172, width: 350 }, { left: 10, top: 80, width: 390, height: 430 }, 216);
  assert.equal(shifted.placement, 'bottom'); assert.equal(shifted.width, 320);
  assert.ok(shifted.top >= 92 && shifted.top + Math.min(216, shifted.maxHeight) <= 498);
  const crowded = choiceMenuGeometry({ left: 12, top: 180, bottom: 232, width: 500 }, { width: 320, height: 340 }, 600);
  assert.equal(crowded.width, 296);
  assert.ok(crowded.top >= 12 && crowded.maxHeight < 600);
});

function fixture({ native = true, rect = { left: 184, top: 400, bottom: 452, right: 358, width: 174, height: 52 } } = {}) {
  const listeners = new Map(), viewListeners = new Map(), observers = [], events = [], frames = new Map();
  let nextFrame = 0, focused = null;
  const attributes = new Map([['aria-expanded', 'false']]), owner = { open: true };
  const trigger = { isConnected: true, disabled: false, getBoundingClientRect: () => rect,
    getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value),
    focus(options) { focused = this; this.focusOptions = options; },
    closest: selector => selector === '[data-choice]' ? field : selector === '.choice-trigger' ? trigger : null };
  const input = { value: '평일', dispatchEvent: event => events.push(event.type) }, display = { textContent: '평일' };
  const options = ['필요할 때', '매일', '평일', '한 번'].map((value, index) => ({
    offsetTop: index * 48, offsetHeight: 48,
    dataset: { choiceOption: value }, selected: value === input.value,
    setAttribute(_name, value) { this.selected = value === 'true'; }, querySelector: () => ({ textContent: value }),
    focus(options) { focused = this; this.focusOptions = options; },
    closest: selector => selector === '[data-choice]' ? field : selector === '[data-choice-option]' ? options.find(option => option.dataset.choiceOption === value) : null,
  }));
  const menuListeners = new Map();
  const menu = { hidden: true, style: {}, dataset: {}, scrollHeight: 216, clientHeight: 160, scrollTop: 0, popoverOpen: false, shown: 0, hides: 0, attributes: new Map([['popover', 'auto']]),
    addEventListener: (type, fn) => menuListeners.set(type, fn), removeEventListener: type => menuListeners.delete(type),
    removeAttribute(name) { this.attributes.delete(name); }, matches: () => menu.popoverOpen,
    contains: target => target === menu || options.includes(target), querySelector: () => options[0],
  };
  const lightDismiss = () => { menuListeners.get('beforetoggle')?.({ newState: 'closed' }); menu.popoverOpen = false; };
  if (native) {
    menu.showPopover = () => { menu.popoverOpen = true; ++menu.shown; };
    menu.hidePopover = () => { ++menu.hides; lightDismiss(); };
  }
  const field = { isConnected: true, closest: () => owner,
    querySelector: selector => ({ '.choice-trigger': trigger, '[role=listbox]': menu, input, '[data-choice-value]': display,
      '[aria-selected=true]': options.find(option => option.selected) })[selector],
    querySelectorAll: () => options,
  };
  const view = { innerWidth: 390, innerHeight: 600,
    addEventListener: (type, fn) => viewListeners.set(type, fn), removeEventListener: type => viewListeners.delete(type),
    requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class { constructor(fn) { this.callback = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
  };
  const root = { defaultView: view, body: {}, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const controller = installChoices(root);
  const fire = (type, target, key) => {
    const event = { target, key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    listeners.get(type)?.(event); return event;
  };
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  return { controller, root, view, viewListeners, field, owner, trigger, menu, input, display, options, events,
    observers, fire, lightDismiss, flushFrames, focused: () => focused };
}

for (const native of [true, false]) test(`${native ? 'native popover' : 'fixed fallback'} selection does not mutate the value before an option is chosen`, () => {
  const f = fixture({ native });
  f.fire('click', f.trigger);
  assert.equal(f.menu.hidden, false); assert.equal(f.menu.style.position, 'fixed');
  assert.equal(f.menu.style.width, '220px'); assert.equal(f.menu.dataset.placement, 'top');
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(f.focused(), f.options[2]); assert.equal(f.input.value, '평일'); assert.deepEqual(f.events, []);
  assert.equal(f.menu.scrollTop, 40, 'the chosen option is revealed only within the menu');
  if (native) assert.equal(f.menu.shown, 1); else assert.equal(f.menu.attributes.has('popover'), false);
  f.fire('click', f.options[1]);
  assert.equal(f.input.value, '매일'); assert.equal(f.display.textContent, '매일');
  assert.deepEqual(f.events, ['change']); assert.equal(f.menu.hidden, true);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false'); assert.equal(f.focused(), f.trigger);
  assert.equal(f.options.filter(option => option.selected).length, 1);
});

test('Escape cancels only the menu, while arrows navigate without committing and Tab can leave the field', () => {
  const f = fixture();
  f.fire('keydown', f.trigger, 'ArrowDown');
  f.fire('keydown', f.options[2], 'End'); assert.equal(f.focused(), f.options[3]);
  f.fire('keydown', f.options[3], 'ArrowDown'); assert.equal(f.focused(), f.options[0]);
  f.fire('keydown', f.options[0], 'Home'); assert.equal(f.focused(), f.options[0]);
  const escape = f.fire('keydown', f.options[0], 'Escape');
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true);
  assert.equal(f.owner.open, true); assert.equal(f.menu.hidden, true); assert.equal(f.input.value, '평일');
  f.fire('click', f.trigger); const tab = f.fire('keydown', f.options[2], 'Tab');
  assert.equal(tab.prevented, false); assert.equal(f.menu.hidden, true); assert.equal(f.focused(), f.trigger);
});

test('native light dismissal updates ARIA without recursively hiding and re-clicking the trigger stays closed', () => {
  const f = fixture(); f.fire('click', f.trigger);
  f.fire('pointerdown', f.trigger); f.lightDismiss();
  assert.equal(f.menu.hides, 0); assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  f.fire('click', f.trigger);
  assert.equal(f.menu.hidden, true); assert.equal(f.menu.shown, 1);
  f.fire('pointerdown', f.trigger); f.fire('click', f.trigger);
  assert.equal(f.menu.hidden, false); assert.equal(f.menu.shown, 2);
  f.fire('click', { closest: () => null });
  assert.equal(f.menu.hidden, true); assert.deepEqual(f.events, []);
});

test('scrolling repositions the menu and removed forms or closed owners release it', () => {
  const rect = { left: 184, top: 400, bottom: 452, right: 358, width: 174, height: 52 }, f = fixture({ rect });
  f.fire('click', f.trigger); const firstTop = f.menu.style.top;
  rect.top -= 100; rect.bottom -= 100; f.fire('scroll', f.root); f.flushFrames();
  assert.notEqual(f.menu.style.top, firstTop);
  f.field.isConnected = false; f.observers[0].callback();
  assert.equal(f.menu.hidden, true); assert.equal(f.observers[0].disconnected, true);
  f.field.isConnected = true; f.fire('click', f.trigger);
  f.owner.open = false; f.fire('close', f.owner);
  assert.equal(f.menu.hidden, true);
  f.controller.destroy(); assert.equal(f.viewListeners.size, 0);
});

test('programmatic choice changes update the visible label and selection without changing popup state or emitting edits', () => {
  const f = fixture(); setChoice(f.field, '필요할 때');
  assert.equal(f.input.value, '필요할 때'); assert.equal(f.display.textContent, '필요할 때');
  assert.equal(f.menu.hidden, true); assert.deepEqual(f.events, []);
  setChoice(f.field, 'unknown'); assert.equal(f.input.value, '필요할 때');
});
