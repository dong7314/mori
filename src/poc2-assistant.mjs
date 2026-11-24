const heroAsset = '/assets/mori-poc2.webp';

function renderControls(task, editing, draft, { icon, esc }) {
  const id = task ? `data-id="${esc(task.id)}"` : '';
  if (editing && task?.status === 'waiting') {
    return `
      <form class="reply-editor" data-form="home-answer" ${id}>
        <label class="sr-only" for="home-answer">모리에게 답하기</label>
        <textarea id="home-answer" name="answer" rows="1" maxlength="1000" placeholder="모리에게 답하기" required>${esc(draft)}</textarea>
        <button class="editor-submit spring-control" type="submit" aria-label="답변 보내기">${icon('arrow-up')}</button>
      </form>
      <button class="quiet-action spring-control" type="button" data-action="close-reply">취소</button>`;
  }

  if (task?.status === 'waiting') {
    return `<div class="conversation-actions">
      ${task.id === 'garage' ? `<button class="filled-action spring-control" type="button" data-action="home-quick-answer" ${id}>${icon('check')}<span>네, 맞아요</span></button>` : ''}
      <button type="button" class="${task.id === 'garage' ? 'secondary-action' : 'filled-action'} spring-control" data-action="open-reply" ${id}>
        ${icon('compose')}<span>직접 답하기</span>
      </button>
    </div>`;
  }

  if (task?.status === 'ready') {
    return `<button type="button" class="result-file spring-control" data-action="home-download" ${id}>
      <span class="result-icon">${icon('file')}</span>
      <span class="result-name"><strong>${esc(task.title)}</strong><small>텍스트 파일 · 기록 ${task.observations.length}개</small></span>
      <span class="result-download">${icon('download')}<span class="sr-only">저장</span></span>
    </button>`;
  }

  return `<div class="conversation-actions">
    ${task?.observations.length ? `<button class="filled-action spring-control" type="button" data-action="home-finish" ${id}>${icon('file')}<span>결과 만들기</span></button>` : ''}
    <button class="${task?.observations.length ? 'secondary-action' : 'filled-action'} spring-control" type="button" data-action="${task ? 'new-note' : 'new-task'}" ${id}>
      ${icon('plus')}<span>${task ? '기록 추가' : '새 부탁'}</span>
    </button>
  </div>`;
}

export function renderAssistant(task, { editing, draft, icon, esc, formatDay }) {
  const answered = task?.observations.some(item => item.kind === 'answer');
  const phase = editing ? 'reply' : task?.status === 'ready' ? 'ready' : task?.status === 'waiting' ? 'ask' : 'rest';
  const title = task?.status === 'waiting' ? task.question ?? '기록을 한 번 확인해 주실래요?'
    : task?.status === 'ready' ? '기록을 정리했어요.'
      : answered ? '답변을 기록에 더했어요.'
        : task ? '기록을 모으고 있어요.' : '어떤 일을 맡길까요?';
  const mascotLabel = task?.status === 'waiting' ? (editing ? '답변 입력으로 이동' : '모리에게 직접 답하기')
    : task ? '모리가 맡은 일 열기' : '모리에게 부탁하기';
  return `
    <section class="assistant-view" data-scene="${phase}" aria-labelledby="assistant-title">
      <div class="mori-stage">
        <div class="stage-light" aria-hidden="true"></div>
        <div class="stage-shadow" aria-hidden="true"></div>
        <button class="mascot-hit spring-control" type="button" data-action="mori-touch"
          ${task ? `data-id="${esc(task.id)}"` : ''} aria-label="${mascotLabel}">
          <span class="mascot-pose">
            <img src="${heroAsset}" alt="" width="660" height="660" fetchpriority="high" draggable="false">
          </span>
        </button>
      </div>
      <div class="conversation">
        ${task ? `
          <button class="job-label spring-control" type="button" data-action="open-task" data-id="${esc(task.id)}">
            <span class="job-symbol">${icon(task.icon)}</span>
            <span class="job-meta"><span class="job-name">${esc(task.title)}</span>
              <span class="job-detail">기록 ${task.observations.length}개${task.due ? ` <span aria-hidden="true">·</span> <time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time>` : ''}</span>
            </span>
            <span class="job-chevron">${icon('chevron')}</span>
          </button>` : ''}
        <h1 id="assistant-title" tabindex="-1">${esc(title)}</h1>
        <div class="reply-area">${renderControls(task, editing, draft, { icon, esc })}</div>
      </div>
      ${phase === 'ready' ? `<span class="delivery-copy" aria-hidden="true">${icon('file')}</span>` : ''}
    </section>`;
}
