const soundStatus = {
  waiting: '모리가 확인할 게 있어요',
  collecting: '모리가 기록을 모으고 있어요',
  ready: '기록이 정리됐어요',
};

const clock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: 'numeric',
  minute: '2-digit',
});

function taskRow(task, { icon, esc, formatDay }) {
  const { id, title, due, status, completedAt, observations } = task;
  const done = status === 'ready';
  const eventDate = done ? completedAt : due;
  const stateText = done ? '텍스트 파일' : status === 'waiting' ? '답변 기다리는 중' : `기록 ${observations.length}개`;
  return `
    <li class="dash-row">
      <button class="dash-row-main spring-control" type="button" data-action="${done ? 'open-file' : 'open-task'}" data-id="${esc(id)}">
        <span class="dash-row-icon" data-icon="${esc(done ? 'file' : task.icon)}">${icon(done ? 'file' : task.icon)}</span>
        <span class="dash-row-copy">
          <strong>${esc(title)}</strong>
          <span>${stateText}${eventDate ? ` <span aria-hidden="true">·</span> <time datetime="${esc(eventDate)}">${esc(formatDay(eventDate))}${done ? '' : '까지'}</time>` : ''}</span>
        </span>
        ${done ? '' : `<span class="dash-row-arrow">${icon('chevron')}</span>`}
      </button>
      ${done ? `
        <button class="dash-row-download spring-control" type="button" data-action="home-download"
          data-id="${esc(id)}" aria-label="${esc(title)} 파일 받기">${icon('download')}</button>
      ` : ''}
    </li>
  `;
}

function renderSpotlight(task, { icon, esc, avatar, workingIds }) {
  const waiting = task?.status === 'waiting';
  const working = Boolean(task && workingIds.has(task.id));
  const mood = working ? 'working' : task?.status ?? 'idle';
  const action = waiting ? 'open-thread' : task ? 'open-task' : 'new-task';
  const headline = waiting ? task.question : task?.title || '모리에게 부탁해 보세요';
  return `
    <section class="dash-spotlight" aria-labelledby="dash-spotlight-title" data-status="${mood}">
      <div class="dash-spotlight-art" aria-hidden="true">${avatar(mood, { large: true })}</div>
      <div class="dash-spotlight-copy">
        <p class="dash-spotlight-label">${waiting ? '모리의 질문' : working ? '기록을 정리하는 중' : task ? '기록을 모으는 중' : '새 부탁'}</p>
        <h2 id="dash-spotlight-title">${esc(headline || task?.title || '모리에게 부탁해 보세요')}</h2>
        ${waiting ? `<p class="dash-spotlight-task">${esc(task.title)}</p>` : ''}
        <button type="button" class="dash-spotlight-action spring-control" data-action="${action}"${task ? ` data-id="${esc(task.id)}"` : ''}>
          ${waiting ? '답하기' : task ? '진행 보기' : '일 맡기기'}${icon('arrow')}
        </button>
      </div>
    </section>
  `;
}

function renderGroup(id, label, tasks, options) {
  if (!tasks.length) return '';
  return `
    <section class="dash-group" aria-labelledby="${id}">
      <div class="dash-group-heading">
        <h2 id="${id}">${label}</h2>
        ${id === 'dash-active' ? `<a class="dash-all spring-control" href="#works">전체 보기${options.icon('chevron')}</a>` : ''}
      </div>
      <ul class="dash-rows">${tasks.map(task => taskRow(task, options)).join('')}</ul>
    </section>
  `;
}

