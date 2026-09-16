import { defaultParkingRule, selectContext, classify, readTime, readDate, minutes, updateParkingRule } from './assistant-model.mjs';

(() => {
  'use strict';

  const $ = (query, root = document) => root.querySelector(query);
  const $$ = (query, root = document) => [...root.querySelectorAll(query)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const key = 'mori.poc.v1';
  const today = new Date();
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dayOffset = n => { const date = new Date(today); date.setDate(date.getDate() + n); return dateKey(date); };
  const fromKey = value => new Date(`${value}T12:00:00`);
  const dateLabel = value => fromKey(value).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
  const timeLabel = value => { const [h, m] = value.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : '시'}`; };
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const seed = () => ({
    parking: { location: '지하 3층 B12', place: '우리 집 주차장', updatedAt: `${dayOffset(-1)}T20:42:00` },
    events: [
      { id: 'seed-1', title: '엄마와 점심 약속', date: dateKey(today), time: '12:30', place: '연남동 소이연남', color: 'orange' },
      { id: 'seed-2', title: '가볍게 산책하기', date: dateKey(today), time: '19:00', place: '집 앞 공원', color: 'green' },
      { id: 'seed-3', title: '민수와 저녁 약속', date: dayOffset(2), time: '18:00', place: '강남역 2번 출구', color: 'purple' },
    ],
    routines: [
      { id: 'parking', title: '출근길, 내 차 위치', description: '평일 아침에 마지막 주차 위치를 보여드려요.', time: '07:30', enabled: true, icon: 'car', learned: true },
      { id: 'daily', title: '하루를 시작하는 일정 한눈에', description: '오늘 약속과 챙길 일을 아침에 정리해요.', time: '08:00', enabled: true, icon: 'sun', learned: false },
      { id: 'tomorrow', title: '내일을 준비하는 저녁', description: '잠들기 전, 내일의 일정을 미리 알려드려요.', time: '21:00', enabled: false, icon: 'calendar', learned: false },
    ],
    notes: [{ id: 'note-seed', title: '엄마가 좋아하는 커피', content: '따뜻한 디카페인 라떼, 시럽은 빼고.', createdAt: dayOffset(-2) }],
    approval: 'pending',
    trip: null,
    personalization: true,
    parkingRule: defaultParkingRule(),
    messages: [{ id: 'hello', role: 'assistant', text: '안녕하세요. 기억할 일부터 여행과 문서까지, 편하게 말씀해 주세요. 출근길에 찾던 주차 위치는 평일 아침에 제가 먼저 꺼내둘게요.' }],
    artifacts: [],
    pending: null,
  });
  let state;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    state = saved && Array.isArray(saved.events) && Array.isArray(saved.routines) && Array.isArray(saved.notes) ? { ...seed(), ...saved } : seed();
  } catch { state = seed(); }
  let view = 'today';
  let selectedDate = dateKey(today);
  let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let memoryFilter = 'all';
  let toastTimer;
  let modalReturnFocus;
  let previewMode = 'live';
  let chatDraft = '';
  let draftFiles = [];
  let recording = false;
  let voiceText = '지하 2층 C18에 주차했어';
  const modal = $('#modal');
  const main = $('#main');

  function save() {
    try { localStorage.setItem(key, JSON.stringify(state)); }
    catch { toast('이 브라우저에서는 기록이 새로고침 후 유지되지 않을 수 있어요.'); }
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('#toast').innerHTML = `${icon('check')}<span>${esc(message)}</span>`;
    $('#toast').classList.add('visible');
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3800);
  }
  const todayEvents = () => state.events.filter(event => event.date === dateKey(today)).sort((a, b) => a.time.localeCompare(b.time));
  const savedLabel = () => state.parking ? new Date(state.parking.updatedAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

  function mascot() {
    return `<svg class="mascot" viewBox="0 0 320 190" fill="none" aria-hidden="true">
      <ellipse cx="187" cy="165" rx="91" ry="9" fill="#aebca4" opacity=".23"/>
      <path d="M106 100c0-31 19-63 54-63 12 0 21 4 29 12 7-5 16-8 25-8 32 0 52 26 52 56v37c0 21-17 33-41 33h-81c-26 0-38-14-38-34v-33Z" fill="#f9fbef"/>
      <path d="M182 48c-14-12-14-31-4-35 13-4 18 17 4 35Z" fill="#839c6e"/>
      <path d="M182 49c2-20 16-30 28-23 8 8-9 24-28 23Z" fill="#adc49a"/>
      <path d="M159 102v7m47-7v7" stroke="#425545" stroke-width="6" stroke-linecap="round"/>
      <path d="M174 119c4 5 11 5 15 0" stroke="#425545" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="148" cy="119" rx="10" ry="5" fill="#eebbb0" opacity=".65"/><ellipse cx="218" cy="119" rx="10" ry="5" fill="#eebbb0" opacity=".65"/>
      <path d="M110 118c-15-8-26-2-20 7l22 10m149-23c19-17 30-10 20 2l-20 15" fill="#f9fbef"/>
      <rect x="54" y="52" width="57" height="45" rx="11" fill="white" transform="rotate(-13 54 52)"/>
      <path d="m72 71 7 6 12-18" stroke="#719b76" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="m274 43 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" fill="#bca46f"/>
      <circle cx="88" cy="133" r="3" fill="#abb99f"/><circle cx="291" cy="91" r="4" fill="#c7d5bd"/>
    </svg>`;
  }

  function parkingCard() {
    const parking = state.parking;
    return `<article class="card parking-card"><div class="card-top"><span class="card-kicker">${icon('car')} 마지막으로 기억한 주차 위치</span><button class="text-button" data-action="parking">${parking ? '수정' : '기억하기'}</button></div>
      <div class="parking-body"><div><h3>${parking ? esc(parking.location) : '오늘, 어디에 주차했나요?'}</h3><p>${parking ? esc(parking.place || '저장한 주차 위치') : '한 번 알려주면 모리가 기억해 둘게요.'}</p></div><div class="parking-sign" aria-hidden="true">P<span>MY SPOT</span></div></div>
      <div class="card-bottom"><span>${icon('clock')} ${parking ? esc(savedLabel()) + ' 기록' : '아직 저장된 위치가 없어요'}</span>${parking ? `<button class="text-button subtle" data-action="parking-detail">자세히 ${icon('chevron')}</button>` : ''}</div></article>`;
  }
  function eventRows(events) {
    return events.length ? events.map(event => `<button class="event-row" data-action="event-detail" data-id="${esc(event.id)}"><span class="event-time">${esc(timeLabel(event.time))}</span><span class="event-bar ${esc(event.color || 'green')}"></span><span class="event-content"><strong>${esc(event.title)}</strong><small>${icon('pin')}${esc(event.place || '장소를 정하지 않았어요')}</small></span>${icon('chevron', 'row-chevron')}</button>`).join('') : `<div class="empty-state compact">${icon('leaf')}<strong>비워둔 시간도 좋아요.</strong><p>새로운 약속이 생기면 모리에게 알려주세요.</p><button class="text-button" data-action="event-chat">말로 약속 남기기 ${icon('chat')}</button></div>`;
  }
  function previewClock() {
    const now = new Date();
    if (previewMode === 'live') return now;
    if (previewMode === 'rule') {
      while (!state.parkingRule.weekdays.includes(now.getDay())) now.setDate(now.getDate() + 1);
      const clock = minutes(state.parkingRule.start); now.setHours(Math.floor(clock / 60), clock % 60, 0, 0); return now;
    }
    const day = now.getDay();
    now.setDate(now.getDate() + (previewMode === 'weekend' ? (6 - day + 7) % 7 : day === 0 ? 1 : day === 6 ? 2 : 0));
    now.setHours(({ commute: 7, afternoon: 14, evening: 21, weekend: 8 })[previewMode], previewMode === 'commute' ? 30 : 0, 0, 0);
    return now;
  }
  function contextCard() {
    const now = previewClock();
    const context = selectContext(state, now);
    const parking = context.kind === 'parking';
    return `<section class="context-widget ${parking ? 'commute' : ''}" aria-label="지금 필요한 비서 위젯"><div class="context-top"><span class="live-label">${icon('spark')} 지금, 나에게 필요한 것</span><span>${previewMode === 'live' ? '현재' : '체험'} ${now.toLocaleDateString('ko-KR', { weekday: 'short' })} ${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</span></div><div class="context-body"><div><p class="context-reason">${esc(context.reason)}</p><h2>${esc(context.title)}</h2><p class="context-subtitle">${esc(context.subtitle)}</p>${parking && state.parking ? `<span class="context-timestamp">${icon('clock')} ${esc(savedLabel())}에 남긴 마지막 기록</span>` : ''}</div><div class="context-illustration" aria-hidden="true">${parking ? '<span class="parking-plaque">P<small>MY SPOT</small></span>' : mascot()}</div></div><div class="context-bottom"><span>${icon('check')} 모리가 필요한 시간에 자동으로 꺼냈어요</span><button class="text-button" data-action="${parking ? 'parking-chat' : context.event ? 'event-detail' : 'chat'}" ${context.event ? `data-id="${esc(context.event.id)}"` : ''}>${parking ? '모리에게 이어서 말하기' : context.event ? '약속 자세히' : '모리와 대화하기'} ${icon('arrow')}</button></div></section>`;
  }
  function composer(home = false) {
    return `<form id="chat-form" class="conversation-composer ${home ? 'home-composer' : ''}"><label for="message">${home ? '무엇이든, 모리에게 말해 주세요.' : '모리에게 보내는 메시지'}</label><div class="composer-entry"><textarea id="message" name="message" rows="1" maxlength="2000" placeholder="${home ? '약속 · 여행 · 문서, 부탁해요' : '편하게 이야기해요'}">${esc(chatDraft)}</textarea><button type="button" class="composer-mic" data-action="voice" aria-label="음성으로 대화하기">${icon('mic')}</button><button type="submit" class="composer-send" aria-label="메시지 보내기">${icon('arrow')}</button></div><div class="composer-tools"><label class="attachment-button">${icon('plus')} 파일 첨부<input id="chat-files" type="file" accept=".pdf,.xlsx,.xls,.csv,.txt" multiple aria-label="PDF 또는 Excel 파일 첨부"></label><span>${home ? '말하거나 적으면, 대화로 이어져요' : 'Enter로 전송 · Shift+Enter로 줄바꿈'}</span></div>${draftFiles.length ? `<div class="attached-files">${draftFiles.map(f => `<span>${icon('book')}${esc(f.name)}</span>`).join('')}<button type="button" data-action="clear-attachments" aria-label="첨부 목록 비우기">${icon('close')}</button></div>` : ''}</form>`;
  }
  function home() {
    const events = todayEvents();
    return `<section class="page-intro compact-intro"><div><div class="date-eyebrow">${icon('sun')} ${today.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })}</div><h1>오늘도, 모리가 챙길게요.</h1></div><label class="clock-preview">시간대 체험<select id="context-preview" aria-label="위젯 시간대 체험">${[['live','실제 요일 · 현재 시간'],['rule',`기억한 시간 · ${state.parkingRule.start}`],['commute','평일 · 출근길 07:30'],['afternoon','평일 · 오후 14:00'],['evening','평일 · 저녁 21:00'],['weekend','토요일 · 오전 08:00']].map(([v,t]) => `<option value="${v}" ${previewMode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></section><div id="context-slot">${contextCard()}</div>
      <section class="home-conversation"><div class="section-heading"><h2>${icon('chat')} 모리와 대화</h2><button class="text-button" data-view="chat">대화 이어보기 ${icon('arrow')}</button></div>${composer(true)}<div class="request-chips" aria-label="대화로 부탁하기">${suggestions()}</div></section>
      <div class="dashboard-grid"><section><div class="section-heading"><h2>오늘의 일정 <span class="count">${events.length}</span></h2><button class="text-button" data-view="calendar">캘린더 보기 ${icon('arrow')}</button></div><article class="card agenda-card">${eventRows(events)}<button class="add-agenda" data-action="event-chat">${icon('chat')} 새로운 약속, 말로 알려주기</button></article></section><aside class="assistant-memory"><span class="learned-label">${icon('spark')} 모리가 배운 나의 일상</span><h3>출근길에 찾던 주차 위치,<br>이제 먼저 보여드려요.</h3><p>반복되는 부탁을 기억해 두고 필요한 시간에 첫 카드로 꺼내요. 따로 위젯을 추가할 필요 없어요.</p><button class="text-button" data-view="routines">모리가 기억한 방식 보기 ${icon('arrow')}</button></aside></div><p class="poc-footnote">현재는 저장된 규칙과 예시 응답으로 동작하는 화면 체험이에요. Hermes·음성 인식·휴대폰 위젯은 연결 전입니다.</p>`;
  }
  function suggestions() {
    return [['car','내 차 어디 있지?','내 차 어디에 주차했지?'],['calendar','약속 기억해 줘','내일 오후 6시에 강남역에서 민수와 저녁 약속을 등록해 줘'],['compass','여행 계획 부탁해','제주 2박 3일 여행 계획을 짜줘'],['book','PDF · Excel 작업','이번 달 지출 정리용 엑셀 양식을 만들어줘']].map(([glyph,label,text]) => `<button data-action="chat-suggest" data-value="${esc(text)}">${icon(glyph)}${label}</button>`).join('');
  }
  function cardMarkup(card) {
    if (!card) return '';
    if (card.kind === 'parking') return `<div class="reply-card"><span class="reply-label">${icon('car')} 기억한 주차 위치</span><h3>${esc(card.location)}</h3><p>${esc(card.place)} · ${esc(card.time)}</p><button class="text-button" data-action="commute-preview">대시보드에서 출근길 미리보기 ${icon('arrow')}</button></div>`;
    if (card.kind === 'rule') return `<div class="reply-card"><span class="reply-label">${icon('spark')} ${card.disabled ? '잠시 쉬는 기억' : '자동으로 챙기는 방식'}</span><h3>${card.disabled ? '출근길 주차 카드 표시를 멈췄어요' : '출근길에는 주차 위치를 먼저'}</h3><p>${esc(card.prompt)}</p><button class="text-button" data-action="commute-preview">첫 위젯 확인하기 ${icon('arrow')}</button></div>`;
    if (card.kind === 'event') return `<div class="reply-card"><span class="reply-label">${icon('calendar')} 캘린더에 기억했어요</span><h3>${esc(card.event.title)}</h3><p>${esc(dateLabel(card.event.date))} ${esc(timeLabel(card.event.time))}</p><p>${esc(card.event.place || '장소 미정')}</p><button class="text-button" data-action="event-detail" data-id="${esc(card.event.id)}">일정 확인·수정 ${icon('arrow')}</button></div>`;
    if (card.kind === 'choices') return `<div class="reply-choices">${card.options.map(option => `<button data-action="chat-suggest" data-value="${esc(option)}" ${!card.requestId || card.requestId !== state.pending?.id ? 'disabled' : ''}>${esc(option)}</button>`).join('')}</div>`;
    const artifact = state.artifacts.find(a => a.id === card.artifactId);
    if (!artifact) return '';
    return `<div class="reply-card artifact-card"><span class="reply-label">${icon(artifact.trip ? 'compass' : 'book')} ${artifact.trip ? '여행 계획 · 예시' : '문서 작업 · 예시'}</span><h3>${esc(artifact.title)}</h3><p>${esc(artifact.description)}</p>${artifact.trip ? `<ol class="trip-outline">${tripPlan(artifact.trip).map(day => `<li><span>DAY ${day.day}</span>${esc(day.title)}</li>`).join('')}</ol>` : ''}<div class="artifact-actions"><button data-action="artifact-preview" data-id="${artifact.id}">${icon('book')} PDF 미리보기</button><button data-action="artifact-csv" data-id="${artifact.id}">${icon('download')} Excel용 CSV</button>${artifact.trip ? `<button data-action="trip-approval" data-id="${artifact.id}">${icon('calendar')} 일정에도 담기</button>` : ''}</div><small>실제 검색·파일 분석 전 예시 · PDF는 인쇄로 저장</small></div>`;
  }
  function chatPage() {
    return `<section class="page-intro chat-page-intro"><div><div class="date-eyebrow">${icon('leaf')} 나의 작은 비서</div><h1>모리와 이야기해요.</h1><p>말한 기억이, 필요한 순간의 도움으로 이어져요.</p></div><button class="text-button" data-view="today">오늘 화면 ${icon('arrow')}</button></section><section class="conversation-panel"><div class="conversation-heading"><span class="mini-mark">m</span><div><strong>모리</strong><span>기억 · 일정 · 여행 · 문서</span></div><span class="tiny-pill">대화 체험</span></div><div class="conversation-log" role="log" aria-label="모리와 나눈 대화" aria-live="polite">${state.messages.map(message => `<article class="conversation-message ${message.role}">${message.role === 'assistant' ? '<span class="message-avatar">m</span>' : ''}<div class="message-content"><span class="message-meta">${message.role === 'assistant' ? '모리' : '나'}${message.source === 'voice' ? ' · 음성으로 보냄' : ''}</span><div class="message-bubble">${esc(message.text)}</div>${message.files?.length ? `<div class="message-files">${message.files.map(f => `<span>${icon('book')}${esc(f.name)}</span>`).join('')}</div>` : ''}${cardMarkup(message.card)}</div></article>`).join('')}</div><div class="chat-dock">${recording ? voicePanel() : composer()}${!recording && state.messages.length < 2 ? `<div class="request-chips">${suggestions()}</div>` : ''}<p class="chat-disclaimer">${draftFiles.length ? '첨부 파일은 이름만 표시해요. 내용 분석·업로드는 하지 않아요.' : '음성·AI는 예시 흐름이며 대화와 기록은 이 브라우저에 저장돼요.'}</p></div></section>`;
  }
  function voicePanel() {
    return `<div class="voice-in-chat"><div class="voice-status"><div class="waveform" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div><strong>말하기를 마치면 대화로 전달해요.</strong><span>음성 인식 시뮬레이션 · 실제 녹음 없음</span></div><label class="field"><span>체험할 음성 문장</span><textarea id="voice-transcript" rows="2" maxlength="2000">${esc(voiceText)}</textarea></label><div class="voice-examples">${['지하 2층 C18에 주차했어','내일 오후 6시에 강남역에서 민수와 약속을 등록해 줘','부산 2박 3일 여행 계획을 짜줘','회의 내용을 PDF 문서로 정리해 줘'].map(t => `<button data-action="voice-example" data-value="${esc(t)}">${esc(t)}</button>`).join('')}</div><div class="voice-controls"><button class="button secondary" data-action="voice-cancel">취소</button><button class="button primary" data-action="voice-stop">${icon('check')} 말하기 종료 · 대화로 보내기</button></div></div>`;
  }
  function scrollChat() { const log = $('.conversation-log'); if (log) log.scrollTop = log.scrollHeight; }
  function startChat(draft = '') { closeModal(); recording = false; chatDraft = draft; navigate('chat'); scrollChat(); $('#message')?.focus({ preventScroll: true }); }
  function voice() { closeModal(); chatDraft = $('#message')?.value || chatDraft; recording = true; navigate('chat'); scrollChat(); }
  function respond(text, card) { if (card?.kind === 'choices' && state.pending) { state.pending.id = uid(); card.requestId = state.pending.id; } state.messages.push({ id: uid(), role: 'assistant', text, card }); }
  function createArtifact(text, trip = null, files = []) {
    const artifact = { id: uid(), title: trip ? `${trip.destination}, ${trip.days}일의 느긋한 여행` : /엑셀|excel|표/i.test(text) ? '내가 부탁한 정리표' : '내가 부탁한 문서', description: trip ? '걷고, 쉬고, 천천히 둘러보는 예시 계획이에요.' : '부탁한 내용을 담은 문서 초안입니다. 실제 내용 분석 전 체험용 양식이에요.', request: text, trip, rows: trip ? [['일차','주제','일정'], ...tripPlan(trip).flatMap(d => d.activities.map(a => [String(d.day),d.title,a]))] : [['항목','내용'],['요청',text],['첨부',files.map(f => f.name).join(', ') || '없음'],['정리할 내용','내용을 채워 주세요'],['메모','예시 양식 · 실제 파일 분석 전']] };
    state.artifacts.push(artifact); return artifact;
  }
  function addChatEvent(pending) {
    const title = pending.text.replace(/(?:오늘|내일|모레|다음\s*주|[월화수목금토일]요일)/g, '').replace(/(?:오전|오후|아침|저녁|밤)?\s*\d{1,2}(?:시(?:\s*(?:반|\d+분))?|:\d{2})에?/g, '').replace(/(?:을|를)?\s*(등록|추가|저장|기억)해\s*줘.*$/, '').trim();
    const event = { id: uid(), title: title || '새로운 약속', date: pending.date, time: pending.time, place: pending.text.match(/([가-힣A-Za-z0-9]+)에서/)?.[1] || '', color: 'green' };
    state.events.push(event); state.pending = null; respond('약속을 기억했어요. 시간이 가까워지면 오늘 화면에서도 먼저 챙겨드릴게요.', { kind: 'event', event: { ...event } });
  }
  function handleRequest(text, files) {
    if (/취소|그만할게/.test(text) && state.pending) { state.pending = null; respond('진행 중이던 부탁은 취소했어요. 다른 이야기를 들려주세요.'); return; }
    if (files.length) { state.pending = null; const artifact = createArtifact(text || '첨부 파일 정리', null, files); respond('파일을 대화에 붙였어요. 지금은 파일 이름과 요청을 담은 예시 작업 카드를 보여드려요. 실제 파일 내용은 읽거나 서버로 전송하지 않았어요.', { kind: 'artifact', artifactId: artifact.id }); return; }
    if (state.pending?.kind === 'event') {
      const parsedTime = readTime(text);
      const pending = state.pending;
      pending.date = readDate(text, new Date()) || pending.date;
      if (parsedTime?.value) pending.time = parsedTime.value;
      if (!pending.date) { respond('어느 날의 약속인가요?', { kind: 'choices', options: ['오늘', '내일', '취소'] }); return; }
      if (!pending.time) { respond('몇 시 약속인지 오전·오후와 함께 알려주세요.', { kind: 'choices', options: [`오전 ${pending.hour || 9}시${pending.minute ? ` ${pending.minute}분` : ''}`, `오후 ${pending.hour || 6}시${pending.minute ? ` ${pending.minute}분` : ''}`, '취소'] }); return; }
      addChatEvent(pending); return;
    }
    if (state.pending?.kind === 'trip') {
      const destination = text.replace(/(?:으로|로)?\s*(가자|부탁해|해줘|여행).*$/, '').trim();
      const trip = { destination: destination.slice(0,40), days: state.pending.days, company: '함께 떠나는 여행' };
      state.pending = null; state.trip = trip; const artifact = createArtifact(text, trip); respond('이 여행지로 예시 계획을 정리했어요. 같은 대화에서 PDF와 표 파일로 확인해 보세요.', { kind: 'artifact', artifactId: artifact.id }); return;
    }
    if (/주차/.test(text) && /끄|그만|중지/.test(text)) { state.parkingRule.enabled = false; respond('출근길 주차 카드를 잠시 쉬도록 기억했어요.', { kind: 'rule', prompt: state.parkingRule.prompt, disabled: true }); return; }
    const request = classify(text, new Date());
    switch (request.kind) {
      case 'rule': {
        const rule = updateParkingRule(text, state.parkingRule); state.parkingRule = rule; respond('이 방식으로 기억해 둘게요. 위젯을 따로 추가하지 않아도 해당 시간에 최신 주차 위치가 첫 카드로 나와요.', { kind: 'rule', prompt: rule.prompt }); break;
      }
      case 'parking-save': state.parking = { location: request.location, place: state.parking?.place || '최근 주차한 곳', updatedAt: new Date().toISOString() }; respond('주차 위치를 기억했어요. 출근길에 보여드리는 카드도 이 위치로 바뀌어요.', { kind:'parking', ...state.parking, time:savedLabel() }); break;
      case 'parking-read':
        if (state.parking) respond('마지막으로 기억한 주차 위치예요.', { kind:'parking', ...state.parking, time:savedLabel() });
        else respond('아직 기억한 위치가 없어요. “지하 2층 C18에 주차했어”처럼 알려주세요.');
        break;
      case 'events-read': respond(todayEvents().length ? `오늘은 ${todayEvents().map(e => `${timeLabel(e.time)} ${e.title}`).join(', ')} 일정이 있어요.` : '오늘 등록된 일정이 없어요. 약속이 생기면 편하게 알려주세요.'); break;
      case 'event': state.pending = request; if (request.date && request.time) addChatEvent(request); else respond(request.date ? '오전인지 오후인지 함께 알려주실래요?' : '어느 날의 약속인지 알려주세요.', { kind:'choices', options: request.date ? [`오전 ${request.hour || 9}시${request.minute ? ` ${request.minute}분` : ''}`, `오후 ${request.hour || 6}시${request.minute ? ` ${request.minute}분` : ''}`, '취소'] : ['오늘', '내일', '취소'] }); break;
      case 'trip': {
        if (request.days < 2 || request.days > 5) { respond('이번 체험에서는 2일부터 5일까지의 예시 여행을 만들 수 있어요. 여행지와 기간을 다시 알려주세요.'); break; }
        if (!request.destination) { state.pending = request; respond('어디로 떠날까요?', { kind:'choices', options:['제주','부산','강릉'] }); break; }
        state.trip = { destination: request.destination, days: request.days, company: '함께 떠나는 여행' }; const artifact = createArtifact(text, state.trip); respond('여행의 밑그림을 그려봤어요. 자세한 계획과 PDF·Excel용 표를 여기서 이어서 확인할 수 있어요.', { kind:'artifact', artifactId:artifact.id }); break;
      }
      case 'document': { const recent = state.artifacts.at(-1); const artifact = /이거|이걸|여행|방금/.test(text) && recent ? recent : createArtifact(text); respond('대화에서 바로 문서 작업으로 이어갈게요. 아래 예시 결과에서 PDF 미리보기나 Excel용 표를 열어보세요.', { kind:'artifact', artifactId:artifact.id }); break; }
      case 'note': state.notes.unshift({ id: uid(), title: text.slice(0,40), content:text, createdAt:dateKey(today) }); respond('말씀하신 내용을 내 기록에 남겨뒀어요. 필요할 때 다시 꺼내 보세요.'); break;
      default: respond('편하게 이야기해 주세요. 실제 AI 연결 전이라 지금은 주차 기억, 약속 등록, 여행 계획, PDF·Excel 문서 요청의 예시 흐름을 체험할 수 있어요.');
    }
  }
  function sendChat(text, source = 'text') {
    text = text.trim(); if (!text && !draftFiles.length) return;
    const files = draftFiles.map(f => ({ name: f.name }));
    state.messages.push({ id: uid(), role:'user', text:text || '이 파일을 정리해 줘', source, files });
    chatDraft = ''; draftFiles = []; recording = false;
    handleRequest(text, files); save(); navigate('chat'); scrollChat();
    if (source === 'text') $('#message')?.focus({ preventScroll:true });
  }
  function showArtifact(id) {
    const artifact = state.artifacts.find(a => a.id === id); if (!artifact) return;
    openModal(`${modalTitle(esc(artifact.title), esc(artifact.description))}<div class="demo-notice">${artifact.trip ? '실제 검색 전 예시 계획이에요. 장소와 운영시간을 확인하지 않았어요.' : '요청을 담은 예시 양식이에요. 첨부 파일의 내용 분석 결과가 아닙니다.'}</div>${artifact.trip ? `<div class="trip-days">${tripPlan(artifact.trip).map(day => `<section><span class="day-tag">DAY ${day.day}</span><h3>${esc(day.title)}</h3>${day.activities.map(a => `<p>${esc(a)}</p>`).join('')}</section>`).join('')}</div>` : `<div class="document-preview">${artifact.rows.slice(1).map(row => `<section><h3>${esc(row[0])}</h3><p>${esc(row[1])}</p></section>`).join('')}</div>`}<button class="button primary full" data-action="print-trip">${icon('download')} 인쇄 · PDF로 저장</button><p class="print-help fine-print" hidden>인쇄 창에서 PDF 저장을 선택해 주세요. 창이 열리지 않으면 Chrome 또는 Safari에서 같은 페이지를 열어주세요.</p>`, '대화에서 만든 문서');
  }
  function downloadRows(rows, name) {
    const csv = '\uFEFF' + rows.map(row => row.map(cell => `"${String(cell).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"','""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  function calendar() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const offset = new Date(year, month, 1).getDay();
    const end = new Date(year, month + 1, 0).getDate();
    const cells = Array.from({ length: Math.ceil((offset + end) / 7) * 7 }, (_, i) => {
      const date = new Date(year, month, i - offset + 1);
      const id = dateKey(date);
      const count = state.events.filter(e => e.date === id).length;
      return `<button class="calendar-day ${date.getMonth() !== month ? 'muted-day' : ''} ${id === selectedDate ? 'selected-day' : ''} ${id === dateKey(today) ? 'is-today' : ''}" data-action="select-date" data-value="${id}" aria-label="${dateLabel(id)}${count ? `, 일정 ${count}개` : ''}" aria-pressed="${id === selectedDate}"><span>${date.getDate()}</span>${count ? `<i class="date-dot"></i>` : ''}</button>`;
    }).join('');
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('calendar')} 나의 시간</div><h1>약속은 모리가 기억할게요.</h1><p>오늘부터 다가오는 날까지, 한눈에 살펴보세요.</p></div><button class="button primary" data-action="event-chat">${icon('chat')} 말로 일정 남기기</button></section>
      <div class="calendar-layout"><section class="card calendar-card"><div class="month-heading"><h2>${year}년 ${month + 1}월</h2><div><button class="icon-button" data-action="prev-month" aria-label="이전 달">${icon('chevron', 'flipped')}</button><button class="text-button" data-action="calendar-today">오늘</button><button class="icon-button" data-action="next-month" aria-label="다음 달">${icon('chevron')}</button></div></div><div class="calendar-week">${['일', '월', '화', '수', '목', '금', '토'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells}</div><p class="calendar-legend"><i></i> 약속이 있는 날 <span class="today-marker"></span> 오늘</p></section><section><div class="section-heading"><h2>${esc(dateLabel(selectedDate))}</h2></div><article class="card agenda-card">${eventRows(state.events.filter(e => e.date === selectedDate).sort((a, b) => a.time.localeCompare(b.time)))}</article><div class="soft-tip">${icon('mic')}<p>“토요일 6시에 민수랑 저녁 약속”<br><span>말로 알려줘도 일정이 돼요.</span></p><button class="icon-button" data-action="voice" aria-label="음성 입력 체험">${icon('arrow')}</button></div></section></div>`;
  }
  function memories() {
    const showLife = memoryFilter !== 'trip';
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('book')} 나 대신 기억해요</div><h1>작은 기억들이 모이는 곳.</h1><p>말해둔 것, 적어둔 것. 필요할 때 다시 꺼내보세요.</p></div><button class="button primary" data-action="chat">${icon('chat')} 모리에게 기억 부탁하기</button></section><div class="filter-tabs" aria-label="기록 종류">${[['all', '모든 기록'], ['life', '생활 기록'], ['trip', '여행 계획']].map(([id, label]) => `<button data-action="memory-filter" data-value="${id}" aria-pressed="${memoryFilter === id}" class="${memoryFilter === id ? 'active' : ''}">${label}</button>`).join('')}</div><div class="memory-grid">${showLife ? parkingCard() : ''}${showLife ? state.notes.map(note => `<article class="card note-card"><span class="action-icon peach">${icon('book')}</span><span class="tiny-label">생활 기록</span><h3>${esc(note.title)}</h3><p>${esc(note.content)}</p><div class="card-bottom"><small>${esc(dateLabel(note.createdAt))}</small><button class="text-button" data-action="note-detail" data-id="${esc(note.id)}">기록 보기 ${icon('arrow')}</button></div></article>`).join('') : ''}${memoryFilter !== 'life' ? `<article class="card trip-memory"><div class="trip-landscape" aria-hidden="true"><span class="landscape-sun"></span><span class="mountain one"></span><span class="mountain two"></span><span class="landscape-caption">a little getaway</span></div><div class="trip-memory-body"><span class="tiny-label">${state.trip ? '내가 만든 여행 계획' : '미리 준비한 예시 여행'}</span><h3>${state.trip ? esc(state.trip.destination) + ', ' + state.trip.days + '일의 느긋한 여행' : '제주, 느긋하게 보내는 3일'}</h3><p>바다를 걷고, 맛있는 걸 먹고, 잠깐 쉬어가요.</p><button class="text-button" data-action="${state.trip ? 'trip-result' : 'sample-trip'}">여행 계획 보기 ${icon('arrow')}</button></div></article>` : ''}</div>`;
  }
  function routines() {
    const rule = state.parkingRule;
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('spark')} 모리가 기억한 방식</div><h1>부탁하지 않아도, 필요한 순간에.</h1><p>반복되는 대화를 기억해 두고 첫 위젯을 알아서 챙겨요.</p></div></section><div class="routine-layout"><section class="routine-list"><article class="card learned-rule-card"><span class="learned-label">${icon('spark')} ${esc(rule.source)}</span><h2>출근 전에 내 차 위치 꺼내두기</h2><p class="rule-quote">“${esc(rule.prompt)}”</p><div class="rule-schedule"><span>${icon('calendar')} ${rule.weekdays.length === 7 ? '매일' : rule.weekdays.length === 2 ? '주말' : '월 · 화 · 수 · 목 · 금'}</span><span>${icon('clock')} ${rule.start}–${rule.end}</span><span class="status-pill">${rule.enabled ? '자동으로 표시 중' : '잠시 쉬는 중'}</span></div><p class="rule-explanation">주차 위치 자체를 고정해 두지 않아요. 대화에서 새로 알려주면 그때의 최신 기록을 보여드려요.</p><div class="rule-actions"><button class="button secondary" data-action="rule-chat">${icon('chat')} 대화로 바꾸기</button><button class="text-button" data-action="pause-rule">${rule.enabled ? '잠시 쉬기' : '다시 챙기기'}</button></div></article><article class="card learned-rule-card"><span class="learned-label">${icon('calendar')} 일정에서 알아서 챙겨요</span><h2>다가오는 약속을 먼저</h2><p class="rule-quote">“출근 시간대가 지나면 오늘 남은 약속을 보여준다. 저녁에는 내일의 첫 약속을 미리 꺼내둔다.”</p><p class="rule-explanation">이미 지난 약속은 첫 카드에서 내리고, 지금 챙길 일이 없으면 쉬어가는 하루를 안내해요.</p></article></section><aside class="learning-card">${mascot()}<span class="eyebrow">따로 추가하지 않아도 돼요</span><h2>대화가 쌓이면,<br>일상을 이해해요.</h2><ol><li><span>1</span> 자주 찾는 기억을 알아요</li><li><span>2</span> 필요한 요일·시간을 기억해요</li><li><span>3</span> 그 순간에 첫 카드로 꺼내요</li></ol><button class="text-button" data-action="commute-preview">출근길 모습 미리보기 ${icon('arrow')}</button></aside></div><p class="poc-footnote">현재는 반복 습관을 이미 배운 예시 규칙과 대화로 저장한 규칙을 사용해요. 실제 Hermes의 프롬프트·스킬 자동 학습은 연결 전입니다.</p>`;
  }
  function render() {
    document.body.classList.toggle('chat-view', view === 'chat');
    main.innerHTML = ({ today: home, chat: chatPage, calendar, memories, routines }[view])();
    $$('[data-view]').forEach(btn => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    });
    $('.notification-dot').hidden = state.approval !== 'pending';
    document.title = `${{ today: '오늘', chat: '모리와 대화', calendar: '캘린더', memories: '내 기록', routines: '자동으로 챙기는 일' }[view]} · mori`;
  }
  function navigate(next) {
    if (!['today', 'chat', 'calendar', 'memories', 'routines'].includes(next)) next = 'today';
    if (next !== 'chat') recording = false;
    view = next;
    if (location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
    render();
    if (next === 'chat') scrollChat();
    window.scrollTo({ top: 0, behavior: 'instant' });
    main.focus({ preventScroll: true });
  }
  function openModal(content, eyebrow = '모리가 도와드릴게요') {
    if (!modal.open) modalReturnFocus = document.activeElement;
    $('#modal-eyebrow').textContent = eyebrow;
    $('#modal-body').innerHTML = content;
    if (!modal.open) modal.showModal();
    document.body.classList.add('modal-open');
  }
  function closeModal() { if (modal.open) modal.close(); }
  modal.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
    else if (view !== 'chat') $('.desktop-nav .active')?.focus();
  });
  modal.addEventListener('click', event => { if (event.target === modal) { const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(); } });
  const field = (label, name, value = '', type = 'text', attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
  const modalTitle = (title, description = '') => `<h2 id="modal-title">${title}</h2>${description ? `<p class="modal-description">${description}</p>` : ''}`;
  const submitButton = label => `<button class="button primary full" type="submit">${icon('check')} ${label}</button>`;

  function parkingForm() {
    openModal(`${modalTitle('어디에 주차하셨나요?', '층과 구역만 알려주세요. 다음에 바로 찾아드릴게요.')}<form id="parking-form">${field('주차 위치', 'location', state.parking?.location || '', 'text', 'required maxlength="80" placeholder="예: 지하 3층 B12" autofocus')}${field('주차장 이름', 'place', state.parking?.place || '', 'text', 'maxlength="80" placeholder="예: 우리 집 주차장 (선택)"')}<div class="inline-tip">${icon('spark')} 저장하면 오늘 화면과 위젯 미리보기가 함께 바뀌어요.</div>${submitButton('이 위치 기억하기')}</form>`, '주차 기억하기');
  }
  function eventForm(event) {
    openModal(`${modalTitle(event ? '일정을 바꿀까요?' : '새로운 약속이 있나요?', '정해진 내용을 알려주시면 모리가 기억할게요.')}<form id="event-form" data-id="${esc(event?.id || '')}">${field('어떤 약속인가요?', 'title', event?.title || '', 'text', 'required maxlength="100" placeholder="예: 민수와 저녁 약속" autofocus')}<div class="field-row">${field('날짜', 'date', event?.date || selectedDate, 'date', 'required')}${field('시간', 'time', event?.time || '18:00', 'time', 'required')}</div>${field('장소', 'place', event?.place || '', 'text', 'maxlength="100" placeholder="예: 강남역 2번 출구 (선택)"')}<div class="inline-tip">${icon('bell')} 이 체험에서는 내 캘린더에만 저장돼요.</div>${submitButton(event ? '변경 내용 저장' : '일정 기억하기')}</form>`, '나의 캘린더');
  }
  function tripPlan(trip) {
    return Array.from({ length: Number(trip.days) }, (_, i) => ({ day: i + 1, title: ['도착, 그리고 천천히 둘러보기', '동네의 풍경을 만나는 날', '아쉬움은 조금 남겨두기', '마음에 든 곳에 다시 가기', '느긋하게 여행 마무리'][i], activities: i === 0 ? ['11:00 · 숙소에 짐 맡기기', `13:00 · ${trip.destination}의 로컬 식당에서 점심`, '15:00 · 가까운 산책길과 카페', '18:00 · 저녁 식사 후 휴식'] : ['09:00 · 여유로운 아침 식사', `11:00 · ${trip.destination}의 관심 장소 둘러보기`, '14:00 · 점심과 자유 시간', '17:00 · 사진 정리하며 하루 마무리'] }));
  }
  function showTrip() {
    const trip = state.trip;
    if (!trip) return;
    openModal(`${modalTitle(`${esc(trip.destination)}, ${trip.days}일을 가볍게.`, `${esc(trip.company || '가족과 함께')} · 느긋하게 걷고 쉬는 예시 계획이에요.`)}<div class="demo-notice">실시간 검색 전 예시입니다. 장소·운영시간·가격은 확인하지 않았어요.</div><div class="trip-days">${tripPlan(trip).map(day => `<section><span class="day-tag">DAY ${day.day}</span><h3>${esc(day.title)}</h3>${day.activities.map(a => `<p>${esc(a)}</p>`).join('')}</section>`).join('')}</div><div class="field-row"><button class="button secondary" data-action="download-trip">${icon('download')} 표 파일 받기</button><button class="button primary" data-action="print-trip">${icon('book')} PDF로 저장</button></div><p class="fine-print">표 파일은 Excel에서 열 수 있는 CSV예요. PDF는 브라우저의 인쇄 기능으로 저장해요.</p><p class="inline-tip print-help" hidden>인쇄 창에서 저장 대상을 PDF로 선택해 주세요. 창이 열리지 않으면 이 페이지를 Chrome 또는 Safari에서 열고 다시 눌러주세요.</p>`, '나의 여행 계획 · 예시');
  }
  function approvalModal() {
    openModal(`${modalTitle('여행 일정도 챙겨둘까요?', '미리 준비한 제주 여행 예시를 내 캘린더에 추가해요.')}<div class="approval-detail"><span class="action-icon lavender">${icon('compass')}</span><div><strong>제주, 느긋하게 보내는 3일</strong><p>${dateLabel(dayOffset(14))}부터 · 일정 3개</p></div></div><ul class="detail-list"><li><span>첫째 날</span><strong>제주 도착 · 바닷가 산책</strong></li><li><span>둘째 날</span><strong>숲길 걷기 · 카페에서 쉬기</strong></li><li><span>셋째 날</span><strong>느긋한 아침 · 돌아오기</strong></li></ul><div class="inline-tip">${icon('shield')} 이 브라우저의 체험 캘린더에만 추가돼요.</div>${state.approval === 'pending' ? `<div class="field-row"><button class="button secondary" data-action="reject-approval">이번에는 괜찮아요</button><button class="button primary" data-action="approve">${icon('check')} 일정에 추가</button></div>` : `<div class="success-note">${icon('check')} ${state.approval === 'approved' ? '캘린더에 추가했어요.' : '추가하지 않고 여행 계획만 보관했어요.'}</div>${state.approval === 'approved' ? '<button class="button primary full" data-action="go-trip-calendar">캘린더에서 보기</button>' : '<button class="button secondary full" data-action="reopen-approval">다시 검토하기</button>'}`}`, '확인이 필요한 일');
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action], [data-view]');
    if (!button) return;
    if (button.dataset.view) { closeModal(); navigate(button.dataset.view); return; }
    const { action, id, value } = button.dataset;
    switch (action) {
      case 'close': closeModal(); break;
      case 'parking': parkingForm(); break;
      case 'parking-detail': openModal(`${modalTitle(esc(state.parking?.location || '기억한 위치가 없어요'), esc(state.parking?.place || ''))}<div class="large-parking">P</div><p class="center-text muted">${esc(savedLabel())}에 남긴 기록이에요.</p><button class="button primary full" data-action="parking">위치 수정하기</button><button class="button ghost full" data-action="clear-parking">이 위치는 이제 필요 없어요</button>`, '기억한 주차 위치'); break;
      case 'clear-parking': state.parking = null; save(); closeModal(); render(); toast('지난 주차 위치를 지웠어요.'); break;
      case 'event': eventForm(); break;
      case 'event-detail': {
        const item = state.events.find(e => e.id === id); if (!item) break;
        openModal(`${modalTitle(esc(item.title))}<ul class="detail-list"><li>${icon('calendar')}<span>${esc(dateLabel(item.date))}</span></li><li>${icon('clock')}<span>${esc(timeLabel(item.time))}</span></li><li>${icon('pin')}<span>${esc(item.place || '장소 미정')}</span></li></ul><button class="button primary full" data-action="edit-event" data-id="${esc(id)}">일정 수정하기</button><button class="button ghost full danger-text" data-action="delete-event" data-id="${esc(id)}">이 일정 삭제하기</button>`, '나의 일정'); break;
      }
      case 'edit-event': eventForm(state.events.find(e => e.id === id)); break;
      case 'delete-event': {
        const item = state.events.find(e => e.id === id); if (!item) break;
        openModal(`${modalTitle('이 일정을 지울까요?', esc(item.title))}<div class="field-row"><button class="button secondary" data-action="event-detail" data-id="${esc(id)}">남겨둘게요</button><button class="button primary" data-action="confirm-delete-event" data-id="${esc(id)}">삭제하기</button></div>`, '일정 삭제'); break;
      }
      case 'confirm-delete-event': state.events = state.events.filter(e => e.id !== id); save(); closeModal(); render(); toast('일정을 삭제했어요.'); break;
      case 'select-date': selectedDate = value; render(); $(`[data-action="select-date"][data-value="${value}"]`)?.focus({ preventScroll: true }); break;
      case 'prev-month': calendarMonth.setMonth(calendarMonth.getMonth() - 1); render(); break;
      case 'next-month': calendarMonth.setMonth(calendarMonth.getMonth() + 1); render(); break;
      case 'calendar-today': selectedDate = dateKey(today); calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1); render(); break;
      case 'voice': voice(); break;
      case 'voice-example': voiceText = value; $('#voice-transcript').value = value; break;
      case 'voice-cancel': recording = false; render(); scrollChat(); break;
      case 'voice-stop': { const text = $('#voice-transcript')?.value.trim(); if (text) { voiceText = text; sendChat(text, 'voice'); } else $('#voice-transcript')?.focus(); break; }
      case 'text-input': startChat(); break;
      case 'chat': startChat(); break;
      case 'chat-suggest': sendChat(value); break;
      case 'parking-chat': startChat(''); break;
      case 'event-chat': startChat('내일 오후 6시에 약속을 등록해 줘'); break;
      case 'clear-attachments': chatDraft = $('#message')?.value || ''; draftFiles = []; render(); scrollChat(); break;
      case 'rule-chat': startChat('평일 아침 8시에 주차 위치를 보여줘'); break;
      case 'pause-rule': state.parkingRule.enabled = !state.parkingRule.enabled; save(); render(); break;
      case 'commute-preview': previewMode = 'rule'; navigate('today'); break;
      case 'artifact-preview': showArtifact(id); break;
      case 'artifact-csv': { const artifact = state.artifacts.find(a => a.id === id); if (artifact) downloadRows(artifact.rows, `mori-${artifact.trip ? 'travel' : 'document'}-example.csv`); break; }
      case 'trip-approval': {
        const artifact = state.artifacts.find(a => a.id === id); if (!artifact?.trip) break;
        openModal(`${modalTitle('이 여행을 캘린더에도 담을까요?', `${esc(artifact.title)} · 오늘부터 2주 뒤에 시작하는 예시입니다.`)}<p class="inline-tip">${artifact.trip.days}개 일정을 이 브라우저의 캘린더에 추가해요.</p><button class="button primary full" data-action="confirm-chat-trip" data-id="${id}">${artifact.added ? '이미 캘린더에 담았어요' : '일정에 담기'}</button>`, '여행 일정 확인'); break;
      }
      case 'confirm-chat-trip': {
        const artifact = state.artifacts.find(a => a.id === id); if (!artifact?.trip || artifact.added) break;
        tripPlan(artifact.trip).forEach(day => state.events.push({ id: uid(), title: `${artifact.trip.destination} · ${day.title}`, date:dayOffset(13 + day.day), time:'10:00', place:artifact.trip.destination, color:'purple' }));
        artifact.added = true; respond(`${artifact.trip.destination} 여행 일정 ${artifact.trip.days}개를 오늘부터 2주 뒤의 캘린더에 담았어요.`); save(); closeModal(); navigate('chat'); scrollChat(); break;
      }
      case 'memory-filter': memoryFilter = value; render(); $(`[data-action="memory-filter"][data-value="${value}"]`)?.focus({ preventScroll: true }); break;
      case 'note-detail': {
        const note = state.notes.find(n => n.id === id); if (!note) break;
        openModal(`${modalTitle(esc(note.title))}<p class="note-content">${esc(note.content)}</p><p class="fine-print">${esc(dateLabel(note.createdAt))} 기록</p><button class="button secondary full" data-action="close">잘 기억하고 있네요</button>`, '내 기록'); break;
      }
      case 'travel': startChat('제주 2박 3일 여행 계획을 짜줘'); break;
      case 'sample-trip': state.trip = { destination: '제주', days: 3, company: '가족과 함께' }; save(); showTrip(); break;
      case 'trip-result': showTrip(); break;
      case 'download-trip': {
        const rows = [['예시 여행 계획', state.trip.destination, '실시간 정보 미확인'], ['일차', '주제', '일정'], ...tripPlan(state.trip).flatMap(d => d.activities.map(a => [String(d.day), d.title, a]))];
        const csv = '\uFEFF' + rows.map(row => row.map(cell => `"${String(cell).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const link = document.createElement('a'); link.href = url; link.download = 'mori-travel-example.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Excel에서 열 수 있는 예시 표를 내려받았어요.'); break;
      }
      case 'print-trip': $('.print-help').hidden = false; window.print(); break;
      case 'approvals': approvalModal(); break;
      case 'approve':
        if (state.approval !== 'pending') break;
        ['제주 도착 · 바닷가 산책', '숲길 걷기 · 카페에서 쉬기', '느긋한 아침 · 돌아오기'].forEach((title, i) => { if (!state.events.some(e => e.id === `approved-trip-${i}`)) state.events.push({ id: `approved-trip-${i}`, title, date: dayOffset(14 + i), time: '10:00', place: '제주 · 예시 일정', color: 'purple' }); });
        state.approval = 'approved'; save(); render(); approvalModal(); toast('여행 일정 3개를 캘린더에 추가했어요.'); break;
      case 'reject-approval': state.approval = 'rejected'; save(); render(); approvalModal(); toast('일정을 추가하지 않고 계획만 보관했어요.'); break;
      case 'reopen-approval': state.approval = 'pending'; save(); render(); approvalModal(); break;
      case 'go-trip-calendar': selectedDate = dayOffset(14); calendarMonth = new Date(fromKey(selectedDate).getFullYear(), fromKey(selectedDate).getMonth(), 1); closeModal(); navigate('calendar'); break;
      case 'settings': openModal(`${modalTitle('나에게 맞는 모리.', '언제든 편하게 바꿀 수 있어요.')}<div class="settings-row"><div><strong>자동 개인화</strong><p>반복하는 일에서 표시할 내용을 배워요.</p></div><button role="switch" class="toggle ${state.personalization ? 'on' : ''}" aria-label="자동 개인화" aria-checked="${state.personalization}" data-action="personalization"><span></span></button></div><div class="inline-tip">${icon('shield')} 체험 데이터는 이 브라우저에만 저장돼요.<br>실제 계정이나 외부 캘린더는 연결하지 않아요.</div><button class="button secondary full" data-action="reset-confirm">체험 데이터를 처음으로 되돌리기</button>`, '내 설정'); break;
      case 'personalization': state.personalization = !state.personalization; save(); button.classList.toggle('on', state.personalization); button.setAttribute('aria-checked', state.personalization); toast(state.personalization ? '자동 개인화를 켰어요. 이 체험에서는 새 자동 학습 없이 설정만 저장해요.' : '자동 개인화를 껐어요. 직접 설정한 반복은 유지해요.'); break;
      case 'reset-confirm': openModal(`${modalTitle('처음 모습으로 돌아갈까요?', '이 브라우저에서 추가한 체험 기록과 일정이 지워지고 예시 데이터로 돌아가요.')}<div class="field-row"><button class="button secondary" data-action="settings">남겨둘게요</button><button class="button primary" data-action="reset">처음으로 되돌리기</button></div>`, '체험 데이터 초기화'); break;
      case 'reset': state = seed(); chatDraft = ''; draftFiles = []; recording = false; previewMode = 'live'; selectedDate = dateKey(today); calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1); save(); closeModal(); navigate('today'); toast('처음의 모리로 돌아왔어요.'); break;
      case 'demo-info': openModal(`${modalTitle('모리의 하루를 미리 만나보세요.', '버튼을 누르고 기록을 남기며 사용 흐름을 살펴보는 UI/UX 체험입니다.')}<ul class="detail-list stacked"><li><strong>직접 해볼 수 있어요</strong><span>주차 위치와 일정 저장, 기록 조회, 승인, 반복 설정</span></li><li><strong>예시로 보여드려요</strong><span>음성 인식, AI 대화, 자동 학습, 여행 검색</span></li><li><strong>모바일 앱에서 만나요</strong><span>실제 홈 화면 위젯, 푸시와 예약 알림</span></li></ul><button class="button primary full" data-action="close">모리 둘러보기</button>`, 'MORI · UI/UX PROTOTYPE'); break;
    }
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!form.id) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    for (const [name, value] of Object.entries(data)) {
      if (typeof value === 'string') data[name] = value.trim();
      const input = form.elements.namedItem(name);
      if (input?.required && !data[name]) { input.setCustomValidity('내용을 입력해 주세요.'); input.reportValidity(); input.addEventListener('input', () => input.setCustomValidity(''), { once: true }); return; }
    }
    switch (form.id) {
      case 'parking-form':
state.parking = { location: data.location, place: data.place || state.parking?.place || '저장한 주차 위치', updatedAt: new Date().toISOString() }; save(); closeModal(); render(); toast(`${data.location}, 기억해 뒀어요.`); break;
      case 'event-form': {
        const item = { id: form.dataset.id || uid(), ...data, color: 'green' };
        const index = state.events.findIndex(e => e.id === item.id);
        if (index >= 0) state.events[index] = item; else state.events.push(item);
        selectedDate = data.date;
        calendarMonth = new Date(fromKey(data.date).getFullYear(), fromKey(data.date).getMonth(), 1);
        save(); closeModal(); render(); toast(index >= 0 ? '변경한 일정으로 기억할게요.' : '새로운 약속을 캘린더에 기억했어요.'); break;
      }
      case 'chat-form': sendChat(data.message); break;

    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'context-preview') { previewMode = event.target.value; $('#context-slot').innerHTML = contextCard(); }
    if (event.target.id === 'chat-files') { chatDraft = $('#message')?.value || ''; draftFiles = [...event.target.files].slice(0, 3).map(file => ({ name:file.name })); render(); if (view === 'chat') scrollChat(); }
  });
  document.addEventListener('input', event => { if (event.target.id === 'message') { chatDraft = event.target.value; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`; } });
  document.addEventListener('keydown', event => { if (event.target.id === 'message' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(event.target.value); } });
  setInterval(() => { if (view === 'today' && previewMode === 'live' && !modal.open) $('#context-slot').innerHTML = contextCard(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && view === 'today' && previewMode === 'live') $('#context-slot').innerHTML = contextCard(); });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  view = ['today', 'chat', 'calendar', 'memories', 'routines'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  render();
  if (view === 'chat') scrollChat();
})();
