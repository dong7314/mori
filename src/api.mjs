export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export async function api(path, { method = 'GET', data, key } = {}) {
  let response;
  try { response = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(28000) }); }
  catch { throw new ApiError(0, 'NETWORK_ERROR', '연결이 잠시 끊겼어요. 같은 내용으로 다시 시도해 주세요.'); }
  let payload;
  try { payload = await response.json(); } catch { throw new ApiError(response.status, 'INVALID_RESPONSE', '응답을 확인하지 못했어요. 다시 시도해 주세요.'); }
  if (!response.ok) throw new ApiError(response.status, payload.error?.code, payload.error?.message || '잠시 후 다시 시도해 주세요.');
  return payload;
}
