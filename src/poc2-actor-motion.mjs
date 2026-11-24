/* Event-driven illustration gestures. Application task state remains the source
 * of truth; temporary poses and paper props are removed when each gesture ends.
 * Play functions return { finished: Promise<boolean>, cancel(), handoffAt } or
 * null. finished resolves false on interruption. Offer handoffAt is 165ms.
 */
const actors = new WeakMap();
const bindings = new WeakMap();
const contexts = new WeakMap();
const hoverTimes = new WeakMap();
const soft = 'cubic-bezier(.22,.76,.25,1)';

function contextFor(doc) {
  let context = contexts.get(doc);
  if (context) return context;
  const win = doc.defaultView;
  const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  context = { doc, win, media, sessions: new Set(), intent: null };
  contexts.set(doc, context);
  const stop = () => [...context.sessions].forEach(session => session.cancel());
  media?.addEventListener?.('change', event => { if (event.matches) stop(); });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) stop(); });
  return context;
}

function visible(avatar) {
  if (!avatar?.isConnected) return false;
  const rect = avatar.getBoundingClientRect();
  const win = avatar.ownerDocument.defaultView;
  return rect.width >= 24 && rect.height >= 24 && rect.bottom > 0 && rect.right > 0
    && rect.top < win.innerHeight && rect.left < win.innerWidth
    && win.getComputedStyle(avatar).visibility !== 'hidden';
}

function primaryAvatar(scope) {
  if (!scope) return null;
  const candidates = scope.matches?.('.mori-avatar') ? [scope] : [...scope.querySelectorAll?.('.mori-avatar') ?? []];
  return candidates.filter(visible).sort((a, b) => {
    const first = a.getBoundingClientRect(), second = b.getBoundingClientRect();
    return second.width * second.height - first.width * first.height;
  })[0] ?? null;
}

function run(avatar, kind, duration, priority, choreograph) {
  if (!visible(avatar)) return null;
  const context = contextFor(avatar.ownerDocument);
  const previous = actors.get(avatar);
  if (previous && previous.priority > priority) return null;
  if (previous?.kind === kind && Date.now() - previous.started < 180) return previous;
  previous?.cancel();
  if (context.media?.matches || typeof avatar.animate !== 'function') return null;

  let resolveFinished;
  let ended = false;
  const motions = new Set();
  const timers = new Set();
  const props = new Set();
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  function settle(completed) {
    if (ended) return;
    ended = true;
    timers.forEach(timer => context.win.clearTimeout(timer));
    motions.forEach(animation => animation.cancel());
    props.forEach(prop => prop.remove());
    delete avatar.dataset.actorMotion;
    delete avatar.dataset.actorPose;
    if (actors.get(avatar) === session) actors.delete(avatar);
    context.sessions.delete(session);
    resolveFinished(completed);
  }
  const session = {
    avatar, kind, priority, started: Date.now(), finished, handoffAt: kind === 'offer' ? 165 : null,
    cancel: () => settle(false),
    pose(value) { if (!ended) avatar.dataset.actorPose = value; },
    later(delay, callback) {
      const timer = context.win.setTimeout(() => { timers.delete(timer); if (!ended && avatar.isConnected) callback(); }, delay);
      timers.add(timer);
    },
    animate(element, keyframes, options = {}) {
      if (!element?.animate || ended) return null;
      const animation = element.animate(keyframes, { duration, easing: soft, fill: 'both', ...options });
      motions.add(animation);
      animation.finished.catch(() => {});
      return animation;
    },
    prop(element) { props.add(element); return element; },
  };
  avatar.dataset.actorMotion = kind;
  actors.set(avatar, session);
  context.sessions.add(session);
  try {
    choreograph(session, context);
    session.later(duration + 32, () => settle(true));
    // Removed views still need cleanup even though choreography callbacks stop.
    const expiry = context.win.setTimeout(() => settle(avatar.isConnected), duration + 100);
    timers.add(expiry);
  } catch {
    settle(false);
    return null;
  }
  return session;
}

function leaf(session, frames, duration) {
  return session.animate(session.avatar.querySelector('.mori-leaf-art'), frames, { duration });
}

