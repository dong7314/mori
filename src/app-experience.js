import { createPresentations } from './presentation.mjs';
import { sheetLayout, sheetPresentation } from './sheet-layout.mjs';
import { captureControl, resolveControl, isAvailableControl } from './navigation-focus.mjs';
import { createVoiceSession } from './voice-session.mjs';
import { createVoicePreview } from './voice-preview.mjs';
import { installOverlayScrollbars } from './overlay-scrollbars.mjs';
import { createAccountLoader } from './account-session.mjs';
import { createFormDrafts } from './form-drafts.mjs';
import { showFormError, clearFormError } from './form-feedback.mjs';
import { VERSION, BUILTINS, seed, uid, esc, dateKey, nowOf, setClock, dashboardCards, applyRequest, runCustom, minuteOf, tickScheduled } from './experience.mjs';
import { DASHBOARD_WINDOWS, dashboardTimeline } from './dashboard-timeline.mjs';
import { recordsOf, conversationGroups, customPreview } from './experience-library.mjs';
import { api } from './api.mjs';
import { parkingConfig, parkingOptions, parkingDescription, parkingPurpose } from './parking-display.mjs';
import { DOCUMENT_MAX_BYTES, documentRecord, formatBytes, storeOriginal, readOriginal } from './document-store.mjs';
import { choiceField, installChoices, setChoice } from './choice-field.mjs';
import { EVENT_KINDS, eventKind, dayDate, eventsOn, moveDate, calendarDates, eventDuration, eventEnd, eventDaySpan, timelineHours, hasOverlap } from './calendar-model.mjs';
import { parkingAttempt, parkingLabel } from './ui-model.mjs';
import { createMotion } from './motion.mjs';
import { cardVisual, featureArt, stockCandlestickChart } from './card-visuals.mjs';

const $ = s => document.querySelector(s);
// Presentations owns modal lifecycles; motion owns main content, tabs and messages.
const motion = createMotion($('#main'));
installOverlayScrollbars();
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const button = (action, content, cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${content}</button>`;
const arrow = icon('chevron');
const mark = (name, color = 'green') => `<span class="feature-icon ${color}">${icon(name)}</span>`;
const BASE_KEY = 'mori.experience.v6';
const previewParam = new URLSearchParams(location.search).get('preview');
const previewId = ['mobile', 'tablet'].includes(previewParam) ? previewParam : null;
const developerPreview = Boolean(previewId && new URLSearchParams(location.search).get('tools') === '1');
// Device previews start from the app's records but never overwrite one another or the app.
const KEY = previewId ? `${BASE_KEY}.preview.${previewId}` : BASE_KEY;
const THEME_KEY = previewId ? `mori.theme.v1.preview.${previewId}` : 'mori.theme.v1';
let data;
try { data = JSON.parse(localStorage.getItem(KEY) ?? (previewId ? localStorage.getItem(BASE_KEY) : null)); if (data?.version !== VERSION || !Array.isArray(data.customs) || !Array.isArray(data.reminders)) data = null; } catch { data = null; }
data ||= seed();
data.drafts ||= {};
// Old demo preferences no longer control account settings or dashboard visibility.
data.profile.recent = true;
data.profile.notify = true;
data.profile.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let selectedTheme = 'system';
try { const stored = localStorage.getItem(THEME_KEY) ?? (previewId ? localStorage.getItem('mori.theme.v1') : null); if (['system', 'light', 'dark'].includes(stored)) selectedTheme = stored; } catch { /* Storage is optional. */ }
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = selectedTheme === 'dark' || selectedTheme === 'system' && systemTheme.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#171c1b' : '#f5f6f3';
}
applyTheme(); systemTheme.addEventListener('change', applyTheme);
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
  data.profile.reduced = event.matches;
  if (event.matches) {
    voiceLayoutAnimation?.cancel();
    presentations.settle($('#chat-panel'));
  }
  render();
});
const ui = { view: 'dashboard', horizon: 0, windowMenu: false, resetRails: false, date: dateKey(nowOf(data)), month: new Date(nowOf(data)), calendar: 'month', filter: 'all', chatId: null, search: '', chart: '1일', detail: null, recordFilter: 'all', recordSearch: '', liveUser: null, liveParking: null, sheetEpoch: 0, accountState: 'checking', settingsRevision: 0, settingsState: 'checking' };
ui.month.setDate(1);
installChoices(document, { disclose: (element, expanded) => motion.disclosure(element, expanded) });
let toastTimer, recognition, liveAttempt = null, fileBusy = false, deletedEvent = null, deletedNote = null;
const busy = new Set();
const presentations = createPresentations({ reducedMotion: () => data.profile.reduced });
const formDrafts = createFormDrafts();
const draftForm = () => $('#sheet-content form:is(#note-form, #event-form, #custom-form)');
const loadAccount = createAccountLoader({ request: api, state: ui, onSettings: prefs => { selectedTheme = prefs.theme; applyTheme(); }, onChange: () => render() });
let presentationSource = null, detailRequest = null, sheetCurrent = null, sheetTrail = [], returningSheet = false, sheetOrigin = null, sheetCardOrigin = null;
const voiceSession = createVoiceSession();
let voiceExpanded = false, voiceFallbackEdited = false, voiceEndTimer, voiceLayoutAnimation;
let voicePreviewing = false;
const voiceDemo = createVoicePreview({ session: voiceSession, onChange: renderVoice, onFinish: settleVoice, isOpen: () => voiceExpanded && $('#chat-panel').open && !$('#chat-panel').dataset.closing });
// The parent preview page exposes this as a labelled UI control. Normal app
// windows and messages from other origins cannot start a rehearsal.
if (previewId && window.parent !== window) window.addEventListener('message', async event => {
  if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'mori:preview-voice') return;
  if ($('#sheet').open) await closeSheet();
  openChat(); await openVoice();
  voicePreviewing = true; voiceDemo.start($('#chat-input').value);
});
// Capture the control before delegated handlers replace it. Never retain a trigger
// across async work: background refreshes must not create navigation steps.
document.addEventListener('click', event => {
  presentationSource = event.target.closest('button');
  const source = presentationSource;
  setTimeout(() => { if (presentationSource === source) presentationSource = null; }, 0);
}, true);
let railObserver, carouselObserver;
const pageScroll = new Map();
const time = value => new Date(value).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dateLabel = value => new Date(value).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
const shortDate = value => new Date(value).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
const clockLabel = value => { const [h, m] = value.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(m).padStart(2, '0')}`; };
const current = () => nowOf(data);
const todayEvents = () => data.events.filter(e => e.date === dateKey(current())).sort((a, b) => a.time.localeCompare(b.time));
function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); return true; } catch { toast('저장 공간이 부족해요. 문서나 오래된 기록을 정리해 주세요.'); return false; } }
function moveToast() { const host = presentations.topDialog() || document.body; if ($('#toast').parentElement !== host) host.append($('#toast')); }
function toast(message, undoAction = '') { moveToast(); clearTimeout(toastTimer); $('#toast').innerHTML = `<span>${esc(message)}</span>${undoAction ? button(undoAction, '되돌리기', '') : ''}`; $('#toast').classList.toggle('has-action', Boolean(undoAction)); $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), undoAction ? 9000 : 3400); }
function heading(title, subtitle = '', trailing = '') { return `<header class="page-heading"><div>${subtitle ? `<p class="eyebrow">${subtitle}</p>` : ''}<h1>${title}</h1></div>${trailing}</header>`; }
function section(title, trailing = '') { return `<div class="section-heading"><h2>${title}</h2>${trailing}</div>`; }
function dashboardCollection(title, viewAction, viewLabel, content, cls = 'surface') {
  const heading = `<div class="section-heading dashboard-section-heading"><h2>${esc(title)}</h2>${button(viewAction, `<span>${esc(viewLabel)}</span>${arrow}`, 'section-view-button', `aria-label="${esc(title)}: ${esc(viewLabel)}"`)}</div>`;
  return `${heading}<div class="${cls} collection-surface">${content}</div>`;
}
function empty(iconName, title, copy, action = '') { return `<div class="empty-state">${mark(iconName)}<h3>${title}</h3>${copy ? `<p>${copy}</p>` : ''}${action}</div>`; }
function tag(text, cls = '') { return `<span class="tag ${cls}">${text}</span>`; }
function eventRow(e) { return button('detail', `<span class="event-time">${e.time}</span><span class="event-line ${e.color}"></span><span class="row-content"><strong>${esc(e.title)}</strong><small>${esc(e.place || '나의 일정')}</small></span>${arrow}`, 'event-row', `data-ref="event:${e.id}"`); }
function mapArt() { return `<div class="parking-map" aria-hidden="true"><span class="map-road"></span><span class="map-road vertical"></span><span class="map-label">주차 위치 메모</span><div class="parking-slots"><i></i><i></i><i class="occupied">${icon('car')}</i><i></i></div><span class="map-pin">${esc(data.parking?.spot || 'P')}</span><span class="map-dot"></span><span class="map-tree one"></span><span class="map-tree two"></span></div>`; }
function recordRow(r) { return button('detail', `${mark(r.icon, r.color)}<span class="row-content"><span class="record-kind">${r.label} · ${shortDate(r.at)}</span><strong>${esc(r.title)}</strong><small>${esc(r.excerpt.replace(/\n/g, ' · '))}${r.kind === 'document' && r.size_bytes != null ? ` · ${formatBytes(r.size_bytes)}` : ''}</small></span>${arrow}`, 'record-row', `data-ref="${r.kind}:${r.id}"`); }
function matchingRecords() {
  const query = ui.recordSearch.trim().toLocaleLowerCase('ko-KR');
  return recordsOf(data, ui.recordFilter).filter(r => `${r.title} ${r.excerpt}`.toLocaleLowerCase('ko-KR').includes(query));
}
function recordResults(records) {
  return records.map(recordRow).join('') || empty(ui.recordSearch.trim() ? 'search' : 'note', ui.recordSearch.trim() ? '일치하는 기록이 없어요' : '아직 남긴 기록이 없어요', ui.recordSearch.trim() ? '다른 단어로 다시 찾아보세요.' : '새 메모나 파일을 추가하세요.');
}
function recordsSheet(filter = ui.recordFilter) {
  ui.recordFilter = filter;
  const query = ui.recordSearch.trim().toLocaleLowerCase('ko-KR');
  const records = matchingRecords();
  openSheet('기록 보관함', `<label class="search-box library-search">${icon('search')}<input id="record-search" type="search" aria-label="기록 검색" placeholder="제목 · 메모 내용 · 파일 이름 검색" value="${esc(ui.recordSearch)}"></label><div class="filter-chips" aria-label="기록 종류">${[['all', '전체'], ['note', '메모'], ['document', '문서'], ['custom', '실행 결과']].map(([v, label]) => button('record-filter', label, filter === v ? 'selected' : '', `data-value="${v}" aria-pressed="${filter === v}"`)).join('')}</div><div class="library-count" role="status">${query ? '검색 결과' : '최근 기록'} <strong>${records.length}</strong></div><div class="record-list">${recordResults(records)}</div><div class="detail-actions library-actions">${button('new-note', icon('compose') + ' 새 메모', 'secondary-button')}${button('document', icon('upload') + ' 파일 가져오기', 'secondary-button')}</div>`, 'library-sheet');
}
const latestNote = () => data.notes.reduce((a, b) => !a || new Date(b.at) > new Date(a.at) ? b : a, null);
const nextReminder = () => data.reminders.filter(r => !r.cancelled && r.target > current()).sort((a, b) => a.target - b.target)[0];
function featurePreviewParams(kind, id = '') {
  if (kind === 'parking') return { floor: data.parking?.floor, spot: data.parking?.spot };
  if (kind === 'news') return { topic: data.news.topic, status: data.news.status, articleCount: data.news.status === 'ready' ? articleTitles.length : undefined };
  if (kind === 'stock') return { symbol: data.stock.symbol, isExample: true };
  if (kind === 'note') {
    const latest = latestNote();
    return { count: data.notes.length, title: latest?.title };
  }
  if (kind === 'schedule') {
    const e = id ? data.events.find(e => e.id === id) : todayEvents().find(e => minuteOf(e.time) >= new Date(current()).getHours() * 60 + new Date(current()).getMinutes()) || todayEvents()[0];
    if (!e) return {};
    const date = dayDate(e.date);
    return { month: date.getMonth() + 1, day: date.getDate(), time: e?.time, title: e?.title };
  }
  if (kind === 'reminder') {
    const r = id ? data.reminders.find(r => r.id === id) : nextReminder();
    if (!r) return {};
    const target = new Date(r.target);
    return { time: `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`, remaining: remaining(r.target), fraction: Math.max(0, Math.min(1, (r.target - current()) / Math.max(1, r.target - r.created))), reminderId: r.id };
  }
  return {};
}
function briefCard(ref) {
  const [kind, id] = ref.split(':');
  let label, title, copy, stamp, symbol, color = 'blue', visual = '', actionRef = ref;
  if (kind === 'parking') {
    label = '주차 기억'; symbol = 'car'; color = 'green';
    title = data.parking ? `<span class="parking-floor">${esc(data.parking.floor)}</span><span class="parking-bay">${esc(data.parking.spot)}</span>` : '어디에 주차하셨나요?';
    copy = data.parking ? parkingPurpose(parkingConfig(data.parking, data.profile)) : '층과 자리 번호를 남겨두세요';
    stamp = data.parking ? `${shortDate(data.parking.at)} ${time(data.parking.at)} 저장` : '눌러서 위치 기록';
    visual = cardVisual('parking', featurePreviewParams('parking'));
  } else if (kind === 'news') {
    label = '나의 뉴스 브리핑'; symbol = 'news'; color = 'blue'; title = data.news.status === 'loading' ? '새 소식을 모으고 있어요' : data.news.status === 'failed' ? '브리핑을 다시 준비할까요?' : `${esc(data.news.topic)} 브리핑`;
    copy = data.news.status === 'ready' ? '요약과 출처 확인' : '카드를 눌러 준비 상태를 확인하세요'; stamp = data.news.status === 'ready' ? `${shortDate(data.news.at)} ${time(data.news.at)} · 샘플 브리핑` : data.news.active ? `${clockLabel(data.news.time)} 예약 · 샘플 브리핑` : '자동 수집 꺼짐 · 샘플 브리핑';
    visual = cardVisual('news', featurePreviewParams('news'));
  } else if (kind === 'stock') {
    label = '관심 종목'; symbol = 'chart'; color = 'rose'; title = esc(data.stock.symbol); copy = `<b class="brief-price">${data.stock.symbol === '코스피' ? '2,650.24 pt' : data.stock.symbol === '애플' ? '228.40 USD' : '72,400원'}</b><span class="brief-change"> +1.82%</span>`; stamp = '샘플 시세'; visual = cardVisual('stock', featurePreviewParams('stock'));
  } else if (kind === 'note') {
    const n = latestNote();
    label = '메모'; symbol = 'note'; color = 'amber'; title = esc(n?.title || '메모를 남겨보세요');
    const excerpt = Array.from((n?.body || '').replace(/\s+/g, ' ').trim());
    copy = n ? esc(excerpt.length > 42 ? `${excerpt.slice(0, 41).join('')}…` : excerpt.join('')) : '떠오른 생각을 잊기 전에 적어두세요';
    stamp = n ? `${data.notes.length}개 메모 · ${shortDate(n.at)} 최근 기록` : '눌러서 첫 메모 작성';
    visual = cardVisual('note', featurePreviewParams('note'));
  } else if (kind === 'schedule') {
    const e = todayEvents().find(e => minuteOf(e.time) >= new Date(current()).getHours() * 60 + new Date(current()).getMinutes()) || todayEvents()[0];
    label = '스케줄'; symbol = 'calendar'; color = 'purple'; title = esc(e?.title || '오늘 일정이 없어요'); copy = `${e?.time || '달력에서 새 일정을 추가하세요'}${e?.place ? ' · ' + esc(e.place) : ''}`; stamp = `오늘 ${todayEvents().length}개의 일정`;
    visual = cardVisual('schedule', featurePreviewParams('schedule'));
  } else if (kind === 'reminder') {
    const r = id ? data.reminders.find(r => r.id === id) : nextReminder();
    label = '알림'; symbol = 'bell'; color = 'orange'; title = esc(r?.title || '알림 만들기');
    copy = r ? `<span data-countdown="${esc(r.id)}">${remaining(r.target)}</span> 후 알려드릴게요` : '시간을 골라 알림을 시작하세요';
    stamp = r ? `${time(r.target)} · 기기 내 알림 체험` : '5분 · 15분 · 30분 · 1시간';
    if (r) actionRef = `reminder:${r.id}`;
    visual = cardVisual('reminder', featurePreviewParams('reminder', r?.id));
  } else {
    const f = data.customs.find(f => f.id === id); label = '나의 반복하는 부탁'; symbol = f.icon; color = 'purple'; title = esc(f.title); copy = esc(f.description || f.work); stamp = f.time ? `${clockLabel(f.time)} · ${esc(f.repeat)}` : '필요할 때 실행';
    visual = cardVisual('custom', { icon: f.icon, time: f.time });
  }
  return button('detail', `<span class="brief-top" data-card-part="label">${mark(symbol, color)}<span>${label}</span>${arrow}</span><span class="brief-body"><span class="brief-copy"><strong data-card-part="title">${title}</strong><span data-card-part="summary">${copy}</span></span>${visual}</span><span class="brief-stamp" data-card-part="stamp">${icon('clock')}${stamp}</span>`, `brief-card ${kind}`, `data-ref="${esc(actionRef)}" data-card-kind="${kind}" aria-label="${kind === 'parking' ? '주차 위치 상세' : label + ' 상세'}"`);
}
function closeWindowMenu(restoreFocus = false) {
  ui.windowMenu = false;
  const menu = $('#dashboard-window-menu'); if (menu) motion.disclosure(menu, false);
  const trigger = $('#dashboard-window-trigger'); trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}
