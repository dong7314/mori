import { icon } from './poc2-icons.mjs';
import { renderSecondary } from './poc2-views.mjs';
import { renderComposer, renderTaskSheet } from './poc2-sheets.mjs';
import {
  DEMO_DATE, TASK_STATUS_LABELS as statuses, createDemoState, loadState, saveState, createTask, createNote,
  addObservation, answerQuestion, completeTask, formatDay, documentText
} from './poc2-model.mjs';

const pages = {
  today: ['오늘', 'home'],
  works: ['맡은 일', 'layers'],
  notes: ['기록', 'note'],
  settings: ['설정', 'settings']
};
const heroAsset = '/assets/mori-poc2.webp';
const themeKey = 'mori.poc2.theme';
const today = new Intl.DateTimeFormat('ko-KR', {
  month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC'
}).format(new Date(DEMO_DATE));

const main = document.querySelector('.workspace');
const sidebar = document.querySelector('.sidebar');
const dock = document.querySelector('.mobile-dock');
const dialog = document.querySelector('.mori-sheet');
const toast = document.querySelector('.toast');
const media = matchMedia('(prefers-color-scheme: dark)');
const storage = getStorage();
let state = loadState(storage);
let theme = readTheme();
let currentPage = 'today';
let filter = 'all';
let weekDay = null;
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

function statusPill(status) {
  return `<span class="status-pill" data-status="${status}"><span></span>${statuses[status]}</span>`;
}

function brand() {
  return '<span class="brand-mark" aria-hidden="true"><i></i><i></i><b></b></span><span class="wordmark">mori<span>.</span></span>';
}

function updateTheme() {
  const mode = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]').content = mode === 'dark' ? '#181a17' : '#f7f7f4';
}

function navLinks() {
  return Object.entries(pages).map(([page, [label, glyph]]) => `
    <a class="nav-link" href="#${page}" aria-label="${label}" ${page === currentPage ? 'aria-current="page"' : ''}>
      ${icon(glyph)}<span>${label}</span>
    </a>`).join('');
}

function renderNavigation() {
  const links = navLinks();
  sidebar.innerHTML = `
    <a class="brand" href="#today" aria-label="모리 홈">${brand()}</a>
    <nav class="side-nav" aria-label="주요 메뉴">${links}</nav>
    <a class="side-profile" href="#settings" aria-label="동엽, 설정"><span class="avatar" aria-hidden="true">동</span>
      <span class="side-profile-copy"><strong>동엽</strong><small>내 작업 공간</small></span>${icon('chevron')}
    </a>`;
  dock.innerHTML = `${links}<button class="dock-add" type="button" data-action="new-task" aria-label="새 부탁">${icon('plus')}</button>`;
}

function findTask(id) {
  return state.tasks.find(task => task.id === id);
}

function listRow(task) {
  return `<button class="work-row" type="button" data-action="open-task" data-id="${esc(task.id)}">
    <span class="work-icon" data-icon="${esc(task.icon)}">${icon(task.icon)}</span>
    <span class="work-copy"><strong>${esc(task.title)}</strong>
      <span>${task.due ? esc(formatDay(task.due)) + '까지' : '기한 없음'} <i aria-hidden="true">·</i> 기록 ${task.observations.length}개</span>
    </span>${statusPill(task.status)}<span class="work-chevron">${icon('chevron')}</span>
  </button>`;
}

function renderHero(task) {
  const waiting = task?.status === 'waiting';
  const ready = task?.status === 'ready';
  const label = waiting ? '확인 필요' : ready ? '준비 완료' : task ? '모으는 중' : '새 부탁';
  const description = task
    ? (waiting ? '기록을 모았어요. 한 가지만 확인하면 돼요.' : ready ? '필요한 날 바로 꺼낼 수 있게 준비해 뒀어요.' : '새로 남긴 기록을 이곳에 모아둘게요.')
    : '결과와 기한을 한 문장으로 알려주세요.';
  return `
    <article class="focus-card" data-state="${task?.status ?? 'empty'}">
      <div class="focus-copy">
        <span class="focus-status"><span></span>${label}</span>
        <h2>${esc(task?.title ?? '어떤 일을 맡길까요?')}</h2>
        <p>${description}</p>
        <button class="focus-button" type="button" data-action="${task ? 'open-task' : 'new-task'}"
          ${task ? 'data-id="' + esc(task.id) + '"' : ''}>${task ? '진행 상황 보기' : '새 부탁'}${icon('arrow')}</button>
      </div>
      <div class="focus-art" aria-hidden="true">
        <span class="art-ring"></span><span class="art-ring outer-ring"></span>
        <img src="${heroAsset}" width="520" height="520" alt="" fetchpriority="high">
      </div>
      ${task?.due ? `<div class="focus-date">${icon('calendar')}${esc(formatDay(task.due))}까지</div>` : ''}
    </article>`;
}

function renderAttention(task) {
  const waiting = task?.status === 'waiting';
  const ready = task?.status === 'ready';
  const empty = !task;
  const detail = waiting
    ? esc(task.question ?? '기록의 내용을 한 번 확인해 주세요.')
    : ready ? '정리한 결과를 바로 열어볼 수 있어요.'
      : empty ? '어떤 일이든 필요한 날까지 맡길 수 있어요.' : '관찰한 내용이나 참고할 정보를 덧붙일 수 있어요.';
  return `
    <section class="attention-card" aria-label="${waiting ? '모리의 질문' : '다음 단계'}">
      <span class="attention-icon">${icon(waiting ? 'chat' : ready ? 'check' : 'note')}</span>
      <div class="attention-copy">
        <p class="attention-kicker">${waiting ? '모리가 궁금한 점' : ready ? '파일 준비 완료' : '기록 남기기'}</p>
        <h3>${detail}</h3>
      </div>
      <button type="button" class="attention-button" data-action="${waiting ? 'answer-task' : ready ? 'open-task' : 'new-note'}"
        ${task ? 'data-id="' + esc(task.id) + '"' : ''}>
        ${waiting ? '답변하기' : ready ? '결과 보기' : '기록 추가'}${icon('arrow')}
      </button>
    </section>`;
}

