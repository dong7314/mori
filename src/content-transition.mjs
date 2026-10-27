// A local choice paints immediately, then its independent live items enter.
// The host keeps its natural layout and never needs visual copies.
export function createContentTransitions({ view, reduced = () => false }) {
  const operations = new Map();
  function finish(content, operation) {
    if (operations.get(content) !== operation) return;
    operations.delete(content);
    content.removeEventListener?.('focusin', operation.focus);
    for (const animation of operation.animations.values()) animation.cancel();
    operation.animations.clear();
    operation.resolve();
  }
  function transition(content, update, {
    targets = () => [{ element: content }], duration = 440, opacity = 0,
    distance = 14, scale = '.985', stagger = 32, maxDelay = 180,
  } = {}) {
    const previous = operations.get(content), painted = new Map();
    if (previous) {
      for (const element of previous.animations.keys()) {
        try {
          const style = view.getComputedStyle?.(element);
          if (style) painted.set(element, {
            opacity: style.opacity,
            translate: style.translate && style.translate !== 'none' ? style.translate : '0 0',
            scale: style.scale && style.scale !== 'none' ? style.scale : '1',
          });
        } catch { /* Optional continuity must never delay a selection. */ }
      }
      finish(content, previous);
    }
    try { update(); } catch (error) { return Promise.reject(error); }
    if (!content?.isConnected || reduced()) return Promise.resolve();
    let candidates;
    try {
      const seen = new Set();
      candidates = [...targets(content)].filter(target => {
        const element = target?.element;
        if (!element?.isConnected || seen.has(element)) return false;
        seen.add(element); return true;
      });
    } catch { return Promise.resolve(); }
    const items = candidates.filter(target => !candidates.some(parent =>
      parent !== target && parent.element.contains?.(target.element)));
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    const operation = { resolve, animations: new Map() };
    operation.focus = () => finish(content, operation);
    operations.set(content, operation);
    content.addEventListener?.('focusin', operation.focus);
    for (const [index, target] of items.entries()) {
      const element = target.element;
      if (typeof element.animate !== 'function') continue;
      const current = painted.get(element);
      const start = current ? {
        opacity: current.opacity || (target.opacity ?? opacity),
        translate: current.translate, scale: current.scale,
      } : {
        opacity: target.opacity ?? opacity,
        translate: `0 ${target.distance ?? distance}px`, scale: target.scale ?? scale,
      };
      let animation;
      try {
        animation = element.animate([start, { opacity: 1, translate: '0 0', scale: '1' }], {
          duration: target.duration ?? duration,
          delay: target.delay ?? Math.min(index * stagger, maxDelay),
          easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards',
        });
        operation.animations.set(element, animation);
        const release = () => {
          if (operations.get(content) !== operation || operation.animations.get(element) !== animation) return;
          operation.animations.delete(element);
          animation.cancel();
          if (!operation.animations.size) finish(content, operation);
        };
        animation.addEventListener('finish', release, { once: true });
        animation.addEventListener('cancel', release, { once: true });
      } catch {
        operation.animations.delete(element);
        animation?.cancel();
      }
    }
    if (!operation.animations.size) finish(content, operation);
    return completion;
  }
  function reset({ preserveConnected = false } = {}) {
    for (const [content, operation] of [...operations]) {
      if (!preserveConnected || !content.isConnected) finish(content, operation);
    }
  }
  return { transition, reset };
}
