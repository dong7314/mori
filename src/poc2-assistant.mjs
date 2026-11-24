const mascot = '/assets/mori-poc2.webp';
const answerMarker = '\n답변: ';

function turn(key, speaker, content, esc) {
  return `<li class="thread-turn" data-speaker="${speaker}" data-turn-key="${esc(key)}">
    <span class="sr-only">${speaker === 'me' ? '나' : '모리'}</span>${content}
  </li>`;
}

function bubble(text, esc) {
  return `<p class="thread-bubble">${esc(text)}</p>`;
}

function fileRow(task, { icon, esc }) {
  return `<button type="button" class="thread-file spring-control" data-action="open-file" data-id="${esc(task.id)}">
    <span class="thread-file-icon">${icon('file')}</span>
    <span><strong>${esc(task.title)}.txt</strong><small>기록 ${task.observations.length}개</small></span>
    <span class="thread-file-download">${icon('chevron')}<span class="sr-only">열기</span></span>
  </button>`;
}

export function renderTurns(task, view) {
  const { esc, icon, formatDay } = view;
  const id = esc(task.id);
  const output = [
    `<li class="thread-date" data-turn-key="date"><time datetime="${esc(task.createdAt)}">${esc(formatDay(task.createdAt))}</time></li>`,
    turn('request', 'me', bubble(task.brief || task.title, esc), esc),
    turn('ack', 'mori', bubble('좋아요. 이 대화에 기록을 모아둘게요.', esc), esc)
  ];

  let questionNumber = 0;
  for (const observation of task.observations) {
    const prefix = esc(observation.id);
    if (observation.kind !== 'answer') {
      output.push(`<li class="thread-turn thread-observation" data-speaker="me" data-turn-key="${prefix}">
        <span class="sr-only">내가 남긴 기록</span>
        <time datetime="${esc(observation.at)}">${esc(formatDay(observation.at))}</time>
        ${bubble(observation.text, esc)}
      </li>`);
      continue;
    }
    const split = observation.text.indexOf(answerMarker);
    if (split >= 0) {
      output.push(turn('question-' + questionNumber, 'mori', bubble(observation.text.slice(0, split).replace(/^질문: /, ''), esc), esc));
      output.push(turn('answer-' + observation.id, 'me', bubble(observation.text.slice(split + answerMarker.length), esc), esc));
    } else {
      output.push(turn('answer-' + observation.id, 'me', bubble(observation.text, esc), esc));
    }
    questionNumber += 1;
  }

  if (view.working) {
    output.push(turn('working', 'mori', '<p class="thread-working"><span></span>기록을 한 파일로 정리하고 있어요.</p>', esc));
  } else if (task.status === 'waiting') {
    output.push(turn('question-' + questionNumber, 'mori', bubble(task.question || '기록을 한 번 확인해 주세요.', esc), esc));
    if (task.id === 'garage') {
      output.push(`<li class="thread-option" data-turn-key="quick"><button type="button" class="thread-quick spring-control" data-action="home-quick-answer" data-id="${id}">네, 맞아요${icon('arrow-up')}</button></li>`);
    }
  } else if (task.status === 'ready') {
    output.push(turn('file-' + task.completedAt, 'mori', bubble('남겨 주신 내용으로 파일을 만들었어요.', esc) + fileRow(task, view), esc));
  } else if (task.observations.length) {
    output.push(`<li class="thread-option" data-turn-key="make-file"><button type="button" class="thread-quick spring-control" data-action="home-finish" data-id="${id}">${icon('file')}기록 정리${icon('chevron')}</button></li>`);
  }
  return output.join('');
}

export function renderAssistant(task, view) {
  if (!task) {
    return `<section class="thread-empty">
      <img src="${mascot}" alt="" width="112" height="112">
      <h1>모리에게 할 일을 맡겨보세요</h1>
      <button class="thread-quick spring-control" type="button" data-action="new-task">${view.icon('plus')}새 부탁</button>
    </section>`;
  }
  return `<section class="thread" data-thread-id="${view.esc(task.id)}" aria-labelledby="thread-title">
    <h1 id="thread-title" class="sr-only" tabindex="-1">${view.esc(task.title)} 대화</h1>
    <div class="thread-context"></div>
    <div role="log" aria-label="모리와 나눈 대화" aria-relevant="additions">
      <ol class="thread-log"></ol>
    </div>
  </section>`;
}

export function renderThreadContext(task, { icon, esc, formatDay }) {
  return `<button class="thread-topic spring-control" type="button" data-action="open-task" data-id="${esc(task.id)}">
    <span class="thread-topic-icon">${icon(task.icon)}</span>
    <span class="thread-topic-copy"><strong>${esc(task.title)}</strong>
      ${task.due ? `<time datetime="${esc(task.due)}">${esc(formatDay(task.due))}까지</time>` : ''}
    </span>
    <span class="thread-topic-more">${icon('chevron')}<span class="sr-only">상세</span></span>
  </button>`;
}

export function renderThreadComposer(task, { icon, esc, working }) {
  if (!task || working) return '';
  if (task.status === 'ready') {
    return `<button class="thread-add-record spring-control" type="button" data-action="new-note" data-id="${esc(task.id)}">${icon('plus')}이 일에 기록 추가</button>`;
  }
  return `<form class="thread-composer" data-form="thread-message" data-id="${esc(task.id)}">
    <label class="sr-only" for="thread-input">모리에게 메시지 보내기</label>
    <textarea id="thread-input" name="message" rows="1" maxlength="1000" placeholder="${task.status === 'waiting' ? '모리에게 답하기' : '남겨둘 기록 쓰기'}" required></textarea>
    <button class="thread-send spring-control" type="submit" aria-label="보내기" disabled>${icon('arrow-up')}</button>
  </form>`;
}

export function renderResultSheet(task, { icon, esc, formatDay }) {
  return `<div class="sheet-content result-preview">
      <div class="sheet-header"><span class="sheet-kicker">받은 파일</span>
        <button class="sheet-close" type="button" data-action="close-sheet" aria-label="닫기">${icon('close')}</button></div>
      <div class="sheet-intro">
        <span class="sheet-task-icon">${icon('file')}</span>
        <h2 id="sheet-title" tabindex="-1">${esc(task.title)}</h2>
        <p class="sheet-meta">텍스트 파일 · 기록 ${task.observations.length}개</p>
      </div>
      <ol class="result-observations">${task.observations.map(observation => `
        <li><time datetime="${esc(observation.at)}">${esc(formatDay(observation.at))}</time><p>${esc(observation.text)}</p></li>
      `).join('')}</ol>
      <div class="sheet-actions"><button class="sheet-primary" type="button" data-action="home-download" data-id="${esc(task.id)}">${icon('download')}TXT 파일 저장</button></div>
    </div>`;
}
