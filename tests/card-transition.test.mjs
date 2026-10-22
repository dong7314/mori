import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { captureCardSnapshot, snapshotTracks } from '../src/card-transition.mjs';

const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Style {
  constructor(css = '') { this.cssText = css; }
  set cssText(value) {
    for (const name of this.values?.keys() || []) delete this[camel(name)];
    this.values = new Map(); this.priorities = new Map();
    for (const declaration of value.split(';')) {
      const separator = declaration.indexOf(':');
      if (separator > 0) this.setProperty(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
    }
  }
  get cssText() { return [...this.values].map(([name, value]) => `${name}:${value};`).join(''); }
  setProperty(name, value, priority = '') { this.values.set(name, value); this.priorities.set(name, priority); this[camel(name)] = value; }
  getPropertyValue(name) { return this[camel(name)] ?? this.values.get(name) ?? ''; }
  getPropertyPriority(name) { return this.priorities.get(name) || ''; }
}
class Element {
  constructor({ attrs = {}, css = {}, bounds = {}, children = [] } = {}) {
    this.attrs = new Map(Object.entries(attrs));
    this.dataset = Object.fromEntries(Object.entries(attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [camel(name.slice(5)), value]));
    this.style = new Style(); this.computed = { transform: 'none', ...css }; this.bounds = { left: 0, top: 0, width: 0, height: 0, ...bounds }; this.children = children;
    this.classList = { add: name => this.attrs.set('class', [this.attrs.get('class'), name].filter(Boolean).join(' ')), contains: name => this.attrs.get('class')?.split(' ').includes(name) || false };
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  removeAttribute(name) { this.attrs.delete(name); if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))]; }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return selector === '*' ? descendants : descendants.filter(child => Object.hasOwn(child.dataset, 'cardPart'));
  }
  getBoundingClientRect() { return { ...this.bounds }; }
  cloneNode() { return new Element({ attrs: Object.fromEntries(this.attrs), css: { ...this.computed }, bounds: this.bounds, children: this.children.map(child => child.cloneNode(true)) }); }
}
let originalComputedStyle;
beforeEach(() => {
  originalComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  globalThis.getComputedStyle = element => {
    const names = Object.keys(element.computed);
    return Object.assign(names, {
      transform: element.computed.transform,
      getPropertyValue: name => element.computed[name] || '',
    });
  };
});
afterEach(() => {
  if (originalComputedStyle) Object.defineProperty(globalThis, 'getComputedStyle', originalComputedStyle);
  else delete globalThis.getComputedStyle;
});

function fixture({ sourceArt = { left: 220, top: 240, width: 100, height: 80 }, targetArt = { left: 200, top: 160, width: 150, height: 120 } } = {}) {
  const title = new Element({ attrs: { 'data-card-part': 'title', id: 'parking-title' }, css: { 'font-size': '20px', 'line-height': '26px', 'white-space': 'normal', width: '150px' }, bounds: { left: 40, top: 230, width: 150, height: 52 } });
  const art = new Element({ attrs: { 'data-card-part': 'art', id: 'parking-art', 'data-countdown': 'live' }, css: { width: '100px', height: '80px' }, bounds: sourceArt });
  const source = new Element({ attrs: { class: 'brief-card parking', 'data-action': 'detail', 'data-ref': 'parking', tabindex: '0', autofocus: '' }, css: { display: 'block', padding: '20px', 'border-radius': '24px' }, bounds: { left: 20, top: 180, width: 340, height: 260 }, children: [title, art] });
  const targetTitle = new Element({ attrs: { 'data-card-part': 'title' }, css: { 'font-size': '28px' }, bounds: { left: 24, top: 120, width: 180, height: 72 } });
  const targetArtwork = new Element({ attrs: { 'data-card-part': 'art' }, bounds: targetArt });
  const hero = new Element({ children: [targetTitle, targetArtwork] });
  const snapshot = captureCardSnapshot(source);
  const visual = { rect: { left: 20, top: 180 }, parts: new Map([['title', { rect: title.getBoundingClientRect() }], ['art', { rect: art.getBoundingClientRect() }]]) };
  const target = { left: 0, top: 0 };
  return { source, title, art, hero, targetTitle, targetArtwork, snapshot, visual, target };
}

test('snapshot freezes the card typography and wrapping without changing the source', () => {
  const { source, title, snapshot } = fixture();
  const copy = snapshot.parts.get('title');
  assert.notEqual(snapshot.root, source);
  assert.notEqual(copy, title);
  for (const [property, value] of Object.entries(title.computed)) assert.equal(copy.style.getPropertyValue(property), value);
  assert.equal(copy.style.getPropertyValue('white-space'), 'normal');
  assert.equal(copy.style.getPropertyValue('width'), '150px');
  assert.equal(copy.style.getPropertyValue('line-height'), '26px');
  assert.equal(snapshot.root.style.width, '340px');
  assert.equal(snapshot.root.style.height, '260px');
  assert.equal(source.getAttribute('data-action'), 'detail');
  assert.equal(title.getAttribute('id'), 'parking-title');
  assert.equal(title.dataset.cardPart, 'title');
  assert.equal(title.style.cssText, '');
  assert.deepEqual(title.computed, { transform: 'none', 'font-size': '20px', 'line-height': '26px', 'white-space': 'normal', width: '150px' });
});

