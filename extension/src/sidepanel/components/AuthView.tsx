/**
 * Puerta de entrada. Un campo, un botón.
 *
 * También es la pantalla a la que se vuelve tras un 401, y en ese caso tiene que
 * decir **por qué** se volvió. Un login que reaparece sin explicación se lee
 * como un fallo de la extensión, no como una sesión caducada.
 */

import { useState, type FormEvent } from 'react';
import { ArrowRight, Lock } from 'lucide-react';
import { useAuth } from '../state/authContext';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEMO_EMAIL = 'demo@compralo.app';

export function AuthView() {
  const { signIn, busy, error, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);

  const valid = EMAIL_PATTERN.test(email.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || busy) return;
    void signIn(email.trim());
  };

  return (
    <div className="flex min-h-full flex-col justify-center gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <div className="flex items-center gap-2 text-mint-400">
          <Lock className="size-4" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-widest">Cómpralo</span>
        </div>
        <h1 className="text-lg font-semibold leading-snug text-slate-50">
          Órdenes límite para productos de todos los días
        </h1>
        <p className="text-xs leading-relaxed text-slate-400">
          Di tu precio, cierra el navegador. El agente vigila y compra una sola vez, dentro de un
          techo que no puede superar.
        </p>
      </header>

      {notice && (
        <p
          role="status"
          className="animate-fade-in rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
        >
          {notice}
        </p>
      )}

      <form onSubmit={submit} className="space-y-2.5" noValidate>
        <div className="space-y-1.5">
          <label htmlFor="email" className="label block">
            Tu email
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            className="input"
            placeholder={DEMO_EMAIL}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !valid}
            aria-describedby={error ? 'auth-error' : undefined}
            disabled={busy}
          />
          {touched && !valid && email.length > 0 && (
            <p className="text-xs text-slate-400">Ese email no tiene buena pinta.</p>
          )}
        </div>

        <button type="submit" className="btn-primary flex items-center justify-center gap-1.5" disabled={busy || !valid}>
          {busy ? 'Entrando…' : 'Entrar'}
          {!busy && <ArrowRight className="size-4" aria-hidden />}
        </button>

        {error && (
          <p
            id="auth-error"
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
          >
            {error}
          </p>
        )}
      </form>

      <button
        type="button"
        className="text-xs text-slate-500 underline decoration-dotted transition hover:text-slate-300"
        onClick={() => setEmail(DEMO_EMAIL)}
        disabled={busy}
      >
        Usar {DEMO_EMAIL}
      </button>
    </div>
  );
}
