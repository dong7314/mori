import { dateKey, minuteOf } from './experience.mjs';

export const EVENT_KINDS = [
  { value: 'green', label: '일 · 업무' },
  { value: 'orange', label: '약속' },
  { value: 'purple', label: '나의 시간' },
];
export const eventKind = event => EVENT_KINDS.find(kind => kind.value === event.color) || EVENT_KINDS[0];
export const dayDate = key => new Date(`${key}T12:00:00`);
export const eventsOn = (events, key) => events.filter(event => event.date === key
  || (event.date === moveDate(key, -1) && minuteOf(event.time) + eventDuration(event) > 1440))
  .sort((a, b) => (a.date === key ? minuteOf(a.time) : 0) - (b.date === key ? minuteOf(b.time) : 0));

// Calendar arithmetic stays in local dates, including month/year and DST boundaries.
export function moveDate(key, amount, unit = 'day') {
  const date = dayDate(key);
  if (unit === 'month') {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + amount);
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  } else date.setDate(date.getDate() + amount * (unit === 'week' ? 7 : 1));
  return dateKey(date);
}

export function calendarDates(key, mode = 'month') {
  const date = dayDate(key), first = new Date(date);
  if (mode === 'month') first.setDate(1);
  const offset = first.getDay();
  const count = mode === 'month'
    ? Math.ceil((offset + new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()) / 7) * 7 : 7;
  first.setDate(first.getDate() - offset);
  return Array.from({ length: count }, (_, i) => moveDate(dateKey(first), i));
}

export function eventDuration(event) {
  return Number.isFinite(Number(event.duration)) && Number(event.duration) > 0 ? Number(event.duration) : 60;
}
export function eventEnd(event) {
  const end = minuteOf(event.time) + eventDuration(event);
  return `${end >= 1440 ? '다음 날 ' : ''}${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
export function eventDaySpan(event, key = event.date) {
  const start = event.date === key ? minuteOf(event.time) : 0;
  const end = minuteOf(event.time) + eventDuration(event) - (event.date === key ? 0 : 1440);
  const format = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return { start, end: Math.min(1440, end), startLabel: format(start), endLabel: format(Math.min(1440, end)),
    continuation: event.date !== key ? '전날부터' : end > 1440 ? '다음 날까지' : '' };
}
export function timelineHours(events, key) {
  const hours = events.map(event => Math.floor(eventDaySpan(event, key).start / 60));
  const first = Math.min(8, ...hours), last = Math.max(20, ...hours);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
export function hasOverlap(events, candidate) {
  const timestamp = event => { const date = dayDate(event.date); const [h, m] = event.time.split(':').map(Number); date.setHours(h, m, 0, 0); return date.getTime(); };
  const start = timestamp(candidate), end = start + eventDuration(candidate) * 60000;
  return events.some(event => event.id !== candidate.id && timestamp(event) < end
    && timestamp(event) + eventDuration(event) * 60000 > start);
}
