const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Discover by behavior so new detail pages, dialogs and nested lists opt in
// automatically, even before their content grows long enough to scroll.
export function discoverScrollAreas(doc) {
  return [...doc.querySelectorAll('body *')].filter(element =>
    element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    !element.closest('[data-overlay-scrollbar], .sheet-replacement-snapshot, .card-transition-origin') &&
    /^(auto|scroll|overlay)$/.test(doc.defaultView.getComputedStyle(element).overflowY));
}

export function scrollbarGeometry(viewport, content, offset, track, minimum = 24) {
  const max = Math.max(0, content - viewport), height = Math.max(0, track);
  if (max <= 1 || viewport <= 0 || height <= 0) return { visible: false, length: 0, position: 0, travel: 0, max: 0 };
  const length = Math.min(height, Math.max(minimum, height * viewport / content));
  const travel = height - length;
  return { visible: true, length, travel, max, position: travel * clamp(offset, 0, max) / max };
}

export function scrollOffsetForThumb(position, geometry) {
  return geometry.travel > 0 ? clamp(position / geometry.travel, 0, 1) * geometry.max : 0;
}

// Native scrolling owns wheel, touch, keyboard, focus and scroll restoration.
// Only its visual scrollbar is replaced; every indicator is outside layout flow.
export function installOverlayScrollbars({ document: doc = globalThis.document, includeViewport = true } = {}) {
  const view = doc.defaultView, entries = new Map();
  let frame = 0, rescan = true, destroyed = false;
  const queue = () => {
    if (destroyed || frame) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (rescan) { reconcile(); rescan = false; }
      for (const entry of entries.values()) sync(entry);
    });
  };
  const recheck = () => { rescan = true; queue(); };
  // Size animation only changes thumb geometry. Roster discovery is already
  // handled by DOM/style mutations and viewport changes; scanning every node
  // on each disclosure frame would compete with its layout and paint.
  const resize = new view.ResizeObserver(queue);

  function hostFor(target) {
    if (target === doc.scrollingElement) return doc.body;
    if (target.matches('dialog')) return target;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (view.getComputedStyle(parent).position !== 'static') return parent;
    }
    return doc.body;
  }

  function show(entry) {
    entry.track.classList.add('is-active');
    view.clearTimeout(entry.fade);
    if (!entry.drag) entry.fade = view.setTimeout(() => entry.track.classList.remove('is-active'), 800);
  }

  function mount(target) {
    const track = doc.createElement('div'), thumb = doc.createElement('i');
    track.className = 'overlay-scrollbar'; thumb.className = 'overlay-scrollbar-thumb';
    track.dataset.overlayScrollbar = ''; track.setAttribute('aria-hidden', 'true');
    track.dataset.scrollFor = target.id || target.classList[0] || target.tagName.toLowerCase();
    track.hidden = true; track.append(thumb);
    const entry = { target, track, thumb, geometry: null, drag: null, fade: 0 };
    const finish = () => { entry.drag = null; track.classList.remove('is-dragging'); show(entry); };
    const move = event => {
      if (entry.drag?.id !== event.pointerId || !entry.geometry) return;
      const rect = track.getBoundingClientRect(), scale = rect.height / track.offsetHeight || 1;
      target.scrollTop = scrollOffsetForThumb((event.clientY - rect.top) / scale - entry.drag.grab, entry.geometry);
      queue();
    };
    track.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !entry.geometry?.visible) return;
      event.preventDefault();
      const rect = track.getBoundingClientRect(), scale = rect.height / track.offsetHeight || 1;
      const pointer = (event.clientY - rect.top) / scale;
      const onThumb = event.target === thumb;
      entry.drag = { id: event.pointerId, grab: onThumb ? pointer - entry.geometry.position : entry.geometry.length / 2 };
      track.setPointerCapture(event.pointerId); track.classList.add('is-dragging'); show(entry); move(event);
    });
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', finish);
    track.addEventListener('lostpointercapture', finish);
    entry.enter = () => show(entry);
    target.addEventListener('pointerenter', entry.enter);
    target.classList.add('overlay-scroll-target');
    entries.set(target, entry); resize.observe(target);
  }

  function remove(entry) {
    view.clearTimeout(entry.fade); resize.unobserve(entry.target);
    entry.target.removeEventListener('pointerenter', entry.enter);
    entry.target.classList.remove('overlay-scroll-target');
    entry.track.remove(); entries.delete(entry.target);
  }

  function reconcile() {
    const targets = new Set(discoverScrollAreas(doc));
    if (includeViewport && doc.scrollingElement) targets.add(doc.scrollingElement);
    for (const [target, entry] of entries) if (!targets.has(target) || !target.isConnected) remove(entry);
    for (const target of targets) {
      if (!entries.has(target)) mount(target);
      else if (!target.classList.contains('overlay-scroll-target')) target.classList.add('overlay-scroll-target');
    }
  }

  function sync(entry) {
    const { target, track, thumb } = entry;
    const viewport = target === doc.scrollingElement;
    const rect = viewport ? { top: 0, left: 0, bottom: view.innerHeight, right: view.innerWidth } : target.getBoundingClientRect();
    const height = viewport ? view.innerHeight : target.clientHeight;
    const targetScaleX = viewport ? 1 : rect.width / target.offsetWidth || 1;
    const targetScaleY = viewport ? 1 : rect.height / target.offsetHeight || 1;
    const geometry = scrollbarGeometry(height, target.scrollHeight, target.scrollTop, height - 12);
    const top = rect.top + ((viewport ? 0 : target.clientTop) + 6) * targetScaleY;
    const bottom = top + (height - 12) * targetScaleY;
    let clipTop = 0, clipBottom = view.innerHeight;
    // A nested transcript or choice list must not paint over its clipped parent.
    for (let parent = target.parentElement; !viewport && parent; parent = parent.parentElement) {
      if (view.getComputedStyle(parent).overflowY !== 'visible') {
        const bounds = parent.getBoundingClientRect();
        clipTop = Math.max(clipTop, bounds.top); clipBottom = Math.min(clipBottom, bounds.bottom);
      }
    }
    const visible = geometry.visible && target.getClientRects().length > 0 && Math.min(bottom, clipBottom) > Math.max(top, clipTop) && rect.right > 0 && rect.left < view.innerWidth;
    if (track.hidden === visible) track.hidden = !visible;
    if (!visible) return;
    const host = hostFor(target);
    if (track.parentElement !== host) host.append(track);
    const hostRect = host.getBoundingClientRect();
    const scaleX = viewport ? 1 : hostRect.width / host.offsetWidth || 1;
    const scaleY = viewport ? 1 : hostRect.height / host.offsetHeight || 1;
    const left = viewport ? view.innerWidth - 12 : rect.left + (target.clientLeft + target.clientWidth - 12) * targetScaleX;
    const trackHeight = (height - 12) * targetScaleY / scaleY;
    entry.geometry = scrollbarGeometry(height, target.scrollHeight, target.scrollTop, trackHeight);
    track.style.position = viewport || host === doc.body ? 'fixed' : 'absolute';
    track.style.left = `${viewport || host === doc.body ? left : (left - hostRect.left) / scaleX + host.scrollLeft - host.clientLeft}px`;
    track.style.top = `${viewport || host === doc.body ? top : (top - hostRect.top) / scaleY + host.scrollTop - host.clientTop}px`;
    track.style.height = `${trackHeight}px`;
    track.style.clipPath = `inset(${Math.max(0, clipTop - top) / scaleY}px 0 ${Math.max(0, bottom - clipBottom) / scaleY}px 0)`;
    thumb.style.height = `${entry.geometry.length}px`;
    thumb.style.transform = `translateY(${entry.geometry.position}px)`;
  }

  const mutations = new view.MutationObserver(records => {
    const changes = records.filter(record => !record.target.closest?.('[data-overlay-scrollbar]') &&
      !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && node.hasAttribute('data-overlay-scrollbar'))));
    if (!changes.length) return;
    // Presentation motion changes inline transforms each frame. Refresh their
    // geometry without rescanning the entire app unless overflow itself changes.
    if (changes.some(record => record.attributeName !== 'style' ||
      /overflow\s*[-:]|overflow[XY]/i.test(`${record.oldValue || ''};${record.target.getAttribute('style') || ''}`))) rescan = true;
    queue();
  });
  mutations.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'data-theme'] });
  const onScroll = event => {
    const entry = entries.get(event.target === doc ? doc.scrollingElement : event.target);
    if (entry) show(entry);
    queue();
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  doc.addEventListener('input', queue, { passive: true });
  doc.addEventListener('load', queue, true);
  doc.addEventListener('transitionend', recheck, true);
  doc.addEventListener('animationend', recheck, true);
  view.addEventListener('resize', recheck, { passive: true });
  view.visualViewport?.addEventListener('resize', recheck, { passive: true });
  doc.fonts?.ready.then(queue);
  reconcile(); rescan = false; queue();

  return { refresh: queue, destroy() {
    destroyed = true; view.cancelAnimationFrame(frame); mutations.disconnect(); resize.disconnect();
    doc.removeEventListener('scroll', onScroll, true); doc.removeEventListener('input', queue); doc.removeEventListener('load', queue, true);
    doc.removeEventListener('transitionend', recheck, true); doc.removeEventListener('animationend', recheck, true);
    view.removeEventListener('resize', recheck); view.visualViewport?.removeEventListener('resize', recheck);
    for (const entry of [...entries.values()]) remove(entry);
  } };
}
