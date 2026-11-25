import { renderAvatar } from './poc2-avatar.mjs';
import { documentFilename } from './poc2-model.mjs';

const answerMarker = '\n답변: ';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul',
});

function clock(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(date)
    : '';
}

function turn(key, speaker, content, { esc }, { label, at, request = false } = {}) {
  return `<li class="thread-turn${request ? ' thread-turn--request' : ''}" data-speaker="${speaker}" data-turn-key="${esc(key)}">
    <div class="thread-turn-meta"><span>${label || (speaker === 'me' ? '나' : '모리')}</span>
      ${at ? `<time datetime="${esc(at)}">${esc(clock(at))}</time>` : ''}</div>
    ${content}
  </li>`;
}

function bubble(text, esc) {
  return `<p class="thread-bubble">${esc(text)}</p>`;
}

function performer(status, view, content, key = 'performer') {
  return `<li class="thread-performer" data-mood="${status}" data-turn-key="${view.esc(key)}">
    <div class="thread-performer-art">${view.avatar(status, { large: true })}</div>
    <div class="thread-performer-copy">${content}</div>
  </li>`;
}

function fileRow(task, { icon, esc }) {
  const filename = documentFilename(task);
  return `<button type="button" class="thread-file spring-control" data-action="open-file" data-id="${esc(task.id)}">
    <span class="thread-file-icon">${icon('file')}</span>
    <span class="thread-file-copy"><strong>${esc(filename)}</strong><small>기록 ${task.observations.length}개를 정리한 문서</small></span>
    <span class="thread-file-download">${icon('arrow-up-right')}<span class="sr-only">파일 미리보기 열기</span></span>
  </button>`;
}

export function renderTurns(task, view) {
  const { esc, icon, formatDay } = view;
  const id = esc(task.id);
  const output = [];
  let previousDay;
  function dateRow(at) {
    const day = dayFormatter.format(new Date(at));
    const label = formatDay(at);
    if (previousDay === day) return;
    previousDay = day;
    output.push(`<li class="thread-date" data-turn-key="${esc('date-' + day)}"><time datetime="${esc(at)}">${esc(label)}</time></li>`);
  }
  dateRow(task.createdAt);
  output.push(turn('request', 'me', bubble(task.brief || task.title, esc), view,
    { label: '처음 맡긴 부탁', at: task.createdAt, request: true }));
  output.push(turn('ack', 'mori', bubble('알겠어요. 이 일에 필요한 기록을 모아둘게요.', esc), view));

  const observations = [...task.observations].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const observation of observations) {
    dateRow(observation.at);
    if (observation.kind !== 'answer') {
      output.push(turn(observation.id, 'me', bubble(observation.text, esc), view,
        { label: '남긴 기록', at: observation.at }));
      continue;
    }
    const split = observation.text.indexOf(answerMarker);
    if (split >= 0) {
      output.push(turn('question-' + observation.id, 'mori',
        bubble(observation.text.slice(0, split).replace(/^질문: /, ''), esc), view, { label: '모리가 확인한 내용' }));
      output.push(turn('answer-' + observation.id, 'me',
        bubble(observation.text.slice(split + answerMarker.length), esc), view, { label: '나의 답변', at: observation.at }));
    } else {
      output.push(turn('answer-' + observation.id, 'me', bubble(observation.text, esc), view,
        { label: '나의 답변', at: observation.at }));
    }
  }

  if (view.working) {
    output.push(performer('working', view, `<p class="thread-action-kicker">기록 ${task.observations.length}개</p>
      <h2 class="thread-performer-question">기록을 정리하고 있어요.</h2>`));
  } else if (task.status === 'waiting') {
    const confirm = task.id === 'garage'
      ? `<button type="button" class="thread-quick thread-quick-answer spring-control" data-action="home-quick-answer" data-id="${id}">${icon('check')}네, 두 번 다 맞아요</button>`
      : '';
    output.push(performer('waiting', view, `<p class="thread-action-kicker">모리의 질문</p>
      <h2 class="thread-performer-question">${esc(task.question || '기록을 한 번 확인해 주세요.')}</h2>
      ${confirm}`));
  } else if (task.status === 'ready') {
    output.push(performer('ready', view, `<p class="thread-action-kicker">기록 ${task.observations.length}개</p>
      <h2 class="thread-performer-question">파일이 준비됐어요</h2>
      ${fileRow(task, view)}`, 'file-' + task.completedAt));
  } else {
    const finish = task.observations.length
      ? `<button type="button" class="thread-quick thread-finish spring-control" data-action="home-finish" data-id="${id}">지금까지의 기록 정리${icon('arrow-up-right')}</button>`
      : '';
    output.push(performer('collecting', view, `<p class="thread-action-kicker">기록 ${task.observations.length}개</p>
      <h2 class="thread-performer-question">기록 남기기</h2>
      ${finish}`));
  }
  return output.join('');
}