function weekDates() {
  const start = new Date(DEMO_DATE + 'T00:00:00Z');
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    return { value: date.toISOString().slice(0, 10), day: date.getUTCDate(),
      weekday: ['월', '화', '수', '목', '금', '토', '일'][offset] };
  });
}

function renderWeek() {
  const days = weekDates();
  const scheduled = state.tasks.filter(task => days.some(day => day.value === task.due)
    && (!weekDay || weekDay === task.due)).sort((a, b) => a.due.localeCompare(b.due));
  return `
    <section class="week-card" aria-labelledby="week-heading">
      <div class="section-bar"><h2 id="week-heading">이번 주</h2><span>${esc(formatDay(days[0].value))}–${days[6].day}일</span></div>
      <div class="week-days" aria-label="날짜 선택">
        ${days.map(day => `<button class="week-day ${day.value === DEMO_DATE ? 'is-today' : ''}" type="button"
          data-action="week-day" data-day="${day.value}" aria-pressed="${day.value === weekDay}"
          aria-label="${esc(formatDay(day.value))} ${day.weekday}요일"
          ${day.value === DEMO_DATE ? 'aria-current="date"' : ''}>
          <span>${day.weekday}</span><strong>${day.day}</strong>
          <i class="${state.tasks.some(task => task.due === day.value) ? 'has-task' : ''}" aria-hidden="true"></i>
        </button>`).join('')}
      </div>
      <div class="week-agenda">
        ${scheduled.length ? scheduled.map(task => `<button type="button" data-action="open-task" data-id="${esc(task.id)}">
          <span class="agenda-symbol">${icon(task.icon)}</span><span><strong>${esc(task.title)}</strong><small>${esc(formatDay(task.due))}까지 준비</small></span>${icon('chevron')}
        </button>`).join('') : '<p>이 날 준비할 일은 없어요.</p>'}
      </div>
    </section>`;
}

function renderToday() {
  const first = ['waiting', 'collecting', 'ready'].map(status => state.tasks.find(task => task.status === status)).find(Boolean);
  const order = Object.keys(statuses);
  const recentTasks = [...state.tasks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).slice(0, 3);
  return `
    <header class="workspace-heading">
      <div class="mobile-brand"><a class="brand" href="#today" aria-label="모리 홈">${brand()}</a>
        <a class="avatar" href="#settings" aria-label="설정">동</a>
      </div>
      <div class="heading-row">
        <div><p class="today-date"><time datetime="${DEMO_DATE}">${today}</time></p>
          <h1>안녕하세요, 동엽님.</h1></div>
        <button class="primary-button desktop-add" type="button" data-action="new-task">${icon('plus')}새 부탁</button>
      </div>
    </header>
    <section class="home-focus" aria-label="지금 챙기는 일">
      ${renderHero(first)}${renderAttention(first)}
    </section>
    <div class="home-details">
      <section class="work-section" aria-labelledby="work-heading">
        <div class="section-bar"><h2 id="work-heading">모리가 맡은 일</h2><a href="#works">전체 보기${icon('chevron')}</a></div>
        <div class="work-list">${recentTasks.map(listRow).join('') || '<p class="row-empty">맡긴 일이 여기에 모여요.</p>'}</div>
      </section>
      ${renderWeek()}
    </div>`;
}

function route({ focus = false } = {}) {
  const slug = location.hash.slice(1);
  currentPage = Object.hasOwn(pages, slug) ? slug : 'today';
  document.title = '모리 · ' + pages[currentPage][0];
  renderNavigation();
  renderPage();
  if (focus) {
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function renderPage() {
  main.innerHTML = currentPage === 'today' ? renderToday()
    : renderSecondary(currentPage, { state, filter, theme, icon, esc, formatDay });
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
  if (message) announce(stored ? message : '이 화면에 반영했어요. 브라우저에는 저장할 수 없어요.');
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
    case 'answer-task':
      if (findTask(id)) {
        showSheet({ kind: 'task', id }, button);
        dialog.querySelector('.sheet-quick-answer, #sheet-answer')?.focus({ preventScroll: true });
      }
      break;
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
    case 'week-day':
      weekDay = weekDay === button.dataset.day ? null : button.dataset.day;
      setFilter(button.dataset.day, 'week-day', 'day');
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
      weekDay = null;
      commit(createDemoState(), '처음 예시를 다시 불러왔어요.');
      dialog.close();
      break;
  }
});

function recordAnswer(value) {
  const task = findTask(sheet?.id);
  const answer = String(value ?? '').trim();
  if (task?.status !== 'waiting' || !answer) return;
  updateTask(answerQuestion(task, answer), '답변을 기록했어요.');
  showNextStage();
}

document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  const fields = new FormData(form);
  const value = name => String(fields.get(name) ?? '').trim();
  if (form.dataset.form === 'task') {
    if (!value('title')) return;
    const task = createTask({ title: value('title'), brief: value('brief'), due: value('due') });
    commit({ ...state, tasks: [task, ...state.tasks] }, '모리가 새 부탁을 맡았어요.');
    showSheet({ kind: 'task', id: task.id });
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
media.addEventListener('change', updateTheme);
updateTheme();
route();