function greet(avatar, tapping = false) {
  const mood = avatar.dataset.mood;
  return run(avatar, tapping ? 'tap' : 'hello', tapping ? 940 : 1040, 0, session => {
    session.pose(mood === 'idle' ? 'waiting' : mood);
    session.animate(avatar.querySelector('.mori-figure'), [
      { transform: 'none' },
      { transform: `translateY(${tapping ? '3%' : '-1%'}) rotate(-4deg) scale(${tapping ? '1.045,.96' : '1.015'})`, offset: .2 },
      { transform: 'translateY(-2%) rotate(3deg)', offset: .47 },
      { transform: 'none', offset: .83 },
      { transform: 'none' },
    ]);
    leaf(session, [
      { transform: 'none' },
      { transform: 'rotate(-14deg) scaleX(.97)', offset: .2 },
      { transform: 'rotate(10deg) scaleX(1.02)', offset: .46 },
      { transform: 'rotate(-6deg)', offset: .69 },
      { transform: 'none' },
    ], tapping ? 920 : 1000);
    if (mood === 'ready') {
      session.animate(avatar.querySelector('.mori-offer-sheet'), [
        { opacity: 0, transform: 'translateY(15%) rotate(4deg)' },
        { opacity: 1, transform: 'translateY(-48%) rotate(-8deg)', offset: .29 },
        { opacity: 1, transform: 'translateY(-48%) rotate(-8deg)', offset: .58 },
        { opacity: 0, transform: 'translateY(10%) rotate(0deg)' },
      ]);
    }
  });
}

function actorForTarget(target) {
  if (!target?.closest) return null;
  const direct = target.closest('.mori-avatar');
  if (direct) return direct;
  const control = target.closest('button, a, [role="button"]');
  if (!control || control.disabled) return null;
  const inside = control.querySelector('.mori-avatar');
  if (inside) return inside;
  const stage = control.closest('.dash-spotlight, .thread-performer, .task-current');
  return stage?.querySelector('.mori-avatar') ?? null;
}

/** Idempotent delegated binding; returns an unbind function. No controls or ARIA roles are added. */
export function bindActorMotion(root) {
  if (!root?.addEventListener) return () => {};
  if (bindings.has(root)) return bindings.get(root);
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const context = contextFor(doc);
  function onHover(event) {
    if (event.pointerType === 'touch') return;
    const avatar = actorForTarget(event.target);
    if (!avatar) return;
    const control = event.target.closest('button, a, .mori-avatar');
    if (control?.contains(event.relatedTarget)) return;
    if (Date.now() - (hoverTimes.get(avatar) ?? 0) < 1100) return;
    hoverTimes.set(avatar, Date.now());
    greet(avatar);
  }
  function onFocus(event) {
    const avatar = actorForTarget(event.target);
    if (avatar && Date.now() - (hoverTimes.get(avatar) ?? 0) > 300) {
      hoverTimes.set(avatar, Date.now());
      greet(avatar);
    }
  }
  function onPress(event) {
    if (!event.isPrimary || event.button !== 0) return;
    const avatar = actorForTarget(event.target);
    if (!avatar) return;
    hoverTimes.set(avatar, Date.now());
    greet(avatar, true);
  }
  function onSubmit(event) {
    const form = event.target;
    if (!/task|note|message|ask|request/.test(form.dataset?.form ?? '')) return;
    const field = form.querySelector('textarea, input:not([type="date"]):not([type="hidden"])');
    if (field) context.intent = { rect: field.getBoundingClientRect(), at: Date.now() };
  }
  root.addEventListener('pointerover', onHover, { passive: true });
  root.addEventListener('focusin', onFocus);
  root.addEventListener('pointerdown', onPress, { passive: true });
  root.addEventListener('submit', onSubmit, true);
  const unbind = () => {
    root.removeEventListener('pointerover', onHover);
    root.removeEventListener('focusin', onFocus);
    root.removeEventListener('pointerdown', onPress);
    root.removeEventListener('submit', onSubmit, true);
    for (const session of [...context.sessions]) if (root.contains(session.avatar)) session.cancel();
    bindings.delete(root);
  };
  bindings.set(root, unbind);
  return unbind;
}

function sourcePoint(from, context, rect) {
  const bounds = from?.getBoundingClientRect?.() ?? from
    ?? (context.intent && Date.now() - context.intent.at < 2500 ? context.intent.rect : null);
  if (bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)) {
    return {
      x: Math.max(12, Math.min(context.win.innerWidth - 12, bounds.left + bounds.width * .5)),
      y: Math.max(12, Math.min(context.win.innerHeight - 12, bounds.top + bounds.height * .5)),
    };
  }
  return { x: Math.max(16, rect.left - rect.width * .65), y: rect.top + rect.height * .85 };
}

