import { VERSION, BUILTINS, seed, uid, esc, dateKey, nowOf, setClock, visibleCards, applyRequest, runCustom, minuteOf, tickScheduled } from './experience.mjs';
import { DASHBOARD_WINDOWS, dashboardTimeline } from './dashboard-timeline.mjs';
import { recordsOf, conversationGroups, customPreview } from './experience-library.mjs';
import { api } from './api.mjs';
import { choiceField, installChoices, setChoice } from './choice-field.mjs';
import { EVENT_KINDS, eventKind, dayDate, eventsOn, moveDate, calendarDates, eventDuration, eventEnd, eventDaySpan, timelineHours, hasOverlap } from './calendar-model.mjs';
import { parkingAttempt, parkingLabel } from './ui-model.mjs';

const $ = s => document.querySelector(s);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const button = (action, content, cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${content}</button>`;
const arrow = icon('chevron');
const mark = (name, color = 'green') => `<span class="feature-icon ${color}">${icon(name)}</span>`;
const KEY = 'mori.experience.v6';
let data;
try { data = JSON.parse(localStorage.getItem(KEY)); if (data?.version !== VERSION || !Array.isArray(data.customs) || !Array.isArray(data.reminders)) data = null; } catch { data = null; }
data ||= seed();
data.drafts ||= {};
// Old demo preferences no longer control account settings or dashboard visibility.
data.profile.recent = true;
data.profile.notify = true;
data.profile.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let selectedTheme = 'system';
try { const stored = localStorage.getItem('mori.theme.v1'); if (['system', 'light', 'dark'].includes(stored)) selectedTheme = stored; } catch { /* Storage is optional. */ }
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = selectedTheme === 'dark' || selectedTheme === 'system' && systemTheme.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#18211e' : '#f7f8f5';
}
applyTheme(); systemTheme.addEventListener('change', applyTheme);
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => { data.profile.reduced = event.matches; render(); });
const ui = { view: 'dashboard', horizon: 0, windowMenu: false, resetRails: false, date: dateKey(nowOf(data)), month: new Date(nowOf(data)), calendar: 'month', filter: 'all', chatId: null, search: '', chart: '1일', detail: null, voiceText: '', recordFilter: 'all', liveUser: null, liveParking: null, accountEpoch: 0, accountState: 'checking', settingsRevision: 0 };
ui.month.setDate(1);
installChoices();
let toastTimer, recognition, voiceListening = false, liveAttempt = null, fileBusy = false, deletedEvent = null, deletedNote = null;
const busy = new Set();
let railObserver;
const time = value => new Date(value).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dateLabel = value => new Date(value).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
const shortDate = value => new Date(value).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
const clockLabel = value => { const [h, m] = value.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(m).padStart(2, '0')}`; };
const current = () => nowOf(data);
const todayEvents = () => data.events.filter(e => e.date === dateKey(current())).sort((a, b) => a.time.localeCompare(b.time));
function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { toast('저장 공간이 부족해요. 문서나 오래된 기록을 정리해 주세요.'); } }
function toast(message, undoAction = '') { const host = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body; host.append($('#toast')); clearTimeout(toastTimer); $('#toast').innerHTML = `<span>${esc(message)}</span>${undoAction ? button(undoAction, '되돌리기', '') : ''}`; $('#toast').classList.toggle('has-action', Boolean(undoAction)); $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), undoAction ? 9000 : 3400); }
function heading(title, subtitle = '', trailing = '') { return `<header class="page-heading"><div>${subtitle ? `<p class="eyebrow">${subtitle}</p>` : ''}<h1>${title}</h1></div>${trailing}</header>`; }
function section(title, trailing = '') { return `<div class="section-heading"><h2>${title}</h2>${trailing}</div>`; }
function empty(iconName, title, copy, action = '') { return `<div class="empty-state">${mark(iconName)}<h3>${title}</h3><p>${copy}</p>${action}</div>`; }
function tag(text, cls = '') { return `<span class="tag ${cls}">${text}</span>`; }
function eventRow(e) { return button('detail', `<span class="event-time">${e.time}</span><span class="event-line ${e.color}"></span><span class="row-content"><strong>${esc(e.title)}</strong><small>${esc(e.place || '나의 일정')}</small></span>${arrow}`, 'event-row', `data-ref="event:${e.id}"`); }
function noteRow(n) { return button('detail', `${mark('note', 'amber')}<span class="row-content"><strong>${esc(n.title)}</strong><small>${esc(n.body.replace(/\n/g, ' · ').slice(0, 55))}</small><span class="row-meta">${shortDate(n.at)} · 메모</span></span>${arrow}`, 'record-row', `data-ref="note:${n.id}"`); }
function mapArt() { return `<div class="parking-map" aria-hidden="true"><span class="map-road"></span><span class="map-road vertical"></span><span class="map-label">주차 위치 메모</span><div class="parking-slots"><i></i><i></i><i class="occupied">${icon('car')}</i><i></i></div><span class="map-pin">${esc(data.parking?.spot || 'P')}</span><span class="map-dot"></span><span class="map-tree one"></span><span class="map-tree two"></span></div>`; }
function recordRow(r) { return button('detail', `${mark(r.icon, r.color)}<span class="row-content"><span class="record-kind">${r.label} · ${shortDate(r.at)}</span><strong>${esc(r.title)}</strong><small>${esc(r.excerpt.replace(/\n/g, ' · '))}</small></span>${arrow}`, 'record-row', `data-ref="${r.kind}:${r.id}"`); }
function recordsSheet(filter = ui.recordFilter) {
  ui.recordFilter = filter; const records = recordsOf(data, filter);
  openSheet('기록 보관함', `<p class="sheet-description">메모와 문서, 실행 결과를 한곳에.<br>가장 최근에 남긴 기록부터 보여드려요.</p><div class="filter-chips" aria-label="기록 종류">${[['all', '전체'], ['note', '메모'], ['document', '문서'], ['custom', '실행 결과']].map(([v, label]) => button('record-filter', label, filter === v ? 'selected' : '', `data-value="${v}" aria-pressed="${filter === v}"`)).join('')}</div><div class="record-list">${records.map(recordRow).join('') || empty('file', '아직 남긴 기록이 없어요', '생각을 남기거나 파일을 정리해 보세요.')}</div><div class="detail-actions">${button('new-note', icon('plus') + ' 메모 남기기', 'secondary-button')}${button('document', icon('upload') + ' 파일 정리', 'secondary-button')}</div>`);
}
function timeCard(ref) {
  const [kind, id] = ref.split(':'); let content, cls = kind;
  if (kind === 'parking') content = `<div class="card-top">${mark('car')}${tag('출근길에 챙겨요')}</div><h3>내 차는<br><b>${esc(data.parking.floor)} ${esc(data.parking.spot)}</b></h3><p>오늘도 가벼운 출근길 되세요.</p>${mapArt()}<div class="card-bottom"><span>${time(data.parking.at)}에 기억했어요</span><span class="round-arrow">${icon('arrow')}</span></div>`;
  if (kind === 'news') content = `<div class="card-top">${mark('news', 'blue')}${tag(data.news.status === 'loading' ? '수집 중' : '나를 위한 브리핑', 'blue')}</div><h3>${data.news.status === 'loading' ? '새로운 이야기를,<br><b>모으고 있어요.</b>' : data.news.status === 'failed' ? '브리핑이 조금,<br><b>늦어지고 있어요.</b>' : dateKey(data.news.at) !== dateKey(current()) ? '새로운 이야기는,<br><b>' + clockLabel(data.news.time) + '부터.</b>' : '세상의 새로운 이야기,<br><b>핵심만 모았어요.</b>'}</h3><p>${esc(data.news.topic)} · ${clockLabel(data.news.time)}</p><div class="news-card-art"><span>${data.news.status === 'loading' ? '브리핑 준비 중' : data.news.status === 'failed' ? '잠시 쉬어가고 있어요' : '나의 관심 주제'}</span><b>${esc(data.news.topic)}</b><div><i>${data.news.status === 'loading' ? '수집 · 정리 중' : data.news.status === 'failed' ? '눌러서 다시 시도' : '요약과 출처를 함께'}</i></div></div><div class="card-bottom"><span>${data.news.status === 'ready' ? '브리핑 예시 · 기사 3개' : '새 소식을 준비하고 있어요'}</span><span class="round-arrow">${icon('arrow')}</span></div>`;
  if (kind === 'stock') content = `<div class="card-top">${mark('chart', 'rose')}${tag('관심 종목', 'rose')}</div><h3>${esc(data.stock.symbol)}<br><b>${data.stock.symbol === '코스피' ? '2,650.24' : data.stock.symbol === '애플' ? '228.40' : '72,400'}<small>${data.stock.symbol === '코스피' ? ' pt' : data.stock.symbol === '애플' ? ' USD' : ' 원'}</small></b></h3><p class="positive">+1.82% <span>예시 흐름</span></p>${sparkline()}<div class="card-bottom"><span>화면 체험용 예시 시세</span><span class="round-arrow">${icon('arrow')}</span></div>`;
  if (kind === 'schedule') { const e = todayEvents().find(e => minuteOf(e.time) >= new Date(current()).getHours() * 60 + new Date(current()).getMinutes()) || todayEvents()[0]; content = `<div class="card-top">${mark('calendar', 'purple')}${tag('다가오는 약속', 'purple')}</div><h3>오늘의 다음 순간,<br><b>${esc(e?.title || '나만의 시간')}</b></h3><div class="appointment-time">${e?.time || '여유롭게'}<span>${esc(e?.place || '')}</span></div><div class="card-bottom"><span>오늘 일정 ${todayEvents().length}개</span><span class="round-arrow">${icon('arrow')}</span></div>`; }
  if (kind === 'reminder') { const r = data.reminders.find(r => r.id === id); content = `<div class="card-top">${mark('bell', 'orange')}${tag('다가오는 알림', 'orange')}</div><h3>${esc(r.title)}<br><b data-countdown="${id}">${remaining(r.target)}</b></h3><p>${time(r.target)}에 챙겨드릴게요.</p><div class="mini-timer">${icon('clock')}</div><div class="card-bottom"><span>기기 내 알림 체험</span><span class="round-arrow">${icon('arrow')}</span></div>`; }
  if (kind === 'custom') { const f = data.customs.find(f => f.id === id); content = `<div class="card-top">${mark(f.icon, 'purple')}${tag('나만의 기능', 'purple')}</div><h3>나를 위한 작은 부탁,<br><b>${esc(f.title)}</b></h3><p>${esc(f.description)}</p><div class="custom-art">${icon('spark')}<span>${f.result ? `최근 결과 ${f.result.items.length}개<br>눌러서 확인해 보세요.` : '정해둔 순간에,<br>나에게 맞는 도움을.'}</span></div><div class="card-bottom"><span>${clockLabel(f.time)} · ${f.repeat}</span><span class="round-arrow">${icon('arrow')}</span></div>`; }
  return button('detail', content, `time-card ${cls}`, `data-ref="${ref}" aria-label="${kind === 'parking' ? '주차 위치 상세' : `${BUILTINS.find(f => f.id === kind)?.title || '내 기능'} 상세`}"`);
}
function sparkline() { const paths = {'1주': 'M0 65L30 40L60 55L90 35L120 42L150 60L180 28L210 38L240 12L270 25L300 8', '1달': 'M0 75L30 62L60 68L90 80L120 53L150 48L180 60L210 25L240 32L270 15L300 4'}; if (paths[ui.chart]) return `<svg class="sparkline" viewBox="0 0 300 90" aria-label="${ui.chart} 체험용 가격 흐름"><path class="chart-fill" d="${paths[ui.chart]}V90H0Z"/><path class="chart-line" d="${paths[ui.chart]}"/></svg>`; return `<svg class="sparkline" viewBox="0 0 300 90" aria-label="체험용 가격 흐름"><path class="chart-fill" d="M0 80L20 69L42 74L60 56L80 62L98 43L117 49L132 31L150 40L173 22L193 33L212 17L233 23L258 8L278 14L300 4V90H0Z"/><path class="chart-line" d="M0 80L20 69L42 74L60 56L80 62L98 43L117 49L132 31L150 40L173 22L193 33L212 17L233 23L258 8L278 14L300 4"/></svg>`; }
function closeWindowMenu(restoreFocus = false) {
  ui.windowMenu = false;
  const menu = $('#dashboard-window-menu'); if (menu) menu.hidden = true;
  const trigger = $('#dashboard-window-trigger'); trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}
