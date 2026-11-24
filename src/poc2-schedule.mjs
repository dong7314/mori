import { DEMO_DATE } from './poc2-model.mjs';

const storageKey = 'mori.poc2.schedule.v1';
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const minutes = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const monthLabel = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', timeZone: 'UTC' });
const dateLabel = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC' });
const hourLabel = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const fieldLimits = { title: 100, place: 120, notes: 1200 };

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return '';
  const day = dayDate(value);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value ? value : '';
}

function dayDate(day) {
  return new Date(`${day}T00:00:00.000Z`);
}

function dayString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function shiftScheduleDay(day, mode, direction) {
  if (direction !== -1 && direction !== 1) return dateValue(day) || DEMO_DATE;
  const current = dayDate(dateValue(day) || DEMO_DATE);
  if (mode !== 'month') return dateValue(dayString(addDays(current, 7 * direction))) || dayString(current);
  const dayOfMonth = current.getUTCDate();
  const next = new Date(current);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + direction);
  const end = new Date(next);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  next.setUTCDate(Math.min(dayOfMonth, end.getUTCDate()));
  return dateValue(dayString(next)) || dayString(current);
}

function demoSchedule(today) {
  const reference = dateValue(today) || DEMO_DATE;
  const demoDay = offset => dateValue(dayString(addDays(dayDate(reference), offset))) || reference;
  return [
    { id: 'calendar-demo-1', title: '점심 약속', date: reference, time: '12:30', place: '연남동', notes: '' },
    { id: 'calendar-demo-2', title: '도서관 책 반납', date: demoDay(2), time: '', place: '동네 도서관', notes: '책 두 권을 가져가요.' },
    { id: 'calendar-demo-3', title: '정비소 방문', date: demoDay(4), time: '10:00', place: '', notes: '정리한 증상 기록을 보여주세요.' },
  ];
}

function validSchedule(events) {
  return Array.isArray(events) && new Set(events.map(event => event?.id)).size === events.length &&
    events.every(event => event && typeof event.id === 'string' && Boolean(event.id) &&
      Boolean(dateValue(event.date)) && typeof event.time === 'string' && (!event.time || minutes.test(event.time)) &&
      typeof event.title === 'string' && Boolean(event.title.trim()) &&
      Object.entries(fieldLimits).every(([field, max]) => typeof event[field] === 'string' && event[field].length <= max));
}

export function loadSchedule(storage, today = DEMO_DATE) {
  try {
    const raw = storage?.getItem(storageKey);
    if (raw === null || raw === undefined) return demoSchedule(today);
    const events = JSON.parse(raw);
    if (validSchedule(events)) return events;
  } catch { /* Unavailable or malformed storage uses the demo calendar. */ }
  return demoSchedule(today);
}

export function saveSchedule(storage, events) {
  if (!validSchedule(events)) return false;
  try {
    if (!storage?.setItem) return false;
    storage.setItem(storageKey, JSON.stringify(events));
    return true;
  } catch { return false; }
}

