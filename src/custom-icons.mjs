// Reuse the app's existing symbol family in the editor, preview and saved cards.
// Keep persisted values stable; labels and grouping are presentation only.
export const CUSTOM_ICON_GROUPS = Object.freeze([
  { id: 'records', label: '기록과 정보', icons: [
    { value: 'note', label: '메모' },
    { value: 'file', label: '문서' },
    { value: 'book', label: '독서' },
    { value: 'news', label: '뉴스' },
    { value: 'chart', label: '주가' },
    { value: 'chat', label: '대화' },
  ] },
  { id: 'routine', label: '일정과 습관', icons: [
    { value: 'calendar', label: '일정' },
    { value: 'clock', label: '시간' },
    { value: 'bell', label: '알림' },
    { value: 'sun', label: '아침' },
    { value: 'moon', label: '저녁' },
    { value: 'spark', label: '반짝임' },
  ] },
  { id: 'daily', label: '생활과 이동', icons: [
    { value: 'home', label: '집' },
    { value: 'leaf', label: '일상' },
    { value: 'heart', label: '건강' },
    { value: 'car', label: '주차' },
    { value: 'pin', label: '장소' },
    { value: 'compass', label: '여행' },
  ] },
].map(group => Object.freeze({ ...group, icons: Object.freeze(group.icons.map(icon => Object.freeze(icon))) })));

export const CUSTOM_ICONS = Object.freeze(CUSTOM_ICON_GROUPS.flatMap(group => group.icons));
export const CUSTOM_ICON_IDS = Object.freeze(CUSTOM_ICONS.map(icon => icon.value));
const allowed = new Set(CUSTOM_ICON_IDS);

export function normalizeCustomIcon(value) {
  return allowed.has(value) ? value : 'spark';
}
