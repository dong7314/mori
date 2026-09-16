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
    phase: 'morning',
  });
  let state;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    state = saved && Array.isArray(saved.events) && Array.isArray(saved.routines) && Array.isArray(saved.notes) ? { ...seed(), ...saved } : seed();
  } catch { state = seed(); }
  if (!['morning', 'afternoon', 'evening'].includes(state.phase)) state.phase = 'morning';
  let view = 'today';
  let selectedDate = dateKey(today);
  let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let memoryFilter = 'all';
  let toastTimer;
  let asyncTimer;
  let modalReturnFocus;
  let conversation = [];
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
  const phaseInfo = () => ({ morning: ['좋은 아침이에요', '가볍게 시작해요.', '07:30'], afternoon: ['편안한 오후예요', '잠깐, 숨을 골라요.', '14:00'], evening: ['하루도 수고했어요', '편안하게 마무리해요.', '21:00'] }[state.phase]);
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
    return events.length ? events.map(event => `<button class="event-row" data-action="event-detail" data-id="${esc(event.id)}"><span class="event-time">${esc(timeLabel(event.time))}</span><span class="event-bar ${esc(event.color || 'green')}"></span><span class="event-content"><strong>${esc(event.title)}</strong><small>${icon('pin')}${esc(event.place || '장소를 정하지 않았어요')}</small></span>${icon('chevron', 'row-chevron')}</button>`).join('') : `<div class="empty-state compact">${icon('leaf')}<strong>비워둔 시간도 좋아요.</strong><p>새로운 약속이 생기면 모리에게 알려주세요.</p><button class="text-button" data-action="event">일정 추가하기 ${icon('plus')}</button></div>`;
  }
  function widgetMarkup() {
    const phase = state.phase;
    const showParking = phase === 'morning' && state.parking && state.routines.some(r => r.id === 'parking' && r.enabled);
    const event = todayEvents()[phase === 'afternoon' ? 1 : 0];
    return `<div class="widget-surface"><div class="widget-brand"><span class="mini-mark">m</span> mori <span>${icon('spark')}</span></div><small>${showParking ? '출근길, 잊지 않도록' : phase === 'evening' ? '오늘도 수고했어요' : '다가오는 나의 일정'}</small><strong>${showParking ? esc(state.parking.location) : phase === 'evening' ? '내일도 가볍게 만나요' : esc(event?.title || '잠깐 쉬어가도 좋아요')}</strong><p>${showParking ? esc(state.parking.place || '최근 주차 기록') : phase === 'evening' ? '내일의 일정도 모리가 챙길게요' : event ? `${esc(timeLabel(event.time))} · ${esc(event.place)}` : '지금은 예정된 일정이 없어요'}</p><div class="widget-foot">${icon(showParking ? 'car' : 'calendar')}<span>${showParking ? esc(savedLabel()) : '앱에서 자세히 보기'}</span>${icon('arrow')}</div></div>`;
  }
  function home() {
    const events = todayEvents();
    const [greeting, phrase] = phaseInfo();
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('sun')} ${today.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })}</div><h1>오늘도, ${phrase}</h1><p>기억할 일은 모리에게 맡겨두세요.</p></div><div class="phase-control"><span>시간대 미리보기</span><div class="segmented" aria-label="시간대 미리보기">${[['morning', '아침'], ['afternoon', '오후'], ['evening', '저녁']].map(([phase, label]) => `<button data-action="phase" data-value="${phase}" aria-pressed="${state.phase === phase}" class="${state.phase === phase ? 'selected' : ''}">${label}</button>`).join('')}</div></div></section>
      <section class="welcome-card"><div class="welcome-copy"><span class="welcome-label"><span class="live-dot"></span> 나를 위한 작은 비서</span><h2>${greeting}.<br>무엇을 도와드릴까요?</h2><button class="button primary voice-button" data-action="voice">${icon('mic')} 모리에게 말하기 <span class="sound-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span></button><span class="welcome-hint">“오늘 주차한 곳 기억해 줘”</span></div><div class="mascot-scene"><div class="speech-bubble">작은 일도, 기억할게요 ${icon('leaf')}</div>${mascot()}</div></section>
      <section class="quick-actions" aria-label="바로 실행하기">${[
        ['parking', 'car', '주차 기억하기', '내 차 위치 저장', 'blue'],
        ['event', 'calendar', '일정 추가', '약속 바로 저장', 'peach'],
        ['travel', 'compass', '여행 계획', '나만의 여행', 'lavender'],
        ['chat', 'chat', '자유롭게 대화', '편하게 물어봐요', 'sage'],
      ].map(([action, glyph, title, subtitle, color]) => `<button class="quick-action" data-action="${action}"><span class="action-icon ${color}">${icon(glyph)}</span><span><strong>${title}</strong><small>${subtitle}</small></span>${icon('arrow', 'quick-arrow')}</button>`).join('')}</section>
      <div class="dashboard-grid"><div class="main-column"><section><div class="section-heading"><h2>오늘 챙길 일 <span class="count">${events.length}</span></h2><button class="text-button" data-view="calendar">캘린더 보기 ${icon('arrow')}</button></div><article class="card agenda-card">${eventRows(events)}<button class="add-agenda" data-action="event">${icon('plus')} 새로운 일정 추가</button></article></section>
      <section><div class="section-heading"><h2>필요할 때, 꺼내 보세요</h2><span class="section-note">모리가 기억하고 있어요</span></div>${parkingCard()}</section>
      <section class="routine-summary"><span class="routine-summary-icon">${icon('spark')}</span><div><strong>일상을 알아갈수록, 더 자연스럽게</strong><p>${state.routines.filter(r => r.enabled).length}가지 일을 모리가 알아서 챙기고 있어요.</p></div><button class="icon-button" data-view="routines" aria-label="자동으로 챙기는 일 보기">${icon('arrow')}</button></section></div>
      <aside class="side-column"><section><div class="section-heading"><h2>휴대폰에서도, 한눈에</h2><span class="tiny-pill">위젯 미리보기</span></div><div class="widget-preview"><div class="widget-preview-top"><span>${phaseInfo()[2]}</span><span>${icon('sun')} 나의 하루</span></div>${widgetMarkup()}<p class="widget-caption">필요한 순간에, 필요한 기억만.</p><button class="text-button" data-action="widget">위젯 살펴보기 ${icon('arrow')}</button></div></section>
      <section class="card approval-card ${state.approval !== 'pending' ? 'resolved' : ''}"><div class="card-kicker">${icon(state.approval === 'pending' ? 'shield' : 'check')} ${state.approval === 'pending' ? '한 번만 확인해 주세요' : '확인해 주셔서 고마워요'}</div><h3>${state.approval === 'pending' ? '여행 일정, 캘린더에<br>옮겨드릴까요?' : state.approval === 'approved' ? '여행 일정까지 챙겼어요.' : '여행 계획만 보관할게요.'}</h3><p>${state.approval === 'pending' ? '제주 2박 3일 계획을 만들었어요.<br>확인하면 일정 3개를 추가할게요.' : state.approval === 'approved' ? '추가한 일정은 캘린더에서 볼 수 있어요.' : '원할 때 언제든 다시 추가할 수 있어요.'}</p><button class="button ${state.approval === 'pending' ? 'dark' : 'secondary'} full" data-action="approvals">${state.approval === 'pending' ? '내용 확인하기' : '처리 내용 보기'} ${icon('arrow')}</button></section></aside></div>`;
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
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('calendar')} 나의 시간</div><h1>약속은 모리가 기억할게요.</h1><p>오늘부터 다가오는 날까지, 한눈에 살펴보세요.</p></div><button class="button primary" data-action="event">${icon('plus')} 일정 추가</button></section>
      <div class="calendar-layout"><section class="card calendar-card"><div class="month-heading"><h2>${year}년 ${month + 1}월</h2><div><button class="icon-button" data-action="prev-month" aria-label="이전 달">${icon('chevron', 'flipped')}</button><button class="text-button" data-action="calendar-today">오늘</button><button class="icon-button" data-action="next-month" aria-label="다음 달">${icon('chevron')}</button></div></div><div class="calendar-week">${['일', '월', '화', '수', '목', '금', '토'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells}</div><p class="calendar-legend"><i></i> 약속이 있는 날 <span class="today-marker"></span> 오늘</p></section><section><div class="section-heading"><h2>${esc(dateLabel(selectedDate))}</h2></div><article class="card agenda-card">${eventRows(state.events.filter(e => e.date === selectedDate).sort((a, b) => a.time.localeCompare(b.time)))}</article><div class="soft-tip">${icon('mic')}<p>“토요일 6시에 민수랑 저녁 약속”<br><span>말로 알려줘도 일정이 돼요.</span></p><button class="icon-button" data-action="voice" aria-label="음성 입력 체험">${icon('arrow')}</button></div></section></div>`;
  }
  function memories() {
    const showLife = memoryFilter !== 'trip';
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('book')} 나 대신 기억해요</div><h1>작은 기억들이 모이는 곳.</h1><p>말해둔 것, 적어둔 것. 필요할 때 다시 꺼내보세요.</p></div><button class="button primary" data-action="note">${icon('plus')} 기억 남기기</button></section><div class="filter-tabs" aria-label="기록 종류">${[['all', '모든 기록'], ['life', '생활 기록'], ['trip', '여행 계획']].map(([id, label]) => `<button data-action="memory-filter" data-value="${id}" aria-pressed="${memoryFilter === id}" class="${memoryFilter === id ? 'active' : ''}">${label}</button>`).join('')}</div><div class="memory-grid">${showLife ? parkingCard() : ''}${showLife ? state.notes.map(note => `<article class="card note-card"><span class="action-icon peach">${icon('book')}</span><span class="tiny-label">생활 기록</span><h3>${esc(note.title)}</h3><p>${esc(note.content)}</p><div class="card-bottom"><small>${esc(dateLabel(note.createdAt))}</small><button class="text-button" data-action="note-detail" data-id="${esc(note.id)}">기록 보기 ${icon('arrow')}</button></div></article>`).join('') : ''}${memoryFilter !== 'life' ? `<article class="card trip-memory"><div class="trip-landscape" aria-hidden="true"><span class="landscape-sun"></span><span class="mountain one"></span><span class="mountain two"></span><span class="landscape-caption">a little getaway</span></div><div class="trip-memory-body"><span class="tiny-label">${state.trip ? '내가 만든 여행 계획' : '미리 준비한 예시 여행'}</span><h3>${state.trip ? esc(state.trip.destination) + ', ' + state.trip.days + '일의 느긋한 여행' : '제주, 느긋하게 보내는 3일'}</h3><p>바다를 걷고, 맛있는 걸 먹고, 잠깐 쉬어가요.</p><button class="text-button" data-action="${state.trip ? 'trip-result' : 'sample-trip'}">여행 계획 보기 ${icon('arrow')}</button></div></article>` : ''}</div>`;
  }
  function routines() {
    return `<section class="page-intro"><div><div class="date-eyebrow">${icon('spark')} 일상을 조금 더 편하게</div><h1>알아서 챙겨두었어요.</h1><p>자주 하는 일을 기억하고, 필요한 때 먼저 알려드려요.</p></div><span class="status-pill">${state.routines.filter(r => r.enabled).length}개 켜짐</span></section><div class="routine-layout"><section class="routine-list">${state.routines.map(r => `<article class="card routine-card"><div class="action-icon ${r.id === 'parking' ? 'blue' : r.id === 'daily' ? 'peach' : 'lavender'}">${icon(r.icon)}</div><div class="routine-info">${r.learned ? '<span class="learned-label">반복한 일에서 배웠어요</span>' : ''}<h2>${esc(r.title)}</h2><p>${esc(r.description)}</p><button class="routine-time" data-action="routine-time" data-id="${r.id}">${icon('clock')} ${r.id === 'parking' ? '평일' : '매일'} ${timeLabel(r.time)} <span>변경</span></button></div><button class="toggle ${r.enabled ? 'on' : ''}" role="switch" aria-checked="${r.enabled}" aria-label="${esc(r.title)} 자동화" data-action="toggle-routine" data-id="${r.id}"><span></span></button></article>`).join('')}</section><aside class="learning-card">${mascot()}<span class="eyebrow">모리는 이렇게 배워요</span><h2>함께할수록,<br>나에게 맞춰져요.</h2><p>아침마다 주차 위치를 찾으셨네요.<br>이제 찾기 전에 먼저 보여드릴게요.</p><ol><li><span>1</span> 자주 하는 일을 기억해요</li><li><span>2</span> 반복되는 방식을 배워요</li><li><span>3</span> 허용한 범위에서 챙겨요</li></ol><button class="text-button" data-action="settings">개인화 설정 ${icon('arrow')}</button></aside></div><p class="page-disclaimer">이 화면은 반복 패턴을 배운 이후의 모습이에요. 실제 학습과 예약 알림은 연결되어 있지 않아요.</p>`;
  }
  function render() {
    main.innerHTML = ({ today: home, calendar, memories, routines }[view])();
    $$('[data-view]').forEach(btn => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    });
    $('.notification-dot').hidden = state.approval !== 'pending';
    document.title = `${{ today: '오늘', calendar: '캘린더', memories: '내 기록', routines: '자동으로 챙기는 일' }[view]} · mori`;
  }
  function navigate(next) {
    if (!['today', 'calendar', 'memories', 'routines'].includes(next)) next = 'today';
    view = next;
    if (location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
    main.focus({ preventScroll: true });
  }
  function openModal(content, eyebrow = '모리가 도와드릴게요') {
    clearTimeout(asyncTimer);
    if (!modal.open) modalReturnFocus = document.activeElement;
    $('#modal-eyebrow').textContent = eyebrow;
    $('#modal-body').innerHTML = content;
    if (!modal.open) modal.showModal();
    document.body.classList.add('modal-open');
  }
  function closeModal() { clearTimeout(asyncTimer); modal.close(); }
  modal.addEventListener('close', () => {
    clearTimeout(asyncTimer);
    document.body.classList.remove('modal-open');
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
    else $('.desktop-nav .active')?.focus();
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
  function voice(stage = 'idle') {
    const contents = {
      idle: `${modalTitle('편하게 말씀해 주세요.', '짧은 말 한마디도 모리가 기억할게요.')}<div class="voice-demo"><div class="voice-orbit">${icon('mic')}</div><p>“지하 3층 B12에 주차했어”</p><span class="tiny-pill">음성 입력 시뮬레이션</span></div><button class="button primary full" data-action="voice-start">${icon('mic')} 음성 입력 체험하기</button><button class="button ghost full" data-action="text-input">직접 입력할게요</button><p class="fine-print">마이크를 켜거나 녹음하지 않는 화면 체험이에요.</p>`,
      recording: `${modalTitle('듣고 있어요.', '예시 문장으로 음성 입력 흐름을 체험해 보세요.')}<div class="voice-demo recording"><div class="voice-orbit">${icon('mic')}</div><div class="waveform" aria-hidden="true">${Array.from({ length: 19 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div><p>“지하 3층 B12에 주차했어”</p></div><button class="button primary full" data-action="voice-stop">말하기 마치기</button><p class="fine-print">실제 녹음 없이 예시 입력을 보여주고 있어요.</p>`,
      processing: `${modalTitle('말씀을 정리하고 있어요.')}<div class="processing-state"><span class="loader"></span><p>기억할 내용을 찾는 중이에요.</p></div>`,
      result: `${modalTitle('이렇게 기억하면 될까요?', '알아들은 내용은 저장하기 전에 바꿀 수 있어요.')}<div class="transcript">${icon('mic')} 지하 3층 B12에 주차했어</div><form id="voice-save-form">${field('주차 위치', 'location', '지하 3층 B12', 'text', 'required maxlength="80"')}<div class="inline-tip">${icon('car')} 새로운 주차 위치로 기억해 둘게요.</div>${submitButton('기억해 줘')}</form><button class="button ghost full" data-action="voice">다시 말하기</button>`,
    };
    openModal(contents[stage], '모리에게 말하기 · 데모');
  }
  function chatModal() {
    openModal(`${modalTitle('모리와 이야기해요.', '궁금한 것도, 기억할 일도 편하게 남겨주세요.')}<div class="chat-log" role="log" aria-live="polite">${conversation.length ? conversation.map(m => `<div class="chat-message ${m.role}">${m.role === 'assistant' ? '<span class="mini-mark">m</span>' : ''}<p>${esc(m.text)}</p></div>`).join('') : `<div class="chat-message assistant"><span class="mini-mark">m</span><p>안녕하세요! 오늘 일정이나 주차 위치가 궁금한가요?</p></div>`}</div><div class="chat-suggestions"><button data-action="chat-suggest" data-value="내 차 어디에 뒀지?">내 차 어디에 뒀지?</button><button data-action="chat-suggest" data-value="오늘 일정 알려줘">오늘 일정 알려줘</button></div><form id="chat-form" class="chat-input"><input name="message" aria-label="모리에게 보낼 메시지" placeholder="궁금한 내용을 적어주세요" required maxlength="500" autocomplete="off"><button type="submit" class="icon-button send-button" aria-label="메시지 보내기">${icon('arrow')}</button></form><p class="fine-print">저장된 기록을 바탕으로 정해진 예시 응답을 보여줘요. AI 연결 전입니다.</p>`, '자유롭게 대화 · 데모');
    $('.chat-log').scrollTop = $('.chat-log').scrollHeight;
  }
  function sendChat(text) {
    conversation.push({ role: 'user', text });
    let reply;
    if (/주차|내 차|자동차/.test(text)) reply = state.parking ? `마지막으로 ${state.parking.location}에 주차하셨어요. ${state.parking.place || ''} · ${savedLabel()}에 기억해 뒀어요.` : '아직 기억한 주차 위치가 없어요. 오늘 화면의 주차 기억하기에서 알려주세요.';
    else if (/일정|약속/.test(text)) reply = todayEvents().length ? `오늘은 ${todayEvents().length}개의 일정이 있어요. ${todayEvents().map(e => `${timeLabel(e.time)} ${e.title}`).join(', ')}. 여유 있는 하루 보내세요!` : '오늘은 등록된 일정이 없어요. 여유롭게 하루를 보내세요.';
    else reply = '들려주셔서 고마워요. 지금은 화면 체험 중이라 자유로운 AI 답변은 준비 중이에요. 주차 위치나 오늘 일정을 물어보면 저장한 내용을 찾아드릴 수 있어요.';
    conversation.push({ role: 'assistant', text: reply });
    chatModal();
    $('[name="message"]')?.focus();
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
      case 'phase': state.phase = value; save(); render(); $(`[data-action="phase"][data-value="${value}"]`)?.focus({ preventScroll: true }); break;
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
      case 'voice-start': voice('recording'); break;
      case 'voice-stop': voice('processing'); asyncTimer = setTimeout(() => { if (modal.open) voice('result'); }, 900); break;
      case 'text-input': openModal(`${modalTitle('글로 알려주셔도 좋아요.', '주차 위치를 남기거나, 일정 추가 화면으로 이동할 수 있어요.')}<form id="text-parking-form">${field('기억할 주차 위치', 'location', '', 'text', 'required maxlength="80" placeholder="예: 지하 2층 C18" autofocus')}${submitButton('위치 기억하기')}</form><button class="button ghost full" data-action="event">일정을 추가할게요</button>`, '직접 입력하기'); break;
      case 'chat': chatModal(); break;
      case 'chat-suggest': sendChat(value); break;
      case 'memory-filter': memoryFilter = value; render(); $(`[data-action="memory-filter"][data-value="${value}"]`)?.focus({ preventScroll: true }); break;
      case 'note': openModal(`${modalTitle('무엇을 기억해 둘까요?', '좋아하는 것부터 사소한 정보까지 남겨두세요.')}<form id="note-form">${field('제목', 'title', '', 'text', 'required maxlength="100" placeholder="예: 엄마가 좋아하는 커피" autofocus')}<label class="field"><span>기억할 내용</span><textarea name="content" required maxlength="1000" placeholder="잊지 않고 싶은 내용을 적어주세요" rows="4"></textarea></label>${submitButton('기억 남기기')}</form>`, '작은 기억'); break;
      case 'note-detail': {
        const note = state.notes.find(n => n.id === id); if (!note) break;
        openModal(`${modalTitle(esc(note.title))}<p class="note-content">${esc(note.content)}</p><p class="fine-print">${esc(dateLabel(note.createdAt))} 기록</p><button class="button secondary full" data-action="close">잘 기억하고 있네요</button>`, '내 기록'); break;
      }
      case 'toggle-routine': { const routine = state.routines.find(r => r.id === id); routine.enabled = !routine.enabled; save(); render(); $(`[data-action="toggle-routine"][data-id="${id}"]`)?.focus({ preventScroll: true }); toast(routine.enabled ? '이 일을 다시 챙기도록 설정했어요.' : '이 일을 잠시 쉬어갈게요.'); break; }
      case 'routine-time': { const routine = state.routines.find(r => r.id === id); openModal(`${modalTitle('언제 챙겨드릴까요?', esc(routine.title))}<form id="routine-form" data-id="${id}">${field('알려드릴 시간', 'time', routine.time, 'time', 'required')}<p class="fine-print">시간 설정을 저장하는 체험이에요. 실제 알림은 울리지 않아요.</p>${submitButton('이 시간으로 변경')}</form>`, '반복 시간 설정'); break; }
      case 'travel': openModal(`${modalTitle('어디로 떠나볼까요?', '모리가 여유로운 여행의 밑그림을 그려드릴게요.')}<form id="travel-form">${field('여행지', 'destination', state.trip?.destination || '제주', 'text', 'required maxlength="40" autofocus')}<div class="field-row"><label class="field"><span>여행 기간</span><select name="days"><option value="2">1박 2일</option><option value="3" selected>2박 3일</option><option value="4">3박 4일</option><option value="5">4박 5일</option></select></label><label class="field"><span>누구와 함께하나요?</span><select name="company"><option>가족과 함께</option><option>친구와 함께</option><option>둘이서</option><option>나 혼자</option></select></label></div><div class="inline-tip">${icon('compass')} 실제 검색 없이 예시 여행 계획을 만들어요.</div><button class="button primary full" type="submit">${icon('spark')} 여행 계획 체험하기</button></form>`, '여행 계획 · 데모'); break;
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
      case 'widget': openModal(`${modalTitle('앱을 열지 않아도, 한눈에.', '필요한 시간에 필요한 정보가 휴대폰에 보여요.')}<div class="widget-modal-preview">${widgetMarkup()}</div><div class="inline-tip">${icon('phone')} 지금은 화면 미리보기예요. 실제 홈 화면 위젯은 모바일 앱에서 제공할 예정이에요.</div><button class="button primary full" data-action="close">이렇게 보이는군요</button>`, '휴대폰 위젯 · 미리보기'); break;
      case 'settings': openModal(`${modalTitle('나에게 맞는 모리.', '언제든 편하게 바꿀 수 있어요.')}<div class="settings-row"><div><strong>자동 개인화</strong><p>반복하는 일에서 표시할 내용을 배워요.</p></div><button role="switch" class="toggle ${state.personalization ? 'on' : ''}" aria-label="자동 개인화" aria-checked="${state.personalization}" data-action="personalization"><span></span></button></div><div class="inline-tip">${icon('shield')} 체험 데이터는 이 브라우저에만 저장돼요.<br>실제 계정이나 외부 캘린더는 연결하지 않아요.</div><button class="button secondary full" data-action="reset-confirm">체험 데이터를 처음으로 되돌리기</button>`, '내 설정'); break;
      case 'personalization': state.personalization = !state.personalization; save(); button.classList.toggle('on', state.personalization); button.setAttribute('aria-checked', state.personalization); toast(state.personalization ? '자동 개인화를 켰어요. 이 체험에서는 설정만 저장해요.' : '자동 개인화를 껐어요. 직접 설정한 반복은 유지해요.'); break;
      case 'reset-confirm': openModal(`${modalTitle('처음 모습으로 돌아갈까요?', '이 브라우저에서 추가한 체험 기록과 일정이 지워지고 예시 데이터로 돌아가요.')}<div class="field-row"><button class="button secondary" data-action="settings">남겨둘게요</button><button class="button primary" data-action="reset">처음으로 되돌리기</button></div>`, '체험 데이터 초기화'); break;
      case 'reset': state = seed(); conversation = []; selectedDate = dateKey(today); calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1); save(); closeModal(); navigate('today'); toast('처음의 모리로 돌아왔어요.'); break;
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
      case 'voice-save-form':
      case 'text-parking-form': state.parking = { location: data.location, place: data.place || state.parking?.place || '저장한 주차 위치', updatedAt: new Date().toISOString() }; save(); closeModal(); render(); toast(`${data.location}, 기억해 뒀어요.`); break;
      case 'event-form': {
        const item = { id: form.dataset.id || uid(), ...data, color: 'green' };
        const index = state.events.findIndex(e => e.id === item.id);
        if (index >= 0) state.events[index] = item; else state.events.push(item);
        selectedDate = data.date;
        calendarMonth = new Date(fromKey(data.date).getFullYear(), fromKey(data.date).getMonth(), 1);
        save(); closeModal(); render(); toast(index >= 0 ? '변경한 일정으로 기억할게요.' : '새로운 약속을 캘린더에 기억했어요.'); break;
      }
      case 'note-form': state.notes.unshift({ id: uid(), ...data, createdAt: dateKey(today) }); save(); closeModal(); navigate('memories'); toast('작은 기억 하나를 남겼어요.'); break;
      case 'routine-form': state.routines.find(r => r.id === form.dataset.id).time = data.time; save(); closeModal(); render(); toast('반복 시간을 변경했어요.'); break;
      case 'chat-form': sendChat(data.message); break;
      case 'travel-form': {
        openModal(`${modalTitle('느긋한 여행을 그리고 있어요.')}<div class="processing-state"><span class="loader"></span><p>${esc(data.destination)}에서 보내는 ${esc(data.days)}일을 준비 중이에요.</p><small>예시 계획 생성 중 · 실제 검색은 하지 않아요</small></div>`, '여행 계획 · 데모');
        asyncTimer = setTimeout(() => { if (!modal.open) return; state.trip = { ...data, days: Number(data.days) }; save(); render(); showTrip(); }, 1100); break;
      }
    }
  });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  view = ['today', 'calendar', 'memories', 'routines'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  render();
})();
