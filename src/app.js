import { api } from './api.mjs';
import { escapeHTML as esc, dayKey, phaseAt, parkingLabel, parkingAttempt, seedPreview } from './ui-model.mjs';

const $ = selector => document.querySelector(selector);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const mascot = (className = '') => `<img class="mascot ${className}" src="/assets/mori.svg" alt="" draggable="false">`;
const uid = () => crypto.randomUUID();
const state = { user: null, ready: false, parking: null, parkingError: '', providers: [], config: null, view: 'today', chatId: null, chatGroup: '전체', date: dayKey(), calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1), preview: seedPreview(), files: [], sending: false };
let pendingParking = null, parkingDraft = {}, toastTimer, closeTimer, sessionVersion = 0, recognition = null, lastOpener, speechText = '', submitting = false;
const sheet = $('#sheet');
const formatDate = (date, options) => new Date(date).toLocaleDateString('ko-KR', options);
const savedAt = value => new Date(value).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeText = value => { const [h, m] = value.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(m).padStart(2, '0')}`; };
const todayEvents = () => state.preview.events.filter(e => e.date === dayKey()).sort((a, b) => a.time.localeCompare(b.time));
const storeKey = () => `mori.app.preview.v3.${state.user?.id || 'guest'}`;
function loadPreview() {
  try { const cached = JSON.parse(localStorage.getItem(storeKey())); state.preview = cached?.version === 3 && Array.isArray(cached.events) && Array.isArray(cached.conversations) && Array.isArray(cached.notes) ? cached : seedPreview(); }
  catch { state.preview = seedPreview(); }
  state.chatId = null; state.files = [];
}
function persistPreview() { try { localStorage.setItem(storeKey(), JSON.stringify(state.preview)); } catch { toast('이 기기의 저장 공간이 부족해요.'); } }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3800); }
function setView(view, chatId = null) {
  closeSheet(); const next = view === 'chat' && chatId ? `chat/${chatId}` : view;
  if (location.hash === '#' + next) route(); else location.hash = next;
}
function route() {
  const [view, chatId] = location.hash.slice(1).split('/');
  state.view = ['today', 'chat', 'calendar', 'memories'].includes(view) ? view : 'today';
  state.chatId = state.preview.conversations.some(c => c.id === chatId) ? chatId : null;
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function header(title, eyebrow, action = '') {
  return `<header class="page-header"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1></div><div class="header-actions">${action}<button class="profile-button" data-action="account" aria-label="${state.user ? '내 계정' : '로그인'}">${mascot()}${state.user?.tier === 'pro' ? '<span class="profile-pro"></span>' : ''}</button></div></header>`;
}
function sectionHeader(title, link = '', view = '') { return `<div class="section-header"><h2>${title}</h2>${link ? `<button class="text-link" data-view="${view}">${link}${icon('chevron')}</button>` : ''}</div>`; }
function home() {
  const phase = phaseAt(), parking = state.parking;
  const commute = phase === 'morning' && ![0, 6].includes(new Date().getDay());
  const title = commute && parking ? '출근길, 내 차는<br>여기에 있어요.' : phase === 'morning' ? '좋은 아침이에요.<br>오늘도, 가볍게.' : phase === 'day' ? '작은 기억이<br>가벼운 하루로.' : '오늘도 수고했어요.<br>기억은 맡겨두세요.';
  const eyebrow = `${formatDate(new Date(), { month: 'long', day: 'numeric', weekday: 'long' })}`;
  const hero = `<article class="hero-card ${phase}"><div class="hero-copy"><div class="hero-eyebrow"><span class="live-dot"></span>${commute ? '출근길에 필요한 기억' : phase === 'day' ? '나를 챙기는 작은 습관' : phase === 'morning' ? '모리와 시작하는 하루' : '하루를 마무리할 시간'}</div><h2>${title}</h2><p>${commute && parking ? esc(parkingLabel(parking)) : '잊지 않아도 되는 일, 모리가 챙길게요.'}</p></div><div class="hero-art"><div class="art-halo"></div><span class="floating-note note-calendar"><b>${new Date().getDate()}</b><small>${formatDate(new Date(), { weekday: 'short' })}요일</small></span>${mascot('hero-mascot')}<span class="floating-note note-memory">${icon(commute && parking ? 'car' : 'heart')}<span>${commute && parking ? esc(parking.spot || parking.floor || '주차 기억') : '기억해 둘게요'}</span></span></div><div class="hero-bottom"><span class="app-icon green">${icon(commute && parking ? 'car' : 'leaf')}</span><div><strong>${commute && parking ? '마지막으로 주차한 곳' : '내 곁의 작은 비서, 모리'}</strong><p>${commute && parking ? esc(savedAt(parking.recorded_at)) : '말로든, 글로든 편하게 부탁해요'}</p></div><button class="pill" data-action="${commute && parking ? 'parking-detail' : 'voice'}">${commute && parking ? '보기' : '부탁'}</button></div></article>`;
  return `${header('오늘', eyebrow)}<div class="home-grid"><div class="home-primary">${hero}<section class="section quick-section">${sectionHeader('어떤 걸 챙겨드릴까요?')}<div class="quick-grid"><button data-action="parking"><span class="app-icon blue">${icon('car')}</span><strong>주차 기억</strong><small>내 차, 어디였지?</small></button><button data-action="event"><span class="app-icon coral">${icon('calendar')}</span><strong>일정 추가</strong><small>약속을 잊지 않게</small></button><button data-action="new-chat"><span class="app-icon purple">${icon('spark')}</span><strong>모리에게 부탁</strong><small>여행부터 문서까지</small></button></div></section></div><div class="home-secondary"><section class="section parking-section">${sectionHeader('내 차의 마지막 자리')}<button class="parking-summary" data-action="${parking ? 'parking-detail' : 'parking'}"><span class="parking-p">P</span><div><strong>${parking ? esc(parkingLabel(parking)) : '어디에 주차하셨나요?'}</strong><p>${parking ? `${esc(savedAt(parking.recorded_at))} 저장` : state.user ? '한 번 알려주면, 모리가 기억해요.' : '로그인하고 나만의 위치를 기억해요.'}</p></div>${icon('chevron')}</button>${state.parkingError ? `<p class="inline-error">${esc(state.parkingError)} <button data-action="reload-parking">다시 확인</button></p>` : ''}</section><section class="section">${sectionHeader('오늘의 일정', '전체', 'calendar')}<div class="schedule-card"><div class="subtle-label">${icon('calendar')}기기 안에서 체험하는 일정<span class="demo-badge">미리보기</span></div>${todayEvents().slice(0, 2).map(e => eventRow(e)).join('') || '<p class="empty-inline">아직 일정이 없어요. 여유로운 하루네요.</p>'}</div></section><section class="section discovery-section">${sectionHeader('모리와 이렇게 시작해요')}<div class="discovery-grid"><button class="discovery-card travel" data-action="trip"><span class="eyebrow">나의 작은 여행</span><h3>계획은 가볍게,<br>설렘은 그대로.</h3><div class="travel-illustration" aria-hidden="true"><span class="sun-disc"></span><span class="hill hill-one"></span><span class="hill hill-two"></span>${icon('compass')}</div><span class="card-foot">제주 여행을 함께 생각해요 ${icon('arrow')}</span></button><button class="discovery-card document" data-action="document"><span class="eyebrow">복잡한 일도 간단하게</span><h3>흩어진 생각을<br>한 장으로.</h3><div class="paper-art" aria-hidden="true"><span>mori notes</span><i></i><i></i><i></i><b>✓</b></div><span class="card-foot">문서 부탁 미리보기 ${icon('arrow')}</span></button></div></section></div></div><p class="brand-signoff">작은 일상에, 모리<span>🌱</span></p>`;
}
function eventRow(event) { return `<button class="event-row" data-action="event-edit" data-id="${esc(event.id)}"><span class="event-time">${esc(timeText(event.time))}</span><span class="event-line ${event.sample ? 'sample' : ''}"></span><span class="event-info"><strong>${esc(event.title)}</strong><small>${esc(event.place || '장소 미정')}</small></span>${icon('chevron')}</button>`; }
function chatPage() {
  const conversation = state.preview.conversations.find(c => c.id === state.chatId);
  if (conversation) return `<header class="conversation-header"><button class="back-button" data-view="chat" aria-label="대화 목록으로">${icon('chevron')}</button><div><strong>${esc(conversation.title)}</strong><p>모리 · 대화 미리보기</p></div><button class="icon-button" data-action="chat-group" aria-label="대화 분류 바꾸기">${icon('more')}</button></header><div class="chat-thread"><div class="chat-welcome">${mascot()}<h2>어떤 이야기든<br>편하게 들려주세요.</h2><p>주차 기록은 실제로 저장하고,<br>다른 부탁은 화면 흐름을 체험할 수 있어요.</p></div><div class="messages" role="log" aria-label="대화 내용">${conversation.messages.map((m, index) => `<article class="message ${m.role}">${m.role === 'assistant' ? `<span class="assistant-dot">${icon('leaf')}</span>` : ''}<div><p>${esc(m.text).replaceAll('\n', '<br>')}</p>${m.files?.length ? `<div class="message-files">${m.files.map(f => `<span>${icon('file')}${esc(f)}</span>`).join('')}</div>` : ''}${m.action ? `<button class="message-action" data-action="${m.action}" data-message-index="${index}">${m.action === 'parking' ? '위치 확인하고 저장' : m.action === 'parking-detail' ? '주차 위치 보기' : '일정 직접 추가'}${icon('arrow')}</button>` : ''}</div></article>`).join('')}</div></div><form id="chat-form" class="composer"><div class="composer-input"><label for="message" class="sr-only">모리에게 보낼 내용</label><textarea id="message" name="message" rows="1" maxlength="2000" placeholder="모리에게 부탁해요" required></textarea><button type="submit" class="send-button" aria-label="메시지 보내기">${icon('arrow')}</button></div><div class="composer-bottom"><label class="icon-button file-button" aria-label="파일 이름 첨부">${icon('plus')}<input type="file" id="files" accept=".pdf,.xlsx,.xls,.csv,.txt" multiple></label><span>${state.files.length ? `${state.files.length}개 파일 · 이름만 첨부` : '대화·문서 생성은 미리보기예요'}</span><button type="button" class="icon-button" data-action="voice" aria-label="말로 입력">${icon('mic')}</button></div></form>`;
  const items = state.preview.conversations.filter(c => state.chatGroup === '전체' || c.group === state.chatGroup).toReversed();
  return `${header('대화', '말해두면, 한결 가벼워져요', '<button class="icon-button" data-action="new-chat" aria-label="새 대화">' + icon('plus') + '</button>')}<div class="filter-chips" role="group" aria-label="대화 분류">${['전체', '생활', '여행', '문서'].map(g => `<button data-action="filter-chat" data-group="${g}" aria-pressed="${state.chatGroup === g}">${g}</button>`).join('')}</div>${items.length ? `<div class="conversation-list">${items.map(c => `<button class="conversation-row" data-action="open-chat" data-id="${esc(c.id)}"><span class="app-icon ${c.group === '여행' ? 'coral' : c.group === '문서' ? 'purple' : 'green'}">${icon(c.group === '여행' ? 'compass' : c.group === '문서' ? 'file' : 'chat')}</span><div><strong>${esc(c.title)}</strong><p>${esc(c.messages.at(-1)?.text || '모리에게 첫 이야기를 건네보세요.')}</p><small>${esc(c.group)} · ${formatDate(c.updatedAt, { month: 'long', day: 'numeric' })}</small></div>${icon('chevron')}</button>`).join('')}</div>` : `<div class="empty-state">${mascot()}<h2>작은 부탁부터 시작해요.</h2><p>일상의 기억, 떠나고 싶은 여행,<br>정리하고 싶은 생각을 모리와 나눠요.</p><button class="primary-button" data-action="new-chat">새 대화 시작하기 ${icon('plus')}</button></div>`}<section class="section"><div class="section-header"><h2>이렇게 말해보세요</h2><span class="demo-badge">미리보기</span></div><div class="prompt-list"><button data-action="parking-chat">${icon('car')}지하 2층 C구역 C36에 주차했어${icon('arrow')}</button><button data-action="trip">${icon('compass')}제주에서 여유로운 2박 3일 보내고 싶어${icon('arrow')}</button><button data-action="document">${icon('file')}이번 달 생활비를 엑셀로 정리하고 싶어${icon('arrow')}</button></div></section>`;
}
function calendarPage() {
  const month = state.calendarMonth, count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const events = state.preview.events.filter(e => e.date === state.date).sort((a, b) => a.time.localeCompare(b.time));
  return `${header('캘린더', '나의 하루를 한눈에', '<button class="icon-button" data-action="event" aria-label="일정 추가">' + icon('plus') + '</button>')}<div class="calendar-card"><div class="month-heading"><h2>${formatDate(month, { year: 'numeric', month: 'long' })}</h2><div><button class="icon-button previous" data-action="prev-month" aria-label="이전 달">${icon('chevron')}</button><button class="text-link" data-action="calendar-today">오늘</button><button class="icon-button" data-action="next-month" aria-label="다음 달">${icon('chevron')}</button></div></div><div class="calendar-grid"><div class="weekday sunday">일</div>${['월', '화', '수', '목', '금', '토'].map(d => `<div class="weekday">${d}</div>`).join('')}${'<span class="calendar-blank"></span>'.repeat(first)}${Array.from({ length: count }, (_, index) => { const date = dayKey(new Date(month.getFullYear(), month.getMonth(), index + 1)); return `<button data-action="select-date" data-date="${date}" class="calendar-day ${date === dayKey() ? 'is-today' : ''}" aria-pressed="${date === state.date}" aria-label="${month.getMonth() + 1}월 ${index + 1}일${date === dayKey() ? ', 오늘' : ''}"><span>${index + 1}</span>${state.preview.events.some(e => e.date === date) ? '<i aria-hidden="true"></i>' : ''}</button>`; }).join('')}</div></div><section class="section"><div class="section-header"><h2>${formatDate(state.date + 'T12:00:00', { month: 'long', day: 'numeric', weekday: 'short' })}</h2><span class="demo-badge">기기 내 미리보기</span></div><div class="schedule-card">${events.map(eventRow).join('') || `<div class="day-empty">${icon('sun')}<h3>비어 있는 시간도 좋아요.</h3><p>챙길 약속이 있다면 여기에 남겨요.</p></div>`}</div><button class="secondary-button full" data-action="event">${icon('plus')}일정 직접 추가</button><p class="helper-text">이 일정은 현재 기기에만 저장돼요.<br>휴대폰 캘린더·알림은 아직 연결되지 않았어요.</p></section>`;
}
function memoriesPage() {
  return `${header('기억', '필요한 순간, 다시 꺼내요')}<section class="memory-feature"><div><span class="eyebrow">모리가 기억하는 내 차</span><h2>${state.parking ? esc(parkingLabel(state.parking)) : '이제, 찾느라<br>헤매지 마세요.'}</h2><p>${state.parking ? esc(savedAt(state.parking.recorded_at)) + ' 저장' : '층과 자리만 알려주면 충분해요.'}</p><button class="pill" data-action="${state.parking ? 'parking-detail' : 'parking'}">${state.parking ? '위치 보기' : '첫 위치 기억하기'}${icon('arrow')}</button></div><span class="memory-parking-p">P</span></section>${state.parkingError ? `<p class="inline-error">${esc(state.parkingError)} <button data-action="reload-parking">다시 확인</button></p>` : ''}<section class="section">${sectionHeader('소소하지만 소중한 기억')}<div class="note-grid">${state.preview.notes.map(n => `<button class="note-card" data-action="note-detail" data-id="${esc(n.id)}"><span class="app-icon coral">${icon('heart')}</span><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p>${n.sample ? '<span class="demo-badge">예시 기억</span>' : ''}</button>`).join('')}</div><button class="secondary-button full" data-action="note">${icon('plus')}작은 기억 남기기</button></section><section class="routine-card"><div class="routine-icon">${icon('repeat')}</div><div><span class="eyebrow">자주 필요한 기억은 먼저</span><h3>아침에는, 내 차 위치.</h3><p>평일 오전 6시부터 10시에는 저장된 주차 위치를 오늘 첫 카드에 보여드려요.</p><span class="demo-badge">화면의 시간대 규칙</span></div></section><p class="helper-text">홈 화면 자동 표시는 이 POC에서 동작해요.<br>휴대폰 위젯과 자동 학습은 앞으로 연결할 기능이에요.</p>`;
}
function render() {
  $('#main').innerHTML = state.view === 'today' ? home() : state.view === 'chat' ? chatPage() : state.view === 'calendar' ? calendarPage() : memoriesPage();
  document.body.classList.toggle('in-conversation', state.view === 'chat' && !!state.chatId);
  document.querySelectorAll('.tab-bar [data-view]').forEach(button => { if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (state.chatId) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
}
function openSheet(title, html, kind = '') {
  clearTimeout(closeTimer); lastOpener = document.activeElement;
  sheet.classList.remove('closing'); sheet.dataset.kind = kind;
  $('#sheet-title').textContent = title; $('#sheet-content').innerHTML = html;
  if (!sheet.open) sheet.showModal();
  document.body.classList.add('sheet-open');
}
function closeSheet() {
  if (!sheet.open) return;
  stopSpeech(); sheet.classList.add('closing');
  clearTimeout(closeTimer); closeTimer = setTimeout(() => { sheet.close(); sheet.classList.remove('closing'); document.body.classList.remove('sheet-open'); if (lastOpener?.isConnected) lastOpener.focus({ preventScroll: true }); }, 160);
}
function connectionDetails() { return `<details class="connection-details"><summary>개발 연결 정보 ${icon('settings')}</summary><dl><dt>Mori API</dt><dd>${esc(state.config?.apiBaseUrl || '확인 중')}</dd><dt>로그인 복귀 주소</dt><dd>${esc(state.config?.callbackUrl || '확인 중')}</dd></dl><p>네이버·카카오 앱 키는 백엔드에 설정해 주세요. 이 복귀 주소를 백엔드의 허용 목록에 등록해야 해요.</p><button class="text-link" data-action="check-connection">연결 다시 확인 ${icon('repeat')}</button><p class="connection-status" role="status"></p></details>`; }
async function accountSheet() {
  if (state.user) {
    const user = state.user;
    openSheet('나의 모리', `<div class="account-profile">${mascot()}<h3>${esc(user.display_name)} 님</h3><span class="tier-badge ${user.tier === 'pro' ? 'pro' : ''}">${user.tier === 'pro' ? icon('spark') + ' 프로' : '무료 사용자'}</span></div><div class="setting-group"><div class="setting-row"><span>연결된 계정</span><strong>${user.providers.map(p => p === 'naver' ? '네이버' : '카카오').join(' · ')}</strong></div><div class="setting-row"><span>이용 등급</span><strong>${user.tier === 'pro' ? '프로' : '무료'}</strong></div>${user.role === 'super_admin' ? '<div class="setting-row"><span>운영 역할</span><strong>최고 관리자</strong></div>' : ''}</div><div class="membership-note">${icon('shield')}<p>${user.tier === 'pro' ? '최고 관리자가 프로 이용을 승인했어요.' : '프로는 최고 관리자의 승인으로 이용할 수 있어요.'}<br>현재 결제나 구독은 없어요.</p></div><button class="secondary-button full" data-action="refresh-account">계정 상태 새로고침 ${icon('repeat')}</button><button class="logout-button" data-action="logout">로그아웃</button><details class="connection-details"><summary>내 사용자 정보</summary><p>${esc(user.id)}</p><button class="text-link" data-action="copy-id">사용자 ID 복사</button></details>${connectionDetails()}`, 'account');
    return;
  }
  openSheet('모리와 시작하기', `<div class="login-art"><span class="art-halo"></span>${mascot()}</div><div class="login-copy"><p class="eyebrow">내 곁의 작은 비서</p><h3>기억할 일은 줄이고,<br>나의 하루는 가볍게.</h3><p>간편하게 로그인하고<br>나만의 주차 위치를 기억해 두세요.</p></div><div class="social-buttons"><button class="social naver" data-action="login" data-provider="naver" disabled><b aria-hidden="true">N</b>네이버로 계속하기</button><button class="social kakao" data-action="login" data-provider="kakao" disabled><span class="kakao-mark" aria-hidden="true"></span>카카오로 계속하기</button></div><p id="login-status" class="helper-text" role="status">로그인 연결을 확인하고 있어요.</p><button class="text-link browse-button" data-action="close">먼저 둘러볼게요</button>${connectionDetails()}`, 'login');
  await loadProviders();
}
async function loadProviders() {
  try { state.providers = await api('/providers'); updateLoginButtons(); }
  catch (error) { if ($('#login-status')) $('#login-status').textContent = error.message; }
}
function updateLoginButtons() {
  if (sheet.dataset.kind !== 'login') return;
  document.querySelectorAll('.social').forEach(button => { button.disabled = !state.providers.some(p => p.provider === button.dataset.provider && p.enabled); });
  if ($('#login-status')) $('#login-status').textContent = state.providers.some(p => p.enabled) ? '네이버·카카오 계정으로만 가입할 수 있어요.' : '아직 소셜 로그인 연결을 준비하고 있어요. 화면은 먼저 둘러볼 수 있어요.';
}
function parkingSheet() {
  if (!state.user) { toast('로그인하면 나만의 주차 위치를 기억할 수 있어요.'); accountSheet(); return; }
  const draft = Object.keys(parkingDraft).length ? parkingDraft : state.parking || {};
  openSheet('주차 위치 기억하기', `<div class="parking-form-intro"><span class="app-icon blue">${icon('car')}</span><div><h3>내 차, 어디에 있나요?</h3><p>세 칸을 모두 채우지 않아도 괜찮아요.</p></div></div><form id="parking-form"><div class="form-group"><label for="parking-floor">층</label><input id="parking-floor" name="floor" placeholder="예: 지하 2층" maxlength="32" value="${esc(draft.floor || '')}"><div class="suggestions"><button type="button" data-action="floor" data-value="B1">지하 1층</button><button type="button" data-action="floor" data-value="B2">지하 2층</button><button type="button" data-action="floor" data-value="B3">지하 3층</button></div></div><div class="form-columns"><div class="form-group"><label for="parking-zone">구역 <span>선택</span></label><input id="parking-zone" name="zone" placeholder="예: C구역" maxlength="64" value="${esc(draft.zone || '')}"></div><div class="form-group"><label for="parking-spot">자리 번호 <span>선택</span></label><input id="parking-spot" name="spot" placeholder="예: C36" maxlength="64" value="${esc(draft.spot || '')}"></div></div><p class="form-error" role="alert" id="parking-error"></p><div class="private-note">${icon('shield')}로그인한 나의 계정에만 저장돼요.</div><button class="primary-button full" type="submit">${icon('check')}이 위치 기억하기</button></form>`, 'parking');
}
function parkingDetail() {
  const p = state.parking;
  if (!p) return parkingSheet();
  openSheet('내 차의 마지막 자리', `<div class="parking-ticket"><div class="ticket-top"><span>MY PARKING SPOT</span>${icon('car')}</div><div class="ticket-location"><span>${esc(p.floor || '주차 위치')}</span><h3>${esc(p.spot || p.zone || p.floor)}</h3>${p.spot && p.zone ? `<p>${esc(p.zone)}</p>` : ''}</div><div class="ticket-rule"></div><div class="ticket-bottom">${icon('clock')}<span>${esc(savedAt(p.recorded_at))}에 기억했어요.</span></div></div><p class="helper-text">마지막으로 저장한 위치예요.<br>자동차의 실시간 GPS 위치는 아니에요.</p><button class="primary-button full" data-action="parking">새 위치 기억하기 ${icon('arrow')}</button><button class="secondary-button full" data-action="copy-parking">${icon('download')}위치 복사하기</button>`, 'parking-detail');
}
function eventSheet(id) {
  const e = state.preview.events.find(item => item.id === id) || {};
  openSheet(e.id ? '일정 보기' : '새로운 일정', `<p class="sheet-description">대화 없이, 필요한 약속만 간단히 남겨요.</p><form id="event-form" data-id="${esc(e.id || '')}"><div class="form-group"><label for="event-title">어떤 약속인가요?</label><input id="event-title" name="title" placeholder="예: 엄마와 점심 약속" maxlength="80" required value="${esc(e.title || '')}"></div><div class="form-columns"><div class="form-group"><label for="event-date">날짜</label><input id="event-date" type="date" name="date" required value="${esc(e.date || state.date)}"></div><div class="form-group"><label for="event-time">시간</label><input id="event-time" type="time" name="time" required value="${esc(e.time || '12:00')}"></div></div><div class="form-group"><label for="event-place">장소 <span>선택</span></label><input id="event-place" name="place" maxlength="120" placeholder="만날 곳을 알려주세요" value="${esc(e.place || '')}"></div><p class="private-note">${icon('phone')}기기 안에서 체험하는 일정이에요. 알림은 발송되지 않아요.</p><button class="primary-button full" type="submit">${e.id ? '변경 내용 저장' : '일정 추가하기'}${icon('check')}</button>${e.id ? `<button type="button" class="logout-button" data-action="delete-event" data-id="${esc(e.id)}">일정 삭제</button>` : ''}</form>`, 'event');
}
function voiceSheet() {
  speechText = '';
  openSheet('말로 부탁하기', `<div class="voice-scene">${mascot()}<div class="voice-wave" aria-hidden="true">${'<i></i>'.repeat(9)}</div></div><div class="voice-copy"><h3 id="voice-title">편하게 말해주세요.</h3><p id="voice-hint">마이크를 켜고 편하게 이야기해요.<br>보내기 전에 내용을 확인할 수 있어요.</p></div><div class="voice-controls"><button class="voice-record" data-action="start-speech" aria-label="음성 입력 시작">${icon('mic')}</button><span>눌러서 말하기</span></div><div class="voice-example"><span>이렇게 부탁해보세요</span><button data-action="voice-example">“지하 2층 C구역 C36에 주차했어”</button></div><form id="voice-form"><label for="voice-text">보낼 내용</label><textarea id="voice-text" name="message" placeholder="음성을 확인하거나 직접 입력해 주세요" rows="3" maxlength="2000" required></textarea><p class="helper-text">음성 인식은 브라우저 기능을 사용해요.<br>서버의 음성·AI 대화 연결은 준비 중이에요.</p><button class="primary-button full" type="submit">대화로 보내기 ${icon('arrow')}</button></form>`, 'voice');
}
function stopSpeech() { if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; } sheet.classList.remove('listening'); }
function startSpeech() {
  if (recognition) { stopSpeech(); $('#voice-title').textContent = '잘 들었어요. 내용을 확인해요.'; return; }
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) { $('#voice-hint').textContent = '이 브라우저에서는 음성 입력이 어려워요. 아래에 직접 입력하거나 예시를 눌러보세요.'; return; }
  recognition = new Speech(); recognition.lang = 'ko-KR'; recognition.interimResults = true; recognition.continuous = false;
  recognition.onresult = event => { speechText = Array.from(event.results).map(r => r[0].transcript).join(' '); if ($('#voice-text')) $('#voice-text').value = speechText; };
  recognition.onerror = event => { if ($('#voice-hint')) $('#voice-hint').textContent = event.error === 'not-allowed' ? '마이크 권한이 꺼져 있어요. 직접 입력해도 괜찮아요.' : '잘 듣지 못했어요. 다시 말하거나 직접 입력해 주세요.'; stopSpeech(); };
  recognition.onend = () => { recognition = null; sheet.classList.remove('listening'); if ($('#voice-title')) $('#voice-title').textContent = '보내기 전에 한 번 확인해요.'; };
  try { recognition.start(); sheet.classList.add('listening'); $('#voice-title').textContent = '이야기해 주세요.'; } catch { stopSpeech(); $('#voice-hint').textContent = '마이크를 시작하지 못했어요. 직접 입력해 주세요.'; }
}
function createChat(group = '생활') { const conversation = { id: uid(), title: '새로운 이야기', group, messages: [], updatedAt: new Date().toISOString() }; state.preview.conversations.push(conversation); persistPreview(); state.chatId = conversation.id; return conversation; }
async function sendMessage(text, group = '생활') {
  text = text.trim(); if (!text || state.sending) return;
  state.sending = true;
  const owner = state.user?.id;
  const conversation = state.preview.conversations.find(c => c.id === state.chatId) || createChat(group);
  if (!conversation.messages.length) conversation.title = text.slice(0, 30);
  conversation.updatedAt = new Date().toISOString();
  conversation.messages.push({ role: 'user', text, files: state.files.map(f => f.name) }); state.files = [];
  let reply = '좋아요. 이 이야기는 여기 모아둘게요. 지금은 대화 화면을 체험하는 단계라 실제 AI 답변은 아직 연결되지 않았어요.', action, parsedParking;
  if (/주차|내 차/.test(text)) {
    if (/어디|어딨|알려|보여/.test(text) && !/주차했/.test(text) && state.user) {
      await loadParking(false);
      reply = state.parkingError ? '주차 위치를 새로 확인하지 못했어요. 잠시 후 다시 확인해 주세요.' : state.parking ? `마지막으로 저장한 주차 위치는 ${parkingLabel(state.parking)}예요. ${savedAt(state.parking.recorded_at)}에 기억해 뒀어요.` : '아직 확인할 수 있는 주차 위치가 없어요. 위치를 한 번 알려주세요.';
      action = state.parking ? 'parking-detail' : 'parking';
    } else {
      const floor = text.match(/지하\s*(\d+)\s*층/i);
      const zone = text.match(/([A-Za-z가-힣0-9]+)\s*구역/);
      const spot = text.match(/\b([A-Za-z]\d{1,5})\b/);
      parkingDraft = { floor: floor ? `B${floor[1]}` : '', zone: zone?.[1] || '', spot: spot?.[1]?.toUpperCase() || '' };
      parsedParking = { ...parkingDraft };
      reply = '주차 위치를 알려주셨네요. 아래에서 위치를 확인하면 내 계정에 실제로 저장할 수 있어요.'; action = 'parking';
    }
  } else if (/일정|약속|미팅/.test(text)) { reply = '약속을 놓치지 않도록 일정에 남겨보세요. 지금은 기기 안에 저장하는 일정 화면을 체험할 수 있어요.'; action = 'event'; }
  else if (/여행|제주/.test(text)) { conversation.group = '여행'; reply = '여유로운 여행, 좋네요. 가고 싶은 곳과 여행 날짜를 이 대화에 모아보세요. 실제 여행 검색과 PDF 만들기는 AI 연결 후 제공할 예정이에요.'; }
  else if (/문서|엑셀|pdf|생활비|파일/i.test(text)) { conversation.group = '문서'; reply = '정리할 내용과 원하는 형태를 남겨주세요. 첨부한 파일은 이름만 표시하며, 실제 파일 분석·Excel·PDF 생성은 아직 연결되지 않았어요.'; }
  if (owner === state.user?.id) { conversation.messages.push({ role: 'assistant', text: reply, action, parking: parsedParking }); persistPreview(); setView('chat', conversation.id); }
  state.sending = false;
}
async function loadParking(repaint = true) {
  const owner = state.user?.id, version = sessionVersion; if (!owner) return;
  try { const record = await api('/parking/latest'); if (state.user?.id === owner && version === sessionVersion) { state.parking = record; state.parkingError = ''; } }
  catch (error) { if (state.user?.id !== owner || version !== sessionVersion) return; if (error.status === 404) { state.parking = null; state.parkingError = ''; } else if (error.status === 401) { loseSession(); return; } else state.parkingError = '주차 위치를 새로 확인하지 못했어요.'; }
  if (repaint) render();
}
function loseSession() { ++sessionVersion; state.user = null; state.parking = null; state.parkingError = ''; pendingParking = null; parkingDraft = {}; loadPreview(); state.chatId = null; render(); if (sheet.open) closeSheet(); toast('다시 로그인하면 나의 기억을 이어볼 수 있어요.'); }
async function syncSession() {
  const version = ++sessionVersion;
  const before = JSON.stringify([state.user, state.parking, state.parkingError]);
  try {
    const { user } = await api('/session'); if (version !== sessionVersion) return;
    if (user?.id !== state.user?.id) { state.user = user; state.parking = null; pendingParking = null; parkingDraft = {}; loadPreview();
      const requested = location.hash.slice(1).split('/')[1];
      state.chatId = state.preview.conversations.some(c => c.id === requested) ? requested : null;
    }
    else state.user = user;
    state.ready = true; await loadParking(false);
    if (before !== JSON.stringify([state.user, state.parking, state.parkingError])) render();
    return true;
  } catch (error) { if (version !== sessionVersion) return; if (error.status === 401) loseSession(); state.ready = true; return false; }
}

// All controls stay in one event layer so sheet replacements do not duplicate handlers.
document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action], button[data-view]'); if (!button || button.disabled) return;
  if (button.dataset.view) { setView(button.dataset.view); return; }
  const { action, id } = button.dataset;
  try {
    if (action === 'close') closeSheet();
    else if (action === 'account') await accountSheet();
    else if (action === 'parking') {
      if (button.dataset.messageIndex !== undefined) {
        const message = state.preview.conversations.find(c => c.id === state.chatId)?.messages[Number(button.dataset.messageIndex)];
        if (message?.parking) parkingDraft = { ...message.parking };
      }
      parkingSheet();
    }
    else if (action === 'parking-detail') parkingDetail();
    else if (action === 'reload-parking') await loadParking();
    else if (action === 'floor') { $('#parking-floor').value = button.dataset.value; document.querySelectorAll('.suggestions button').forEach(b => b.setAttribute('aria-pressed', String(b === button))); }
    else if (action === 'copy-parking') { await navigator.clipboard.writeText(parkingLabel(state.parking)); toast('주차 위치를 복사했어요.'); }
    else if (action === 'event' || action === 'event-edit') eventSheet(id);
    else if (action === 'delete-event') { const saved = state.preview.events.find(e => e.id === id); openSheet('일정을 삭제할까요?', `<p class="sheet-description">${esc(saved?.title)}<br>이 기기에 저장한 일정을 삭제해요.</p><button class="primary-button full danger" data-action="confirm-delete-event" data-id="${esc(id)}">삭제하기</button><button class="secondary-button full" data-action="event-edit" data-id="${esc(id)}">다시 돌아가기</button>`); }
    else if (action === 'confirm-delete-event') { state.preview.events = state.preview.events.filter(e => e.id !== id); persistPreview(); closeSheet(); render(); toast('일정을 삭제했어요.'); }
    else if (action === 'prev-month' || action === 'next-month') { state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + (action === 'next-month' ? 1 : -1), 1); render(); }
    else if (action === 'calendar-today') { state.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); state.date = dayKey(); render(); }
    else if (action === 'select-date') { state.date = button.dataset.date; render(); }
    else if (action === 'new-chat') { const chat = createChat(); setView('chat', chat.id); }
    else if (action === 'open-chat') setView('chat', id);
    else if (action === 'filter-chat') { state.chatGroup = button.dataset.group; render(); }
    else if (action === 'chat-group') openSheet('이야기를 모아두는 곳', `<div class="group-options">${['생활', '여행', '문서'].map(g => `<button class="secondary-button full" data-action="move-group" data-group="${g}">${g}${icon('chevron')}</button>`).join('')}</div>`);
    else if (action === 'move-group') { state.preview.conversations.find(c => c.id === state.chatId).group = button.dataset.group; persistPreview(); closeSheet(); toast('이야기를 옮겼어요.'); }
    else if (action === 'trip' || action === 'document' || action === 'parking-chat') { state.chatId = null; await sendMessage(action === 'trip' ? '제주에서 여유로운 2박 3일 보내고 싶어' : action === 'document' ? '이번 달 생활비를 엑셀로 정리하고 싶어' : '지하 2층 C구역 C36에 주차했어'); }
    else if (action === 'voice') voiceSheet();
    else if (action === 'start-speech') startSpeech();
    else if (action === 'voice-example') { $('#voice-text').value = '지하 2층 C구역 C36에 주차했어'; $('#voice-title').textContent = '이렇게 보내볼까요?'; }
    else if (action === 'note') openSheet('작은 기억 남기기', `<form id="note-form"><div class="form-group"><label for="note-title">어떤 기억인가요?</label><input id="note-title" name="title" maxlength="60" placeholder="예: 엄마가 좋아하는 커피" required></div><div class="form-group"><label for="note-body">기억할 내용</label><textarea id="note-body" name="body" rows="4" maxlength="1000" required></textarea></div><p class="private-note">${icon('phone')}이 기억은 현재 기기에만 저장돼요.</p><button class="primary-button full" type="submit">기억 남기기 ${icon('check')}</button></form>`);
    else if (action === 'note-detail') { const note = state.preview.notes.find(n => n.id === id); openSheet(note.title, `<div class="note-detail">${icon('heart')}<p>${esc(note.body)}</p><span class="demo-badge">${note.sample ? '예시 기억' : '기기 내 미리보기'}</span></div>`); }
    else if (action === 'login') { button.disabled = true; $('#login-status').textContent = '안전하게 로그인 화면으로 연결할게요.'; const result = await api('/auth/start', { method: 'POST', data: { provider: button.dataset.provider } }); location.assign(result.url); }
    else if (action === 'logout') { button.disabled = true; const result = await api('/logout', { method: 'POST', data: {} }); loseSession(); toast(result.revoked ? '로그아웃했어요. 다음에 또 만나요.' : '이 기기에서 로그아웃했어요. 서버 연결은 확인하지 못했어요.'); }
    else if (action === 'refresh-account') { button.disabled = true; const synced = await syncSession(); await accountSheet(); toast(synced ? '최신 계정 상태를 확인했어요.' : '연결을 확인하고 다시 시도해 주세요.'); }
    else if (action === 'copy-id') { await navigator.clipboard.writeText(state.user.id); toast('사용자 ID를 복사했어요.'); }
    else if (action === 'check-connection') { button.disabled = true; try { state.providers = await api('/providers'); updateLoginButtons(); $('.connection-status').textContent = '백엔드 연결을 확인했어요.'; } catch (err) { $('.connection-status').textContent = err.message; } finally { button.disabled = false; } }
    else if (action === 'parking-done') { closeSheet(); state.view = 'today'; location.hash = 'today'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  } catch (err) { button.disabled = false; if (err.status === 401) loseSession(); else if ($('#login-status') && action === 'login') { $('#login-status').textContent = err.message; updateLoginButtons(); $('#login-status').textContent = err.message; } else toast(err.message || '지금은 처리할 수 없어요. 다시 시도해 주세요.'); }
});
document.addEventListener('submit', async event => {
  const form = event.target; if (!['parking-form', 'event-form', 'chat-form', 'voice-form', 'note-form'].includes(form.id)) return;
  event.preventDefault(); const values = Object.fromEntries(new FormData(form));
  if (form.id === 'parking-form') {
    if (submitting) return; const owner = state.user?.id; if (!owner) return accountSheet();
    try {
      pendingParking = parkingAttempt(pendingParking, values); parkingDraft = values;
      submitting = true; form.querySelector('button[type=submit]').disabled = true; form.querySelector('button[type=submit]').textContent = '기억하고 있어요…'; $('#parking-error').textContent = '';
      const record = await api('/parking', { method: 'POST', data: pendingParking.payload, key: pendingParking.key });
      if (owner !== state.user?.id) return;
      state.parking = record; state.parkingError = ''; pendingParking = null; parkingDraft = {}; render();
      openSheet('잘 기억해 뒀어요', `<div class="success-scene"><span class="success-ring">${icon('check')}</span>${mascot()}</div><div class="success-copy"><h3>주차 위치,<br>모리에게 맡겨두세요.</h3><p class="saved-location">${esc(parkingLabel(record))}</p><p>${esc(savedAt(record.recorded_at))} · 계정에 저장 완료</p></div><button class="primary-button full" data-action="parking-done">오늘에서 확인하기 ${icon('arrow')}</button>`, 'success');
    } catch (err) { if (err.status === 401) { loseSession(); accountSheet(); } else if ($('#parking-error')) $('#parking-error').textContent = err.message; }
    finally { submitting = false; const submit = form.querySelector('button[type=submit]'); submit.disabled = false; submit.textContent = pendingParking ? '같은 위치 다시 저장하기' : '이 위치 기억하기'; }
  } else if (form.id === 'event-form') {
    if (!values.title.trim()) { toast('약속 이름을 입력해 주세요.'); return; }
    const e = { id: form.dataset.id || uid(), title: values.title.trim(), place: values.place.trim(), date: values.date, time: values.time, sample: false };
    const index = state.preview.events.findIndex(item => item.id === e.id); if (index >= 0) state.preview.events[index] = e; else state.preview.events.push(e);
    state.date = e.date; state.calendarMonth = new Date(e.date + 'T12:00:00'); state.calendarMonth.setDate(1); persistPreview(); closeSheet(); render(); toast('이 기기의 일정에 저장했어요.');
  } else if (form.id === 'chat-form' || form.id === 'voice-form') { if (form.id === 'voice-form') stopSpeech(); await sendMessage(values.message); }
  else if (form.id === 'note-form') { state.preview.notes.push({ id: uid(), title: values.title.trim(), body: values.body.trim() }); persistPreview(); closeSheet(); render(); toast('이 기기에 기억을 남겼어요.'); }
});
document.addEventListener('change', event => { if (event.target.id === 'files') { state.files = [...event.target.files].slice(0, 5).map(f => ({ name: f.name })); const draft = $('#message')?.value; render(); if ($('#message')) $('#message').value = draft || ''; toast('파일 이름만 첨부했어요. 파일 내용은 전송하지 않아요.'); } });
document.addEventListener('keydown', event => { if (event.target.id === 'message' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); event.target.form.requestSubmit(); } });
sheet.addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
sheet.addEventListener('click', event => { if (event.target === sheet) { const r = sheet.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeSheet(); } });
window.addEventListener('hashchange', route);
window.addEventListener('focus', () => { if (!sheet.open && !submitting) syncSession(); });
let homeTimeKey = dayKey() + phaseAt();
setInterval(() => {
  const next = dayKey() + phaseAt();
  if (next !== homeTimeKey && state.view === 'today' && !sheet.open && document.visibilityState === 'visible') { homeTimeKey = next; render(); }
}, 60000);
loadPreview(); route();
api('/config').then(config => { state.config = config; }).catch(() => {});
const loginResult = new URLSearchParams(location.search).get('login');
if (loginResult) { history.replaceState(null, '', location.pathname + location.hash); }
await syncSession();
if (loginResult === 'success' && state.user) toast(`${state.user.display_name} 님, 반가워요. 모리가 함께할게요.`);
else if (loginResult) { toast(loginResult === 'cancelled' ? '로그인을 취소했어요. 준비되면 다시 만나요.' : '로그인을 완료하지 못했어요. 처음부터 다시 시도해 주세요.'); accountSheet(); }
