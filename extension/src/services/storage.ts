/**
 * Persistencia del panel. Envuelve `chrome.storage.local` con tipos y cae a
 * `localStorage` cuando no hay contexto de extensión — así el panel se puede
 * abrir en una pestaña normal durante `vite dev` sin reventar.
 */

export interface StoredSession {
  token: string;
  user_id: string;
  email: string;
}

const KEY_SESSION = 'compralo.session';
const KEY_MOCK_OVERRIDE = 'compralo.mock';

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && !!chrome.storage?.local;

async function readRaw(key: string): Promise<string | null> {
  if (hasChromeStorage()) {
    const bag = await chrome.storage.local.get(key);
    const value = bag[key];
    return typeof value === 'string' ? value : null;
  }
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

async function writeRaw(key: string, value: string): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* modo privado o storage bloqueado: la sesión dura lo que dure el panel */
  }
}

async function removeRaw(key: string): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(key);
    return;
  }
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ídem */
  }
}

// ─── Sesión ──────────────────────────────────────────────────────────────────

export async function readSession(): Promise<StoredSession | null> {
  const raw = await readRaw(KEY_SESSION);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.token || !parsed.user_id) return null;
    return { token: parsed.token, user_id: parsed.user_id, email: parsed.email ?? '' };
  } catch {
    // Un JSON corrupto es equivalente a no tener sesión: se vuelve a pedir login.
    await removeRaw(KEY_SESSION);
    return null;
  }
}

export async function writeSession(session: StoredSession): Promise<void> {
  await writeRaw(KEY_SESSION, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  await removeRaw(KEY_SESSION);
}

// ─── Override de modo mock ───────────────────────────────────────────────────
//
// `VITE_MOCK` es el valor de compilación. Esto lo sobrescribe en caliente desde
// el panel, para poder pasar a backend real en el escenario sin recompilar.

export async function readMockOverride(): Promise<boolean | null> {
  const raw = await readRaw(KEY_MOCK_OVERRIDE);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

export async function writeMockOverride(value: boolean | null): Promise<void> {
  if (value === null) {
    await removeRaw(KEY_MOCK_OVERRIDE);
    return;
  }
  await writeRaw(KEY_MOCK_OVERRIDE, value ? 'true' : 'false');
}
