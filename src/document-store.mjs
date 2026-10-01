export const DOCUMENT_MAX_BYTES = 10_000_000;
export const formatBytes = bytes => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${(bytes / 1000).toFixed(1)} KB` : `${bytes} B`;
export function documentRecord(id, filename, source, at) {
  if (!/\.(txt|md|csv)$/i.test(filename) || filename.length > 120) throw new Error('파일 이름은 120자 이내의 TXT, MD, CSV여야 해요.');
  const size_bytes = new TextEncoder().encode(source).length;
  if (!source.length || size_bytes > DOCUMENT_MAX_BYTES) throw new Error('내용이 있는 10MB 이하의 텍스트 파일을 선택해 주세요.');
  return { id, title: filename.replace(/\.[^.]+$/, '').slice(0, 80), filename, size_bytes, at, processing: 'stored_original' };
}
let database;
function openDatabase() {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('mori.documents.v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('originals');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => { database = null; reject(new Error('문서 저장소를 열 수 없어요. 다른 모리 탭을 닫고 다시 시도해 주세요.')); };
  });
  return database;
}
export async function storeOriginal(id, source) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('originals', 'readwrite');
    transaction.objectStore('originals').put(source, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
export async function readOriginal(record) {
  if (typeof record.source === 'string') return record.source;
  // Earlier demo files stored the entire generated text in summary.
  if (typeof record.summary === 'string') return record.summary.split('\n\n원문\n').slice(1).join('\n\n원문\n') || record.summary;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('originals').objectStore('originals').get(record.id);
    request.onsuccess = () => typeof request.result === 'string' ? resolve(request.result) : reject(new Error('원문을 찾지 못했어요. 파일을 다시 불러와 주세요.'));
    request.onerror = () => reject(request.error);
  });
}
