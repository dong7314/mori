import { captureControl, resolveControl } from './navigation-focus.mjs';

// Keep text at its natural aspect ratio. Only the surface boundary changes size.
export function cardGeometry(source, target, radius = 28, targetRadius = 0) {
  if (!source || !target || source.width <= 0 || source.height <= 0 ||
      source.width > target.width || source.height > target.height) return null;
  const x = source.left - target.left, y = source.top - target.top;
  return { x, y, frames: [
    { transform: `translate(${x}px, ${y}px)`, clipPath: `inset(0px ${target.width - source.width}px ${target.height - source.height}px 0px round ${radius}px)`, opacity: 1, '--detail-progress': '0' },
    { transform: 'translate(0px, 0px)', clipPath: `inset(0px 0px 0px 0px round ${targetRadius}px)`, opacity: 1, '--detail-progress': '1' },
  ] };
}

export function createPresentations({ reducedMotion = () => false } = {}) {
  const states = new WeakMap();
  let openOrder = [];
  const easing = 'cubic-bezier(.22,1,.36,1)';
  // A result inside chat can share its action with a dashboard card. Keep the
  // originating surface so a rerender cannot send focus behind the open dialog.
  const resolveSource = state => resolveControl(state.sourceRoot, state.source, { visible: true });
  const visibleRect = element => {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth ? rect : null;
  };
  const readFrame = (element, template) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(Object.keys(template).map(key => [key, key.startsWith('--') ? style.getPropertyValue(key).trim() || template[key] : key === 'clipPath' && style[key] === 'none' ? template[key] : style[key] || template[key]]));
  };
  const cancel = state => {
    state?.animation?.cancel();
    state?.tracks?.forEach(track => track.animation.cancel());
  };
  const clearDrag = dialog => {
    dialog.style?.removeProperty('transform');
    dialog.style?.removeProperty('opacity');
    dialog.style?.removeProperty('clip-path');
    dialog.style?.removeProperty('--detail-progress');
  };
  const clearFrozen = state => {
    state?.frozen?.forEach((properties, element) => {
      for (const [key, value] of properties) {
        if (value) element.style.setProperty(key, value); else element.style.removeProperty(key);
      }
    });
    if (state) state.frozen = null;
  };
  function plan(dialog, state) {
    const source = resolveSource(state), rect = visibleRect(source);
    const target = state.target;
    const hero = dialog.querySelector?.('.parking-detail');
    const scroller = dialog.querySelector?.('#sheet-content');
    // Match actual common content, not every unrelated list row to a full page.
    const shared = source?.matches?.('.time-card.parking') && hero && !scroller?.scrollTop;
    const geometry = shared && cardGeometry(rect, target, parseFloat(getComputedStyle(source).borderRadius) || 28, parseFloat(getComputedStyle(dialog).borderRadius) || 0);
    if (geometry) {
      const parts = [...hero.querySelectorAll('[data-card-part]')].flatMap(element => {
        const from = source.querySelector(`[data-card-part="${element.dataset.cardPart}"]`);
        if (!from) return [];
        const a = from.getBoundingClientRect(), b = element.getBoundingClientRect();
        const style = getComputedStyle(element), sourceStyle = getComputedStyle(from);
        const scale = parseFloat(sourceStyle.fontSize) / parseFloat(style.fontSize) || 1;
        const base = style.transform === 'none' ? '' : style.transform;
        return [{ element, frames: [
          { transform: `translate(${a.left - b.left - geometry.x}px, ${a.top - b.top - geometry.y}px) scale(${scale}) ${base}`.trim(), opacity: sourceStyle.opacity },
          { transform: base || 'none', opacity: style.opacity },
        ] }];
      });
      const reveals = [...dialog.querySelectorAll('[data-card-reveal], .sheet-header')].map(element => ({ element, frames: [
        { opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0px)' },
      ] }));
      return { frames: geometry.frames, parts, reveals, card: true };
    }
    return { frames: [
      { transform: state.kind === 'voice' ? 'translateY(28px) scale(.98)' : 'translateY(28px)', opacity: 0, '--detail-progress': '0' },
      { transform: 'translateY(0px)', opacity: 1, '--detail-progress': '1' },
    ], parts: [], reveals: [], card: false };
  }
  function run(dialog, state, motion, closing = false, current = null) {
    const duration = closing ? 360 : motion.card ? 500 : 320;
    const options = { duration, easing, fill: 'both' };
    clearFrozen(state);
    if (motion.card) dialog.dataset.cardMotion = 'true';
    state.tracks = [];
    for (const track of [...motion.parts, ...motion.reveals]) {
      if (!track.element.isConnected) continue;
      const revealing = motion.reveals.includes(track);
      const frames = closing ? [current?.get(track.element) || readFrame(track.element, track.frames[1]), track.frames[0]] : [current?.get(track.element) || track.frames[0], track.frames[1]];
      const animation = track.element.animate(frames, { ...options, duration: revealing ? closing ? 150 : 240 : duration, delay: revealing && !closing && !current ? 100 : 0 });
      animation.finished.catch(() => {});
      state.tracks.push({ ...track, animation });
    }
    const frames = closing ? [current?.get(dialog) || readFrame(dialog, motion.frames[1]), motion.frames[0]] : [current?.get(dialog) || motion.frames[0], motion.frames[1]];
    state.animation = dialog.animate(frames, options);
    return state.animation;
  }
  function snapshot(dialog, state) {
    if (!state?.motion) return null;
    return new Map([[dialog, readFrame(dialog, state.motion.frames[1])], ...[...state.motion.parts, ...state.motion.reveals].filter(t => t.element.isConnected).map(t => [t.element, readFrame(t.element, t.frames[1])])]);
  }
  function settleOpening(dialog, state) {
    cancel(state); clearFrozen(state);
    if (state) { state.animation = null; state.tracks = []; }
    dialog.removeAttribute('data-card-motion'); clearDrag(dialog);
  }
  function finishOpening(dialog, state, animation) {
    animation.finished.then(() => {
      if (states.get(dialog) !== state || state.animation !== animation || state.closing) return;
      settleOpening(dialog, state);
    }).catch(() => {});
  }
  function show(dialog, { source = document.activeElement, kind = 'sheet' } = {}) {
    const previous = states.get(dialog);
    if (dialog.open && !previous?.closing) return;
    const current = previous?.closing ? snapshot(dialog, previous) : null;
    cancel(previous); clearFrozen(previous); clearDrag(dialog);
    const state = { source: captureControl(source), sourceRoot: source?.closest('dialog') || document, kind, animation: null, tracks: [], closing: null };
    states.set(dialog, state);
    openOrder = openOrder.filter(view => view !== dialog && view.open);
    openOrder.push(dialog);
    dialog.dataset.presentation = kind;
    dialog.removeAttribute('data-closing'); dialog.removeAttribute('data-card-motion');
    if (!dialog.open) dialog.showModal();
    state.target = dialog.getBoundingClientRect();
    state.motion = plan(dialog, state);
    if (!reducedMotion()) finishOpening(dialog, state, run(dialog, state, state.motion, false, current));
  }
  function dismiss(dialog, { dragOffset = 0 } = {}) {
    if (!dialog.open) return Promise.resolve();
    const state = states.get(dialog) || { kind: 'sheet', tracks: [] };
    if (state.closing) return state.closing;
    states.set(dialog, state);
    const current = snapshot(dialog, state);
    cancel(state); clearDrag(dialog);
    // Resolve the source again after rerenders or editing. Scrolled/changed details
    // use the simple dismissal instead of morphing unrelated text into the card.
    if (!state.animation && !dragOffset) {
      state.target = dialog.getBoundingClientRect();
      state.motion = plan(dialog, state);
    }
    state.motion ||= plan(dialog, state);
    dialog.dataset.closing = 'true';
    state.closing = (async () => {
      if (!reducedMotion()) {
        const animation = run(dialog, state, state.motion, true, current);
        try { await animation.finished; } catch { return; }
      }
      dialog.close(); cancel(state); clearFrozen(state);
      dialog.removeAttribute('data-closing'); dialog.removeAttribute('data-card-motion'); clearDrag(dialog);
      states.delete(dialog);
      const source = resolveSource(state);
      source?.focus({ preventScroll: true });
    })();
    return state.closing;
  }
  function replace(content, { back = false, level = false } = {}) {
    content.getAnimations().forEach(animation => animation.cancel());
    if (reducedMotion()) return;
    const frames = level ? [{ opacity: .55 }, { opacity: 1 }] : [
      { opacity: .1, transform: `translateX(${back ? -18 : 24}px)` },
      { opacity: 1, transform: 'translateX(0)' },
    ];
    content.animate(frames, { duration: level ? 150 : 260, easing });
  }
  function pullToDismiss(dialog, onDismiss) {
    let drag;
    const reset = () => { drag = null; clearDrag(dialog); };
    dialog.addEventListener('pointerdown', event => {
      if (drag || event.isPrimary === false || event.button !== 0 || dialog.dataset.closing || event.target.closest('button') ||
        !event.target.closest('.sheet-handle, .sheet-header, .chat-header, .voice-panel > header, .parking-detail') ||
        (event.target.closest('.parking-detail') && dialog.querySelector('#sheet-content').scrollTop > 0)) return;
      event.preventDefault();
      const state = states.get(dialog);
      if (state && !state.animation) {
        state.target = dialog.getBoundingClientRect();
        state.motion = plan(dialog, state);
      }
      // Complete an in-flight entrance before direct manipulation. A tap alone
      // leaves the entrance running; movement takes over on pointermove.
      drag = { id: event.pointerId, y: event.clientY, at: performance.now(), offset: 0, state };
      dialog.setPointerCapture(event.pointerId);
    });
    dialog.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return;
      drag.offset = Math.max(0, event.clientY - drag.y) * .8;
      if (drag.offset < 3) return;
      if (!drag.started) {
        drag.started = true;
        // Keep the rendered position if the user catches the entrance mid-flight.
        const current = snapshot(dialog, drag.state);
        drag.base = current?.get(dialog);
        cancel(drag.state);
        if (drag.state) {
          drag.state.animation = null; drag.state.tracks = []; drag.state.frozen = new Map();
          current?.forEach((frame, element) => {
            if (element === dialog) return;
            const properties = ['transform', 'opacity'];
            drag.state.frozen.set(element, new Map(properties.map(key => [key, element.style.getPropertyValue(key)])));
            for (const key of properties) element.style.setProperty(key, frame[key]);
          });
        }
        if (drag.base?.clipPath) dialog.style.clipPath = drag.base.clipPath;
        if (drag.base?.opacity) dialog.style.opacity = drag.base.opacity;
      }
      const base = drag.base?.transform && drag.base.transform !== 'none' ? drag.base.transform : '';
      dialog.style.transform = `translateY(${drag.offset}px) ${base}`;
      const progress = Number(drag.base?.['--detail-progress']);
      dialog.style.setProperty('--detail-progress', String((Number.isFinite(progress) ? progress : 1) * Math.max(.2, 1 - drag.offset / 350)));
    });
    dialog.addEventListener('pointerup', event => {
      if (drag?.id !== event.pointerId) return;
      const { offset, at, state, started } = drag;
      const velocity = offset / Math.max(1, performance.now() - at);
      drag = null; dialog.releasePointerCapture(event.pointerId);
      if (!started) return;
      if (offset > 100 || (offset > 45 && velocity > .5)) onDismiss(offset);
      else {
        const current = snapshot(dialog, state); clearDrag(dialog);
        if (!reducedMotion() && state) finishOpening(dialog, state, run(dialog, state, state.motion, false, current));
        else settleOpening(dialog, state);
      }
    });
    const cancelDrag = event => {
      if (drag?.id !== event.pointerId) return;
      const { state, started } = drag, current = snapshot(dialog, state); reset();
      if (!started) return;
      if (state && !reducedMotion()) finishOpening(dialog, state, run(dialog, state, state.motion, false, current));
      else settleOpening(dialog, state);
    };
    dialog.addEventListener('pointercancel', cancelDrag);
    dialog.addEventListener('lostpointercapture', cancelDrag);
    dialog.addEventListener('close', reset);
  }
  const topDialog = () => openOrder.filter(dialog => dialog.open && !dialog.dataset.closing).at(-1) || null;
  return { show, dismiss, replace, pullToDismiss, topDialog };
}
