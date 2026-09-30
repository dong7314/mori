import { dateKey, minuteOf, nowOf } from './experience.mjs';
import { eventDuration } from './calendar-model.mjs';

export const DASHBOARD_WINDOWS = [
  { hours: 0, label: '지금', description: '지금 필요한 카드만 간결하게' },
  { hours: 3, label: '3시간', description: '곧 다가오는 부탁과 약속' },
  { hours: 5, label: '5시간', description: '다음 일까지 여유 있게 살펴보기' },
  { hours: 24, label: '하루', description: '지금부터 24시간을 한눈에' },
];

const atTime = (day, time) => {
  const date = new Date(day); date.setHours(0, minuteOf(time), 0, 0); return date.getTime();
};
const clock = value => new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

// Forecast stored definitions only. Never advance the clock, run tools or mutate occurrences.
export function dashboardTimeline(state, hours, now = nowOf(state)) {
  if (![3, 5, 24].includes(hours)) return { from: now, until: now, groups: [], count: 0 };
  const until = now + hours * 3600000, entries = [];
  const add = (ref, at, end, details) => {
    if (!Number.isFinite(at) || at >= until || (at < now && end <= now)) return;
    entries.push({ ...details, ref, at, end, current: at <= now, key: `${ref}@${at}` });
  };
  const day = new Date(now); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - 1);
  while (day.getTime() <= until) {
    if (state.parking && state.parking.enabled !== false) {
      const at = atTime(day, state.parking.show), end = atTime(day, state.profile.commute) + 3600000;
      add('parking', at, end, { kind: 'parking', title: '출근길 주차 위치', description: '가장 최근에 기억한 주차 위치를 확인해요.', icon: 'car', color: 'green', action: '카드 표시', detail: '최신 주차 기록 보기' });
    }
    if (state.news.active) {
      const at = atTime(day, state.news.time);
      add('news', at, at + 180 * 60000, { kind: 'news', title: '나만의 뉴스 브리핑', description: state.news.topic, icon: 'news', color: 'blue', action: '수집 시작', detail: '브리핑과 설정 보기' });
    }
    if (state.stock.active) {
      const at = atTime(day, state.stock.time);
      add('stock', at, atTime(day, '16:00'), { kind: 'stock', title: `${state.stock.symbol} 살펴보기`, description: '관심 종목을 확인하는 시간', icon: 'chart', color: 'rose', action: '카드 표시', detail: '관심 종목 보기' });
    }
    for (const f of state.customs) {
      if (!f.active || !f.work || !f.time || (f.repeat === '평일' && [0, 6].includes(day.getDay()))) continue;
      if (f.repeat === '한 번' && f.occurrence) continue;
      const at = atTime(day, f.time);
      // A one-off with no stored date belongs to the next occurrence, not every day.
      if (f.repeat === '한 번' && at < now) continue;
      if (f.repeat === '한 번' && entries.some(item => item.ref === `custom:${f.id}`)) continue;
      add(`custom:${f.id}`, at, at + 90 * 60000, { kind: 'custom', title: f.title, description: f.description || f.work, icon: f.icon || 'spark', color: 'purple', action: '실행 예약', detail: '부탁과 실행 결과 보기' });
    }
    day.setDate(day.getDate() + 1);
  }
  for (const event of state.events) {
    const at = atTime(new Date(`${event.date}T12:00:00`), event.time);
    add(`event:${event.id}`, at, at + eventDuration(event) * 60000, { kind: 'event', title: event.title, description: event.place || '나의 약속', icon: 'calendar', color: 'purple', action: '약속 시작', detail: '약속 자세히 보기' });
  }
  for (const reminder of state.reminders) {
    if (reminder.cancelled || reminder.target < now) continue;
    add(`reminder:${reminder.id}`, reminder.target, reminder.target + 1, { kind: 'reminder', title: reminder.title, description: '잊지 않도록 챙겨드릴게요.', icon: 'bell', color: 'orange', action: '알림 예정', detail: '남은 시간 확인하기' });
  }
  entries.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
  const groups = new Map();
  for (const item of entries) {
    const date = new Date(item.at), block = Math.floor(date.getHours() / 6), key = item.current ? 'current' : `${dateKey(date)}-${block}`;
    if (!groups.has(key)) {
      const start = new Date(date); start.setHours(block * 6, 0, 0, 0);
      const end = new Date(start); end.setHours(end.getHours() + 6);
      const dayLabel = dateKey(date) === dateKey(now) ? '오늘' : '내일';
      groups.set(key, { key, label: item.current ? '지금 확인할 수 있어요' : `${dayLabel} ${['새벽', '아침', '오후', '저녁'][block]}`,
        span: item.current ? '이 시간에 열려 있는 카드' : `${clock(Math.max(now, start.getTime()))} – ${clock(Math.min(until, end.getTime()))}`,
        icon: item.current ? 'spark' : ['moon', 'sun', 'sun', 'moon'][block], items: [] });
    }
    groups.get(key).items.push(item);
  }
  return { from: now, until, groups: [...groups.values()], count: entries.length };
}
