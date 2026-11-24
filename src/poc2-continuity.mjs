/*
 * Call captureShared(avatar) immediately before replacing the outgoing view,
 * then revealShared(snapshot, incomingAvatar) after the new view has layout.
 * Snapshots are opaque, single-use, and have cancel() for abandoned navigation.
 * Both revealShared() and animateSheet() return Animation | null. A closing
 * sheet must stay open until animation.finished settles successfully.
 */

const documents = new WeakMap();
const hiddenElements = new WeakMap();
const sheetMotions = new WeakMap();
const observedSheets = new WeakSet();
const sharedEasing = 'cubic-bezier(.22,.76,.2,1)';
const sheetEasing = 'cubic-bezier(.2,.8,.2,1)';

function contextFor(doc) {
  let context = documents.get(doc);
  if (context) return context;
  const win = doc.defaultView;
  const preference = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  context = { doc, win, preference, shared: null, sheets: new Set() };
  documents.set(doc, context);

  const settle = () => {
    context.shared?.cancel();
    for (const motion of [...context.sheets]) {
      // Finish rather than cancel: callers awaiting a closing sheet can close it.
      try { motion.animation.finish(); } catch { motion.dispose(); }
    }
  };
  preference?.addEventListener?.('change', event => { if (event.matches) settle(); });
  win?.addEventListener('resize', () => context.shared?.cancel(), { passive: true });
  win?.visualViewport?.addEventListener('resize', () => context.shared?.cancel(), { passive: true });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) settle(); });
  return context;
}

function rectOf(element) {
  if (!element?.isConnected || typeof element.getBoundingClientRect !== 'function') return null;
  const rect = element.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function conceal(element) {
  let entry = hiddenElements.get(element);
  if (!entry) {
    entry = {
      count: 0,
      value: element.style.getPropertyValue('visibility'),
      priority: element.style.getPropertyPriority('visibility'),
    };
    hiddenElements.set(element, entry);
    element.style.setProperty('visibility', 'hidden', 'important');
  }
  entry.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.count) return;
    hiddenElements.delete(element);
    // Do not overwrite a visibility change made by the application meanwhile.
    if (element.style.getPropertyValue('visibility') !== 'hidden'
      || element.style.getPropertyPriority('visibility') !== 'important') return;
    if (entry.value) element.style.setProperty('visibility', entry.value, entry.priority);
    else element.style.removeProperty('visibility');
  };
}

function freezeClone(source, win) {
  const clone = source.cloneNode(true);
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((original, index) => {
    const copy = copies[index];
    const computed = win.getComputedStyle(original);
    // Resolving each property also keeps ancestor-scoped sprite styles, clipping,
    // frame positions, CSS variables, and the currently rendered orientation.
    for (const property of computed) copy.style.setProperty(property, computed.getPropertyValue(property));
    // Physical dimensions win over logical aliases and intrinsic grid/image
    // sizing once the copy no longer participates in its original layout.
    copy.style.setProperty('width', computed.width, 'important');
    copy.style.setProperty('height', computed.height, 'important');
    if (computed.width.endsWith('px')) {
      copy.style.setProperty('min-width', computed.width, 'important');
      copy.style.setProperty('max-width', computed.width, 'important');
    }
    if (computed.height.endsWith('px')) {
      copy.style.setProperty('min-height', computed.height, 'important');
      copy.style.setProperty('max-height', computed.height, 'important');
    }
    copy.removeAttribute('id');
    copy.removeAttribute('autofocus');
    copy.removeAttribute('tabindex');
    for (const attribute of [...copy.attributes]) {
      if (attribute.name.startsWith('on')) copy.removeAttribute(attribute.name);
    }
    copy.style.setProperty('animation', 'none', 'important');
    copy.style.setProperty('transition', 'none', 'important');
    copy.style.setProperty('pointer-events', 'none', 'important');
    copy.style.setProperty('caret-color', 'transparent', 'important');
    if (original.localName === 'canvas') {
      try { copy.getContext('2d')?.drawImage(original, 0, 0); } catch { /* The avatar normally uses images. */ }
    }
  });
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  clone.style.setProperty('position', 'absolute', 'important');
  clone.style.setProperty('inset', 'auto', 'important');
  clone.style.setProperty('left', '0px', 'important');
  clone.style.setProperty('top', '0px', 'important');
  clone.style.setProperty('margin', '0', 'important');
  // Inline avatars need a real box when removed from their original flex/grid.
  if (win.getComputedStyle(source).display === 'inline') clone.style.setProperty('display', 'block', 'important');
  return clone;
}

