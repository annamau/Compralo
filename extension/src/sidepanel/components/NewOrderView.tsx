/**
 * Vista A — creación del mandato.
 *
 * Orquesta el esqueleto de 3 fases, el upgrade al producto canónico y la
 * proyección genérica del `constraint_schema`. Lo que falta encima de esto:
 *   T+2:15  `RetailerToggles` con los candidatos de `/discover`
 *   T+2:30  `MandateForm`: techo en céntimos, plazo ≤ 7 días, cantidad, armar
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Compass, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { ConstraintValue, ConstraintValues } from '@/services/api.types';
import { defaultValuesFor, GenericRenderer } from './GenericRenderer';
import { ProductCard } from './ProductCard';
import { ProductSkeleton } from './ProductSkeleton';
import { useProductAnalysis } from '../state/useProductAnalysis';

export function NewOrderView() {
  const analysis = useProductAnalysis();
  const [confirmed, setConfirmed] = useState(false);
  const [constraints, setConstraints] = useState<ConstraintValues>({});

  const schema = analysis.understanding?.constraint_schema ?? [];

  // Los valores de partida son los `default` que mandó P3. Se siembran cuando
  // llega el esquema, no en cada render.
  useEffect(() => {
    if (schema.length > 0) setConstraints(defaultValuesFor(schema));
  }, [schema]);

  const setConstraint = (key: string, value: ConstraintValue) =>
    setConstraints((prev) => ({ ...prev, [key]: value }));

  const restart = () => {
    setConfirmed(false);
    setConstraints({});
    analysis.restart();
  };

  const projectedTypes = useMemo(
    () => [...new Set(schema.map((field) => field.type))],
    [schema],
  );

  // La página no es una ficha de producto. Decir *por qué* en lugar de "no se
  // pudo leer": en la demo es muy probable que alguien abra el panel sobre un
  // listado, y un agente que distingue un buscador de una ficha se lee listo.
  if (analysis.phase === 'unsupported' && analysis.guard?.kind !== 'ok') {
    return (
      <div className="card space-y-2.5">
        <div className="flex gap-2">
          <Compass className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-100">
              {analysis.guard?.kind === 'listing'
                ? 'Esto es un listado, no un producto'
                : 'Aquí no hay nada que leer'}
            </p>
            <p className="text-[11px] leading-relaxed text-slate-400">
              {analysis.guard?.message}
            </p>
          </div>
        </div>
        {analysis.guard?.kind === 'listing' && (
          <button
            type="button"
            className="btn-ghost flex w-full items-center justify-center gap-1.5 text-xs"
            onClick={restart}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Leer esta página igualmente
          </button>
        )}
      </div>
    );
  }

  if (analysis.phase === 'error') {
    return (
      <div className="card space-y-2.5">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-300" aria-hidden />
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-100">No pude leer este producto</p>
            <p className="text-[11px] leading-relaxed text-slate-400">
              {analysis.error ?? 'El análisis falló.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="btn-ghost flex w-full items-center justify-center gap-1.5 text-xs"
          onClick={restart}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Reintentar
        </button>
      </div>
    );
  }

  const ready = analysis.phase === 'ready' && analysis.understanding;

  return (
    <div className="space-y-3">
      {ready && analysis.understanding ? (
        <ProductCard
          state={analysis}
          understanding={analysis.understanding}
          confirmed={confirmed}
          onConfirm={() => setConfirmed(true)}
          onRestart={restart}
        />
      ) : (
        <ProductSkeleton state={analysis} />
      )}

      {ready && (
        <section className="card animate-upgrade-in space-y-2.5">
          <header className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-mint-400">
              <SlidersHorizontal className="size-3.5" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-wide">
                Qué cuenta como este producto
              </span>
            </span>
          </header>

          <GenericRenderer schema={schema} values={constraints} onChange={setConstraint} />

          {/*
            La línea del Beat 2. No es decoración: es la evidencia, en pantalla,
            de que estos controles salieron de un esquema abstracto y no de un
            formulario escrito para esta categoría.
          */}
          <p className="border-t border-ink-600 pt-2 text-[10px] leading-relaxed text-slate-500">
            {schema.length} campos proyectados por <code className="text-slate-400">type</code> (
            {projectedTypes.join(', ')}). Ninguna <code className="text-slate-400">key</code> se
            lee para decidir qué control pintar.
          </p>
        </section>
      )}
    </div>
  );
}
