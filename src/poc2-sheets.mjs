const phases = ['관찰 모으기', '내용 확인', '결과 준비'];

const statusLabels = {
  collecting: '기록 모으는 중',
  waiting: '답변이 필요해요',
  ready: '준비 완료',
};

function sheetHeader(label, { icon, esc }) {
  return `
    <div class="sheet-header">
      <span class="sheet-kicker">${esc(label)}</span>
      <button type="button" class="sheet-close" data-action="close-sheet" aria-label="닫기">${icon('close')}</button>
    </div>
  `;
}

function stepTrack(task, icon) {
  const { status, observations } = task;
  const activeIndex = status === 'collecting' && !observations.some(item => item.kind === 'answer')
    ? 0 : status === 'waiting' ? 1 : 2;
  return `
    <ol class="stage-track" aria-label="일의 진행 단계">
      ${phases.map((label, index) => {
        const state = index < activeIndex ? 'done' : index === activeIndex ? 'current' : 'next';
        const mark = index < activeIndex || status === 'ready' ? icon('check') : '<span></span>';
        return `
          <li class="stage-step" data-state="${state}"${state === 'current' ? ' aria-current="step"' : ''}>
            <span class="stage-mark" aria-hidden="true">${mark}</span>
            <span class="stage-label">${label}</span>
          </li>
        `;
      }).join('')}
    </ol>
  `;
}

function observationsList(task, { icon, esc, formatDay }) {
  if (!task.observations.length) {
    return '<p class="sheet-empty">아직 연결한 기록이 없어요.</p>';
  }

  return `
    <ul class="sheet-observation-list">
      ${task.observations.map(item => `
        <li class="sheet-observation-item">
          <span class="sheet-observation-mark" aria-hidden="true">${icon(item.kind === 'answer' ? 'check' : 'note')}</span>
          <div>
            <p>${esc(item.text)}</p>
            <time datetime="${esc(item.at)}">${esc(formatDay(item.at))}${item.kind === 'answer' ? ' · 확인 답변' : ''}</time>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}

function observationForm(icon) {
  return `
    <form class="sheet-form sheet-observation-form" data-form="observation">
      <label class="field-label" for="sheet-observation">이어 남길 기록</label>
      <textarea class="field-input" id="sheet-observation" name="observation" rows="2" placeholder="기억나는 내용을 짧게 남겨보세요." required maxlength="1000"></textarea>
      <div class="sheet-actions">
        <button type="submit" class="sheet-secondary">${icon('plus')}<span>기록 추가</span></button>
      </div>
    </form>
  `;
}

function questionBlock(task, { icon, esc }) {
  const shortcut = task.id === 'garage'
    ? `<button type="button" class="sheet-secondary sheet-quick-answer" data-action="quick-answer" data-answer="네, 두 번 다 방지턱을 넘을 때였어요.">${icon('check')}<span>네, 두 번 다 방지턱을 넘을 때였어요.</span></button>`
    : '';

  return `
    <section class="sheet-question" aria-labelledby="sheet-question-label">
      <p class="sheet-question-label" id="sheet-question-label">${icon('spark')}<span>모리의 질문</span></p>
      <h3>${esc(task.question || '이 기록에 추가로 확인할 내용이 있나요?')}</h3>
      ${shortcut}
      <form class="sheet-form sheet-answer-form" data-form="answer">
        <label class="field-label" for="sheet-answer">직접 답하기</label>
        <div class="sheet-inline-field">
          <input class="field-input" type="text" id="sheet-answer" name="answer" placeholder="짧게 답해도 괜찮아요." required maxlength="1000">
          <button class="sheet-primary sheet-answer-submit" type="submit" aria-label="답변 보내기">${icon('arrow')}</button>
        </div>
      </form>
    </section>
  `;
}

function documentBlock(task, { icon, esc, formatDay }) {
  return `
    <section class="sheet-document" aria-labelledby="sheet-document-title">
      <div class="sheet-document-header">
        <span class="sheet-document-icon" aria-hidden="true">${icon('file')}</span>
        <div>
          <h3 id="sheet-document-title">${esc(task.title)}</h3>
          <p>텍스트 문서 · 기록 ${task.observations.length}개</p>
        </div>
      </div>
      <div class="sheet-document-preview">
        ${observationsList(task, { icon, esc, formatDay })}
      </div>
      <button class="sheet-primary sheet-download" type="button" data-action="download-task">${icon('download')}<span>파일 저장</span></button>
    </section>
  `;
}

function collectingBlock(task, options) {
  const { icon } = options;
  return `
    <section class="sheet-observations" aria-labelledby="sheet-observations-title">
      <h3 id="sheet-observations-title">모아 둔 기록 <span class="sheet-count">${task.observations.length}</span></h3>
      ${observationsList(task, options)}
      ${observationForm(icon)}
    </section>
    ${task.observations.length ? `
      <div class="sheet-actions sheet-finish-actions">
        <button type="button" class="sheet-primary" data-action="finish-task">${icon('file')}<span>결과 만들기</span></button>
      </div>
    ` : ''}
  `;
}

