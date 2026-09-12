/**
 * Cabecera del panel: quién está dentro, contra qué está hablando la extensión,
 * y la conmutación mock ↔ backend real.
 *
 * El toggle de mock existe para no depender de una recompilación: `VITE_MOCK` es
 * el valor de arranque, pero en el escenario puede hacer falta pasar a P1 en
 * vivo (o volver a los mocks si algo se cae) sin tocar la terminal.
 */

import { useState } from 'react';
import { Radio, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import { apiBaseUrl } from '@/services/apiClient';

export function HeaderBar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="border-b border-ink-600 bg-ink-800">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-slate-50">Cómpralo</span>
          <ModeChip />
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
            <p className="label">Origen de datos</p>
            <p className="truncate text-xs text-slate-300">{apiBaseUrl()}</p>
          </div>

        </div>
      )}
    </header>
  );
}

function ModeChip() {
  return (
    <span
      className={clsx(
        'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        'bg-mint-500/15 text-mint-400',
      )}
      title={`Conectado a ${apiBaseUrl()}`}
    >
      <Radio className="size-3" aria-hidden />
      en vivo
    </span>
  );
}
