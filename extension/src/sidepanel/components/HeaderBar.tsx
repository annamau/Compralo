/**
 * Cabecera del panel: quién está dentro, contra qué está hablando la extensión,
 * y la conmutación mock ↔ backend real.
 *
 * El toggle de mock existe para no depender de una recompilación: `VITE_MOCK` es
 * el valor de arranque, pero en el escenario puede hacer falta pasar a P1 en
 * vivo (o volver a los mocks si algo se cae) sin tocar la terminal.
 */

import { useState } from 'react';
import { Database, LogOut, Radio, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import { apiBaseUrl, isMockMode, setMockMode } from '@/services/apiClient';
import { useAuth } from '../state/authContext';

export function HeaderBar() {
  const { session, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [mock, setMock] = useState(() => isMockMode());

  const toggleMock = async () => {
    const next = !mock;
    await setMockMode(next);
    setMock(next);
    // El estado en memoria del mock y la lista cargada dejan de corresponder al
    // conmutar de origen, así que se recarga el panel en vez de mezclar ambos.
    globalThis.location.reload();
  };

  return (
    <header className="border-b border-ink-600 bg-ink-800">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-slate-50">Cómpralo</span>
          <ModeChip mock={mock} />
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label="Ajustes"
          className="rounded-md p-1.5 text-slate-400 transition hover:bg-ink-700 hover:text-slate-200"
        >
          <Settings2 className="size-4" aria-hidden />
        </button>
      </div>

      {open && (
        <div className="animate-fade-in space-y-2.5 border-t border-ink-600 px-3 py-2.5">
          <div className="min-w-0">
            <p className="label">Sesión</p>
            <p className="truncate text-xs text-slate-300">{session?.email || '—'}</p>
          </div>

          <div>
            <p className="label">Origen de datos</p>
            <p className="truncate text-xs text-slate-300">
              {mock ? 'mocks/ y fixtures/ de la raíz' : apiBaseUrl()}
            </p>
          </div>

          <div className="flex gap-2">
            <button type="button" className="btn-ghost flex-1 text-xs" onClick={() => void toggleMock()}>
              {mock ? 'Usar backend real' : 'Volver a mocks'}
            </button>
            <button
              type="button"
              className="btn-ghost flex items-center gap-1.5 text-xs"
              onClick={() => void signOut()}
            >
              <LogOut className="size-3.5" aria-hidden />
              Salir
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

function ModeChip({ mock }: { mock: boolean }) {
  return (
    <span
      className={clsx(
        'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        mock ? 'bg-ink-600 text-slate-300' : 'bg-mint-500/15 text-mint-400',
      )}
      title={mock ? 'Datos servidos desde los mocks de la raíz' : `Conectado a ${apiBaseUrl()}`}
    >
      {mock ? <Database className="size-3" aria-hidden /> : <Radio className="size-3" aria-hidden />}
      {mock ? 'mock' : 'en vivo'}
    </span>
  );
}
