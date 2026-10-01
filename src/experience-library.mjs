import { dateKey } from './experience.mjs';

// Keep one timeline across record types without mutating the stored collections.
export function recordsOf(state, filter = 'all') {
  return [
    ...state.notes.map(n => ({ ...n, kind: 'note', label: '메모', icon: 'note', color: 'amber', excerpt: n.body })),
    ...state.documents.map(d => ({ id: d.id, title: d.title, at: d.at, filename: d.filename, size_bytes: d.size_bytes, kind: 'document', label: '문서', icon: 'file', color: 'blue', excerpt: d.filename })),
    ...state.customs.filter(f => f.result).map(f => ({ id: f.id, title: f.title, at: f.result.at, kind: 'custom', label: '실행 결과', icon: f.icon || 'spark', color: 'purple', excerpt: `할 일 ${f.result.items.length}개 · ${f.result.items.filter(i => i.done).length}개 완료` })),
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

export function customPreview(values) {
  const work = values.work.trim();
  return { title: values.title.trim() || work.slice(0, 24) || '새로운 내 기능',
    description: values.description.trim() || '나에게 맞춰 기억하는 작은 부탁', work,
    time: values.time, repeat: values.time ? (values.repeat === '필요할 때' ? '매일' : values.repeat) : '필요할 때',
    icon: ['spark', 'note', 'leaf', 'news', 'bell', 'compass'].includes(values.icon) ? values.icon : 'spark' };
}
