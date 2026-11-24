const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const tactile = '.spring-control, .mori-sheet button';
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

export function playThreadReply(turn) {
  animate(turn, [{ opacity: .45, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], {
    duration: 250, easing: 'cubic-bezier(.22,.76,.23,1)'
  });
}

export function playAskOpen(panel, trigger) {
  if (!panel || reduceMotion.matches) return;
  const bounds = panel.getBoundingClientRect();
  const button = trigger?.getBoundingClientRect();
  const towardButton = button ? Math.sign(button.left + button.width / 2 - bounds.left - bounds.width / 2) * 12 : 0;
  animate(panel, [
    { opacity: .45, transform: `translate(${towardButton}px, 13px) scale(.97)` },
    { opacity: 1, transform: 'none' }
  ], { duration: 315, easing: 'cubic-bezier(.18,.74,.23,1)' });
}

export function playTabSelection(marker, previous, current) {
  animate(marker, [
    { transform: `translateX(${100 * previous}%)` },
    { transform: `translateX(${100 * current}%)` }
  ], { duration: 310, easing: 'cubic-bezier(.2,.76,.23,1)' });
}

export function playView(view, direction) {
  animate(view, [{ opacity: .46, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'none' }], {
    duration: 290, easing: 'cubic-bezier(.2,.72,.23,1)'
  });
}

export function playAvatarAcceptance(scope) {
  for (const avatar of scope.querySelectorAll('.mori-avatar[data-mood="collecting"]')) {
    animate(avatar.querySelector('.mori-figure'), [
      { transform: 'none' },
      { transform: 'translateY(6%) rotate(-8deg) scale(1.06,.9)', offset: .39 },
      { transform: 'translateY(-4%) rotate(4deg)' },
      { transform: 'none' }
    ], { duration: 590, easing: 'cubic-bezier(.24,.72,.24,1)' });
    animate(avatar.querySelector('.mori-desk'), [
      { opacity: 0, transform: 'translate(-33%, -46%) rotate(-12deg) scale(.72)' },
      { opacity: 1, transform: 'translate(0,4%) rotate(2deg)', offset: .73 },
      { opacity: 0, transform: 'translate(20%, 5%) scale(.72)' }
    ], { duration: 545, fill: 'backwards', easing: 'cubic-bezier(.21,.69,.23,1)' });
  }
}

/* The document travels from Mori’s hands to its interactive file row. */
export function deliverFile(performer) {
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
  sheet.style.left = (origin.left + origin.width * .61) + 'px';
  sheet.style.top = (origin.top + origin.height * .61) + 'px';
  document.body.append(sheet);
  const dx = finish.left - origin.left - origin.width * .61;
  const dy = finish.top - origin.top - origin.height * .61;
  const flight = sheet.animate([
    { transform: 'translate(-20%, -26%) rotate(-18deg) scale(.8)', opacity: .82 },
    { transform: `translate(${dx * .6}px, ${dy * .46 - 13}px) rotate(9deg) scale(1.06)`, opacity: 1, offset: .62 },
    { transform: `translate(${dx}px, ${dy}px) rotate(0) scale(1)`, opacity: 1 }
  ], { duration: 590, easing: 'cubic-bezier(.24,.64,.21,1)' });
  controlledAnimations.add(flight);
  animate(target, [{ opacity: 0 }, { opacity: 0, offset: .74 }, { opacity: 1 }], { duration: 590 });
  flight.finished.then(cleanup, cleanup);
  function cleanup() {
    controlledAnimations.delete(flight);
    sheet.remove();
  }
}