export function eventFromFields(fields, existing = null) {
  const get = key => {
    const value = typeof fields?.get === 'function' ? fields.get(key) : fields?.[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const title = get('title');
  const date = dateValue(get('date'));
  const time = get('time');
  const place = get('place');
  const notes = get('notes');

  if (!title) return { error: '일정 이름을 입력해 주세요.' };
  if (!date) return { error: '날짜를 다시 선택해 주세요.' };
  if (time && !minutes.test(time)) return { error: '시간을 다시 선택해 주세요.' };
  if (Object.entries({ title, place, notes }).some(([key, value]) => value.length > fieldLimits[key])) {
    return { error: '입력한 내용이 너무 길어요.' };
  }

  const id = existing?.id ?? `event-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  return { id, title, date, time, place, notes };
}


function localDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = part => String(part).padStart(2, '0');
  return {
    date: `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function toolItem(tool, date, title, time, detail) {
  return { type: 'tool', id: tool, tool, date, title, time, detail, place: '', notes: '' };
}

function scheduledTools(tools, day, today) {
  if (!tools || !dateValue(day)) return [];
  const items = [];

  for (const reminder of tools.reminders || []) {
    if (reminder.completedAt) continue;
    const target = localDateTime(reminder.targetAt);
    if (target?.date === day) {
      items.push(toolItem(`reminder:${reminder.id}`, day, reminder.title, target.time, '알림'));
    }
  }

  const weekday = dayDate(day).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  for (const routine of tools.routines || []) {
    if (!routine.enabled || day > routine.endsAt || !minutes.test(routine.time)) continue;
    const repeats = routine.repeat === 'daily' || (routine.repeat === 'weekdays' && !weekend) ||
      (routine.repeat === 'weekends' && weekend);
    if (!repeats || localDateTime(routine.lastCompletedAt)?.date === day) continue;
    const first = Date.parse(routine.createdAt);
    const slot = Date.parse(`${day}T${routine.time}:00`);
    if (!Number.isFinite(first) || !Number.isFinite(slot) || slot < first) continue;
    items.push(toolItem(`routine:${routine.id}`, day, routine.title, routine.time, '반복 루틴'));
  }

  if (day === today && tools.news?.enabled && minutes.test(tools.news.time)) {
    items.push(toolItem('news', day, '뉴스 브리핑', tools.news.time, `${tools.news.topic} · 예시`));
  }
  if (day === today && tools.market?.enabled && minutes.test(tools.market.time)) {
    items.push(toolItem('market', day, '관심 시세', tools.market.time, `${tools.market.symbol} · 예시`));
  }
  return items;
}

export function scheduleItems(events, tasks, day = DEMO_DATE, tools, today = DEMO_DATE) {
  return [
    ...events.filter(event => event.date === day).map(event => ({ ...event, type: 'event' })),
    ...tasks.filter(task => task.due === day).map(task => ({
      type: 'task', id: task.id, date: task.due, title: task.title,
      time: '', place: '', notes: '', status: task.status,
    })),
    ...scheduledTools(tools, day, today),
  ].sort((left, right) => left.time.localeCompare(right.time));
}

function calendarMarkerMap(events, tasks, dates, tools, today) {
  const marked = new Map();
  for (const { date } of events) marked.set(date, (marked.get(date) || 0) | 1);
  for (const { due } of tasks) if (due) marked.set(due, (marked.get(due) || 0) | 2);
  for (const date of dates) {
    const day = dayString(date);
    if (scheduledTools(tools, day, today).length) marked.set(day, (marked.get(day) || 0) | 1);
  }
  return marked;
}

function calendarDates(day, mode) {
  const selected = dayDate(day);
  const anchor = new Date(selected);
  if (mode === 'month') anchor.setUTCDate(1);
  const first = addDays(anchor, -anchor.getUTCDay());
  const end = new Date(anchor);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const count = mode === 'month' ? Math.ceil((anchor.getUTCDay() + end.getUTCDate()) / 7) * 7 : 7;
  return Array.from({ length: count }, (_, offset) => addDays(first, offset));
}

function renderDay(date, selected, markers, mode, today, esc) {
  const value = dayString(date);
  if (!dateValue(value)) return '<span aria-hidden="true"></span>';
  const isToday = value === today;
  const marked = markers.get(value) || 0;
  const outside = mode === 'month' && value.slice(0, 7) !== selected.slice(0, 7);
  const dateInfo = [fullDate.format(date)];
  if (marked & 1) dateInfo.push('일정 있음');
  if (marked & 2) dateInfo.push('맡긴 일 마감 있음');
  return `
    <button class="schedule-day spring-control" type="button" data-action="schedule-day" data-day="${value}"
      data-outside="${outside}" aria-pressed="${value === selected}"${isToday ? ' aria-current="date"' : ''}
      aria-label="${esc(dateInfo.join(', '))}">
      <span class="schedule-number">${date.getUTCDate()}</span>
      <span class="schedule-dots" aria-hidden="true">${marked & 1 ? '<i></i>' : ''}${marked & 2 ? '<i class="schedule-due-dot"></i>' : ''}</span>
    </button>
  `;
}

function eventTime(value) {
  return value ? hourLabel.format(new Date(`2000-01-01T${value}:00Z`)) : '종일';
}

function renderRow(item, { icon, esc }) {
  const task = item.type === 'task';
  const tool = item.type === 'tool';
  const action = task ? 'open-task' : tool ? 'open-tool' : 'open-event';
  const detail = task ? (item.status === 'ready' ? '맡긴 일 · 완료' : '맡긴 일') : tool ? item.detail : item.place;
  return `
    <li class="schedule-list-item">
      <button type="button" class="schedule-event-row spring-control" data-action="${action}" data-id="${esc(item.id)}"${tool ? ` data-tool="${esc(item.tool)}"` : ''}>
        <span class="schedule-row-time">${task ? '마감' : esc(eventTime(item.time))}</span>
        <span class="schedule-row-line"${task ? ' data-due="true"' : ''} aria-hidden="true"></span>
        <span class="schedule-row-copy">
          <strong>${esc(item.title)}</strong>
          ${detail ? `<span>${esc(detail)}</span>` : ''}
        </span>
        <span class="schedule-row-chevron">${icon('chevron')}</span>
      </button>
    </li>
  `;
}

export function renderSchedule({ events, tasks, day, mode = 'week', icon, esc, tools, today = DEMO_DATE }) {
  const reference = dateValue(today) || DEMO_DATE;
  const chosen = dateValue(day) || reference;
  const displayMode = mode === 'month' ? 'month' : 'week';
  const datestamp = dayDate(chosen);
  const dates = calendarDates(chosen, displayMode);
  const markers = calendarMarkerMap(events, tasks, dates, tools, today);
  const items = scheduleItems(events, tasks, chosen, tools, today);
  const stepLabel = displayMode === 'week' ? '주' : '달';

  return `
    <div class="schedule-page" aria-labelledby="schedule-title">
      <header class="schedule-heading">
        <h1 id="schedule-title" tabindex="-1">일정</h1>
        <button class="schedule-new spring-control" type="button" data-action="new-event" aria-label="새 일정">${icon('plus')}</button>
      </header>
      <section class="schedule-calendar" aria-label="달력">
        <div class="schedule-calendar-top">
          <h2>${esc(monthLabel.format(datestamp))}</h2>
          <div class="schedule-calendar-nav">
            <button type="button" class="schedule-today spring-control" data-action="today-schedule">오늘</button>
            <button type="button" class="schedule-step spring-control" aria-label="이전 ${stepLabel}" data-action="schedule-step" data-direction="-1">${icon('chevron')}</button>
            <button type="button" class="schedule-step spring-control" aria-label="다음 ${stepLabel}" data-action="schedule-step" data-direction="1">${icon('chevron')}</button>
          </div>
        </div>
        <div class="schedule-weekdays" aria-hidden="true">
          ${weekdays.map(label => `<span>${label}</span>`).join('')}
        </div>
        <div class="schedule-grid" data-mode="${displayMode}">
          ${dates.map(date => renderDay(date, chosen, markers, displayMode, reference, esc)).join('')}
        </div>
        <div class="schedule-mode" role="group" aria-label="일정 보기">
          <button type="button" class="spring-control" data-action="schedule-mode" data-mode="week" aria-pressed="${displayMode === 'week'}">주간</button>
          <button type="button" class="spring-control" data-action="schedule-mode" data-mode="month" aria-pressed="${displayMode === 'month'}">월간</button>
        </div>
      </section>
      <section class="schedule-agenda" aria-labelledby="schedule-agenda-title">
        <div class="schedule-agenda-heading">
          <h2 id="schedule-agenda-title"><time datetime="${chosen}">${esc(dateLabel.format(datestamp))}</time></h2>
          <span>${items.length ? `${items.length}개` : ''}</span>
        </div>
        ${items.length ? `<ul class="schedule-list">${items.map(item => renderRow(item, { icon, esc })).join('')}</ul>` :
          `<div class="schedule-empty"><span>${icon('calendar')}</span><p>이 날에는 일정이 없어요.</p><button class="spring-control" type="button" data-action="new-event">일정 추가</button></div>`}
      </section>
    </div>
  `;
}

function eventForm(event, selected, { icon, esc }) {
  return `
    <form class="sheet-form calendar-event-form" data-form="calendar-event"${event ? ` data-id="${esc(event.id)}"` : ''}>
      <div class="field-group">
        <label class="field-label" for="calendar-event-title">일정 이름</label>
        <input class="field-input" id="calendar-event-title" name="title" type="text" value="${esc(event?.title || '')}" maxlength="${fieldLimits.title}" placeholder="어떤 일정인가요?" required>
      </div>
      <div class="calendar-event-when">
        <div class="field-group">
          <label class="field-label" for="calendar-event-date">날짜</label>
          <input class="field-input" id="calendar-event-date" name="date" type="date" value="${selected}" required>
        </div>
        <div class="field-group">
          <label class="field-label" for="calendar-event-time">시간 <span class="field-optional">선택</span></label>
          <input class="field-input" id="calendar-event-time" name="time" type="time" value="${esc(event?.time || '')}">
        </div>
      </div>
      <div class="field-group">
        <label class="field-label" for="calendar-event-place">장소 <span class="field-optional">선택</span></label>
        <input class="field-input" id="calendar-event-place" name="place" type="text" value="${esc(event?.place || '')}" maxlength="${fieldLimits.place}" placeholder="어디에서 만나나요?">
      </div>
      <div class="field-group">
        <label class="field-label" for="calendar-event-notes">메모 <span class="field-optional">선택</span></label>
        <textarea class="field-input" id="calendar-event-notes" name="notes" rows="2" maxlength="${fieldLimits.notes}" placeholder="기억해 둘 내용">${esc(event?.notes || '')}</textarea>
      </div>
      <div class="sheet-actions">
        <button class="sheet-primary spring-control" type="submit">${icon('check')}<span>저장</span></button>
      </div>
    </form>
  `;
}

export function renderCalendarSheet({ event, day, icon, esc, editing = !event }) {
  const selected = dateValue(event?.date || day) || DEMO_DATE;
  const title = editing ? (event ? '일정 편집' : '새 일정') : event?.title || '일정';
  return `
    <div class="sheet-content calendar-event-sheet">
      <div class="sheet-header">
        <span class="sheet-kicker">일정</span>
        <button class="sheet-close spring-control" type="button" data-action="close-sheet" aria-label="닫기">${icon('close')}</button>
      </div>
      <div class="sheet-intro"><h2 id="sheet-title" tabindex="-1">${esc(title)}</h2></div>
      ${editing || !event ? eventForm(event, selected, { icon, esc }) : `
        <div class="calendar-event-detail">
          <div class="calendar-event-line calendar-event-date-row">
            ${icon('calendar')}
            <div><time datetime="${selected}">${esc(dateLabel.format(dayDate(selected)))}</time><span>${esc(eventTime(event.time))}</span></div>
          </div>
          ${event.place ? `<div class="calendar-event-line">${icon('house')}<p>${esc(event.place)}</p></div>` : ''}
          ${event.notes ? `<div class="calendar-event-line calendar-event-notes">${icon('note')}<p>${esc(event.notes)}</p></div>` : ''}
        </div>
        <div class="sheet-actions calendar-event-actions">
          <button class="sheet-secondary calendar-delete spring-control" type="button" data-action="delete-event" data-id="${esc(event.id)}">일정 삭제</button>
          <button class="sheet-primary spring-control" type="button" data-action="edit-event" data-id="${esc(event.id)}">${icon('compose')}<span>편집</span></button>
        </div>
      `}
    </div>
  `;
}
