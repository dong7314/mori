const statusText = {
  waiting: '답변을 기다려요',
  collecting: '기록을 모으고 있어요',
  working: '파일을 정리하는 중이에요',
  ready: '결과 파일이 준비됐어요',
};

const yearMonth = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', year: 'numeric', month: 'long' });
const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', weekday: 'long' });
const clock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit',
});

function renderDate(today, fallback, esc) {
  const date = new Date(`${today}T00:00:00.000Z`);
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(today ?? '') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === today;
  if (!hasDate) return `<h1 class="dash-heading dash-heading-simple" id="dashboard-title" tabindex="-1"><span>오늘</span><small>${esc(fallback ?? '')}</small></h1>`;

  return `<h1 class="dash-heading" id="dashboard-title" tabindex="-1">
    <time class="dash-date" datetime="${esc(today)}">
      <span class="dash-date-number" aria-hidden="true">${date.getUTCDate()}</span>
      <span class="dash-date-meta" aria-hidden="true">
        <span class="dash-date-month">${esc(yearMonth.format(date))}</span>
        <span class="dash-date-weekday">${esc(weekday.format(date))}</span>
      </span>
      <span class="sr-only">오늘 ${esc(yearMonth.format(date))} ${date.getUTCDate()}일 ${esc(weekday.format(date))}</span>
    </time>
  </h1>`;
}

function renderSpotlight(task, { icon, esc, formatDay, avatar, workingIds }) {
  const waiting = task?.status === 'waiting';
  const working = Boolean(task && workingIds.has(task.id));
  const mood = working ? 'working' : task?.status ?? 'idle';
  const action = waiting ? 'open-thread' : task ? 'open-task' : 'new-task';
  const heading = waiting ? task.question || task.title : task?.title || '어떤 일을 맡길까요?';
  const label = waiting ? '모리의 질문' : working ? '정리 중' : task ? '맡은 일' : '새 부탁';
  return `
    <section class="dash-spotlight" aria-labelledby="dash-spotlight-title" data-status="${mood}">
      <div class="dash-spotlight-copy">
        <p class="dash-spotlight-label">${label}</p>
        <h2 id="dash-spotlight-title">${esc(heading)}</h2>
        ${task ? `<p class="dash-spotlight-context">
          <span>${waiting ? esc(task.title) : working ? '결과 파일을 준비하고 있어요' : `기록 ${task.observations.length}개`}</span>
          ${task.due ? `<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time>` : ''}
        </p>` : ''}
        <button type="button" class="dash-spotlight-action spring-control" data-action="${action}"${task ? ` data-id="${esc(task.id)}"` : ''}>
          <span>${waiting ? '답하기' : task ? '진행 보기' : '일 맡기기'}</span>${icon('arrow')}
        </button>
      </div>
      <div class="dash-spotlight-art" aria-hidden="true">${avatar(mood, { large: true })}</div>
    </section>
  `;
}

function renderAgenda(items, { icon, esc }) {
  return `
    <section class="dash-agenda" aria-labelledby="dash-agenda-title">
      <div class="dash-section-heading">
        <h2 id="dash-agenda-title">오늘 일정</h2>
        <a class="dash-link spring-control" href="#schedule">전체 일정${icon('chevron')}</a>
      </div>
      ${items.length ? `<ol class="dash-agenda-list">
        ${items.slice(0, 4).map(item => {
          const action = item.type === 'task' ? 'open-task' : item.type === 'tool' ? 'open-tool' : 'open-event';
          const detail = item.type === 'tool' ? item.detail : item.place;
          return `
            <li>
              <button class="dash-agenda-item spring-control" type="button" data-action="${action}"
                data-id="${esc(item.id)}" data-type="${esc(item.type)}"${item.type === 'tool' ? ` data-tool="${esc(item.tool)}"` : ''}>
                <span class="dash-agenda-time">${item.time ? `<time datetime="${esc(item.time)}">${esc(item.time)}</time>` : item.type === 'task' ? '마감' : '종일'}</span>
                <span class="dash-agenda-point" aria-hidden="true"></span>
                <span class="dash-line-copy"><strong>${esc(item.title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</span>
                <span class="dash-row-arrow">${icon('chevron')}</span>
              </button>
            </li>
          `;
        }).join('')}
      </ol>` : `<div class="dash-agenda-empty">
        <p>오늘 잡힌 일정이 없어요.</p>
        <button type="button" class="dash-link spring-control" data-action="new-event">${icon('plus')}일정 추가</button>
      </div>`}
    </section>
  `;
}