function toggleWindowMenu() {
  ui.windowMenu = !ui.windowMenu;
  motion.disclosure($('#dashboard-window-menu'), ui.windowMenu);
  $('#dashboard-window-trigger').setAttribute('aria-expanded', String(ui.windowMenu));
  if (ui.windowMenu) { positionWindowMenu(); $('#dashboard-window-menu [aria-pressed=true]')?.focus({ preventScroll: true }); }
}
function positionWindowMenu() {
  const menu = $('#dashboard-window-menu'); if (!menu || menu.hidden) return;
  menu.classList.remove('is-docked');
  const boundary = $('.app-dock').getBoundingClientRect().top;
  const docked = menu.getBoundingClientRect().bottom > boundary - 8;
  menu.classList.toggle('is-docked', docked);
  menu.style.setProperty('--menu-bottom', `${innerHeight - boundary + 8}px`);
  menu.style.maxHeight = `${Math.max(80, docked ? boundary - 24 : boundary - menu.getBoundingClientRect().top - 12)}px`;
}
function windowPicker() {
  const selected = DASHBOARD_WINDOWS.find(w => w.hours === ui.horizon);
  return `<div class="time-window-picker">${button('toggle-window', `${icon('clock')}<span>${ui.horizon ? selected.hours === 24 ? '하루 보기' : `앞으로 ${selected.label}` : time(current())}</span>${arrow}`, `window-trigger ${ui.horizon ? 'is-expanded-range' : ''}`, `id="dashboard-window-trigger" aria-expanded="${ui.windowMenu}" aria-controls="dashboard-window-menu" aria-label="표시 시간 범위: ${selected.label}. 범위 선택"`)}
    <div id="dashboard-window-menu" class="window-menu" role="group" aria-label="표시 시간 범위" ${ui.windowMenu ? '' : 'hidden'}><p>표시할 시간 범위</p>${DASHBOARD_WINDOWS.map(w => button('set-window', `<span><strong>${w.label}</strong><small>${w.description}</small></span>${icon(w.hours === ui.horizon ? 'check' : 'chevron')}`, '', `data-hours="${w.hours}" aria-pressed="${w.hours === ui.horizon}"`)).join('')}${developerPreview ? button('day-preview', '체험 시간 변경' + arrow, 'window-demo') : ''}</div></div>`;
}
function forecastCard(item) {
  const atLabel = item.end === null ? '항상 표시' : `${item.current && dateKey(item.at) !== dateKey(current()) ? '어제 ' : ''}${time(item.at)}`;
  const kind = item.kind === 'event' ? 'schedule' : item.kind;
  const params = featurePreviewParams(kind, item.ref.split(':')[1]);
  const art = featureArt(kind, item.kind === 'news' && !item.current ? { ...params, status: 'scheduled', articleCount: undefined } : params).replace('<svg ', '<svg data-card-part="art" ');
  return button('detail', `<div class="forecast-card-top" data-card-part="label">${mark(item.icon, item.color)}${item.current ? '' : `<span class="forecast-status">${item.action}</span>`}</div><div class="forecast-body"><div class="forecast-copy"><div class="forecast-time" data-card-part="time">${atLabel}${item.current && item.end !== null ? '<small>부터</small>' : ''}</div><h4 data-card-part="title">${esc(item.title)}</h4><p data-card-part="summary">${esc(item.description)}</p></div>${art}</div><div class="forecast-card-bottom" data-card-part="stamp"><span>${item.detail}</span>${icon('arrow')}</div>`, `forecast-card ${item.color} ${item.current ? 'is-current' : ''}`, `data-ref="${esc(item.ref)}" data-card-kind="${kind}" data-occurrence="${esc(item.key)}" aria-label="${esc(item.title)}, ${atLabel}, ${item.current ? '지금 확인 가능' : item.action}"`);
}
function forecastShelves() {
  const result = dashboardTimeline(data, ui.horizon, current());
  const rangeEnd = `${dateKey(result.until) !== dateKey(result.from) ? '내일 ' : ''}${time(result.until)}`;
  return `<div class="forecast-summary" role="status"><div><span class="forecast-eyebrow">${ui.horizon === 24 ? '앞으로 24시간' : `앞으로 ${ui.horizon}시간`}</span><p>${time(result.from)} <span>—</span> ${rangeEnd}</p></div><strong>${result.count}<small>개 항목</small></strong></div>
    <div class="forecast-shelves">${result.groups.map(group => `<section class="forecast-shelf" aria-labelledby="shelf-heading-${group.key}"><header><div>${group.key === 'current' ? '' : `<span class="shelf-overline">${group.span}</span>`}<h3 id="shelf-heading-${group.key}">${group.label}<span>${group.items.length}</span></h3></div><div class="shelf-nav">${button('shelf-page', icon('back'), '', `data-rail="forecast-${group.key}" data-direction="-1" aria-label="${group.label} 이전 카드" aria-controls="forecast-${group.key}" disabled`)}${button('shelf-page', icon('arrow'), '', `data-rail="forecast-${group.key}" data-direction="1" aria-label="${group.label} 다음 카드" aria-controls="forecast-${group.key}"`)}</div></header><div class="forecast-rail" id="forecast-${group.key}" data-forecast-rail role="group" aria-label="${group.label} 카드 목록">${group.items.map(forecastCard).join('')}</div></section>`).join('') || empty('leaf', '이 시간에는 예정된 일이 없어요', '범위를 넓혀 다가오는 일을 살펴보세요.', ui.horizon < 24 ? button('set-window', '하루 전체 살펴보기 ' + arrow, 'text-button', 'data-hours="24"') : button('new-chat', '새 요청 입력', 'text-button'))}</div>
    `;
}
function dashboardNow(cards) {
  return `<section class="now-section ${ui.horizon ? 'is-browsing' : ''}"><div class="section-heading now-heading"><h2>${ui.horizon ? '미리 보는 하루' : '지금 챙길 것'}</h2>${windowPicker()}</div>${ui.horizon ? forecastShelves() : cards.length ? `<div class="brief-grid">${cards.map(briefCard).join('')}</div>` : empty('leaf', '지금 표시할 일정이 없어요', '일정과 반복 작업은 정한 시간에 여기에 표시돼요.', button('set-window', '앞으로 3시간 보기 ' + arrow, 'text-button', 'data-hours="3"'))}</section>`;
}
function dashboard() {
  const h = new Date(current()).getHours(), cards = dashboardCards(data);
  return `<div class="home-top"><span class="wordmark">mori<span>·</span></span><div class="home-tools">${developerPreview ? button('day-preview', `${icon(h < 18 ? 'sun' : 'moon')}<span>${h < 12 ? '아침' : h < 18 ? '낮' : '저녁'} 체험</span>`, 'preview-pill', 'aria-label="체험 시간 바꾸기"') : ''}${button('go-my', `<span>${esc((ui.liveUser?.display_name || data.profile.name).slice(0, 1))}</span>`, 'home-profile', 'aria-label="마이 화면"')}</div></div>
    <header class="home-greeting"><p class="home-date">${dateLabel(current())}</p><h1>${esc(ui.liveUser?.display_name || data.profile.name)}님,<br>${h < 12 ? '가벼운 하루를 시작해요' : h < 18 ? '오후도 가볍게 보내요' : '오늘도 수고했어요'}</h1><p class="greeting-caption">작은 기억은 모리에게 맡겨두세요.</p></header>
    ${dashboardNow(cards)}
    <div class="home-lower"><section>${dashboardCollection('오늘의 약속', 'go-schedule', '일정으로', todayEvents().map(eventRow).join('') || empty('calendar', '오늘 약속이 없어요', ''))}
    ${data.profile.recent ? dashboardCollection('최근 대화', 'go-conversations', '대화로', data.conversations.slice().sort((a, b) => b.at - a.at).slice(0, 2).map(conversationRow).join('') || empty('chat', '아직 대화가 없어요', '')) : ''}</section>
    <section>${dashboardCollection('기록과 정리', 'records', '전체 보기', recordsOf(data).slice(0, 3).map(recordRow).join('') || empty('note', '아직 남긴 기록이 없어요', ''), 'record-list')}
    ${section('모리와 더 편하게')}<div class="surface utility-list">${button('guide', `${mark('compass', 'blue')}<span class="row-content"><strong>모리 둘러보기</strong><small>작은 부탁 하나부터 시작해요</small></span>${arrow}`, 'record-row')}${button('new-custom', `${mark('spark', 'purple')}<span class="row-content"><strong>반복하는 부탁 만들기</strong><small>시간에 맞춰 챙기는 나만의 기능</small></span>${arrow}`, 'record-row')}</div><p class="home-signoff">작은 부탁, 가벼운 하루. <span>mori</span></p></section></div>`;
}
function conversationRow(c) { const last = c.messages.at(-1), draft = data.drafts[c.id]; return button('open-conversation', `${mark(c.pinned ? 'pin' : 'chat', c.pinned ? 'green' : 'soft')}<span class="row-content"><strong>${esc(c.title)}</strong><small class="${draft ? 'draft-text' : ''}">${draft ? '작성 중 · ' + esc(draft) : esc(last?.text || '새 이야기를 시작해 보세요')}</small></span><span class="row-date">${shortDate(c.at)}</span>`, 'conversation-row', `data-id="${c.id}"`); }
function conversationContent() {
  const groups = conversationGroups(data.conversations, ui.search, current()), count = groups.reduce((n, [, items]) => n + items.length, 0);
  return `
  ${!ui.search ? `<div class="conversation-start"><div class="mori-small"><img src="/assets/mori.svg" alt=""></div><div><h2>무슨 생각 하고 계세요?</h2><p>${data.drafts.new ? '쓰던 부탁이 기다리고 있어요.' : '작은 부탁 하나부터 시작해요.'}</p>${button('new-chat', data.drafts.new ? '작성 중인 부탁 이어쓰기 ' + arrow : '새 이야기 시작하기 ' + arrow, 'text-button')}</div>${button('voice', icon('mic'), 'header-button', 'aria-label="음성으로 입력"')}</div>` : `<p class="list-label" role="status">검색 결과 <span>${count}개</span></p>`}
  <div class="conversation-groups">${groups.map(([label, items]) => `<section><p class="list-label">${label} <span>${items.length}</span></p><div class="surface">${items.map(conversationRow).join('')}</div></section>`).join('') || (ui.search ? empty('search', '찾는 이야기가 없어요', '조금 더 짧은 단어나 다른 표현으로 찾아보세요.', button('clear-search', '검색 지우기', 'text-button')) : empty('chat', '첫 이야기를 기다리고 있어요', '주차 위치, 떠오른 생각, 작은 부탁을 남겨보세요.', button('new-chat', '모리와 대화하기', 'primary-button')))}</div>`;
}
function conversations() {
  return `${heading('대화', '모리와 나눈 이야기', button('new-chat', icon('compose'), 'header-button', 'aria-label="새 대화"'))}<label class="search-box">${icon('search')}<input id="conversation-search" type="search" placeholder="지난 이야기 검색" value="${esc(ui.search)}" aria-label="대화 검색"></label><div id="conversation-content">${conversationContent()}</div>`;
}
function conversationOptions() {
  const c = data.conversations.find(c => c.id === ui.chatId); if (!c) return;
  openSheet('대화 정리', `<form id="conversation-form" data-id="${c.id}">${field('대화 이름', 'title', c.title, 'text', 'required maxlength="80"')}<button class="primary-button" type="submit">이름 저장</button></form>${button('pin-conversation', icon('pin') + (c.pinned ? '고정 해제' : '목록 맨 위에 고정하기'), 'secondary-button full', `data-id="${c.id}"`)}<p class="field-help">자주 이어가는 대화는 고정해 두세요.</p>`, 'conversation-options-sheet');
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
  return `<div class="schedule-topbar">${heading('일정', '내 하루의 흐름을 한눈에', button('new-event', icon('plus'), 'header-button', 'aria-label="일정 추가"'))}
    <div class="schedule-summary"><div><span>${scopeLabel}의 약속</span><strong>${scope.length}<small>개</small></strong></div><p>${next ? `다음은 <b>${esc(next.title)}</b><span>오늘 ${next.time} · ${esc(next.place || '장소 미정')}</span>` : '지금은 여유로운 시간이에요.<span>다가올 약속을 천천히 챙겨보세요.</span>'}</p></div></div>
    <div class="segmented calendar-modes" aria-label="달력 보기 방식">${[['month', '월'], ['week', '주'], ['day', '일']].map(([id, title]) => button('calendar-mode', title, ui.calendar === id ? 'selected' : '', `data-value="${id}" aria-pressed="${ui.calendar === id}"`)).join('')}</div>
    <div class="schedule-layout ${ui.calendar}"><section class="calendar-surface" data-month="${year}-${String(month + 1).padStart(2, '0')}" aria-label="날짜 선택">
      <div class="month-header">${button('calendar-jump', `<span class="calendar-title-copy"><small>${year}년</small><strong>${month + 1}월</strong></span>${arrow}`, 'month-title', `aria-label="${year}년 ${month + 1}월, 연도와 월 선택"`)}<div class="calendar-navigation">${button('calendar-today', '오늘', 'today-button')}<span class="calendar-period-nav" role="group" aria-label="달력 기간 이동">${button('month-prev', icon('back'), 'small-icon', 'aria-label="이전 기간"')}${button('month-next', arrow, 'small-icon', 'aria-label="다음 기간"')}</span></div></div>
      <div class="weekdays">${['일', '월', '화', '수', '목', '금', '토'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="calendar-grid ${ui.calendar !== 'month' ? 'week-strip' : ''}" data-period="${dates[0]}/${dates.at(-1)}">${dates.map(cell).join('')}</div>
      <div class="calendar-legend">${EVENT_KINDS.map(kind => `<span><i class="${kind.value}"></i>${kind.label}</span>`).join('')}</div>
    </section><section class="agenda-panel" aria-label="일정 목록">
      <div class="agenda-heading"><div><p>${ui.calendar === 'week' ? '한 주의 흐름' : `${ui.date === today ? '오늘 · ' : ''}${selected.toLocaleDateString('ko-KR', { weekday: 'long' })}`}</p><h2>${ui.calendar === 'week' ? weekLabel : `${selected.getMonth() + 1}월 ${selected.getDate()}일`}</h2></div><span>${ui.calendar === 'week' ? scope.length : events.length}개의 약속</span></div>
      <div class="agenda-body">${agenda}</div>${events.length && ui.calendar === 'month' ? button('new-event', icon('plus') + ' 이 날에 일정 추가', 'agenda-add') : ''}
    </section></div><div class="quiet-card">${icon('spark')}<div><strong>음성으로 일정 입력</strong><p>말한 내용을 확인한 뒤 보내세요.</p></div>${button('voice', icon('mic'), 'small-icon', 'aria-label="음성으로 일정 입력"')}</div>`;
}
function calendarJump(year = dayDate(ui.date).getFullYear()) {
  ui.jumpYear = year;
  openSheet('날짜로 이동', `<div class="jump-year">${button('jump-year', icon('back'), 'small-icon', 'data-delta="-1" aria-label="이전 연도"')}<h3>${year}년</h3>${button('jump-year', arrow, 'small-icon', 'data-delta="1" aria-label="다음 연도"')}</div><div class="month-options">${Array.from({ length: 12 }, (_, month) => button('jump-month', `${month + 1}월`, year === dayDate(ui.date).getFullYear() && month === dayDate(ui.date).getMonth() ? 'selected' : '', `data-month="${month}" aria-pressed="${year === dayDate(ui.date).getFullYear() && month === dayDate(ui.date).getMonth()}"`)).join('')}</div>`, 'date-jump-sheet');
}
function featureStatus(id) {
  return ({parking: data.parking ? `${data.parking.floor} ${data.parking.spot}` : '저장된 위치 없음', news: `매일 ${clockLabel(data.news.time)}`, stock: data.stock.symbol, note: `${data.notes.length}개 저장됨`, schedule: `오늘 일정 ${todayEvents().length}개`, reminder: `진행 중 ${data.reminders.filter(r => !r.cancelled && r.target > current()).length}개`})[id];
}
function features() {
  return `${heading('기능', '매일의 부탁을, 나만의 방식으로', button('new-custom', icon('plus'), 'header-button', 'aria-label="새 기능 만들기"'))}<div class="segmented">${[['all', '모든 기능'], ['builtin', '기본 기능'], ['custom', '내 기능']].map(([v, title]) => button('feature-filter', title, ui.filter === v ? 'selected' : '', `data-value="${v}" aria-pressed="${ui.filter === v}"`)).join('')}</div>
    ${ui.filter !== 'custom' ? `${section('매일을 위한 기본 기능', '<span class="section-caption">6가지</span>')}<div class="feature-grid">${BUILTINS.map(f => button('detail', `<span class="feature-tile-copy"><h3>${f.title}</h3><p>${f.subtitle}</p><span class="feature-status">${esc(featureStatus(f.id))}</span></span>${featureArt(f.id, featurePreviewParams(f.id))}${arrow}`, `feature-tile feature-tile--${f.id}`, `data-ref="${f.id}"`)).join('')}</div>` : ''}
    ${ui.filter !== 'builtin' ? `${section('나에게 맞춘 기능', `<span class="section-caption">${data.customs.filter(f => f.active).length}개 사용 중</span>`)}<div class="custom-list">${data.customs.map(f => button('detail', `${mark(f.icon, 'purple')}<span class="row-content"><strong>${esc(f.title)}</strong><small>${esc(f.time ? `${f.repeat} ${clockLabel(f.time)}` : '필요할 때 실행')}</small>${f.result ? `<span class="row-meta">최근 실행 ${shortDate(f.result.at)} · 결과 ${f.result.items.length}개</span>` : ''}</span>${tag(!f.work ? '초안' : f.active ? '사용 중' : '중지', f.active ? 'green' : '')}${arrow}`, 'custom-row', `data-ref="custom:${f.id}"`)).join('') || empty('spark', '나만의 루틴을 만들어보세요', '반복하는 부탁을 한 번만 정해두세요.')}</div><button class="create-feature" data-action="new-custom"><span class="create-icon">${icon('spark')}</span><span class="tiny-label">나만의 반복</span><h3>반복하는 부탁,<br>내 기능으로 기억해요.</h3><p>할 일과 시간을 정하면 같은 모양의 카드로 만나보세요.</p><span>새 기능 만들기 ${icon('plus')}</span></button>` : ''}`;
}
const themeLabel = () => ({system: '시스템 설정', light: '라이트', dark: '다크'})[selectedTheme];
function my() {
  const user = ui.liveUser;
  const status = ui.accountState === 'checking' ? '계정을 확인하고 있어요' : ui.accountState === 'error' ? '계정 연결을 확인해 주세요' : '로그인하고 시작해요';
  return `${heading('마이', '나의 계정과 이용 설정')}<div class="profile-summary"><div class="profile-art"><img src="/assets/mori.svg" alt="모리"></div><div><span class="account-eyebrow">${user ? '나의 모리' : '나의 모리'}</span><h2>${user ? esc(user.display_name) + '님' : '반가워요'}</h2><p>${user ? user.providers.map(p => p === 'naver' ? '네이버' : '카카오').join(' · ') + '로 로그인 중' : status}</p></div></div>
    ${!user ? button('account', '네이버 · 카카오로 로그인 ' + icon('arrow'), 'primary-button full') : ''}
    <div class="license-card account-plan"><div>${tag(user?.tier === 'pro' ? 'Pro' : 'Free')}<h3>${user?.tier === 'pro' ? '나만을 위한 모리' : '가볍게 시작하는 모리'}</h3><p>${user?.tier === 'pro' ? '이용 중인 요금제를 확인하세요.' : '무료로 일상의 부탁을 시작하세요.'}</p></div>${button('license', '요금제 보기 ' + arrow, 'text-button')}</div>
    ${section('계정')}<div class="settings-list">${button('account', `${mark('user', 'soft')}<span class="setting-copy"><strong>사용자 정보</strong><small>${user ? '내 정보와 연결된 계정 확인' : '로그인 후 확인할 수 있어요'}</small></span>${arrow}`, 'setting-row')}${button('edit-profile', `${mark('compose', 'soft')}<span class="setting-copy"><strong>사용자 정보 수정</strong><small>모리가 부를 이름을 변경해요</small></span>${arrow}`, 'setting-row')}</div>
    ${section('앱 설정')}<div class="settings-list">${button('theme', `${mark('moon', 'soft')}<span class="setting-copy"><strong>테마</strong><small>${themeLabel()}</small></span>${arrow}`, 'setting-row')}</div>
    ${section('요금제')}<div class="settings-list">${button('license', `${mark('spark', 'purple')}<span class="setting-copy"><strong>요금제 및 결제 관리</strong><small>무료 이용 · Pro 결제 · 구독 해지</small></span>${arrow}`, 'setting-row')}</div>
    ${user ? button('logout', '로그아웃', 'logout-button full') : ''}<div class="brand-footer">mori <span>작은 부탁, 가벼운 하루.</span></div>`;
}
function render({ scrollTop } = {}) {
  const main = $('#main');
  const tabFocus = captureControl($('#tabs').contains(document.activeElement) ? document.activeElement : null);
  const previousScroll = scrollTop ?? main.scrollTop;
  const railPositions = new Map([...document.querySelectorAll('[data-forecast-rail]')].map(el => [el.id, el.scrollLeft]));
  railObserver?.disconnect();
  main.innerHTML = ({ dashboard, schedule, conversations, features, my }[ui.view] || dashboard)();
  main.classList.toggle('has-composer', ui.view === 'dashboard');
  main.dataset.page = ui.view;
  main.scrollTo({ top: previousScroll, behavior: 'instant' });
  // Keep the live glass indicator and buttons mounted. Replacing them loses
  // their in-flight position, pressed state and keyboard focus on every render.
  const tabs = $('#tabs');
  if (!tabs.querySelector('.nav-indicator')) tabs.innerHTML = '<span class="nav-indicator" aria-hidden="true"></span>' + [['dashboard', 'home', '오늘'], ['schedule', 'calendar', '일정'], ['conversations', 'chat', '대화'], ['features', 'grid', '기능'], ['my', 'user', '마이']].map(([v, i, label]) => `<button type="button" data-view="${v}">${icon(i)}<span>${label}</span></button>`).join('');
  for (const tab of tabs.querySelectorAll('[data-view]')) {
    if (tab.dataset.view === ui.view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  resolveControl($('#tabs'), tabFocus, { visible: true })?.focus({ preventScroll: true });
  $('#quick-composer').hidden = false; document.documentElement.classList.toggle('reduce-motion', data.profile.reduced);
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
  motion.render(ui.view);
}
function route() {
  const next = location.hash.slice(1), previous = ui.view;
  pageScroll.set(previous, $('#main').scrollTop);
  ui.view = ['dashboard', 'schedule', 'conversations', 'features', 'my'].includes(next) ? next : 'dashboard';
  render({ scrollTop: pageScroll.get(ui.view) || 0 });
}
function go(view) { closeWindowMenu(); if (location.hash === `#${view}`) $('#main').scrollTo({ top: 0, behavior: data.profile.reduced ? 'instant' : 'smooth' }); else location.hash = view; }
function cardDetailHero() {
  if (!sheetCardOrigin) return '';
  const { sourceRef, occurrence, forecast, kind } = sheetCardOrigin;
  const matchesOrigin = card => card && $('#main').contains(card) &&
    card.matches(forecast ? '.forecast-card' : '.brief-card') && card.dataset.ref === sourceRef &&
    (!forecast || card.dataset.occurrence === occurrence);
  let source = resolveControl(document, sheetCardOrigin.control);
  if (!matchesOrigin(source)) source = [...$('#main').querySelectorAll(forecast ? '.forecast-card' : '.brief-card')].find(matchesOrigin);
  // Only an original generic brief card may acquire a new record id. An exact
  // forecast occurrence must never become another day's or another item's card.
  if (!source && !forecast && sourceRef === kind) source = [...$('#main').querySelectorAll('.brief-card')].find(card => card.dataset.cardKind === kind);
  if (!source) return sheetCardOrigin.hero || '';
  const hero = document.createElement('article');
  hero.className = `card-detail-hero ${source.className}`;
  hero.innerHTML = source.innerHTML;
  hero.querySelector('.brief-top > .icon:last-child')?.remove();
  // The page summary is presentational; only the real detail body has controls.
  hero.querySelectorAll('[data-action], [tabindex], [id]').forEach(element => {
    element.removeAttribute('data-action'); element.removeAttribute('tabindex'); element.removeAttribute('id');
  });
  sheetCardOrigin.hero = hero.outerHTML;
  return sheetCardOrigin.hero;
}
function cardDetailBody(content, ref, hasHero) {
  if (!hasHero) return content;
  const template = document.createElement('template');
  template.innerHTML = content;
  const kind = ref?.split(':')[0];
  // The expanded card already carries the title and summary. Continue directly
  // into the facts, articles or chart rather than repeating the same header.
  if (kind === 'parking') {
    template.content.querySelector('.parking-detail')?.remove();
  } else if (kind === 'stock' && sheetCardOrigin?.forecast) {
    const heading = template.content.querySelector('.detail-title');
    // A forecast carries the symbol and time, but not the quote. Retain the
    // price and change in the body instead of dropping them with the title.
    heading?.querySelector('.feature-icon')?.remove();
    heading?.querySelector('h2')?.remove();
    heading?.querySelector('p:not(.positive)')?.remove();
    if (heading) heading.className = 'forecast-stock-quote';
  } else if (['stock', 'news'].includes(kind)) template.content.querySelector('.detail-title')?.remove();
  else if (kind === 'event' && sheetCardOrigin?.forecast) {
    const title = template.content.querySelector('.detail-title');
    const date = title?.querySelector('p');
    if (date) { date.classList.add('sheet-description'); title.before(date); }
    title?.remove();
  }
  return template.innerHTML;
}
function openSheet(title, content, cls = '', { ref = detailRequest, restore = null } = {}) {
  formDrafts.capture(draftForm());
  const dialog = $('#sheet'), wasOpen = dialog.open && !dialog.hasAttribute('data-closing'), source = presentationSource;
  const scroller = $('#sheet-content'), previousRef = ui.detail, previousSize = sheetCurrent?.size;
  const parentPresentation = wasOpen ? dialog.dataset.sheetPresentation : '';
  const refreshing = wasOpen && Boolean(ref) && ref === previousRef && !returningSheet;
  // A scheduled result must not replace the elements being used by an entrance
  // or resurrect a page that the user is already dismissing.
  if (dialog.open && dialog.hasAttribute('data-closing') && ref) return;
  if (refreshing && presentations.deferUpdate(dialog, () => {
    if (dialog.open && ui.detail === ref && !dialog.hasAttribute('data-closing')) openSheet(title, content, cls, { ref, restore });
  })) return;
  if (wasOpen && !refreshing) presentations.settle(dialog);
  const previousScroll = scroller.scrollTop;
  const focusedControl = captureControl(scroller.contains(source) ? source : scroller.contains(document.activeElement) ? document.activeElement : null);
  const action = source?.dataset.action;
  const nested = ['detail', 'edit-parking', 'edit-note', 'new-note', 'edit-event', 'new-event', 'edit-custom', 'edit-profile', 'news-settings', 'stock-settings', 'article', 'document', 'preset-reminder', 'account', 'license', 'theme'];
  if (!wasOpen) {
    sheetTrail = [];
    const origin = source || document.activeElement;
    sheetOrigin = { root: origin?.closest('dialog') || document, control: captureControl(origin) };
    const card = origin?.closest('.brief-card, .forecast-card');
    sheetCardOrigin = card?.dataset.ref && $('#main').contains(card) ? {
      control: captureControl(card), ref: ref || card.dataset.ref, sourceRef: card.dataset.ref,
      kind: card.dataset.ref.split(':')[0], forecast: card.matches('.forecast-card'),
      occurrence: card.dataset.occurrence || null,
    } : null;
  }
  if (!returningSheet && !refreshing && wasOpen && sheetCurrent && source?.closest('#sheet') && nested.includes(action)) {
    sheetTrail.push({ ...sheetCurrent, ref: previousRef, scroll: $('#sheet-content').scrollTop, control: captureControl(source) });
  }
  // Saving an edit returns to its existing detail, rather than adding another level.
  const existing = ref ? sheetTrail.findIndex(entry => entry.ref === ref) : -1;
  if (existing >= 0) sheetTrail = sheetTrail.slice(0, existing);
  const previousView = wasOpen && !refreshing ? presentations.captureReplacement(scroller) : null;
  const previousTitle = previousView ? $('#sheet-title').textContent : '';
  ++ui.sheetEpoch; ui.detail = null;
  const detail = Boolean(sheetCardOrigin) || Boolean(ref && !['schedule', 'note'].includes(ref)) || Boolean(ref?.includes(':')) || (wasOpen && sheetTrail.some(entry => entry.detail)) || (wasOpen && previousRef?.startsWith('document:'));
  const cardHero = sheetCardOrigin && (ref === sheetCardOrigin.ref || !ref && !sheetTrail.length) ? cardDetailHero() : '';
  sheetCurrent = { title, content, cls, detail, restore };
  $('#sheet-title').textContent = title;
  $('#sheet-content').innerHTML = sheetCardOrigin ? `${cardHero}<section class="card-detail-body" data-card-reveal>${cardDetailBody(content, ref, Boolean(cardHero))}</section>` : content;
  // One native form-associated submit lives in the fixed action area. Keeping
  // the real button preserves required validation, Enter and disabled states.
  const actions = $('#sheet-actions');
  actions.replaceChildren();
  const headerActions = $('#sheet-header-actions');
  headerActions.replaceChildren();
  const form = scroller.querySelector('form');
  const submit = form?.querySelector('button[type="submit"]');
  const pagePresentation = sheetPresentation({ screen: cls, formId: form?.id, hasCardHero: Boolean(cardHero), parent: sheetTrail.length ? parentPresentation : '' });
  if (submit && form.id) {
    submit.setAttribute('form', form.id);
    if (pagePresentation === 'page') {
      submit.setAttribute('aria-label', submit.textContent.trim());
      submit.textContent = form.id === 'theme-form' ? '완료' : '저장';
      headerActions.append(submit);
    } else actions.append(submit);
  }
  if (cls === 'library-sheet' && pagePresentation === 'page') {
    headerActions.innerHTML = button('document', icon('upload'), '', 'aria-label="파일 가져오기"') + button('new-note', icon('compose'), '', 'aria-label="새 메모"');
  }
  actions.hidden = !actions.children.length;
  if (formDrafts.restore(draftForm())) {
    draftForm().insertAdjacentHTML('afterbegin', `<div class="draft-notice"><span>저장하지 않은 내용을 이어서 작성해요.</span>${button('discard-form-draft', '초안 지우기', 'text-button')}</div>`);
    syncDraftForm();
  }
  dialog.className = `sheet ${cls} ${detail ? 'detail-page' : ''} ${ref === 'parking' ? 'parking-story' : ''} ${cardHero ? 'card-page has-card-hero' : ''}`;
  const layout = sheetLayout({ formId: form?.id, ref, screen: cls, hasCardHero: Boolean(cardHero) });
  // A short step within a large flow stays in the existing frame. Forms always
  // use the same large frame, regardless of which card or tab opened them.
  if (wasOpen && sheetTrail.length && layout.size === 'compact' && previousSize !== 'compact') layout.size = 'large';
  sheetCurrent.size = layout.size;
  dialog.dataset.sheetSurface = layout.surface;
  dialog.dataset.sheetSize = layout.size;
  dialog.dataset.sheetPresentation = pagePresentation;
  dialog.dataset.scrolled = 'false';
  dialog.style.setProperty('--nav-action-width', headerActions.children.length > 1 ? '88px' : '52px');
  dialog.dataset.detailKind = ref?.split(':')[0] || '';
  $('#sheet-back').hidden = pagePresentation !== 'page' && !sheetTrail.length;
  $('#sheet-back').setAttribute('aria-label', sheetTrail.length ? `${sheetTrail.at(-1).title} 화면으로 돌아가기` : '이전 화면으로 돌아가기');
  scroller.scrollTop = refreshing ? previousScroll : 0;
  presentations.show(dialog, { source: source || document.activeElement, kind: layout.surface === 'card' || layout.size === 'page' ? 'detail' : 'sheet' }); moveToast();
  if (previousView) {
    presentations.replace(scroller, { back: returningSheet, level: !returningSheet && !nested.includes(action), previous: previousView });
    motion.swapTitle($('#sheet-title'), previousTitle, { back: returningSheet });
  }
  if (refreshing) resolveControl(scroller, focusedControl, { visible: true })?.focus({ preventScroll: true });
  else if (wasOpen && source && !source.isConnected) $('#sheet-title').focus({ preventScroll: true });
}
function backSheet() {
  const previous = sheetTrail.pop();
  if (!previous) return closeSheet();
  returningSheet = true;
  try {
    if (previous.restore) previous.restore();
    else if (previous.ref && previous.ref !== 'note') openDetail(previous.ref);
    else if (previous.cls === 'library-sheet') recordsSheet();
    else openSheet(previous.title, previous.content, previous.cls);
    $('#sheet-content').scrollTop = previous.scroll;
    (resolveControl($('#sheet-content'), previous.control, { visible: true }) || $('#sheet-title')).focus({ preventScroll: true });
  } finally { returningSheet = false; }
}
function closeSheet(dragOffset = 0) { formDrafts.capture(draftForm()); ++ui.sheetEpoch; ui.detail = null; sheetTrail = []; const closed = presentations.dismiss($('#sheet'), { dragOffset }); moveToast(); return closed; }
function syncDraftForm() {
  const form = draftForm(); if (!form) return;
  form.querySelectorAll('[data-choice]').forEach(choice => setChoice(choice, choice.querySelector('input').value));
  if (form.id === 'event-form') updateEventPreview();
  if (form.id === 'custom-form') updateCustomPreview();
  if (form.id === 'note-form') $('#note-length').textContent = `${form.elements.body.value.length.toLocaleString()}자`;
}
const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
const textArea = (label, name, value = '', extra = '') => `<label class="field"><span>${label}</span><textarea name="${name}" rows="4" ${extra}>${esc(value)}</textarea></label>`;
function parkingForm(live = false) {
  const record = live ? ui.liveParking : data.parking, p = record ? parkingConfig(record, data.profile) : { purpose: 'external', display_mode: 'always' };
  const schedule = p.display_schedule || { time: '08:30', days: [0, 1, 2, 3, 4], duration_minutes: 90 };
  const choices = (legend, name, options, value) => `<fieldset class="parking-options"><legend>${legend}</legend><div>${options.map(([v, title, description]) => `<label><input type="radio" name="${name}" value="${v}" ${v === value ? 'checked' : ''}><span><strong>${title}</strong><small>${description}</small></span></label>`).join('')}</div></fieldset>`;
  openSheet(live ? '계정에 주차 위치 저장' : '주차 위치 저장', `<form id="${live ? 'live-parking' : 'parking-form'}" class="parking-form"><div class="form-intro compact-intro">${mark('car')}<h3>주차 위치</h3><p>${live ? '로그인한 계정에 저장해요.' : '저장하면 이전 주차 위치가 바뀌어요.'}</p></div><div class="field-pair">${field('층 · 선택', 'floor', record?.floor || '', 'text', 'maxlength="32" placeholder="지하 3층"')}${field('구역 · 자리', 'spot', record?.spot || '', 'text', 'maxlength="64" placeholder="B16"')}</div>${choices('주차 용도', 'purpose', [['external', '외부 주차', '방문한 곳의 주차 위치'], ['commute', '출근용', '출근할 때 확인할 위치']], p.purpose)}${choices(live ? '대시보드 표시' : '확인할 시간', 'display_mode', [['always', live ? '항상 표시' : '시간 지정 안 함', live ? '다음 위치를 저장할 때까지' : '기능 탭에서 언제든 확인'], ['scheduled', '정한 시간', '선택한 요일과 시간에 표시']], p.display_mode)}${live ? '' : '<p class="field-help">시간을 정하면 ‘지금 챙길 것’에 표시해요. 기록은 기능 탭에서 언제든 확인할 수 있어요.</p>'}<div id="parking-schedule" ${p.display_mode === 'always' ? 'hidden' : ''}><div class="field-pair">${field('표시 시작', 'time', schedule.time, 'time')}${choiceField('표시 기간', 'duration_minutes', schedule.duration_minutes, [...new Set([30, 60, 90, 120, 180, 1440, schedule.duration_minutes])].sort((a, b) => a - b).map(value => ({ value, label: value === 1440 ? '24시간' : `${value}분` })))}</div><fieldset class="parking-weekdays"><legend>표시할 요일</legend>${['월', '화', '수', '목', '금', '토', '일'].map((label, index) => `<label><input type="checkbox" name="days" value="${index}" ${schedule.days.includes(index) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</fieldset><p class="field-help">한국 시간 기준 · 기기 알림은 보내지 않아요.</p></div><div class="parking-preview" role="status"><span>${icon('car')}저장할 위치</span><strong id="parking-location-preview"></strong><p id="parking-display-preview"></p></div><p class="form-error" role="alert"></p><div class="form-actions"><button class="primary-button" type="submit">위치 저장 ${icon('check')}</button></div></form>`, 'parking-sheet');
  updateParkingPreview();
}
function parkingValues(form) {
  const values = Object.fromEntries(new FormData(form));
  return { floor: values.floor, spot: values.spot, ...parkingOptions({ ...values, days: [...form.querySelectorAll('[name=days]:checked')].map(input => Number(input.value)) }) };
}
function updateParkingPreview() {
  const form = $('.parking-form'); if (!form) return;
  const scheduled = form.querySelector('[name=display_mode]:checked').value === 'scheduled';
  $('#parking-schedule').hidden = !scheduled;
  form.querySelector('[name=time]').required = scheduled;
  $('#parking-location-preview').textContent = [form.elements.floor.value.trim(), form.elements.spot.value.trim()].filter(Boolean).join(' · ') || '층이나 자리 번호를 알려주세요';
  try { $('#parking-display-preview').textContent = form.id === 'parking-form' && !scheduled ? '시간 지정 없음 · 기능 탭에서 확인' : parkingDescription(parkingValues(form)); } catch (err) { $('#parking-display-preview').textContent = err.message; }
}
function noteForm(id) { const n = data.notes.find(n => n.id === id); openSheet(n ? '메모 편집' : '새 메모', `<form id="note-form" data-id="${n?.id || ''}">${field('제목', 'title', n?.title || '', 'text', 'maxlength="80" placeholder="제목"')}${textArea('내용', 'body', n?.body || '', 'placeholder="내용을 입력하세요" id="note-content" maxlength="12000"')}<p class="form-error" role="alert"></p><span id="note-length" class="field-help">${(n?.body || '').length.toLocaleString()}자</span><button class="primary-button" type="submit">메모 저장 ${icon('check')}</button></form>`); }
function eventForm(id, date = ui.date, startTime = '14:00') {
  const event = data.events.find(event => event.id === id);
  const duration = event ? eventDuration(event) : 60;
  const durations = [...new Set([30, 60, 90, 120, 180, duration])].sort((a, b) => a - b).map(value => ({ value, label: `${Math.floor(value / 60) ? Math.floor(value / 60) + '시간' : ''}${value % 60 ? ' ' + value % 60 + '분' : ''}`.trim() }));
  openSheet(event ? '일정 편집' : '일정 추가', `<form id="event-form" data-id="${event?.id || ''}" data-draft-key="${event?.id || `${date}:${startTime}`}">
    ${field('어떤 약속인가요?', 'title', event?.title || '', 'text', 'required maxlength="80" placeholder="예: 모리 디자인 미팅"')}
    ${field('날짜', 'date', event?.date || date, 'date', 'required')}
    <div class="field-pair">${field('시작 시간', 'time', event?.time || startTime, 'time', 'required')}${choiceField('소요 시간', 'duration', duration, durations)}</div>
    ${choiceField('일정 종류', 'color', event?.color || 'green', EVENT_KINDS)}
    ${field('장소 · 선택', 'place', event?.place || '', 'text', 'maxlength="120" placeholder="장소나 온라인 링크"')}
    ${textArea('메모 · 선택', 'memo', event?.memo || '', 'maxlength="1000" placeholder="미리 챙길 준비물이나 기억할 내용"')}
    <p class="event-preview" id="event-preview" role="status"></p>
    <p class="form-error" role="alert"></p><div class="form-footer"><button class="primary-button" type="submit">${event ? '변경 저장' : '일정 저장'} ${icon('check')}</button>${event ? button('delete-event', icon('trash') + ' 이 일정 삭제', 'danger-button', `data-id="${event.id}"`) : ''}</div>
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
  openSheet(f ? '내 기능 편집' : '나만의 기능 만들기', `<div class="form-intro compact-intro">${mark('spark', 'purple')}<h3>반복하는 부탁을 기억해요.</h3><p>반복할 일과 실행 시간을 입력하세요.</p></div>${!f ? button('custom-example', '예시 채우기 · 평일 저녁에 메모 정리하기 ' + arrow, 'example-request') : ''}<form id="custom-form" data-id="${f?.id || ''}"><fieldset class="icon-picker"><legend>카드 아이콘</legend>${[['spark', '반짝임'], ['note', '메모'], ['leaf', '일상'], ['news', '정보'], ['bell', '알림'], ['compass', '여행']].map(([v, label]) => `<label><input type="radio" name="icon" value="${v}" ${(f?.icon || 'spark') === v ? 'checked' : ''}><span>${icon(v)}<span class="sr-only">${label}</span></span></label>`).join('')}</fieldset>${field('기능 이름', 'title', f?.title || '', 'text', 'maxlength="60" placeholder="예: 퇴근 정리"')}${textArea('어떤 일을 하면 좋을까요?', 'work', f?.work || '', 'maxlength="2000" placeholder="오늘 저장한 메모를 모아서 할 일을 정리해줘"')}${field('짧은 설명 · 선택', 'description', f?.description || '', 'text', 'maxlength="180" placeholder="카드에 보여줄 한 줄"')}<div class="field-pair">${field('실행 시간 · 선택', 'time', f?.time || '', 'time')}${choiceField('반복', 'repeat', f?.repeat || '필요할 때', ['필요할 때', '매일', '평일', '한 번'])}</div><details class="support-details"><summary>참고할 내용 추가하기</summary>${textArea('참고 자료 · 선택', 'content', f?.content || '', 'maxlength="6000" placeholder="함께 확인할 내용을 남겨주세요"')}</details><p class="field-help">시간이 없으면 필요할 때 직접 실행해요.<br>체험에서는 앱이 열려 있을 때 저장한 메모를 정리해요.</p><details class="support-details custom-preview-disclosure"><summary>대시보드 카드 미리보기</summary><div id="custom-preview" class="custom-preview" aria-label="기능 카드 미리보기"></div></details><p class="form-error" role="alert"></p><button class="primary-button" type="submit">${f ? '변경 저장' : '내 기능으로 저장'} ${icon('check')}</button></form>`);
  updateCustomPreview();
}
function updateCustomPreview() {
  const form = $('#custom-form'); if (!form) return;
  const f = customPreview(Object.fromEntries(new FormData(form)));
  $('#custom-preview').innerHTML = `<div class="preview-label">카드 미리보기 ${tag(f.work ? '준비됨' : '초안', 'purple')}</div><div class="preview-content">${mark(f.icon, 'purple')}<div><strong>${esc(f.title)}</strong><p>${esc(f.description)}</p></div></div><div class="preview-time">${icon(f.time ? 'clock' : 'spark')}${f.time ? `${f.repeat} ${clockLabel(f.time)}` : '필요할 때 직접 실행'}</div>`;
}
function remaining(target) { const total = Math.max(0, Math.ceil((target - current()) / 1000)); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }
const articleTitles = ['개인 비서 AI의 일정 관리 기능', '음성 인식, 어디까지 왔을까', '업무 도구에 추가되는 자동화 기능'];
function openDetail(ref) {
  detailRequest = ref;
  try { return renderDetail(ref); } finally { detailRequest = null; }
}
function detailHeader(name, color, title, context = '', badge = '') {
  return `<div class="feature-detail-header">${mark(name, color)}<div>${context ? `<p class="detail-kicker">${esc(context)}</p>` : ''}<h2>${esc(title)}</h2>${badge}</div></div>`;
}
function renderDetail(ref) {
  const [kind, id] = ref.split(':');
  if (kind === 'parking') { if (!data.parking) return parkingForm(); const p = parkingConfig(data.parking, data.profile); openSheet('주차 기록', `<div class="detail-hero parking-detail">${mark('car')}<p>${parkingPurpose(p)} · 잘 기억하고 있어요</p><h2>${esc(p.floor)}<br><strong>${esc(p.spot || '내 차가 있는 곳')}</strong></h2>${mapArt()}</div><div class="detail-facts"><div><span>기억한 시간</span><strong>${shortDate(p.at)} ${time(p.at)}</strong></div><div><span>표시 방식</span><strong>${p.display_mode === 'always' ? '시간 지정 없음' : '정한 시간에 표시'}</strong></div><div><span>대시보드</span><strong>${esc(p.display_mode === 'always' ? '표시 시간 미설정' : parkingDescription(p))}</strong></div></div><p class="field-help">정한 시간에는 ‘지금 챙길 것’에 표시해요. 기록은 기능 탭에서 언제든 확인할 수 있어요.<br>다른 곳에 주차하면 가장 최근 위치로 바뀌어요. 기기 알림은 별도로 예약해야 해요.</p>${button('edit-parking', '위치 · 표시 설정 바꾸기 ' + icon('car'), 'primary-button')}`); }
  else if (kind === 'news') openSheet('뉴스 브리핑', `<div class="detail-title">${mark('news', 'blue')}<p>${esc(data.news.topic)} · ${clockLabel(data.news.time)}</p><h2>${esc(data.news.topic)} 브리핑</h2>${tag('샘플 브리핑', 'blue')}</div>${data.news.status === 'loading' ? `<div class="loading-news"><span class="loading-orb"></span><h3>관심 있는 이야기를 모으고 있어요.</h3><p>요약과 출처를 함께 정리할게요.</p><div class="skeleton"></div><div class="skeleton short"></div></div>` : data.news.status === 'failed' ? `<div class="error-card">${icon('cloud')}<h3>브리핑이 조금 늦어지고 있어요.</h3><p>마지막 결과: ${shortDate(data.news.at)} ${time(data.news.at)}<br>새 결과가 도착하면 갱신할게요.</p>${button('refresh-news', '다시 수집하기', 'secondary-button')}</div>` : `<p class="updated-at">${shortDate(data.news.at)} ${time(data.news.at)} 기준 · 기사 3개</p><div class="article-list">${articleTitles.map((title, i) => button('article', `<span class="article-number">0${i + 1}</span><span><h3>${title}</h3><p>${['작은 일을 맡기며 달라지는 일상의 모습.', '기술과 함께 더 명확하게 생각하는 방법.', '정보를 줄이고 해야 할 일에 집중하기.'][i]}</p><small>모리 테크 레터</small></span>${arrow}`, 'article', `data-index="${i}"`)).join('')}</div>`}<div class="detail-actions">${button('news-settings', '관심사 · 시간 설정', 'secondary-button')}${button('refresh-news', icon('repeat') + ' 새로 수집', 'secondary-button', data.news.status === 'loading' ? 'disabled' : '')}</div>${developerPreview ? `<details class="support-details"><summary>브리핑 상태별 화면 체험</summary><div class="state-picker">${[['loading', '수집 중'], ['ready', '완료'], ['failed', '실패']].map(([v, title]) => button('news-state', title, data.news.status === v ? 'selected' : '', `data-value="${v}" aria-pressed="${data.news.status === v}"`)).join('')}</div><p class="field-help">실제 수집 요청 없이 화면 상태를 바꿔보는 옵션이에요.</p></details>` : ''}`);
  else if (kind === 'stock') openSheet('관심 주가', `<div class="detail-title">${mark('chart', 'rose')}<p>관심 종목 · 샘플 시세</p><h2>${esc(data.stock.symbol)}</h2><div class="stock-price">${data.stock.symbol === '코스피' ? '2,650.24' : data.stock.symbol === '애플' ? '228.40' : '72,400'}<small>${data.stock.symbol === '코스피' ? ' pt' : data.stock.symbol === '애플' ? ' USD' : '원'}</small></div><p class="positive">+1.82% <span>등락</span></p></div><div class="stock-chart">${stockCandlestickChart(ui.chart)}<div class="chart-labels">${(ui.chart === '1일' ? ['09:00', '12:00', '15:30'] : ui.chart === '1주' ? ['월', '수', '금'] : ['1일', '15일', '30일']).map(v => `<span>${v}</span>`).join('')}</div></div><div class="segmented">${['1일', '1주', '1달'].map(v => button('chart-range', v, ui.chart === v ? 'selected' : '', `data-value="${v}"`)).join('')}</div><p class="field-help">${ui.chart} 예시 차트 · 빨간 봉은 상승, 파란 봉은 하락을 나타내요.<br>실시간 가격과 투자 정보가 아니에요.</p><div class="detail-facts"><div><span>시장 · 통화</span><strong>${data.stock.symbol === '애플' ? 'NASDAQ · USD' : 'KRX · KRW'}</strong></div><div><span>기준 시각</span><strong>${shortDate(data.stock.at)} ${time(data.stock.at)}</strong></div><div><span>데이터 출처</span><strong>샘플 데이터</strong></div></div>${button('stock-settings', '관심 종목 바꾸기', 'primary-button')}`);
  else if (kind === 'note' && id) { const n = data.notes.find(n => n.id === id); if (!n) return; openSheet('메모', `<div class="detail-title">${mark('note', 'amber')}<p>${shortDate(n.at)} ${time(n.at)}</p><h2>${esc(n.title)}</h2></div><div class="note-body">${esc(n.body)}</div><div class="detail-actions">${button('edit-note', icon('compose') + ' 편집하기', 'secondary-button', `data-id="${id}"`)}${button('delete-note', icon('trash') + ' 삭제', 'secondary-button', `data-id="${id}"`)}</div>`); }
  else if (kind === 'note') { if (!data.notes.length) return noteForm(); ui.recordSearch = ''; recordsSheet('note'); }
  else if (kind === 'schedule') {
    if (!sheetCardOrigin && !presentationSource?.matches('.brief-card')) return closeSheet().then(() => go('schedule'));
    openSheet('스케줄', `<p class="sheet-description">${dateLabel(current())}</p><div class="surface">${todayEvents().map(eventRow).join('') || empty('calendar', '오늘 일정이 없어요', '새 약속을 추가하거나 달력에서 다른 날을 확인하세요.')}</div><div class="detail-actions">${button('new-event', icon('plus') + ' 일정 추가', 'secondary-button')}${button('go-schedule', '달력으로 보기 ' + arrow, 'secondary-button')}</div>`);
  }
  else if (kind === 'event') { const e = data.events.find(e => e.id === id); if (!e) return; const kind = eventKind(e); openSheet('나의 약속', `<div class="event-detail-top">${mark('calendar', kind.value)}${tag(kind.label, kind.value)}</div><div class="detail-title"><h2>${esc(e.title)}</h2><p>${dateLabel(dayDate(e.date))}</p></div><div class="event-detail-time">${icon('clock')}<div><strong>${e.time} <span>– ${eventEnd(e)}</span></strong><small>${eventDuration(e)}분 동안</small></div></div><div class="event-detail-place">${icon('pin')}<span>${esc(e.place || '장소를 정하지 않았어요')}</span></div>${e.memo ? `<div class="note-body">${esc(e.memo)}</div>` : ''}${button('edit-event', icon('compose') + ' 일정 편집하기', 'primary-button', `data-id="${id}"`)}`); }
  else if (kind === 'reminder' && id) { const r = data.reminders.find(r => r.id === id); if (!r) return; const done = current() >= r.target; openSheet('나의 알림', `<div class="timer-scene ${r.cancelled ? 'cancelled' : ''}"><p>${esc(r.title)}</p><div class="timer-ring"><svg viewBox="0 0 240 240" aria-hidden="true"><circle class="timer-track" cx="120" cy="120" r="108"/><circle class="timer-progress" cx="120" cy="120" r="108" stroke-dasharray="679" stroke-dashoffset="0"/></svg><div><span data-countdown="${id}">${r.cancelled ? '중지됨' : remaining(r.target)}</span><small>${r.cancelled ? '다시 시작할 수 있어요' : done ? '목표 시각이 되었어요' : '남은 시간'}</small></div></div><h2>${time(r.target)}</h2><p>기기 알림은 아직 지원하지 않아요</p></div><div class="detail-actions">${button('timer-extend', '+ 5분', 'secondary-button', `data-id="${id}"`)}${button('timer-cancel', r.cancelled ? '다시 30분 시작' : '알림 취소', r.cancelled ? 'primary-button' : 'secondary-button', `data-id="${id}"`)}</div>${developerPreview ? `<details class="support-details"><summary>알림 완료 화면 미리보기</summary><p class="field-help">체험 시간을 이 알림의 목표 시각으로 이동해요.</p>${button('timer-finish', '목표 시각으로 이동하기', 'text-button full', `data-id="${id}"`)}</details>` : ''}`, 'timer-sheet'); }
  else if (kind === 'reminder') openSheet('알림', `<div class="form-intro">${mark('bell', 'orange')}<h3>언제 챙겨드릴까요?</h3><p>몇 분 뒤에 알릴지 선택하세요.</p></div><div class="reminder-presets">${[5, 15, 30, 60].map(m => button('preset-reminder', `<b>${m}</b><span>분 뒤</span>`, '', `data-minutes="${m}"`)).join('')}</div><div class="surface">${data.reminders.map(r => button('detail', `${mark('bell', 'orange')}<span class="row-content"><strong>${esc(r.title)}</strong><small>${r.cancelled ? '중지됨' : r.target <= current() ? '완료된 알림' : `${time(r.target)} · ${remaining(r.target)}`}</small></span>${arrow}`, 'record-row', `data-ref="reminder:${r.id}"`)).join('')}</div>`);
  else if (kind === 'custom') { const f = data.customs.find(f => f.id === id); if (!f) return; openSheet('나만의 기능', `<div class="detail-title">${mark(f.icon, 'purple')}<p>내 기능 · 버전 ${f.version}</p><h2>${esc(f.title)}</h2>${f.description ? `<p>${esc(f.description)}</p>` : ''}${tag(!f.work ? '초안' : f.active ? '사용 중' : '잠시 중지', f.active ? 'green' : '')}</div><div class="work-card"><span class="tiny-label">이렇게 도와드려요</span><p>${esc(f.work || '어떤 일을 할지 편집에서 추가해 주세요.')}</p><div>${icon('clock')} ${esc(f.time ? `${f.repeat} ${clockLabel(f.time)}` : '필요할 때 직접 실행')}</div></div>${f.content ? `<div class="note-body">${esc(f.content)}</div>` : ''}${f.result ? `<div class="section-heading"><h3>최근 실행 결과</h3><small>${time(f.result.at)} · v${f.result.version}</small></div><div class="checklist">${f.result.items.map((item, i) => button('check-item', `<span class="check-box ${item.done ? 'checked' : ''}">${item.done ? icon('check') : ''}</span><span>${esc(item.text)}</span>`, item.done ? 'done' : '', `data-id="${id}" data-index="${i}" aria-pressed="${item.done}"`)).join('')}</div><p class="field-help">저장한 메모에서 정리한 할 일이에요.</p>` : '<p class="field-help">아직 실행 결과가 없어요. 지금 실행해 보세요.</p>'}<div class="detail-actions">${button('edit-custom', '편집', 'secondary-button', `data-id="${id}"`)}${button('toggle-custom', f.active ? '잠시 중지' : '다시 켜기', 'secondary-button', `data-id="${id}"`)}</div>${button('run-custom', icon('spark') + ' 지금 실행하기', 'primary-button', `data-id="${id}" ${!f.active || !f.work ? 'disabled' : ''}`)}`); }
  else if (kind === 'document') return documentDetail(id);
  if (!$('#sheet').hasAttribute('data-closing')) ui.detail = ref;
}
function guide() {
  const row = (iconName, color, title, description, promptText) => button('prompt', `${mark(iconName, color)}<span class="guide-option-copy"><strong>${title}</strong><small>${description}</small></span>${arrow}`, 'guide-option', `data-prompt="${esc(promptText)}"`);
  const groups = [
    ['기억하고 정리하기', [
      row('car', 'green', '주차 위치 기억', '주차한 층과 자리를 남겨요', '지하 3층 B16에 주차했어. 내일 출근할 때 알려줘'),
      row('calendar', 'purple', '약속 등록', '시간과 장소를 일정에 넣어요', '내일 오후 2시 디자인 미팅 일정 추가해줘'),
      row('note', 'amber', '메모 남기기', '떠오른 생각을 기록해요', '이번 주말에 한강 산책하기 메모해줘'),
      button('document', `${mark('file', 'blue')}<span class="guide-option-copy"><strong>파일 가져오기</strong><small>기기의 텍스트 파일을 보관해요</small></span>${arrow}`, 'guide-option'),
    ]],
    ['시간에 맞춰 챙기기', [
      row('news', 'blue', '뉴스 브리핑', '매일 관심 뉴스를 모아요', '매일 오전 9시에 AI 뉴스를 수집해서 정리해줘'),
      row('chart', 'rose', '관심 주가 확인', '관심 종목의 시세를 살펴봐요', '삼성전자 주가 알려줘'),
      row('bell', 'orange', '알림 맞추기', '원하는 시간에 알려드려요', '30분 뒤에 잠깐 쉬라고 알림 줘'),
      row('spark', 'purple', '내 기능 만들기', '반복할 일과 시간을 정해요', '매일 저녁 8시에 오늘 메모를 모아서 정리하는 기능 만들어줘. 제목은 하루 마무리로 해줘'),
    ]],
  ];
  openSheet('모리 둘러보기', `<div class="guide-summary"><img src="/assets/mori.svg" alt=""><p>필요한 도움을 골라 모리에게 부탁해 보세요.</p></div>${groups.map(([title, rows], index) => `<section class="guide-section" aria-labelledby="guide-group-${index}"><h3 id="guide-group-${index}">${title}</h3><div class="guide-options">${rows.join('')}</div></section>`).join('')}`, 'guide-sheet');
}
function dayPreview() {
  const choices = [[8, 40, 'sun', '아침', '출근길 주차 위치'], [9, 0, 'news', '브리핑', '뉴스 수집과 요약'], [13, 0, 'sun', '낮', '관심 주가와 다음 약속'], [19, 0, 'moon', '저녁', '퇴근 정리와 하루 마무리']];
  openSheet('체험 시간', `<p class="sheet-description">시간을 골라 대시보드가 어떻게 달라지는지 확인해 보세요.</p><div class="time-choices">${choices.map(([h, m, i, title, desc]) => button('set-clock', `${mark(i, h < 18 ? 'amber' : 'purple')}<span><strong>${title}</strong><small>${desc}</small></span><time datetime="${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}">${h}:${String(m).padStart(2, '0')}</time>`, 'time-choice', `data-hour="${h}" data-minute="${m}"`)).join('')}</div><p class="guide-footnote">시간을 바꿔도 기록과 예약은 유지돼요.</p>`, 'time-preview-sheet');
}
function persistDraft() { const key = ui.chatId || 'new', value = $('#chat-input').value; if (value) data.drafts[key] = value; else delete data.drafts[key]; save(); }
function syncComposer() {
  const input = $('#chat-input');
  const messages = $('#messages');
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  input.rows = 1;
  input.style.height = 'auto';
  if (input.scrollHeight) input.style.height = `${Math.min(input.scrollHeight, parseFloat(getComputedStyle(input).maxHeight) || 160)}px`;
  // Reserve only the editable rail in the conversation. Voice expands above
  // it without resizing or removing the messages behind the glass.
  $('#chat-panel').style.setProperty('--composer-rail-height', `${$('.composer-editor').offsetHeight || 44}px`);
  if (nearBottom) messages.scrollTop = messages.scrollHeight;
  $('#chat-send').disabled = !input.value.trim() || input.value.length > 4000 || busy.has(ui.chatId) || voiceActive();
}
function openChat(id = null, returnSource = null) {
  if ($('#chat-panel').open) persistDraft();
  stopVoice();
  ui.chatId = id; $('#chat-input').value = data.drafts[id || 'new'] || '';
  $('#chat-announcement').textContent = '';
  const source = [returnSource, presentationSource, $('#main [data-action=new-chat]'), $('#main [data-action=guide]'), $('#quick-composer [data-action=new-chat]'), $('#tabs [aria-current=page]')].find(isAvailableControl);
  renderChat(true); presentations.show($('#chat-panel'), { source, kind: 'chat' }); syncComposer(); moveToast();
}
function renderChat(forceScroll = false) {
  if ($('#chat-panel').dataset.closing) return;
  const c = data.conversations.find(c => c.id === ui.chatId), messages = $('#messages');
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100, scroll = messages.scrollTop;
  $('#chat-title').textContent = c?.title || '모리';
  $('#chat-options').hidden = !c;
  messages.innerHTML = !c?.messages.length ? `<div class="chat-welcome"><span class="voice-emblem" aria-hidden="true"><i class="fluid-layer"></i><i class="fluid-layer"></i><i class="fluid-layer"></i></span><p>내 곁의 작은 비서</p><h2>무엇을 챙겨드릴까요?</h2><span>문득 떠오른 생각부터, 잊고 싶지 않은 일까지.<br>편하게 이야기해 주세요.</span></div><div class="chat-suggestions">${[['car', '주차 위치 기억하기', '지하 3층 B16에 주차했어'], ['note', '떠오른 생각 남기기', '메모해줘: '], ['spark', '내 기능 실행하기', '퇴근 정리 실행해줘']].map(([i, title, t]) => button('chat-example', `${mark(i)}<span>${title}</span>${arrow}`, '', `data-prompt="${esc(t)}"`)).join('')}</div>` : c.messages.map(m => `<div class="message ${m.role}">${m.role === 'assistant' ? `<span class="assistant-avatar">${icon('spark')}</span>` : ''}<div><p>${esc(m.text)}</p>${m.ref ? button('detail', `${icon('check')}<span><small>부탁한 일의 결과</small><strong>${referenceTitle(m.ref)}</strong></span>${arrow}`, 'message-result', `data-ref="${m.ref}"`) : ''}</div></div>`).join('');
  if (busy.has(ui.chatId)) messages.insertAdjacentHTML('beforeend', `<div class="assistant-progress"><span class="typing"><i></i><i></i><i></i></span> 내 기능과 요청을 확인하고 있어요</div>`);
  syncComposer(); messages.scrollTop = forceScroll || nearBottom ? messages.scrollHeight : scroll;
  motion.messages(messages, ui.chatId || 'new');
}
function announceChat(message, id) {
  if (ui.chatId === id && $('#chat-panel').open) $('#chat-announcement').textContent = message;
}
function referenceTitle(ref) { const [kind, id] = ref.split(':'); return esc(({ parking: '주차 위치 확인', news: '뉴스 브리핑 보기', stock: '관심 주가 보기', note: '저장한 메모 보기', reminder: '카운트다운 보기', event: '저장한 일정 보기', custom: data.customs.find(f => f.id === id)?.title || '내 기능 보기' })[kind] || '결과 보기'); }
async function send(raw, { preserveDraft = false } = {}) {
  const text = raw.trim(); if (!text || text.length > 4000 || busy.has(ui.chatId) || voiceActive()) return;
  if (voiceExpanded && !$('#voice-fallback').hidden && $('#voice-transcript').value.trim()) {
    $('#voice-transcript').focus();
    return toast('인식한 내용을 입력창에 추가하거나 취소한 뒤 보내세요.');
  }
  stopVoice();
  const retainedDraft = preserveDraft ? $('#chat-input').value : '';
  const wasNew = !ui.chatId; let c = data.conversations.find(c => c.id === ui.chatId); if (!c) { c = { id: uid(), title: text.slice(0, 26), at: current(), messages: [] }; data.conversations.unshift(c); ui.chatId = c.id; }
  const request = c.awaiting && !preserveDraft ? `${c.awaiting === 'parking' ? '주차 ' : '알림 '}${text}` : text; c.awaiting = null;
  c.messages.push({ role: 'user', text }); c.at = current(); const id = c.id; busy.add(id); delete data.drafts[id]; if (wasNew) delete data.drafts.new; if (retainedDraft) data.drafts[id] = retainedDraft; $('#chat-input').value = retainedDraft; save(); renderChat(true);
  announceChat('요청을 확인하고 있어요.', id);
  await new Promise(resolve => setTimeout(resolve, 650));
  if (!data.conversations.includes(c)) { busy.delete(id); return; }
  const reply = applyRequest(data, request); c.messages.push({ role: 'assistant', ...reply }); c.awaiting = reply.followup; busy.delete(id); save(); render(); if (ui.chatId === id) renderChat();
  announceChat(reply.text, id);
  if (reply.ref?.startsWith('reminder:') && $('#chat-panel').open && !$('#chat-panel').dataset.closing && ui.chatId === id && !$('#sheet').open && !voiceExpanded) openDetail(reply.ref);
}
async function prompt(text) {
  const origin = sheetOrigin;
  await closeSheet();
  if (!$('#chat-panel').open) openChat(null, resolveControl(origin?.root, origin?.control, { visible: true }));
  send(text, { preserveDraft: true });
}
function voiceActive() { return ['requesting', 'listening', 'processing'].includes(voiceSession.state.phase); }
function abortRecognition() {
  clearTimeout(voiceEndTimer);
  const session = recognition; recognition = null;
  if (!session) return;
  session.onstart = session.onend = session.onerror = session.onresult = null;
  try { session.abort(); } catch { /* A browser may already have ended the session. */ }
}
async function openVoice() {
  const source = presentationSource;
  if ($('#sheet').open) await closeSheet();
  if (!$('#chat-panel').open) openChat(ui.chatId, source);
  if (voiceExpanded) return closeVoice();
  voiceSession.reset($('#chat-input').value);
  voiceExpanded = true; voiceFallbackEdited = false; $('#voice-transcript').value = '';
  renderVoice(); $('#record-button').focus({ preventScroll: true });
}
function renderVoice({ animate = true } = {}) {
  const state = voiceSession.state, active = voiceActive();
  const supported = voicePreviewing || Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const form = $('#chat-form');
  const phaseChanged = form.dataset.voicePhase !== state.phase;
  const expansionChanged = form.classList.contains('voice-expanded') !== voiceExpanded;
  const changed = phaseChanged || expansionChanged;
  const layoutChanged = expansionChanged || phaseChanged && ['idle', 'requesting', 'ready', 'error'].includes(state.phase);
  const previous = animate && layoutChanged && $('#chat-panel').open && !$('#chat-panel').dataset.closing
    ? presentations.captureReplacement(form, { settle: true, anchor: '.composer-editor' }) : null;
  // Commit the voice layout once. Animating the flex item's height squeezes the
  // message list and its nested scroll region on every frame, producing a
  // scrollbar pulse and moving the transcript while people are reading it.
  if (changed) voiceLayoutAnimation?.cancel();
  $('#voice-input').hidden = !voiceExpanded;
  $('.voice-eyebrow').textContent = voicePreviewing ? '음성 UI 체험 · 실제 녹음 아님' : '모리 음성 입력';
  $('#chat-form').classList.toggle('voice-expanded', voiceExpanded);
  $('#chat-form').dataset.voicePhase = state.phase;
  $('#chat-mic').setAttribute('aria-expanded', String(voiceExpanded));
  $('#chat-mic').setAttribute('aria-label', voiceExpanded ? '음성 입력 접기' : '음성 입력 열기');
  $('#chat-input').readOnly = active;
  $('#chat-input').placeholder = active ? '녹음을 마치면 이어 쓸 수 있어요' : '무엇이든 편하게 말해 주세요';
  $('#voice-examples').hidden = active;
  const messages = {
    idle: supported ? '시작 버튼을 누르면 듣기 시작해요.' : '이 브라우저는 음성 입력을 지원하지 않아요. 메시지 입력창에 직접 써 주세요.',
    requesting: '마이크 연결을 기다리고 있어요. 브라우저의 권한 요청을 확인해 주세요.',
    listening: '떠오르는 대로 이야기해 주세요.',
    processing: '말한 내용을 정리하고 있어요.',
    ready: '내용을 확인한 뒤 보내 주세요.',
    error: ({ 'not-allowed': '마이크 권한이 꺼져 있어요. 권한을 바꾸거나 아래에 직접 입력하세요.', 'service-not-allowed': '이 브라우저에서 음성 인식을 사용할 수 없어요. 아래에 직접 입력하세요.', 'audio-capture': '마이크를 찾지 못했어요. 연결을 확인하거나 아래에 직접 입력하세요.', 'no-speech': '말소리를 듣지 못했어요. 다시 말하거나 아래에 직접 입력하세요.', network: '음성 인식 연결이 끊겼어요. 다시 시도하거나 아래에서 이어 쓰세요.', limit: '기존 메시지와 합치면 4,000자를 넘어요. 인식한 말을 줄인 뒤 다시 추가하세요.' })[state.error] || '음성 인식을 시작하지 못했어요. 다시 시도하거나 아래에 직접 입력하세요.',
  };
  $('#voice-subtitle').textContent = messages[state.phase];
  $('#voice-title').textContent = ({ requesting: '잠시만 기다려 주세요', listening: '듣고 있어요', processing: '말씀을 담고 있어요', ready: '입력창에 담았어요', error: '다시 이어가 볼까요?' })[state.phase] || '편하게 말해 주세요';
  $('#voice-preview').textContent = state.transcript || (state.phase === 'listening' ? '말한 내용이 여기에 나타나요' : '');
  $('#voice-preview').hidden = !state.transcript && !active;
  const record = $('#record-button');
  record.disabled = !supported || state.phase === 'processing';
  record.hidden = !supported;
  const recordLabel = ({ requesting: '요청 취소', listening: '녹음 마치기', processing: '인식 중', ready: '이어서 녹음' })[state.phase] || '말하기 시작';
  record.setAttribute('aria-label', state.phase === 'requesting' ? '마이크 요청 취소' : recordLabel);
  record.setAttribute('aria-busy', String(state.phase === 'processing'));
  // Keep the control mounted while interim transcripts arrive. Only its glyph
  // and label change, so the symbol's surface and focus feedback stay intact.
  record.querySelector('use').setAttribute('href', ['requesting', 'listening'].includes(state.phase) ? '#i-stop' : '#i-mic');
  if (record.querySelector('.record-label').textContent !== recordLabel) record.querySelector('.record-label').textContent = recordLabel;
  // A second editor is only recovery for an unfinished recognition result.
  // Ordinary typing always belongs to the existing message input.
  const fallback = !active && state.phase === 'error' && Boolean(state.transcript.trim());
  $('#voice-fallback').hidden = !fallback;
  $('#voice-service-note').hidden = !voicePreviewing;
  $('#voice-service-note').textContent = voicePreviewing ? '마이크를 사용하지 않는 음성 입력 미리보기예요.' : '';
  updateVoiceInput(); syncComposer();
  if (previous) {
    presentations.replace(form, { previous, vertical: true, back: !voiceExpanded });
  } else if (animate && changed && $('#chat-panel').open && !$('#chat-panel').dataset.closing && !data.profile.reduced) {
    // Reopening reveals the voice surface once. A status change only introduces
    // its new label; the moving emblem and readable transcript stay undisturbed.
    const surface = expansionChanged ? voiceExpanded ? $('#voice-input') : null : $('#voice-title').parentElement;
    if (!surface) return;
    voiceLayoutAnimation = surface.animate([
      { opacity: expansionChanged ? .2 : .65, transform: `translateY(${expansionChanged ? 8 : 2}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: expansionChanged ? 260 : 160, easing: 'cubic-bezier(.22,.8,.2,1)' });
  }
}
function updateVoiceInput() { $('#voice-send').disabled = !$('#voice-transcript').value.trim(); }
function settleVoice({ edited = false } = {}) {
  const state = voiceSession.state;
  if (state.phase === 'ready') {
    $('#chat-input').value = state.draft; $('#voice-transcript').value = ''; voiceFallbackEdited = false; persistDraft();
  } else if (state.phase === 'error') {
    $('#voice-transcript').value = state.transcript; voiceFallbackEdited = edited;
  }
  renderVoice();
}
function voiceToChat(text = $('#voice-transcript').value) {
  abortRecognition();
  voiceSession.accept(text, $('#chat-input').value);
  settleVoice({ edited: voiceFallbackEdited });
}
function suspendVoice() {
  // Stop the microphone immediately, but keep the current visual state intact
  // until the chat's return transition has completed.
  voiceDemo.cancel(); abortRecognition();
}
function stopVoice({ animate = false } = {}) {
  voiceDemo.cancel(); voicePreviewing = false;
  abortRecognition(); voiceSession.reset($('#chat-input').value);
  voiceExpanded = false; voiceFallbackEdited = false;
  renderVoice({ animate });
}
function closeVoice(keyboard = false) {
  if (keyboard && !$('#voice-fallback').hidden && $('#voice-transcript').value.trim()) {
    voiceToChat();
    if (voiceSession.state.phase !== 'ready') { $('#voice-transcript').focus(); return; }
  }
  // During recording the editable draft has not changed. A finished recording
  // already belongs to it, so switching to the keyboard keeps that text too.
  stopVoice({ animate: true }); persistDraft();
  (keyboard ? $('#chat-input') : $('#chat-mic')).focus({ preventScroll: true });
}
function recordVoice() {
  if (voiceDemo.active) return voiceDemo.finish();
  voicePreviewing = false;
  const phase = voiceSession.state.phase;
  if (phase === 'requesting') { abortRecognition(); voiceSession.cancel(); return renderVoice(); }
  if (phase === 'processing') return;
  if (phase === 'listening') {
    const id = voiceSession.state.id;
    voiceSession.processing(id); renderVoice();
    voiceEndTimer = setTimeout(() => {
      if (voiceSession.state.id !== id || voiceSession.state.phase !== 'processing') return;
      abortRecognition(); voiceSession.fail(id, 'network'); settleVoice();
    }, 10000);
    try { recognition?.stop(); } catch { abortRecognition(); voiceSession.finish(id); settleVoice(); }
    return;
  }
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return renderVoice();
  if (voiceFallbackEdited && !$('#voice-fallback').hidden && $('#voice-transcript').value.trim()) {
    $('#voice-transcript').focus();
    return toast('수정한 내용을 먼저 입력창에 추가하거나 취소해 주세요.');
  }
  abortRecognition(); voiceFallbackEdited = false;
  const id = voiceSession.begin($('#chat-input').value);
  renderVoice();
  try {
    const session = new Speech(); recognition = session;
    session.lang = 'ko-KR'; session.interimResults = true; session.continuous = false;
    const currentSession = () => recognition === session && $('#chat-panel').open && !$('#chat-panel').dataset.closing && voiceSession.state.id === id;
    session.onstart = () => { if (!currentSession()) return; voiceSession.listening(id); renderVoice(); };
    session.onresult = event => {
      if (!currentSession()) return;
      voiceSession.update(id, Array.from(event.results, result => ({ text: result[0]?.transcript || '', final: result.isFinal })));
      renderVoice();
    };
    session.onerror = event => {
      if (!currentSession()) return;
      abortRecognition(); voiceSession.fail(id, event.error); settleVoice();
    };
    session.onend = () => {
      if (!currentSession()) return;
      clearTimeout(voiceEndTimer); recognition = null; session.onstart = session.onend = session.onerror = session.onresult = null;
      voiceSession.finish(id); settleVoice();
    };
    session.start();
  } catch {
    abortRecognition(); voiceSession.fail(id, 'start'); settleVoice();
  }
}
function documentSheet() {
  openSheet('파일 가져오기', `<p class="sheet-description">텍스트 파일을 기록 보관함에 추가해요.</p><label class="upload-zone">${mark('file', 'blue')}<strong>파일 선택</strong><span>TXT · MD · CSV, 최대 10MB</span><input id="document-upload" type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" aria-label="가져올 텍스트 파일 선택"></label><p class="document-storage-note">원문은 이 기기에 보관돼요.</p>${button('sample-document', `${mark('note', 'amber')}<span class="guide-option-copy"><strong>예시 파일로 살펴보기</strong><small>회의 메모를 보관함에 추가해요</small></span>${arrow}`, 'document-sample-row')}<p class="guide-footnote">Word·Excel·PDF 파일은 아직 지원하지 않아요.</p>`, 'document-import-sheet');
}
async function documentDetail(id) {
  const d = data.documents.find(d => d.id === id); if (!d) return;
  const ref = `document:${id}`;
  openSheet('문서', '<p class="sheet-description" role="status">원문을 불러오고 있어요.</p>', '', { ref }); ui.detail = ref;
  const epoch = ui.sheetEpoch;
  try {
    const source = await readOriginal(d); if (epoch !== ui.sheetEpoch || !$('#sheet').open) return;
    const bytes = d.size_bytes ?? new TextEncoder().encode(source).length;
    openSheet('문서', `<div class="detail-title">${mark('file', 'blue')}<h2>${esc(d.title)}</h2></div><div class="document-meta">${tag(d.filename.split('.').at(-1).toUpperCase(), 'blue')}<span>${formatBytes(bytes)}</span><span>원문 보관</span></div><div class="work-card"><span class="tiny-label">원문 미리보기</span><pre class="document-source">${esc(source.slice(0, 12000))}</pre></div>${source.length > 12000 ? '<p class="field-help">앞부분 12,000자만 보여드려요. 내려받으면 원문 전체를 확인할 수 있어요.</p>' : ''}<div class="file-result">${icon('file')}<div><strong>${esc(d.filename)}</strong><small>${shortDate(d.at)} 보관 · ${formatBytes(bytes)}</small></div></div>${button('download', icon('download') + ' 원문 다운로드', 'primary-button', `data-id="${id}"`)}`, '', { ref }); ui.detail = ref;
  } catch (err) { if (epoch === ui.sheetEpoch && $('#sheet').open) openSheet('문서를 열지 못했어요', `<p class="sheet-description">${esc(err.message || '저장소를 확인해 주세요.')}</p>${button('document', '파일 다시 불러오기', 'primary-button')}`, '', { ref }); }
}
async function saveDocument(name, content, sheetEpoch = ui.sheetEpoch) {
  const d = documentRecord(uid(), name, content, current());
  await storeOriginal(d.id, content);
  data.documents.unshift(d);
  if (!save()) { data.documents.shift(); throw new Error('보관함 저장 공간이 부족해요. 다른 기록을 정리한 뒤 다시 불러와 주세요.'); }
  render(); if (sheetEpoch === ui.sheetEpoch && $('#sheet').open && !$('#sheet').hasAttribute('data-closing')) await openDetail(`document:${d.id}`);
  else toast('파일을 기록 보관함에 저장했어요.');
}
function profileDetails() {
  const user = ui.liveUser;
  openSheet('사용자 정보', `<div class="detail-title">${mark('user')}<h2>${esc(user.display_name)}님</h2><p>내 곁의 작은 비서, 모리</p></div><dl class="account-facts"><div><dt>이름</dt><dd>${esc(user.display_name)}</dd></div><div><dt>연결된 계정</dt><dd>${user.providers.map(p => p === 'naver' ? '네이버' : '카카오').join(' · ')}</dd></div><div><dt>이용 요금제</dt><dd>${user.tier === 'pro' ? 'Pro' : 'Free'}</dd></div>${user.created_at ? `<div><dt>가입일</dt><dd>${new Date(user.created_at).toLocaleDateString('ko-KR')}</dd></div>` : ''}</dl>${button('edit-profile', '사용자 정보 수정', 'primary-button full')}`, '', { restore: profileDetails });
}
async function accountSheet() {
  openSheet('내 계정', '<p class="sheet-description" role="status">계정 정보를 확인하고 있어요.</p>', 'login-sheet');
  const sheetEpoch = ui.sheetEpoch;
  const loaded = await loadAccount(); if (loaded === null || sheetEpoch !== ui.sheetEpoch || !$('#sheet').open) return;
  if (!loaded) return openSheet('내 계정', empty('cloud', '연결을 확인해 주세요', '계정 정보를 불러오지 못했어요.', button('account', '다시 시도', 'primary-button')), 'login-sheet');
  if (ui.liveUser) return profileDetails();
  const epoch = ui.sheetEpoch;
  try {
    const providers = await api('/providers'); if (epoch !== ui.sheetEpoch || !$('#sheet').open) return;
    openSheet('로그인', `<div class="form-intro">${mark('user')}<h3>계정 연결</h3><p>네이버 또는 카카오 계정으로 로그인하세요.</p></div><div class="social-login-options">${providers.map(p => button('login', `${p.provider === 'naver' ? '네이버' : '카카오'}로 계속하기`, `social-login ${p.provider}`, `data-provider="${p.provider}" ${p.enabled ? '' : 'disabled'}`)).join('')}</div>${providers.some(p => !p.enabled) ? '<p class="field-help center">사용할 수 없는 로그인 연결은 준비 중이에요.</p>' : ''}`, 'login-sheet');
  } catch { if (epoch === ui.sheetEpoch && $('#sheet').open) openSheet('로그인', empty('cloud', '로그인 정보를 불러오지 못했어요', '잠시 후 다시 시도해 주세요.', button('account', '다시 시도', 'primary-button')), 'login-sheet'); }
}
function themeSheet() {
  openSheet('테마', `<p class="sheet-description">시스템 설정을 선택하면 기기에 맞춰 자동으로 바뀌어요.</p><form id="theme-form"><fieldset class="theme-options"><legend class="sr-only">화면 테마</legend>${[['system', '시스템 설정', '기기 설정에 맞춰 자동으로'], ['light', '라이트', '밝고 산뜻한 화면'], ['dark', '다크', '차분하고 편안한 화면']].map(([value, label, copy]) => `<label class="theme-option"><input type="radio" name="theme" value="${value}" ${selectedTheme === value ? 'checked' : ''}><span class="theme-preview ${value}" aria-hidden="true"><i></i><i></i></span><span><strong>${label}</strong><small>${copy}</small></span>${icon('check')}</label>`).join('')}</fieldset><p class="form-error" role="alert"></p><button type="submit" class="primary-button full">적용하기</button><p class="field-help center">${ui.liveUser ? '내 계정에 저장해요.' : '로그인 전에는 이 기기에 적용해요.'}</p></form>`, 'theme-sheet');
}
async function subscriptionSheet() {
  openSheet('요금제 및 결제', '<p class="sheet-description" role="status">요금제를 확인하고 있어요.</p>', 'plans-sheet');
  const epoch = ui.sheetEpoch;
  try {
    const [plans, subscription] = await Promise.all([api('/plans'), ui.liveUser ? api('/subscription') : Promise.resolve(null)]);
    if (epoch !== ui.sheetEpoch || !$('#sheet').open) return;
    openSheet('요금제 및 결제', `<div class="form-intro">${mark('spark', 'purple')}<h3>나에게 맞는 모리</h3><p>${esc(subscription?.message || 'Free와 Pro의 이용 상태를 확인하세요.')}</p></div><div class="account-plan-options">${plans.map(plan => `<article class="account-plan-option ${subscription?.plan === plan.id ? 'selected' : ''}"><header><span>${plan.name}</span>${subscription?.plan === plan.id ? tag('이용 중') : ''}</header><h3>${plan.amount === null ? '준비 중' : plan.amount === 0 ? '무료' : plan.amount.toLocaleString('ko-KR') + '원'}</h3><p>${esc(plan.description)}</p>${plan.id === 'free' ? button(ui.liveUser ? 'close' : 'account', subscription?.plan === 'pro' ? '기본 요금제' : ui.liveUser ? '무료로 계속 이용하기' : '무료로 시작하기', 'secondary-button full', subscription?.plan === 'pro' ? 'disabled' : '') : '<button type="button" class="primary-button full" disabled>Pro 결제 준비 중</button>'}</article>`).join('')}</div><div class="subscription-cancel"><strong>Pro 구독 해지</strong><p>${subscription?.access_source === 'admin_approval' ? '관리자 승인 이용권은 결제 구독이 아니에요.' : '현재 해지할 결제 구독이 없어요.'}</p><button type="button" class="secondary-button full" disabled>결제 취소 · 구독 해지</button></div><p class="field-help">Pro 가격과 결제 서비스는 준비 중이에요. 결제 연결 전에는 요금이 청구되지 않아요.</p>`, 'plans-sheet');
  } catch { if (epoch === ui.sheetEpoch && $('#sheet').open) openSheet('요금제 및 결제', empty('cloud', '요금제를 불러오지 못했어요', '잠시 후 다시 시도해 주세요.', button('license', '다시 시도', 'primary-button')), 'plans-sheet'); }
}

document.addEventListener('click', async event => {
  if (event.target.closest('.skip-link')) { event.preventDefault(); $('#main').focus({ preventScroll: true }); return; }
  const nav = event.target.closest('[data-view]'); if (nav) return go(nav.dataset.view);
  const el = event.target.closest('[data-action]'); if (!el || el.disabled) return; const a = el.dataset.action, id = el.dataset.id;
  if (a.startsWith('go-')) { await closeSheet(); return go(a.slice(3)); }
  if (a === 'close') return closeSheet();
  if (a === 'sheet-back') return backSheet();
  if (a === 'discard-form-draft') { const form = draftForm(); formDrafts.discard(form); form?.querySelector('.draft-notice')?.remove(); const error = form?.querySelector('.form-error'); if (error) error.textContent = ''; syncDraftForm(); form?.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea')?.focus(); return; }
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
  if (a === 'records') { ui.recordSearch = ''; return recordsSheet(); }
  if (a === 'record-filter') return recordsSheet(el.dataset.value);
  if (a === 'clear-search') { ui.search = ''; render(); return $('#conversation-search').focus(); }
  if (a === 'chat-options') return conversationOptions();
  if (a === 'pin-conversation') { const c = data.conversations.find(c => c.id === id); c.pinned = !c.pinned; save(); closeSheet(); render(); return toast(c.pinned ? '대화를 목록 위에 고정했어요.' : '고정을 해제했어요.'); }
  if (a === 'undo-note') { if (!deletedNote) return; data.notes.push(deletedNote); deletedNote = null; save(); render(); return toast('메모를 다시 가져왔어요.'); }
  if (a === 'detail') return openDetail(el.dataset.ref);
  if (a === 'carousel') return $('#time-carousel')?.children[Number(el.dataset.index)]?.scrollIntoView({ behavior: data.profile.reduced ? 'instant' : 'smooth', block: 'nearest', inline: 'start' });
  if (a === 'carousel-page') {
    const rail = $('#time-carousel');
    const step = rail.firstElementChild.getBoundingClientRect().width + 12;
    rail.scrollBy({ left: Number(el.dataset.direction) * step, behavior: data.profile.reduced ? 'instant' : 'smooth' });
    return;
  }
  if (a === 'guide') return guide();
  if (a === 'day-preview') { closeWindowMenu(); return dayPreview(); }
  if (a === 'set-clock') { setClock(data, Number(el.dataset.hour), Number(el.dataset.minute)); tickScheduled(data); save(); closeSheet(); go('dashboard'); render(); return toast('체험 시간을 바꿨어요. 지금 필요한 카드를 살펴보세요.'); }
  if (a === 'new-chat') return openChat();
  if (a === 'open-conversation') return openChat(id);
  if (a === 'close-chat') { suspendVoice(); return presentations.dismiss($('#chat-panel')); }
  if (a === 'prompt') return prompt(el.dataset.prompt);
  if (a === 'chat-example') { if (voiceActive()) return toast('녹음을 마치거나 취소한 뒤 예시를 골라 주세요.'); if ($('#chat-input').value.trim()) { $('#chat-input').focus(); return toast('작성 중인 메시지를 먼저 보내거나 지워 주세요.'); } $('#chat-input').value = el.dataset.prompt; persistDraft(); syncComposer(); return $('#chat-input').focus(); }
  if (a === 'voice') return openVoice();
  if (a === 'voice-close') return closeVoice();
  if (a === 'record') return recordVoice();
  if (a === 'voice-example') return voiceToChat(el.dataset.text);
  if (a === 'voice-send') return voiceToChat();
  if (a === 'edit-parking') return parkingForm();

  if (a === 'new-note' || a === 'edit-note') return noteForm(id);
  if (a === 'delete-note') { const n = data.notes.find(n => n.id === id); deletedNote = n; data.notes = data.notes.filter(n => n.id !== id); save(); closeSheet(); render(); return toast(`‘${n.title}’ 메모를 삭제했어요.`, 'undo-note'); }
  if (a === 'new-event' || a === 'edit-event') return eventForm(id, el.dataset.date || ui.date, el.dataset.time || '14:00');
  if (a === 'delete-event') { deletedEvent = data.events.find(event => event.id === id); data.events = data.events.filter(event => event.id !== id); save(); closeSheet(); render(); return toast('약속을 삭제했어요.', 'undo-event'); }
  if (a === 'undo-event') { if (!deletedEvent) return; data.events.push(deletedEvent); deletedEvent = null; save(); render(); return toast('약속을 다시 가져왔어요.'); }
  if (a === 'select-date') { ui.date = el.dataset.date; ui.month = dayDate(ui.date); render(); document.querySelector(`[data-date="${ui.date}"][aria-pressed]`)?.focus({ preventScroll: true }); return; }
  if (a === 'calendar-mode') { ui.calendar = el.dataset.value; render(); document.querySelector(`[data-action=calendar-mode][data-value=${ui.calendar}]`)?.focus({ preventScroll: true }); return; }
  if (a === 'calendar-today') { ui.date = dateKey(current()); ui.month = new Date(current()); ui.month.setDate(1); render(); document.querySelector('[data-action=calendar-today]')?.focus({ preventScroll: true }); return; }
  if (a === 'month-prev' || a === 'month-next') { ui.date = moveDate(ui.date, a === 'month-prev' ? -1 : 1, ui.calendar); ui.month = dayDate(ui.date); render(); document.querySelector(`[data-action=${a}]`)?.focus({ preventScroll: true }); return; }
  if (a === 'calendar-jump') return calendarJump();
  if (a === 'jump-year') return calendarJump(ui.jumpYear + Number(el.dataset.delta));
  if (a === 'jump-month') { const selected = dayDate(ui.date); ui.date = moveDate(ui.date, (ui.jumpYear - selected.getFullYear()) * 12 + Number(el.dataset.month) - selected.getMonth(), 'month'); ui.month = dayDate(ui.date); closeSheet(); return render(); }
  if (a === 'feature-filter') { ui.filter = el.dataset.value; render(); return document.querySelector(`[data-action=feature-filter][data-value=${ui.filter}]`)?.focus({ preventScroll: true }); }
  if (a === 'new-custom' || a === 'edit-custom') return customForm(id);
  if (a === 'custom-example') { const form = $('#custom-form'); form.elements.title.value = '하루 마무리'; form.elements.work.value = '오늘 저장한 메모를 모아서 할 일을 정리하기'; form.elements.description.value = '오늘 메모에서 할 일을 정리해요'; form.elements.time.value = '19:00'; setChoice(form.querySelector('[name=repeat]').closest('[data-choice]'), '평일'); updateCustomPreview(); return; }
  if (a === 'toggle-custom') { const f = data.customs.find(f => f.id === id); if (!f.work) return toast('편집에서 어떤 일을 할지 먼저 추가해 주세요.'); f.active = !f.active; save(); render(); return openDetail(`custom:${id}`); }
  if (a === 'run-custom') { const f = runCustom(data, id); if (!f) return; save(); render(); openDetail(`custom:${id}`); return toast('저장된 메모로 실행 결과를 만들었어요.'); }
  if (a === 'check-item') { const f = data.customs.find(f => f.id === id); f.result.items[Number(el.dataset.index)].done = !f.result.items[Number(el.dataset.index)].done; save(); render(); return openDetail(`custom:${id}`); }
  if (a === 'preset-reminder') { const previous = data.reminders.slice(); const reply = applyRequest(data, `${el.dataset.minutes}분 뒤에 알림 줘`); if (!save()) { data.reminders = previous; return; } render(); return openDetail(reply.ref); }
  if (a === 'timer-extend') { const r = data.reminders.find(r => r.id === id); r.target = Math.max(current(), r.target) + 300000; r.cancelled = false; r.notified = false; save(); render(); return openDetail(`reminder:${id}`); }
  if (a === 'timer-cancel') { const r = data.reminders.find(r => r.id === id); if (r.cancelled) { r.target = current() + 1800000; r.created = current(); r.notified = false; } r.cancelled = !r.cancelled; save(); render(); return openDetail(`reminder:${id}`); }
  if (a === 'timer-finish') { const r = data.reminders.find(r => r.id === id); if (r.cancelled) return toast('취소된 알림이에요. 다시 시작한 뒤 체험해 주세요.'); data.clock = { real: Date.now(), virtual: r.target }; save(); render(); return openDetail(`reminder:${id}`); }
  if (a === 'news-state') { ++data.news.generation; data.news.readyAt = null; data.news.status = el.dataset.value; save(); render(); return openDetail('news'); }
  if (a === 'refresh-news') { data.news.readyAt = null; data.news.status = 'loading'; const generation = ++data.news.generation; save(); render(); openDetail('news'); setTimeout(() => { if (generation !== data.news.generation) return; data.news.status = 'ready'; data.news.at = current(); save(); render(); if (ui.detail === 'news' && $('#sheet').open) openDetail('news'); }, 1700); return; }
  if (a === 'article') { const index = Number(el.dataset.index); return openSheet('뉴스 요약', `<div class="detail-title"><p>브리핑 · ${index + 1}번째 기사</p><h2>${articleTitles[index]}</h2></div><p class="detail-notice">실제 뉴스가 아닌 화면 구성 예시입니다.</p><div class="note-body">${['일정 관리 기능은 요청한 날짜와 시간을 확인하고, 등록한 뒤 결과를 보여줍니다.\n\n모리에서는 등록 결과에서 일정 상세로 이동해 시간과 장소를 다시 확인할 수 있습니다.', '음성으로 입력한 내용은 전송 전에 확인하고 수정할 수 있습니다.\n\n대화 중에도 마이크와 키보드를 바꿔가며 같은 대화를 이어갈 수 있습니다.', '반복할 작업에는 실행할 시간과 요일을 정합니다. 실행 결과는 대시보드와 기능 상세에서 확인합니다.\n\n설정을 바꾸거나 잠시 중지할 때는 기능 상세의 편집 메뉴를 사용합니다.'][index]}</div><p class="field-help">실제 뉴스 연결 후에는 수집 시각과 원문 링크가 함께 표시됩니다.</p>`, 'plans-sheet'); }
  if (a === 'news-settings') return openSheet('브리핑 설정', `<form id="news-form">${field('관심 주제', 'topic', data.news.topic, 'text', 'required maxlength="60"')}${field('매일 수집할 시간', 'time', data.news.time, 'time', 'required')}<p class="field-help">설정 시각은 수집을 시작하는 시간이에요.</p><div class="form-actions"><button class="primary-button" type="submit">설정 저장</button></div></form>`, 'plans-sheet');
  if (a === 'stock-settings') return openSheet('관심 종목 변경', `<div class="stock-options">${['삼성전자', '코스피', '애플'].map(name => button('select-stock', `${mark('chart', 'rose')}<strong>${name}</strong>${data.stock.symbol === name ? icon('check') : arrow}`, `setting-row ${data.stock.symbol === name ? 'selected' : ''}`, `data-value="${name}" aria-pressed="${data.stock.symbol === name}"`)).join('')}</div><p class="field-help">가격은 샘플 데이터로 표시돼요.</p>`, 'stock-choice-sheet');
  if (a === 'select-stock') { data.stock.symbol = el.dataset.value; save(); render(); return openDetail('stock'); }
  if (a === 'chart-range') { ui.chart = el.dataset.value; return openDetail('stock'); }
  if (a === 'edit-profile') {
    if (!ui.liveUser) return accountSheet();
    return openSheet('사용자 정보 수정', `<form id="profile-form">${field('이름', 'name', ui.liveUser.display_name, 'text', 'required maxlength="80"')}<p class="field-help">모리에서 사용할 이름이에요. 연결된 소셜 계정은 바뀌지 않아요.</p><p class="form-error" role="alert"></p><div class="form-actions"><button class="primary-button full" type="submit">변경 저장</button></div></form>`, 'plans-sheet');
  }
  if (a === 'theme') return themeSheet();
  if (a === 'license') return subscriptionSheet();
  if (a === 'document') return documentSheet();
  if (a === 'sample-document') { if (fileBusy) return; fileBusy = true; try { await saveDocument('모리 회의 메모.txt', '모리 화면 회의\n대시보드는 지금 필요한 정보부터 보여주기\n채팅과 음성을 자연스럽게 이어주기\n기본 기능과 내 기능의 화면을 통일하기\n다음 회의 전 주차와 알림 시나리오 확인하기'); } catch (err) { toast(err.message || '문서를 보관하지 못했어요.'); } finally { fileBusy = false; } return; }
  if (a === 'download') { const d = data.documents.find(d => d.id === id); if (!d || busy.has(`download:${id}`)) return; busy.add(`download:${id}`); try { const source = await readOriginal(d), url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = d.filename; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('원문 다운로드를 요청했어요.'); } catch { toast('원문을 불러오지 못했어요. 파일을 다시 확인해 주세요.'); } finally { busy.delete(`download:${id}`); } return; }
  if (a === 'account') return accountSheet();
  if (a === 'live-parking-form') return parkingForm(true);
  if (a === 'login') { el.disabled = true; try { const r = await api('/auth/start', { method: 'POST', data: { provider: el.dataset.provider } }); location.assign(r.url); } catch (err) { toast(err.message); el.disabled = false; } }
  if (a === 'logout') {
    if (busy.has('logout')) return;
    busy.add('logout'); el.disabled = true; loadAccount.invalidate();
    try {
      await api('/logout', { method: 'POST', data: {} }); loadAccount.invalidate();
      ui.liveUser = null; ui.accountState = 'guest'; ui.settingsRevision = 0; ui.settingsState = 'idle'; ui.liveParking = null; liveAttempt = null;
      closeSheet(); render(); toast('로그아웃했어요.');
    } catch (err) { toast(err.message); }
    finally { busy.delete('logout'); el.disabled = false; }
  }
});
for (const type of ['input', 'change']) document.addEventListener(type, event => {
  const form = event.target.form || event.target.closest('form');
  if (form) clearFormError(form, form.id === 'note-form' ? null : event.target);
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, v = Object.fromEntries(new FormData(form)), id = form.dataset.id;
  if (form.id === 'conversation-form') { const c = data.conversations.find(c => c.id === id); if (!c || !v.title.trim()) return; c.title = v.title.trim(); save(); closeSheet(); render(); renderChat(); return toast('대화 이름을 바꿨어요.'); }
  if (form.id === 'chat-form') return send(v.message || '');
  if (form.id === 'parking-form') { try { const payload = parkingAttempt(null, parkingValues(form)).payload; data.parking = { ...payload, at: current() }; save(); render(); openDetail('parking'); return toast('위치와 표시 방식을 기억했어요.'); } catch (err) { showFormError(form, err.message); } return; }
  if (form.id === 'note-form') {
    if (!v.title.trim() && !v.body.trim()) { showFormError(form, '제목이나 내용을 한 줄 남겨주세요.', { field: 'title' }); return; }
    const n = { id: id || uid(), title: v.title.trim() || v.body.slice(0, 28), body: v.body.trim(), at: current() }, previous = data.notes;
    data.notes = id ? previous.map(note => note.id === id ? n : note) : [n, ...previous];
    if (!save()) { data.notes = previous; showFormError(form, '저장하지 못했어요. 작성한 내용은 유지됩니다. 저장 공간을 확보한 뒤 다시 시도해 주세요.'); return; }
    formDrafts.commit(form); render(); openDetail(`note:${n.id}`); return toast('메모를 저장했어요.');
  }
  if (form.id === 'event-form') {
    const e = { id: id || uid(), title: v.title.trim(), date: v.date, time: v.time, place: v.place.trim(), color: v.color, duration: Number(v.duration), memo: v.memo.trim() }, previous = data.events;
    if (!e.title) { showFormError(form, '일정 이름을 입력해 주세요.', { field: 'title' }); return; }
    data.events = id ? previous.map(event => event.id === id ? e : event) : [...previous, e];
    if (!save()) { data.events = previous; showFormError(form, '저장하지 못했어요. 작성한 내용을 확인하고 다시 시도해 주세요.'); return; }
    ui.date = e.date; ui.month = new Date(e.date + 'T12:00:00'); ui.month.setDate(1);
    formDrafts.commit(form); render(); openDetail(`event:${e.id}`); return toast('약속을 저장했어요.');
  }
  if (form.id === 'custom-form') {
    const existing = data.customs.find(f => f.id === id), previous = data.customs;
    const f = { ...existing, id: id || uid(), title: v.title.trim() || v.work.trim().slice(0, 24) || '새로운 내 기능', work: v.work.trim(), description: v.description.trim(), time: v.time, repeat: v.time ? (v.repeat === '필요할 때' ? '매일' : v.repeat) : '필요할 때', icon: customPreview(v).icon, active: Boolean(v.work.trim()) && (existing?.work?.trim() ? existing.active : true), content: v.content.trim(), version: (existing?.version || 0) + 1, runs: existing?.runs || 0, result: existing?.result || null };
    if (existing && (existing.time !== f.time || existing.repeat !== f.repeat)) delete f.occurrence;
    data.customs = existing ? previous.map(custom => custom.id === id ? f : custom) : [...previous, f];
    if (!save()) { data.customs = previous; showFormError(form, '저장하지 못했어요. 작성한 내용을 확인하고 다시 시도해 주세요.'); return; }
    formDrafts.commit(form); render(); openDetail(`custom:${f.id}`); return toast(f.work ? '내 기능으로 저장했어요.' : '기능 초안을 저장했어요.');
  }
  if (form.id === 'news-form') { data.news.topic = v.topic.trim(); data.news.time = v.time; save(); render(); openDetail('news'); return toast('브리핑 설정을 저장했어요.'); }
  if (form.id === 'profile-form' || form.id === 'theme-form') {
    const submit = [...form.elements].find(element => element.type === 'submit'); if (submit.disabled) return;
    submit.disabled = true;
    if (ui.accountState === 'checking') await loadAccount();
    if (!form.isConnected) return;
    const owner = ui.liveUser?.id; const epoch = ui.sheetEpoch; loadAccount.invalidate();
    try {
      if (form.id === 'profile-form') {
        if (!owner) return accountSheet();
        const profile = await api('/profile', {method: 'PATCH', data: {display_name: v.name.trim(), revision: ui.liveUser.revision}});
        if (owner !== ui.liveUser?.id) return; ui.liveUser = profile;
      } else {
        if (owner) {
          if (ui.settingsState !== 'ready') { const latest = await api('/settings'); if (owner !== ui.liveUser?.id) return; ui.settingsRevision = latest.revision; ui.settingsState = 'ready'; }
          const prefs = await api('/settings', {method: 'PUT', data: {theme: v.theme, revision: ui.settingsRevision}});
          if (owner !== ui.liveUser?.id) return; ui.settingsRevision = prefs.revision; ui.settingsState = 'ready';
        }
        selectedTheme = v.theme; try { localStorage.setItem(THEME_KEY, selectedTheme); } catch { /* Applied for this session. */ } applyTheme();
      }
      render();
      if (epoch !== ui.sheetEpoch || !form.isConnected) return toast(form.id === 'profile-form' ? '사용자 정보를 수정했어요.' : '테마를 적용했어요.');
      if (form.id === 'profile-form') {
        if (sheetTrail.at(-1)?.restore === profileDetails) backSheet();
        else profileDetails();
      } else closeSheet();
      toast(form.id === 'profile-form' ? '사용자 정보를 수정했어요.' : '테마를 적용했어요.');
    } catch (err) {
      if (err.status === 409) await loadAccount();
      if (form.isConnected) showFormError(form, err.status === 409 ? '다른 곳에서 변경됐어요. 최신 정보를 불러왔으니 내용을 확인하고 다시 저장해 주세요.' : err.message);
    } finally { submit.disabled = false; }
    return;
  }
  if (form.id === 'live-parking') {
    const owner = ui.liveUser?.id; if (!owner) return accountSheet();
    const submit = [...form.elements].find(element => element.type === 'submit'); if (submit.disabled) return;
    const epoch = ui.sheetEpoch; submit.disabled = true;
    try {
      liveAttempt = parkingAttempt(liveAttempt, parkingValues(form));
      const record = await api('/parking', { method: 'POST', data: liveAttempt.payload, key: liveAttempt.key });
      if (owner !== ui.liveUser?.id) return;
      ui.liveParking = record; liveAttempt = null;
      if (epoch === ui.sheetEpoch && form.isConnected) closeSheet();
      toast('계정에 위치와 표시 방식을 저장했어요.');
    } catch (err) {
      if (epoch === ui.sheetEpoch && form.isConnected) showFormError(form, err.message);
      else toast(err.message);
    } finally { submit.disabled = false; }
  }
});
document.addEventListener('input', event => {
  if (event.target.id === 'record-search') {
    // Keep the input node alive so Korean IME composition and the caret are preserved.
    ui.recordSearch = event.target.value;
    const records = matchingRecords();
    $('.library-count').innerHTML = `${ui.recordSearch.trim() ? '검색 결과' : '최근 기록'} <strong>${records.length}</strong>`;
    const list = $('.library-sheet .record-list');
    list.innerHTML = recordResults(records);
    if (!event.isComposing) motion.result(list);
  }
  if (event.target.id === 'note-content') $('#note-length').textContent = `${event.target.value.length.toLocaleString()}자`;
});
document.addEventListener('input', event => {
  if (event.target.id !== 'conversation-search') return;
  ui.search = event.target.value;
  const list = $('#conversation-content');
  list.innerHTML = conversationContent();
  if (!event.isComposing) motion.result(list);
});
document.addEventListener('input', event => { if (event.target.closest('#event-form')) updateEventPreview(); });
document.addEventListener('change', event => { if (event.target.closest('#event-form')) updateEventPreview(); });
document.addEventListener('change', async event => { if (event.target.id !== 'document-upload' || fileBusy) return; const file = event.target.files?.[0]; if (!file) return; if (!/\.(txt|md|csv)$/i.test(file.name) || file.size > DOCUMENT_MAX_BYTES) { event.target.value = ''; return toast('10MB 이하의 TXT, MD, CSV 파일을 선택해 주세요.'); } fileBusy = true; event.target.disabled = true; const sheetEpoch = ui.sheetEpoch; try { const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); await saveDocument(file.name, content, sheetEpoch); } catch (err) { toast(err instanceof TypeError ? 'UTF-8 텍스트 파일로 저장한 뒤 다시 선택해 주세요.' : err.message || '파일을 보관하지 못했어요.'); } finally { fileBusy = false; event.target.disabled = false; event.target.value = ''; } });
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
$('#chat-input').addEventListener('focus', () => { if (voiceExpanded && !voiceActive()) closeVoice(true); });
document.addEventListener('input', event => { if (event.target.id === 'chat-input') { if (voiceExpanded && !voiceActive()) closeVoice(true); persistDraft(); syncComposer(); } if (event.target.closest('#custom-form')) updateCustomPreview(); });
document.addEventListener('change', event => { if (event.target.closest('#custom-form')) updateCustomPreview(); });
$('#chat-panel').addEventListener('close', () => {
  if ($('#chat-panel').open) return;
  stopVoice(); persistDraft(); render();
});
$('#voice-transcript').addEventListener('input', () => { voiceFallbackEdited = true; updateVoiceInput(); });
$('#voice-examples-toggle').addEventListener('click', () => {
  const toggle = $('#voice-examples-toggle'), expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  // Examples belong to this panel. Grow only their occupied space; never
  // clone or re-present the composer, its emblem or its live input controls.
  motion.disclosure($('#voice-example-list'), expanded, { inFlow: true });
});
$('#sheet-content').addEventListener('scroll', () => { $('#sheet').dataset.scrolled = String($('#sheet-content').scrollTop > 8); }, { passive: true });
$('#sheet').addEventListener('close', () => { formDrafts.capture(draftForm()); if (!$('#sheet').open) { ui.detail = null; sheetCardOrigin = null; } });
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', moveToast);
  const dismiss = (dragOffset = 0) => {
    if (dialog.id === 'sheet') return closeSheet(dragOffset);
    if (dialog.id === 'chat-panel') suspendVoice();
    return presentations.dismiss(dialog, { dragOffset });
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (dialog.id === 'chat-panel' && voiceExpanded) return closeVoice(); if (dialog.id === 'sheet' && sheetTrail.length) backSheet(); else dismiss(); });
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dismiss(); });
  presentations.pullToDismiss(dialog, dismiss);
}
// Keep editable sheets inside the visible area when the software keyboard opens.
// Pinch zoom remains a browser operation; do not resize the UI to a zoomed viewport.
function syncVisibleViewport() {
  const viewport = window.visualViewport;
  const editable = document.activeElement?.matches('input:not([type=radio]):not([type=checkbox]), textarea, [contenteditable=true]');
  const constrained = Boolean(viewport && viewport.scale === 1 && editable && innerHeight - viewport.height > 120);
  document.documentElement.classList.toggle('keyboard-open', constrained);
  document.documentElement.style.setProperty('--visible-height', `${constrained ? viewport.height : innerHeight}px`);
  document.documentElement.style.setProperty('--visible-top', `${constrained ? viewport.offsetTop : 0}px`);
}
window.visualViewport?.addEventListener('resize', syncVisibleViewport);
window.visualViewport?.addEventListener('scroll', syncVisibleViewport);
document.addEventListener('focusin', syncVisibleViewport);
document.addEventListener('focusout', () => requestAnimationFrame(syncVisibleViewport));
window.addEventListener('resize', syncVisibleViewport);
syncVisibleViewport();
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => {
  if (ui.windowMenu) positionWindowMenu();
  if ($('#chat-panel').open) {
    presentations.settle($('#chat-panel'));
    syncComposer();
  }
  motion.render(ui.view);
});
let lastMinute = '';
setInterval(() => {
  if (tickScheduled(data)) { save(); render(); if (ui.detail && $('#sheet').open) openDetail(ui.detail); }
  document.querySelectorAll('[data-countdown]').forEach(el => { const r = data.reminders.find(r => r.id === el.dataset.countdown); if (r) { el.textContent = r.cancelled ? '중지됨' : remaining(r.target); const ring = el.closest('.timer-ring'); if (ring) { const fraction = Math.max(0, Math.min(1, (r.target - current()) / Math.max(1, r.target - r.created))); ring.querySelector('.timer-progress').setAttribute('stroke-dashoffset', String(679 * (1 - fraction))); ring.querySelector('small').textContent = r.cancelled ? '다시 시작할 수 있어요' : current() >= r.target ? '목표 시각이 되었어요' : '남은 시간'; } } });
  document.querySelectorAll('[data-timer-preview]').forEach(el => {
    const r = data.reminders.find(r => r.id === el.dataset.timerPreview);
    if (!r) return;
    const fraction = r.cancelled ? 0 : Math.max(0, Math.min(1, (r.target - current()) / Math.max(1, r.target - r.created)));
    if (Number.isFinite(fraction)) el.setAttribute('stroke-dashoffset', String(100 * (1 - fraction)));
  });
  document.querySelectorAll('.scene-timer-value[data-countdown]').forEach(el => {
    el.classList.toggle('is-long', el.textContent.length > 5);
    el.classList.toggle('is-extra-long', el.textContent.length > 7);
  });
  data.reminders.filter(r => !r.cancelled && !r.notified && r.target <= current()).forEach(r => { r.notified = true; save(); if (data.profile.notify) toast(`${r.title} · 목표 시각이 되었어요.`); });
  const minute = Math.floor(current() / 60000); if (minute !== lastMinute) { lastMinute = minute; if (ui.view === 'dashboard' && !ui.windowMenu && !document.querySelector('dialog[open]')) render(); }
}, 1000);
tickScheduled(data); save(); route();
const login = new URLSearchParams(location.search).get('login'); if (login) { history.replaceState(null, '', location.pathname + location.hash); toast(login === 'success' ? '계정을 연결했어요.' : '로그인을 완료하지 못했어요.'); accountSheet(); } else { loadAccount(); }

document.addEventListener('input', event => { if (event.target.closest('.parking-form')) updateParkingPreview(); });
document.addEventListener('change', event => { if (event.target.closest('.parking-form')) updateParkingPreview(); });
