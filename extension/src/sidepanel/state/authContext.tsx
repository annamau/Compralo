/**
 * Sesión del panel.
 *
 * Dos comportamientos que el scope de P2 marca como no negociables:
 *
 *  - Un **401 nunca falla en silencio**: `apiClient` limpia el token y avisa por
 *    `onAuthExpired`; aquí se vuelve a la pantalla de login con un motivo
 *    escrito, no con un panel en blanco.
 *  - Un token guardado se **valida** contra `GET /auth/me` al abrir el panel.
 *    Sin eso, un token caducado no se descubre hasta el primer 401 en medio de
 *    un flujo, que es el peor momento posible.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  currentSession,
  isUnauthorized,
  login,
  logout,
  me,
  onAuthExpired,
} from '@/services/apiClient';
import type { StoredSession } from '@/services/storage';

interface AuthContextValue {
  session: StoredSession | null;
  /** Se está validando un token ya guardado contra `/auth/me`. */
  validating: boolean;
  /** Login en vuelo. */
  busy: boolean;
  /** Fallo del último intento de login. */
  error: string | null;
  /** Motivo por el que se volvió al login (sesión caducada, por ejemplo). */
  notice: string | null;
  signIn: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // `initApiClient()` ya corrió en `main.tsx`, así que el estado inicial es
  // síncrono: el panel no parpadea del login a la sesión.
  const [session, setSession] = useState<StoredSession | null>(() => currentSession());
  const [validating, setValidating] = useState<boolean>(() => currentSession() !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () =>
      onAuthExpired(() => {
        setSession(null);
        setValidating(false);
        setNotice('Tu sesión ha caducado. Vuelve a entrar para seguir.');
      }),
    [],
  );

  useEffect(() => {
    if (!currentSession()) return;
    let cancelled = false;

    me()
      .then(() => {
        if (!cancelled) setValidating(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setValidating(false);
        // Un 401 ya lo gestionó `apiClient` por el canal de `onAuthExpired`.
        // Cualquier otro fallo (backend caído, CORS) no invalida el token: se
        // mantiene la sesión y es la vista quien avisa de la conectividad.
        if (!isUnauthorized(cause)) {
          console.warn('[compralo] no se pudo validar la sesión guardada', cause);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await login(email);
      setSession(next);
      setValidating(false);
    } catch (cause: unknown) {
      const message =
        cause instanceof ApiError && cause.status === 0
          ? 'No hay conexión con el backend. Comprueba que está en pie o activa el modo mock.'
          : cause instanceof Error
            ? cause.message
            : 'No se pudo iniciar sesión.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setSession(null);
    setNotice(null);
    setError(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ session, validating, busy, error, notice, signIn, signOut }),
    [session, validating, busy, error, notice, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth se usó fuera de <AuthProvider>');
  return value;
}
