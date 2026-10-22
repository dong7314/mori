import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetLayout, sheetPresentation } from '../src/sheet-layout.mjs';

test('같은 입력 화면은 진입 경로와 상세 참조가 달라도 같은 편집 크기를 사용한다', () => {
  const editor = { surface: 'sheet', size: 'large' };
  assert.deepEqual(sheetLayout({ formId: 'editor' }), editor);
  assert.deepEqual(sheetLayout({ formId: 'editor', ref: 'parking' }), editor);
  assert.deepEqual(sheetLayout({ formId: 'editor', ref: 'note:42', screen: 'library-sheet' }), editor);
  assert.deepEqual(sheetLayout({ formId: 'editor', ref: 'news', screen: 'stock-choice-sheet' }), editor);
});

test('실제 카드 히어로가 있는 화면만 카드 전환 표면을 사용한다', () => {
  assert.deepEqual(sheetLayout({ hasCardHero: true }), { surface: 'card', size: 'page' });
  assert.deepEqual(sheetLayout({ hasCardHero: true, formId: 'editor', screen: 'guide-sheet', ref: 'parking' }), { surface: 'card', size: 'page' });
  assert.equal(sheetLayout({ ref: 'parking' }).surface, 'sheet');
  assert.equal(sheetLayout({ screen: 'card-page' }).surface, 'sheet');
});

test('읽기 상세는 기능 종류나 식별자 형식과 관계없이 같은 페이지 크기를 사용한다', () => {
  for (const ref of ['parking', 'news', 'stock', 'note:42', 'event:3', 'reminder:1', 'custom:9', 'document:7']) {
    assert.deepEqual(sheetLayout({ ref }), { surface: 'sheet', size: 'page' });
  }
});

test('명시한 목록·안내 화면은 상세 참조가 남아 있어도 원래 크기를 유지한다', () => {
  for (const screen of ['guide-sheet', 'library-sheet', 'document-import-sheet', 'plans-sheet']) {
    assert.deepEqual(sheetLayout({ screen, ref: 'note' }), { surface: 'sheet', size: 'large' });
    assert.deepEqual(sheetLayout({ screen }), { surface: 'sheet', size: 'large' });
  }
});

test('명시한 선택 화면은 상세 참조보다 선택 화면 정책을 우선한다', () => {
  for (const screen of ['time-preview-sheet', 'theme-sheet', 'stock-choice-sheet', 'login-sheet', 'conversation-options-sheet', 'date-jump-sheet']) {
    assert.deepEqual(sheetLayout({ screen, ref: 'stock' }), { surface: 'sheet', size: 'compact' });
    assert.deepEqual(sheetLayout({ screen }), { surface: 'sheet', size: 'compact' });
  }
});

test('초기 로딩과 알 수 없는 화면도 일관된 기본 시트 크기를 갖는다', () => {
  assert.deepEqual(sheetLayout(), { surface: 'sheet', size: 'large' });
  assert.deepEqual(sheetLayout({ screen: 'future-screen' }), { surface: 'sheet', size: 'large' });
  assert.deepEqual(sheetLayout({ screen: 'future-screen', ref: 'news' }), { surface: 'sheet', size: 'page' });
});

test('짧은 선택과 대화 이름 설정은 제출 버튼이 있어도 간결한 크기를 사용한다', () => {
  for (const formId of ['theme-form', 'conversation-form']) {
    assert.deepEqual(sheetLayout({ formId }), { surface: 'sheet', size: 'compact' });
    assert.deepEqual(sheetLayout({ formId, ref: 'news' }), { surface: 'sheet', size: 'compact' });
  }
});

test('기록·설정·편집은 팝업이 아닌 탐색 페이지로 표시한다', () => {
  for (const screen of ['guide-sheet', 'library-sheet', 'document-import-sheet', 'plans-sheet', 'theme-sheet', 'login-sheet']) {
    assert.equal(sheetPresentation({ screen }), 'page');
  }
  for (const formId of ['note-form', 'parking-form', 'event-form', 'theme-form', 'custom-form']) {
    assert.equal(sheetPresentation({ formId }), 'page');
  }
});

test('짧은 선택만 독립 시트를 사용하고 페이지 내부에서는 탐색 흐름을 유지한다', () => {
  for (const screen of ['time-preview-sheet', 'date-jump-sheet', 'stock-choice-sheet']) {
    assert.equal(sheetPresentation({ screen }), 'sheet');
    assert.equal(sheetPresentation({ screen, parent: 'page' }), 'page');
  }
  assert.equal(sheetPresentation({ hasCardHero: true, parent: 'page' }), 'card');
});
