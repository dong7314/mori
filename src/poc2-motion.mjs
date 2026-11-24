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
        { scale: intensity, offset: 0 }, { scale: 1.023, offset: .48 },
        { scale: .995, offset: .77 }, { scale: 1 }
      ], { duration: 290, easing: 'cubic-bezier(.19,.72,.28,1)' });
    }
  }

  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => {
    press?.control.classList.remove('is-pressed');
    press = null;
  });
}

export function playThreadReply(avatar, turn, hasFile) {
  const easing = 'cubic-bezier(.22,.76,.23,1)';
  animate(avatar, [
    { transform: 'none' },
    { transform: 'translateY(2px) rotate(9deg) scale(1.04,.94)' },
    { transform: 'translateY(-3px) rotate(-3deg)' },
    { transform: 'none' }
  ], { duration: 425, easing });
  animate(turn, [{ opacity: .35, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], { duration: 270, easing });
  if (hasFile) animate(turn?.querySelector('.thread-file'), [
    { opacity: 0, transform: 'translateY(-8px) scale(.98)' },
    { opacity: 1, transform: 'none' }
  ], { duration: 340, delay: 100, fill: 'backwards', easing });
}

export function playView(view, direction) {
  animate(view, [{ opacity: .46, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], {
    duration: 290, easing: 'cubic-bezier(.2,.72,.23,1)'
  });
}
