export const defaultGroups = () => [
  { id: 'life', name: '생활', icon: 'leaf' },
  { id: 'travel', name: '여행', icon: 'compass' },
  { id: 'documents', name: '문서', icon: 'book' },
];
export function inferGroup(text) {
  if (/여행|휴가|숙소/.test(text)) return 'travel';
  if (/pdf|excel|엑셀|문서|파일|보고서/i.test(text)) return 'documents';
  return 'life';
}
export function createConversation(id, now = new Date()) {
  const timestamp = now.toISOString();
  return { id, title: '새 대화', groupId: 'life', messages: [], pending: null, draft: '', draftFiles: [], createdAt: timestamp, updatedAt: timestamp };
}
export function updateConversationMetadata(conversation, text, now = new Date()) {
  if (!conversation.messages.some(message => message.role === 'user')) {
    if (!conversation.titleLocked) conversation.title = text.replace(/\s+/g, ' ').trim().slice(0, 40) || '파일에 관한 대화';
    if (!conversation.groupLocked) conversation.groupId = inferGroup(text);
  }
  conversation.updatedAt = now.toISOString();
}
export function sampleConversations(now) {
  const sample = (id, title, groupId, daysAgo, question, answer) => {
    const date = new Date(now); date.setDate(date.getDate() - daysAgo);
    return { ...createConversation(id, date), title, groupId, example: true, messages: [
      { id: `${id}-user`, role: 'user', text: question },
      { id: `${id}-assistant`, role: 'assistant', text: answer },
    ] };
  };
  return [
    sample('example-commute', '출근길, 내 차 위치', 'life', 0, '평일 아침에는 주차 위치를 먼저 보여줘.', '평일 오전 7시부터 9시까지, 마지막 주차 위치를 오늘 화면에 꺼내둘게요.'),
    sample('example-trip', '가족과 떠나는 제주 여행', 'travel', 1, '가족과 제주에 가려고 해. 여유로운 여행이면 좋겠어.', '좋아요. 여행 날짜와 하고 싶은 일을 이 대화에 모아두면, 이어서 계획을 준비할 수 있어요.'),
    sample('example-document', '한 달 생활비 정리', 'documents', 2, '생활비를 엑셀로 정리하고 싶어.', '정리할 내용을 알려주거나 파일을 붙여주세요. 같은 대화에서 문서 작업을 이어갈 수 있어요.'),
  ];
}
// Preserve the previous single conversation, including unfinished questions and file links.
export function migrateConversations(state, now = new Date()) {
  if (Array.isArray(state.conversations) && Array.isArray(state.conversationGroups)) return state;
  const legacyMessages = Array.isArray(state.messages) ? state.messages : [];
  const hasHistory = legacyMessages.some(message => message.role === 'user');
  const conversation = { ...createConversation('legacy-conversation', now), title: '이전에 나눈 이야기', messages: legacyMessages, pending: state.pending || null };
  if (hasHistory) conversation.groupId = inferGroup(legacyMessages.find(message => message.role === 'user').text);
  const conversations = hasHistory ? [conversation] : sampleConversations(now);
  const artifacts = (state.artifacts || []).map(artifact => ({ ...artifact, conversationId: artifact.conversationId || (hasHistory ? conversation.id : null) }));
  const result = { ...state, conversations, conversationGroups: defaultGroups(), activeConversationId: hasHistory ? conversation.id : null, artifacts };
  delete result.messages;
  delete result.pending;
  return result;
}
export function filterConversations(conversations, groupId = 'all', query = '') {
  const needle = query.trim().toLocaleLowerCase();
  return conversations.filter(conversation => {
    if (groupId !== 'all' && conversation.groupId !== groupId) return false;
    const content = [conversation.title, conversation.draft, ...conversation.messages.map(message => `${message.text} ${(message.files || []).map(file => file.name).join(' ')}`)].join(' ').toLocaleLowerCase();
    return !needle || content.includes(needle);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function latestArtifact(artifacts, conversationId) {
  return artifacts.filter(artifact => artifact.conversationId === conversationId).at(-1);
}
