const portrait = '/assets/mori-poc2.webp';

export const avatarStatus = Object.freeze({
  idle: '맡길 일 기다리는 중',
  collecting: '기록을 받아두는 중',
  waiting: '답변을 기다려요',
  working: '기록을 정리하는 중',
  ready: '파일을 준비했어요',
});

export function renderAvatar(status, { large = false } = {}) {
  const mood = Object.hasOwn(avatarStatus, status) ? status : 'idle';
  return `<span class="mori-avatar${large ? ' mori-avatar-large' : ''}" data-mood="${mood}" aria-hidden="true">
    <span class="mori-figure"><img src="${portrait}" alt="" width="112" height="112" draggable="false"></span>
    <span class="mori-desk"><i></i><i></i></span>
    <span class="mori-question">?</span>
    <span class="mori-complete">✓</span>
  </span>`;
}

export function renderActivity(task, status, { icon, esc, formatDay }) {
  const when = value => `<time datetime="${esc(value)}">${esc(formatDay(value))}</time>`;
  const rows = task ? [
    ['check', '부탁을 맡았어요', when(task.createdAt)],
    ...(task.observations.length ? [['note', '기록 ' + task.observations.length + '개를 모았어요', when(task.observations.at(-1).at)]] : []),
    ...(task.status === 'waiting' ? [['chat', '확인할 내용이 있어요', esc(task.question)]] : []),
    ...(task.status === 'ready' && task.completedAt ? [['file', '결과 파일을 준비했어요', when(task.completedAt)]] : []),
  ] : [];
  return `<div class="sheet-content mori-activity">
    <div class="sheet-header"><span class="sheet-kicker">모리의 활동</span>
      <button class="sheet-close" type="button" data-action="close-sheet" aria-label="닫기">${icon('close')}</button></div>
    <div class="activity-heading">
      ${renderAvatar(status, { large: true })}
      <h2 id="sheet-title" tabindex="-1">${avatarStatus[status] ?? avatarStatus.idle}</h2>
      ${task ? `<p>${esc(task.title)}</p>` : ''}
    </div>
    ${rows.length ? `<ol class="activity-list">${rows.reverse().map(([symbol, title, meta]) =>
      `<li><span class="activity-icon">${icon(symbol)}</span><span><strong>${title}</strong><small>${meta}</small></span></li>`
    ).join('')}</ol><button type="button" class="sheet-primary activity-action" data-action="open-task" data-id="${esc(task.id)}">맡긴 일 보기${icon('chevron')}</button>` : ''}
  </div>`;
}