function placeHost(host, rect) {
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
  host.style.transform = 'none';
}

function makeVisual(source, rect, context) {
  const host = context.doc.createElement('div');
  host.className = 'mori-shared-flight';
  host.setAttribute('aria-hidden', 'true');
  host.inert = true;
  // Geometry and hit testing remain correct if the companion CSS is loaded late.
  Object.assign(host.style, {
    position: 'fixed', margin: '0', padding: '0', border: '0',
    pointerEvents: 'none', zIndex: '2147483646', overflow: 'visible',
    transformOrigin: '0 0', boxSizing: 'border-box',
  });
  placeHost(host, rect);
  const stage = context.doc.createElement('div');
  stage.className = 'mori-shared-actor';
  Object.assign(stage.style, {
    position: 'absolute', inset: '0 auto auto 0', width: `${rect.width}px`,
    height: `${rect.height}px`, transformOrigin: '0 0', pointerEvents: 'none',
  });
  const clone = freezeClone(source, context.win);
  stage.append(clone);
  host.append(stage);
  context.doc.body.append(host);
  // Preserve transforms on the avatar itself too, including scaleX(-1). Its
  // transformed bounding box is aligned inside the moving viewport rectangle.
  const rendered = clone.getBoundingClientRect();
  clone.style.setProperty('left', `${rect.left - rendered.left}px`, 'important');
  clone.style.setProperty('top', `${rect.top - rendered.top}px`, 'important');
  return { host, stage, scaleX: 1, scaleY: 1 };
}

/** Capture the visible actor before its view is removed. Returns null when motion is unavailable. */
export function captureShared(source) {
  const doc = source?.ownerDocument;
  if (!doc?.body || !doc.defaultView) return null;
  const context = contextFor(doc);
  if (context.preference?.matches || typeof source.animate !== 'function') {
    context.shared?.cancel();
    return null;
  }
  const sourceRect = rectOf(source);
  if (!sourceRect) {
    context.shared?.cancel();
    return null;
  }

  let rect = sourceRect;
  let visual;
  const previous = context.shared;
  if (previous?.host.isConnected) {
    // A rapid second navigation starts exactly where the first actor is now.
    rect = rectOf(previous.host) ?? sourceRect;
    visual = previous.visual;
    visual.scaleX *= rect.width / previous.rect.width;
    visual.scaleY *= rect.height / previous.rect.height;
    previous.cancel(true);
    visual.stage.style.transform = `scale(${visual.scaleX}, ${visual.scaleY})`;
    placeHost(visual.host, rect);
  } else {
    previous?.cancel();
    const computed = context.win.getComputedStyle(source);
    if (computed.visibility === 'hidden' || computed.display === 'none') return null;
    visual = makeVisual(source, rect, context);
  }

  const releases = [conceal(source)];
  let disposed = false;
  let expiry;
  const snapshot = {
    rect, visual, host: visual.host, animation: null, consumed: false,
    begin() { context.win.clearTimeout(expiry); },
    cancel(preserveVisual = false) {
      if (disposed) return;
      disposed = true;
      context.win.clearTimeout(expiry);
      if (context.shared === snapshot) context.shared = null;
      snapshot.animation?.cancel();
      for (const release of releases) release();
      if (!preserveVisual) visual.host.remove();
    },
  };
  // An abandoned render must never leave the original avatar invisible.
  expiry = context.win.setTimeout(() => snapshot.cancel(), 1200);
  snapshot.concealTarget = target => releases.push(conceal(target));
  context.shared = snapshot;
  return snapshot;
}

/** Move a captured actor into the incoming avatar. Superseded flights are cleaned up automatically. */
export function revealShared(snapshot, target, { reverse = false } = {}) {
  if (!snapshot || snapshot.consumed) return null;
  snapshot.consumed = true;
  const context = target?.ownerDocument ? contextFor(target.ownerDocument) : null;
  const destination = rectOf(target);
  if (!context || context.shared !== snapshot || !destination || context.preference?.matches
    || typeof snapshot.host.animate !== 'function') {
    snapshot.cancel();
    return null;
  }
  snapshot.begin();
  snapshot.concealTarget(target);
  const { rect } = snapshot;
  const dx = destination.left - rect.left;
  const dy = destination.top - rect.top;
  const sx = destination.width / rect.width;
  const sy = destination.height / rect.height;
  const duration = reverse ? 490 : 560;
  try {
    const animation = snapshot.host.animate([
      { transform: 'translate(0px, 0px) scale(1, 1)' },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    ], { duration, easing: sharedEasing, fill: 'both' });
    snapshot.animation = animation;
    animation.finished.then(() => snapshot.cancel(), () => snapshot.cancel());
    return animation;
  } catch {
    snapshot.cancel();
    return null;
  }
}

