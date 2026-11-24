const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const tactile = '.spring-control, .mori-sheet button';
const actionButtons = '.dock-action, .dash-spotlight-action, .ask-send, .thread-send, .sheet-primary, .task-action-primary, .schedule-new';
const askMotions = new WeakMap();
const controlledAnimations = new Set();

function animate(element, frames, options) {
  if (reduceMotion.matches || !element?.animate) return;
  const animation = element.animate(frames, options);
  controlledAnimations.add(animation);
  animation.finished.then(() => controlledAnimations.delete(animation), () => controlledAnimations.delete(animation));
  return animation;
}

reduceMotion.addEventListener('change', () => {
  if (reduceMotion.matches) controlledAnimations.forEach(animation => animation.cancel());
});

export function bindTouchFeedback(root) {
  let press;
  root.addEventListener('pointerdown', event => {
    const control = event.target.closest(tactile);
    if (!control || control.disabled || !event.isPrimary || event.button !== 0 || reduceMotion.matches) return;
    press?.control.classList.remove('is-pressed');
    control.classList.add('is-pressed');
    press = { control, id: event.pointerId, intensity: event.pointerType === 'touch' ? .95 : .97 };
  });

  function release(event) {
    if (press?.id !== event.pointerId) return;
    const { control, intensity } = press;
    press = null;
    control.classList.remove('is-pressed');
    const releasedOn = document.elementFromPoint(event.clientX, event.clientY);
    if (event.type === 'pointerup' && control.isConnected && control.contains(releasedOn) && control.matches(actionButtons)) {
      animate(control, [
        { scale: intensity }, { scale: 1.014, offset: .66 }, { scale: 1 }
      ], { duration: 210, easing: 'cubic-bezier(.2,.75,.23,1)' });
    }
  }

  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => {
    press?.control.classList.remove('is-pressed');
    press = null;
  });
}

export function playThreadReply(turn) {
  animate(turn, [{ opacity: .45, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], {
    duration: 250, easing: 'cubic-bezier(.22,.76,.23,1)'
  });
}

export function playAskTransition(panel, trigger, { open, enabled = true }) {
  const previous = askMotions.get(panel);
  const content = panel.querySelector('.ask-content');
  const sampled = previous && {
    transform: getComputedStyle(panel).transform,
    borderRadius: getComputedStyle(panel).borderRadius,
    backgroundColor: getComputedStyle(panel).backgroundColor,
  };
  const sampledOpacity = previous && getComputedStyle(content).opacity;
  previous?.surface.cancel();
  previous?.content?.cancel();
  askMotions.delete(panel);
  if (!enabled || reduceMotion.matches || !panel.animate) return null;

  const resting = panel.getBoundingClientRect();
  if (!resting.width || !resting.height) return null;
  const control = trigger?.getBoundingClientRect();
  const origin = control?.width && control.height ? control : {
    left: resting.right - 48, top: resting.bottom - 44, width: 48, height: 44
  };
  const sx = origin.width / resting.width;
  const sy = origin.height / resting.height;
  const shellStyle = getComputedStyle(panel);
  const radius = parseFloat(trigger ? getComputedStyle(trigger).borderRadius : '') || 14;
  const collapsed = {
    transform: `translate(${origin.left - resting.left}px, ${origin.top - resting.top}px) scale(${sx}, ${sy})`,
    borderRadius: `${radius / sx}px / ${radius / sy}px`,
    backgroundColor: shellStyle.getPropertyValue('--accent').trim() || shellStyle.backgroundColor,
  };
  const expanded = { transform: 'none', borderRadius: shellStyle.borderRadius, backgroundColor: shellStyle.backgroundColor };
  const surface = animate(panel, open ? [sampled || collapsed, expanded] : [sampled || expanded, collapsed], {
    duration: open ? 470 : 320, easing: open ? 'cubic-bezier(.16,.78,.22,1)' : 'cubic-bezier(.42,0,.82,.56)',
  });
  if (!surface) return null;

  const reveal = animate(content, open
    ? [{ opacity: sampledOpacity || 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }]
    : [{ opacity: sampledOpacity || 1 }, { opacity: 0 }],
  { duration: open ? 245 : 130, delay: open && !previous ? 110 : 0, fill: 'both', easing: 'ease-out' });
  const motion = { surface, content: reveal };
  askMotions.set(panel, motion);
  const cleanup = () => {
    if (askMotions.get(panel) !== motion) return;
    askMotions.delete(panel);
    reveal?.cancel();
  };
  surface.finished.then(cleanup, cleanup);
  return surface;
}

export function playTabSelection(marker, previous, current) {
  animate(marker, [
    { transform: `translateX(${100 * previous}%)` },
    { transform: `translateX(${100 * current}%)` }
  ], { duration: 310, easing: 'cubic-bezier(.2,.76,.23,1)' });
}

export function playView(view, direction) {
  animate(view, [{ opacity: .72, transform: `translateX(${direction * 10}px)` }, { opacity: 1, transform: 'none' }], {
    duration: 290, easing: 'cubic-bezier(.2,.72,.23,1)'
  });
}

/* The document travels from Mori’s hands to its interactive file row. */
export function deliverFile(performer, { delay = 0 } = {}) {
  if (!performer || reduceMotion.matches) return;
  const avatar = performer.querySelector('.mori-avatar');
  const target = performer.querySelector('.thread-file-icon');
  if (!avatar || !target) return;
  const origin = avatar.getBoundingClientRect();
  const finish = target.getBoundingClientRect();
  if (!origin.width || !finish.width) return;
  const sheet = target.cloneNode(true);
  sheet.classList.add('mori-document-flight');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.style.opacity = '0';
  sheet.style.left = (origin.left + origin.width * .61) + 'px';
  sheet.style.top = (origin.top + origin.height * .61) + 'px';
  document.body.append(sheet);
  const dx = finish.left - origin.left - origin.width * .61;
  const dy = finish.top - origin.top - origin.height * .61;
  const duration = 535;
  const flight = animate(sheet, [
    { transform: 'translate(-20%, -26%) rotate(-18deg) scale(.8)', opacity: .82 },
    { transform: `translate(${dx * .6}px, ${dy * .46 - 13}px) rotate(9deg) scale(1.06)`, opacity: 1, offset: .62 },
    { transform: `translate(${dx}px, ${dy}px) rotate(0) scale(1)`, opacity: 1 }
  ], { duration, delay, easing: 'cubic-bezier(.24,.64,.21,1)' });
  if (!flight) { sheet.remove(); return; }
  const flightEnd = duration + delay;
  animate(target, [{ opacity: 0 }, { opacity: 0, offset: 1 - 125 / flightEnd }, { opacity: 1 }], { duration: flightEnd });
  const clean = () => sheet.remove();
  flight.finished.then(clean, clean);
}
