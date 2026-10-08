export class RequestError extends Error {
  constructor(message: string, public code = 'network_error') { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new RequestError('无法连接本地服务，请检查服务是否仍在运行。'); }
  const result = await response.json();
  if (!response.ok) throw new RequestError(result.error?.message ?? '请求未完成，请重试。', result.error?.code);
  return result as T;
}
