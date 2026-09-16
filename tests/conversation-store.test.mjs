import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversation, migrateConversations, updateConversationMetadata, filterConversations, latestArtifact } from '../src/conversation-store.mjs';
const now = new Date('2026-09-16T08:00:00');
test('기존 대화의 메시지·추가 질문·파일 참조를 그대로 이관하며 중복 이관하지 않는다', () => {
  const state = { parking: { location: 'B12' }, messages: [{ role: 'user', text: '내일 6시에 약속' }, { role: 'assistant', text: '오전인가요?' }], pending: { kind: 'event', hour: 6 }, artifacts: [{ id: 'pdf-1' }] };
  const next = migrateConversations(state, now);
  assert.deepEqual(next.conversations[0].messages, state.messages);
  assert.deepEqual(next.conversations[0].pending, state.pending);
  assert.equal(next.artifacts[0].conversationId, next.conversations[0].id);
  assert.deepEqual(next.parking, state.parking);
  assert.equal(migrateConversations(next, now), next);
  assert.equal(state.messages.length, 2);
});
test('대화별 추가 질문과 초안, 파일 결과가 섞이지 않는다', () => {
  const first = createConversation('a', now), second = createConversation('b', now);
  first.pending = { kind: 'event' }; first.draft = '오후 6시'; first.draftFiles.push({ name: 'a.pdf' });
  assert.equal(second.pending, null); assert.equal(second.draft, ''); assert.deepEqual(second.draftFiles, []);
  assert.equal(latestArtifact([{ id: 'a-file', conversationId: 'a' }], 'b'), undefined);
});
test('첫 메시지로 주제를 묶되 이후 대화나 사용자 분류를 덮어쓰지 않는다', () => {
  const conversation = createConversation('a', now);
  updateConversationMetadata(conversation, '부산 여행 계획', now);
  assert.equal(conversation.groupId, 'travel');
  conversation.messages.push({ role: 'user', text: '부산 여행 계획' });
  conversation.groupId = 'custom'; conversation.title = '가족 휴가';
  updateConversationMetadata(conversation, '이걸 PDF로 만들어줘', now);
  assert.equal(conversation.groupId, 'custom'); assert.equal(conversation.title, '가족 휴가');
});
test('그룹·본문·첨부 이름으로 검색하고 최근 대화부터 정렬한다', () => {
  const a = { ...createConversation('a', now), groupId: 'travel', messages: [{ role: 'user', text: '부산 바다', files: [{ name: 'ticket.pdf' }] }] };
  const b = { ...createConversation('b', new Date('2026-09-17T08:00:00')), groupId: 'life', title: '주차' };
  assert.deepEqual(filterConversations([a,b]).map(c => c.id), ['b','a']);
  assert.deepEqual(filterConversations([a,b], 'travel', 'TICKET.PDF').map(c => c.id), ['a']);
  assert.equal(filterConversations([a,b], 'life', '부산').length, 0);
});
