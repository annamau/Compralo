/**
 * Watch list — versión de arranque.
 *
 * En este hito solo lee `GET /instructions` y pinta una línea por orden. Su
 * trabajo hoy es probar el cableado completo (apiClient → mockStore → JSON de
 * la raíz) con datos reales en pantalla, no con una afirmación.
 *
 * Llega a T+3:00: tarjetas por estado, polling cada 5 s, cancelar,
 * `ApprovalCard` para `AWAITING_APPROVAL` y `DecisionAudit` con los motivos
 * literales de rechazo.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { listInstructions } from '@/services/apiClient';
import type { InstructionSummary } from '@/services/api.types';
import { formatCents } from '../utils/currency';
import { daysUntil, formatRelative } from '../utils/dates';

export function WatchListView({ onCount }: { onCount?: (summaries: InstructionSummary[]) => void }) {
  const [instructions, setInstructions] = useState<InstructionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => listInstructions()
      .then((response) => {
        if (cancelled) return;
        setInstructions(response.instructions);
        onCount?.(response.instructions);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'No se pudo cargar la lista.');
      });
    void load();
    // No hay SSE global; el listado se refresca sin inventar last_checked_at.
    const timer = globalThis.setInterval(() => void load(), 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onCount]);

  if (error) {
    return (
      <div className="card flex items-start gap-2 text-xs text-red-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{error}</span>
      </div>
    );
  }

  if (!instructions) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-xs text-slate-400">
          <Loader2 className="size-4 animate-spin" aria-hidden />
        Cargando monitores del servidor…
      </div>
    );
  }

  if (instructions.length === 0) {
    return (
      <div className="card space-y-1 text-center">
          <p className="text-sm text-slate-200">No hay monitores en el servidor</p>
        <p className="text-xs text-slate-400">
          Crea uno desde «Nueva orden» con una URL pública de producto.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {instructions.map((instruction) => (
        <li key={instruction.id} className="card space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium leading-snug text-slate-100">
              {instruction.canonical.name}
            </p>
            <StatusChip status={instruction.status} />
          </div>
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="tabular">Techo {formatCents(instruction.max_total_cents)}</span>
            <span>{daysUntil(instruction.deadline)} d restantes</span>
          </div>
          <p className="text-[11px] text-slate-500">{lastCheckedLabel(instruction.last_checked_at)}</p>
        </li>
      ))}
    </ul>
  );
}

function lastCheckedLabel(lastCheckedAt: string | null): string {
  const relative = formatRelative(lastCheckedAt);
  return relative ? `Comprobado ${relative}` : 'Sin comprobar todavía';
}

/**
 * Colores por estado. Deliberadamente **exhaustivo con fallback**: P1 puede
 * añadir un estado y la lista degrada a una etiqueta neutra en vez de romperse.
 */
const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-ink-600 text-slate-300',
  ARMED: 'bg-mint-500/15 text-mint-400',
  EVALUATING: 'bg-sky-500/15 text-sky-300',
  EXECUTING: 'bg-indigo-500/15 text-indigo-300',
  PURCHASED: 'bg-mint-500/20 text-mint-400',
  AWAITING_APPROVAL: 'bg-amber-500/15 text-amber-300',
  NEEDS_ATTENTION: 'bg-amber-500/15 text-amber-300',
  DECLINED: 'bg-red-500/15 text-red-300',
  FAILED: 'bg-red-500/15 text-red-300',
  EXPIRED: 'bg-ink-600 text-slate-400',
  CANCELLED: 'bg-ink-600 text-slate-400',
};

function StatusChip({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? 'bg-ink-600 text-slate-300';
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${style}`}>
      {status}
    </span>
  );
}
