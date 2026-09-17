export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function phaseAt(date = new Date()) { const h = date.getHours(); return h >= 6 && h < 10 ? 'morning' : h >= 10 && h < 18 ? 'day' : 'evening'; }
export const parkingLabel = parking => parking ? [parking.floor, parking.zone, parking.spot].filter(Boolean).join(' · ') : '';
export function normalizeParking(values) {
  const payload = Object.fromEntries(['floor', 'zone', 'spot'].map(key => [key, String(values[key] || '').trim() || null]));
  if (!Object.values(payload).some(Boolean)) throw new Error('층, 구역, 자리 번호 중 하나를 알려주세요.');
  for (const [key, value] of Object.entries(payload)) if (value && (value.length > (key === 'floor' ? 32 : 64) || /[\x00-\x1f\x7f]/.test(value))) throw new Error('위치를 조금 더 짧게 입력해 주세요.');
  return payload;
}
export function parkingAttempt(previous, values, newId = () => crypto.randomUUID()) {
  const payload = normalizeParking(values);
  return previous && JSON.stringify(previous.payload) === JSON.stringify(payload) ? previous : { key: newId(), payload };
}
export function seedPreview(now = new Date()) {
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    version: 3,
    events: [
      { id: 'sample-lunch', title: '엄마와 점심 약속', place: '동네에서 맛있는 한 끼', date: dayKey(now), time: '12:30', sample: true },
      { id: 'sample-walk', title: '하루를 마무리하는 산책', place: '집 앞 공원', date: dayKey(now), time: '19:00', sample: true },
      { id: 'sample-book', title: '읽고 싶던 책 찾아보기', place: '동네 서점', date: dayKey(tomorrow), time: '14:00', sample: true },
    ],
    conversations: [],
    notes: [{ id: 'sample-coffee', title: '엄마가 좋아하는 커피', body: '따뜻한 디카페인 라떼. 시럽은 빼고.', sample: true }],
  };
}