export function renderAssistant(task, view) {
  if (!task) {
    return `<section class="thread-empty">
      <div class="thread-empty-art">${view.avatar('idle', { large: true })}</div>
      <h1>아직 맡긴 일이 없어요</h1>
      <button class="thread-quick spring-control" type="button" data-action="new-task">새 부탁 남기기${view.icon('arrow-up-right')}</button>
    </section>`;
  }
  return `<section class="thread" data-thread-id="${view.esc(task.id)}" aria-labelledby="thread-title">
    <div class="thread-context"></div>
    <div class="thread-transcript" role="log" aria-label="이 일에 모인 대화와 기록" aria-relevant="additions">
      <ol class="thread-log"></ol>
    </div>
    <div class="thread-composer-slot"></div>
  </section>`;
}

export function renderThreadContext(task, { icon, esc, formatDay }) {
  return `<header class="thread-topic">
    <div class="thread-topic-topline"><span class="thread-topic-label">모리에게 맡긴 일</span>
      <button class="thread-topic-more spring-control" type="button" data-action="open-task" data-id="${esc(task.id)}" aria-label="${esc(task.title)} 상세 보기">${icon('arrow-up-right')}</button></div>
    <h1 id="thread-title" tabindex="-1">${esc(task.title)}</h1>
    <p class="thread-topic-meta"><span class="thread-topic-icon">${icon(task.icon)}</span>
      ${task.due ? `<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time>` : '<span>필요한 기록을 모으고 있어요</span>'}
    </p>
  </header>`;
}

export function renderThreadComposer(task, { icon, esc, working }) {
  if (!task || working) return '';
  if (task.status === 'ready') {
    return `<button class="thread-add-record spring-control" type="button" data-action="new-note" data-id="${esc(task.id)}">${icon('plus')}이 일에 기록 더 남기기</button>`;
  }
  const answering = task.status === 'waiting';
  return `<form class="thread-composer" data-form="thread-message" data-id="${esc(task.id)}">
    <textarea id="thread-input" name="message" rows="1" maxlength="1000" placeholder="${answering ? '상황을 짧게 알려주세요' : '새로 기억난 내용을 적어주세요'}" required></textarea>
    <label class="sr-only" for="thread-input">${answering ? '모리에게 답변' : '이 일에 남길 기록'}</label>
    <button type="button" class="thread-voice spring-control" data-action="voice-input" aria-label="음성 입력" aria-pressed="false">${icon('mic')}</button>
    <button class="thread-send spring-control" type="submit" aria-label="${answering ? '답변 보내기' : '기록 보내기'}" disabled>${icon('arrow-up')}</button>
  </form>`;
}

export function renderResultSheet(task, { icon, esc, formatDay, avatar = renderAvatar }) {
  return `<div class="sheet-content result-preview">
      <div class="sheet-header"><span class="sheet-kicker">파일 미리보기</span>
        <button class="sheet-close" type="button" data-action="close-sheet" aria-label="닫기">${icon('close')}</button></div>
      <div class="sheet-result-heading">
        <div class="sheet-intro"><span class="sheet-result-type">모리가 정리한 기록</span>
          <h2 id="sheet-title" tabindex="-1">${esc(task.title)}</h2>
          <p class="sheet-meta">${task.completedAt ? `${esc(formatDay(task.completedAt))} 정리 · ` : ''}기록 ${task.observations.length}개</p>
        </div>
        <div class="sheet-result-mori">${avatar('ready', { large: true })}</div>
      </div>
      <section class="sheet-result-paper" aria-label="파일 내용">
        <div class="sheet-result-paper-label">${icon('file')}<span>전달할 내용</span><span>TXT</span></div>
        <ol class="result-observations">${task.observations.map(observation => `
          <li><time datetime="${esc(observation.at)}">${esc(formatDay(observation.at))}</time><p>${esc(observation.text)}</p></li>
        `).join('')}</ol>
      </section>
      <div class="sheet-actions sheet-result-actions"><button class="sheet-primary" type="button" data-action="home-download" data-id="${esc(task.id)}">${icon('download')}파일 저장</button></div>
    </div>`;
}