function renderAgenda(items, view) {
  const { icon, esc } = view;
  return `<section class="dash-group dash-agenda" aria-labelledby="dash-agenda-title">
    <div class="dash-group-heading"><h2 id="dash-agenda-title">오늘 일정</h2>
      <a class="dash-all spring-control" href="#schedule">일정 보기${icon('chevron')}</a></div>
    ${items.length ? `<ul class="dash-rows">
      ${items.slice(0, 3).map(item => {
        const action = item.type === 'task' ? 'open-task' : item.type === 'tool' ? 'open-tool' : 'open-event';
        const detail = item.type === 'tool' ? item.detail : item.place;
        return `<li class="dash-row">
          <button class="dash-row-main dash-time-row spring-control" type="button" data-action="${action}" data-id="${esc(item.id)}"${item.type === 'tool' ? ` data-tool="${esc(item.tool)}"` : ''}>
            <span class="dash-agenda-time">${esc(item.time || (item.type === 'task' ? '마감' : '종일'))}</span>
            <span class="dash-row-copy"><strong>${esc(item.title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</span>
            <span class="dash-row-arrow">${icon('chevron')}</span>
          </button></li>`;
      }).join('')}</ul>`
      : `<div class="dash-no-events"><span>오늘 잡힌 일정이 없어요</span><button type="button" class="dash-all spring-control" data-action="new-event">${icon('plus')}일정 추가</button></div>`}
  </section>`;
}

export function renderDashboard(state, { icon, esc, formatDay, avatar, todayLabel, workingIds = new Set(), agenda = [] }) {
  const options = { icon, esc, formatDay, avatar, workingIds };
  const active = state.tasks.filter(task => task.status !== 'ready');
  const spotlight = active.find(task => task.status === 'waiting') ?? active[0];
  const otherActive = active.filter(task => task !== spotlight).slice(0, 4);
  const recent = state.tasks.filter(task => task.status === 'ready')
    .sort((first, second) => Date.parse(second.completedAt || second.createdAt) - Date.parse(first.completedAt || first.createdAt))
    .slice(0, 3);

  return `
    <div class="dashboard-page" aria-labelledby="dashboard-title">
      <header class="dash-heading">
        <p>${esc(todayLabel)}</p>
        <h1 id="dashboard-title" tabindex="-1">오늘</h1>
      </header>
      ${renderSpotlight(spotlight, options)}
      ${renderAgenda(agenda, options)}
      ${renderGroup('dash-active', '진행 중', otherActive, options)}
      ${renderGroup('dash-recent', '최근 결과', recent, options)}
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
  const sorted = [...task.observations].sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
  return `
    <section class="task-history" aria-labelledby="task-history-title">
      <h2 id="task-history-title">남긴 기록</h2>
      ${sorted.length ? `
        <ol class="task-log">
          ${sorted.map(observation => `
            <li class="task-log-entry">
              <span class="task-log-icon">${icon(observation.kind === 'answer' ? 'chat' : 'note')}</span>
              <div class="task-log-copy">
                <div class="task-log-meta">
                  <span>${observation.kind === 'answer' ? '내 답변' : '메모'}</span>
                  <time datetime="${esc(observation.at)}">${esc(formatDay(observation.at))} · ${esc(clock.format(new Date(observation.at)))}</time>
                </div>
                ${logContent(observation, esc)}
              </div>
            </li>
          `).join('')}
        </ol>
      ` : '<p class="task-empty">기록을 남기면 여기에 시간순으로 모여요.</p>'}
    </section>
  `;
}

function taskActions(task, { icon, esc, working }) {
  const id = esc(task.id);
  if (working) return '<p class="thread-working"><span></span>남긴 기록을 한 파일로 모으고 있어요.</p>';
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
        <h1 id="task-page-title" tabindex="-1">${esc(task.title)}</h1>
        ${task.due ? `<p class="task-due">${icon('calendar')}<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time></p>` : ''}
        ${task.brief ? `<p class="task-brief">${esc(task.brief)}</p>` : ''}
      </header>
      <section class="task-current" aria-label="진행 상황" data-status="${esc(task.status)}">
        <div class="task-current-avatar" aria-hidden="true">${avatar(viewStatus, { large: true })}</div>
        <div class="task-current-copy">
          <h2>${working ? '모리가 기록을 정리하는 중이에요' : soundStatus[task.status]}</h2>
          ${task.status === 'waiting' && task.question ? `<p>${esc(task.question)}</p>` : ''}
          ${task.status === 'ready' && task.completedAt ? `<p><time datetime="${esc(task.completedAt)}">${esc(formatDay(task.completedAt))}</time>에 완료</p>` : ''}
        </div>
      </section>
      <div class="task-actions">${taskActions(task, { icon, esc, working })}</div>
      ${renderLog(task, { icon, esc, formatDay })}
    </article>
  `;
}