function waitingBlock(task, options) {
  const { icon } = options;
  return `
    ${questionBlock(task, options)}
    <section class="sheet-observations" aria-labelledby="sheet-observations-title">
      <h3 id="sheet-observations-title">모아 둔 기록 <span class="sheet-count">${task.observations.length}</span></h3>
      ${observationsList(task, options)}
      <details class="sheet-details">
        <summary class="sheet-summary">${icon('plus')}<span>기록 더 남기기</span>${icon('chevron')}</summary>
        ${observationForm(icon)}
      </details>
    </section>
  `;
}

export function renderTaskSheet(task, { icon, esc, formatDay }) {
  const options = { icon, esc, formatDay };
  const content = {
    collecting: collectingBlock,
    waiting: waitingBlock,
    ready: documentBlock,
  }[task.status];

  return `
    <div class="sheet-content sheet-task-content">
      ${sheetHeader('맡은 일', options)}
      <div class="sheet-intro">
        <div class="sheet-task-line">
          <span class="sheet-task-icon" aria-hidden="true">${icon(task.icon)}</span>
          <span class="sheet-status" data-status="${esc(task.status)}">${statusLabels[task.status]}</span>
        </div>
        <h2 id="sheet-title" tabindex="-1">${esc(task.title)}</h2>
        ${task.brief ? `<p class="sheet-brief">${esc(task.brief)}</p>` : ''}
        ${task.due ? `
          <p class="sheet-meta">${icon('calendar')}<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time></p>
        ` : ''}
      </div>
      ${stepTrack(task, icon)}
      ${content(task, options)}
    </div>
  `;
}

function createTaskForm(icon) {
  return `
    <form class="sheet-form sheet-compose-form" data-form="task">
      <div class="field-group">
        <label class="field-label" for="task-title">맡길 일</label>
        <input class="field-input" type="text" name="title" id="task-title" placeholder="정비소에 보여줄 기록" required maxlength="80">
      </div>
      <div class="field-group">
        <label class="field-label" for="task-brief">원하는 결과 <span class="field-optional">선택</span></label>
        <textarea class="field-input" name="brief" id="task-brief" rows="3" placeholder="토요일에 보여줄 수 있게 소리가 났던 상황을 한 장에 모아줘." maxlength="1000"></textarea>
      </div>
      <div class="field-group">
        <label class="field-label" for="task-due">필요한 날 <span class="field-optional">선택</span></label>
        <input class="field-input" type="date" name="due" id="task-due">
      </div>
      <div class="sheet-actions">
        <button type="submit" class="sheet-primary">${icon('spark')}<span>모리에게 맡기기</span></button>
      </div>
    </form>
  `;
}

function createNoteForm(state, { icon, esc, selectedTaskId }) {
  const activeTasks = state.tasks.filter(task => task.status !== 'ready' || task.id === selectedTaskId);

  return `
    <form class="sheet-form sheet-compose-form" data-form="note">
      <div class="field-group">
        <label class="field-label" for="note-text">남길 내용</label>
        <textarea class="field-input" name="text" id="note-text" rows="4" placeholder="비 올 때 뒷자리에서 덜컹거렸어." required maxlength="1000"></textarea>
      </div>
      ${activeTasks.length ? `
        <div class="field-group">
          <label class="field-label" for="note-task">연결할 일 <span class="field-optional">선택</span></label>
          <select class="field-input" id="note-task" name="taskId">
            <option value="">기록에만 남기기</option>
            ${activeTasks.map(task => `
              <option value="${esc(task.id)}"${task.id === selectedTaskId ? ' selected' : ''}>${esc(task.title)}</option>
            `).join('')}
          </select>
        </div>
      ` : ''}
      <div class="sheet-actions">
        <button class="sheet-primary" type="submit">${icon('check')}<span>기록 저장</span></button>
      </div>
    </form>
  `;
}

export function renderComposer(state, { icon, esc, composerMode = 'task', selectedTaskId }) {
  const recording = composerMode === 'note';

  return `
    <div class="sheet-content sheet-composer-content">
      ${sheetHeader('모리에게', { icon, esc })}
      <div class="sheet-intro">
        <h2 id="sheet-title" tabindex="-1">${recording ? '기록 남기기' : '모리에게 부탁하기'}</h2>
      </div>
      <div class="sheet-switch" role="group" aria-label="작성할 내용">
        <button type="button" data-action="composer-mode" data-mode="task" aria-pressed="${!recording}">${icon('spark')}<span>일 맡기기</span></button>
        <button type="button" data-action="composer-mode" data-mode="note" aria-pressed="${recording}">${icon('note')}<span>기록 남기기</span></button>
      </div>
      ${recording ? createNoteForm(state, { icon, esc, selectedTaskId }) : createTaskForm(icon)}
    </div>
  `;
}
