/**
 * Vista A — creación del mandato. Andamio de este hito.
 *
 * Llega a continuación, en este orden:
 *   T+1:00  Esqueleto de 3 fases (`tabs.query` → `executeScript` → captura).
 *   T+1:45  `GenericRenderer` sobre el `constraint_schema` + animación de upgrade.
 *   T+2:15  `RetailerToggles` con los candidatos de `/discover`.
 *   T+2:30  `MandateForm`: techo en céntimos, plazo ≤ 7 días, cantidad, y armar.
 */

import { Sparkles } from 'lucide-react';

export function NewOrderView() {
  return (
    <div className="space-y-3">
      <div className="card space-y-2">
        <div className="flex items-center gap-2 text-mint-400">
          <Sparkles className="size-4" aria-hidden />
          <p className="text-xs font-semibold uppercase tracking-wide">Siguiente hito</p>
        </div>
        <p className="text-xs leading-relaxed text-slate-300">
          El shell, la sesión y el cliente de red están en pie. Lo que entra aquí a T+1:00 es la
          captura de la pestaña y el esqueleto del producto pintado en menos de 200 ms.
        </p>
      </div>

      <p className="px-1 text-[11px] leading-relaxed text-slate-500">
        Los controles de esta pantalla no se escriben a mano: llegan en el{' '}
        <code className="text-slate-400">constraint_schema</code> de P3 y se proyectan por{' '}
        <code className="text-slate-400">type</code>.
      </p>
    </div>
  );
}
