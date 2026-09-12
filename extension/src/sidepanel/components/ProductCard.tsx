/**
 * La tarjeta enriquecida: lo que sustituye al esqueleto cuando responde
 * `/understand`. La transición es el Beat 2 de la demo — el momento en que el
 * título crudo de la pestaña se convierte en el producto canónico y aparecen
 * controles que nadie programó.
 *
 * Dos cosas que esta tarjeta hace y que son de producto, no de adorno:
 *
 *  - **El total es siempre puesto en casa.** Si hay envío, se desglosa. Un
 *    precio sin envío no es un precio.
 *  - **Por debajo de 0.7 de confianza pregunta en vez de asumir.** Un agente que
 *    pregunta se lee más inteligente que uno que adivina, y es lo honesto: si el
 *    modelo no está seguro de qué producto es, el mandato no debería armarse
 *    sobre esa suposición.
 */

import { BadgeCheck, RefreshCw, ShieldQuestion, Store } from 'lucide-react';
import clsx from 'clsx';
import type { UnderstandResponse } from '@/services/api.types';
import { formatCents } from '../utils/currency';
import type { AnalysisState } from '../state/useProductAnalysis';
import { retailerLabel } from '../state/useProductAnalysis';

/** Umbral por debajo del cual la UI pide confirmación en vez de seguir. */
export const LOW_CONFIDENCE = 0.7;

interface ProductCardProps {
  state: AnalysisState;
  understanding: UnderstandResponse;
  /** El usuario confirmó que el producto identificado es el correcto. */
  confirmed: boolean;
  onConfirm: () => void;
  onRestart: () => void;
}

export function ProductCard({
  state,
  understanding,
  confirmed,
  onConfirm,
  onRestart,
}: ProductCardProps) {
  const { canonical, listing, confidence } = understanding;
  const image = state.hints?.imageUrl ?? null;
  const retailer = retailerLabel(state) ?? listing.retailer;
  const lowConfidence = confidence < LOW_CONFIDENCE;

  const descriptors = [canonical.brand, canonical.generation ?? canonical.model].filter(
    (value): value is string => Boolean(value),
  );

  return (
    <article className="card animate-upgrade-in space-y-2.5">
      <div className="flex gap-2.5">
        {image ? (
          <img
            src={image}
            alt=""
            className="size-16 shrink-0 rounded-lg border border-ink-600 object-contain"
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden';
            }}
          />
        ) : (
          <div className="size-16 shrink-0 rounded-lg border border-ink-600 bg-ink-700" />
        )}

        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="line-clamp-3 text-xs font-semibold leading-snug text-slate-50">
            {canonical.name}
          </h2>

          {descriptors.length > 0 && (
            <p className="truncate text-[11px] text-slate-400">{descriptors.join(' · ')}</p>
          )}

          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Store className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{retailer}</span>
          </div>
        </div>
      </div>

      <PriceBlock listing={listing} />

      {canonical.identifiers?.ean && (
        <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <BadgeCheck className="size-3 shrink-0 text-mint-500" aria-hidden />
          <span className="truncate">
            EAN {canonical.identifiers.ean} — el agente busca por identificador, no por título
          </span>
        </p>
      )}

      <Footer
        confidence={confidence}
        understandMs={state.timings.understand}
        firstPaintMs={state.timings.firstPaint}
      />

      {lowConfidence && !confirmed && (
        <LowConfidencePrompt
          confidence={confidence}
          name={canonical.name}
          onConfirm={onConfirm}
          onRestart={onRestart}
        />
      )}
    </article>
  );
}

function PriceBlock({ listing }: { listing: UnderstandResponse['listing'] }) {
  const hasShipping = listing.shipping_cents > 0;

  return (
    <div className="rounded-lg bg-ink-700/60 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">Aquí, puesto en casa</span>
        <span className="tabular text-base font-semibold text-slate-50">
          {formatCents(listing.total_cents, listing.currency)}
        </span>
      </div>
      {hasShipping && (
        <p className="tabular mt-0.5 text-right text-[10px] text-slate-500">
          {formatCents(listing.price_cents, listing.currency)} +{' '}
          {formatCents(listing.shipping_cents, listing.currency)} de envío
        </p>
      )}
    </div>
  );
}

function Footer({
  confidence,
  understandMs,
  firstPaintMs,
}: {
  confidence: number;
  understandMs?: number;
  firstPaintMs?: number;
}) {
  const percent = Math.round(confidence * 100);

  return (
    <div className="flex items-center justify-between gap-2 border-t border-ink-600 pt-2 text-[10px]">
      <span
        className={clsx(
          'rounded-full px-1.5 py-0.5 font-medium',
          confidence >= LOW_CONFIDENCE ? 'bg-mint-500/15 text-mint-400' : 'bg-amber-500/15 text-amber-300',
        )}
      >
        Confianza {percent}%
      </span>
      <span className="tabular truncate text-slate-500">
        {typeof firstPaintMs === 'number' && `esqueleto ${firstPaintMs} ms`}
        {typeof firstPaintMs === 'number' && typeof understandMs === 'number' && ' · '}
        {typeof understandMs === 'number' && `análisis ${(understandMs / 1000).toFixed(1)} s`}
      </span>
    </div>
  );
}

function LowConfidencePrompt({
  confidence,
  name,
  onConfirm,
  onRestart,
}: {
  confidence: number;
  name: string;
  onConfirm: () => void;
  onRestart: () => void;
}) {
  return (
    <div className="animate-fade-in space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
      <div className="flex gap-2">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        <div className="space-y-1">
          <p className="text-xs font-medium text-amber-100">¿Es este el producto?</p>
          <p className="text-[11px] leading-relaxed text-amber-200/80">
            Solo estoy seguro al {Math.round(confidence * 100)}% de haber identificado «{name}». Antes
            de armar un mandato sobre esto, confírmalo.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1 py-1.5 text-xs" onClick={onConfirm}>
          Sí, es este
        </button>
        <button
          type="button"
          className="btn-ghost flex items-center gap-1.5 px-2 py-1.5 text-xs"
          onClick={onRestart}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Reanalizar
        </button>
      </div>
    </div>
  );
}
