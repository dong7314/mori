import test from 'node:test';
import assert from 'node:assert/strict';
import { documentRecord, readOriginal } from '../src/document-store.mjs';
import { recordsOf } from '../src/experience-library.mjs';

test('10 MB uses UTF-8 bytes; record lists never contain the full original', () => {
  const source = '가'.repeat(3333333) + '\n';
  const record = documentRecord('test', '회의.txt', source, 1);
  assert.equal(record.size_bytes, 10000000);
  assert.ok(!('source' in record));
  assert.throws(() => documentRecord('test', '회의.txt', source + 'x', 1));
  assert.throws(() => documentRecord('test', '회의.txt', '', 1));
  const list = recordsOf({ documents: [{ ...record, source }], notes: [], customs: [] });
  assert.ok(!('source' in list[0]));
  assert.ok(JSON.stringify(list).length < 1000);
});
test('existing demo document originals remain readable without resetting records', async () => {
  const source = ' 원문\r\n내용 ';
  assert.equal(await readOriginal({ source }), source);
  assert.equal(await readOriginal({ summary: `정리한 메모\n\n원문\n${source}` }), source);
});
