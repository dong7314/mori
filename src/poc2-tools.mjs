const STORAGE_KEY = 'mori.poc2.tools.v1';
const REPEATS = { daily: '매일', weekdays: '평일', weekends: '주말' };
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 100;
// These values and headlines are the original Mori prototype's fixed examples.
const MARKETS = {
  '삼성전자': { value: '72,400', unit: '원', market: 'KRX' },
  '코스피': { value: '2,650.24', unit: 'pt', market: 'KRX' },
  '애플': { value: '228.40', unit: 'USD', market: 'NASDAQ' },
};
const NEWS = [
  ['개인 비서 AI의 일정 관리 기능', '날짜와 시간을 확인하고, 등록한 일정을 다시 살펴보는 흐름을 담은 예시예요.'],
  ['음성 인식, 어디까지 왔을까', '음성으로 입력한 내용을 전송 전에 확인하고 수정하는 흐름을 담았어요.'],
  ['업무 도구에 추가되는 자동화 기능', '반복할 시간과 요일을 정하고, 필요할 때 잠시 멈추는 기능의 예시예요.'],
];

const clean = (value, length = 200) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const newId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const dateLabel = value => new Intl.DateTimeFormat('ko-KR', {
  month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
}).format(new Date(value));

function localDay(value = Date.now()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localInput(value) {
  const date = new Date(value);
  return `${localDay(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function initialTools() {
  return {
    version: 1, parking: null, reminders: [], routines: [],
    news: { topic: 'AI와 테크', time: '09:00', enabled: false },
    market: { symbol: '삼성전자', time: '09:30', enabled: false },
  };
}

function normalize(value) {
  const base = initialTools();
  if (!value || value.version !== 1) return base;
  const parking = value.parking;
  if (parking && (clean(parking.place) || clean(parking.floor) || clean(parking.spot)) && validDate(parking.savedAt)) {
    base.parking = { place: clean(parking.place, 80), floor: clean(parking.floor, 30), spot: clean(parking.spot, 30), note: clean(parking.note, 300), savedAt: parking.savedAt };
  }
  const reminderIds = new Set();
  base.reminders = (Array.isArray(value.reminders) ? value.reminders : []).filter(item => {
    if (!item || !clean(item.id, 100) || reminderIds.has(item.id) || !clean(item.title, 80) || !validDate(item.targetAt)) return false;
    reminderIds.add(item.id);
    return true;
  }).slice(0, MAX_ITEMS).map(item => ({
    id: clean(item.id, 100), title: clean(item.title, 80), targetAt: item.targetAt,
    createdAt: validDate(item.createdAt) ? item.createdAt : item.targetAt,
    completedAt: validDate(item.completedAt) ? item.completedAt : null,
  }));
  const routineIds = new Set();
  base.routines = (Array.isArray(value.routines) ? value.routines : []).filter(item => {
    if (!item || !clean(item.id, 100) || routineIds.has(item.id) || !clean(item.title, 80) || !clean(item.rule, 500)
      || !TIME.test(item.time) || !Object.hasOwn(REPEATS, item.repeat) || !DAY.test(item.endsAt) || !validDate(item.createdAt)) return false;
    routineIds.add(item.id);
    return true;
  }).slice(0, MAX_ITEMS).map(item => ({
    id: clean(item.id, 100), title: clean(item.title, 80), rule: clean(item.rule, 500), time: item.time,
    repeat: item.repeat, horizon: Math.min(365, Math.max(1, Number(item.horizon) || 14)),
    createdAt: item.createdAt, endsAt: item.endsAt, enabled: item.enabled === true,
    lastCompletedAt: validDate(item.lastCompletedAt) ? item.lastCompletedAt : null,
  }));
  if (value.news && typeof value.news === 'object') {
    base.news = { topic: clean(value.news.topic, 60) || base.news.topic, time: TIME.test(value.news.time) ? value.news.time : base.news.time, enabled: value.news.enabled === true };
  }
  if (value.market && typeof value.market === 'object') {
    base.market = { symbol: Object.hasOwn(MARKETS, value.market.symbol) ? value.market.symbol : base.market.symbol, time: TIME.test(value.market.time) ? value.market.time : base.market.time, enabled: value.market.enabled === true };
  }
  return base;
}

export function loadTools(storage) {
  try { return normalize(JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')); }
  catch { return initialTools(); }
}

export function saveTools(storage, tools) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(normalize(tools)));
    return true;
  } catch { return false; }
}

export function toolCountdown(targetAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((Date.parse(targetAt) - now) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (!seconds) return '시간이 됐어요';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  if (days) return `${days}일 ${hours}시간 남음`;
  if (hours) return `${hours}시간 ${minutes}분 남음`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

// Call from the app's clock tick: text updates preserve sheet fields and focus.
export function updateToolCountdowns(root, now = Date.now()) {
  for (const node of root.querySelectorAll('[data-tool-countdown]')) {
    const label = toolCountdown(node.dataset.target, now);
    if (node.textContent !== label) node.textContent = label;
    node.dataset.expired = String(Date.parse(node.dataset.target) <= now);
  }
}

export function nextRoutineAt(routine, now = Date.now()) {
  if (!routine?.enabled || !TIME.test(routine.time) || !DAY.test(routine.endsAt)) return null;
  const start = Math.max(now, Date.parse(routine.createdAt));
  const day = new Date(start);
  const [hour, minute] = routine.time.split(':').map(Number);
  for (let i = 0; i <= 365; i += 1) {
    if (localDay(day) > routine.endsAt) break;
    day.setHours(hour, minute, 0, 0);
    const weekday = day.getDay();
    const matches = routine.repeat === 'daily' || (routine.repeat === 'weekdays' ? weekday > 0 && weekday < 6 : weekday === 0 || weekday === 6);
    if (matches && day.getTime() > now && (!routine.lastCompletedAt || localDay(routine.lastCompletedAt) !== localDay(day))) return day.toISOString();
    day.setDate(day.getDate() + 1);
  }
  return null;
}

function countdown(reminder, esc, now, className = '') {
  return `<span class="tool-countdown ${className}" data-tool-countdown="${esc(reminder.id)}" data-target="${esc(reminder.targetAt)}" data-expired="${Date.parse(reminder.targetAt) <= now}">${esc(toolCountdown(reminder.targetAt, now))}</span>`;
}

function button(command, id, label, esc, className = 'tool-small-action', extra = '') {
  return `<button type="button" class="${className}" data-action="tool-action" data-command="${command}" data-id="${esc(id || '')}" ${extra}>${label}</button>`;
}

function featureRow(key, title, detail, symbol, { icon, esc }, trailing = '') {
  return `<li><button type="button" class="tool-feature-row spring-control" data-action="open-tool" data-tool="${esc(key)}">
    <span class="tool-feature-icon tool-feature-icon--${key}" aria-hidden="true">${icon(symbol)}</span>
    <span class="tool-feature-copy"><strong>${esc(title)}</strong><span>${esc(detail)}</span></span>
    ${trailing}<span class="tool-chevron" aria-hidden="true">${icon('chevron')}</span>
  </button></li>`;
}

export function renderTools(tools, opts) {
  const { icon, esc, now = Date.now(), notesHref = '#notes', scheduleHref = '#schedule' } = opts;
  const active = tools.reminders.filter(item => !item.completedAt).sort((a, b) => Date.parse(a.targetAt) - Date.parse(b.targetAt));
  const enabled = tools.routines.filter(item => nextRoutineAt(item, now));
  const parking = tools.parking;
  const parkingLabel = parking ? [parking.place, parking.floor, parking.spot].filter(Boolean).join(' · ') : '어디에 주차했는지 남겨두세요';
  return `<div class="tools-page">
    <header class="page-heading tools-heading"><h1>기능</h1><p>작은 일도 가볍게 챙겨요.</p></header>
    ${active.length ? `<section class="tools-active" aria-labelledby="tools-active-title"><div class="tool-section-heading"><h2 id="tools-active-title">지금 챙길 일</h2><span>${active.length}</span></div>
      <ul class="tool-active-list">${active.slice(0, 3).map(item => `<li><button type="button" class="tool-active-row" data-action="open-tool" data-tool="reminder:${esc(item.id)}">
        <span class="tool-active-mark" aria-hidden="true">${icon('clock')}</span><span class="tool-feature-copy"><strong>${esc(item.title)}</strong><time datetime="${esc(item.targetAt)}">${esc(dateLabel(item.targetAt))}</time></span>
        ${countdown(item, esc, now)}<span class="tool-chevron" aria-hidden="true">${icon('chevron')}</span></button></li>`).join('')}</ul>
    </section>` : ''}
    <section class="tool-section" aria-labelledby="tools-everyday-title"><h2 id="tools-everyday-title">생활 도구</h2><ul class="tool-feature-list">
      ${featureRow('parking', '주차 위치', parkingLabel, 'car', opts)}
      ${featureRow('reminders', '알림', active.length ? `${active.length}개 진행 중 · 남은 시간 확인` : '시간을 정하고 남은 시간 확인', 'clock', opts)}
      ${featureRow('routines', '반복 루틴', enabled.length ? `${enabled.length}개 켜짐 · 정해 둔 시간에 확인` : '챙길 일과 반복할 시간 정하기', 'reset', opts)}
    </ul></section>
    <section class="tool-section" aria-labelledby="tools-saved-title"><h2 id="tools-saved-title">내가 남긴 것</h2><div class="tool-destination-group">
      <a class="tool-destination" href="${esc(notesHref)}"><span aria-hidden="true">${icon('note')}</span><strong>기록</strong><span class="tool-chevron" aria-hidden="true">${icon('chevron')}</span></a>
      <a class="tool-destination" href="${esc(scheduleHref)}"><span aria-hidden="true">${icon('calendar')}</span><strong>일정</strong><span class="tool-chevron" aria-hidden="true">${icon('chevron')}</span></a>
    </div></section>
    <section class="tool-section" aria-labelledby="tools-brief-title"><div class="tool-section-heading"><h2 id="tools-brief-title">브리핑</h2><span class="tool-sample-label">예시 데이터</span></div><ul class="tool-feature-list">
      ${featureRow('news', '뉴스', `${tools.news.topic} · 예시 브리핑`, 'file', opts)}
      ${featureRow('market', '관심 시세', `${tools.market.symbol} · 고정된 예시 가격`, 'layers', opts)}
    </ul><p class="tool-footnote">뉴스와 시세는 화면 체험용 예시예요.</p></section>
  </div>`;
}

function sheet(title, content, { icon, esc }, subtitle = '') {
  return `<div class="sheet-content tool-sheet"><div class="sheet-header"><span class="sheet-kicker">생활 도구</span>
    <button class="sheet-close" type="button" data-action="close-sheet" aria-label="닫기">${icon('close')}</button></div>
    <div class="sheet-intro"><h2 id="sheet-title" tabindex="-1">${esc(title)}</h2>${subtitle ? `<p class="sheet-brief">${esc(subtitle)}</p>` : ''}</div>${content}</div>`;
}

function field(label, name, value, esc, { type = 'text', required = false, placeholder = '', maxlength = 80, attrs = '' } = {}) {
  return `<div class="tool-field"><label for="tool-${name}">${esc(label)}</label><input id="tool-${name}" name="${name}" type="${type}" value="${esc(value ?? '')}" ${required ? 'required' : ''} ${type === 'text' ? `maxlength="${maxlength}"` : ''} ${placeholder ? `placeholder="${esc(placeholder)}"` : ''} ${attrs}></div>`;
}

function select(label, name, options, selected, esc) {
  return `<div class="tool-field"><label for="tool-${name}">${esc(label)}</label><select id="tool-${name}" name="${name}">${options.map(([value, text]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></div>`;
}

function form(key, fields, label, esc, tail = '') {
  return `<form class="tool-form" data-form="mori-tool" data-tool="${esc(key)}">${fields}<p class="tool-form-error" data-tool-error role="alert" hidden></p><div class="tool-form-actions"><button class="sheet-primary tool-submit" type="submit">${esc(label)}</button>${tail}</div></form>`;
}

function parkingSheet(tools, opts) {
  const { icon, esc } = opts;
  const value = tools.parking;
  const summary = value ? `<div class="tool-parking-saved"><span class="tool-parking-symbol" aria-hidden="true">${icon('car')}</span><div><p>${esc(value.place || '저장한 주차 위치')}</p><strong>${esc([value.floor, value.spot].filter(Boolean).join(' · ') || value.place)}</strong><time datetime="${esc(value.savedAt)}">${esc(dateLabel(value.savedAt))} 저장</time></div></div>` : '';
  const fields = field('주차장 · 장소', 'place', value?.place, esc, { placeholder: '예: 서울숲 주차장' })
    + `<div class="tool-field-pair">${field('층', 'floor', value?.floor, esc, { placeholder: '지하 3층', maxlength: 30 })}${field('자리 번호', 'spot', value?.spot, esc, { placeholder: 'B16', maxlength: 30 })}</div>`
    + field('찾아갈 때 참고할 메모', 'note', value?.note, esc, { placeholder: '예: 엘리베이터 오른쪽', maxlength: 300 });
  return sheet('주차 위치', summary + form('parking', fields, value ? '위치 다시 저장' : '위치 저장', esc, value ? button('parking-clear', '', '기록 지우기', esc, 'tool-text-action') : ''), opts, '장소나 층·자리 번호를 직접 남겨두세요.');
}

function reminderSheet(key, tools, opts) {
  const { icon, esc, now = Date.now() } = opts;
  const id = key.split(':')[1];
  const reminder = tools.reminders.find(item => item.id === id);
  if (id && !reminder) return sheet('알림을 찾을 수 없어요', '<p class="tool-notice">목록에서 다른 알림을 열어주세요.</p>', opts);
  if (reminder) {
    const detail = `<div class="tool-timer"><span>${reminder.completedAt ? '완료한 알림' : '남은 시간'}</span>${reminder.completedAt ? `<strong>${icon('check')} 완료</strong>` : countdown(reminder, esc, now, 'tool-timer-value')}<time datetime="${esc(reminder.targetAt)}">${esc(dateLabel(reminder.targetAt))}</time></div>
      <div class="tool-timer-actions">${!reminder.completedAt ? button('reminder-complete', id, `${icon('check')}<span>완료</span>`, esc, 'sheet-primary') + button('reminder-extend', id, '10분 더', esc, 'sheet-secondary') : ''}</div>
      <p class="tool-notice">앱을 열어둔 동안 남은 시간을 볼 수 있어요. 푸시 알림이나 소리는 울리지 않아요.</p>
      ${!reminder.completedAt ? `<details class="tool-edit-details"><summary>제목 · 시간 바꾸기 ${icon('chevron')}</summary>${form(key, field('할 일', 'title', reminder.title, esc, { required: true }) + field('알림 시각', 'targetAt', localInput(reminder.targetAt), esc, { type: 'datetime-local', required: true, attrs: `min="${localInput(now)}"` }), '알림 변경', esc)}</details>` : ''}
      ${button('reminder-delete', id, '알림 지우기', esc, 'tool-text-action tool-delete')}`;
    return sheet(reminder.title, detail, opts);
  }
  const active = tools.reminders.filter(item => !item.completedAt).sort((a, b) => Date.parse(a.targetAt) - Date.parse(b.targetAt));
  const completed = tools.reminders.filter(item => item.completedAt).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  const list = (items, done) => `<ul class="tool-sheet-list">${items.map(item => `<li><button class="tool-simple-row" type="button" data-action="open-tool" data-tool="reminder:${esc(item.id)}"><span class="tool-feature-copy"><strong>${esc(item.title)}</strong><span>${esc(dateLabel(item.targetAt))}</span></span>${done ? `<span class="tool-check">${icon('check')}</span>` : countdown(item, esc, now)}${icon('chevron')}</button></li>`).join('')}</ul>`;
  return sheet('알림', `<p class="tool-notice">이 화면에서 남은 시간을 확인해요. 푸시 알림이나 소리는 울리지 않아요.</p>
    ${active.length ? list(active, false) : ''}
    <h3 class="tool-form-title">새 알림</h3>${form('reminders', field('할 일', 'title', '', esc, { required: true, placeholder: '예: 세탁물 꺼내기' }) + field('알림 시각', 'targetAt', localInput(now + 30 * 60000), esc, { type: 'datetime-local', required: true, attrs: `min="${localInput(now)}"` }), '카운트다운 시작', esc)}
    ${completed.length ? `<details class="tool-edit-details"><summary>완료한 알림 ${completed.length}개 ${icon('chevron')}</summary>${list(completed, true)}</details>` : ''}`, opts);
}

function routineSheet(key, tools, opts) {
  const { icon, esc, now = Date.now() } = opts;
  const id = key.split(':')[1];
  const routine = tools.routines.find(item => item.id === id);
  if (id && !routine) return sheet('루틴을 찾을 수 없어요', '<p class="tool-notice">목록에서 다른 루틴을 열어주세요.</p>', opts);
  const next = routine && nextRoutineAt(routine, now);
  const routineStatus = !routine?.enabled ? '잠시 멈춰 있어요'
    : routine.endsAt < localDay(now) ? '설정한 기간이 끝났어요' : '기간 안에 남은 예정 시간이 없어요';
  const list = !id && tools.routines.length ? `<ul class="tool-sheet-list">${tools.routines.map(item => `<li class="tool-routine-row"><button class="tool-simple-row" type="button" data-action="open-tool" data-tool="routine:${esc(item.id)}"><span class="tool-feature-copy"><strong>${esc(item.title)}</strong><span>${REPEATS[item.repeat]} ${item.time} · ${item.endsAt.slice(5).replace('-', '/')}까지</span></span>${icon('chevron')}</button>${button('routine-toggle', item.id, `<span class="tool-toggle-knob"></span>`, esc, 'tool-toggle', `role="switch" aria-checked="${item.enabled}" aria-label="${esc(item.title)} 켜기"`)}</li>`).join('')}</ul>` : '';
  const fields = field('루틴 이름', 'title', routine?.title, esc, { required: true, placeholder: '예: 퇴근 정리' })
    + `<div class="tool-field"><label for="tool-rule">챙길 내용</label><textarea id="tool-rule" name="rule" rows="3" maxlength="500" required placeholder="예: 오늘 남긴 메모를 확인하고 내일 할 일을 정하기">${esc(routine?.rule || '')}</textarea></div>`
    + `<div class="tool-field-pair">${select('반복', 'repeat', Object.entries(REPEATS), routine?.repeat || 'weekdays', esc)}${field('확인할 시간', 'time', routine?.time || '19:00', esc, { type: 'time', required: true })}</div>`
    + field(routine ? '오늘부터 이어갈 기간' : '이어갈 기간', 'horizon', routine?.horizon || 14, esc, { type: 'number', required: true, attrs: 'min="1" max="365" step="1" aria-describedby="tool-horizon-help"' })
    + '<p class="tool-field-help" id="tool-horizon-help">1~365일 · 기간이 지나면 다음 일정이 표시되지 않아요.</p>';
  return sheet(routine?.title || '반복 루틴', `${list}${routine ? `<div class="tool-routine-status"><span>${next ? `다음 ${esc(dateLabel(next))}` : routineStatus}</span>${button('routine-toggle', id, routine.enabled ? '잠시 멈추기' : '다시 켜기', esc)}</div><p class="tool-routine-rule">${esc(routine.rule)}</p>${next ? button('routine-complete', id, `${icon('check')}<span>오늘 챙겼어요</span>`, esc, 'sheet-secondary tool-routine-complete') : ''}` : ''}
    <p class="tool-notice">정한 시간에 확인할 내용을 저장해요. 외부 앱 작업이나 자동 메시지는 실행하지 않아요.</p>
    <h3 class="tool-form-title">${routine ? '루틴 수정' : '새 루틴'}</h3>${form(key, fields, routine ? '변경 저장' : '루틴 만들기', esc)}
    ${routine ? button('routine-delete', id, '루틴 지우기', esc, 'tool-text-action tool-delete') : ''}`, opts);
}

function briefingSheet(key, tools, opts) {
  const { esc } = opts;
  const news = key === 'news';
  const config = tools[key];
  const sample = news ? `<ol class="tool-news-list">${NEWS.map(([title, copy], index) => `<li><details><summary><span class="tool-news-number">${index + 1}</span><strong>${esc(title)}</strong></summary><p>${esc(copy)}</p></details></li>`).join('')}</ol>`
    : `<div class="tool-market-value"><span>${esc(config.symbol)} · ${MARKETS[config.symbol].market}</span><strong>${MARKETS[config.symbol].value}<small>${MARKETS[config.symbol].unit}</small></strong><p>+1.82% <span>예시 등락률</span></p></div>`;
  const fields = (news ? field('저장할 관심 주제', 'topic', config.topic, esc, { required: true, maxlength: 60 }) : select('관심 종목', 'symbol', Object.keys(MARKETS).map(name => [name, name]), config.symbol, esc))
    + field('확인할 시간', 'time', config.time, esc, { type: 'time', required: true });
  return sheet(news ? '뉴스 브리핑' : '관심 시세', `<div class="tool-sample-notice"><span class="tool-sample-label">예시 데이터</span><p>${news ? '원래 모리의 화면 예시 3개예요. 실제 기사를 수집하거나 갱신하지 않아요.' : '원래 모리의 고정된 예시 가격이에요. 실시간 시세가 아니에요.'}</p></div>${sample}
    <div class="tool-setting-toggle"><span>오늘 일정에 예시 표시</span>${button(`${key}-toggle`, '', '<span class="tool-toggle-knob"></span>', esc, 'tool-toggle', `role="switch" aria-checked="${config.enabled}" aria-label="${news ? '뉴스' : '시세'} 예시 일정 표시"`)}</div>
    ${form(key, fields, '설정 저장', esc)}`, opts);
}

export function renderToolSheet(key, tools, opts) {
  if (key === 'parking') return parkingSheet(tools, opts);
  if (key === 'reminders' || key.startsWith('reminder:')) return reminderSheet(key, tools, opts);
  if (key === 'routines' || key.startsWith('routine:')) return routineSheet(key, tools, opts);
  if (key === 'news' || key === 'market') return briefingSheet(key, tools, opts);
  return sheet('기능을 찾을 수 없어요', '<p class="tool-notice">기능 목록에서 다시 선택해주세요.</p>', opts);
}

export function applyToolForm(key, state, fields) {
  const get = name => clean(typeof fields?.get === 'function' ? fields.get(name) : fields?.[name], 1000);
  const now = Date.now();
  const id = key.split(':')[1];
  if (key === 'parking') {
    const place = get('place').slice(0, 80), floor = get('floor').slice(0, 30), spot = get('spot').slice(0, 30);
    if (!place && !floor && !spot) return { error: '장소, 층, 자리 번호 중 하나를 입력해주세요.' };
    return { state: { ...state, parking: { place, floor, spot, note: get('note').slice(0, 300), savedAt: new Date(now).toISOString() } }, message: '주차 위치를 저장했어요.' };
  }
  if (key === 'reminders' || key.startsWith('reminder:')) {
    const title = get('title').slice(0, 80), targetAt = get('targetAt');
    if (!title) return { error: '알림 이름을 입력해주세요.' };
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(targetAt) || !Number.isFinite(Date.parse(targetAt)) || localInput(targetAt) !== targetAt) return { error: '올바른 날짜와 시간을 선택해주세요.' };
    if (Date.parse(targetAt) <= now) return { error: '현재보다 뒤의 시간을 선택해주세요.' };
    const previous = state.reminders.find(item => item.id === id);
    if (id && !previous) return { error: '이 알림을 찾을 수 없어요.' };
    if (previous?.completedAt) return { error: '완료한 알림은 새 알림으로 만들어주세요.' };
    if (!previous && state.reminders.length >= MAX_ITEMS) return { error: '알림은 100개까지 저장할 수 있어요. 완료한 알림을 먼저 지워주세요.' };
    const item = { id: previous?.id || newId('reminder'), title, targetAt: new Date(targetAt).toISOString(), createdAt: previous?.createdAt || new Date(now).toISOString(), completedAt: null };
    return { state: { ...state, reminders: previous ? state.reminders.map(old => old.id === id ? item : old) : [...state.reminders, item] }, message: previous ? '알림을 변경했어요.' : '카운트다운을 시작했어요.' };
  }
  if (key === 'routines' || key.startsWith('routine:')) {
    const title = get('title').slice(0, 80), rule = get('rule').slice(0, 500), time = get('time'), repeat = get('repeat'), horizon = Number(get('horizon'));
    if (!title || !rule) return { error: '루틴 이름과 챙길 내용을 입력해주세요.' };
    if (!TIME.test(time) || !Object.hasOwn(REPEATS, repeat)) return { error: '반복할 요일과 시간을 선택해주세요.' };
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) return { error: '기간은 1~365일 사이로 입력해주세요.' };
    const previous = state.routines.find(item => item.id === id);
    if (id && !previous) return { error: '이 루틴을 찾을 수 없어요.' };
    if (!previous && state.routines.length >= MAX_ITEMS) return { error: '루틴은 100개까지 저장할 수 있어요.' };
    const end = new Date(now); end.setDate(end.getDate() + horizon - 1);
    const item = { id: previous?.id || newId('routine'), title, rule, time, repeat, horizon, createdAt: previous?.createdAt || new Date(now).toISOString(), endsAt: localDay(end), enabled: previous?.enabled ?? true, lastCompletedAt: previous?.lastCompletedAt || null };
    return { state: { ...state, routines: previous ? state.routines.map(old => old.id === id ? item : old) : [...state.routines, item] }, message: previous ? '루틴을 변경했어요.' : '반복 루틴을 만들었어요.' };
  }
  if (key === 'news' || key === 'market') {
    if (!TIME.test(get('time'))) return { error: '확인할 시간을 선택해주세요.' };
    if (key === 'news' && !get('topic')) return { error: '관심 주제를 입력해주세요.' };
    if (key === 'market' && !Object.hasOwn(MARKETS, get('symbol'))) return { error: '관심 종목을 선택해주세요.' };
    return { state: { ...state, [key]: { ...state[key], time: get('time'), ...(key === 'news' ? { topic: get('topic').slice(0, 60) } : { symbol: get('symbol') }) } }, message: '예시 브리핑 설정을 저장했어요.' };
  }
  return { error: '저장할 기능을 찾을 수 없어요.' };
}

export function applyToolAction(action, state, id) {
  const now = new Date().toISOString();
  if (action === 'parking-clear') return { state: { ...state, parking: null }, message: '주차 기록을 지웠어요.' };
  if (action.startsWith('reminder-')) {
    const item = state.reminders.find(reminder => reminder.id === id);
    if (!item) return { state, message: '이 알림을 찾을 수 없어요.' };
    if (action === 'reminder-delete') return { state: { ...state, reminders: state.reminders.filter(reminder => reminder.id !== id) }, message: '알림을 지웠어요.' };
    if (action === 'reminder-complete') return { state: { ...state, reminders: state.reminders.map(reminder => reminder.id === id ? { ...reminder, completedAt: now } : reminder) }, message: '완료했어요.' };
    if (action === 'reminder-extend' && !item.completedAt) return { state: { ...state, reminders: state.reminders.map(reminder => reminder.id === id ? { ...reminder, targetAt: new Date(Math.max(Date.now(), Date.parse(reminder.targetAt)) + 10 * 60000).toISOString() } : reminder) }, message: '10분을 더했어요.' };
  }
  if (action.startsWith('routine-')) {
    const item = state.routines.find(routine => routine.id === id);
    if (!item) return { state, message: '이 루틴을 찾을 수 없어요.' };
    if (action === 'routine-delete') return { state: { ...state, routines: state.routines.filter(routine => routine.id !== id) }, message: '루틴을 지웠어요.' };
    if (action === 'routine-toggle') return { state: { ...state, routines: state.routines.map(routine => routine.id === id ? { ...routine, enabled: !routine.enabled } : routine) }, message: item.enabled ? '루틴을 잠시 멈췄어요.' : '루틴을 켰어요.' };
    if (action === 'routine-complete') return { state: { ...state, routines: state.routines.map(routine => routine.id === id ? { ...routine, lastCompletedAt: now } : routine) }, message: '오늘 챙긴 것으로 남겼어요.' };
  }
  if (action === 'news-toggle' || action === 'market-toggle') {
    const key = action.split('-')[0];
    return { state: { ...state, [key]: { ...state[key], enabled: !state[key].enabled } }, message: state[key].enabled ? '예시 일정 표시를 껐어요.' : '예시 일정 표시를 켰어요.' };
  }
  return { state, message: '이 동작을 실행할 수 없어요.' };
}
