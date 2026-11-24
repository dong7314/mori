const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const tactile = '.spring-control, .mori-sheet button, .sec-work-card, .sec-note-card--linked, .sec-filter, .sec-theme-option';
const controlledAnimations = new Set();

function animate(element, frames, options) {
  if (reduceMotion.matches || !element?.animate) return;
  const animation = element.animate(frames, options);
  controlledAnimations.add(animation);
  animation.finished.then(() => controlledAnimations.delete(animation), () => controlledAnimations.delete(animation));
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
    const rect = control.getBoundingClientRect();
    control.style.setProperty('--touch-x', (event.clientX - rect.left) + 'px');
    control.style.setProperty('--touch-y', (event.clientY - rect.top) + 'px');
    control.classList.add('is-pressed');
    press = { control, id: event.pointerId, intensity: event.pointerType === 'touch' ? .94 : .97 };
  });

  function release(event) {
    if (press?.id !== event.pointerId) return;
    const { control, intensity } = press;
    press = null;
    control.classList.remove('is-pressed');
    const releasedOn = document.elementFromPoint(event.clientX, event.clientY);
    if (event.type === 'pointerup' && control.isConnected && control.contains(releasedOn)) {
      animate(control, [
        { scale: intensity, offset: 0 }, { scale: 1.035, offset: .48 },
        { scale: .993, offset: .77 }, { scale: 1 }
      ], { duration: 310, easing: 'cubic-bezier(.19,.72,.28,1)' });
    }
  }

  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => {
    press?.control.classList.remove('is-pressed');
    press = null;
  });
}

function passFile(scene, mascot, easing) {
  if (reduceMotion.matches || !mascot) return;
  const destination = scene.querySelector('.result-icon');
  const tile = scene.querySelector('.delivery-copy');
  if (!destination || !tile) return;
  const stage = scene.getBoundingClientRect();
  const model = mascot.getBoundingClientRect();
  const file = destination.getBoundingClientRect();
  const fromX = model.x + model.width * .77 - stage.x - 18;
  const fromY = model.y + model.height * .45 - stage.y - 18;
  const toX = file.x - stage.x + (file.width - 38) / 2;
  const toY = file.y - stage.y + (file.height - 38) / 2;
  animate(tile, [
    { opacity: 0, transform: `translate(${fromX}px, ${fromY}px) rotate(12deg) scale(.58)` },
    { opacity: .98, transform: `translate(${fromX - 14}px, ${fromY - 9}px) rotate(5deg) scale(1.03)`, offset: .25 },
    { opacity: .9, transform: `translate(${toX}px, ${toY}px) rotate(0) scale(1)`, offset: .87 },
    { opacity: 0, transform: `translate(${toX}px, ${toY}px) scale(.9)` }
  ], { duration: 580, easing });
}

export function playMori(scene, beat, previous) {
  if (!scene || reduceMotion.matches) return;
  const target = scene.querySelector('.mascot-hit');
  if (previous && target) {
    const bounds = target.getBoundingClientRect();
    const x = previous.x + previous.width / 2 - bounds.x - bounds.width / 2;
    const y = previous.y + previous.height / 2 - bounds.y - bounds.height / 2;
    animate(target, [
      { transform: `translate(${x}px, ${y}px) scale(${previous.width / bounds.width})` },
      { transform: 'none' }
    ], { duration: 422, easing: 'cubic-bezier(.25,.75,.23,1)' });
  }
  const mascot = scene.querySelector('.mascot-pose');
  const shadow = scene.querySelector('.stage-shadow');
  const content = scene.querySelector('.conversation');
  const easing = 'cubic-bezier(.2,.79,.19,1)';
  const pose = {
    arrive: ['translateY(17px) scale(.9)', 'translateY(-7px) scale(1.025)', 'none'],
    listen: ['none', 'translate(3px, 5px) rotate(4deg) scale(1.018, .98)', 'none'],
    answer: ['none', 'translateY(12px) rotate(6deg) scale(1.05, .93)', 'translateY(-9px) rotate(-3deg) scale(.982, 1.035)', 'none'],
    ready: ['none', 'translateY(7px) scale(1.06,.94)', 'translate(-9px,-25px) rotate(-5deg) scale(.99,1.044)', 'translateY(3px) scale(1.025,.98)', 'none'],
  }[beat];
  if (!pose) return;
  animate(mascot, pose.map(transform => ({ transform })), { duration: beat === 'ready' ? 690 : 560, easing });
  if (beat === 'answer' || beat === 'ready') {
    animate(shadow, [{ scale: 1 }, { scale: .84, opacity: .56 }, { scale: 1, opacity: 1 }], { duration: 590, easing });
  }
  if (beat === 'ready') {
    passFile(scene, mascot, easing);
    animate(scene.querySelector('.result-file'), [
      { opacity: 0, transform: 'translateY(-20px) rotate(-3deg) scale(.92)' },
      { opacity: 1, transform: 'translateY(3px) rotate(.6deg) scale(1.012)', offset: .72 },
      { opacity: 1, transform: 'none' }
    ], { duration: 565, delay: 105, fill: 'backwards', easing });
  } else if (beat === 'arrive' || beat === 'answer') {
    animate(content, [{ opacity: .45, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing });
  } else {
    animate(scene.querySelector('.reply-editor'), [{ opacity: .5, transform: 'scale(.98) translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing });
  }
}

export function playView(view, direction) {
  animate(view, [{ opacity: .46, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], {
    duration: 290, easing: 'cubic-bezier(.2,.72,.23,1)'
  });
}
