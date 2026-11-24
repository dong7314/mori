import { shiftScheduleDay } from './poc2-schedule.mjs';

const bindings = new WeakMap();

function adjacentGrid(grid, day, direction, renderPeriod) {
  const mode = grid.dataset.mode === 'month' ? 'month' : 'week';
  const selected = shiftScheduleDay(day, mode, direction);
  const template = document.createElement('template');
  template.innerHTML = renderPeriod(selected, mode);
  const preview = template.content.querySelector('.schedule-grid');
  if (!preview) return null;
  preview.classList.add('schedule-grid-preview');
  preview.setAttribute('aria-hidden', 'true');
  preview.inert = true;
  for (const node of preview.querySelectorAll('[id]')) node.removeAttribute('id');
  for (const button of preview.querySelectorAll('button')) {
    button.removeAttribute('data-action');
    button.setAttribute('tabindex', '-1');
  }
  return { grid: preview, selected };
}

/**
 * Bind once to the persistent main element. The returned function removes the
 * listeners and cancels an in-progress drag. onStep(direction, { animated: true })
 * runs after a committed snap; it should synchronously render the new period and
 * skip a second grid entrance animation. Calendar buttons remain independent.
 * renderPeriod(day, mode) returns the normal schedule markup with current data;
 * its date grid is reused so preview dates, selection and markers cannot drift.
 */
