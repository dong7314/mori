import { esc } from './experience.mjs';

// Options stay next to their input in the DOM, but render in the top layer so
// choosing a value never changes the height or scroll position of the form.
export function choiceField(label, name, value, options) {
  const items = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  const selected = items.find(option => String(option.value) === String(value)) || items[0];
  return `<div class="field choice-field" data-choice>
    <span id="label-${name}">${esc(label)}</span>
    <input type="hidden" name="${name}" value="${esc(selected.value)}">
    <button type="button" class="choice-trigger" aria-labelledby="label-${name} value-${name}" aria-haspopup="listbox" aria-expanded="false" aria-controls="options-${name}">
      <span id="value-${name}" data-choice-value>${esc(selected.label)}</span><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>
    </button>
    <div class="choice-options" id="options-${name}" role="listbox" aria-labelledby="label-${name}" popover="auto" hidden>
      ${items.map(option => `<button type="button" role="option" tabindex="-1" aria-selected="${String(option.value) === String(selected.value)}" data-choice-option="${esc(option.value)}"><span>${esc(option.label)}</span><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg></button>`).join('')}
    </div>
  </div>`;
}

export function setChoice(field, value) {
  if (!field) return;
  const option = [...field.querySelectorAll('[role=option]')].find(option => option.dataset.choiceOption === String(value));
  if (!option) return;
  field.querySelector('input').value = value;
  field.querySelector('[data-choice-value]').textContent = option.querySelector('span').textContent;
  field.querySelectorAll('[role=option]').forEach(item => item.setAttribute('aria-selected', String(item === option)));
}

export function choiceMenuGeometry(anchor, viewport, contentHeight) {
  const margin = 12, gap = 8;
  const leftEdge = (viewport.left || 0) + margin, topEdge = (viewport.top || 0) + margin;
  const rightEdge = (viewport.left || 0) + viewport.width - margin;
  const bottomEdge = (viewport.top || 0) + viewport.height - margin;
  const width = Math.max(0, Math.min(Math.max(anchor.width, 220), 320, viewport.width - margin * 2));
  const below = Math.max(0, bottomEdge - anchor.bottom - gap), above = Math.max(0, anchor.top - topEdge - gap);
  const desired = Math.min(contentHeight, 320);
  const placement = below >= desired || below >= above ? 'bottom' : 'top';
  const maxHeight = placement === 'bottom' ? below : above;
  const height = Math.min(desired, maxHeight);
  return { width, left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)),
    top: placement === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height,
    maxHeight: Math.min(320, maxHeight), placement };
}

