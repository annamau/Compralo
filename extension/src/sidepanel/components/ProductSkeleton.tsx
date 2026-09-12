/**
 * El esqueleto. Lo que se ve antes de que responda nada de la red.
 *
 * Va mejorando in situ, sin desmontarse, a medida que llegan datos: primero el
 * título y el favicon de la pestaña (fase 1), después la imagen real del
 * producto y el precio local del DOM (fase 2). Cero spinners sobre vacío — el
 * shimmer solo cubre lo que todavía no se sabe.
 */

import { Loader2, Store } from 'lucide-react';
import clsx from 'clsx';
import type { AnalysisState } from '../state/useProductAnalysis';
import { retailerLabel } from '../state/useProductAnalysis';

export function ProductSkeleton({ state }: { state: AnalysisState }) {
  const title = state.hints?.title ?? state.tab?.title ?? null;
  const image = state.hints?.imageUrl ?? null;
  const favicon = state.tab?.favIconUrl ?? null;
  const price = state.hints?.priceText ?? null;
  const retailer = retailerLabel(state);

  return (
    <article className="card space-y-2.5" aria-busy="true">
      <div className="flex gap-2.5">
        <Thumbnail image={image} favicon={favicon} />

        <div className="min-w-0 flex-1 space-y-1.5">
          {title ? (
            <h2 className="line-clamp-3 text-xs font-medium leading-snug text-slate-100">
              {title}
            </h2>
          ) : (
            <>
              <div className="shimmer h-3 w-full rounded" />
              <div className="shimmer h-3 w-4/5 rounded" />
            </>
          )}

          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            {retailer ? (
              <>
                <Store className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{retailer}</span>
              </>
            ) : (
              <div className="shimmer h-2.5 w-20 rounded" />
            )}
          </div>

          {price ? (
            <p className="tabular text-sm font-semibold text-slate-200">{price}</p>
          ) : (
            <div className="shimmer h-4 w-24 rounded" />
          )}
        </div>
      </div>

      <AnalysisFooter state={state} />
    </article>
  );
}

function Thumbnail({ image, favicon }: { image: string | null; favicon: string | null }) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        className="size-16 shrink-0 animate-fade-in rounded-lg border border-ink-600 object-contain"
        // Una imagen rota de la tienda no debe dejar un icono partido en la
        // tarjeta: se oculta y queda el hueco neutro.
        onError={(event) => {
          event.currentTarget.style.visibility = 'hidden';
        }}
      />
    );
  }

  return (
    <div className="shimmer flex size-16 shrink-0 items-center justify-center rounded-lg">
      {favicon && <img src={favicon} alt="" className="size-5 opacity-70" />}
    </div>
  );
}

/**
 * Dice en qué va el análisis y cuánto ha costado. El tiempo del primer paint no
 * es decoración: es la promesa del producto, y conviene poder señalarla.
 */
function AnalysisFooter({ state }: { state: AnalysisState }) {
  const { timings, phase, capture, simulated } = state;

  const label =
    phase === 'tab'
      ? 'Leyendo la pestaña…'
      : phase === 'hints'
        ? 'Leyendo la ficha de la página…'
        : 'Analizando el producto…';

  return (
    <div className="space-y-1 border-t border-ink-600 pt-2">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5 text-slate-400">
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
          <span className="truncate">{label}</span>
        </span>
        {typeof timings.firstPaint === 'number' && (
          <span
            className={clsx(
              'tabular shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              timings.firstPaint < 200 ? 'bg-mint-500/15 text-mint-400' : 'bg-ink-600 text-slate-300',
            )}
            title="Tiempo hasta el primer contenido en pantalla"
          >
            {timings.firstPaint} ms
          </span>
        )}
      </div>

      {simulated && (
        <p className="text-[10px] leading-relaxed text-amber-300/80">
          Modo navegador: no hay pestaña real que leer ni capturar. Los datos del producto vienen
          del análisis, no de la página.
        </p>
      )}

      {capture && !capture.ok && !simulated && (
        <p className="text-[10px] leading-relaxed text-amber-300/80">
          Sin captura de pantalla: {capture.reason} El análisis sigue con los datos del DOM.
        </p>
      )}
    </div>
  );
}
