import { captureShared, revealShared, animateSheet } from './poc2-continuity.mjs';
import { loadSchedule, saveSchedule, renderSchedule, renderCalendarSheet, scheduleItems, eventFromFields, shiftScheduleDay } from './poc2-schedule.mjs';
import { loadTools, saveTools, renderTools, renderToolSheet, applyToolForm, applyToolAction, updateToolCountdowns } from './poc2-tools.mjs';
import { cancelVoiceInput, toggleVoiceInput } from './poc2-voice.mjs';
import { renderAssistant, renderThreadComposer, renderThreadContext, renderTurns, renderResultSheet } from './poc2-assistant.mjs';
import { bindTouchFeedback, deliverFile, playAskOpen, playAvatarAcceptance, playTabSelection, playThreadReply, playView } from './poc2-motion.mjs';
import { avatarStatus, renderActivity, renderAvatar } from './poc2-avatar.mjs';
import { renderDashboard, renderTaskPage } from './poc2-dashboard.mjs';
import { icon } from './poc2-icons.mjs';
import { renderSecondary, renderLibraryResults } from './poc2-views.mjs';
import { renderComposer } from './poc2-sheets.mjs';
import {
  createDemoState, loadState, saveState, createTask, createNote,
  addObservation, answerQuestion, completeTask, formatDay, documentFilename, documentText
} from './poc2-model.mjs';

const pages = {
  today: ['오늘', 'sun'],
  schedule: ['일정', 'calendar'],
  library: ['보관함', 'layers'],
  tools: ['생활', 'grid'],
  chat: ['대화', 'chat'],
  settings: ['설정', 'settings'],
  task: ['맡은 일', 'file']
};
const themeKey = 'mori.poc2.theme';
const taskKey = 'mori.poc2.active-task';
const topTabs = ['today', 'schedule', 'library', 'tools'];
const libraryTabs = ['tasks', 'notes', 'files'];
const openedAt = new Date();
const today = [openedAt.getFullYear(), openedAt.getMonth() + 1, openedAt.getDate()]
  .map(part => String(part).padStart(2, '0')).join('-');
const todayLabel = new Intl.DateTimeFormat('ko-KR', {
  month: 'long', day: 'numeric', weekday: 'long'
}).format(openedAt);
const main = document.querySelector('.workspace');
const appBar = document.querySelector('.app-bar');
const dock = document.querySelector('.dock');
const appBottom = document.querySelector('.app-bottom');
const threadFooter = document.querySelector('.thread-footer');
const askDock = document.querySelector('#ask-dock');
let askInput;
const dialog = document.querySelector('.mori-sheet');
const toast = document.querySelector('.toast');
const media = matchMedia('(prefers-color-scheme: dark)');
const storage = getStorage();
let state = loadState(storage);
let events = loadSchedule(storage, today);
let tools = loadTools(storage);
let scheduleDay = today;
let scheduleMode = 'week';
let theme = readTheme();
let currentPage = 'today';
let pageTaskId = null;
const nestedPages = ['task', 'settings', 'chat'];
let activeTab = 'today';
let sharedRoute;
let acceptedTaskId = null;
const preparing = new Map();
let libraryTab = 'tasks';
let libraryQuery = '';
let homeTaskId = loadTaskSelection();
const replyDrafts = new Map();
let sheet = null;
let returnFocus = null;
let toastTimer;
let sheetExit;

function getStorage() {
  try { return window.localStorage; } catch { return null; }
}

function readTheme() {
  try {
    const value = storage?.getItem(themeKey);
    return ['light', 'dark', 'system'].includes(value) ? value : 'system';
  } catch { return 'system'; }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function updateTheme() {
  const mode = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]').content = mode === 'dark' ? '#201b20' : '#f7f4ef';
}

function currentToolbarTask() {
  if (currentPage === 'task') return findTask(pageTaskId);
  if (currentPage === 'today') {
    return state.tasks.find(task => preparing.has(task.id))
      ?? state.tasks.find(task => task.status === 'waiting')
      ?? state.tasks.find(task => task.status === 'collecting')
      ?? state.tasks[0];
  }
  return homeTask();
}

function moodOf(task) {
  return preparing.has(task?.id) ? 'working' : task?.status ?? 'idle';
}

function refreshActor() {
  const control = appBar.querySelector('[data-action="open-activity"]');
  if (!control) return;
  const task = currentToolbarTask();
  const mood = moodOf(task);
  control.dataset.id = task?.id ?? '';
  const avatar = control.querySelector('.mori-avatar');
  if (avatar) {
    avatar.dataset.mood = mood;
    control.querySelector('.thread-identity-copy strong').textContent = task?.title ?? '모리';
  }
  const status = control.querySelector('.thread-state');
  if (status) status.textContent = avatarStatus[mood];
}