function taskRow(task, { icon, esc, formatDay, workingIds }) {
  const { id, title, due, status, completedAt, observations } = task;
  const done = status === 'ready';
  const action = done ? 'open-file' : 'open-task';
  const eventDate = done ? completedAt : due;
  const statusLabel = done ? '텍스트 파일' : status === 'waiting' ? '답변 대기'
    : workingIds.has(id) ? '정리 중' : `기록 ${observations.length}개`;
  return `
    <li class="dash-record">
      <button class="dash-record-main spring-control" type="button" data-action="${action}" data-id="${esc(id)}">
        <span class="dash-record-icon">${icon(done ? 'file' : task.icon)}</span>
        <span class="dash-line-copy">
          <strong>${esc(title)}</strong>
          <small>${statusLabel}${eventDate ? ` <span aria-hidden="true">·</span> <time datetime="${esc(eventDate)}">${esc(formatDay(eventDate))}${done ? '' : '까지'}</time>` : ''}</small>
        </span>
        ${done ? '' : `<span class="dash-row-arrow">${icon('chevron')}</span>`}
      </button>
      ${done ? `<button class="dash-file-download spring-control" type="button" data-action="home-download"
        data-id="${esc(id)}" aria-label="${esc(title)} 파일 받기">${icon('download')}</button>` : ''}
    </li>
  `;
}

function renderGroup(id, label, tasks, options) {
  if (!tasks.length) return '';
  return `
    <section class="dash-records" aria-labelledby="${id}">
      <div class="dash-section-heading">
        <h2 id="${id}">${label}</h2>
        ${id === 'dash-active' ? `<a class="dash-link spring-control" href="#library/tasks">보관함${options.icon('chevron')}</a>` : ''}
      </div>
      <ul class="dash-record-list">${tasks.map(task => taskRow(task, options)).join('')}</ul>
    </section>
  `;
}

export function renderDashboard(state, { icon, esc, formatDay, avatar, today, todayLabel, workingIds = new Set(), agenda = [] }) {
  const options = { icon, esc, formatDay, avatar, workingIds };
  const active = state.tasks.filter(task => task.status !== 'ready');
  const spotlight = active.find(task => task.status === 'waiting') ?? active.find(task => workingIds.has(task.id)) ?? active[0];
  const otherActive = active.filter(task => task !== spotlight).slice(0, 2);
  const recent = state.tasks.filter(task => task.status === 'ready')
    .sort((first, second) => Date.parse(second.completedAt || second.createdAt) - Date.parse(first.completedAt || first.createdAt))
    .slice(0, 2);

  return `
    <div class="dashboard-page" aria-labelledby="dashboard-title">
      ${renderDate(today, todayLabel, esc)}
      ${renderSpotlight(spotlight, options)}
      ${renderAgenda(agenda, options)}
      ${renderGroup('dash-recent', '최근 받은 파일', recent, options)}
      ${renderGroup('dash-active', '진행 중인 일', otherActive, options)}
    </div>
  `;
}

function logContent(observation, esc) {
  if (observation.kind !== 'answer') return `<p>${esc(observation.text)}</p>`;
  const divider = '\n답변: ';
  const cut = observation.text.indexOf(divider);
  if (!observation.text.startsWith('질문: ') || cut < 0) return `<p>${esc(observation.text)}</p>`;
  const question = observation.text.slice('질문: '.length, cut);
  const answer = observation.text.slice(cut + divider.length);
  return `<p class="task-log-question">${esc(question)}</p><p>${esc(answer)}</p>`;
}

