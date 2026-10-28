import { dateKey } from './experience.mjs';
import { normalizeCustomIcon } from './custom-icons.mjs';

// Keep one timeline across record types without mutating the stored collections.
export function recordsOf(state, filter = 'all') {
  return [
    ...state.notes.map(n => ({ ...n, kind: 'note', label: '메모', icon: 'note', color: 'amber', excerpt: n.body })),
    ...state.documents.map(d => ({ id: d.id, title: d.title, at: d.at, filename: d.filename, size_bytes: d.size_bytes, kind: 'document', label: '문서', icon: 'file', color: 'blue', excerpt: d.filename })),
    ...state.customs.filter(f => f.result).map(f => ({ id: f.id, title: f.title, at: f.result.at, kind: 'custom', label: '실행 결과', icon: normalizeCustomIcon(f.icon), color: 'purple', excerpt: `할 일 ${f.result.items.length}개 · ${f.result.items.filter(i => i.done).length}개 완료` })),
  ].filter(r => filter === 'all' || r.kind === filter).sort((a, b) => b.at - a.at);
}

export function conversationGroups(conversations, query = '', now = Date.now()) {
  const term = query.trim().toLocaleLowerCase();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map(['고정한 대화', '오늘', '어제', '이전 대화'].map(label => [label, []]));
  conversations.filter(c => !term || [c.title, ...c.messages.map(m => m.text)].some(text => text.toLocaleLowerCase().includes(term)))
    .slice().sort((a, b) => b.at - a.at).forEach(c => {
      const day = dateKey(c.at);
      const group = c.pinned ? '고정한 대화' : day === dateKey(now) ? '오늘' : day === dateKey(yesterday) ? '어제' : '이전 대화';
      groups.get(group).push(c);
    });
  return [...groups].filter(([, items]) => items.length);
}

// Validate the schedule the form actually shows; never turn a manual request
// into a daily automation (or discard a chosen recurrence) during saving.
export function normalizeCustomSchedule(values = {}) {
  const time = typeof values.time === 'string' ? values.time.trim() : values.time == null ? '' : String(values.time);
  const repeat = typeof values.repeat === 'string' ? values.repeat.trim() : values.repeat == null ? '필요할 때' : String(values.repeat);
  const invalid = (message, field) => { throw Object.assign(new Error(message), { field }); };
  if (!['필요할 때', '매일', '평일', '한 번'].includes(repeat)) invalid('반복 방식을 다시 선택해 주세요.', 'repeat');
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid('실행 시간을 확인해 주세요.', 'time');
  if (!time && repeat !== '필요할 때') invalid('예약 실행할 시간을 선택해 주세요.', 'time');
  if (time && repeat === '필요할 때') invalid('시간에 맞춰 실행할 반복 방식을 선택해 주세요.', 'repeat');
  return { time, repeat };
}

export function customPreview(values) {
  const work = values.work.trim();
  return { title: values.title.trim() || work.slice(0, 24) || '새로운 내 기능',
    description: values.description.trim() || '나에게 맞춰 기억하는 작은 부탁', work,
    time: values.time, repeat: values.repeat,
    icon: normalizeCustomIcon(values.icon) };
}
