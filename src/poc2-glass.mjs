const reduceTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
const mobileDock = matchMedia('(width < 900px)');
const workspace = document.querySelector('.workspace');
const panels = [
  { selector: '.dock-request', surface: 'request', mobile: true, depth: 13 },
  { selector: '.dock-tabs', surface: 'tabs', mobile: true, depth: 15 },
  { selector: '.thread-composer', surface: 'thread', depth: 13 }
];

let engine;
let backdrop;
let starting;
let unavailable = false;
let frame;
let revision = 0;
let requestedRevision = -1;
let capturePending = false;
let snapshot;

const resize = new ResizeObserver(() => {
  updateLiquidGlass();
});
resize.observe(workspace);

function queueFrame() {
  if (frame === undefined) frame = requestAnimationFrame(render);
}

export function updateLiquidGlass() {
  revision++;
  queueFrame();
}

function getSceneElement() {
  return workspace.querySelector('.thread') ?? workspace;
}

async function captureScene() {
  // Capture the full transcript so scrolling only offsets the raster, without cloning it again.
  const source = getSceneElement();
  const bounds = source.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const version = revision;
  const view = document.body.dataset.view;
  requestedRevision = version;
  capturePending = true;
  try {
    const canvas = await engine.capture.captureToCanvas(source, bounds.width, bounds.height,
      [...source.querySelectorAll('.thread-footer')]);
    if (version === revision && canvas?.width && canvas.height) {
      snapshot = { canvas, source, view, width: bounds.width, height: bounds.height };
    }
  } finally {
    capturePending = false;
    queueFrame();
  }
}

function drawBackdrop() {
  const width = backdrop.clientWidth;
  const height = backdrop.clientHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (backdrop.width !== Math.round(width * dpr) || backdrop.height !== Math.round(height * dpr)) {
    backdrop.width = Math.round(width * dpr);
    backdrop.height = Math.round(height * dpr);
  }
  const context = backdrop.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = getComputedStyle(document.body).backgroundColor;
  context.fillRect(0, 0, width, height);
  if (snapshot?.source === getSceneElement() && snapshot.view === document.body.dataset.view) {
    const clip = workspace.getBoundingClientRect();
    const bounds = snapshot.source.getBoundingClientRect();
    context.save();
    context.beginPath();
    context.rect(clip.x, clip.y, clip.width, clip.height);
    context.clip();
    context.drawImage(snapshot.canvas, bounds.x, bounds.y, snapshot.width, snapshot.height);
    context.restore();
  }
  engine.markChanged(backdrop);
}

async function initialize() {
  const { LiquidGlass } = await import('./vendor/ybouane-liquidglass/index.mjs');
  const root = document.createElement('div');
  root.className = 'glass-scene';
  root.setAttribute('aria-hidden', 'true');
  backdrop = document.createElement('canvas');
  backdrop.className = 'glass-source';
  root.append(backdrop);
  for (const panel of panels) {
    panel.plane = document.createElement('div');
    panel.plane.className = 'glass-plane';
    panel.plane.dataset.surface = panel.surface;
    panel.plane.hidden = true;
    root.append(panel.plane);
  }
  document.body.append(root);
  try {
    engine = await LiquidGlass.init({
      root,
      glassElements: panels.map(panel => panel.plane),
      defaults: {
        blurAmount: .54,
        refraction: .48,
        chromAberration: .008,
        edgeHighlight: .08,
        specular: .022,
        fresnel: .30,
        shadowOpacity: .035,
        shadowSpread: 5,
        shadowOffsetY: 2
      }
    });
  } catch (error) {
    root.remove();
    throw error;
  }
}

function showPanel(panel, target) {
  if (panel.target !== target) {
    if (panel.target) {
      panel.target.classList.remove('has-glass-shader');
      resize.unobserve(panel.target);
    }
    if (target) resize.observe(target);
    panel.target = target;
  }
  if (!panel.plane) return false;
  const box = target?.getBoundingClientRect();
  if (!box?.width || !box.height || reduceTransparency.matches) {
    panel.plane.hidden = true;
    panel.plane.classList.remove('is-rendered');
    target?.classList.remove('has-glass-shader');
    return false;
  }
  const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius);
  panel.plane.hidden = false;
  Object.assign(panel.plane.style, {
    left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px',
    borderRadius: radius + 'px'
  });
  const config = JSON.stringify({ cornerRadius: radius, zRadius: panel.depth });
  if (panel.plane.dataset.config !== config) panel.plane.dataset.config = config;
  return true;
}

function render() {
  frame = undefined;
  const visible = [];
  const targets = panels.map(panel => panel.mobile && !mobileDock.matches ? null : document.querySelector(panel.selector));
  if (!starting && !unavailable && !reduceTransparency.matches && targets.some(Boolean)) {
    starting = initialize().then(queueFrame, error => {
      unavailable = true;
      console.warn('Mori LiquidGlass unavailable', error);
    });
  }
  panels.forEach((panel, i) => {
    if (showPanel(panel, targets[i])) visible.push(panel);
  });
  if (!engine || !visible.length) return;
  if (requestedRevision !== revision && !capturePending) {
    captureScene();
  }
  drawBackdrop();
  if (!snapshot) return;
  requestAnimationFrame(() => {
    for (const panel of visible) {
      if (panel.plane.hidden || !panel.target || !panel.target.isConnected) continue;
      if (panel.plane.classList.contains('is-rendered')) {
        panel.target.classList.add('has-glass-shader');
        continue;
      }
      const canvas = panel.plane.querySelector('canvas');
      if (!canvas?.width || !canvas.height) continue;
      const data = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      if (data[3]) {
        panel.plane.classList.add('is-rendered');
        panel.target.classList.add('has-glass-shader');
      }
    }
  });
}

window.addEventListener('scroll', queueFrame, { passive: true, capture: true });
window.addEventListener('resize', updateLiquidGlass);
mobileDock.addEventListener('change', updateLiquidGlass);
reduceTransparency.addEventListener('change', updateLiquidGlass);
new MutationObserver(updateLiquidGlass).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
