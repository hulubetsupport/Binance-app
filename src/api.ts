export interface ApiConfig {
  apiBase: string;
  initData: string;
  adminToken: string;
  adminKey: string;
}

const STORAGE_KEY_API_BASE = 'ethiop2p_api_base';
const STORAGE_KEY_DEV_TG_ID = 'ethiop2p_dev_tg_id';
const STORAGE_KEY_ADMIN_KEY = 'ethiop2p_admin_key';

export function getInitialApiBase(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const paramApi = urlParams.get('api');
  if (paramApi) {
    const clean = paramApi.replace(/\/$/, '');
    localStorage.setItem(STORAGE_KEY_API_BASE, clean);
    return clean;
  }
  const saved = localStorage.getItem(STORAGE_KEY_API_BASE);
  if (saved) return saved;
  return '';
}

export function setStoredApiBase(url: string) {
  const clean = url.trim().replace(/\/$/, '');
  if (clean) {
    localStorage.setItem(STORAGE_KEY_API_BASE, clean);
  } else {
    localStorage.removeItem(STORAGE_KEY_API_BASE);
  }
}

export function getTelegramWebApp(): any {
  return (window as any).Telegram?.WebApp || null;
}

export function getSavedDevTgId(): string {
  return localStorage.getItem(STORAGE_KEY_DEV_TG_ID) || '200002';
}

export function setSavedDevTgId(id: string) {
  localStorage.setItem(STORAGE_KEY_DEV_TG_ID, id);
}

export function getSavedAdminKey(): string {
  return localStorage.getItem(STORAGE_KEY_ADMIN_KEY) || '';
}

export function setSavedAdminKey(key: string) {
  if (key) localStorage.setItem(STORAGE_KEY_ADMIN_KEY, key);
  else localStorage.removeItem(STORAGE_KEY_ADMIN_KEY);
}

export function getHashAdminToken(): string {
  const hash = window.location.hash || '';
  const m = /token=([^&]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function apiFetch<T = any>(
  path: string,
  opts: {
    method?: string;
    body?: any;
    initData?: string;
    adminToken?: string;
    adminKey?: string;
    apiBase?: string;
  } = {}
): Promise<T> {
  const base = (opts.apiBase ?? getInitialApiBase()).replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (opts.initData) headers['X-Telegram-Init-Data'] = opts.initData;
  if (opts.adminToken) headers['X-Admin-Token'] = opts.adminToken;
  if (opts.adminKey) headers['X-Admin-Key'] = opts.adminKey;

  let bodyPayload: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    bodyPayload = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyPayload = JSON.stringify(opts.body);
  }

  const resp = await fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: bodyPayload,
  });

  const text = await resp.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text || `HTTP ${resp.status}` };
  }

  if (!resp.ok) {
    throw new Error(json?.error || `Request failed (${resp.status})`);
  }
  return json as T;
}

export async function fetchPrivateImageBlobUrl(
  fileId: string,
  auth: { initData?: string; adminToken?: string; adminKey?: string; apiBase?: string }
): Promise<string> {
  const base = (auth.apiBase ?? getInitialApiBase()).replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (auth.initData) headers['X-Telegram-Init-Data'] = auth.initData;
  if (auth.adminToken) headers['X-Admin-Token'] = auth.adminToken;
  if (auth.adminKey) headers['X-Admin-Key'] = auth.adminKey;

  const resp = await fetch(`${base}/api/files/${encodeURIComponent(fileId)}`, { headers });
  if (!resp.ok) throw new Error('Unable to load private image');
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
