import { TASK_STATUS_LABELS } from './poc2-model.mjs';

const FILTERS = [['all', '전체'], ...Object.entries(TASK_STATUS_LABELS)];
const seoulDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
});
const seoulTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit'
});

function renderWorks({ state, filter, icon, esc, formatDay }) {
  const activeFilter = FILTERS.some(([value]) => value === filter) ? filter : 'all';
  const tasks = state.tasks.filter(task => activeFilter === 'all' || task.status === activeFilter);
  const filters = FILTERS.map(([value, label]) => {
    return `<button type="button" class="sec-filter ${activeFilter === value ? 'is-selected' : ''}"
      data-action="filter" data-filter="${value}" aria-pressed="${activeFilter === value}">
      <span>${label}</span>
    </button>`;
  }).join('');

  const cards = tasks.map(task => {
    const lastObservation = task.observations.at(-1);
    return `<li class="sec-work-item">
      <button type="button" class="sec-work-card" data-action="open-task" data-id="${esc(task.id)}">
        <span class="sec-work-icon" aria-hidden="true">${icon(task.icon)}</span>
        <span class="sec-work-copy">
          <strong class="sec-work-title">${esc(task.title)}</strong>
          <span class="sec-work-brief">${esc(lastObservation?.text || task.brief)}</span>
          <span class="sec-work-meta">
            <span class="sec-status sec-status--${task.status}">${TASK_STATUS_LABELS[task.status]}</span>
            ${task.due ? `<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}</time>` : ''}
          </span>
        </span>
        <span class="sec-work-arrow" aria-hidden="true">${icon('chevron')}</span>
      </button>
    </li>`;
  }).join('');

  const empty = `<div class="sec-empty">
    <span class="sec-empty-icon" aria-hidden="true">${icon('layers')}</span>
    <h2>${activeFilter === 'all' ? '아직 맡긴 일이 없어요' : '이 상태의 일이 없어요'}</h2>
    ${activeFilter === 'all'
      ? '<p>홈에서 모리에게 부탁을 남겨보세요.</p>'
      : '<button type="button" class="sec-text-button" data-action="filter" data-filter="all">전체 보기</button>'}
  </div>`;

  return `<div class="sec-page sec-works">
    <header class="page-heading sec-heading"><h1>맡은 일</h1></header>
    <div class="sec-filters" role="group" aria-label="일의 상태">${filters}</div>
    ${tasks.length ? `<ul class="sec-work-list">${cards}</ul>` : empty}
  </div>`;
}

function localDay(value) {
  const parts = Object.fromEntries(seoulDate.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function renderNotes({ state, icon, esc, formatDay }) {
  const entries = state.notes.map(note => ({
    text: note.text,
    at: note.createdAt,
    label: '메모',
    task: null,
  }));

  for (const task of state.tasks) {
    for (const observation of task.observations) {
      entries.push({
        text: observation.text,
        at: observation.at,
        label: observation.kind === 'answer' ? '내 답변' : '기록',
        task,
      });
    }
  }
  entries.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  const days = new Map();
  for (const entry of entries) {
    const day = localDay(entry.at);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(entry);
  }

  const sections = [...days].map(([day, notes]) => {
    const items = notes.map(entry => {
      const content = `<span class="sec-note-meta">
        <span>${entry.label}</span>
        <time datetime="${esc(entry.at)}">${esc(seoulTime.format(new Date(entry.at)))}</time>
      </span>
      <span class="sec-note-text">${esc(entry.text)}</span>
      ${entry.task ? `<span class="sec-note-source"><span aria-hidden="true">${icon(entry.task.icon)}</span>${esc(entry.task.title)}<span class="sec-note-arrow" aria-hidden="true">${icon('arrow-up-right')}</span></span>` : ''}`;

      return `<li class="sec-note-item">${entry.task
        ? `<button type="button" class="sec-note-card sec-note-card--linked" data-action="open-task" data-id="${esc(entry.task.id)}">${content}</button>`
        : `<div class="sec-note-card">${content}</div>`}</li>`;
    }).join('');

    return `<section class="sec-note-day" aria-labelledby="sec-note-day-${day}">
      <h2 class="sec-day-heading" id="sec-note-day-${day}"><time datetime="${day}">${esc(formatDay(day))}</time></h2>
      <ol class="sec-note-list">${items}</ol>
    </section>`;
  }).join('');

  return `<div class="sec-page sec-notes">
    <header class="page-heading sec-heading">
      <h1>기록</h1>
      <button type="button" class="sec-add-button" data-action="new-note" aria-label="메모 남기기"><span aria-hidden="true">${icon('plus')}</span><span>메모</span></button>
    </header>
    ${entries.length ? `<div class="sec-notebook">${sections}</div>` : `<div class="sec-empty">
      <span class="sec-empty-icon" aria-hidden="true">${icon('note')}</span>
      <h2>아직 남긴 기록이 없어요</h2>
      <p>맡긴 일에 남긴 내용과 따로 적은 메모가 여기에 모여요.</p>
    </div>`}
  </div>`;
}

function renderSettings({ theme, icon }) {
  const themes = [
    ['system', '시스템', 'monitor'],
    ['light', '라이트', 'sun'],
    ['dark', '다크', 'moon'],
  ];
  const options = themes.map(([value, label, symbol]) => `<button type="button"
    class="sec-theme-option ${theme === value ? 'is-selected' : ''}" data-action="theme" data-theme="${value}"
    aria-pressed="${theme === value}"><span class="sec-theme-icon" aria-hidden="true">${icon(symbol)}</span><span>${label}</span><span class="sec-theme-check" aria-hidden="true">${theme === value ? icon('check') : ''}</span>
  </button>`).join('');

  return `<div class="sec-page sec-settings">
    <header class="page-heading sec-heading"><h1>설정</h1></header>
    <section class="sec-setting-section" aria-labelledby="sec-theme-title">
      <h2 class="sec-setting-title" id="sec-theme-title">화면 모드</h2>
      <div class="sec-theme-options" role="group" aria-label="화면 모드">${options}</div>
      <p class="sec-setting-help">시스템을 선택하면 기기의 화면 모드를 따라가요.</p>
    </section>
    <section class="sec-setting-section" aria-labelledby="sec-demo-title">
      <h2 class="sec-setting-title" id="sec-demo-title">체험</h2>
      <div class="sec-setting-group">
      <details class="sec-demo-info">
        <summary class="sec-setting-row"><span aria-hidden="true">${icon('info')}</span><span>체험 안내</span><span class="sec-summary-arrow" aria-hidden="true">${icon('chevron')}</span></summary>
        <div class="sec-demo-content"><p>예시 자료로 모리가 맡은 일의 진행 상황과 결과를 체험할 수 있어요. 새로 남긴 부탁과 기록은 이 브라우저에 저장돼요.</p></div>
      </details>
      <button type="button" class="sec-setting-row sec-reset-button" data-action="reset"><span aria-hidden="true">${icon('reset')}</span><span>처음 상태로 되돌리기</span></button>
      </div>
      <p class="sec-setting-help">되돌리면 추가한 메모와 변경한 작업을 지우고 처음의 예시를 불러와요.</p>
    </section>
  </div>`;
}

export function renderSecondary(page, context) {
  if (page === 'works') return renderWorks(context);
  if (page === 'notes') return renderNotes(context);
  if (page === 'settings') return renderSettings(context);
  return '';
}