/** A real submitted note flies from its former field (or optional from rect/element) into Mori's hands. */
export function playActorReception(scope, { from } = {}) {
  const avatar = primaryAvatar(scope);
  return run(avatar, 'reception', 1000, 1, (session, context) => {
    session.pose('waiting');
    const rect = avatar.getBoundingClientRect();
    const start = sourcePoint(from, context, rect);
    const end = { x: rect.left + rect.width * .52, y: rect.top + rect.height * .70 };
    const dx = start.x - end.x, dy = start.y - end.y;
    const paper = session.prop(context.doc.createElement('span'));
    paper.className = 'mori-actor-paper mori-receive-flight';
    paper.setAttribute('aria-hidden', 'true');
    const width = Math.max(21, rect.width * .25), height = width * .7;
    Object.assign(paper.style, { left: `${end.x - width / 2}px`, top: `${end.y - height / 2}px`, width: `${width}px`, height: `${height}px` });
    context.doc.body.append(paper);
    session.animate(paper, [
      { transform: `translate(${dx}px, ${dy}px) rotate(-24deg) scale(.86)`, opacity: 0 },
      { transform: `translate(${dx * .94}px, ${dy * .94}px) rotate(-20deg) scale(.92)`, opacity: 1, offset: .10 },
      { transform: `translate(${dx * .33}px, ${dy * .36 - 22}px) rotate(11deg) scale(1.08)`, opacity: 1, offset: .59 },
      { transform: 'translate(0, 0) rotate(-5deg) scale(1)', opacity: 1, offset: .83 },
      { transform: 'translate(0, 0) rotate(-5deg) scale(.92)', opacity: 0 },
    ], { duration: 660 });
    const toward = Math.sign(dx) || -1;
    session.animate(avatar.querySelector('.mori-figure'), [
      { transform: 'none' },
      { transform: `translateX(${toward * 3}%) rotate(${toward * 5}deg)`, offset: .36 },
      { transform: 'translateY(4%) scale(1.035,.96)', offset: .59 },
      { transform: 'translateY(-1%)', offset: .76 },
      { transform: 'none' },
    ]);
    leaf(session, [{ transform: 'none' }, { transform: `rotate(${-toward * 16}deg)`, offset: .4 }, { transform: 'rotate(-7deg)', offset: .7 }, { transform: 'none' }], 950);
    session.later(535, () => session.pose('collecting'));
  });
}

/** A finite three-paper sift; 1100ms total, intended for the actual working start. */
export function playActorSorting(performer) {
  const avatar = primaryAvatar(performer);
  return run(avatar, 'sorting', 1100, 1, session => {
    session.pose('working');
    session.animate(avatar.querySelector('.mori-figure'), [
      { transform: 'none' },
      { transform: 'translateY(3%) rotate(-3deg)', offset: .2 },
      { transform: 'translate(1%,1%) rotate(2deg)', offset: .43 },
      { transform: 'translateY(3%) rotate(-2deg)', offset: .65 },
      { transform: 'none' },
    ]);
    const papers = [...avatar.querySelectorAll('.mori-work-papers .mori-actor-paper')];
    papers.forEach((paper, index) => {
      session.animate(paper, [
        { transform: 'translate(0,0) rotate(-10deg)', opacity: 0 },
        { transform: 'translate(-6%,-9%) rotate(-15deg)', opacity: 1, offset: .08 },
        { transform: 'translate(44%,-76%) rotate(19deg) rotateX(22deg)', opacity: 1, offset: .36 },
        { transform: 'translate(112%,3%) rotate(3deg)', opacity: 1, offset: .64 },
        { transform: 'translate(114%,5%) rotate(2deg)', opacity: 0, offset: .90 },
        { transform: 'translate(114%,5%) rotate(2deg)', opacity: 0 },
      ], { duration: 620, delay: index * 190, easing: 'cubic-bezier(.32,.12,.28,1)' });
    });
    leaf(session, [
      { transform: 'none' }, { transform: 'rotate(11deg)', offset: .2 },
      { transform: 'rotate(-10deg)', offset: .43 }, { transform: 'rotate(8deg)', offset: .66 }, { transform: 'none' },
    ], 1100);
  });
}

/** Leans toward the file; launch the existing document flight at returned handoffAt (165ms). */
export function playActorOffer(performer) {
  const avatar = primaryAvatar(performer);
  return run(avatar, 'offer', 680, 1, session => {
    session.pose('ready');
    const target = performer?.querySelector?.('.thread-file-icon, .task-action-primary');
    const origin = avatar.getBoundingClientRect();
    const toward = target ? Math.sign(target.getBoundingClientRect().left - origin.left) || -1 : -1;
    session.animate(avatar.querySelector('.mori-figure'), [
      { transform: 'none' },
      { transform: `translate(${toward * 5}%, 2%) rotate(${toward * 5}deg) scale(1.04)`, offset: .24 },
      { transform: `translate(${toward * 4}%, 1%) rotate(${toward * 3}deg)`, offset: .56 },
      { transform: 'none' },
    ]);
    session.animate(avatar.querySelector('.mori-offer-sheet'), [
      { transform: 'translateY(16%) rotate(3deg)', opacity: 0 },
      { transform: `translate(${toward * 12}%,-45%) rotate(${-toward * 8}deg)`, opacity: 1, offset: .21 },
      { transform: `translate(${toward * 16}%,-54%) rotate(${-toward * 10}deg)`, opacity: 0, offset: .32 },
      { transform: 'translateY(10%)', opacity: 0 },
    ]);
    leaf(session, [{ transform: 'none' }, { transform: `rotate(${-toward * 14}deg)`, offset: .24 }, { transform: 'rotate(4deg)', offset: .6 }, { transform: 'none' }], 650);
  });
}
