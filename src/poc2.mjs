import { renderAssistant, renderThreadComposer, renderThreadContext, renderTurns } from './poc2-assistant.mjs';
import { bindTouchFeedback, playThreadReply, playView } from './poc2-motion.mjs';
import { icon } from './poc2-icons.mjs';
import { renderSecondary } from './poc2-views.mjs';
import { renderComposer, renderTaskSheet } from './poc2-sheets.mjs';
import {
  createDemoState, loadState, saveState, createTask, createNote,
  addObservation, answerQuestion, completeTask, formatDay, documentText
} from './poc2-model.mjs';

const pages = {
  today: ['모리', 'mori'],
  works: ['맡은 일', 'layers'],
  notes: ['기록', 'note'],
  settings: ['설정', 'settings']
};
const themeKey = 'mori.poc2.theme';
const taskKey = 'mori.poc2.active-task';
const main = document.querySelector('.workspace');
const appBar = document.querySelector('.app-bar');
const dock = document.querySelector('.dock');
const threadFooter = document.querySelector('.thread-footer');
const dialog = document.querySelector('.mori-sheet');
const toast = document.querySelector('.toast');
const media = matchMedia('(prefers-color-scheme: dark)');
const storage = getStorage();
let state = loadState(storage);
let theme = readTheme();
let currentPage = 'today';
let filter = 'all';
let homeTaskId = loadTaskSelection();
const replyDrafts = new Map();
let sheet = null;
let returnFocus = null;
let toastTimer;

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
  document.querySelector('meta[name="theme-color"]').content = mode === 'dark' ? '#1c201d' : '#fcfdfb';
}

