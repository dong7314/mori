// Motion follows a change of context. Clock refreshes stay still, and content
// never depends on an animation or an observer becoming ready to be readable.
export function createMotion(main, { nav = main?.ownerDocument?.querySelector('#tabs') } = {}) {
  if (!main) throw new TypeError('createMotion requires the page content element.');
  const doc = main.ownerDocument, view = doc.defaultView;
  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set(), animations = new WeakMap(), messageStates = new WeakMap();
  const opened = new WeakSet(), closing = new Map(), dialogListeners = new Map(), disclosures = new Map();
  const ease = 'cubic-bezier(.22, 1, .36, 1)', spring = 'cubic-bezier(.22, .9, .28, 1)';
  let observer, previous, navPosition, disposed = false;
  const reduced = element => disposed || preference.matches || doc.hidden ||
    doc.documentElement.classList.contains('reduce-motion') || Boolean(element?.closest('.reduce-motion'));

  function play(element, frames, options = {}) {
    if (!element?.isConnected || reduced(element) || typeof element.animate !== 'function') return;
    animations.get(element)?.cancel();
    let animation;
    try { animation = element.animate(frames, { duration: 460, easing: ease, ...options }); }
    catch { return; } // Unsupported animation properties must never interrupt an action.
    active.add(animation); animations.set(element, animation);
    const release = () => {
      active.delete(animation);
      if (animations.get(element) === animation) animations.delete(element);
    };
    animation.addEventListener('finish', release, { once: true });
    animation.addEventListener('cancel', release, { once: true });
    return animation;
  }

  function enter(element, delay = 0, { distance = 14, duration = 520 } = {}) {
    element?.classList.remove('motion-pending');
    return play(element, [{ opacity: 0, translate: `0 ${distance}px` }, { opacity: 1, translate: '0 0' }],
      { delay: Math.min(Math.max(delay, 0), 180), duration, fill: 'backwards' });
  }

  function reset() {
    observer?.disconnect(); observer = undefined;
    for (const animation of active) animation.cancel();
    active.clear();
    main.querySelectorAll('.motion-pending').forEach(element => element.classList.remove('motion-pending'));
    for (const operation of [...closing.values()]) operation.finish();
    for (const operation of [...disclosures.values()]) operation.finish();
  }

  // Small menus keep their DOM and focus targets throughout the transition.
  // A superseded operation can settle its promise, but cannot hide a reopened menu.
  function disclosure(element, expanded) {
    if (!element) return Promise.resolve();
    expanded = Boolean(expanded);
    const before = disclosures.get(element), wasHidden = element.hidden;
    if (before?.expanded === expanded) return before.promise;
    if (!before && wasHidden === !expanded) {
      element.inert = !expanded;
      return Promise.resolve();
    }
    let current;
    if (before && !wasHidden) {
      try { current = view.getComputedStyle?.(element); } catch { /* Optional visual continuity only. */ }
    }
    const start = current ? { opacity: current.opacity, translate: current.translate === 'none' ? '0 0' : current.translate } : undefined;
    let resolveCompletion, finished = false;
    const promise = new Promise(resolve => { resolveCompletion = resolve; });
    const operation = { expanded, promise, finish: () => {
      if (finished) return;
      finished = true;
      if (disclosures.get(element) === operation) {
        disclosures.delete(element);
        element.hidden = !expanded;
        element.inert = !expanded;
      }
      operation.animation?.cancel();
      resolveCompletion();
    } };
    disclosures.set(element, operation);
    before?.finish();
    element.hidden = false;
    element.inert = !expanded;
    const animation = play(element, expanded ? [
      start || { opacity: 0, translate: '0 -4px' },
      { opacity: 1, translate: '0 0' },
    ] : [
      start || { opacity: 1, translate: '0 0' },
      { opacity: 0, translate: '0 -3px' },
    ], { duration: expanded ? 160 : 120, easing: expanded ? ease : 'cubic-bezier(.4, 0, 1, 1)', fill: expanded ? 'backwards' : 'forwards' });
    operation.animation = animation;
    if (!animation) operation.finish();
    else {
      animation.addEventListener('finish', operation.finish, { once: true });
      animation.addEventListener('cancel', operation.finish, { once: true });
    }
    return promise;
  }

  function result(container) {
    return enter(container, 0, { distance: 3, duration: 160 });
  }

  function visible(element) {
    const box = element.getBoundingClientRect(), page = main.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > Math.max(0, page.top) &&
      box.top < Math.min(view.innerHeight, page.bottom) && box.right > 0 && box.left < view.innerWidth;
  }

  function reveal(elements, { stagger = 48, distance = 14, duration = 520 } = {}) {
    if (reduced(main)) return;
    const candidates = [...new Set(elements)];
    const items = candidates.filter(element => !candidates.some(parent => parent !== element && parent.contains(element)));
    let index = 0;
    const waiting = [];
    for (const item of items) {
      if (visible(item)) enter(item, index++ * stagger, { distance, duration });
      else waiting.push(item);
    }
    if (!waiting.length || typeof view.IntersectionObserver !== 'function') return;
    // Offscreen sections remain visible. The observer only adds polish.
    try {
      observer = new view.IntersectionObserver(entries => {
        entries.filter(entry => entry.isIntersecting).forEach((entry, position) => {
          observer?.unobserve(entry.target);
          enter(entry.target, position * 35, { distance: 10, duration: 420 });
        });
      }, { root: main, threshold: 0.06 });
      waiting.forEach(item => observer.observe(item));
    } catch { observer?.disconnect(); observer = undefined; }
  }

  function capture(scene, state) {
    return {
      scene,
      month: main.querySelector('.month-title, .month-heading h2')?.textContent,
      date: main.querySelector('.calendar-grid [aria-pressed="true"], .selected-day')?.dataset.date,
      calendar: main.querySelector('.calendar-modes [aria-pressed="true"]')?.dataset.value,
      filter: main.querySelector('.segmented:not(.calendar-modes) [aria-pressed="true"], .filter-tabs .active')?.dataset.value,
      horizon: main.querySelector('.window-menu [aria-pressed="true"]')?.dataset.hours,
      search: main.querySelector('#conversation-search')?.value,
      ...state,
    };
  }

  function moveNavigation(changed) {
    const selected = nav?.querySelector('[aria-current="page"]');
    if (!selected) return;
    const indicator = nav.querySelector('[data-nav-indicator], .nav-indicator');
    if (indicator) {
      const bounds = nav.getBoundingClientRect(), target = selected.getBoundingClientRect();
      const next = {
        x: target.left - bounds.left + nav.scrollLeft - nav.clientLeft,
        y: target.top - bounds.top + nav.scrollTop - nav.clientTop,
        width: target.width, height: target.height,
      };
      indicator.style.width = `${next.width}px`; indicator.style.height = `${next.height}px`;
      indicator.style.transformOrigin = '0 0';
      indicator.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
      if (changed && navPosition && next.width > 0 && next.height > 0) play(indicator, [
        { transform: `translate3d(${navPosition.x}px, ${navPosition.y}px, 0) scale(${navPosition.width / next.width}, ${navPosition.height / next.height})` },
        { transform: `translate3d(${next.x}px, ${next.y}px, 0) scale(1, 1)` },
      ], { duration: 430, easing: spring });
      navPosition = next;
    }
    if (changed) play(selected.querySelector('.icon'), [
      { scale: '.86', translate: '0 2px', offset: 0 },
      { scale: '1.04', translate: '0 -1px', offset: 0.66 },
      { scale: '1', translate: '0 0', offset: 1 },
    ], { duration: 420, easing: spring });
  }

  function render(scene, state = {}) {
    const current = capture(scene, state), changed = previous?.scene !== scene;
    reset(); moveNavigation(changed && Boolean(previous));
    if (changed) {
      // Independent sections: never animate both a card and its parent.
      reveal(main.querySelectorAll([
        '[data-motion="reveal"]', '.home-top', '.home-greeting',
        '.dashboard-section',
        '.now-section > .section-heading', '.brief-card', '.forecast-summary', '.forecast-shelf',
        '.home-lower > section', '.page-heading', '.search-box', '.conversation-start',
        '.conversation-groups > section', '.conversation-groups > .empty-state',
        '.schedule-topbar', '.calendar-modes', '.schedule-layout > section', '.quiet-card',
        '.feature-grid > .feature-tile', '.custom-list', '.create-feature',
        '.profile-summary', '.license-card', '.settings-list', '.brand-footer',
      ].join(', ')));
    } else if (current.horizon !== previous.horizon) {
      reveal(main.querySelectorAll('.brief-card, .forecast-summary, .forecast-shelf'), { stagger: 40, distance: 10, duration: 400 });
    } else if (current.calendar !== previous.calendar || current.month !== previous.month) {
      reveal(main.querySelectorAll('.schedule-layout > section, .calendar-grid'), { stagger: 35, distance: 8, duration: 340 });
    } else if (current.date !== previous.date) {
      enter(main.querySelector('.agenda-body, .calendar-layout > section:last-child'), 0, { distance: 8, duration: 340 });
      play(main.querySelector('.calendar-grid [aria-pressed="true"] .calendar-date-number'), [{ scale: '.9' }, { scale: '1' }], { duration: 320, easing: spring });
    } else if (current.filter !== previous.filter) {
      reveal(main.querySelectorAll('.feature-grid > .feature-tile, .custom-list, .create-feature, .memory-grid > article'), { stagger: 35, distance: 8, duration: 360 });
    } else if (current.search !== previous.search) {
      enter(main.querySelector('.conversation-groups'), 0, { distance: 4, duration: 220 });
    }
    previous = current;
  }

  function messages(container, key = 'conversation') {
    if (!container) return;
    const occurrences = new Map();
    const items = [...container.querySelectorAll('.message, [data-message-id]')].map(element => {
      const signature = element.dataset.messageId || `${element.className}:${element.textContent}`;
      const occurrence = (occurrences.get(signature) || 0) + 1;
      occurrences.set(signature, occurrence);
      return { element, id: `${signature}:${occurrence}` };
    });
    const before = messageStates.get(container);
    messageStates.set(container, { key, ids: new Set(items.map(item => item.id)) });
    if (!before || before.key !== key) return;
    items.filter(item => !before.ids.has(item.id)).slice(-3).forEach(({ element }, index) => {
      play(element, [
        { opacity: 0, translate: element.classList.contains('user') ? '8px 5px' : '0 9px', scale: '.985' },
        { opacity: 1, translate: '0 0', scale: '1' },
      ], { delay: index * 40, duration: 360, fill: 'backwards' });
    });
  }

  function registerDialog(dialog) {
    if (dialogListeners.has(dialog)) return;
    const onClose = () => {
      if (dialog.open) return; // A queued close event may follow a same-tick reopen.
      opened.delete(dialog); animations.get(dialog)?.cancel(); closing.get(dialog)?.finish();
    };
    dialog.addEventListener('close', onClose); dialogListeners.set(dialog, onClose);
  }

  // Call before or immediately after showModal(). Content updates in an open
  // sheet keep their position instead of replaying its entrance.
  function openDialog(dialog) {
    if (!dialog || disposed) return;
    registerDialog(dialog); closing.get(dialog)?.finish();
    if (!dialog.open) dialog.showModal();
    if (opened.has(dialog)) return;
    opened.add(dialog);
    const compact = view.innerWidth < 700;
    return play(dialog, [
      { opacity: 0, translate: compact ? '0 28px' : '0 12px', scale: compact ? '.99' : '.97' },
      { opacity: 1, translate: '0 0', scale: '1' },
    ], { duration: compact ? 470 : 390, easing: spring, fill: 'backwards' });
  }

  // Await this before opening another modal. Immediate is useful when a
  // submission/navigation flow must synchronously release modal focus.
  function closeDialog(dialog, { immediate = false, returnValue } = {}) {
    if (!dialog?.open) return Promise.resolve();
    if (closing.has(dialog)) return closing.get(dialog).promise;
    registerDialog(dialog); opened.delete(dialog);
    if (immediate || reduced(dialog)) { dialog.close(returnValue); return Promise.resolve(); }
    let resolveClose;
    const promise = new Promise(resolve => { resolveClose = resolve; });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; closing.delete(dialog);
      if (dialog.open) dialog.close(returnValue);
      resolveClose();
    };
    closing.set(dialog, { finish, promise });
    const animation = play(dialog, [
      { opacity: 1, translate: '0 0', scale: '1' },
      { opacity: 0, translate: '0 10px', scale: '.985' },
    ], { duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    if (!animation) finish();
    else {
      animation.addEventListener('finish', finish, { once: true });
      animation.addEventListener('cancel', finish, { once: true });
    }
    return promise;
  }

  const focus = event => {
    for (let element = event.target; element && element !== main; element = element.parentElement) {
      observer?.unobserve(element); element.classList?.remove('motion-pending');
      // Opening disclosures deliberately expose focus targets immediately. Their
      // autofocus must not cancel the entrance it was just allowed to enter.
      if (!disclosures.get(element)?.expanded) animations.get(element)?.cancel();
    }
  };
  const visibility = () => { if (doc.hidden) reset(); };
  const preferenceChange = () => reset();
  const classObserver = typeof view.MutationObserver === 'function' ? new view.MutationObserver(() => {
    if (reduced(main)) reset();
  }) : undefined;
  classObserver?.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  main.addEventListener('focusin', focus); preference.addEventListener('change', preferenceChange);
  view.addEventListener('beforeprint', reset); doc.addEventListener('visibilitychange', visibility);

  function destroy() {
    disposed = true; reset(); classObserver?.disconnect();
    main.removeEventListener('focusin', focus); preference.removeEventListener('change', preferenceChange);
    view.removeEventListener('beforeprint', reset); doc.removeEventListener('visibilitychange', visibility);
    for (const [dialog, listener] of dialogListeners) dialog.removeEventListener('close', listener);
    dialogListeners.clear();
  }

  return { render, enter, result, disclosure, messages, openDialog, closeDialog, reset, destroy };
}