test('snapshot has no live actions, countdown hooks, ids or focus targets', () => {
  const { snapshot, source } = fixture();
  for (const copy of [snapshot.root, ...snapshot.root.querySelectorAll('*')]) {
    assert.ok(copy.attributes.every(({ name }) => name !== 'id' && name !== 'tabindex' && name !== 'autofocus' && !name.startsWith('data-')));
    assert.equal(copy.style.getPropertyValue('animation'), 'none');
    assert.equal(copy.style.getPropertyPriority('animation'), 'important');
    assert.equal(copy.style.getPropertyValue('transition'), 'none');
  }
  assert.equal(snapshot.root.getAttribute('aria-hidden'), 'true');
  assert.equal(snapshot.root.getAttribute('inert'), '');
  assert.equal(snapshot.root.style.getPropertyValue('pointer-events'), 'none');
  assert.equal(snapshot.root.classList.contains('card-transition-origin'), true);
  assert.equal(source.getAttribute('aria-hidden'), null);
  assert.equal(source.getAttribute('inert'), null);
  assert.equal(source.children[1].getAttribute('data-countdown'), 'live');
});

const translation = frame => {
  if (frame.transform === 'none') return { x: 0, y: 0 };
  const match = frame.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
  return { x: Number(match?.[1] || 0), y: Number(match?.[2] || 0) };
};
test('paired source and detail tracks meet at the same endpoints without font-size interpolation', () => {
  const { snapshot, visual, hero, target, title, targetTitle } = fixture();
  const tracks = snapshotTracks(snapshot, visual, hero, target);
  const origin = tracks.find(track => track.key === 'origin:title');
  const detail = tracks.find(track => track.key === 'detail:title');
  const a = title.getBoundingClientRect(), b = targetTitle.getBoundingClientRect();
  const endOrigin = translation(origin.frames[1]), startDetail = translation(detail.frames[0]);
  // The surface itself supplies the source viewport offset during expansion.
  assert.deepEqual({ x: a.left - visual.rect.left + endOrigin.x, y: a.top - visual.rect.top + endOrigin.y }, { x: b.left - target.left, y: b.top - target.top });
  assert.deepEqual({ x: b.left + startDetail.x + visual.rect.left, y: b.top + startDetail.y + visual.rect.top }, { x: a.left, y: a.top });
  for (const track of tracks) for (const frame of track.frames) assert.equal(Object.hasOwn(frame, 'fontSize'), false);
  assert.ok(origin.frames.every(frame => !frame.transform.includes('scale')));
  assert.ok(detail.frames.every(frame => !frame.transform.includes('scale')));
  assert.equal(detail.frames[1].transform, 'none');
});

test('artwork uses reciprocal uniform scales so the snapshot and detail share its proportions', () => {
  const { snapshot, visual, hero, target } = fixture();
  const tracks = snapshotTracks(snapshot, visual, hero, target);
  const origin = tracks.find(track => track.key === 'origin:art');
  const detail = tracks.find(track => track.key === 'detail:art');
  assert.match(origin.frames[1].transform, /scale\(1\.5\)/);
  assert.match(detail.frames[0].transform, /scale\(0\.6666666666666666\)/);
  assert.equal(origin.frames[0].transformOrigin, '0px 0px');
  assert.equal(detail.frames[1].transformOrigin, '0px 0px');
});

test('both fade layers reach their resting opacity before the expanding surface ends', () => {
  const { snapshot, visual, hero, target } = fixture();
  const tracks = snapshotTracks(snapshot, visual, hero, target);
  const layers = tracks.filter(track => track.key === 'origin' || track.key.startsWith('hero:'));
  assert.equal(layers.length, hero.children.length + 1);
  for (const layer of layers) {
    const final = layer.keyframes.at(-1), penultimate = layer.keyframes.at(-2);
    assert.equal(final.offset, 1);
    assert.ok(penultimate.offset < 1);
    assert.equal(penultimate.opacity, final.opacity);
  }
  assert.equal(layers.find(layer => layer.key === 'origin').keyframes.at(-1).opacity, 0);
  assert.ok(layers.filter(layer => layer.key.startsWith('hero:')).every(layer => layer.keyframes.at(-1).opacity === 1));
});

test('clipped source bounds preserve the snapshot offset and missing or empty artwork stays safe', () => {
  const { snapshot, visual, hero, target } = fixture({ sourceArt: { left: 220, top: 240, width: 0, height: 0 } });
  visual.rect = { left: 24, top: 200 };
  const tracks = snapshotTracks(snapshot, visual, hero, target);
  assert.equal(snapshot.root.style.left, '-4px');
  assert.equal(snapshot.root.style.top, '-20px');
  const art = tracks.filter(track => track.key.endsWith(':art'));
  assert.equal(art.length, 2);
  for (const track of art) for (const frame of track.frames) assert.doesNotMatch(frame.transform, /NaN|Infinity/);
  assert.match(art[0].frames[1].transform, /scale\(1\)/);
  visual.parts.delete('art');
  assert.equal(snapshotTracks(snapshot, visual, hero, target).some(track => track.key.endsWith(':art')), false);
  assert.equal(captureCardSnapshot(null), null);
});