function renderNavigation() {
  const onThread = currentPage === 'today';
  appBar.innerHTML = `
    ${onThread ? `<button class="thread-identity spring-control" type="button" data-action="focus-thread" aria-label="모리에게 말하기">
      <span class="thread-avatar"><img src="/assets/mori-poc2.webp" width="44" height="44" alt=""></span>
      <span class="thread-identity-copy"><strong>모리</strong><small class="thread-state"></small></span>
    </button>` : '<a class="brand-wordmark spring-control" href="#today" aria-label="모리 홈">모리</a>'}
    <a class="utility-control glass spring-control" href="#settings" aria-label="설정"
       ${currentPage === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}</a>`;
  if (!dock.firstElementChild) {
    const links = Object.entries(pages).filter(([page]) => page !== 'settings').map(([page, [label, glyph]]) => `
      <a class="nav-link spring-control" href="#${page}" data-page="${page}">
        ${icon(glyph)}<span>${label}</span>
      </a>`).join('');
    dock.innerHTML = `<nav class="dock-tabs glass" aria-label="주요 메뉴">
      <span class="tab-indicator" aria-hidden="true"></span>${links}
    </nav>
    <button class="dock-action glass spring-control" type="button" data-action="new-task" aria-label="새 부탁">${icon('plus')}</button>`;
  }
  dock.dataset.view = currentPage;
  for (const link of dock.querySelectorAll('[data-page]')) {
    if (link.dataset.page === currentPage) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
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
  const slug = location.hash.slice(1);
  const previousPage = currentPage;
  currentPage = Object.hasOwn(pages, slug) ? slug : 'today';
  document.body.dataset.view = currentPage;
  document.title = currentPage === 'today' ? '모리' : '모리 · ' + pages[currentPage][0];
  renderNavigation();
  renderPage();
  if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  if (currentPage === 'today') scrollThread();
  else {
    const order = Object.keys(pages);
    playView(main.querySelector('.sec-page'), order.indexOf(currentPage) >= order.indexOf(previousPage) ? 1 : -1);
  }
}

const threadView = { icon, esc, formatDay };

function updateTranscript(log, markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  const existing = new Map([...log.children].map(node => [node.dataset.turnKey, node]));
  let current = log.firstElementChild;
  for (const turn of [...template.content.children]) {
    const previous = existing.get(turn.dataset.turnKey);
    const node = previous?.isEqualNode(turn) ? previous : turn;
    if (node !== current) log.insertBefore(node, current);
    current = node.nextElementSibling;
    if (previous === node) existing.delete(turn.dataset.turnKey);
  }
  for (const stale of existing.values()) stale.remove();
}

function renderPage() {
  const onThread = currentPage === 'today';
  threadFooter.hidden = !onThread;
  if (!onThread) {
    threadFooter.replaceChildren();
    delete threadFooter.dataset.key;
    main.innerHTML = renderSecondary(currentPage, { state, filter, theme, icon, esc, formatDay });
    return;
  }

  const task = homeTask();
  const active = main.querySelector('.thread');
  if (!active || active.dataset.threadId !== task?.id) main.innerHTML = renderAssistant(task, threadView);
  const status = appBar.querySelector('.thread-state');
  if (status) {
    status.textContent = ({ waiting: '답변 기다리는 중', collecting: '기록 모으는 중', ready: '파일 준비 완료' })[task?.status] ?? '';
    const label = task?.status === 'ready' ? '정리한 파일로 이동' : task ? '모리에게 말하기' : '새 부탁';
    status.closest('button').setAttribute('aria-label', label);
  }
  if (task) {
    const context = main.querySelector('.thread-context');
    if (!context.firstElementChild) context.innerHTML = renderThreadContext(task, threadView);
    updateTranscript(main.querySelector('.thread-log'), renderTurns(task, threadView));
  }

  const key = task ? task.id + ':' + task.status : '';
  if (threadFooter.dataset.key !== key) {
    threadFooter.innerHTML = renderThreadComposer(task, threadView);
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

function openThread(id) {
  if (!findTask(id)) return;
  selectTask(id);
  if (currentPage !== 'today') {
    location.hash = 'today';
    return;
  }
  renderNavigation();
  renderPage();
  scrollThread();
  main.focus({ preventScroll: true });
}

function updateComposer(input) {
  input.form.querySelector('button[type="submit"]').disabled = !input.value.trim();
}

function updateHomeTask(task) {
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
  const last = [...main.querySelectorAll('.thread-turn')].at(-1);
  const file = last?.querySelector('.thread-file');
  scrollThread();
  if (!previousFocus?.isConnected) (file ?? threadFooter.querySelector('#thread-input') ?? main).focus({ preventScroll: true });
  playThreadReply(appBar.querySelector('.thread-avatar img'), last, hasFile);
}

function announce(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('shown');
  toastTimer = setTimeout(() => {
    toast.classList.remove('shown');
    toast.textContent = '';
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

function renderDialog() {
  if (sheet.kind === 'task') {
    const task = findTask(sheet.id);
    if (!task) return;
    dialog.innerHTML = renderTaskSheet(task, { icon, esc, formatDay });
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
      <p>이 브라우저에서 추가한 부탁과 기록을 지우고 처음 예시를 다시 엽니다.</p>
      <div class="sheet-actions"><button type="button" data-action="close-sheet" class="sheet-secondary">취소</button>
      <button type="button" data-action="confirm-reset" class="sheet-primary">되돌리기</button></div></div>`;
  }
  dialog.insertAdjacentHTML('afterbegin', '<div class="sheet-grabber" aria-hidden="true"><span></span></div>');
}

function showSheet(next, trigger = document.activeElement) {
  if (!dialog.open) {
    returnFocus = trigger instanceof HTMLElement ? { element: trigger, id: trigger.dataset.id, action: trigger.dataset.action } : null;
  }
  sheet = next;
  dialog.dataset.kind = next.kind;
  renderDialog();
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('sheet-open');
  dialog.scrollTop = 0;
  dialog.querySelector('#sheet-title')?.focus({ preventScroll: true });
}

function focusInDialog(selector = '#sheet-title') {
  const target = dialog.querySelector(selector) ?? dialog.querySelector('#sheet-title');
  target?.focus({ preventScroll: true });
}

function showNextStage() {
  renderDialog();
  focusInDialog();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const panel = dialog.querySelector('.sheet-intro') ?? dialog.querySelector('#sheet-title');
    panel?.animate([{ opacity: 0.48, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], {
      duration: 240, easing: 'cubic-bezier(.2,.75,.25,1)'
    });
  }
}

function download(task) {
  const url = URL.createObjectURL(new Blob([documentText(task)], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = task.title.replace(/[\\/:*?"<>|]/g, '_') + '.txt';
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
    case 'new-task':
      showSheet({ kind: 'compose', mode: 'task' }, button);
      break;
    case 'new-note':
      showSheet({ kind: 'compose', mode: 'note', id }, button);
      break;
    case 'focus-thread': {
      const editor = threadFooter.querySelector('#thread-input');
      const file = main.querySelector('.thread-file');
      if (editor) editor.focus();
      else if (file) { scrollThread(); file.focus(); }
      else showSheet({ kind: 'compose', mode: 'task' }, button);
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
        updateHomeTask(completeTask(task));
      }
      break;
    }
    case 'home-download': {
      const task = findTask(id);
      if (task?.status === 'ready') download(task);
      break;
    }
    case 'open-task':
      if (findTask(id)) showSheet({ kind: 'task', id }, button);
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
      dialog.close();
      break;
    case 'quick-answer':
      recordAnswer(button.dataset.answer);
      break;
    case 'finish-task': {
      const task = findTask(sheet?.id);
      if (task?.status === 'collecting' && task.observations.length) {
        updateTask(completeTask(task), '결과가 준비됐어요.');
        showNextStage();
      }
      break;
    }
    case 'download-task': {
      const task = findTask(sheet?.id);
      if (task?.status === 'ready') download(task);
      break;
    }
    case 'filter':
      filter = button.dataset.filter;
      setFilter(filter, 'filter', 'filter');
      break;
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
      filter = 'all';
      selectTask(null);
      replyDrafts.clear();
      commit(createDemoState(), '처음 예시를 다시 불러왔어요.');
      dialog.close();
      break;
  }
});

function recordAnswer(value) {
  const task = findTask(sheet?.id);
  const answer = String(value ?? '').trim();
  if (task?.status !== 'waiting' || !answer) return;
  updateTask(completeTask(answerQuestion(task, answer)), '답변을 기록하고 파일을 준비했어요.');
  showNextStage();
}

function recordHomeAnswer(id, text) {
  const task = findTask(id);
  const answer = text.trim();
  if (task?.status !== 'waiting' || !answer) return;
  updateHomeTask(completeTask(answerQuestion(task, answer)));
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
  const fields = new FormData(form);
  const value = name => String(fields.get(name) ?? '').trim();
  if (form.dataset.form === 'thread-message') {
    const message = value('message');
    const task = findTask(form.dataset.id);
    if (!message || !task) return;
    if (task.status === 'waiting') recordHomeAnswer(task.id, message);
    else if (task.status === 'collecting') updateHomeTask(addObservation(task, message));
  } else if (form.dataset.form === 'task') {
    if (!value('title')) return;
    const task = createTask({ title: value('title'), brief: value('brief'), due: value('due') });
    selectTask(task.id);
    commit({ ...state, tasks: [task, ...state.tasks] }, '모리가 새 부탁을 맡았어요.');
    dialog.close();
    openThread(task.id);
  } else if (form.dataset.form === 'answer') {
    recordAnswer(value('answer'));
  } else if (form.dataset.form === 'note' && value('text')) {
    const task = findTask(value('taskId'));
    if (task) updateTask(addObservation(task, value('text')), '맡긴 일에 기록을 더했어요.');
    else commit({ ...state, notes: [createNote(value('text')), ...state.notes] }, '기록을 남겼어요.');
    dialog.close();
  } else if (form.dataset.form === 'observation' && value('observation')) {
    const task = findTask(sheet?.id);
    if (!task) return;
    updateTask(addObservation(task, value('observation')), '기록을 더했어요.');
    showNextStage();
  }
});

dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
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
    dialog.close();
  } else if (offset > 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.animate([{ translate: '0 ' + offset + 'px' }, { translate: '0 0' }], {
      duration: 210, easing: 'cubic-bezier(.2,.75,.25,1)'
    });
  }
}

dialog.addEventListener('pointerup', endSheetDrag);
dialog.addEventListener('pointercancel', endSheetDrag);

dialog.addEventListener('close', () => {
  document.body.classList.remove('sheet-open');
  sheet = null;
  const trigger = returnFocus;
  returnFocus = null;
  const replacement = trigger?.action && document.querySelector(
    `[data-action="${CSS.escape(trigger.action)}"]${trigger.id ? '[data-id="' + CSS.escape(trigger.id) + '"]' : ''}`
  );
  (trigger?.element.isConnected ? trigger.element : replacement || main).focus({ preventScroll: true });
});

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !dialog.open) {
    event.preventDefault();
    showSheet({ kind: 'compose', mode: 'task' });
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
  if (keyboard) document.body.style.setProperty('--keyboard-height', viewport.height + 'px');
  else document.body.style.removeProperty('--keyboard-height');
}

window.visualViewport?.addEventListener('resize', updateKeyboard);
document.addEventListener('focusin', updateKeyboard);
document.addEventListener('focusout', () => requestAnimationFrame(updateKeyboard));
media.addEventListener('change', updateTheme);
bindTouchFeedback(document);
updateTheme();
route();
