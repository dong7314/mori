// Motion follows visible UI changes; it never delays navigation or form submission.
export function createMotion(main) {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set();
  let observer;
  let previous;
  const ease = 'cubic-bezier(.22, 1, .36, 1)';

  function play(element, frames, options = {}) {
    if (!element || preference.matches || !element.animate) return;
    const animation = element.animate(frames, { duration: 480, easing: ease, ...options });
    active.add(animation);
    const release = () => active.delete(animation);
    animation.addEventListener('finish', release, { once: true });
    animation.addEventListener('cancel', release, { once: true });
    return animation;
  }

  function enter(element, delay = 0) {
    element?.classList.remove('motion-pending');
    play(element, [{ opacity: 0, translate: '0 18px' }, { opacity: 1, translate: '0 0' }], { delay, fill: 'backwards', duration: 650 });
  }

  function reset() {
    observer?.disconnect();
    for (const animation of active) animation.cancel();
    main.querySelectorAll('.motion-pending').forEach(element => element.classList.remove('motion-pending'));
  }

  function reveal(elements) {
    if (preference.matches) return;
    const items = [...elements];
    if (!('IntersectionObserver' in window)) { items.forEach((item, i) => enter(item, Math.min(i, 3) * 60)); return; }
    observer = new IntersectionObserver(entries => {
      entries.filter(entry => entry.isIntersecting).forEach((entry, i) => {
        observer.unobserve(entry.target);
        enter(entry.target, Math.min(i, 3) * 65);
      });
    }, { threshold: 0, rootMargin: '0px 0px -20px 0px' });
    items.forEach(item => { item.classList.add('motion-pending'); observer.observe(item); });
  }

  function capture() {
    return {
      month: main.querySelector('.month-heading h2')?.textContent,
      date: main.querySelector('.selected-day')?.dataset.value,
      filter: main.querySelector('.filter-tabs .active, .conversation-filters [aria-pressed="true"]')?.dataset.value,
      messages: new Set([...main.querySelectorAll('[data-message-id]')].map(item => item.dataset.messageId)),
      mode: main.querySelector('.voice-workspace') ? 'voice' : 'text',
    };
  }

  function render(scene) {
    const current = { ...capture(), scene };
    reset();
    if (previous?.scene !== scene) {
      // Observe siblings, never both a card and its parent, to avoid double movement.
      reveal(main.querySelectorAll('.page-intro, .conversation-detail-header, .context-widget, .daily-brief-card, .today-middle > section, .prepared-section .section-heading, .prepared-item, .discover-section .section-heading, .discover-card, .home-utilities, .conversation-search, .conversation-filters, .conversation-group, .conversation-empty, .conversation-panel, .calendar-layout > section, .filter-tabs, .memory-grid > article, .scheduled-jobs > .section-heading, .scheduled-job, .rules-section-heading, .simple-rules > article'));
    } else if (current.mode !== previous.mode) {
      enter(main.querySelector('.voice-workspace, .conversation-log'));
      play(main.querySelector('.mode-indicator'), [
        { transform: current.mode === 'voice' ? 'translateX(0)' : 'translateX(100%)' },
        { transform: current.mode === 'voice' ? 'translateX(100%)' : 'translateX(0)' },
      ], { duration: 340 });
    } else if (current.month !== previous.month) {
      play(main.querySelector('.calendar-grid'), [{ opacity: 0, translate: '0 8px' }, { opacity: 1, translate: '0 0' }], { duration: 300 });
    } else if (current.date !== previous.date) {
      enter(main.querySelector('.calendar-layout > section:last-child'));
      play(main.querySelector('.selected-day > span'), [{ scale: '.8' }, { scale: '1' }], { duration: 300 });
    } else if (current.filter !== previous.filter) {
      reveal(main.querySelectorAll('.memory-grid > article, .conversation-group, .conversation-empty'));
    } else {
      main.querySelectorAll('[data-message-id]').forEach(message => {
        if (!previous.messages.has(message.dataset.messageId)) enter(message);
      });
    }
    previous = current;
  }

  // Keyboard users should never land on an element waiting for a scroll reveal.
  main.addEventListener('focusin', event => {
    const pending = event.target.closest('.motion-pending');
    if (pending) { observer?.unobserve(pending); pending.classList.remove('motion-pending'); }
  });
  preference.addEventListener('change', reset);
  window.addEventListener('beforeprint', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });

  return { render, reset, enter };
}
