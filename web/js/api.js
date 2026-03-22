/**
 * Zabbix JSON-RPC 2.0 client.
 * Token stored in sessionStorage.
 */

const ENDPOINT = 'api/jsonrpc';
let _id = 1;

function token() { return sessionStorage.getItem('zbx_token') || ''; }
export function setToken(t)    { sessionStorage.setItem('zbx_token', t); }
export function clearToken()   { sessionStorage.removeItem('zbx_token'); sessionStorage.removeItem('zbx_user'); }
export function isLoggedIn()   { return !!token(); }
export function setUsername(u) { sessionStorage.setItem('zbx_user', u); }
export function getUsername()  { return sessionStorage.getItem('zbx_user') || ''; }

export class ApiError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export async function call(method, params = {}) {
  const body = {
    jsonrpc: '2.0',
    method,
    params,
    id: _id++,
  };

  const headers = { 'Content-Type': 'application/json' };
  const tok = token();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new ApiError(-1, `HTTP ${res.status}`, '');

  const json = await res.json();
  if (json.error) throw new ApiError(json.error.code, json.error.message, json.error.data);
  return json.result;
}

export async function batch(requests) {
  /** requests: [{method, params}] → results array */
  const headers = { 'Content-Type': 'application/json' };
  const tok = token();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;

  const body = requests.map(r => ({
    jsonrpc: '2.0',
    method: r.method,
    params: r.params || {},
    id: _id++,
  }));

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new ApiError(-1, `HTTP ${res.status}`, '');
  const json = await res.json();

  return json.map(r => {
    if (r.error) throw new ApiError(r.error.code, r.error.message, r.error.data);
    return r.result;
  });
}
