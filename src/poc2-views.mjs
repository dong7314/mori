import { documentFilename } from './poc2-model.mjs';

const libraryTabs = [
  ['tasks', '부탁', 'layers'],
  ['notes', '메모', 'note'],
  ['files', '파일', 'file'],
];
const taskGroups = [
  ['waiting', '내 답변을 기다려요'],
  ['collecting', '모리가 맡은 일'],
  ['ready', '끝낸 일'],
];

const localDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
const localTime = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

function dateKey(value) {
  const parts = Object.fromEntries(localDate.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function byNewest(a, b) {
  return Date.parse(b.at) - Date.parse(a.at);
}

function matches(query, ...values) {
  return !query || values.some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(query));
}

function libraryGroup(title, rows, status = '') {
  return `<section class="library-group"${status ? ` data-status="${status}"` : ''}>
    <h2>${title}</h2>
    <ul class="library-list">${rows.join('')}</ul>
  </section>`;
}

function libraryRow({ title, detail, trail, symbol, action, id }, { icon, esc }) {
  return `<li><button type="button" class="library-row spring-control" data-action="${action}" data-id="${esc(id)}">
    <span class="library-row-icon" aria-hidden="true">${icon(symbol)}</span>
    <span class="library-row-copy"><strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</span>
    <span class="library-row-trailing">${trail ? `<small>${esc(trail)}</small>` : ''}${icon('chevron')}</span>
  </button></li>`;
}

function requests({ state, workingIds, icon, esc, formatDay }, query) {
  const tasks = state.tasks.filter(task => matches(query, task.title, task.brief, task.question));
  return taskGroups.map(([status, title]) => {
    const group = tasks.filter(task => task.status === status);
    if (!group.length) return '';
    const rows = group.map(task => libraryRow({
      title: task.title,
      detail: workingIds?.has(task.id) ? '기록을 정리하는 중'
        : status === 'waiting' ? task.question
        : status === 'ready' ? '결과 파일 있음'
        : `남긴 기록 ${task.observations.length}개`,
      trail: task.due ? formatDay(task.due) : '',
      symbol: task.icon,
      action: 'open-task',
      id: task.id,
    }, { icon, esc }));
    return libraryGroup(title, rows, status);
  }).join('');
}

function files({ state, icon, esc, formatDay }, query) {
  const items = state.tasks.filter(task => task.status === 'ready' && matches(query, task.title, documentFilename(task)))
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  if (!items.length) return '';
  return `<ul class="library-list library-files">${items.map(task => libraryRow({
    title: documentFilename(task),
    detail: `텍스트 파일 · 기록 ${task.observations.length}개`,
    trail: task.completedAt ? formatDay(task.completedAt) : '',
    symbol: 'file',
    action: 'open-file',
    id: task.id,
  }, { icon, esc })).join('')}</ul>`;
}

function notes({ state, icon, esc, formatDay }, query) {
  const entries = state.notes.map(note => ({ text: note.text, at: note.createdAt, task: null, label: '메모' }));
  for (const task of state.tasks) {
    for (const observation of task.observations) {
      entries.push({ text: observation.text, at: observation.at, task, label: observation.kind === 'answer' ? '내 답변' : '기록' });
    }
  }
  entries.sort(byNewest);
  const days = new Map();
  for (const entry of entries) {
    if (!matches(query, entry.text, entry.task?.title)) continue;
    const day = dateKey(entry.at);
    if (!days.has(day)) days.set(day, []);
    const item = `<span class="library-note-mark" aria-hidden="true">${icon(entry.label === '내 답변' ? 'chat' : 'note')}</span>
      <span class="library-note-copy"><span class="library-note-meta">
        <span>${entry.label}</span><time datetime="${esc(entry.at)}">${esc(localTime.format(new Date(entry.at)))}</time>
      </span><span class="library-note-text">${esc(entry.text)}</span>
      ${entry.task ? `<span class="library-note-source">${esc(entry.task.title)}${icon('arrow-up-right')}</span>` : ''}</span>`;
    days.get(day).push(`<li>${entry.task
      ? `<button class="library-note spring-control" type="button" data-action="open-task" data-id="${esc(entry.task.id)}">${item}</button>`
      : `<div class="library-note">${item}</div>`}</li>`);
  }
  return [...days].map(([day, items]) => libraryGroup(`<time datetime="${day}">${esc(formatDay(day))}</time>`, items)).join('');
}

export function renderLibraryResults(context) {
  const query = context.libraryQuery.trim().toLocaleLowerCase('ko-KR');
  const render = { tasks: requests, notes, files }[context.libraryTab];
  const result = render(context, query);
  if (result) return result;
  const empty = { tasks: '아직 맡긴 일이 없어요', notes: '아직 남긴 메모가 없어요', files: '아직 받은 파일이 없어요' };
  return `<div class="library-empty">
    <p>${query ? '일치하는 항목이 없어요' : empty[context.libraryTab]}</p>
  </div>`;
}

function renderLibrary(context) {
  const { libraryTab, libraryQuery, icon, esc } = context;
  return `<div class="library-page" aria-labelledby="library-title">
    <header class="library-heading"><h1 id="library-title">보관함</h1>
      ${libraryTab === 'notes' ? `<button type="button" class="library-add spring-control" data-action="new-note" aria-label="메모 남기기">${icon('plus')}</button>` : ''}
    </header>
    <nav class="library-tabs" aria-label="보관함 구분" data-section="${libraryTab}">
      <span class="library-indicator" aria-hidden="true"></span>
      ${libraryTabs.map(([id, label, symbol]) => `<a class="spring-control" href="#library/${id}"${libraryTab === id ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('')}
    </nav>
    <div class="library-search">
      ${icon('search')}
      <label for="library-query" class="sr-only">보관함 검색</label>
      <input id="library-query" type="search" value="${esc(libraryQuery)}" placeholder="보관함 검색" autocomplete="off" spellcheck="false">
      <button type="button" class="library-search-clear spring-control" data-action="clear-library-query" aria-label="검색어 지우기"${libraryQuery ? '' : ' hidden'}>${icon('close')}</button>
    </div>
    <div class="library-results">${renderLibraryResults(context)}</div>
  </div>`;
}

function renderSettings({ theme, icon }) {
  const themes = [
    ['system', '기기 설정 사용', 'monitor'],
    ['light', '라이트', 'sun'],
    ['dark', '다크', 'moon'],
  ];
  return `<div class="library-page settings-page" aria-labelledby="settings-title">
    <header class="library-heading"><h1 id="settings-title">설정</h1></header>
    <section class="library-group" aria-labelledby="settings-theme-title">
      <h2 id="settings-theme-title">화면 모드</h2>
      <div class="setting-options" role="group" aria-label="화면 모드">
        ${themes.map(([id, label, symbol]) => `<button type="button" class="setting-option spring-control" data-action="theme" data-theme="${id}" aria-pressed="${theme === id}">
          ${icon(symbol)}<span>${label}</span>${theme === id ? icon('check') : ''}
        </button>`).join('')}
      </div>
    </section>
    <section class="library-group" aria-labelledby="settings-storage-title">
      <h2 id="settings-storage-title">저장 공간</h2>
      <p class="setting-help">부탁과 일정, 메모는 이 브라우저에 저장돼요.</p>
      <button type="button" class="setting-option spring-control" data-action="reset">${icon('reset')}<span>예시 데이터로 되돌리기</span>${icon('chevron')}</button>
    </section>
  </div>`;
}

export function renderSecondary(page, context) {
  if (page === 'library') return renderLibrary(context);
  if (page === 'settings') return renderSettings(context);
  return '';
}