function toggleWindowMenu() {
  ui.windowMenu = !ui.windowMenu;
  $('#dashboard-window-menu').hidden = !ui.windowMenu;
  $('#dashboard-window-trigger').setAttribute('aria-expanded', String(ui.windowMenu));
  if (ui.windowMenu) { positionWindowMenu(); $('#dashboard-window-menu [aria-pressed=true]')?.focus({ preventScroll: true }); }
}
function positionWindowMenu() {
  const menu = $('#dashboard-window-menu'); if (!menu || menu.hidden) return;
  menu.classList.remove('is-docked');
  const dock = $('.app-dock').getBoundingClientRect();
  menu.classList.toggle('is-docked', menu.getBoundingClientRect().bottom > dock.top - 8);
}
function windowPicker() {
  const selected = DASHBOARD_WINDOWS.find(w => w.hours === ui.horizon);
  return `<div class="time-window-picker">${button('toggle-window', `${icon('clock')}<span>${ui.horizon ? selected.hours === 24 ? '하루 보기' : `앞으로 ${selected.label}` : time(current())}</span>${arrow}`, `window-trigger ${ui.horizon ? 'is-expanded-range' : ''}`, `id="dashboard-window-trigger" aria-expanded="${ui.windowMenu}" aria-controls="dashboard-window-menu" aria-label="표시 시간 범위: ${selected.label}. 범위 선택"`)}
    <div id="dashboard-window-menu" class="window-menu" role="group" aria-label="표시 시간 범위" ${ui.windowMenu ? '' : 'hidden'}><p>얼마나 미리 살펴볼까요?</p>${DASHBOARD_WINDOWS.map(w => button('set-window', `<span><strong>${w.label}</strong><small>${w.description}</small></span>${icon(w.hours === ui.horizon ? 'check' : 'chevron')}`, '', `data-hours="${w.hours}" aria-pressed="${w.hours === ui.horizon}"`)).join('')}<div class="window-menu-hint">예약과 현재 시간은 그대로 유지돼요.</div></div></div>`;
}
function forecastCard(item) {
  const atLabel = `${item.current && dateKey(item.at) !== dateKey(current()) ? '어제 ' : ''}${time(item.at)}`;
  return button('detail', `<div class="forecast-card-top">${mark(item.icon, item.color)}<span class="forecast-status">${item.current ? '지금 확인' : item.action}</span></div><div class="forecast-time">${atLabel}${item.current ? '<small>부터</small>' : ''}</div><h4>${esc(item.title)}</h4><p>${esc(item.description)}</p><div class="forecast-card-bottom"><span>${item.detail}</span>${icon('arrow')}</div><span class="forecast-art" aria-hidden="true">${icon(item.icon)}</span>`, `forecast-card ${item.color} ${item.current ? 'is-current' : ''}`, `data-ref="${item.ref}" data-occurrence="${item.key}" aria-label="${esc(item.title)}, ${atLabel}, ${item.current ? '지금 확인 가능' : item.action}"`);
}
function forecastShelves() {
  const result = dashboardTimeline(data, ui.horizon, current());
  const rangeEnd = `${dateKey(result.until) !== dateKey(result.from) ? '내일 ' : ''}${time(result.until)}`;
  return `<div class="forecast-summary" role="status"><div><span class="forecast-eyebrow">${ui.horizon === 24 ? '앞으로 24시간' : `앞으로 ${ui.horizon}시간`}</span><p>${time(result.from)} <span>—</span> ${rangeEnd}</p></div><strong>${result.count}<small>개의 카드</small></strong></div>
    <div class="forecast-shelves">${result.groups.map(group => `<section class="forecast-shelf" aria-labelledby="shelf-heading-${group.key}"><header><div><span class="shelf-overline">${icon(group.icon)} ${group.span}</span><h3 id="shelf-heading-${group.key}">${group.label}<span>${group.items.length}</span></h3></div><div class="shelf-nav">${button('shelf-page', icon('back'), '', `data-rail="forecast-${group.key}" data-direction="-1" aria-label="${group.label} 이전 카드" aria-controls="forecast-${group.key}" disabled`)}${button('shelf-page', icon('arrow'), '', `data-rail="forecast-${group.key}" data-direction="1" aria-label="${group.label} 다음 카드" aria-controls="forecast-${group.key}"`)}</div></header><div class="forecast-rail" id="forecast-${group.key}" data-forecast-rail role="group" aria-label="${group.label} 카드 목록">${group.items.map(forecastCard).join('')}</div></section>`).join('') || empty('leaf', '이 시간에는 예정된 일이 없어요', '범위를 넓혀 다가오는 일을 살펴보세요.', ui.horizon < 24 ? button('set-window', '하루 전체 살펴보기 ' + arrow, 'text-button', 'data-hours="24"') : button('new-chat', '모리에게 새 부탁하기', 'text-button'))}</div>
    <p class="forecast-footnote">${icon('clock')}저장해 둔 시간 기준이에요. 카드를 눌러 내용을 확인하세요.</p>`;
}
function dashboardNow(cards) {
  return `<section class="now-section ${ui.horizon ? 'is-browsing' : ''}"><div class="section-heading now-heading"><h2>${ui.horizon ? '미리 만나는 나의 하루' : '지금, 나에게 필요한 것'}</h2>${windowPicker()}</div>${ui.horizon ? forecastShelves() : cards.length ? `<div class="time-carousel" id="time-carousel">${cards.map(timeCard).join('')}</div><div class="carousel-dots" aria-label="카드 탐색">${cards.map((ref, i) => button('carousel', '', i === 0 ? 'active' : '', `data-index="${i}" aria-label="${i + 1}번째 카드 · ${BUILTINS.find(f => f.id === ref.split(':')[0])?.title || '내 기능'}"`)).join('')}</div>` : empty('leaf', '지금은 여유로운 시간', '시간 범위를 넓혀 다음 부탁을 살펴보세요.', button('set-window', '앞으로 3시간 보기 ' + arrow, 'text-button', 'data-hours="3"'))}</section>`;
}
function dashboard() {
  const h = new Date(current()).getHours(), cards = visibleCards(data);
  return `<div class="home-top"><span class="wordmark">mori<span></span></span>${button('day-preview', `${icon('sun')} ${h < 12 ? '아침' : h < 18 ? '낮' : '저녁'} 체험 ${arrow}`, 'preview-pill')}</div>
    <header class="home-greeting"><p>${dateLabel(current())}</p><h1>${h < 12 ? '좋은 아침이에요.' : h < 18 ? '조금은 느긋하게.' : '오늘도 수고했어요.'}<br><span>${esc(ui.liveUser?.display_name || data.profile.name)}님의 하루를 챙길게요.</span></h1><button class="greeting-avatar" data-action="go-my" aria-label="마이 화면"><img src="/assets/mori.svg" alt="모리"></button></header>
    ${dashboardNow(cards)}
    <div class="home-lower"><section>${section('가볍게 부탁해요', button('guide', '둘러보기 ' + arrow, 'text-button'))}<div class="quick-actions">${button('new-note', `${mark('note', 'amber')}<span>메모 남기기</span>`)}${button('prompt', `${mark('bell', 'orange')}<span>30분 뒤 알림</span>`, '', 'data-prompt="30분 뒤에 잠깐 쉬라고 알림 줘"')}${button('new-custom', `${mark('spark', 'purple')}<span>내 기능 만들기</span>`)}</div>
    ${section('기록과 정리', button('records', '보관함 ' + arrow, 'text-button'))}<div class="record-list">${recordsOf(data).slice(0, 3).map(recordRow).join('') || empty('note', '생각을 가볍게 남겨보세요', '채팅이나 마이크로 메모를 부탁해 보세요.')}</div>${button('document', `${icon('file')} 문서 정리해 보기 ${arrow}`, 'document-entry')}</section>
    <section>${section('오늘의 약속', button('go-schedule', '전체 보기 ' + arrow, 'text-button'))}<div class="surface">${todayEvents().map(eventRow).join('') || empty('calendar', '아직 약속이 없어요', '나를 위한 시간을 만들어보세요.', button('new-event', '일정 추가', 'text-button'))}</div>
    ${data.profile.recent ? section('이어서 이야기해요', button('go-conversations', '전체 보기 ' + arrow, 'text-button')) + `<div class="surface">${data.conversations.slice().sort((a, b) => b.at - a.at).slice(0, 2).map(conversationRow).join('')}</div>` : ''}<p class="home-signoff">작은 부탁, 가벼운 하루. <span>mori</span></p></section></div>`;
}
function conversationRow(c) { const last = c.messages.at(-1), draft = data.drafts[c.id]; return button('open-conversation', `${mark(c.pinned ? 'pin' : 'chat', c.pinned ? 'green' : 'soft')}<span class="row-content"><strong>${esc(c.title)}</strong><small class="${draft ? 'draft-text' : ''}">${draft ? '작성 중 · ' + esc(draft) : esc(last?.text || '새 이야기를 시작해 보세요')}</small></span><span class="row-date">${shortDate(c.at)}</span>`, 'conversation-row', `data-id="${c.id}"`); }
function conversations() {
  const groups = conversationGroups(data.conversations, ui.search, current()), count = groups.reduce((n, [, items]) => n + items.length, 0);
  return `${heading('대화', '지난 부탁도, 새로운 생각도', button('new-chat', icon('compose'), 'header-button', 'aria-label="새 대화"'))}<label class="search-box">${icon('search')}<input id="conversation-search" type="search" placeholder="제목이나 대화 내용으로 찾아요" value="${esc(ui.search)}" aria-label="대화 검색"></label>
  ${!ui.search ? `<div class="conversation-start"><div class="mori-small"><img src="/assets/mori.svg" alt=""></div><div><h2>무슨 생각 하고 계세요?</h2><p>${data.drafts.new ? '쓰던 부탁이 기다리고 있어요.' : '작은 부탁 하나부터 시작해요.'}</p>${button('new-chat', data.drafts.new ? '작성 중인 부탁 이어쓰기 ' + arrow : '새 이야기 시작하기 ' + arrow, 'text-button')}</div>${button('voice', icon('mic'), 'header-button', 'aria-label="말로 새 대화 시작"')}</div>` : `<p class="list-label" role="status">검색 결과 <span>${count}개</span></p>`}
  <div class="conversation-groups">${groups.map(([label, items]) => `<section><p class="list-label">${label} <span>${items.length}</span></p><div class="surface">${items.map(conversationRow).join('')}</div></section>`).join('') || (ui.search ? empty('search', '찾는 이야기가 없어요', '조금 더 짧은 단어나 다른 표현으로 찾아보세요.', button('clear-search', '검색 지우기', 'text-button')) : empty('chat', '첫 이야기를 기다리고 있어요', '주차 위치, 떠오른 생각, 작은 부탁을 남겨보세요.', button('new-chat', '모리와 대화하기', 'primary-button')))}</div>`;
}
function conversationOptions() {
  const c = data.conversations.find(c => c.id === ui.chatId); if (!c) return;
  openSheet('대화 정리', `<form id="conversation-form" data-id="${c.id}">${field('대화 이름', 'title', c.title, 'text', 'required maxlength="80"')}<button class="primary-button" type="submit">이름 저장</button></form>${button('pin-conversation', icon('pin') + (c.pinned ? '고정 해제' : '목록 맨 위에 고정하기'), 'secondary-button full', `data-id="${c.id}"`)}<p class="field-help">자주 이어가는 대화는 고정해 두세요.</p>`);
}
function scheduleEvent(event, nextId = null, date = ui.date) {
  const kind = eventKind(event), span = eventDaySpan(event, date);
  return button('detail', `<span class="agenda-clock"><b>${span.startLabel}</b><small>${span.endLabel}</small></span>
    <span class="agenda-content"><span class="agenda-event-top"><span class="event-kind ${kind.value}">${kind.label}</span>${span.continuation ? `<span class="next-badge">${span.continuation}</span>` : ''}${event.id === nextId ? '<span class="next-badge">다음 일정</span>' : ''}</span>
    <strong>${esc(event.title)}</strong><span class="agenda-range">${span.startLabel} – ${span.endLabel}</span><span class="agenda-place">${icon('pin')}${esc(event.place || '장소 미정')}</span></span>${arrow}`,
    `agenda-event ${kind.value} ${event.id === nextId ? 'is-next' : ''}`, `data-ref="event:${event.id}"`);
}
function schedule() {
  const selected = dayDate(ui.date), year = selected.getFullYear(), month = selected.getMonth();
  const today = dateKey(current()), dates = calendarDates(ui.date, ui.calendar), events = eventsOn(data.events, ui.date);
  const next = todayEvents().find(event => minuteOf(event.time) >= new Date(current()).getHours() * 60 + new Date(current()).getMinutes());
  const scopeDates = ui.calendar === 'day' ? [ui.date] : ui.calendar === 'month' ? dates.filter(key => key.startsWith(ui.date.slice(0, 7))) : dates;
  const scope = [...new Map(scopeDates.flatMap(key => eventsOn(data.events, key)).map(event => [event.id, event])).values()];
  const scopeLabel = { month: ui.date.slice(0, 7) === today.slice(0, 7) ? '이번 달' : '선택한 달', week: dates.includes(today) ? '이번 주' : '선택한 주', day: ui.date === today ? '오늘' : '선택한 날' }[ui.calendar];
  const weekLabel = `${shortDate(dayDate(dates[0]))} – ${shortDate(dayDate(dates.at(-1)))}`;
  const cell = key => {
    const day = dayDate(key), items = eventsOn(data.events, key);
    return button('select-date', `<span class="calendar-date-number">${day.getDate()}</span><span class="calendar-markers" aria-hidden="true">${items.slice(0, 3).map(event => `<i class="${eventKind(event).value}"></i>`).join('')}${items.length > 3 ? '<b>+</b>' : ''}</span>`,
      `${key === ui.date ? 'selected' : ''} ${day.getMonth() !== month ? 'outside' : ''} ${key === today ? 'today' : ''} ${day.getDay() === 0 ? 'sunday' : day.getDay() === 6 ? 'saturday' : ''}`,
      `data-date="${key}" aria-label="${day.getFullYear()}년 ${day.getMonth() + 1}월 ${day.getDate()}일${key === today ? ', 오늘' : ''}, 일정 ${items.length}개" aria-pressed="${key === ui.date}" tabindex="${key === ui.date ? 0 : -1}" ${key === today ? 'aria-current="date"' : ''}`);
  };
  let agenda;
  if (ui.calendar === 'week') {
    agenda = dates.map(key => { const items = eventsOn(data.events, key); return `<section class="week-day-group ${key === ui.date ? 'is-selected' : ''}">
      <div class="week-day-heading">${button('select-date', `${shortDate(dayDate(key))}<span>${dayDate(key).toLocaleDateString('ko-KR', { weekday: 'short' })}</span>${key === today ? '<em>오늘</em>' : ''}`, '', `data-date="${key}"`)}<small>${items.length ? items.length + '개의 약속' : '비워둔 하루'}</small>${button('new-event', icon('plus'), 'small-icon', `data-date="${key}" aria-label="${dateLabel(dayDate(key))} 일정 추가"`)}</div>
      ${items.map(event => scheduleEvent(event, next?.id, key)).join('') || '<p class="week-empty">여유로운 하루네요. 나를 위한 시간을 더해도 좋아요.</p>'}</section>`; }).join('');
  } else if (ui.calendar === 'day') {
    const currentHour = new Date(current()).getHours();
    agenda = `<div class="day-timeline">${timelineHours(events, ui.date).map(hour => {
      const items = events.filter(event => Math.floor(eventDaySpan(event, ui.date).start / 60) === hour);
      const hourText = `${String(hour).padStart(2, '0')}:00`;
      return `<div class="timeline-slot ${ui.date === today && hour === currentHour ? 'is-current' : ''}"><span class="hour-label">${hourText}${ui.date === today && hour === currentHour ? '<i>지금</i>' : ''}</span><div>${items.map(event => scheduleEvent(event, next?.id)).join('') || button('new-event', icon('plus') + '<span>일정 추가</span>', 'empty-hour', `data-date="${ui.date}" data-time="${hourText}" aria-label="${hourText} 일정 추가"`)}</div></div>`;
    }).join('')}</div>`;
  } else {
    agenda = events.map(event => scheduleEvent(event, next?.id)).join('') || `<div class="calendar-empty">${mark('sun', 'amber')}<h3>아직 약속이 없는 하루예요</h3><p>쉬어가는 시간도 좋은 일정이죠.<br>기억할 일이 생기면 여기에 남겨주세요.</p>${button('new-event', icon('plus') + ' 첫 일정 추가', 'secondary-button')}</div>`;
  }
  return `<div class="schedule-topbar">${heading('스케줄', '내 하루의 흐름을 한눈에', button('new-event', icon('plus'), 'header-button', 'aria-label="일정 추가"'))}
    <div class="schedule-summary"><div><span>${scopeLabel}의 약속</span><strong>${scope.length}<small>개</small></strong></div><p>${next ? `다음은 <b>${esc(next.title)}</b><span>오늘 ${next.time} · ${esc(next.place || '장소 미정')}</span>` : '지금은 여유로운 시간이에요.<span>다가올 약속을 천천히 챙겨보세요.</span>'}</p></div></div>
    <div class="segmented calendar-modes" aria-label="달력 보기 방식">${[['month', '월'], ['week', '주'], ['day', '일']].map(([id, title]) => button('calendar-mode', title, ui.calendar === id ? 'selected' : '', `data-value="${id}" aria-pressed="${ui.calendar === id}"`)).join('')}</div>
    <div class="schedule-layout ${ui.calendar}"><section class="calendar-surface" aria-label="날짜 선택">
      <div class="month-header">${button('calendar-jump', `${year}년 ${month + 1}월 ${arrow}`, 'month-title', 'aria-label="연도와 월 선택"')}<div>${button('calendar-today', '오늘', 'today-button')}${button('month-prev', icon('back'), 'small-icon', 'aria-label="이전 기간"')}${button('month-next', arrow, 'small-icon', 'aria-label="다음 기간"')}</div></div>
      <div class="weekdays">${['일', '월', '화', '수', '목', '금', '토'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="calendar-grid ${ui.calendar !== 'month' ? 'week-strip' : ''}">${dates.map(cell).join('')}</div>
      <div class="calendar-legend">${EVENT_KINDS.map(kind => `<span><i class="${kind.value}"></i>${kind.label}</span>`).join('')}</div>
    </section><section class="agenda-panel" aria-label="일정 목록">
      <div class="agenda-heading"><div><p>${ui.calendar === 'week' ? '한 주의 흐름' : ui.date === today ? 'TODAY' : selected.toLocaleDateString('ko-KR', { weekday: 'long' })}</p><h2>${ui.calendar === 'week' ? weekLabel : `${selected.getMonth() + 1}월 ${selected.getDate()}일`}</h2></div><span>${ui.calendar === 'week' ? scope.length : events.length}개의 약속</span></div>
      <div class="agenda-body">${agenda}</div>${events.length && ui.calendar === 'month' ? button('new-event', icon('plus') + ' 이 날에 일정 추가', 'agenda-add') : ''}
    </section></div><div class="quiet-card">${icon('spark')}<div><strong>말로 남겨도, 같은 달력에.</strong><p>“내일 오후 2시 디자인 회의 잡아줘”</p></div>${button('prompt', icon('arrow'), 'small-icon', 'data-prompt="내일 오후 2시 디자인 회의 잡아줘" aria-label="말로 일정 추가 체험"')}</div>`;
}
function calendarJump(year = dayDate(ui.date).getFullYear()) {
  ui.jumpYear = year;
  openSheet('날짜로 이동', `<div class="jump-year">${button('jump-year', icon('back'), 'small-icon', 'data-delta="-1" aria-label="이전 연도"')}<h3>${year}년</h3>${button('jump-year', arrow, 'small-icon', 'data-delta="1" aria-label="다음 연도"')}</div><div class="month-options">${Array.from({ length: 12 }, (_, month) => button('jump-month', `${month + 1}월`, year === dayDate(ui.date).getFullYear() && month === dayDate(ui.date).getMonth() ? 'selected' : '', `data-month="${month}" aria-pressed="${year === dayDate(ui.date).getFullYear() && month === dayDate(ui.date).getMonth()}"`)).join('')}</div>`);
}
function featureStatus(id) {
  return ({parking: data.parking ? `${data.parking.floor} ${data.parking.spot}` : '위치를 기억해 보세요', news: `${clockLabel(data.news.time)} 브리핑`, stock: data.stock.symbol, note: `기억해 둔 메모 ${data.notes.length}개`, schedule: `오늘의 약속 ${todayEvents().length}개`, reminder: `진행 중 ${data.reminders.filter(r => !r.cancelled && r.target > current()).length}개`})[id];
}
function features() {
  return `${heading('기능', '매일의 부탁을, 나만의 방식으로', button('new-custom', icon('plus'), 'header-button', 'aria-label="새 기능 만들기"'))}<div class="segmented">${[['all', '모든 기능'], ['builtin', '기본 기능'], ['custom', '내 기능']].map(([v, title]) => button('feature-filter', title, ui.filter === v ? 'selected' : '', `data-value="${v}" aria-pressed="${ui.filter === v}"`)).join('')}</div>
    ${ui.filter !== 'custom' ? `${section('매일을 위한 기본 기능', '<span class="section-caption">바로 사용할 수 있어요</span>')}<div class="feature-grid">${BUILTINS.map(f => button('detail', `<div class="feature-tile-top">${mark(f.icon, f.color)}${arrow}</div><h3>${f.title}</h3><p>${f.subtitle}</p><span class="feature-status">${esc(featureStatus(f.id))}</span>`, 'feature-tile', `data-ref="${f.id}"`)).join('')}</div>` : ''}
    ${ui.filter !== 'builtin' ? `${section('나에게 맞춘 기능', `<span class="section-caption">${data.customs.filter(f => f.active).length}개 사용 중</span>`)}<div class="custom-list">${data.customs.map(f => button('detail', `${mark(f.icon, 'purple')}<span class="row-content"><strong>${esc(f.title)}</strong><small>${esc(f.time ? `${f.repeat} ${clockLabel(f.time)}` : '필요할 때 실행')}</small>${f.result ? `<span class="row-meta">최근 실행 ${shortDate(f.result.at)} · 결과 ${f.result.items.length}개</span>` : ''}</span>${tag(!f.work ? '초안' : f.active ? '사용 중' : '중지', f.active ? 'green' : '')}${arrow}`, 'custom-row', `data-ref="custom:${f.id}"`)).join('') || empty('spark', '나만의 루틴을 만들어보세요', '반복하는 부탁을 한 번만 정해두세요.')}</div><button class="create-feature" data-action="new-custom"><span class="create-icon">${icon('spark')}</span><span class="tiny-label">MADE FOR YOU</span><h3>반복하는 부탁,<br>내 기능으로 기억해요.</h3><p>할 일과 시간을 정하면 같은 모양의 카드로 만나보세요.</p><span>새 기능 만들기 ${icon('plus')}</span></button>` : ''}`;
}
const themeLabel = () => ({system: '시스템 설정', light: '라이트', dark: '다크'})[selectedTheme];
function my() {
  const user = ui.liveUser;
  const status = ui.accountState === 'checking' ? '계정을 확인하고 있어요' : ui.accountState === 'error' ? '계정 연결을 확인해 주세요' : '로그인하고 시작해요';
  return `${heading('마이', '나의 계정과 이용 설정')}<div class="profile-summary"><div class="profile-art"><img src="/assets/mori.svg" alt="모리"></div><div><span class="account-eyebrow">${user ? 'MY MORI' : 'WELCOME TO MORI'}</span><h2>${user ? esc(user.display_name) + '님' : '반가워요'}</h2><p>${user ? user.providers.map(p => p === 'naver' ? '네이버' : '카카오').join(' · ') + '로 로그인 중' : status}</p></div></div>
    ${!user ? button('account', '네이버 · 카카오로 로그인 ' + icon('arrow'), 'primary-button full') : ''}
    <div class="license-card account-plan"><div>${tag(user?.tier === 'pro' ? 'Pro' : 'Free')}<h3>${user?.tier === 'pro' ? '나만을 위한 모리' : '가볍게 시작하는 모리'}</h3><p>${user?.tier === 'pro' ? '이용 중인 요금제를 확인하세요.' : '무료로 일상의 부탁을 시작하세요.'}</p></div>${button('license', '요금제 보기 ' + arrow, 'text-button')}</div>
    ${section('계정')}<div class="settings-list">${button('account', `${mark('user', 'soft')}<span class="setting-copy"><strong>사용자 정보</strong><small>${user ? '내 정보와 연결된 계정 확인' : '로그인 후 확인할 수 있어요'}</small></span>${arrow}`, 'setting-row')}${button('edit-profile', `${mark('compose', 'soft')}<span class="setting-copy"><strong>사용자 정보 수정</strong><small>모리가 부를 이름을 변경해요</small></span>${arrow}`, 'setting-row')}</div>
    ${section('앱 설정')}<div class="settings-list">${button('theme', `${mark('moon', 'soft')}<span class="setting-copy"><strong>테마</strong><small>${themeLabel()}</small></span>${arrow}`, 'setting-row')}</div>
    ${section('요금제')}<div class="settings-list">${button('license', `${mark('spark', 'purple')}<span class="setting-copy"><strong>요금제 및 결제 관리</strong><small>무료 이용 · Pro 결제 · 구독 해지</small></span>${arrow}`, 'setting-row')}</div>
    ${user ? button('logout', '로그아웃', 'logout-button full') : ''}<div class="brand-footer">mori <span>작은 부탁, 가벼운 하루.</span></div>`;
}
function render() {
  const main = $('#main');
  const previousScroll = main.scrollTop;
  const railPositions = new Map([...document.querySelectorAll('[data-forecast-rail]')].map(el => [el.id, el.scrollLeft]));
  railObserver?.disconnect();
  const oldCarousel = $('#time-carousel');
  const oldIndex = oldCarousel?.firstElementChild ? Math.round(oldCarousel.scrollLeft / (oldCarousel.firstElementChild.getBoundingClientRect().width + 12)) : 0;
  const cardRef = oldCarousel?.children[oldIndex]?.dataset.ref;
  main.innerHTML = ({ dashboard, schedule, conversations, features, my }[ui.view] || dashboard)();
  main.classList.toggle('has-composer', ui.view === 'dashboard');
  main.dataset.page = ui.view;
  main.scrollTop = previousScroll;
  $('#tabs').innerHTML = [['dashboard', 'home', '대시보드'], ['schedule', 'calendar', '스케줄'], ['conversations', 'chat', '대화'], ['features', 'grid', '기능'], ['my', 'user', '마이']].map(([v, i, label]) => `<button type="button" data-view="${v}" ${v === ui.view ? 'aria-current="page"' : ''}>${icon(i)}<span>${label}</span></button>`).join('');
  $('#quick-composer').hidden = ui.view !== 'dashboard'; document.documentElement.classList.toggle('reduce-motion', data.profile.reduced);
  const carousel = $('#time-carousel'); if (carousel) {
    const index = [...carousel.children].findIndex(card => card.dataset.ref === cardRef);
    if (index > 0) carousel.scrollLeft = index * (carousel.firstElementChild.getBoundingClientRect().width + 12);
    const syncDots = () => { const currentIndex = Math.round(carousel.scrollLeft / (carousel.firstElementChild.getBoundingClientRect().width + 12)); document.querySelectorAll('.carousel-dots button').forEach((el, i) => { el.classList.toggle('active', i === currentIndex); el.setAttribute('aria-pressed', String(i === currentIndex)); }); };
    carousel.addEventListener('scroll', syncDots, { passive: true }); syncDots();
  }
  const syncRail = rail => {
    const max = rail.scrollWidth - rail.clientWidth;
    rail.closest('.forecast-shelf').querySelector('.shelf-nav').hidden = max <= 2;
    for (const control of rail.closest('.forecast-shelf').querySelectorAll('[data-direction]')) {
      control.disabled = Number(control.dataset.direction) < 0 ? rail.scrollLeft <= 2 : rail.scrollLeft >= max - 2;
    }
  };
  railObserver = new ResizeObserver(entries => entries.forEach(({ target }) => syncRail(target)));
  for (const rail of document.querySelectorAll('[data-forecast-rail]')) {
    if (!ui.resetRails) rail.scrollLeft = railPositions.get(rail.id) || 0;
    rail.addEventListener('scroll', () => syncRail(rail), { passive: true });
    railObserver.observe(rail); syncRail(rail);
  }
  ui.resetRails = false;
  if (ui.windowMenu) positionWindowMenu();
}
function route() { const next = location.hash.slice(1); ui.view = ['dashboard', 'schedule', 'conversations', 'features', 'my'].includes(next) ? next : 'dashboard'; render(); $('#main').scrollTop = 0; }
function go(view) { closeWindowMenu(); if (location.hash === `#${view}`) route(); else location.hash = view; }
function openSheet(title, content, cls = '') { ++ui.accountEpoch; ui.detail = null; $('#sheet-title').textContent = title; $('#sheet-content').innerHTML = content; $('#sheet').className = `sheet ${cls}`; if (!$('#sheet').open) $('#sheet').showModal(); $('#sheet-content').scrollTop = 0; }
function closeSheet() { $('#sheet').close(); ui.detail = null; }
const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
const textArea = (label, name, value = '', extra = '') => `<label class="field"><span>${label}</span><textarea name="${name}" rows="4" ${extra}>${esc(value)}</textarea></label>`;
function parkingForm(live = false) { const p = live ? ui.liveParking : data.parking; openSheet(live ? '계정에 주차 위치 저장' : '주차 위치 기억하기', `<form id="${live ? 'live-parking' : 'parking-form'}"><div class="form-intro">${mark('car')}<h3>어디에 주차하셨나요?</h3><p>${live ? '연결된 실제 Mori 계정에 저장해요.' : '이 기기에 기억하고, 출근길에 보여드려요.'}</p></div><div class="field-pair">${field('층', 'floor', p?.floor || '지하 3층', 'text', 'required maxlength="32"')}${field('구역 · 자리', 'spot', p?.spot || 'B16', 'text', 'maxlength="32"')}</div><div class="inline-info">${icon('sun')}출근 시간 ${clockLabel(data.profile.commute)} · ${data.profile.parkingLead ?? 30}분 전부터 카드에 표시</div><p class="form-error" role="alert"></p><button class="primary-button" type="submit">이 위치 기억하기 ${icon('check')}</button></form>`); }
function noteForm(id) { const n = data.notes.find(n => n.id === id); openSheet(n ? '메모 편집' : '생각 남기기', `<form id="note-form" data-id="${n?.id || ''}">${field('제목', 'title', n?.title || '', 'text', 'maxlength="80" placeholder="떠오른 생각에 이름을 붙여보세요"')}${textArea('내용', 'body', n?.body || '', 'placeholder="짧은 한 줄이어도 좋아요." maxlength="12000"')}<button class="primary-button" type="submit">메모 저장 ${icon('check')}</button></form>`); }
function eventForm(id, date = ui.date, startTime = '14:00') {
  const event = data.events.find(event => event.id === id);
  const duration = event ? eventDuration(event) : 60;
  const durations = [...new Set([30, 60, 90, 120, 180, duration])].sort((a, b) => a - b).map(value => ({ value, label: `${Math.floor(value / 60) ? Math.floor(value / 60) + '시간' : ''}${value % 60 ? ' ' + value % 60 + '분' : ''}`.trim() }));
  openSheet(event ? '일정 편집' : '새로운 약속', `<form id="event-form" data-id="${event?.id || ''}">
    <p class="form-caption">기억할 약속을 편하게 남겨주세요.</p>
    ${field('어떤 약속인가요?', 'title', event?.title || '', 'text', 'required maxlength="80" placeholder="예: 모리 디자인 미팅"')}
    ${field('날짜', 'date', event?.date || date, 'date', 'required')}
    <div class="field-pair">${field('시작 시간', 'time', event?.time || startTime, 'time', 'required')}${choiceField('소요 시간', 'duration', duration, durations)}</div>
    ${choiceField('일정 종류', 'color', event?.color || 'green', EVENT_KINDS)}
    ${field('장소 · 선택', 'place', event?.place || '', 'text', 'maxlength="120" placeholder="장소나 온라인 링크"')}
    ${textArea('메모 · 선택', 'memo', event?.memo || '', 'maxlength="1000" placeholder="미리 챙길 준비물이나 기억할 내용"')}
    <p class="event-preview" id="event-preview" role="status"></p>
    <div class="form-footer"><button class="primary-button" type="submit">${event ? '변경 저장' : '일정 저장'} ${icon('check')}</button>${event ? button('delete-event', icon('trash') + ' 이 일정 삭제', 'danger-button', `data-id="${event.id}"`) : ''}</div>
  </form>`, 'event-sheet');
  updateEventPreview();
}
function updateEventPreview() {
  const form = $('#event-form'); if (!form) return;
  const values = Object.fromEntries(new FormData(form));
  if (!values.date || !values.time) { $('#event-preview').textContent = '날짜와 시작 시간을 선택해 주세요.'; return; }
  const candidate = { ...values, id: form.dataset.id };
  const overlap = hasOverlap(data.events, candidate);
  $('#event-preview').classList.toggle('has-overlap', overlap);
  $('#event-preview').textContent = `${shortDate(dayDate(values.date))} · ${values.time} – ${eventEnd(candidate)}${overlap ? ' · 같은 시간에 다른 약속이 있어요.' : ''}`;
}
function customForm(id) {
  const f = data.customs.find(f => f.id === id);
  openSheet(f ? '내 기능 편집' : '나만의 기능 만들기', `<div class="form-intro compact-intro">${mark('spark', 'purple')}<h3>반복하는 부탁을 기억해요.</h3><p>미리보기로 카드에 어떻게 보일지 확인해 보세요.</p></div>${!f ? button('custom-example', '예시 채우기 · 평일 저녁에 메모 정리하기 ' + arrow, 'example-request') : ''}<form id="custom-form" data-id="${f?.id || ''}"><div id="custom-preview" class="custom-preview" aria-label="기능 카드 미리보기"></div><fieldset class="icon-picker"><legend>카드 아이콘</legend>${[['spark', '반짝임'], ['note', '메모'], ['leaf', '일상'], ['news', '정보'], ['bell', '알림'], ['compass', '여행']].map(([v, label]) => `<label><input type="radio" name="icon" value="${v}" ${(f?.icon || 'spark') === v ? 'checked' : ''}><span>${icon(v)}<span class="sr-only">${label}</span></span></label>`).join('')}</fieldset>${field('기능 이름', 'title', f?.title || '', 'text', 'maxlength="60" placeholder="예: 퇴근 정리"')}${textArea('어떤 일을 하면 좋을까요?', 'work', f?.work || '', 'maxlength="2000" placeholder="오늘 저장한 메모를 모아서 할 일을 정리해줘"')}${field('짧은 설명 · 선택', 'description', f?.description || '', 'text', 'maxlength="180" placeholder="카드에 보여줄 한 줄"')}<div class="field-pair">${field('실행 시간 · 선택', 'time', f?.time || '', 'time')}${choiceField('반복', 'repeat', f?.repeat || '필요할 때', ['필요할 때', '매일', '평일', '한 번'])}</div><details class="support-details"><summary>참고할 내용 추가하기</summary>${textArea('참고 자료 · 선택', 'content', f?.content || '', 'maxlength="6000" placeholder="함께 확인할 내용을 남겨주세요"')}</details><p class="field-help">시간이 없으면 필요할 때 직접 실행해요.<br>체험에서는 앱이 열려 있을 때 저장한 메모를 정리해요.</p><button class="primary-button" type="submit">${f ? '변경 저장' : '내 기능으로 저장'} ${icon('check')}</button></form>`);
  updateCustomPreview();
}
function updateCustomPreview() {
  const form = $('#custom-form'); if (!form) return;
  const f = customPreview(Object.fromEntries(new FormData(form)));
  $('#custom-preview').innerHTML = `<div class="preview-label">카드 미리보기 ${tag(f.work ? '준비됨' : '초안', 'purple')}</div><div class="preview-content">${mark(f.icon, 'purple')}<div><strong>${esc(f.title)}</strong><p>${esc(f.description)}</p></div></div><div class="preview-time">${icon(f.time ? 'clock' : 'spark')}${f.time ? `${f.repeat} ${clockLabel(f.time)}` : '필요할 때 직접 실행'}</div>`;
}
function remaining(target) { const total = Math.max(0, Math.ceil((target - current()) / 1000)); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }
const articleTitles = ['우리의 일상으로 들어온 작은 AI 비서', '새로운 도구보다 중요한 건, 좋은 질문', '덜 복잡하게 일하는 사람들의 공통점'];
function openDetail(ref) {
  const [kind, id] = ref.split(':');
  if (kind === 'parking') { if (!data.parking) return parkingForm(); openSheet('주차 기록', `<div class="detail-hero parking-detail">${mark('car')}<p>잘 기억하고 있어요</p><h2>${esc(data.parking.floor)}<br><strong>${esc(data.parking.spot || '내 차가 있는 곳')}</strong></h2>${mapArt()}</div><div class="detail-facts"><div><span>기억한 시간</span><strong>${shortDate(data.parking.at)} ${time(data.parking.at)}</strong></div><div><span>출근길 카드</span><strong>${data.parking.enabled === false ? '표시 중지' : `${clockLabel(data.parking.show)}부터`}</strong></div><div><span>알림 방식</span><strong>대시보드에 표시</strong></div></div><p class="field-help">다른 곳에 주차하면 가장 최근 위치로 바뀌어요.</p>${button('edit-parking', '새 위치 기억하기 ' + icon('car'), 'primary-button')}${button('toggle-parking', data.parking.enabled === false ? '출근길 카드 다시 표시' : '출근길 카드 잠시 중지', 'secondary-button full')}`); }
  else if (kind === 'news') openSheet('뉴스 브리핑', `<div class="detail-title">${mark('news', 'blue')}<p>${esc(data.news.topic)} · ${clockLabel(data.news.time)}</p><h2>오늘의 이야기,<br>핵심만 간결하게.</h2>${tag('체험용 예시 기사', 'blue')}</div>${data.news.status === 'loading' ? `<div class="loading-news"><span class="loading-orb"></span><h3>관심 있는 이야기를 모으고 있어요.</h3><p>요약과 출처를 함께 정리할게요.</p><div class="skeleton"></div><div class="skeleton short"></div></div>` : data.news.status === 'failed' ? `<div class="error-card">${icon('cloud')}<h3>브리핑이 조금 늦어지고 있어요.</h3><p>마지막 결과: ${shortDate(data.news.at)} ${time(data.news.at)}<br>새 결과가 도착하면 갱신할게요.</p>${button('refresh-news', '다시 수집하기', 'secondary-button')}</div>` : `<p class="updated-at">${shortDate(data.news.at)} ${time(data.news.at)} 기준 · 예시 3개</p><div class="article-list">${articleTitles.map((title, i) => button('article', `<span class="article-number">0${i + 1}</span><span><h3>${title}</h3><p>${['작은 일을 맡기며 달라지는 일상의 모습.', '기술과 함께 더 명확하게 생각하는 방법.', '정보를 줄이고 해야 할 일에 집중하기.'][i]}</p><small>모리 테크 레터 · 예시 출처</small></span>${arrow}`, 'article', `data-index="${i}"`)).join('')}</div>`}<div class="detail-actions">${button('news-settings', '관심사 · 시간 설정', 'secondary-button')}${button('refresh-news', icon('repeat') + ' 새로 수집', 'secondary-button', data.news.status === 'loading' ? 'disabled' : '')}</div><details class="support-details"><summary>브리핑 상태별 화면 체험</summary><div class="state-picker">${[['loading', '수집 중'], ['ready', '완료'], ['failed', '실패']].map(([v, title]) => button('news-state', title, data.news.status === v ? 'selected' : '', `data-value="${v}" aria-pressed="${data.news.status === v}"`)).join('')}</div><p class="field-help">실제 수집 요청 없이 화면 상태를 바꿔보는 옵션이에요.</p></details>`);
  else if (kind === 'stock') openSheet('관심 주가', `<div class="detail-title">${mark('chart', 'rose')}<p>관심 종목 · 화면 체험용 데이터</p><h2>${esc(data.stock.symbol)}</h2><div class="stock-price">${data.stock.symbol === '코스피' ? '2,650.24' : data.stock.symbol === '애플' ? '228.40' : '72,400'}<small>${data.stock.symbol === '코스피' ? ' pt' : data.stock.symbol === '애플' ? ' USD' : '원'}</small></div><p class="positive">+1.82% <span>예시 등락</span></p></div><div class="stock-chart">${sparkline()}<div class="chart-labels">${(ui.chart === '1일' ? ['09:00', '12:00', '15:30'] : ui.chart === '1주' ? ['월', '수', '금'] : ['1일', '15일', '30일']).map(v => `<span>${v}</span>`).join('')}</div></div><div class="segmented">${['1일', '1주', '1달'].map(v => button('chart-range', v, ui.chart === v ? 'selected' : '', `data-value="${v}"`)).join('')}</div><p class="field-help">${ui.chart} 표시 범위 체험 · 실시간 가격과 투자 정보가 아니에요.</p><div class="detail-facts"><div><span>시장 · 통화</span><strong>${data.stock.symbol === '애플' ? 'NASDAQ · USD' : 'KRX · KRW'}</strong></div><div><span>예시 기준 시각</span><strong>${shortDate(data.stock.at)} ${time(data.stock.at)}</strong></div><div><span>데이터 출처</span><strong>화면 체험용 예시</strong></div></div>${button('stock-settings', '관심 종목 바꾸기', 'primary-button')}`);
  else if (kind === 'note' && id) { const n = data.notes.find(n => n.id === id); if (!n) return; openSheet('메모', `<div class="detail-title">${mark('note', 'amber')}<p>${shortDate(n.at)} ${time(n.at)}</p><h2>${esc(n.title)}</h2></div><div class="note-body">${esc(n.body)}</div><div class="detail-actions">${button('edit-note', icon('compose') + ' 편집하기', 'secondary-button', `data-id="${id}"`)}${button('delete-note', icon('trash') + ' 삭제', 'secondary-button', `data-id="${id}"`)}</div>`); }
  else if (kind === 'note') openSheet('메모', `<p class="sheet-description">떠오른 생각을 가볍게 남겨보세요.</p><div class="record-list">${data.notes.map(noteRow).join('')}</div>${button('new-note', icon('plus') + ' 메모 남기기', 'primary-button')}`);
  else if (kind === 'schedule') { closeSheet(); go('schedule'); }
  else if (kind === 'event') { const e = data.events.find(e => e.id === id); if (!e) return; const kind = eventKind(e); openSheet('나의 약속', `<div class="event-detail-top">${mark('calendar', kind.value)}${tag(kind.label, kind.value)}</div><div class="detail-title"><h2>${esc(e.title)}</h2><p>${dateLabel(dayDate(e.date))}</p></div><div class="event-detail-time">${icon('clock')}<div><strong>${e.time} <span>– ${eventEnd(e)}</span></strong><small>${eventDuration(e)}분 동안</small></div></div><div class="event-detail-place">${icon('pin')}<span>${esc(e.place || '장소를 정하지 않았어요')}</span></div>${e.memo ? `<div class="note-body">${esc(e.memo)}</div>` : ''}${button('edit-event', icon('compose') + ' 일정 편집하기', 'primary-button', `data-id="${id}"`)}`); }
  else if (kind === 'reminder' && id) { const r = data.reminders.find(r => r.id === id); if (!r) return; const done = current() >= r.target; openSheet('나의 알림', `<div class="timer-scene ${r.cancelled ? 'cancelled' : ''}"><p>${esc(r.title)}</p><div class="timer-ring"><svg viewBox="0 0 240 240" aria-hidden="true"><circle class="timer-track" cx="120" cy="120" r="108"/><circle class="timer-progress" cx="120" cy="120" r="108" stroke-dasharray="679" stroke-dashoffset="0"/></svg><div><span data-countdown="${id}">${r.cancelled ? '중지됨' : remaining(r.target)}</span><small>${r.cancelled ? '다시 시작할 수 있어요' : done ? '목표 시각이 되었어요' : '남은 시간'}</small></div></div><h2>${time(r.target)}</h2><p>이 기기의 알림 체험 · 실제 푸시는 전송하지 않아요</p></div><div class="detail-actions">${button('timer-extend', '+ 5분', 'secondary-button', `data-id="${id}"`)}${button('timer-cancel', r.cancelled ? '다시 30분 시작' : '알림 취소', r.cancelled ? 'primary-button' : 'secondary-button', `data-id="${id}"`)}</div><details class="support-details"><summary>알림 완료 화면 미리보기</summary><p class="field-help">체험 시간을 이 알림의 목표 시각으로 이동해요.</p>${button('timer-finish', '목표 시각으로 이동하기', 'text-button full', `data-id="${id}"`)}</details>`, 'timer-sheet'); }
  else if (kind === 'reminder') openSheet('알림', `<div class="form-intro">${mark('bell', 'orange')}<h3>언제 챙겨드릴까요?</h3><p>짧은 휴식도, 중요한 순간도.</p></div><div class="reminder-presets">${[5, 15, 30, 60].map(m => button('preset-reminder', `<b>${m}</b><span>분 뒤</span>`, '', `data-minutes="${m}"`)).join('')}</div><div class="surface">${data.reminders.map(r => button('detail', `${mark('bell', 'orange')}<span class="row-content"><strong>${esc(r.title)}</strong><small>${r.cancelled ? '중지됨' : r.target <= current() ? '완료된 알림' : `${time(r.target)} · ${remaining(r.target)}`}</small></span>${arrow}`, 'record-row', `data-ref="reminder:${r.id}"`)).join('')}</div>`);
  else if (kind === 'custom') { const f = data.customs.find(f => f.id === id); if (!f) return; openSheet('나만의 기능', `<div class="detail-title">${mark(f.icon, 'purple')}<p>내 기능 · 버전 ${f.version}</p><h2>${esc(f.title)}</h2>${f.description ? `<p>${esc(f.description)}</p>` : ''}${tag(!f.work ? '초안' : f.active ? '사용 중' : '잠시 중지', f.active ? 'green' : '')}</div><div class="work-card"><span class="tiny-label">이렇게 도와드려요</span><p>${esc(f.work || '어떤 일을 할지 편집에서 추가해 주세요.')}</p><div>${icon('clock')} ${esc(f.time ? `${f.repeat} ${clockLabel(f.time)}` : '필요할 때 직접 실행')}</div></div>${f.content ? `<div class="note-body">${esc(f.content)}</div>` : ''}${f.result ? `<div class="section-heading"><h3>최근 실행 결과</h3><small>${time(f.result.at)} · v${f.result.version}</small></div><div class="checklist">${f.result.items.map((item, i) => button('check-item', `<span class="check-box ${item.done ? 'checked' : ''}">${item.done ? icon('check') : ''}</span><span>${esc(item.text)}</span>`, item.done ? 'done' : '', `data-id="${id}" data-index="${i}" aria-pressed="${item.done}"`)).join('')}</div><p class="field-help">저장된 메모를 할 일로 옮기는 로컬 실행 예시예요.</p>` : '<p class="field-help">아직 실행 결과가 없어요. 지금 실행해 결과 화면을 체험해 보세요.</p>'}<div class="detail-actions">${button('edit-custom', '편집', 'secondary-button', `data-id="${id}"`)}${button('toggle-custom', f.active ? '잠시 중지' : '다시 켜기', 'secondary-button', `data-id="${id}"`)}</div>${button('run-custom', icon('spark') + ' 지금 실행하기', 'primary-button', `data-id="${id}" ${!f.active || !f.work ? 'disabled' : ''}`)}<p class="field-help center">정의 · 실행 · 결과가 함께 연결되는 기능 체험</p>`); }
  else if (kind === 'document') { const d = data.documents.find(d => d.id === id); if (!d) return; openSheet('문서 정리', `<div class="detail-title">${mark('file', 'blue')}<p>이 기기에서 정리한 문서</p><h2>${esc(d.title)}</h2></div>${d.highlights ? `<div class="work-card"><span class="tiny-label">정리한 내용 · ${d.highlights.length}줄</span><ol class="document-summary">${d.highlights.map(line => `<li>${esc(line)}</li>`).join('')}</ol></div><details class="support-details"><summary>원문 펼쳐보기</summary><div class="note-body">${esc(d.source)}</div></details>` : `<div class="note-body">${esc(d.summary)}</div>`}<p class="field-help">원문의 앞부분을 목록으로 옮겼어요. AI 요약은 아니에요.</p><div class="file-result">${icon('file')}<div><strong>${esc(d.filename)}</strong><small>실제 텍스트 파일로 내려받을 수 있어요</small></div></div>${button('download', icon('download') + ' 정리한 파일 받기', 'primary-button', `data-id="${id}"`)}`); }
  ui.detail = ref;
}
function guide() { openSheet('모리와 하루를 보내보세요', `<div class="guide-intro"><img src="/assets/mori.svg" alt="모리"><h2>작은 부탁 하나부터.</h2><p>예시를 누르면 대화와 결과가 연결돼요.</p></div><div class="scenario-list">${[['car', 'green', '주차하고, 출근길에 다시 만나기', '지하 3층 B16에 주차했어. 내일 출근할 때 알려줘'], ['news', 'blue', '매일 아침 나만의 뉴스', '매일 오전 9시에 AI 뉴스를 수집해서 정리해줘'], ['chart', 'rose', '관심 있는 종목 챙기기', '삼성전자 주가 알려줘'], ['note', 'amber', '떠오른 생각 남기기', '이번 주말에 한강 산책하기 메모해줘'], ['calendar', 'purple', '말로 만드는 새로운 약속', '내일 오후 2시 디자인 미팅 일정 추가해줘'], ['bell', 'orange', '30분 뒤, 잠깐 쉬어가기', '30분 뒤에 잠깐 쉬라고 알림 줘'], ['spark', 'purple', '나만의 커스텀 기능', '매일 저녁 8시에 오늘 메모를 모아서 정리하는 기능 만들어줘. 제목은 하루 마무리로 해줘']].map(([i, c, title, prompt], idx) => button('prompt', `${mark(i, c)}<span><small>0${idx + 1}</small><strong>${title}</strong></span>${arrow}`, 'scenario-row', `data-prompt="${esc(prompt)}"`)).join('')}</div>${button('document', icon('file') + ' 파일 정리도 체험하기', 'secondary-button full')}<p class="field-help center">실제 AI 서버 없이 작동하는 앱 시나리오 체험이에요.</p>`); }
function dayPreview() { openSheet('모리와 하루 미리보기', `<p class="sheet-description">시간이 바뀌면 필요한 정보도 달라져요.<br>카드가 나타나는 순간을 살펴보세요.</p><div class="day-choices">${[[8, 40, 'sun', '아침', '출근길 주차 · 아침 뉴스'], [9, 0, 'news', '브리핑', '수집 시작부터 완료까지'], [13, 0, 'sun', '낮', '관심 주가 · 다음 약속'], [19, 0, 'moon', '저녁', '퇴근 정리 · 하루 마무리']].map(([h, m, i, title, desc]) => button('set-clock', `${icon(i)}<strong>${title}</strong><span>${h}:${String(m).padStart(2, '0')}</span><small>${desc}</small>`, '', `data-hour="${h}" data-minute="${m}"`)).join('')}</div><p class="field-help">체험 시간을 이동해요. 저장된 기록과 예약은 유지돼요.</p>`); }
function persistDraft() { const key = ui.chatId || 'new', value = $('#chat-input').value; if (value) data.drafts[key] = value; else delete data.drafts[key]; save(); }
function syncComposer() {
  const input = $('#chat-input');
  input.rows = Math.min(4, Math.max(1, input.value.split('\n').length, Math.ceil(input.value.length / 28)));
  $('#chat-send').disabled = !input.value.trim() || input.value.length > 4000 || busy.has(ui.chatId);
}
function openChat(id = null) {
  if ($('#chat-panel').open) persistDraft();
  if (ui.chatId !== id) { ui.voiceText = ''; $('#voice-transcript').value = ''; }
  ui.chatId = id; $('#chat-input').value = data.drafts[id || 'new'] || '';
  if (!$('#chat-panel').open) $('#chat-panel').showModal(); renderChat(true);
}
function renderChat(forceScroll = false) {
  const c = data.conversations.find(c => c.id === ui.chatId), messages = $('#messages');
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100, scroll = messages.scrollTop;
  $('#chat-title').textContent = c?.title || '모리에게 부탁하기';
  $('#chat-options').hidden = !c;
  messages.innerHTML = !c?.messages.length ? `<div class="chat-welcome"><img src="/assets/mori.svg" alt="모리"><p>내 곁의 작은 비서</p><h2>무엇을 챙겨드릴까요?</h2><span>이야기는 편하게,<br>기억할 일은 모리에게.</span></div><div class="chat-suggestions">${[['car', '주차 위치 기억하기', '지하 3층 B16에 주차했어'], ['note', '떠오른 생각 남기기', '메모해줘: '], ['spark', '내 기능 실행하기', '퇴근 정리 실행해줘']].map(([i, title, t]) => button('chat-example', `${mark(i)}<span>${title}</span>${arrow}`, '', `data-prompt="${esc(t)}"`)).join('')}</div><p class="field-help center">예시를 고른 뒤 내용을 고쳐서 보내세요.</p>` : c.messages.map(m => `<div class="message ${m.role}">${m.role === 'assistant' ? `<span class="assistant-avatar">${icon('spark')}</span>` : ''}<div><p>${esc(m.text)}</p>${m.ref ? button('detail', `${icon('check')}<span><small>부탁한 일의 결과</small><strong>${referenceTitle(m.ref)}</strong></span>${arrow}`, 'message-result', `data-ref="${m.ref}"`) : ''}</div></div>`).join('');
  if (busy.has(ui.chatId)) messages.insertAdjacentHTML('beforeend', `<div class="assistant-progress" role="status"><span class="typing"><i></i><i></i><i></i></span> 내 기능과 요청을 확인하고 있어요</div>`);
  syncComposer(); messages.scrollTop = forceScroll || nearBottom ? messages.scrollHeight : scroll;
}
function referenceTitle(ref) { const [kind, id] = ref.split(':'); return esc(({ parking: '주차 위치 확인', news: '뉴스 브리핑 보기', stock: '관심 주가 보기', note: '저장한 메모 보기', reminder: '카운트다운 보기', event: '저장한 일정 보기', custom: data.customs.find(f => f.id === id)?.title || '내 기능 보기' })[kind] || '결과 보기'); }
async function send(raw) {
  const text = raw.trim(); if (!text || text.length > 4000 || busy.has(ui.chatId)) return;
  const wasNew = !ui.chatId; let c = data.conversations.find(c => c.id === ui.chatId); if (!c) { c = { id: uid(), title: text.slice(0, 26), at: current(), messages: [] }; data.conversations.unshift(c); ui.chatId = c.id; }
  const request = c.awaiting ? `${c.awaiting === 'parking' ? '주차 ' : '알림 '}${text}` : text; c.awaiting = null;
  c.messages.push({ role: 'user', text }); c.at = current(); const id = c.id; busy.add(id); delete data.drafts[id]; if (wasNew) delete data.drafts.new; $('#chat-input').value = ''; save(); renderChat(true);
  await new Promise(resolve => setTimeout(resolve, 650));
  if (!data.conversations.includes(c)) { busy.delete(id); return; }
  const reply = applyRequest(data, request); c.messages.push({ role: 'assistant', ...reply }); c.awaiting = reply.followup; busy.delete(id); save(); render(); if (ui.chatId === id) renderChat();
  if (reply.ref?.startsWith('reminder:') && $('#chat-panel').open && ui.chatId === id && !$('#sheet').open && !$('#voice-panel').open) openDetail(reply.ref);
}
function prompt(text) { closeSheet(); if (!$('#chat-panel').open) openChat(); send(text); }
function openVoice() { if (!$('#chat-panel').open) openChat(); persistDraft(); $('#voice-transcript').value = ui.voiceText; $('#voice-panel').showModal(); voiceStatus('편하게 말해 주세요', '마이크를 눌러 시작하거나 음성 예시를 선택하세요.'); }
function voiceStatus(title, subtitle) { $('#voice-title').textContent = title; $('#voice-subtitle').textContent = subtitle; $('#voice-panel').classList.toggle('listening', voiceListening); $('#record-button').setAttribute('aria-label', voiceListening ? '녹음 중지' : '녹음 시작'); $('#record-button').innerHTML = icon(voiceListening ? 'stop' : 'mic'); }
function stopVoice() { ui.voiceText = $('#voice-transcript').value; if (recognition) { recognition.onend = null; recognition.abort(); recognition = null; } voiceListening = false; }
function recordVoice() {
  if (voiceListening) { recognition?.stop(); voiceListening = false; voiceStatus('이렇게 들었어요', '내용을 확인하고 대화로 이어가세요.'); return; }
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) { voiceStatus('음성 예시로 체험해 보세요', '이 브라우저에서는 음성 인식을 지원하지 않아요.'); return; }
  recognition = new Speech(); recognition.lang = 'ko-KR'; recognition.interimResults = true; recognition.continuous = false;
  recognition.onresult = event => { const text = Array.from(event.results).map(r => r[0].transcript).join(' '); $('#voice-transcript').value = text; };
  recognition.onerror = () => { recognition.onend = null; voiceListening = false; voiceStatus('마이크를 사용할 수 없어요', '권한을 확인하거나 아래 음성 예시로 이어가세요.'); };
  recognition.onend = () => { voiceListening = false; voiceStatus($('#voice-transcript').value.trim() ? '이렇게 들었어요' : '아직 들은 내용이 없어요', '말한 내용을 고치거나 키보드로 이어갈 수 있어요.'); };
  try { recognition.start(); voiceListening = true; voiceStatus('듣고 있어요', '서두르지 않아도 괜찮아요.'); } catch { voiceStatus('음성을 시작하지 못했어요', '음성 예시로도 모든 흐름을 체험할 수 있어요.'); }
}
function documentSheet() { openSheet('생각이 담긴 파일도 가볍게', `<div class="form-intro">${mark('file', 'blue')}<h3>파일 속 생각도 한곳에.</h3><p>텍스트를 불러와 정리하고, 파일로 받아보세요.</p></div><label class="upload-zone">${icon('upload')}<strong>텍스트 파일 선택</strong><span>TXT · MD · CSV, 최대 200KB</span><input id="document-upload" type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv"></label>${button('sample-document', '예시 회의 메모로 체험하기 ' + icon('arrow'), 'secondary-button full')}<p class="field-help">이 기기에서만 파일을 읽어요. Word·Excel·PDF 변환과 실제 AI 요약은 연결 전이에요.</p>`); }
function saveDocument(name, content) { const lines = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean); const summary = `정리한 메모\n\n${lines.slice(0, 12).map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\n원문\n${content}`; const d = { id: uid(), source: content, highlights: lines.slice(0, 12), title: name.replace(/\.[^.]+$/, '') + ' 정리', filename: name.replace(/\.[^.]+$/, '') + '-정리.txt', summary, at: current() }; data.documents.unshift(d); save(); render(); openDetail(`document:${d.id}`); }
async function loadAccount() {
  const epoch = ++ui.accountEpoch;
  try {
    const session = await api('/session'); if (epoch !== ui.accountEpoch) return false;
    ui.liveUser = session.user; ui.accountState = session.user ? 'signed-in' : 'guest';
    if (session.user) {
      const prefs = await api('/settings'); if (epoch !== ui.accountEpoch) return false;
      ui.settingsRevision = prefs.revision; selectedTheme = prefs.theme; applyTheme();
    }
    render(); return true;
  } catch {
    if (epoch !== ui.accountEpoch) return false;
    ui.accountState = 'error'; ui.liveUser = null; render(); return false;
  }
}
function profileDetails() {
  const user = ui.liveUser;
  openSheet('사용자 정보', `<div class="detail-title">${mark('user')}<h2>${esc(user.display_name)}님</h2><p>내 곁의 작은 비서, 모리</p></div><dl class="account-facts"><div><dt>이름</dt><dd>${esc(user.display_name)}</dd></div><div><dt>연결된 계정</dt><dd>${user.providers.map(p => p === 'naver' ? '네이버' : '카카오').join(' · ')}</dd></div><div><dt>이용 요금제</dt><dd>${user.tier === 'pro' ? 'Pro' : 'Free'}</dd></div>${user.created_at ? `<div><dt>가입일</dt><dd>${new Date(user.created_at).toLocaleDateString('ko-KR')}</dd></div>` : ''}</dl>${button('edit-profile', '사용자 정보 수정', 'primary-button full')}`);
}
async function accountSheet() {
  openSheet('내 계정', '<p class="sheet-description" role="status">계정 정보를 확인하고 있어요.</p>');
  const loaded = await loadAccount(); if (!$('#sheet').open) return;
  if (!loaded) return openSheet('내 계정', empty('cloud', '연결을 확인해 주세요', '계정 정보를 불러오지 못했어요.', button('account', '다시 시도', 'primary-button')));
  if (ui.liveUser) return profileDetails();
  const epoch = ui.accountEpoch;
  try {
    const providers = await api('/providers'); if (epoch !== ui.accountEpoch || !$('#sheet').open) return;
    openSheet('로그인', `<div class="form-intro">${mark('user')}<h3>나의 모리를 시작해요</h3><p>사용하던 계정으로 간편하게 로그인하세요.</p></div><div class="social-login-options">${providers.map(p => button('login', `${p.provider === 'naver' ? '네이버' : '카카오'}로 계속하기`, `social-login ${p.provider}`, `data-provider="${p.provider}" ${p.enabled ? '' : 'disabled'}`)).join('')}</div>${providers.some(p => !p.enabled) ? '<p class="field-help center">사용할 수 없는 로그인 연결은 준비 중이에요.</p>' : ''}`);
  } catch { if (epoch === ui.accountEpoch && $('#sheet').open) openSheet('로그인', empty('cloud', '로그인 정보를 불러오지 못했어요', '잠시 후 다시 시도해 주세요.', button('account', '다시 시도', 'primary-button'))); }
}
function themeSheet() {
  openSheet('테마', `<p class="sheet-description">눈에 편한 화면을 골라주세요.</p><form id="theme-form"><fieldset class="theme-options"><legend class="sr-only">화면 테마</legend>${[['system', '시스템 설정', '기기 설정에 맞춰 자동으로'], ['light', '라이트', '밝고 산뜻한 화면'], ['dark', '다크', '차분하고 편안한 화면']].map(([value, label, copy]) => `<label class="theme-option"><input type="radio" name="theme" value="${value}" ${selectedTheme === value ? 'checked' : ''}><span class="theme-preview ${value}" aria-hidden="true"><i></i><i></i></span><span><strong>${label}</strong><small>${copy}</small></span>${icon('check')}</label>`).join('')}</fieldset><p class="form-error" role="alert"></p><button type="submit" class="primary-button full">적용하기</button><p class="field-help center">${ui.liveUser ? '내 계정에 저장해요.' : '로그인 전에는 이 기기에 적용해요.'}</p></form>`);
}
async function subscriptionSheet() {
  openSheet('요금제 및 결제', '<p class="sheet-description" role="status">요금제를 확인하고 있어요.</p>');
  const epoch = ui.accountEpoch;
  try {
    const [plans, subscription] = await Promise.all([api('/plans'), ui.liveUser ? api('/subscription') : Promise.resolve(null)]);
    if (epoch !== ui.accountEpoch || !$('#sheet').open) return;
    openSheet('요금제 및 결제', `<div class="form-intro">${mark('spark', 'purple')}<h3>나에게 맞는 모리</h3><p>${esc(subscription?.message || '무료로 시작하고, 필요한 순간에 더 가까이.')}</p></div><div class="account-plan-options">${plans.map(plan => `<article class="account-plan-option ${subscription?.plan === plan.id ? 'selected' : ''}"><header><span>${plan.name}</span>${subscription?.plan === plan.id ? tag('이용 중') : ''}</header><h3>${plan.amount === null ? '준비 중' : plan.amount === 0 ? '무료' : plan.amount.toLocaleString('ko-KR') + '원'}</h3><p>${esc(plan.description)}</p>${plan.id === 'free' ? button(ui.liveUser ? 'close' : 'account', subscription?.plan === 'pro' ? '기본 요금제' : ui.liveUser ? '무료로 계속 이용하기' : '무료로 시작하기', 'secondary-button full', subscription?.plan === 'pro' ? 'disabled' : '') : '<button type="button" class="primary-button full" disabled>Pro 결제 준비 중</button>'}</article>`).join('')}</div><div class="subscription-cancel"><strong>Pro 구독 해지</strong><p>${subscription?.access_source === 'admin_approval' ? '관리자 승인 이용권은 결제 구독이 아니에요.' : '현재 해지할 결제 구독이 없어요.'}</p><button type="button" class="secondary-button full" disabled>결제 취소 · 구독 해지</button></div><p class="field-help">Pro 가격과 결제 서비스는 준비 중이에요. 결제 연결 전에는 요금이 청구되지 않아요.</p>`);
  } catch { if (epoch === ui.accountEpoch && $('#sheet').open) openSheet('요금제 및 결제', empty('cloud', '요금제를 불러오지 못했어요', '잠시 후 다시 시도해 주세요.', button('license', '다시 시도', 'primary-button'))); }
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]'); if (nav) return go(nav.dataset.view);
  const el = event.target.closest('[data-action]'); if (!el || el.disabled) return; const a = el.dataset.action, id = el.dataset.id;
  if (a.startsWith('go-')) { closeSheet(); return go(a.slice(3)); }
  if (a === 'close') return closeSheet();
  if (a === 'toggle-window') return toggleWindowMenu();
  if (a === 'set-window') {
    const hours = Number(el.dataset.hours); if (!DASHBOARD_WINDOWS.some(w => w.hours === hours)) return;
    ui.horizon = hours; ui.windowMenu = false; ui.resetRails = true; render();
    return $('#dashboard-window-trigger')?.focus({ preventScroll: true });
  }
  if (a === 'shelf-page') {
    const rail = document.getElementById(el.dataset.rail); if (!rail) return;
    const step = rail.firstElementChild.getBoundingClientRect().width + 14;
    rail.scrollBy({ left: Number(el.dataset.direction) * Math.max(1, Math.floor(rail.clientWidth / step)) * step, behavior: data.profile.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  if (a === 'records' || a === 'record-filter') return recordsSheet(el.dataset.value || 'all');
  if (a === 'clear-search') { ui.search = ''; render(); return $('#conversation-search').focus(); }
  if (a === 'chat-options') return conversationOptions();
  if (a === 'pin-conversation') { const c = data.conversations.find(c => c.id === id); c.pinned = !c.pinned; save(); closeSheet(); render(); return toast(c.pinned ? '대화를 목록 위에 고정했어요.' : '고정을 해제했어요.'); }
  if (a === 'undo-note') { if (!deletedNote) return; data.notes.push(deletedNote); deletedNote = null; save(); render(); return toast('메모를 다시 가져왔어요.'); }
  if (a === 'detail') return openDetail(el.dataset.ref);
  if (a === 'carousel') return $('#time-carousel')?.children[Number(el.dataset.index)]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  if (a === 'guide') return guide();
  if (a === 'day-preview') return dayPreview();
  if (a === 'set-clock') { setClock(data, Number(el.dataset.hour), Number(el.dataset.minute)); tickScheduled(data); save(); closeSheet(); go('dashboard'); render(); return toast('체험 시간을 바꿨어요. 지금 필요한 카드를 살펴보세요.'); }
  if (a === 'new-chat') return openChat();
  if (a === 'open-conversation') return openChat(id);
  if (a === 'close-chat') { $('#chat-panel').close(); return render(); }
  if (a === 'prompt') return prompt(el.dataset.prompt);
  if (a === 'chat-example') { $('#chat-input').value = el.dataset.prompt; persistDraft(); syncComposer(); return $('#chat-input').focus(); }
  if (a === 'voice') { if (!$('#chat-panel').open) openChat(); return openVoice(); }
  if (a === 'voice-close') { stopVoice(); return $('#voice-panel').close(); }
  if (a === 'record') return recordVoice();
  if (a === 'voice-example') { stopVoice(); $('#voice-transcript').value = el.dataset.text; return voiceStatus('이렇게 말했어요', '음성 입력 예시예요. 내용을 고쳐도 좋아요.'); }
  if (a === 'voice-send') { const text = $('#voice-transcript').value.trim(); if (!text) return toast('먼저 말하거나 음성 예시를 선택해 주세요.'); if ([ $('#chat-input').value.trim(), text ].filter(Boolean).join('\n').length > 4000) return toast('기존 메시지와 합쳐 4,000자까지 담을 수 있어요. 내용을 조금 줄여주세요.'); stopVoice(); $('#voice-panel').close(); ui.voiceText = ''; $('#voice-transcript').value = ''; const input = $('#chat-input'); input.value = [input.value.trim(), text].filter(Boolean).join('\n'); persistDraft(); syncComposer(); input.focus(); return; }
  if (a === 'edit-parking') return parkingForm();
  if (a === 'toggle-parking') { data.parking.enabled = data.parking.enabled === false; save(); render(); return openDetail('parking'); }
  if (a === 'new-note' || a === 'edit-note') return noteForm(id);
  if (a === 'delete-note') { const n = data.notes.find(n => n.id === id); deletedNote = n; data.notes = data.notes.filter(n => n.id !== id); save(); closeSheet(); render(); return toast(`‘${n.title}’ 메모를 삭제했어요.`, 'undo-note'); }
  if (a === 'new-event' || a === 'edit-event') return eventForm(id, el.dataset.date || ui.date, el.dataset.time || '14:00');
  if (a === 'delete-event') { deletedEvent = data.events.find(event => event.id === id); data.events = data.events.filter(event => event.id !== id); save(); closeSheet(); render(); return toast('약속을 삭제했어요.', 'undo-event'); }
  if (a === 'undo-event') { if (!deletedEvent) return; data.events.push(deletedEvent); deletedEvent = null; save(); render(); return toast('약속을 다시 가져왔어요.'); }
  if (a === 'select-date') { ui.date = el.dataset.date; ui.month = dayDate(ui.date); render(); document.querySelector(`[data-date="${ui.date}"][aria-pressed]`)?.focus({ preventScroll: true }); return; }
  if (a === 'calendar-mode') { ui.calendar = el.dataset.value; render(); document.querySelector(`[data-action=calendar-mode][data-value=${ui.calendar}]`)?.focus({ preventScroll: true }); return; }
  if (a === 'calendar-today') { ui.date = dateKey(current()); ui.month = new Date(current()); ui.month.setDate(1); return render(); }
  if (a === 'month-prev' || a === 'month-next') { ui.date = moveDate(ui.date, a === 'month-prev' ? -1 : 1, ui.calendar); ui.month = dayDate(ui.date); render(); document.querySelector(`[data-action=${a}]`)?.focus({ preventScroll: true }); return; }
  if (a === 'calendar-jump') return calendarJump();
  if (a === 'jump-year') return calendarJump(ui.jumpYear + Number(el.dataset.delta));
  if (a === 'jump-month') { const selected = dayDate(ui.date); ui.date = moveDate(ui.date, (ui.jumpYear - selected.getFullYear()) * 12 + Number(el.dataset.month) - selected.getMonth(), 'month'); ui.month = dayDate(ui.date); closeSheet(); return render(); }
  if (a === 'feature-filter') { ui.filter = el.dataset.value; render(); return document.querySelector(`[data-action=feature-filter][data-value=${ui.filter}]`)?.focus({ preventScroll: true }); }
  if (a === 'new-custom' || a === 'edit-custom') return customForm(id);
  if (a === 'custom-example') { const form = $('#custom-form'); form.elements.title.value = '하루 마무리'; form.elements.work.value = '오늘 저장한 메모를 모아서 할 일을 정리하기'; form.elements.description.value = '하루의 생각을 내일의 한 걸음으로'; form.elements.time.value = '19:00'; setChoice(form.querySelector('[name=repeat]').closest('[data-choice]'), '평일'); updateCustomPreview(); return; }
  if (a === 'toggle-custom') { const f = data.customs.find(f => f.id === id); if (!f.work) return toast('편집에서 어떤 일을 할지 먼저 추가해 주세요.'); f.active = !f.active; save(); render(); return openDetail(`custom:${id}`); }
  if (a === 'run-custom') { const f = runCustom(data, id); if (!f) return; save(); render(); openDetail(`custom:${id}`); return toast('저장된 메모로 실행 결과를 만들었어요.'); }
  if (a === 'check-item') { const f = data.customs.find(f => f.id === id); f.result.items[Number(el.dataset.index)].done = !f.result.items[Number(el.dataset.index)].done; save(); return openDetail(`custom:${id}`); }
  if (a === 'preset-reminder') return prompt(`${el.dataset.minutes}분 뒤에 알림 줘`);
  if (a === 'timer-extend') { const r = data.reminders.find(r => r.id === id); r.target = Math.max(current(), r.target) + 300000; r.cancelled = false; r.notified = false; save(); render(); return openDetail(`reminder:${id}`); }
  if (a === 'timer-cancel') { const r = data.reminders.find(r => r.id === id); if (r.cancelled) { r.target = current() + 1800000; r.created = current(); r.notified = false; } r.cancelled = !r.cancelled; save(); render(); return openDetail(`reminder:${id}`); }
  if (a === 'timer-finish') { const r = data.reminders.find(r => r.id === id); if (r.cancelled) return toast('취소된 알림이에요. 다시 시작한 뒤 체험해 주세요.'); data.clock = { real: Date.now(), virtual: r.target }; save(); render(); return openDetail(`reminder:${id}`); }
  if (a === 'news-state') { data.news.readyAt = null; data.news.status = el.dataset.value; save(); render(); return openDetail('news'); }
  if (a === 'refresh-news') { data.news.readyAt = null; data.news.status = 'loading'; const generation = ++data.news.generation; save(); render(); openDetail('news'); setTimeout(() => { if (generation !== data.news.generation) return; data.news.status = 'ready'; data.news.at = current(); save(); render(); if (ui.detail === 'news' && $('#sheet').open) openDetail('news'); }, 1700); return; }
  if (a === 'article') { const index = Number(el.dataset.index); return openSheet('브리핑 예시', `<div class="detail-title">${tag('실제 뉴스가 아닌 화면 예시', 'blue')}<h2>${articleTitles[index]}</h2><p>모리 테크 레터 · 예시 출처</p></div><div class="note-body">일상에서 반복하는 작은 일을 비서에게 맡겨보세요.\n\n중요한 정보는 짧게 요약하고, 다시 확인할 수 있는 출처와 기준 시각을 함께 보여주는 화면을 체험하고 있어요.\n\n실제 뉴스 수집 결과는 서버 연결 후 이 자리에 표시돼요.</div>${button('detail', '브리핑으로 돌아가기', 'secondary-button full', 'data-ref="news"')}`); }
  if (a === 'news-settings') return openSheet('나만의 뉴스 설정', `<form id="news-form">${field('관심 주제', 'topic', data.news.topic, 'text', 'required maxlength="60"')}${field('매일 수집할 시간', 'time', data.news.time, 'time', 'required')}<p class="field-help">설정 시각은 수집을 시작하는 시간이에요.</p><button class="primary-button" type="submit">설정 저장</button></form>`);
  if (a === 'stock-settings') return openSheet('관심 종목 바꾸기', `<div class="stock-options">${['삼성전자', '코스피', '애플'].map(name => button('select-stock', `${mark('chart', 'rose')}<strong>${name}</strong>${arrow}`, 'setting-row', `data-value="${name}"`)).join('')}</div><p class="field-help">가격은 화면 체험용 예시로 표시돼요.</p>`);
  if (a === 'select-stock') { data.stock.symbol = el.dataset.value; save(); render(); return openDetail('stock'); }
  if (a === 'chart-range') { ui.chart = el.dataset.value; return openDetail('stock'); }
  if (a === 'edit-profile') {
    if (!ui.liveUser) return accountSheet();
    return openSheet('사용자 정보 수정', `<form id="profile-form">${field('이름', 'name', ui.liveUser.display_name, 'text', 'required maxlength="80"')}<p class="field-help">모리에서 사용할 이름이에요. 연결된 소셜 계정은 바뀌지 않아요.</p><p class="form-error" role="alert"></p><button class="primary-button full" type="submit">저장하기</button></form>`);
  }
  if (a === 'theme') return themeSheet();
  if (a === 'license') return subscriptionSheet();
  if (a === 'document') return documentSheet();
  if (a === 'sample-document') return saveDocument('모리 회의 메모.txt', '모리 화면 회의\n대시보드는 지금 필요한 정보부터 보여주기\n채팅과 음성을 자연스럽게 이어주기\n기본 기능과 내 기능의 화면을 통일하기\n다음 회의 전 주차와 알림 시나리오 확인하기');
  if (a === 'download') { const d = data.documents.find(d => d.id === id), url = URL.createObjectURL(new Blob([d.summary], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = d.filename; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); return toast('파일 다운로드를 요청했어요.'); }
  if (a === 'account') return accountSheet();
  if (a === 'live-parking-form') return parkingForm(true);
  if (a === 'login') { el.disabled = true; try { const r = await api('/auth/start', { method: 'POST', data: { provider: el.dataset.provider } }); location.assign(r.url); } catch (err) { toast(err.message); el.disabled = false; } }
  if (a === 'logout') { ++ui.accountEpoch; try { await api('/logout', { method: 'POST', data: {} }); } catch (err) { return toast(err.message); } ui.liveUser = null; ui.accountState = 'guest'; ui.settingsRevision = 0; ui.liveParking = null; liveAttempt = null; closeSheet(); render(); toast('로그아웃했어요.'); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, v = Object.fromEntries(new FormData(form)), id = form.dataset.id;
  if (form.id === 'conversation-form') { const c = data.conversations.find(c => c.id === id); if (!c || !v.title.trim()) return; c.title = v.title.trim(); save(); closeSheet(); render(); renderChat(); return toast('대화 이름을 바꿨어요.'); }
  if (form.id === 'chat-form') return send(v.message || '');
  if (form.id === 'parking-form') { const mins = Math.max(0, minuteOf(data.profile.commute) - (data.profile.parkingLead ?? 30)); data.parking = { floor: v.floor.trim(), spot: v.spot.trim(), at: current(), show: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, enabled: true }; save(); render(); openDetail('parking'); return toast('새 주차 위치를 기억했어요.'); }
  if (form.id === 'note-form') { if (!v.title.trim() && !v.body.trim()) return toast('제목이나 내용을 한 줄 남겨주세요.'); const n = { id: id || uid(), title: v.title.trim() || v.body.slice(0, 28), body: v.body.trim(), at: current() }; const index = data.notes.findIndex(n => n.id === id); if (index >= 0) data.notes[index] = n; else data.notes.unshift(n); save(); render(); openDetail(`note:${n.id}`); return toast('메모를 저장했어요.'); }
  if (form.id === 'event-form') { const e = { id: id || uid(), title: v.title.trim(), date: v.date, time: v.time, place: v.place.trim(), color: v.color, duration: Number(v.duration), memo: v.memo.trim() }; if (!e.title) return; const index = data.events.findIndex(e => e.id === id); if (index >= 0) data.events[index] = e; else data.events.push(e); ui.date = e.date; ui.month = new Date(e.date + 'T12:00:00'); ui.month.setDate(1); save(); render(); openDetail(`event:${e.id}`); return toast('약속을 저장했어요.'); }
  if (form.id === 'custom-form') { const existing = data.customs.find(f => f.id === id); const f = { id: id || uid(), title: v.title.trim() || v.work.trim().slice(0, 24) || '새로운 내 기능', work: v.work.trim(), description: v.description.trim(), time: v.time, repeat: v.time ? (v.repeat === '필요할 때' ? '매일' : v.repeat) : '필요할 때', icon: customPreview(v).icon, active: Boolean(v.work.trim()) && (existing ? existing.active : true), content: v.content.trim(), version: (existing?.version || 0) + 1, runs: existing?.runs || 0, result: existing?.result || null }; if (existing) Object.assign(existing, f); else data.customs.push(f); save(); render(); openDetail(`custom:${f.id}`); return toast(f.work ? '내 기능으로 저장했어요.' : '기능 초안을 저장했어요.'); }
  if (form.id === 'news-form') { data.news.topic = v.topic.trim(); data.news.time = v.time; save(); render(); openDetail('news'); return toast('브리핑 설정을 저장했어요.'); }
  if (form.id === 'profile-form' || form.id === 'theme-form') {
    const submit = form.querySelector('[type=submit]'); if (submit.disabled) return;
    const owner = ui.liveUser?.id; const epoch = ui.accountEpoch; submit.disabled = true;
    try {
      if (form.id === 'profile-form') {
        if (!owner) return accountSheet();
        const profile = await api('/profile', {method: 'PATCH', data: {display_name: v.name.trim(), revision: ui.liveUser.revision}});
        if (epoch !== ui.accountEpoch) return; ui.liveUser = profile;
      } else {
        if (owner) { const prefs = await api('/settings', {method: 'PUT', data: {theme: v.theme, revision: ui.settingsRevision}}); if (epoch !== ui.accountEpoch) return; ui.settingsRevision = prefs.revision; }
        selectedTheme = v.theme; try { localStorage.setItem('mori.theme.v1', selectedTheme); } catch { /* Applied for this session. */ } applyTheme();
      }
      closeSheet(); render(); toast(form.id === 'profile-form' ? '사용자 정보를 수정했어요.' : '테마를 적용했어요.');
    } catch (err) {
      if (err.status === 409) await loadAccount();
      if (form.isConnected) form.querySelector('.form-error').textContent = err.status === 409 ? '다른 곳에서 변경됐어요. 최신 정보를 불러왔으니 내용을 확인하고 다시 저장해 주세요.' : err.message;
    } finally { submit.disabled = false; }
    return;
  }
  if (form.id === 'live-parking') { const owner = ui.liveUser?.id; if (!owner) return accountSheet(); const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { liveAttempt = parkingAttempt(liveAttempt, { floor: v.floor, spot: v.spot }); const record = await api('/parking', { method: 'POST', data: liveAttempt.payload, key: liveAttempt.key }); if (owner !== ui.liveUser?.id) return; ui.liveParking = record; liveAttempt = null; closeSheet(); toast('실제 계정에 주차 위치를 저장했어요.'); } catch (err) { form.querySelector('.form-error').textContent = err.message; } finally { submit.disabled = false; } }
});
document.addEventListener('input', event => { if (event.target.id === 'conversation-search') { const pos = event.target.selectionStart; ui.search = event.target.value; render(); const input = $('#conversation-search'); input.focus(); try { input.setSelectionRange(pos, pos); } catch { /* search input may not support selection */ } } });
document.addEventListener('input', event => { if (event.target.closest('#event-form')) updateEventPreview(); });
document.addEventListener('change', event => { if (event.target.closest('#event-form')) updateEventPreview(); });
document.addEventListener('change', async event => { if (event.target.id !== 'document-upload' || fileBusy) return; const file = event.target.files?.[0]; if (!file) return; if (!/\.(txt|md|csv)$/i.test(file.name) || file.size > 204800) return toast('200KB 이하의 TXT, MD, CSV 파일을 선택해 주세요.'); fileBusy = true; try { saveDocument(file.name, await file.text()); } catch { toast('파일을 읽지 못했어요. 다른 텍스트 파일을 선택해 주세요.'); } finally { fileBusy = false; } });
document.addEventListener('click', event => { if (ui.windowMenu && !event.target.closest('.time-window-picker')) closeWindowMenu(); });
document.addEventListener('focusin', event => { if (ui.windowMenu && !event.target.closest('.time-window-picker')) closeWindowMenu(); });
document.addEventListener('keydown', event => {
  if (ui.windowMenu && event.key === 'Escape') { event.preventDefault(); closeWindowMenu(true); return; }
  if (event.target.id === 'dashboard-window-trigger' && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (!ui.windowMenu) toggleWindowMenu(); return; }
  if (event.target.closest('#dashboard-window-menu') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const options = [...$('#dashboard-window-menu').querySelectorAll('button')], index = options.indexOf(event.target);
    options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
  }
  const rail = event.target.closest('[data-forecast-rail]');
  if (rail && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const cards = [...rail.children], index = cards.indexOf(event.target.closest('.forecast-card'));
    const next = cards[event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : Math.max(0, Math.min(cards.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))];
    next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }
});
document.addEventListener('keydown', event => {
  const cell = event.target.closest('.calendar-grid [data-date]');
  if (!cell) return;
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -dayDate(ui.date).getDay(), End: 6 - dayDate(ui.date).getDay() };
  if (!(event.key in offsets) && !['PageUp', 'PageDown'].includes(event.key)) return;
  event.preventDefault();
  ui.date = event.key in offsets ? moveDate(ui.date, offsets[event.key]) : moveDate(ui.date, event.key === 'PageUp' ? -1 : 1, 'month');
  ui.month = dayDate(ui.date); render(); document.querySelector('.calendar-grid [aria-pressed=true]')?.focus({ preventScroll: true });
});
document.addEventListener('keydown', event => { if (event.target.id === 'chat-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); } });
document.addEventListener('input', event => { if (event.target.id === 'chat-input') { persistDraft(); syncComposer(); } if (event.target.closest('#custom-form')) updateCustomPreview(); });
document.addEventListener('change', event => { if (event.target.closest('#custom-form')) updateCustomPreview(); });
$('#chat-panel').addEventListener('close', () => { persistDraft(); render(); });
$('#voice-panel').addEventListener('close', stopVoice);
$('#sheet').addEventListener('close', () => { if (!$('#sheet').open) ui.detail = null; });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (ui.windowMenu) positionWindowMenu(); });
let lastMinute = '';
setInterval(() => {
  if (tickScheduled(data)) { save(); render(); if (ui.detail && $('#sheet').open) openDetail(ui.detail); }
  document.querySelectorAll('[data-countdown]').forEach(el => { const r = data.reminders.find(r => r.id === el.dataset.countdown); if (r) { el.textContent = r.cancelled ? '중지됨' : remaining(r.target); const ring = el.closest('.timer-ring'); if (ring) { const fraction = Math.max(0, Math.min(1, (r.target - current()) / Math.max(1, r.target - r.created))); ring.querySelector('.timer-progress').setAttribute('stroke-dashoffset', String(679 * (1 - fraction))); ring.querySelector('small').textContent = r.cancelled ? '다시 시작할 수 있어요' : current() >= r.target ? '목표 시각이 되었어요' : '남은 시간'; } } });
  data.reminders.filter(r => !r.cancelled && !r.notified && r.target <= current()).forEach(r => { r.notified = true; save(); if (data.profile.notify) toast(`${r.title} · 목표 시각이 되었어요.`); });
  const minute = Math.floor(current() / 60000); if (minute !== lastMinute) { lastMinute = minute; if (ui.view === 'dashboard' && !ui.windowMenu && !document.querySelector('dialog[open]')) render(); }
}, 1000);
tickScheduled(data); save(); route();
const login = new URLSearchParams(location.search).get('login'); if (login) { history.replaceState(null, '', location.pathname + location.hash); toast(login === 'success' ? '계정을 연결했어요.' : '로그인을 완료하지 못했어요.'); accountSheet(); } else { loadAccount(); }