function currentTranslate(dialog, win) {
  const value = win.getComputedStyle(dialog).translate;
  return value && value !== 'none' ? value : '0px 0px';
}

function backdropMotion(dialog, from, to, duration, easing) {
  try {
    const animation = dialog.animate([{ opacity: from }, { opacity: to }], {
      duration, easing, fill: 'both', pseudoElement: '::backdrop',
    });
    // Engines without pseudo-element WAAPI support can silently ignore the option.
    if (animation.effect?.pseudoElement !== '::backdrop') {
      animation.cancel();
      return null;
    }
    animation.finished.catch(() => {});
    return animation;
  } catch { return null; }
}

/**
 * Call after showModal() for entry. For exit, await the returned animation before
 * dialog.close(); null means close immediately. offset is an existing downward
 * drag distance in CSS pixels, after removing the drag class/inline translate.
 */
export function animateSheet(dialog, { opening = true, offset = 0 } = {}) {
  if (!dialog?.open || !dialog.ownerDocument?.defaultView) return null;
  const context = contextFor(dialog.ownerDocument);
  const { win } = context;
  const previous = sheetMotions.get(dialog);
  const current = previous ? currentTranslate(dialog, win) : null;
  const opacity = previous ? win.getComputedStyle(dialog).opacity : '1';
  const backdropOpacity = win.getComputedStyle(dialog, '::backdrop').opacity;
  previous?.dispose();
  dialog.dataset.nativeSheet = '';
  dialog.dataset.nativeSheetPhase = opening ? 'opening' : 'closing';

  if (!observedSheets.has(dialog)) {
    observedSheets.add(dialog);
    dialog.addEventListener('close', () => {
      sheetMotions.get(dialog)?.dispose();
      dialog.dataset.nativeSheetPhase = 'closed';
    });
  }
  if (context.preference?.matches || typeof dialog.animate !== 'function') {
    dialog.dataset.nativeSheetPhase = opening ? 'open' : 'closed';
    return null;
  }

  const rect = dialog.getBoundingClientRect();
  const viewportHeight = win.visualViewport?.height ?? win.innerHeight;
  const distance = Math.ceil(rect.height + Math.max(0, viewportHeight - rect.bottom) + 32);
  const dragOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const from = current ?? `0px ${opening ? distance : dragOffset}px`;
  const to = opening ? '0px 0px' : `0px ${Math.max(distance, dragOffset + 32)}px`;
  const duration = opening ? (previous ? 340 : 440) : (dragOffset ? 240 : 300);
  let animation;
  try {
    animation = dialog.animate([
      { translate: from, opacity: opening && !previous ? .92 : opacity },
      { translate: to, opacity: opening ? 1 : .96 },
    ], { duration, easing: opening ? sheetEasing : 'cubic-bezier(.4,0,.8,.4)', fill: 'both' });
  } catch {
    dialog.dataset.nativeSheetPhase = opening ? 'open' : 'closed';
    return null;
  }
  const backdrop = backdropMotion(dialog,
    previous ? backdropOpacity : (opening ? 0 : 1), opening ? 1 : 0, duration, 'ease-out');
  dialog.dataset.nativeBackdrop = backdrop ? 'waapi' : 'css';
  let disposed = false;
  const motion = {
    animation,
    dispose() {
      if (disposed) return;
      disposed = true;
      context.sheets.delete(motion);
      if (sheetMotions.get(dialog) === motion) sheetMotions.delete(dialog);
      animation.cancel();
      backdrop?.cancel();
    },
  };
  context.sheets.add(motion);
  sheetMotions.set(dialog, motion);
  animation.finished.then(() => {
    if (sheetMotions.get(dialog) !== motion) return;
    context.sheets.delete(motion);
    dialog.dataset.nativeSheetPhase = opening ? 'open' : 'closed';
    if (opening) motion.dispose();
    // Exit keeps its final frame until the caller closes the modal dialog.
  }, () => motion.dispose());
  return animation;
}
