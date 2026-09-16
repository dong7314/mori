import { dateKey } from './assistant-model.mjs';

// Local preview data, never a background scheduler or a real Hermes memory store.
export const createConcierge = () => ({
  preferences: { travel: '많이 이동하기보다, 걷고 쉬는 여유로운 여행', reply: '핵심부터 짧고 쉽게', care: '일정에 추가하기 전에는 한 번 확인하기' },
  jobs: [
    { id: 'morning', title: '아침을 가볍게', description: '오늘 일정과 주차 위치를 한 장으로.', icon: 'sun', time: '07:20', days: [1,2,3,4,5], enabled: true, source: '처음 준비한 예시' },
    { id: 'weekly', title: '한 주 돌아보기', description: '지나온 일정과 남긴 기억을 모아봐요.', icon: 'leaf', time: '20:00', days: [0], enabled: false, source: '모리의 추천 예시' },
  ],
  reports: [],
});

export function hydrateConcierge(state) {
  const initial = createConcierge();
  return { ...state, concierge: { ...initial, ...state.concierge, preferences: { ...initial.preferences, ...state.concierge?.preferences } } };
}

export function nextRunAt(job, now = new Date()) {
  if (!job.enabled || !job.days.length) return null;
  const [hour, minute] = job.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const next = new Date(now);
    next.setDate(next.getDate() + offset); next.setHours(hour, minute, 0, 0);
    if (job.days.includes(next.getDay()) && next > now) return next;
  }
  return null;
}

export const scheduleLabel = job => `${job.days.length === 7 ? '매일' : job.days.length === 5 ? '평일' : '매주 ' + job.days.map(day => '일월화수목금토'[day] + '요일').join('·')} ${job.time}`;

export function buildBrief(state, jobId, now = new Date()) {
  const weekly = jobId === 'weekly';
  const start = new Date(now); start.setDate(start.getDate() - 6);
  const events = state.events.filter(event => weekly ? event.date >= dateKey(start) && event.date <= dateKey(now) : event.date === dateKey(now)).sort((a,b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const notes = state.notes.filter(note => !weekly || note.createdAt >= dateKey(start) && note.createdAt <= dateKey(now));
  const items = [
    { label: weekly ? '지난 7일의 일정' : '오늘의 일정', value: events.length ? `${events.length}개의 약속` : '비워둔 시간', detail: events.map(event => `${weekly ? event.date.slice(5) + ' ' : ''}${event.time} ${event.title}`).join('\n') || '등록된 약속이 없어요. 여유롭게 하루를 보내세요.' },
    weekly ? { label: '이번 주 남긴 기억', value: `${notes.length}개의 기록`, detail: notes.slice(0,3).map(note => note.content).join('\n') || '기억하고 싶은 순간을 모리에게 남겨보세요.' } : { label: '마지막 주차 위치', value: state.parking?.location || '아직 남긴 위치가 없어요', detail: state.parking ? `${state.parking.place}\n${new Date(state.parking.updatedAt).toLocaleString('ko-KR')} 기록` : '주차하고 한마디만 알려주세요.' },
    { label: '모리가 기억하는 방식', value: state.concierge.preferences.reply, detail: state.concierge.preferences.care },
  ];
  return { jobId, title: weekly ? '한 주의 기억을 모았어요.' : '오늘 하루, 이 한 장이면 돼요.', createdAt: now.toISOString(), items, preview: true };
}

export function matchConciergeRequest(text) {
  if (/브리핑|하루.*정리|오늘.*한눈/.test(text)) return 'morning';
  if (/한\s*주.*(?:정리|돌아)|주간.*(?:정리|보고)/.test(text)) return 'weekly';
  return null;
}