export function bindCalendarGesture(main, onStep, renderPeriod) {
  bindings.get(main)?.();
  let gesture = null;
  let suppressClickUntil = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const releaseCapture = current => {
    if (main.hasPointerCapture?.(current.id)) main.releasePointerCapture(current.id);
  };

  const clean = current => {
    if (gesture === current) gesture = null;
    current.animations?.forEach(animation => animation.cancel());
    releaseCapture(current);
    if (current.viewport?.isConnected) current.viewport.replaceWith(current.grid);
    if (current.focus?.isConnected && document.activeElement === document.body) {
      current.focus.focus({ preventScroll: true });
    }
  };

  const beginDrag = current => {
    const grid = current.grid;
    const selected = grid.querySelector('[aria-pressed="true"]')?.dataset.day;
    if (!selected || typeof renderPeriod !== 'function') return false;
    const previous = adjacentGrid(grid, selected, -1, renderPeriod);
    const next = adjacentGrid(grid, selected, 1, renderPeriod);
    if (!previous || !next) return false;
    const viewport = document.createElement('div');
    viewport.className = 'schedule-drag-viewport';
    viewport.dataset.dragging = 'true';
    const track = document.createElement('div');
    track.className = 'schedule-drag-track';
    current.focus = grid.contains(document.activeElement) ? document.activeElement : null;
    grid.before(viewport);
    viewport.append(track);
    track.append(previous.grid, grid, next.grid);
    const width = viewport.getBoundingClientRect().width;
    current.viewport = viewport;
    current.track = track;
    current.width = width;
    current.step = width + 16;
    current.heights = [previous.grid, grid, next.grid].map(node => node.getBoundingClientRect().height);
    current.available = [previous.selected !== selected, next.selected !== selected];
    current.locked = true;
    track.style.transform = `translate3d(${-current.step}px, 0, 0)`;
    viewport.style.height = `${current.heights[1]}px`;
    main.setPointerCapture?.(current.id);
    return true;
  };

  const position = (current, dx) => {
    const available = current.available[dx < 0 ? 1 : 0];
    const distance = Math.max(-current.step, Math.min(current.step, dx));
    const offset = available ? distance : distance * .16;
    const progress = Math.min(1, Math.abs(offset) / current.step);
    const targetHeight = current.heights[offset < 0 ? 2 : 0];
    current.offset = offset;
    current.height = current.heights[1] + (targetHeight - current.heights[1]) * progress;
    current.track.style.transform = `translate3d(${-current.step + offset}px, 0, 0)`;
    current.viewport.style.height = `${current.height}px`;
  };

  const settle = (current, direction = 0) => {
    if (!current.locked) { clean(current); return; }
    current.settling = true;
    current.viewport.dataset.dragging = 'false';
    suppressClickUntil = performance.now() + 450;
    releaseCapture(current);
    const target = -current.step - direction * current.step;
    const height = current.heights[direction ? direction + 1 : 1];
    const finish = () => {
      if (gesture !== current) return;
      const connected = current.viewport.isConnected && main.contains(current.viewport);
      clean(current);
      if (direction && connected) onStep(direction, { animated: true });
    };
    if (reducedMotion.matches || !current.track.animate) { finish(); return; }
    const duration = direction ? 240 : 190;
    const timing = { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' };
    current.animations = [
      current.track.animate([
        { transform: `translate3d(${-current.step + current.offset}px, 0, 0)` },
        { transform: `translate3d(${target}px, 0, 0)` },
      ], timing),
      current.viewport.animate([{ height: `${current.height}px` }, { height: `${height}px` }], timing),
    ];
    Promise.all(current.animations.map(animation => animation.finished)).then(finish, () => {});
  };

  const down = event => {
    if (event.isPrimary) suppressClickUntil = 0;
    if (event.pointerType !== 'touch') return;
    if (!event.isPrimary) { if (gesture) clean(gesture); return; }
    if (gesture?.settling) return;
    const grid = event.target.closest?.('.schedule-grid:not(.schedule-grid-preview)');
    if (!grid || !main.contains(grid)) return;
    if (gesture) clean(gesture);
    gesture = {
      id: event.pointerId, grid, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastAt: event.timeStamp, velocity: 0, offset: 0,
    };
  };

  const move = event => {
    const current = gesture;
    if (!current || current.id !== event.pointerId || current.settling) return;
    if (!current.grid.isConnected) { clean(current); return; }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.locked) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.1) { clean(current); return; }
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
      if (!beginDrag(current)) { clean(current); return; }
    }
    event.preventDefault();
    const elapsed = event.timeStamp - current.lastAt;
    if (elapsed > 0) current.velocity = (event.clientX - current.lastX) / elapsed;
    current.lastX = event.clientX;
    current.lastAt = event.timeStamp;
    position(current, dx);
  };

  const up = event => {
    const current = gesture;
    if (!current || current.id !== event.pointerId || current.settling) return;
    if (!current.locked) { clean(current); return; }
    event.preventDefault();
    const dx = event.clientX - current.x;
    position(current, dx);
    const direction = dx < 0 ? 1 : -1;
    const velocity = event.timeStamp - current.lastAt < 100 ? current.velocity : 0;
    const flick = Math.abs(dx) > 26 && Math.abs(velocity) > .45 && Math.sign(velocity) === Math.sign(dx);
    const committed = Math.abs(dx) >= Math.min(90, current.width * .24) || flick;
    settle(current, committed && current.available[direction > 0 ? 1 : 0] ? direction : 0);
  };

  const cancel = event => {
    if (gesture && (!event || gesture.id === event.pointerId) && !gesture.settling) settle(gesture);
  };
  const click = event => {
    if (performance.now() >= suppressClickUntil || event.detail === 0) return;
    // A drag must not activate the date that was initially under the finger.
    if (event.target.closest?.('.schedule-grid, .schedule-drag-viewport') || event.target === main) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClickUntil = 0;
    }
  };
  const key = event => { if (event.key === 'Escape' && gesture) cancel(); };
  const resize = () => { if (gesture) clean(gesture); };
  main.addEventListener('pointerdown', down, { passive: true });
  main.addEventListener('pointermove', move, { passive: false });
  main.addEventListener('pointerup', up, { passive: false });
  main.addEventListener('pointercancel', cancel);
  main.addEventListener('click', click, true);
  main.addEventListener('keydown', key);
  window.addEventListener('resize', resize);
  const cleanup = () => {
    if (gesture) clean(gesture);
    main.removeEventListener('pointerdown', down);
    main.removeEventListener('pointermove', move);
    main.removeEventListener('pointerup', up);
    main.removeEventListener('pointercancel', cancel);
    main.removeEventListener('click', click, true);
    main.removeEventListener('keydown', key);
    window.removeEventListener('resize', resize);
    bindings.delete(main);
  };
  bindings.set(main, cleanup);
  return cleanup;
}
