import { parkingWindows, parkingDescription } from './parking-display.mjs';
export const VERSION = 6;
export const uid = () => globalThis.crypto.randomUUID();
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const dateKey = date => { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const BUILTINS = [
  { id: 'parking', title: '주차 기록', subtitle: '내 차가 있는 곳, 잊지 않게', icon: 'car', color: 'green' },
  { id: 'news', title: '뉴스 브리핑', subtitle: '내 관심사만 모아 간결하게', icon: 'news', color: 'blue' },
  { id: 'stock', title: '관심 주가', subtitle: '궁금한 종목을 한눈에', icon: 'chart', color: 'rose' },
  { id: 'note', title: '메모', subtitle: '떠오른 생각을 가볍게', icon: 'note', color: 'amber' },
  { id: 'schedule', title: '스케줄', subtitle: '하루의 약속을 차근차근', icon: 'calendar', color: 'purple' },
  { id: 'reminder', title: '알림', subtitle: '챙겨야 할 순간에 맞춰', icon: 'bell', color: 'orange' },
];
export function seed(real = Date.now()) {
  const start = new Date(real); start.setHours(8, 40, 0, 0); const today = dateKey(start);
  return { version: VERSION, clock: { real, virtual: start.getTime() }, profile: { name: '동엽', commute: '09:00', parkingLead: 30, notify: false, recent: true, reduced: false },
    parking: { floor: '지하 3층', spot: 'B16', at: start.getTime() - 36000000, show: '08:30', enabled: true },
    notes: [{ id: 'note-weekend', title: '주말에 하고 싶은 것', body: '한강 따라 산책하기\n읽다 만 책 마저 읽기\n좋아하는 사람과 느긋한 저녁', at: start.getTime() - 86400000 }, { id: 'note-idea', title: '문득 떠오른 아이디어', body: '작은 부탁을 잊지 않고 챙겨주는 비서.\n내 하루에 자연스럽게 스며들면 좋겠다.', at: start.getTime() - 7200000 }],
    events: [{ id: 'event-design', title: '모리 디자인 미팅', date: today, time: '10:30', place: '온라인 · 화면 흐름 함께 보기', color: 'green' }, { id: 'event-lunch', title: '친구와 점심', date: today, time: '12:30', place: '성수동', color: 'orange' }, { id: 'event-walk', title: '저녁 산책', date: today, time: '19:00', place: '집 앞 공원', color: 'purple' }],
    reminders: [], customs: [{ id: 'custom-evening', title: '퇴근 정리', description: '하루의 생각을 내일의 할 일로', work: '오늘 저장한 메모를 모아서 할 일을 정리하기', time: '19:00', repeat: '평일', icon: 'spark', active: true, version: 1, runs: 0, result: null }],
    news: { topic: 'AI와 테크', time: '09:00', active: true, status: 'ready', at: start.getTime() - 86400000, generation: 0 },
    stock: { symbol: '삼성전자', active: true, time: '09:30', at: start.getTime() - 86400000 },
    conversations: [{ id: 'chat-welcome', title: '아침을 조금 더 가볍게', at: start.getTime() - 86400000, messages: [{ role: 'user', text: '내일 출근할 때 주차 위치 알려줘.' }, { role: 'assistant', text: '출근 시간은 오전 9시로 설정되어 있어요. 오전 8시 30분부터 대시보드에 최신 주차 위치를 보여드릴게요.', ref: 'parking' }] }], documents: [] };
}
export const nowOf = (state, real = Date.now()) => state.clock.virtual + real - state.clock.real;
export function setClock(state, hour, minute = 0, real = Date.now()) { const d = new Date(nowOf(state, real)); d.setHours(hour, minute, 0, 0); state.clock = { real, virtual: d.getTime() }; }
export const minuteOf = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
export function visibleCards(state, now = nowOf(state)) {
  const d = new Date(now), minute = d.getHours() * 60 + d.getMinutes(), cards = [];
  if (parkingWindows(state.parking, state.profile, now).length) cards.push('parking');
  if (state.news.active && minute >= minuteOf(state.news.time) - 30 && minute < minuteOf(state.news.time) + 180) cards.push('news');
  if (state.stock.active && minute >= minuteOf(state.stock.time) && minute < 16 * 60) cards.push('stock');
  if (state.events.some(e => e.date === dateKey(now) && minuteOf(e.time) >= minute - 30 && minuteOf(e.time) <= minute + 150)) cards.push('schedule');
  state.reminders.filter(r => !r.cancelled && r.target > now && r.target - now <= 90 * 60000).forEach(r => cards.unshift(`reminder:${r.id}`));
  state.customs.filter(f => f.active && f.time && (f.repeat !== '평일' || ![0, 6].includes(d.getDay())) && Math.abs(minute - minuteOf(f.time)) < 90).forEach(f => cards.push(`custom:${f.id}`));
  return cards;
}
export function parseTime(text, fallback = '09:00') {
  const m = text.match(/(오전|오후|저녁|아침)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (!m) return fallback;
  let hour = Number(m[2]); if (hour > 23 || Number(m[3] || 0) > 59) return fallback;
  if (['오후', '저녁'].includes(m[1]) && hour < 12) hour += 12;
  if (m[1] === '오전' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(m[3] || 0).padStart(2, '0')}`;
}
export function runCustom(state, id, now = nowOf(state)) {
  const f = state.customs.find(item => item.id === id); if (!f || !f.active) return null;
  const notes = state.notes.filter(n => dateKey(n.at) === dateKey(now));
  f.runs++; f.result = { at: now, version: f.version, items: notes.length ? notes.slice(0, 4).map(n => ({ text: n.title, done: false })) : [{ text: f.work, done: false }] }; return f;
}
// The demo scheduler is local; occurrence keys survive refresh and prevent reruns.
export function tickScheduled(state, now = nowOf(state)) {
  const day = dateKey(now), date = new Date(now), minute = date.getHours() * 60 + date.getMinutes();
  let changed = false;
  const newsKey = `${day}:${state.news.time}`;
  if (state.news.active && minute >= minuteOf(state.news.time) && state.news.occurrence !== newsKey) {
    Object.assign(state.news, { occurrence: newsKey, status: 'loading', readyAt: now + 1700 }); changed = true;
  }
  if (state.news.readyAt && now >= state.news.readyAt) {
    Object.assign(state.news, { status: 'ready', at: now, readyAt: null }); changed = true;
  }
  for (const f of state.customs) {
    if (!f.active || !f.time || minute < minuteOf(f.time) || (f.repeat === '평일' && [0, 6].includes(date.getDay()))) continue;
    const key = `${day}:${f.time}`;
    if (f.occurrence === key || (f.repeat === '한 번' && f.occurrence)) continue;
    runCustom(state, f.id, now); f.occurrence = key; changed = true;
  }
  return changed;
}
export function applyRequest(state, raw, now = nowOf(state)) {
  const text = raw.trim();
  if (!text) return null;
  if (/기능.*(만들|추가|생성)|퇴근 정리.*만들|메모.*모아.*정리/.test(text)) {
    const named = text.match(/제목은\s*["“']?(.+?)["”']?(?:으로|로)\s*해/);
    const title = named?.[1] || (/메모.*모아/.test(text) ? '퇴근 정리' : text.replace(/기능.*$/, '').slice(0, 22).trim() || '나만의 기능');
    const existing = state.customs.find(f => f.title === title);
    if (existing) return { text: `이미 ‘${title}’ 기능이 있어요. 기존 기능에서 내용을 수정하거나 바로 실행할 수 있어요.`, ref: `custom:${existing.id}` };
    const f = { id: uid(), title, description: '내가 부탁한 일을 모리가 기억해요', work: text, time: /\d+\s*시/.test(text) ? parseTime(text) : '', repeat: /평일/.test(text) ? '평일' : /매일/.test(text) ? '매일' : '한 번', active: true, icon: 'spark', version: 1, runs: 0, result: null };
    state.customs.push(f); return { text: `‘${title}’ 기능을 이 기기에 저장했어요.${f.time ? ` ${f.repeat} ${f.time} 실행과 대시보드 표시를 체험할 수 있어요.` : '필요할 때 기능 탭에서 실행할 수 있어요.'}`, ref: `custom:${f.id}` };
  }
  if (/주차/.test(text)) {
    if (/어디|위치.*(알려|찾)|조회/.test(text) && !/지하|B\d/i.test(text)) return { text: state.parking ? `마지막 주차 위치는 ${state.parking.floor} ${state.parking.spot}이에요.` : '아직 주차 기록이 없어요. 어디에 주차하셨나요?', ref: state.parking ? 'parking' : null };
    const floor = text.match(/지하\s*(\d+)\s*층|\bB(\d+)층(?=\s|$)/i); const spot = text.replace(floor?.[0] || '', '').match(/([A-Z]\d{1,3})(?!\d)/i);
    if (!floor && !spot) return { text: '어디에 주차하셨나요? “지하 3층 B16에 주차했어”처럼 알려주세요.', followup: 'parking' };
    const showMinute = Math.max(0, minuteOf(state.profile.commute) - (state.profile.parkingLead ?? 30));
    const scheduled = /출근|평일|매일|\d+\s*시/.test(text);
    state.parking = { floor: floor ? `지하 ${floor[1] || floor[2]}층` : '', spot: spot?.[1]?.toUpperCase() || '', at: now,
      purpose: /출근/.test(text) ? 'commute' : 'external', display_mode: scheduled ? 'scheduled' : 'always',
      display_schedule: scheduled ? { time: parseTime(text, `${String(Math.floor(showMinute / 60)).padStart(2, '0')}:${String(showMinute % 60).padStart(2, '0')}`), timezone: 'Asia/Seoul', days: /매일/.test(text) ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4], duration_minutes: 90 } : null };
    return { text: `${state.parking.floor} ${state.parking.spot}, 잘 기억해 뒀어요. ${scheduled ? parkingDescription(state.parking) + '해요.' : '새 위치를 기억할 때까지 대시보드에 계속 보여드릴게요.'} 기기 알림은 예약하지 않았어요.`, ref: 'parking' };
  }
  if (/알림|타이머/.test(text)) {
    const relative = text.match(/(\d+)\s*분\s*(뒤|후)/); let target;
    if (relative) target = now + Number(relative[1]) * 60000;
    else if (/\d+\s*시/.test(text)) { const d = new Date(now), [h, m] = parseTime(text).split(':').map(Number); d.setHours(h, m, 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); target = d.getTime(); }
    else return { text: '언제 알려드릴까요? “30분 뒤에 알림 줘”라고 말해보세요.', followup: 'reminder' };
    const r = { id: uid(), title: /물/.test(text) ? '물 한 잔 마시기' : /휴식|쉬/.test(text) ? '잠깐 쉬어가기' : '잊지 않고 챙길 시간', target, created: now, cancelled: false };
    state.reminders.push(r); return { text: '알림을 이 기기에 저장했어요. 남은 시간을 상세 화면에서 확인하고 변경할 수 있어요.', ref: `reminder:${r.id}` };
  }
  if (/뉴스/.test(text)) {
    state.news.topic = /경제/.test(text) ? '경제' : /AI|인공지능/.test(text) ? 'AI' : state.news.topic;
    if (/매일|평일|\d+\s*시/.test(text)) { state.news.time = parseTime(text, state.news.time); state.news.active = true; return { text: `${state.news.time}에 ${state.news.topic} 뉴스를 모으도록 설정했어요. 뉴스 상세에서 수집 중·완료·실패 화면을 체험할 수 있어요.`, ref: 'news' }; }
    state.news.status = 'ready'; state.news.at = now; return { text: `${state.news.topic} 브리핑 예시를 준비했어요. 기사 요약과 출처가 어떻게 표시되는지 살펴보세요.`, ref: 'news' };
  }
  if (/주가|주식|코스피|삼성전자/.test(text)) { state.stock.symbol = /코스피/.test(text) ? '코스피' : /애플/.test(text) ? '애플' : '삼성전자'; if (/\d+\s*시/.test(text)) state.stock.time = parseTime(text, state.stock.time); state.stock.at = now; return { text: `${state.stock.symbol}를 관심 주가에 담았어요. 기준 시각과 등락이 표시되는 예시 화면을 준비했어요.`, ref: 'stock' }; }
  if (/일정|미팅|약속|회의|산책/.test(text) && /추가|잡아|등록|내일|오늘/.test(text)) {
    const eventTime = parseTime(text, null);
    if (!eventTime) return { text: '몇 시에 잡아드릴까요? “내일 오후 2시 디자인 미팅 일정 추가해줘”처럼 시간을 함께 알려주세요.' };
    const d = new Date(now); if (/내일/.test(text)) d.setDate(d.getDate() + 1);
    const title = text.replace(/내일|오늘|오전|오후|저녁|아침|\d+시(?:\s*\d+분)?|일정|추가해줘|등록해줘|잡아줘|해줘/g, '').trim() || '새 약속';
    const e = { id: uid(), title, date: dateKey(d), time: eventTime, place: '', color: 'green' }; state.events.push(e);
    return { text: `${e.date.slice(5).replace('-', '월 ')}일 ${e.time}, ‘${e.title}’ 일정을 저장했어요. 스케줄에서도 같은 약속을 확인할 수 있어요.`, ref: `event:${e.id}` };
  }
  if (/메모|기억해|적어/.test(text)) {
    const body = text.replace(/(?:이거\s*)?메모해줘|메모해\s*줘|기억해줘|적어줘|^메모[:：]?/g, '').trim() || '새로운 생각';
    const n = { id: uid(), title: body.split('\n')[0].slice(0, 28), body, at: now }; state.notes.unshift(n);
    return { text: '생각이 사라지기 전에 적어뒀어요. 대시보드의 기록과 정리에서 다시 꺼내볼 수 있어요.', ref: `note:${n.id}` };
  }
  const f = state.customs.find(f => text.includes(f.title));
  if (f) { if (!f.active) return { text: `‘${f.title}’ 기능은 잠시 쉬고 있어요. 상세 화면에서 다시 켤 수 있어요.`, ref: `custom:${f.id}` }; runCustom(state, f.id, now); return { text: `‘${f.title}’ 기능으로 저장된 메모를 정리했어요. 결과에서 할 일을 체크해보세요.`, ref: `custom:${f.id}` }; }
  return { text: /안녕|고마워/.test(text) ? '반가워요. 작은 기억부터 오늘의 약속까지, 함께 챙겨볼까요?' : '어떤 부탁을 할 수 있을지 같이 살펴볼까요? 이 체험에서는 주차 기억하기, 메모, 일정, 알림과 나만의 기능을 직접 만들어볼 수 있어요.' };
}