function renderNavigation() {
  const nested = nestedPages.includes(currentPage);
  const actor = appBar.querySelector('.mori-avatar');
  const inThread = currentPage === 'chat';
  appBar.innerHTML = `
    <div class="app-bar-leading">
      ${nested ? `<button class="utility-control back-control spring-control" type="button" data-action="back" aria-label="이전 화면">${icon('back')}</button>` : ''}
      ${inThread
        ? `<button class="thread-identity spring-control" type="button" data-action="open-activity" aria-label="모리 활동">
          ${renderAvatar('idle')}<span class="thread-identity-copy"><strong>모리</strong><small class="thread-state" aria-live="polite"></small></span></button>`
        : `<a class="brand-wordmark" href="#today" aria-label="모리 오늘"><span class="brand-mark">${icon('mori')}</span>모리</a>`}
    </div>
    <div class="app-bar-trailing">
      ${!inThread ? `<button class="utility-control spring-control" type="button" data-action="open-activity" aria-label="모리 활동">${icon('clock')}</button>` : ''}
      ${currentPage !== 'settings' ? `<a class="utility-control spring-control" href="#settings" aria-label="설정">${icon('settings')}</a>` : ''}
    </div>`;
  if (actor && inThread) appBar.querySelector('.mori-avatar').replaceWith(actor);
  if (!dock.firstElementChild) {
    const links = topTabs.map(page => `<a class="nav-link spring-control" href="#${page}" data-page="${page}">
      ${icon(pages[page][1])}<span>${pages[page][0]}</span>
    </a>`).join('');
    dock.innerHTML = `<nav class="dock-tabs" aria-label="주요 메뉴">
      <span class="tab-indicator" aria-hidden="true"></span>${links}
    </nav>
    <button class="dock-action spring-control" type="button" data-action="open-ask" aria-controls="ask-dock" aria-expanded="false">
      ${icon('compose')}<span>부탁</span>
    </button>`;
  }
  const selected = currentPage === 'settings' ? 'settings' : activeTab;
  dock.dataset.view = selected;
  for (const link of dock.querySelectorAll('[data-page]')) {
    if (link.dataset.page === selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  refreshActor();
}

function initializeAsk() {
  const shortcuts = [
    ['new-event', 'calendar', '일정'],
    ['new-note', 'note', '메모'],
    ['open-tool', 'pin', '주차', 'parking'],
    ['open-tool', 'clock', '알림', 'reminders'],
  ];
  askDock.innerHTML = `
    <div class="ask-heading"><h2 id="ask-title">모리에게 부탁하기</h2>
      <button class="ask-close spring-control" type="button" data-action="close-ask" aria-label="부탁 입력 닫기">${icon('close')}</button>
    </div>
    <form class="ask-form" data-form="instant-task">
      <label for="ask-input" class="sr-only">부탁 내용</label>
      <textarea id="ask-input" name="request" rows="2" maxlength="1000" placeholder="어떤 일을 맡길까요?" required></textarea>
      <div class="ask-actions">
        <button class="ask-more spring-control" type="button" data-action="ask-details">${icon('calendar')}<span>기한 정하기</span></button>
        <div class="ask-input-controls">
          <button class="ask-voice spring-control" type="button" data-action="voice-input" aria-label="음성 입력" aria-pressed="false">${icon('mic')}</button>
          <button class="ask-send spring-control" type="submit" aria-label="부탁 보내기" disabled>${icon('arrow-up')}</button>
        </div>
      </div>
    </form>
    <div class="ask-shortcuts" aria-label="바로 추가">
      ${shortcuts.map(([action, symbol, label, tool]) => `<button class="spring-control" type="button" data-action="${action}"${tool ? ` data-tool="${tool}"` : ''}>${icon(symbol)}${label}</button>`).join('')}
    </div>`;
  askInput = askDock.querySelector('textarea');
  askInput.addEventListener('input', () => updateComposer(askInput));
}

function setAskOpen(open, { focus = true } = {}) {
  if (open === !askDock.hidden) return;
  const trigger = dock.querySelector('[data-action="open-ask"]');
  askDock.hidden = !open;
  trigger?.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('is-asking', open);
  cancelVoiceInput();
  if (open) {
    playAskOpen(askDock, trigger);
    if (focus) askInput.focus({ preventScroll: true });
  } else if (focus) {
    trigger?.focus({ preventScroll: true });
  }
}

function askRequest(text) {
  const [firstLine] = text.trim().split(/\r?\n/, 1);
  const headline = Array.from(firstLine);
  const title = headline.length > 72 ? headline.slice(0, 71).join('') + '…' : firstLine;
  return { title, brief: title === text ? '' : text };
}

function findTask(id) {
  return state.tasks.find(task => task.id === id);
}

function homeTask() {
  return findTask(homeTaskId)
    ?? state.tasks.find(task => task.status === 'waiting')
    ?? state.tasks.find(task => task.status === 'collecting')
    ?? state.tasks[0];
}

function loadTaskSelection() {
  try { return storage?.getItem(taskKey) ?? null; } catch { return null; }
}

function selectTask(id) {
  homeTaskId = id;
  try {
    if (id) storage?.setItem(taskKey, id);
    else storage?.removeItem(taskKey);
  } catch { /* The current thread remains available in this session. */ }
}

function route({ focus = false } = {}) {
  const [slug, id] = location.hash.slice(1).split('/');
  const previousPage = currentPage;
  const previousTab = libraryTab;
  if (!sharedRoute && (!slug || slug === 'today')) captureReturnToToday();
  cancelVoiceInput();
  setAskOpen(false, { focus: false });
  const legacyTab = slug === 'works' ? 'tasks' : slug === 'notes' ? 'notes' : null;
  currentPage = legacyTab ? 'library' : Object.hasOwn(pages, slug) ? slug : 'today';
  if (topTabs.includes(currentPage)) activeTab = currentPage;
  else if (currentPage !== 'settings') activeTab = history.state?.moriTab ?? 'library';
  if (currentPage === 'library') libraryTab = legacyTab ?? (libraryTabs.includes(id) ? id : 'tasks');
  let routeId = null;
  try { routeId = id ? decodeURIComponent(id) : null; } catch { /* An invalid hash has no selected record. */ }
  pageTaskId = currentPage === 'task' ? routeId : null;
  if (currentPage === 'chat' && findTask(routeId)) selectTask(routeId);
  document.body.dataset.view = currentPage;
  document.title = '모리 · ' + pages[currentPage][0];
  renderNavigation();
  renderPage();
  if (focus) {
    main.focus({ preventScroll: true });
    if (currentPage !== 'chat') window.scrollTo(0, 0);
  }
  if (currentPage === 'chat') scrollThread();
  if (previousPage === 'library' && currentPage === 'library' && previousTab !== libraryTab) {
    const direction = libraryTabs.indexOf(libraryTab) - libraryTabs.indexOf(previousTab);
    playView(main.querySelector('.library-results'), Math.sign(direction));
    playTabSelection(main.querySelector('.library-indicator'), libraryTabs.indexOf(previousTab), libraryTabs.indexOf(libraryTab));
    if (focus) main.querySelector('.library-tabs [aria-current]')?.focus({ preventScroll: true });
  }
  const transition = sharedRoute;
  sharedRoute = null;
  const arriving = transition?.page === currentPage;
  const target = arriving && (currentPage === 'chat'
    ? main.querySelector('.thread-performer .mori-avatar')
    : main.querySelector('.dash-spotlight .mori-avatar'));
  if (target) {
    revealShared(transition.snapshot, target, { reverse: currentPage === 'today' });
  } else {
    transition?.snapshot?.cancel();
    if (previousPage !== currentPage && currentPage !== 'chat') {
      const order = Object.keys(pages);
      playView(main.firstElementChild, order.indexOf(currentPage) >= order.indexOf(previousPage) ? 1 : -1);
    }
  }
  if (acceptedTaskId === pageTaskId && currentPage === 'task') {
    acceptedTaskId = null;
    playAvatarAcceptance(document);
  }
}

const threadView = { icon, esc, formatDay, avatar: renderAvatar };

function updateTranscript(log, markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const existing = new Map([...log.children].map(node => [node.dataset.turnKey, node]));
  let current = log.firstElementChild;
  for (const turn of [...template.content.children]) {
    const previous = existing.get(turn.dataset.turnKey);
    let comparable = previous;
    if (previous?.querySelector('.thread-composer-slot')?.contains(threadFooter)) {
      comparable = previous.cloneNode(true);
      comparable.querySelector('.thread-composer-slot').replaceChildren();
    }
    const node = comparable?.isEqualNode(turn) ? previous : turn;
    if (node !== current) log.insertBefore(node, current);
    current = node.nextElementSibling;
    if (previous === node) existing.delete(turn.dataset.turnKey);
  }
  for (const stale of existing.values()) stale.remove();
}

function renderPage() {
  refreshActor();
  const onThread = currentPage === 'chat';
  threadFooter.hidden = !onThread;
  if (!onThread) {
    if (threadFooter.parentElement !== appBottom) appBottom.prepend(threadFooter);
    threadFooter.replaceChildren();
    delete threadFooter.dataset.key;
    if (currentPage === 'today') {
      main.innerHTML = renderDashboard(state, {
        ...threadView, today, todayLabel, workingIds: preparing, agenda: scheduleItems(events, state.tasks, today, tools, today)
      });
    } else if (currentPage === 'schedule') {
      main.innerHTML = renderSchedule({ ...threadView, events, tools, tasks: state.tasks, today, day: scheduleDay, mode: scheduleMode });
    } else if (currentPage === 'tools') {
      main.innerHTML = renderTools(tools, { ...threadView, notesHref: '#library/notes', scheduleHref: '#schedule' });
    } else if (currentPage === 'task') {
      const task = findTask(pageTaskId);
      main.innerHTML = task
        ? renderTaskPage(task, { ...threadView, avatar: renderAvatar, working: preparing.has(task.id) })
        : '<section class="thread-empty"><h1>이 일을 찾을 수 없어요</h1><a class="thread-quick" href="#library">보관함 보기</a></section>';
    } else {
      main.innerHTML = renderSecondary(currentPage, libraryContext());
    }
    return;
  }

  const task = homeTask();
  const active = main.querySelector('.thread');
  if (!active || active.dataset.threadId !== task?.id) main.innerHTML = renderAssistant(task, threadView);
  const working = preparing.has(task?.id);
  if (task) {
    const context = main.querySelector('.thread-context');
    if (!context.firstElementChild) context.innerHTML = renderThreadContext(task, threadView);
    updateTranscript(main.querySelector('.thread-log'), renderTurns(task, { ...threadView, working }));
  }

  const outlet = main.querySelector('.thread-composer-slot') ?? appBottom;
  if (threadFooter.parentElement !== outlet) outlet.prepend(threadFooter);
  const key = task ? task.id + ':' + (working ? 'working' : task.status) : '';
  if (threadFooter.dataset.key !== key) {
    threadFooter.innerHTML = renderThreadComposer(task, { ...threadView, working });
    threadFooter.dataset.key = key;
    const input = threadFooter.querySelector('#thread-input');
    if (input) {
      input.value = replyDrafts.get(task.id) ?? '';
      updateComposer(input);
    }
  }
}

function scrollThread() {
  main.scrollTop = main.scrollHeight;
}

function routeToDetail(hash) {
  if (location.hash === hash) return;
  if (history.state?.moriParent === hash) {
    history.back();
    return;
  }
  history.pushState({ moriParent: location.hash || '#today', moriTab: activeTab }, '', hash);
  route({ focus: true });
}

function openThread(id) {
  if (!findTask(id)) return;
  if (currentPage !== 'chat') {
    const spotlight = main.querySelector('.dash-spotlight:has([data-id="' + CSS.escape(id) + '"]) .mori-avatar');
    const source = spotlight ?? main.querySelector('.task-current .mori-avatar');
    if (source) sharedRoute = { page: 'chat', snapshot: captureShared(source) };
  }
  selectTask(id);
  routeToDetail('#chat/' + encodeURIComponent(id));
}

function captureReturnToToday() {
  if (currentPage !== 'chat') return;
  const spotlight = state.tasks.find(task => task.status === 'waiting')
    ?? state.tasks.find(task => task.status !== 'ready');
  const source = main.querySelector('.thread-performer .mori-avatar');
  if (source && spotlight?.id === homeTask()?.id) sharedRoute = { page: 'today', snapshot: captureShared(source) };
}

function openTask(id) {
  if (!findTask(id)) return;
  const navigate = () => routeToDetail('#task/' + encodeURIComponent(id));
  if (dialog.open) dismissSheet(0, navigate);
  else navigate();
}

function updateComposer(input) {
  input.form.querySelector('button[type="submit"]').disabled = !input.value.trim();
}

function updateHomeTask(task) {
  cancelVoiceInput();
  selectTask(task.id);
  replyDrafts.delete(task.id);
  const input = threadFooter.querySelector('#thread-input');
  const previousFocus = document.activeElement;
  if (input) {
    input.value = '';
    updateComposer(input);
  }
  updateTask(task);
  const hasFile = task.status === 'ready';
  const performer = main.querySelector('.thread-performer');
  const last = performer ?? [...main.querySelectorAll('.thread-turn')].at(-1);
  const file = last?.querySelector('.thread-file');
  scrollThread();
  if (!previousFocus?.isConnected) (file ?? threadFooter.querySelector('#thread-input') ?? main).focus({ preventScroll: true });
  if (hasFile) deliverFile(performer);
  else playThreadReply(last);
}

function announce(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('shown');
  toastTimer = setTimeout(() => {
    toast.classList.remove('shown');
  }, 2800);
}

function commit(next, message) {
  state = next;
  const stored = saveState(storage, state);
  renderPage();
  if (!stored) announce('이 화면에 반영했어요. 브라우저에는 저장할 수 없어요.');
  else if (message) announce(message);
}

function updateTask(task, message) {
  commit({ ...state, tasks: state.tasks.map(item => item.id === task.id ? task : item) }, message);
}

function libraryContext() {
  return { state, theme, icon, esc, formatDay, libraryTab, libraryQuery, workingIds: preparing };
}

function refreshLibrarySearch() {
  const results = main.querySelector('.library-results');
  if (!results) return;
  results.innerHTML = renderLibraryResults(libraryContext());
  main.querySelector('.library-search-clear').hidden = !libraryQuery;
}

function createAndOpenTask(values) {
  const task = createTask(values);
  selectTask(task.id);
  commit({ ...state, tasks: [task, ...state.tasks] }, '모리가 새 부탁을 맡았어요.');
  acceptedTaskId = task.id;
  dismissSheet(0, () => openTask(task.id));
}

function renderDeleteEvent(event) {
  return `<div class="sheet-content">
    <div class="sheet-header"><h2 id="sheet-title" tabindex="-1">일정을 지울까요?</h2>
      <button type="button" class="sheet-close" data-action="close-sheet" aria-label="닫기">${icon('close')}</button></div>
    <p class="sheet-brief">${esc(event.title)}</p>
    <div class="sheet-actions">
      <button type="button" class="sheet-secondary" data-action="open-event" data-id="${esc(event.id)}">취소</button>
      <button type="button" class="sheet-primary destructive-control" data-action="confirm-delete-event" data-id="${esc(event.id)}">일정 삭제</button>
    </div>
  </div>`;
}

function formError(form, message) {
  let error = form.querySelector('.form-error, [data-tool-error]');
  if (!error) {
    error = document.createElement('p');
    error.className = 'form-error';
    error.setAttribute('role', 'alert');
    form.append(error);
  }
  error.hidden = false;
  error.textContent = message;
}

function updateSchedule(next, message) {
  events = next;
  const saved = saveSchedule(storage, events);
  renderPage();
  announce(saved ? message : '이 화면에 반영했어요. 브라우저에는 저장할 수 없어요.');
}

function updateTools(next, message, { preserveDraft = false } = {}) {
  tools = next;
  const saved = saveTools(storage, tools);
  if (['today', 'schedule', 'tools'].includes(currentPage)) renderPage();
  if (dialog.open && sheet?.kind === 'tool') {
    const before = dialog.querySelector('form[data-form="mori-tool"]');
    const draft = preserveDraft && before ? new FormData(before) : null;
    const active = document.activeElement;
    const { action, command, id } = active?.dataset ?? {};
    renderDialog();
    const after = dialog.querySelector('form[data-form="mori-tool"]');
    if (draft && after?.dataset.tool === before.dataset.tool) {
      for (const [name, value] of draft) {
        const field = after.elements.namedItem(name);
        if (field instanceof HTMLElement) field.value = value;
      }
    }
    const replacement = [...dialog.querySelectorAll('[data-action]')].find(button =>
      button.dataset.action === action && button.dataset.command === command && button.dataset.id === id
    );
    (replacement ?? dialog.querySelector('#sheet-title'))?.focus({ preventScroll: true });
  }
  if (message || !saved) announce(saved ? message : '이 화면에 반영했어요. 브라우저에는 저장할 수 없어요.');
}

function renderDialog() {
  if (sheet.kind === 'event') {
    dialog.innerHTML = renderCalendarSheet({
      ...threadView, event: events.find(event => event.id === sheet.id), day: sheet.day || scheduleDay, editing: sheet.editing
    });
  } else if (sheet.kind === 'delete-event') {
    const record = events.find(event => event.id === sheet.id);
    if (record) dialog.innerHTML = renderDeleteEvent(record);
  } else if (sheet.kind === 'tool') {
    dialog.innerHTML = renderToolSheet(sheet.tool, tools, threadView);
    updateToolCountdowns(dialog);
  } else if (sheet.kind === 'activity') {
    const task = findTask(sheet.id);
    dialog.innerHTML = renderActivity(task, moodOf(task), threadView);
  } else if (sheet.kind === 'file') {
    const task = findTask(sheet.id);
    if (task?.status === 'ready') dialog.innerHTML = renderResultSheet(task, threadView);
  } else if (sheet.kind === 'compose') {
    dialog.innerHTML = renderComposer(state, {
      icon, esc, formatDay, composerMode: sheet.mode, selectedTaskId: sheet.id
    });
    const form = dialog.querySelector('form');
    for (const [name, value] of Object.entries(sheet.drafts?.[sheet.mode] ?? {})) {
      const field = form.elements.namedItem(name);
      if (field) field.value = value;
    }
  } else {
    dialog.innerHTML = `<header class="sheet-header"><button class="sheet-close" type="button" data-action="close-sheet" aria-label="닫기">${icon('close')}</button></header>
      <div class="reset-sheet"><h2 id="sheet-title" tabindex="-1">예시로 되돌릴까요?</h2>
      <p>이 브라우저에서 추가한 부탁, 일정, 기록과 기능 설정을 지우고 처음 예시를 다시 엽니다.</p>
      <div class="sheet-actions"><button type="button" data-action="close-sheet" class="sheet-secondary">취소</button>
      <button type="button" data-action="confirm-reset" class="sheet-primary">되돌리기</button></div></div>`;
  }
  dialog.insertAdjacentHTML('afterbegin', '<div class="sheet-grabber" aria-hidden="true"><span></span></div>');
}

function showSheet(next, trigger = document.activeElement) {
  if (!askDock.hidden) {
    if (askDock.contains(trigger)) trigger = dock.querySelector('[data-action="open-ask"]');
    setAskOpen(false, { focus: false });
  }
  const reopening = Boolean(sheetExit);
  sheetExit = null;
  const first = !dialog.open;
  if (first) {
    returnFocus = trigger instanceof HTMLElement ? {
      element: trigger, id: trigger.dataset.id, action: trigger.dataset.action, tool: trigger.dataset.tool
    } : null;
  }
  sheet = next;
  dialog.dataset.kind = next.kind;
  renderDialog();
  if (first) dialog.showModal();
  if (first || reopening) {
    animateSheet(dialog, { opening: true });
  } else {
    playView(dialog.querySelector('.sheet-content') ?? dialog.firstElementChild, 1);
  }
  document.body.classList.add('sheet-open');
  dialog.scrollTop = 0;
  dialog.querySelector('#sheet-title')?.focus({ preventScroll: true });
}

function dismissSheet(offset = 0, after) {
  if (!dialog.open) { after?.(); return; }
  if (sheetExit) return;
  const motion = animateSheet(dialog, { opening: false, offset });
  if (!motion) { dialog.close(); after?.(); return; }
  sheetExit = motion;
  motion.finished.then(() => {
    if (sheetExit !== motion) return;
    dialog.close();
    after?.();
  }, () => {});
}

function focusInDialog(selector = '#sheet-title') {
  const target = dialog.querySelector(selector) ?? dialog.querySelector('#sheet-title');
  target?.focus({ preventScroll: true });
}

function download(task) {
  const url = URL.createObjectURL(new Blob([documentText(task)], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = documentFilename(task);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  announce('결과 파일을 내려받았어요.');
}

function setFilter(value, action, valueKey) {
  renderPage();
  main.querySelector(`[data-action="${action}"][data-${valueKey}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
}

function moveSchedule(direction, { focus = false } = {}) {
  if (direction !== -1 && direction !== 1) return;
  scheduleDay = shiftScheduleDay(scheduleDay, scheduleMode, direction);
  if (focus) setFilter(String(direction), 'schedule-step', 'direction');
  else renderPage();
  playView(main.querySelector('.schedule-grid'), direction);
  playView(main.querySelector('.schedule-agenda'), direction);
}

let scheduleSwipe;
main.addEventListener('pointerdown', event => {
  if (currentPage !== 'schedule' || event.pointerType !== 'touch' || !event.isPrimary || !event.target.closest('.schedule-grid')) return;
  scheduleSwipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
main.addEventListener('pointerup', event => {
  if (scheduleSwipe?.id !== event.pointerId) return;
  const dx = event.clientX - scheduleSwipe.x;
  const dy = event.clientY - scheduleSwipe.y;
  scheduleSwipe = null;
  if (currentPage === 'schedule' && Math.abs(dx) >= 56 && Math.abs(dx) > Math.abs(dy) * 1.35) {
    event.preventDefault();
    moveSchedule(dx < 0 ? 1 : -1);
  }
});
main.addEventListener('pointercancel', () => { scheduleSwipe = null; });

document.addEventListener('click', event => {
  if (event.target.closest('.skip-link')) {
    event.preventDefault();
    main.focus();
    main.scrollIntoView({ block: 'start' });
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, mode } = button.dataset;
  switch (action) {
    case 'open-ask':
      setAskOpen(askDock.hidden);
      break;
    case 'close-ask':
      setAskOpen(false);
      break;
    case 'ask-details':
      showSheet({ kind: 'compose', mode: 'task', fromQuickAsk: true, drafts: { task: askRequest(askInput.value.trim()) } }, button);
      break;
    case 'voice-input':
      toggleVoiceInput(button, button.form?.querySelector('textarea'), announce);
      break;
    case 'today-schedule': {
      const direction = today < scheduleDay ? -1 : 1;
      scheduleDay = today;
      renderPage();
      main.querySelector('[data-action="today-schedule"]')?.focus({ preventScroll: true });
      playView(main.querySelector('.schedule-agenda'), direction);
      break;
    }
    case 'schedule-day': {
      const direction = button.dataset.day < scheduleDay ? -1 : 1;
      if (scheduleDay === button.dataset.day) break;
      scheduleDay = button.dataset.day;
      setFilter(scheduleDay, 'schedule-day', 'day');
      playView(main.querySelector('.schedule-agenda'), direction);
      break;
    }
    case 'schedule-step':
      moveSchedule(Number(button.dataset.direction), { focus: true });
      break;
    case 'schedule-mode':
      if ((mode === 'week' || mode === 'month') && mode !== scheduleMode) {
        const previousMode = scheduleMode;
        scheduleMode = mode;
        setFilter(mode, 'schedule-mode', 'mode');
        const selector = main.querySelector('.schedule-mode');
        selector.dataset.mode = previousMode;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (selector.isConnected) selector.dataset.mode = mode;
        }));
        playView(main.querySelector('.schedule-grid'), mode === 'month' ? 1 : -1);
      }
      break;
    case 'new-event':
      showSheet({ kind: 'event', day: currentPage === 'schedule' ? scheduleDay : today, editing: true }, button);
      break;
    case 'open-event':
    case 'edit-event':
    case 'delete-event': {
      if (!events.some(event => event.id === id)) break;
      showSheet({ kind: action === 'delete-event' ? 'delete-event' : 'event', id, editing: action === 'edit-event' }, button);
      break;
    }
    case 'confirm-delete-event':
      if (events.some(event => event.id === id)) {
        updateSchedule(events.filter(event => event.id !== id), '일정을 지웠어요.');
        dismissSheet();
      }
      break;
    case 'open-tool':
      showSheet({ kind: 'tool', tool: button.dataset.tool }, button);
      break;
    case 'tool-action': {
      const command = button.dataset.command;
      const result = applyToolAction(command, tools, id);
      if (result?.state) {
        if (command === 'reminder-delete') sheet.tool = 'reminders';
        if (command === 'routine-delete') sheet.tool = 'routines';
        updateTools(result.state, result.message, { preserveDraft: command !== 'parking-clear' });
      } else if (result?.error) announce(result.error);
      break;
    }
    case 'new-task':
      setAskOpen(true);
      break;
    case 'new-note':
      showSheet({ kind: 'compose', mode: 'note', id }, button);
      break;
    case 'open-activity':
      showSheet({ kind: 'activity', id }, button);
      break;
    case 'back': {
      const parent = history.state?.moriParent;
      if (parent) history.back();
      else location.hash = currentPage === 'task' ? '#library' : '#today';
      break;
    }
    case 'open-thread':
      openThread(id);
      break;
    case 'home-quick-answer':
      if (id === 'garage') recordHomeAnswer(id, '네, 두 번 다 방지턱을 넘을 때였어요.');
      break;
    case 'home-finish': {
      const task = findTask(id);
      if (task?.status === 'collecting' && task.observations.length) {
        prepareResult(task);
      }
      break;
    }
    case 'open-file':
      if (findTask(id)?.status === 'ready') showSheet({ kind: 'file', id }, button);
      break;
    case 'home-download': {
      const task = findTask(id);
      if (task?.status === 'ready') download(task);
      break;
    }
    case 'open-task':
      openTask(id);
      break;
    case 'composer-mode':
      if (sheet?.kind === 'compose' && mode !== sheet.mode && ['task', 'note'].includes(mode)) {
        sheet.drafts ??= {};
        sheet.drafts[sheet.mode] = Object.fromEntries(new FormData(dialog.querySelector('form')));
        sheet.mode = mode;
        renderDialog();
        focusInDialog('[data-mode="' + mode + '"]');
      }
      break;
    case 'close-sheet':
      dismissSheet();
      break;
    case 'clear-library-query': {
      const input = main.querySelector('#library-query');
      if (!input) break;
      input.value = libraryQuery = '';
      refreshLibrarySearch();
      input.focus();
      break;
    }
    case 'theme':
      theme = button.dataset.theme;
      try { storage?.setItem(themeKey, theme); } catch { /* Theme still updates in this session. */ }
      updateTheme();
      setFilter(theme, 'theme', 'theme');
      break;
    case 'reset':
      showSheet({ kind: 'reset' }, button);
      break;
    case 'confirm-reset':
      libraryQuery = '';
      askInput.value = '';
      updateComposer(askInput);
      selectTask(null);
      for (const timer of preparing.values()) clearTimeout(timer);
      preparing.clear();
      replyDrafts.clear();
      events = loadSchedule(null, today);
      tools = loadTools(null);
      saveSchedule(storage, events);
      saveTools(storage, tools);
      scheduleDay = today;
      commit(createDemoState(), '처음 예시를 다시 불러왔어요.');
      dismissSheet();
      break;
  }
});

function prepareResult(task, { submittedReply = false } = {}) {
  if (preparing.has(task.id)) return;
  const wasChat = currentPage === 'chat' && homeTask()?.id === task.id;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timer = setTimeout(() => {
    preparing.delete(task.id);
    const known = findTask(task.id);
    if (!known || known.status !== 'collecting') return;
    const result = completeTask(known);
    if (currentPage === 'chat' && homeTask()?.id === task.id) updateHomeTask(result);
    else updateTask(result, '결과 파일을 준비했어요.');
    if (dialog.open && sheet?.kind === 'activity') renderDialog();
  }, reduce ? 0 : 910);
  preparing.set(task.id, timer);
  if (submittedReply && wasChat) updateHomeTask(task);
  else if (submittedReply) updateTask(task);
  else renderPage();
}

function recordHomeAnswer(id, text) {
  const task = findTask(id);
  const answer = text.trim();
  if (task?.status !== 'waiting' || !answer || preparing.has(id)) return;
  prepareResult(answerQuestion(task, answer), { submittedReply: true });
}

threadFooter.addEventListener('input', event => {
  const input = event.target.closest('#thread-input');
  if (!input) return;
  input.setCustomValidity('');
  replyDrafts.set(input.form.dataset.id, input.value);
  updateComposer(input);
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  if (sheetExit && dialog.contains(form)) return;
  const fields = new FormData(form);
  const value = name => String(fields.get(name) ?? '').trim();
  if (form.dataset.form === 'instant-task') {
    const request = value('request');
    if (!request) return;
    form.reset();
    updateComposer(askInput);
    setAskOpen(false, { focus: false });
    createAndOpenTask(askRequest(request));
  } else if (form.dataset.form === 'calendar-event') {
    const existing = events.find(event => event.id === form.dataset.id);
    const next = eventFromFields(fields, existing);
    if (next.error) { formError(form, next.error); return; }
    scheduleDay = next.date;
    updateSchedule(existing ? events.map(event => event.id === existing.id ? next : event) : [...events, next],
      existing ? '일정을 수정했어요.' : '일정을 추가했어요.');
    dismissSheet(0, () => { if (currentPage !== 'schedule') location.hash = 'schedule'; });
  } else if (form.dataset.form === 'mori-tool') {
    const result = applyToolForm(form.dataset.tool, tools, fields);
    if (result?.error) { formError(form, result.error); return; }
    if (result?.state) updateTools(result.state, result.message);
  } else if (form.dataset.form === 'thread-message') {
    const message = value('message');
    const task = findTask(form.dataset.id);
    if (!message || !task || preparing.has(task.id)) return;
    if (task.status === 'waiting') recordHomeAnswer(task.id, message);
    else if (task.status === 'collecting') updateHomeTask(addObservation(task, message));
  } else if (form.dataset.form === 'task') {
    if (!value('title')) return;
    const fromQuickAsk = sheet?.drafts?.task && sheet.fromQuickAsk;
    if (fromQuickAsk) {
      askInput.value = '';
      updateComposer(askInput);
    }
    createAndOpenTask({ title: value('title'), brief: value('brief'), due: value('due') });
  } else if (form.dataset.form === 'note' && value('text')) {
    const task = findTask(value('taskId'));
    if (task) updateTask(addObservation(task, value('text')), '맡긴 일에 기록을 더했어요.');
    else commit({ ...state, notes: [createNote(value('text')), ...state.notes] }, '기록을 남겼어요.');
    dismissSheet();
  }
});

dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismissSheet();
});

let sheetDrag = null;
const mobileSheet = matchMedia('(max-width: 640px)');

dialog.addEventListener('pointerdown', event => {
  if (!mobileSheet.matches || event.pointerType === 'mouse' || !event.target.closest('.sheet-grabber')) return;
  sheetDrag = { pointerId: event.pointerId, startY: event.clientY, offset: 0 };
  dialog.setPointerCapture(event.pointerId);
  dialog.classList.add('is-dragging');
});

dialog.addEventListener('pointermove', event => {
  if (sheetDrag?.pointerId !== event.pointerId) return;
  sheetDrag.offset = Math.max(0, event.clientY - sheetDrag.startY);
  dialog.style.setProperty('--sheet-offset', sheetDrag.offset + 'px');
});

function endSheetDrag(event) {
  if (sheetDrag?.pointerId !== event.pointerId) return;
  const { offset } = sheetDrag;
  sheetDrag = null;
  dialog.classList.remove('is-dragging');
  dialog.style.removeProperty('--sheet-offset');
  if (event.type === 'pointerup' && offset > 94) {
    dismissSheet(offset);
  } else if (offset > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.animate([{ translate: '0 ' + offset + 'px' }, { translate: '0 0' }], {
      duration: 210, easing: 'cubic-bezier(.2,.75,.25,1)'
    });
  }
}

dialog.addEventListener('pointerup', endSheetDrag);
dialog.addEventListener('pointercancel', endSheetDrag);

dialog.addEventListener('cancel', event => {
  event.preventDefault();
  dismissSheet();
});

dialog.addEventListener('close', () => {
  sheetExit?.cancel();
  sheetExit = null;
  document.body.classList.remove('sheet-open');
  sheet = null;
  const trigger = returnFocus;
  returnFocus = null;
  const replacement = trigger?.action && [...document.querySelectorAll('[data-action]')].find(button =>
    button.dataset.action === trigger.action && button.dataset.id === trigger.id && button.dataset.tool === trigger.tool
  );
  (trigger?.element.isConnected ? trigger.element : replacement || main).focus({ preventScroll: true });
});

main.addEventListener('input', event => {
  if (event.target.id !== 'library-query') return;
  libraryQuery = event.target.value;
  refreshLibrarySearch();
});

document.addEventListener('keydown', event => {
  if (dialog.open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    setAskOpen(true);
    askInput.focus({ preventScroll: true });
  } else if (event.key === 'Escape' && !askDock.hidden) {
    event.preventDefault();
    setAskOpen(false);
  }
});

document.addEventListener('click', event => {
  if (event.target.closest('a[href="#settings"]') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    routeToDetail('#settings');
    return;
  }
  if (!askDock.hidden && !event.target.closest('#ask-dock, .dock, dialog, [data-action="new-task"]')) {
    setAskOpen(false, { focus: false });
  }
});

window.addEventListener('hashchange', () => {
  if (dialog.open) dialog.close();
  route({ focus: true });
});
function updateKeyboard() {
  const viewport = window.visualViewport;
  const keyboard = viewport && innerHeight - viewport.height > 145
    && document.activeElement?.matches('input, textarea, select');
  document.body.toggleAttribute('data-keyboard', Boolean(keyboard));
  if (keyboard) {
    document.body.style.setProperty('--keyboard-height', viewport.height + 'px');
    document.body.style.setProperty('--keyboard-inset', Math.max(0, innerHeight - viewport.height - viewport.offsetTop) + 'px');
    if (currentPage === 'chat' && threadFooter.contains(document.activeElement)) scrollThread();
  } else {
    document.body.style.removeProperty('--keyboard-height');
    document.body.style.removeProperty('--keyboard-inset');
  }
}

window.visualViewport?.addEventListener('resize', updateKeyboard);
document.addEventListener('focusin', updateKeyboard);
document.addEventListener('focusout', () => requestAnimationFrame(updateKeyboard));
media.addEventListener('change', updateTheme);
bindTouchFeedback(document);
setInterval(() => {
  if (currentPage === 'tools' || dialog.open && sheet?.kind === 'tool') updateToolCountdowns(document);
}, 1000);
initializeAsk();
updateTheme();
route();
