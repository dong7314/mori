// A frozen DOM copy keeps the card's original wrapping and icon sizes while
// the already-laid-out detail fades in. No raster assets or live controls.
export function captureCardSnapshot(source) {
  if (!source?.cloneNode) return null;
  const root = source.cloneNode(true);
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [root, ...root.querySelectorAll('*')];
  const parts = new Map();
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index], copy = copies[index];
    const computed = getComputedStyle(original);
    copy.style.cssText = Array.from(computed, name => `${name}:${computed.getPropertyValue(name)};`).join('');
    copy.style.setProperty('animation', 'none', 'important');
    copy.style.setProperty('transition', 'none', 'important');
    for (const { name } of [...copy.attributes]) {
      if (name === 'id' || name === 'tabindex' || name === 'autofocus' || name.startsWith('data-')) copy.removeAttribute(name);
    }
    if (original.dataset.cardPart) parts.set(original.dataset.cardPart, copy);
  }
  root.classList.add('card-transition-origin');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('inert', '');
  root.style.setProperty('pointer-events', 'none', 'important');
  const bounds = source.getBoundingClientRect();
  Object.assign(root.style, {
    position: 'absolute', inset: 'auto', left: '0px', top: '0px',
    width: `${bounds.width}px`, height: `${bounds.height}px`,
    minHeight: '0px', maxHeight: 'none', minWidth: '0px', maxWidth: 'none',
    margin: '0px', transform: 'none', transformOrigin: '0px 0px',
    overflow: 'visible', opacity: '0', zIndex: '4',
    background: 'transparent', boxShadow: 'none', borderColor: 'transparent',
  });
  return { root, parts, bounds };
}

export function snapshotTracks(snapshot, visual, hero, target) {
  snapshot.root.style.left = `${snapshot.bounds.left - visual.rect.left}px`;
  snapshot.root.style.top = `${snapshot.bounds.top - visual.rect.top}px`;
  const tracks = [];
  for (const element of hero.querySelectorAll('[data-card-part]')) {
    const name = element.dataset.cardPart, copy = snapshot.parts.get(name), source = visual.parts.get(name);
    if (!copy || !source) continue;
    const a = source.rect, b = element.getBoundingClientRect();
    const base = copy.style.transform === 'none' ? '' : copy.style.transform;
    const art = name === 'art';
    const scale = art && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 ? Math.min(b.width / a.width, b.height / a.height) : 1;
    const dx = b.left - target.left - (a.left - visual.rect.left);
    const dy = b.top - target.top - (a.top - visual.rect.top);
    tracks.push({ element: copy, key: `origin:${name}`, returningScroll: 0, frames: [
      { transform: base || 'none', transformOrigin: '0px 0px' },
      { transform: `translate(${dx}px, ${dy}px)${art ? ` scale(${scale})` : ''} ${base}`.trim(), transformOrigin: '0px 0px' },
    ] });
    const targetTransform = getComputedStyle(element).transform;
    const targetBase = targetTransform === 'none' ? '' : targetTransform;
    tracks.push({ element, key: `detail:${name}`, returningScroll: 0, frames: [
      { transform: `translate(${-dx}px, ${-dy}px)${art ? ` scale(${1 / scale})` : ''} ${targetBase}`.trim(), transformOrigin: '0px 0px' },
      { transform: targetBase || 'none', transformOrigin: '0px 0px' },
    ] });
  }
  tracks.push({ element: snapshot.root, key: 'origin', frames: [{ opacity: 1 }, { opacity: 0 }], keyframes: [
    { opacity: 1, offset: 0 }, { opacity: 0, offset: .68 }, { opacity: 0, offset: 1 },
  ] });
  for (const [index, element] of [...hero.children].entries()) tracks.push({
    element, key: `hero:${index}`, frames: [{ opacity: 0 }, { opacity: 1 }], keyframes: [
      { opacity: 0, offset: 0 }, { opacity: 0, offset: .08 }, { opacity: 1, offset: .72 }, { opacity: 1, offset: 1 },
    ],
  });
  return tracks;
}
