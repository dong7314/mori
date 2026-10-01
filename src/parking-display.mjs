const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
export const parkingPurpose = p => p?.purpose === 'external' ? '외부 주차' : '출근용';
export function parkingConfig(p, profile = {}) {
  if (p?.display_mode === 'always' || p?.display_schedule) return p;
  return { ...p, purpose: 'commute', display_mode: 'scheduled', display_schedule: {
    time: p?.show || '08:30', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: [0, 1, 2, 3, 4, 5, 6],
    duration_minutes: Math.max(1, (Number(profile.commute?.slice(0, 2) || 9) * 60 + Number(profile.commute?.slice(3) || 0) + 60) - (Number(p?.show?.slice(0, 2) || 8) * 60 + Number(p?.show?.slice(3) || 30))),
  } };
}
export function parkingOptions(values) {
  const purpose = values.purpose || 'external', display_mode = values.display_mode || 'always';
  if (!['commute', 'external'].includes(purpose) || !['always', 'scheduled'].includes(display_mode)) throw new Error('주차 용도와 표시 방식을 선택해 주세요.');
  if (display_mode === 'always') return { purpose, display_mode, display_schedule: null };
  const s = values.display_schedule || values;
  const days = (s.days || []).map(Number).sort((a, b) => a - b), duration = Number(s.duration_minutes ?? 90);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') || !days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size !== days.length || !Number.isInteger(duration) || duration < 1 || duration > 1440) throw new Error('표시 시각과 요일을 확인해 주세요.');
  const timezone = s.timezone || 'Asia/Seoul';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('시간대를 확인해 주세요.'); }
  return { purpose, display_mode, display_schedule: { time: s.time, timezone, days, duration_minutes: duration } };
}
export function parkingDescription(record, profile) {
  const p = parkingConfig(record, profile);
  if (p.display_mode === 'always') return '항상 표시 · 새 위치를 기억할 때까지';
  const s = p.display_schedule;
  const days = s.days.join() === '0,1,2,3,4' ? '평일' : s.days.length === 7 ? '매일' : s.days.map(d => DAYS[d]).join('·');
  return `${days} ${s.time} · ${s.duration_minutes}분 동안 표시`;
}
const parts = (at, zone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
function wallTime(day, time, zone) {
  const [h, m] = time.split(':').map(Number), target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
  let at = target;
  for (let i = 0; i < 4; i++) { const p = parts(at, zone); at += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute); }
  const p = parts(at, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === target ? at : null;
}
export function parkingWindows(record, profile, from, until = from) {
  if (!record || record.enabled === false) return [];
  const p = parkingConfig(record, profile), saved = record.at ?? Date.parse(record.recorded_at), result = [];
  if (p.display_mode === 'always') return saved <= from ? [{ at: saved, end: null, current: true, key: `parking@${saved}` }] : [];
  const s = p.display_schedule, local = parts(from, s.timezone), day = new Date(Date.UTC(local.year, local.month - 1, local.day - 1));
  for (let i = 0; i < 4; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    if (!s.days.includes((day.getUTCDay() + 6) % 7)) continue;
    const at = wallTime(day, s.time, s.timezone), end = at + s.duration_minutes * 60000;
    if (at === null || end <= saved) continue;
    const current = Math.max(at, saved) <= from && from < end;
    if (current || at >= from && at < until) result.push({ at, end, current, key: `parking@${at}` });
  }
  return result;
}
