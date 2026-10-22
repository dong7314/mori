import { captureControl, resolveControl, isAvailableControl } from './navigation-focus.mjs';
import { captureCardSnapshot, snapshotTracks } from './card-transition.mjs';

let replacementSequence = 0;

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
  const replacementViews = new WeakMap();
  const replacementDialogs = new WeakMap();
  const replacementListeners = new WeakSet();
  let openOrder = [];
  const easing = 'cubic-bezier(.22,.78,.22,1)';
  // A result inside chat can share its action with a dashboard card. Keep the
  // originating surface so a rerender cannot send focus behind the open dialog.
  function resolveOrigin(state, { visible = false } = {}) {
    const exact = resolveControl(state.sourceRoot, state.source, { visible });
    if (exact) return exact;
    const attributes = new Map(state.source?.attributes || []);
    const kind = attributes.get('data-card-kind');
    // A generic empty feature card can acquire a record id after creating its
    // first item. Keep that feature as the origin; never redirect a deleted
    // specific record to an unrelated item of the same kind.
    if (!kind || attributes.get('data-ref') !== kind ||
        !state.source?.element?.matches?.('.brief-card')) return null;
    return [...(state.sourceRoot?.querySelectorAll?.('.brief-card[data-card-kind]') || [])].find(element =>
      element.isConnected && element.matches?.('.brief-card') && element.getAttribute('data-card-kind') === kind &&
      (!visible || isAvailableControl(element))) || null;
  }
  const resolveSource = state => resolveOrigin(state, { visible: true });
  // showModal makes the background inert. Geometry is still useful while that
  // card is behind the modal, even though it cannot currently receive focus.
  const resolveVisualSource = state => resolveOrigin(state);
  const visibleRect = element => {
    if (!element?.isConnected || !element.getClientRects?.().length ||
        element.closest?.('[hidden], dialog:not([open])')) return null;
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(innerWidth, rect.right ?? rect.left + rect.width);
    let bottom = Math.min(innerHeight, rect.bottom ?? rect.top + rect.height);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    // A card at the edge can still expand from its visible portion. Completely
    // offscreen cards use a simple presentation instead of flying across the UI.
    if (right - left < 24 || bottom - top < 24) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const isCard = element => element?.matches?.('.brief-card, .forecast-card, .time-card.parking');
  const isNavigationPage = dialog => dialog?.dataset.sheetPresentation === 'page' && !dialog.classList?.contains('card-page');
  function captureVisual(source) {
    const rect = isCard(source) && visibleRect(source);
    if (!rect) return null;
    const parts = new Map([...(source.querySelectorAll?.('[data-card-part]') || [])].map(element => [element.dataset.cardPart, {
      rect: element.getBoundingClientRect(),
      opacity: getComputedStyle(element).opacity,
      fontSize: getComputedStyle(element).fontSize,
    }]));
    return { rect, parts, radius: parseFloat(getComputedStyle(source).borderRadius) || 28,
      snapshot: reducedMotion() ? null : captureCardSnapshot(source) };
  }
  const readFrame = (element, template) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(Object.keys(template).map(key => [key, key.startsWith('--') ? style.getPropertyValue(key).trim() || template[key] : key === 'clipPath' && style[key] === 'none' ? template[key] : style[key] || template[key]]));
  };
  const cancel = state => {
    state?.animation?.cancel();
    state?.tracks?.forEach(track => track.animation.cancel());
  };
  const removeLayers = state => {
    state?.layers?.forEach(layer => layer.remove());
    if (state) state.layers = [];
  };
  function removeReplacement(view) {
    if (!view || view.removed) return;
    view.removed = true;
    view.animations.forEach(animation => animation.cancel());
    if (view.contentZ !== undefined) view.content.style.zIndex = view.contentZ;
    view.root.remove();
    if (replacementViews.get(view.content) === view) replacementViews.delete(view.content);
    replacementDialogs.get(view.dialog)?.delete(view);
  }
  function clearReplacements(dialog, except = null) {
    for (const view of replacementDialogs.get(dialog) || []) if (view !== except) removeReplacement(view);
  }
  function captureReplacement(content, { settle = false, anchor = null } = {}) {
    const dialog = content?.closest?.('dialog');
    if (dialog) clearReplacements(dialog);
    // A composer can reverse before its previous reveal ends. Freeze its final
    // layout, never an opacity-zero frame, before taking the next outgoing view.
    if (settle) content?.getAnimations?.().forEach(animation => animation.cancel());
    if (reducedMotion() || !dialog?.open || !content?.cloneNode) return null;
    const bounds = content.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const editor = anchor ? content.querySelector?.(anchor) : null;
    const anchorBounds = editor?.getBoundingClientRect();
    // An anchored replacement never falls back to a duplicate editable rail.
    // Hidden/zero-area editors cannot provide a reliable clipping boundary.
    if (anchor && (!editor || !anchorBounds || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(anchorBounds[key])) ||
        anchorBounds.width <= 0 || anchorBounds.height <= 0)) return null;
    const originals = [], copies = [];
    const cloneBranch = original => {
      // Do not even clone the editor temporarily. Besides avoiding two visible
      // drafts, this keeps the focused textarea, selection and controls live.
      if (original === editor || original.hidden) return null;
      const copy = original.cloneNode(false);
      originals.push(original); copies.push(copy);
      for (const child of original.childNodes || original.children || []) {
        const branch = child.nodeType === 1 || child.tagName ? cloneBranch(child) : child.cloneNode(true);
        if (branch) copy.appendChild(branch);
      }
      return copy;
    };
    const root = editor ? cloneBranch(content) : content.cloneNode(true);
    if (!editor) {
      originals.push(content, ...content.querySelectorAll('*'));
      copies.push(root, ...root.querySelectorAll('*'));
    }
    const svgIds = new Map();
    const prefix = `mori-view-${++replacementSequence}-`;
    for (const [index, element] of originals.entries()) {
      const id = element.getAttribute('id');
      if (id && (element.ownerSVGElement || element.tagName?.toLowerCase() === 'svg')) svgIds.set(id, `${prefix}${index}`);
    }
    const references = value => value.replace(/url\((['"]?)[^)'"\s]*#([^)'"\s]+)\1\)/g,
      (match, quote, id) => svgIds.has(id) ? `url("#${svgIds.get(id)}")` : match);
    const associations = new Set(['name', 'form', 'for', 'action', 'method', 'target', 'formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate', 'contenteditable', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant']);
    const scroll = [];
    for (const [index, original] of originals.entries()) {
      const copy = copies[index], computed = getComputedStyle(original);
      copy.style.cssText = Array.from(computed, name => `${name}:${references(computed.getPropertyValue(name))};`).join('');
      copy.style.setProperty('animation', 'none', 'important');
      copy.style.setProperty('transition', 'none', 'important');
      for (const { name, value } of [...copy.attributes]) {
        if (name === 'id' || name === 'tabindex' || name === 'autofocus' || name.startsWith('data-') || name.startsWith('on') || associations.has(name)) copy.removeAttribute(name);
        else if (name === 'href' || name === 'xlink:href') {
          if (value.startsWith('#') && svgIds.has(value.slice(1))) copy.setAttribute(name, `#${svgIds.get(value.slice(1))}`);
          else if (!original.ownerSVGElement) copy.removeAttribute(name);
        } else if (value.includes('url(')) copy.setAttribute(name, references(value));
      }
      const svgId = svgIds.get(original.getAttribute('id'));
      if (svgId) copy.setAttribute('id', svgId);
      // File inputs reject assigning a nonempty value. Their visible picker
      // label is already frozen; the snapshot must never copy a file handle.
      if ('value' in original && original.type !== 'file') copy.value = original.value;
      if ('checked' in original) copy.checked = original.checked;
      if ('selected' in original) copy.selected = original.selected;
      if ('disabled' in copy) copy.disabled = true;
      if (copy.tagName?.toLowerCase() === 'button') copy.type = 'button';
      if (original.scrollTop || original.scrollLeft) scroll.push({ element: copy, top: original.scrollTop || 0, left: original.scrollLeft || 0 });
    }
    root.classList.add('sheet-replacement-snapshot');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('inert', '');
    root.style.setProperty('pointer-events', 'none', 'important');
    const parent = dialog.getBoundingClientRect();
    Object.assign(root.style, {
      position: 'absolute', inset: 'auto', left: `${bounds.left - parent.left - (dialog.clientLeft || 0)}px`, top: `${bounds.top - parent.top - (dialog.clientTop || 0)}px`,
      width: `${bounds.width}px`, height: `${bounds.height}px`, minHeight: '0px', maxHeight: 'none', minWidth: '0px', maxWidth: 'none',
      margin: '0px', transform: 'none', transformOrigin: '0px 0px', overflow: 'hidden', opacity: '1', zIndex: '5', boxSizing: 'border-box', willChange: 'transform, opacity',
    });
    if (editor) for (const child of content.children) {
      const copy = copies[originals.indexOf(child)];
      if (!copy) continue;
      const rect = child.getBoundingClientRect();
      // Removing the editor must not give its flex space to the frozen voice
      // pane. Preserve that pane's viewport and its original scroll offset.
      Object.assign(copy.style, {
        position: 'absolute', inset: 'auto', margin: '0px',
        left: `${rect.left - bounds.left - (content.clientLeft || 0)}px`,
        top: `${rect.top - bounds.top - (content.clientTop || 0)}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
        minHeight: '0px', maxHeight: 'none', minWidth: '0px', maxWidth: 'none', boxSizing: 'border-box',
      });
    }
    const pane = editor ? content.querySelector?.('.inline-voice') : null;
    const frozenPane = pane ? copies[originals.indexOf(pane)] : null;
    const view = { root, content, dialog, bounds, scroll, animations: [], removed: false,
      anchor: editor ? { element: editor, selector: anchor, bounds: anchorBounds,
        pane: frozenPane ? { element: frozenPane, bounds: pane.getBoundingClientRect() } : null } : null };
    replacementViews.set(content, view);
    if (!replacementDialogs.has(dialog)) replacementDialogs.set(dialog, new Set());
    replacementDialogs.get(dialog).add(view);
    if (!replacementListeners.has(dialog)) {
      replacementListeners.add(dialog);
      dialog.addEventListener('close', () => clearReplacements(dialog));
    }
    return view;
  }
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
  function plan(dialog, state, openingVisual = null, returning = false) {
    // Reading and editing screens are navigation destinations. A horizontal
    // push has no modal fade or vertical sheet motion, regardless of opener.
    if (isNavigationPage(dialog)) return {
      frames: [
        { transform: `translateX(${state.target.width}px)`, opacity: 1, '--detail-progress': '0' },
        { transform: 'translateX(0px)', opacity: 1, '--detail-progress': '1' },
      ], parts: [], reveals: [], card: false,
    };
    if (state.kind === 'chat') {
      const mobile = innerWidth < 768;
      // A full-screen conversation travels out of the viewport on return. A
      // 28px fade on this surface looks like the whole page was just removed.
      const distance = Math.max(state.target.height, innerHeight - state.target.top);
      return { frames: [
        { transform: mobile ? `translateY(${distance}px)` : 'translateY(28px) scale(.985)', opacity: mobile ? 1 : 0, '--detail-progress': '0' },
        { transform: 'translateY(0px)', opacity: 1, '--detail-progress': '1' },
      ], parts: [], reveals: [], card: false, duration: mobile ? 420 : 300, exitDuration: mobile ? 320 : 220 };
    }
    const source = resolveVisualSource(state);
    const visual = openingVisual || captureVisual(source);
    const target = state.target;
    const hero = dialog.querySelector?.('.card-detail-hero') || dialog.querySelector?.('.parking-detail');
    const scroller = dialog.querySelector?.('#sheet-content');
    // A scrolled page closes back through its hero. Only the modal scroller moves;
    // the dashboard remains at the same scroll position behind it.
    const returningScroll = returning && visual ? scroller?.scrollTop || 0 : 0;
    if (returningScroll) scroller.scrollTop = 0;
    const shared = visual && (hero || dialog.classList?.contains('card-page'));
    const geometry = shared && cardGeometry(visual.rect, target, visual.radius, parseFloat(getComputedStyle(dialog).borderRadius) || 0);
    if (geometry) {
      const layered = visual.snapshot && hero?.children;
      if (layered) {
        dialog.append(visual.snapshot.root);
        (state.layers ||= []).push(visual.snapshot.root);
      }
      const parts = layered ? snapshotTracks(visual.snapshot, visual, hero, target) : [...(hero?.querySelectorAll?.('[data-card-part]') || [])].flatMap(element => {
        const name = element.dataset.cardPart;
        const from = visual.parts.get(name);
        if (!from) return [];
        const a = from.rect, b = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const base = style.transform === 'none' ? '' : style.transform;
        const art = name === 'art' || element.matches?.('svg');
        const scale = art && b.width > 0 && b.height > 0 ? Math.min(a.width / b.width, a.height / b.height) : 1;
        const start = {
          transform: `translate(${a.left - b.left - geometry.x}px, ${a.top - b.top - geometry.y}px)${art ? ` scale(${scale})` : ''} ${base}`.trim(),
          transformOrigin: '0px 0px', opacity: from.opacity,
        };
        const end = { transform: base || 'none', transformOrigin: '0px 0px', opacity: style.opacity };
        // Text never gets stretched. If the expanded hero changes type size, the
        // browser lays the type out at each size instead of scaling its glyphs.
        if (!art && parseFloat(from.fontSize) > 0 && parseFloat(style.fontSize) > 0) {
          start.fontSize = from.fontSize; end.fontSize = style.fontSize;
        }
        return [{ element, returningScroll, frames: [start, end] }];
      });
      if (layered && returning) for (const track of parts) if (track.key?.startsWith('origin:')) {
        Object.assign(track.element.style, track.frames[1]);
      }
      if (layered) for (const track of parts) if (track.key?.startsWith('hero:')) track.returningScroll = returningScroll;
      const reveals = [...(dialog.querySelectorAll?.('[data-card-reveal], .sheet-header') || [])].map(element => ({ element, returningScroll: element.hasAttribute?.('data-card-reveal') ? returningScroll : 0, frames: [
        { opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0px)' },
      ] }));
      return { frames: geometry.frames, parts, reveals, card: true };
    }
    const sheet = dialog.dataset.sheetSurface === 'sheet';
    const bottomSheet = sheet && innerWidth < 700;
    return { frames: [
      { transform: bottomSheet ? `translateY(${target.height}px)` : sheet ? 'translateY(18px) scale(.98)' : state.kind === 'voice' ? 'translateY(28px) scale(.98)' : 'translateY(28px)', opacity: bottomSheet ? 1 : 0, '--detail-progress': '0' },
      { transform: 'translateY(0px)', opacity: 1, '--detail-progress': '1' },
    ], parts: [], reveals: [], card: false };
  }
  function run(dialog, state, motion, closing = false, current = null) {
    const duration = closing ? motion.exitDuration || 340 : motion.duration || (motion.card ? 460 : dialog.dataset.sheetSurface === 'sheet' ? 400 : 320);
    const options = { duration, easing, fill: 'both' };
    clearFrozen(state);
    if (motion.card) dialog.dataset.cardMotion = 'true';
    state.tracks = [];
    for (const track of [...motion.parts, ...motion.reveals]) {
      if (!track.element.isConnected) continue;
      const revealing = motion.reveals.includes(track);
      const sampled = current?.get(track.key) || current?.get(track.element);
      const saved = sampled && Object.fromEntries(Object.keys(track.frames[1]).filter(key => sampled[key] != null).map(key => [key, sampled[key]]));
      let frames = track.keyframes ? track.keyframes.map(frame => ({ ...frame })) : track.frames.map(frame => ({ ...frame }));
      if (closing) frames = frames.reverse().map(frame => Object.hasOwn(frame, 'offset') ? { ...frame, offset: 1 - frame.offset } : frame);
      frames[0] = { ...frames[0], ...(saved || (closing ? readFrame(track.element, track.frames[1]) : {})) };
      if (closing && track.returningScroll) {
        const shifted = frame => ({ ...frame, transform: `translateY(${-track.returningScroll}px) ${frame.transform === 'none' ? '' : frame.transform || ''}`.trim() });
        // Resetting the scroller exposes the hero for its return animation. Keep
        // its shared parts at their pre-reset positions in the first frame, then
        // let them travel to their card positions. The old body stays displaced
        // for both frames of its shorter fade. Fixed headers are never shifted.
        frames = revealing ? frames.map(shifted) : [shifted(frames[0]), ...frames.slice(1)];
      }
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
    const frames = new Map([[dialog, readFrame(dialog, state.motion.frames[1])]]);
    for (const track of [...state.motion.parts, ...state.motion.reveals].filter(t => t.element.isConnected)) {
      const frame = readFrame(track.element, track.frames[1]);
      frames.set(track.element, { ...frames.get(track.element), ...frame });
      if (track.key) frames.set(track.key, frame);
    }
    return frames;
  }
  function settleOpening(dialog, state) {
    cancel(state); clearFrozen(state); removeLayers(state);
    if (state) { state.animation = null; state.tracks = []; }
    dialog.removeAttribute('data-card-motion'); clearDrag(dialog);
    const pending = state?.pendingUpdate;
    if (state) state.pendingUpdate = null;
    if (dialog.open && !state?.closing) pending?.();
  }
  function finishOpening(dialog, state, animation) {
    animation.finished.then(() => {
      if (states.get(dialog) !== state || state.animation !== animation || state.closing) return;
      settleOpening(dialog, state);
    }).catch(() => {});
  }
  function show(dialog, { source = document.activeElement, kind = 'sheet' } = {}) {
    const previous = states.get(dialog);
    if (dialog.open && previous && !previous.closing) {
      if (!previous.animation && !previous.frozen) {
        previous.kind = kind;
        previous.target = dialog.getBoundingClientRect();
        // Build return geometry lazily after the next edit, keeping the first
        // opener as the destination and avoiding detached card layers here.
        previous.motion = null;
        dialog.dataset.presentation = kind;
      }
      return;
    }
    const current = previous?.closing ? snapshot(dialog, previous) : null;
    cancel(previous); clearFrozen(previous); removeLayers(previous); clearDrag(dialog);
    // Read the origin before the top-layer modal changes focus/inertness.
    const openingVisual = captureVisual(source);
    const state = { source: captureControl(source), sourceRoot: source?.closest('dialog') || document, kind, animation: null, tracks: [], closing: null };
    states.set(dialog, state);
    openOrder = openOrder.filter(view => view !== dialog && view.open);
    openOrder.push(dialog);
    dialog.dataset.presentation = kind;
    dialog.removeAttribute('data-closing'); dialog.removeAttribute('data-card-motion');
    if (!dialog.open) dialog.showModal();
    state.target = dialog.getBoundingClientRect();
    state.motion = plan(dialog, state, openingVisual);
    if (!reducedMotion()) finishOpening(dialog, state, run(dialog, state, state.motion, false, current));
  }
  function dismiss(dialog, { dragOffset = 0 } = {}) {
    if (!dialog.open) return Promise.resolve();
    clearReplacements(dialog);
    const state = states.get(dialog) || { kind: 'sheet', tracks: [] };
    if (state.closing) return state.closing;
    states.set(dialog, state);
    const current = snapshot(dialog, state);
    cancel(state); clearDrag(dialog);
    // Resolve the source again after rerenders or editing. Even a nested card
    // page without shared hero parts can return its surface to the same origin.
    if (state.kind === 'chat' || !state.animation && !dragOffset) {
      state.target = dialog.getBoundingClientRect();
      state.motion = plan(dialog, state, null, true);
    }
    state.motion ||= plan(dialog, state, null, true);
    dialog.dataset.closing = 'true';
    state.closing = (async () => {
      if (!reducedMotion()) {
        const animation = run(dialog, state, state.motion, true, current);
        try { await animation.finished; } catch {
          // Reopening owns a new state. Other cancellations must still release
          // modal focus and temporary styles instead of leaving a stuck exit.
          if (states.get(dialog) !== state) return;
        }
      }
      if (states.get(dialog) !== state) return;
      dialog.close(); cancel(state); clearFrozen(state); removeLayers(state);
      dialog.removeAttribute('data-closing'); dialog.removeAttribute('data-card-motion'); clearDrag(dialog);
      states.delete(dialog);
      const source = resolveSource(state);
      source?.focus({ preventScroll: true });
    })();
    return state.closing;
  }
  function replace(content, { back = false, level = false, vertical = false, previous = null } = {}) {
    const dialog = content.closest?.('dialog');
    if (dialog) clearReplacements(dialog, previous);
    content.getAnimations().forEach(animation => animation.cancel());
    const snapshot = previous && !previous.removed && previous.content === content && previous.dialog === dialog ? previous : null;
    if (previous && previous !== snapshot) removeReplacement(previous);
    if (reducedMotion() || dialog && !dialog.open) { removeReplacement(snapshot); return; }
    if (snapshot) {
      const target = content.getBoundingClientRect();
      if (vertical && ['left', 'top', 'width', 'height'].every(key => Math.abs(target[key] - snapshot.bounds[key]) < 1)) {
        removeReplacement(snapshot); return;
      }
      const bounds = dialog.getBoundingClientRect();
      snapshot.root.style.left = `${snapshot.bounds.left - bounds.left - (dialog.clientLeft || 0)}px`;
      snapshot.root.style.top = `${snapshot.bounds.top - bounds.top - (dialog.clientTop || 0)}px`;
      dialog.append(snapshot.root);
      for (const { element, top, left } of snapshot.scroll) { element.scrollTop = top; element.scrollLeft = left; }
      const distance = snapshot.bounds.width;
      snapshot.contentZ = content.style.zIndex || '';
      content.style.zIndex = back ? '1' : '2';
      snapshot.root.style.zIndex = back ? '2' : '1';
      if (vertical && snapshot.anchor) {
        const editor = content.querySelector?.(snapshot.anchor.selector);
        const rail = editor?.getBoundingClientRect();
        if (editor !== snapshot.anchor.element || !rail || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(rail[key])) ||
            rail.width <= 0 || rail.height <= 0) { removeReplacement(snapshot); return; }
        const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
        const collapsing = back || target.height < snapshot.bounds.height - 1;
        const options = { duration: collapsing ? 240 : 280, easing, fill: 'both' };
        // Both layouts keep the real editor in place. The outgoing surface
        // stops above it at every frame; it contains no second editor at all.
        const old = snapshot.bounds;
        const boundary = Math.min(snapshot.anchor.bounds.top, rail.top);
        const bottom = clamp(old.top + old.height - boundary, old.height);
        const oldClip = `inset(0px 0px ${bottom}px 0px)`;
        const endTop = clamp(target.top - old.top, old.height - bottom);
        const collapsedClip = `inset(${endTop}px 0px ${bottom}px 0px)`;
        snapshot.root.style.clipPath = oldClip;
        content.style.zIndex = '1';
        snapshot.root.style.zIndex = '2';
        const outgoing = collapsing ? [
          { clipPath: oldClip, opacity: 1 },
          { clipPath: collapsedClip, opacity: 0 },
        ] : [
          { clipPath: oldClip, opacity: 1 },
          { clipPath: oldClip, opacity: 0 },
        ];
        // Only the form's upper boundary changes. Never fade or translate the
        // ancestor of the focused textarea, even for the first reveal frame.
        if (!collapsing) {
          const top = clamp(Math.min(old.top, rail.top) - target.top, target.height);
          const style = getComputedStyle(content);
          const radius = Math.max(0, parseFloat(style.borderRadius || style.getPropertyValue('border-radius')) || 0);
          const railInset = Math.max(0, rail.top - target.top - top);
          const cornerLimit = inset => inset + railInset + Math.sqrt(2 * inset * railInset);
          // Match the real surface's corners without shaving the editor's top
          // corners in unusually tight layouts. As the edge rises, it has room
          // to reach the full form radius while the editor remains stationary.
          const startRadius = Math.min(radius,
            cornerLimit(Math.max(0, rail.left - target.left)),
            cornerLimit(Math.max(0, target.left + target.width - rail.left - rail.width)));
          snapshot.animations.push(content.animate([
            { clipPath: `inset(${top}px 0px 0px 0px round ${startRadius}px)` },
            { clipPath: `inset(0px 0px 0px 0px round ${radius}px)` },
          ], options));
        }
        snapshot.animations.push(snapshot.root.animate(outgoing, options));
        const pane = collapsing ? snapshot.anchor.pane?.element : content.querySelector?.('.inline-voice');
        const paneBounds = collapsing ? snapshot.anchor.pane?.bounds : pane?.getBoundingClientRect();
        if (pane && !pane.hidden && paneBounds?.width > 0 && paneBounds.height > 0) {
          const distance = collapsing ? Math.max(0, target.top - old.top) : Math.max(0, old.top - target.top);
          const cutoff = Math.max(0, paneBounds.top + paneBounds.height - boundary);
          const shifted = { transform: `translateY(${distance}px)`, clipPath: `inset(0px 0px ${cutoff + distance}px 0px)` };
          const settled = { transform: 'translateY(0px)', clipPath: `inset(0px 0px ${cutoff}px 0px)` };
          // Let the voice header travel with the rounded reveal edge. The
          // inverse bottom clip keeps this translated pane above the live
          // editor instead of letting its buttons slide across the draft.
          snapshot.animations.push(pane.animate(collapsing ? [settled, shifted] : [shifted, settled], options));
        }
        Promise.all(snapshot.animations.map(animation => animation.finished)).then(() => removeReplacement(snapshot), () => removeReplacement(snapshot));
        return;
      }
      if (vertical) {
        // Finishing dictation also collapses the panel, while the logical voice
        // mode remains open. Direction follows geometry as well as navigation.
        const collapsing = back || target.height < snapshot.bounds.height - 1;
        content.style.zIndex = collapsing ? '1' : '2';
        snapshot.root.style.zIndex = collapsing ? '2' : '1';
        const style = getComputedStyle(content);
        const radius = Math.max(0, parseFloat(style.borderRadius || style.getPropertyValue('border-radius')) || 0);
        const full = `inset(0px 0px 0px 0px round ${radius}px)`;
        const intersection = (outer, inner) => {
          const clamp = (value, max) => Math.max(0, Math.min(max, value));
          const top = clamp(inner.top - outer.top, outer.height);
          const right = clamp(outer.left + outer.width - inner.left - inner.width, outer.width);
          const bottom = clamp(outer.top + outer.height - inner.top - inner.height, outer.height);
          const left = clamp(inner.left - outer.left, outer.width);
          return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
        };
        const incoming = collapsing ? [
          { opacity: 0, offset: 0 }, { opacity: 0, offset: .5 }, { opacity: 1, offset: 1 },
        ] : [
          { clipPath: intersection(target, snapshot.bounds), opacity: .35 },
          { clipPath: full, opacity: 1 },
        ];
        const outgoing = collapsing ? [
          { clipPath: full, opacity: 1, offset: 0 },
          { clipPath: intersection(snapshot.bounds, target), opacity: 1, offset: .85 },
          { clipPath: intersection(snapshot.bounds, target), opacity: 0, offset: 1 },
        ] : [{ opacity: 1, offset: 0 }, { opacity: 0, offset: .5 }, { opacity: 0, offset: 1 }];
        const options = { duration: collapsing ? 240 : 280, easing, fill: 'both' };
        snapshot.animations = [content.animate(incoming, options), snapshot.root.animate(outgoing, options)];
        Promise.all(snapshot.animations.map(animation => animation.finished)).then(() => removeReplacement(snapshot), () => removeReplacement(snapshot));
        return;
      }
      const incoming = level ? [{ opacity: .55 }, { opacity: 1 }] : [
        { opacity: 1, transform: `translateX(${back ? -distance * .24 : distance}px)` },
        { opacity: 1, transform: 'translateX(0px)' },
      ];
      const outgoing = level ? [{ opacity: 1 }, { opacity: 0 }] : [
        { opacity: 1, transform: 'translateX(0px)' },
        { opacity: back ? 1 : .7, transform: `translateX(${back ? distance : -distance * .24}px)` },
      ];
      const options = { duration: level ? 150 : 320, easing, fill: 'both' };
      snapshot.animations = [content.animate(incoming, options), snapshot.root.animate(outgoing, options)];
      Promise.all(snapshot.animations.map(animation => animation.finished)).then(() => removeReplacement(snapshot), () => removeReplacement(snapshot));
      return;
    }
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
      if (drag || isNavigationPage(dialog) || event.isPrimary === false || event.button !== 0 || dialog.dataset.closing || event.target.closest('button') ||
        !event.target.closest('.sheet-handle, .sheet-header, .chat-header, .voice-panel > header, .parking-detail, .card-detail-hero') ||
        (event.target.closest('.parking-detail, .card-detail-hero') && dialog.querySelector('#sheet-content')?.scrollTop > 0)) return;
      event.preventDefault();
      const state = states.get(dialog);
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
        // A tap is not a transition. Allocate the return snapshot only after
        // the pointer actually moves, so header taps cannot leave hidden layers.
        if (drag.state && !drag.state.animation) {
          removeLayers(drag.state);
          drag.state.target = dialog.getBoundingClientRect();
          drag.state.motion = plan(dialog, drag.state, null, true);
        }
        // Keep the rendered position if the user catches the entrance mid-flight.
        const current = snapshot(dialog, drag.state);
        drag.base = current?.get(dialog);
        cancel(drag.state);
        if (drag.state) {
          drag.state.animation = null; drag.state.tracks = []; drag.state.frozen = new Map();
          current?.forEach((frame, element) => {
            if (element === dialog || !element?.style) return;
            const properties = ['transform', 'opacity', ...(frame.fontSize ? ['font-size'] : []), ...(frame.transformOrigin ? ['transform-origin'] : [])];
            drag.state.frozen.set(element, new Map(properties.map(key => [key, element.style.getPropertyValue(key)])));
            for (const key of properties) {
              const value = frame[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
              if (value != null) element.style.setProperty(key, value);
            }
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
  const deferUpdate = (dialog, update) => {
    const state = states.get(dialog);
    if (!dialog.open || !state || !(state.animation || state.frozen || state.closing)) return false;
    if (!state.closing) state.pendingUpdate = update;
    return true;
  };
  const settle = dialog => {
    clearReplacements(dialog);
    const state = states.get(dialog);
    if (state?.closing) { state.animation?.finish?.(); return; }
    if (state && !state.closing) { state.pendingUpdate = null; settleOpening(dialog, state); }
  };
  const topDialog = () => openOrder.filter(dialog => dialog.open && !dialog.dataset.closing).at(-1) || null;
  return { show, dismiss, captureReplacement, replace, pullToDismiss, topDialog, deferUpdate, settle };
}
