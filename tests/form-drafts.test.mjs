import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormDrafts } from '../src/form-drafts.mjs';

const form = (id, record = '', title = '', draftKey = '') => ({ id, dataset: { id: record, draftKey }, elements: [
  { name: 'title', type: 'text', value: title },
  { name: 'memo', type: 'textarea', value: '' },
  { name: 'icon', type: 'radio', value: 'note', checked: true },
  { name: 'icon', type: 'radio', value: 'leaf', checked: false },
] });

test('closing and reopening restores unsaved content without changing saved defaults', () => {
  const drafts = createFormDrafts(), editing = form('note-form', 'n1', 'Saved');
  assert.equal(drafts.restore(editing), false);
  editing.elements[0].value = 'Unsent title'; editing.elements[1].value = '한글 본문';
  drafts.capture(editing);
  const reopened = form('note-form', 'n1', 'Saved');
  assert.equal(drafts.restore(reopened), true);
  assert.equal(reopened.elements[0].value, 'Unsent title');
  assert.equal(reopened.elements[1].value, '한글 본문');
  drafts.discard(reopened);
  assert.equal(reopened.elements[0].value, 'Saved');
  assert.equal(reopened.elements[1].value, '');
  drafts.capture(reopened);
  assert.equal(drafts.restore(form('note-form', 'n1', 'Saved')), false);
});

test('event drafts stay with their intended slot and radio choices are restored', () => {
  const drafts = createFormDrafts(), first = form('event-form', '', '', '2026-10-13:14:00');
  drafts.restore(first); first.elements[0].value = '회의';
  first.elements[2].checked = false; first.elements[3].checked = true;
  drafts.capture(first);
  assert.equal(drafts.restore(form('event-form', '', '', '2026-10-14:09:00')), false);
  const reopened = form('event-form', '', '', '2026-10-13:14:00');
  assert.equal(drafts.restore(reopened), true);
  assert.equal(reopened.elements[2].checked, false);
  assert.equal(reopened.elements[3].checked, true);
});

test('successful save clears the draft and an unchanged form creates none', () => {
  const drafts = createFormDrafts(), editing = form('custom-form', 'c1', 'Saved');
  drafts.restore(editing); drafts.capture(editing);
  assert.equal(drafts.restore(form('custom-form', 'c1', 'Saved')), false);
  editing.elements[0].value = 'Updated'; drafts.capture(editing); drafts.commit(editing);
  drafts.capture(editing);
  assert.equal(drafts.restore(form('custom-form', 'c1', 'Updated')), false);
});

test('parking and briefing drafts survive a new page session, save and discard remove them', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const drafts = createFormDrafts({ storage, key: 'mobile' });
  for (const id of ['parking-form', 'news-form']) {
    const editing = form(id, '', '원래 값'); drafts.restore(editing);
    editing.elements[0].value = '작성 중'; drafts.capture(editing);
  }
  const reloaded = createFormDrafts({ storage, key: 'mobile' });
  const parking = form('parking-form', '', '원래 값'), news = form('news-form', '', '원래 값');
  assert.equal(reloaded.restore(parking), true);
  assert.equal(reloaded.restore(news), true);
  assert.equal(parking.elements[0].value, '작성 중');
  reloaded.commit(parking); reloaded.discard(news);
  const next = createFormDrafts({ storage, key: 'mobile' });
  assert.equal(next.restore(form('parking-form')), false);
  assert.equal(next.restore(form('news-form')), false);
  assert.equal(createFormDrafts({ storage, key: 'tablet' }).restore(form('parking-form')), false);
});

test('a full draft store reports failure while retaining the current session draft', () => {
  const drafts = createFormDrafts({ storage: { getItem: () => 'broken JSON', setItem: () => { throw new Error('full'); } } });
  const editing = form('note-form'); drafts.restore(editing); editing.elements[0].value = '보존';
  assert.equal(drafts.capture(editing), false);
  const reopened = form('note-form'); assert.equal(drafts.restore(reopened), true);
  assert.equal(reopened.elements[0].value, '보존');
});

test('deleting a record clears its edit draft without removing another record draft', () => {
  const drafts = createFormDrafts();
  for (const id of ['n1', 'n2']) { const editing = form('note-form', id); drafts.restore(editing); editing.elements[0].value = 'draft'; drafts.capture(editing); }
  drafts.remove('note-form', 'n1');
  assert.equal(drafts.restore(form('note-form', 'n1')), false);
  assert.equal(drafts.restore(form('note-form', 'n2')), true);
});