export function installChoices(root = document) {
  const doc = root.ownerDocument || root, view = doc.defaultView;
  let active = null, frame = 0, triggerWasOpen = null;
  const focusOption = (menu, option, center = false) => {
    if (!option) return;
    // Keep keyboard navigation inside the menu's scroll container.
    if (menu.clientHeight) {
      if (center) menu.scrollTop = Math.max(0, option.offsetTop - (menu.clientHeight - option.offsetHeight) / 2);
      else if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
        menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
    option.focus({ preventScroll: true });
  };
  const close = (focus = false, nativeClosing = false) => {
    if (!active) return;
    const state = active; active = null;
    if (frame) { view.cancelAnimationFrame(frame); frame = 0; }
    state.observer?.disconnect();
    state.menu.removeEventListener('beforetoggle', state.onToggle);
    if (state.native && !nativeClosing && state.menu.matches(':popover-open')) state.menu.hidePopover();
    state.menu.hidden = true; delete state.menu.dataset.choiceOpen;
    state.trigger.setAttribute('aria-expanded', 'false');
    if (focus && state.trigger.isConnected && (!state.owner || state.owner.open)) state.trigger.focus({ preventScroll: true });
  };
  const position = () => {
    if (!active) return;
    const { field, trigger, menu, owner } = active;
    if (!field.isConnected || !trigger.isConnected || owner && !owner.open) return close();
    const rect = trigger.getBoundingClientRect(), visual = view.visualViewport;
    const viewport = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
      width: visual?.width || view.innerWidth, height: visual?.height || view.innerHeight };
    if (!rect.width || !rect.height || rect.bottom <= viewport.top || rect.top >= viewport.top + viewport.height ||
        rect.right <= viewport.left || rect.left >= viewport.left + viewport.width) return close();
    menu.style.width = `${choiceMenuGeometry(rect, viewport, 0).width}px`;
    const geometry = choiceMenuGeometry(rect, viewport, menu.scrollHeight || 240);
    Object.assign(menu.style, { position: 'fixed', inset: 'auto', margin: '0', width: `${geometry.width}px`,
      left: `${geometry.left}px`, top: `${geometry.top}px`, maxHeight: `${geometry.maxHeight}px`, overflowY: 'auto' });
    menu.dataset.placement = geometry.placement;
  };
  const queuePosition = event => {
    if (!active || event?.target && active.menu.contains(event.target) || frame) return;
    frame = view.requestAnimationFrame(() => { frame = 0; position(); });
  };
  const open = field => {
    close();
    const trigger = field.querySelector('.choice-trigger'), menu = field.querySelector('[role=listbox]');
    if (!field.isConnected || trigger.disabled) return;
    const owner = field.closest('dialog'), native = typeof menu.showPopover === 'function';
    active = { field, trigger, menu, owner, native };
    menu.hidden = false;
    Object.assign(menu.style, { position: 'fixed', inset: 'auto', margin: '0', left: '0', top: '0' });
    if (native) menu.showPopover();
    else menu.removeAttribute('popover');
    // Light dismissal must also update ARIA and release the anchor observer.
    const state = active;
    state.onToggle = event => { if (event.newState === 'closed' && active === state) close(false, true); };
    menu.addEventListener('beforetoggle', state.onToggle);
    if (view.MutationObserver) {
      state.observer = new view.MutationObserver(() => {
        if (!field.isConnected) close(); else queuePosition();
      });
      state.observer.observe(doc.body, { childList: true, subtree: true });
    }
    trigger.setAttribute('aria-expanded', 'true');
    position();
    if (active !== state) return;
    menu.dataset.choiceOpen = 'true';
    const selected = field.querySelector('[aria-selected=true]') || menu.querySelector('[role=option]');
    focusOption(menu, selected, true);
  };
  const pointerdown = event => {
    triggerWasOpen = active && event.target.closest('.choice-trigger') === active.trigger ? active.field : null;
  };
  const click = event => {
    const field = event.target.closest('[data-choice]'), trigger = event.target.closest('.choice-trigger');
    const wasOpen = triggerWasOpen === field; triggerWasOpen = null;
    if (!field) return close();
    if (trigger) { if (wasOpen || active?.field === field) close(); else open(field); return; }
    const option = event.target.closest('[data-choice-option]');
    if (option && active?.field === field) {
      setChoice(field, option.dataset.choiceOption);
      close(true);
      field.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const keydown = event => {
    const field = event.target.closest('[data-choice]');
    if (!field) return;
    if (event.key === 'Escape' && active?.field === field) {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    if (event.key === 'Tab' && active?.field === field) { close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (active?.field !== field) return open(field);
    const options = [...field.querySelectorAll('[role=option]')], index = options.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    focusOption(active.menu, options[next]);
  };
  const focusin = event => { if (active && event.target.closest('[data-choice]') !== active.field) close(); };
  const ownerClosed = event => { if (active?.owner === event.target) close(); };
  root.addEventListener('pointerdown', pointerdown, true);
  root.addEventListener('click', click);
  root.addEventListener('keydown', keydown, true);
  root.addEventListener('focusin', focusin);
  root.addEventListener('close', ownerClosed, true);
  root.addEventListener('scroll', queuePosition, true);
  view.addEventListener('resize', queuePosition);
  view.visualViewport?.addEventListener('resize', queuePosition);
  view.visualViewport?.addEventListener('scroll', queuePosition);
  return { close, destroy() {
    close();
    root.removeEventListener('pointerdown', pointerdown, true); root.removeEventListener('click', click);
    root.removeEventListener('keydown', keydown, true); root.removeEventListener('focusin', focusin);
    root.removeEventListener('close', ownerClosed, true); root.removeEventListener('scroll', queuePosition, true);
    view.removeEventListener('resize', queuePosition);
    view.visualViewport?.removeEventListener('resize', queuePosition);
    view.visualViewport?.removeEventListener('scroll', queuePosition);
  } };
}