function renderLog(task, { icon, esc, formatDay }) {
  const entries = [
    { type: 'created', at: task.createdAt, label: '부탁을 맡겼어요', symbol: 'check' },
    ...task.observations.map(observation => ({
      type: observation.kind, at: observation.at, label: observation.kind === 'answer' ? '내 답변' : '남긴 메모',
      symbol: observation.kind === 'answer' ? 'chat' : 'note', observation,
    })),
    ...(task.completedAt ? [{ type: 'ready', at: task.completedAt, label: '결과 파일이 준비됐어요', symbol: 'file' }] : []),
  ].sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
  return `
    <section class="task-history" aria-labelledby="task-history-title">
      <h2 id="task-history-title">작업 기록</h2>
      <ol class="task-log">
        ${entries.map(entry => `
          <li class="task-log-entry" data-type="${entry.type}">
            <span class="task-log-icon">${icon(entry.symbol)}</span>
            <div class="task-log-copy">
              <div class="task-log-meta">
                <strong>${entry.label}</strong>
                <time datetime="${esc(entry.at)}">${esc(formatDay(entry.at))} · ${esc(clock.format(new Date(entry.at)))}</time>
              </div>
              ${entry.observation ? logContent(entry.observation, esc) : ''}
            </div>
          </li>
        `).join('')}
      </ol>
    </section>
  `;
}

function renderSteps(status, icon) {
  const step = status === 'ready' || status === 'working' ? 2 : 1;
  const labels = ['일 맡김', '기록 모으기', '파일 준비'];
  return `
    <ol class="task-steps" aria-label="작업 진행 단계">
      ${labels.map((label, index) => {
        const state = status === 'ready' || index < step ? 'done' : index === step ? 'current' : 'next';
        return `<li data-state="${state}"${state === 'current' ? ' aria-current="step"' : ''}>
          <span class="task-step-mark" aria-hidden="true">${state === 'done' ? icon('check') : ''}</span>
          <span>${label}</span>
        </li>`;
      }).join('')}
    </ol>
  `;
}

function taskActions(task, { icon, esc, working }) {
  const id = esc(task.id);
  if (working) return '<p class="thread-working" role="status"><span></span>남긴 기록을 한 파일로 모으고 있어요.</p>';
  if (task.status === 'ready') {
    return `
      <button type="button" class="task-action-primary spring-control" data-action="home-download" data-id="${id}">${icon('download')}<span>결과 파일 받기</span></button>
      <button type="button" class="task-action-secondary spring-control" data-action="open-thread" data-id="${id}">대화 보기</button>
    `;
  }
  if (task.status === 'waiting') {
    return `
      <button type="button" class="task-action-primary spring-control" data-action="open-thread" data-id="${id}">${icon('chat')}<span>모리에게 답하기</span></button>
      <button type="button" class="task-action-secondary spring-control" data-action="new-note" data-id="${id}">기록 남기기</button>
    `;
  }
  return `
    <button type="button" class="task-action-primary spring-control" data-action="new-note" data-id="${id}">${icon('plus')}<span>기록 남기기</span></button>
    <button type="button" class="task-action-secondary spring-control" data-action="open-thread" data-id="${id}">대화 보기</button>
    ${task.observations.length ? `<button type="button" class="task-action-secondary spring-control" data-action="home-finish" data-id="${id}">결과 만들기</button>` : ''}
  `;
}

export function renderTaskPage(task, { icon, esc, formatDay, avatar, working = false }) {
  const viewStatus = working ? 'working' : task.status;
  return `
    <article class="task-page" aria-labelledby="task-page-title">
      <header class="task-heading">
        ${task.due ? `<p class="task-due">${icon('calendar')}<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time></p>` : ''}
        <h1 id="task-page-title" tabindex="-1">${esc(task.title)}</h1>
        ${task.brief ? `<p class="task-brief">${esc(task.brief)}</p>` : ''}
      </header>
      <section class="task-current" aria-label="진행 상황" data-status="${esc(viewStatus)}">
        ${renderSteps(viewStatus, icon)}
        <div class="task-current-body">
          <div class="task-current-copy">
            <h2>${statusText[viewStatus]}</h2>
            ${task.status === 'waiting' && task.question ? `<p>${esc(task.question)}</p>` : ''}
            ${task.status === 'ready' && task.completedAt ? `<p><time datetime="${esc(task.completedAt)}">${esc(formatDay(task.completedAt))}</time>에 완료</p>` : ''}
          </div>
          <div class="task-current-avatar" aria-hidden="true">${avatar(viewStatus, { large: true })}</div>
        </div>
        <div class="task-actions">${taskActions(task, { icon, esc, working })}</div>
      </section>
      ${renderLog(task, { icon, esc, formatDay })}
    </article>
  `;
}
