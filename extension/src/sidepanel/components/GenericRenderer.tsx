/**
 * El renderizador genérico. La pieza que sostiene el Beat 2 de la demo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA DE FRONTERA: este fichero **nunca** mira `field.key`.
 *
 *  Ni un `if (field.key === 'generation')`, ni un `switch (field.key)`, ni un
 *  mapa de claves a componentes. `key` se usa para **una sola cosa**: como
 *  nombre de propiedad al recolectar el valor. Leer la clave para elegir cómo
 *  pintar es lo que mata la afirmación de que nadie programó el formulario a
 *  mano — y esa afirmación es el beat.
 *
 *  La proyección es estrictamente por `type`:
 *    enum  → pills segmentadas (única, o múltiple si el campo lo pide)
 *    bool  → interruptor
 *    money → importe en céntimos enteros
 *    int   → stepper
 *    date  → selector de fecha
 *
 *  Un `type` desconocido degrada a un aviso legible en vez de romper: P3 puede
 *  añadir un tipo antes que nosotros.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nota sobre qué NO vive aquí: el clamp de 7 días y el techo del mandato. Un
 * `date` del esquema es una restricción de producto cualquiera, y recortarla a
 * 7 días porque *es una fecha* sería colar semántica de negocio en un
 * renderizador que debe ser tonto. Eso vive en el formulario de mandato.
 */

import { useEffect, useState } from 'react';
import { Minus, Plus, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type {
  ConstraintField,
  ConstraintOption,
  ConstraintValue,
  ConstraintValues,
} from '@/services/api.types';
import { centsToInputValue, parseInputToCents } from '../utils/currency';

interface GenericRendererProps {
  schema: ConstraintField[];
  values: ConstraintValues;
  onChange: (key: string, value: ConstraintValue) => void;
}

export function GenericRenderer({ schema, values, onChange }: GenericRendererProps) {
  if (schema.length === 0) {
    return (
      <p className="px-1 text-[11px] text-slate-500">
        El análisis no devolvió restricciones para este producto.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {schema.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <label className="label block" htmlFor={`field-${field.key}`}>
            {field.label}
          </label>
          <Control field={field} value={values[field.key]} onChange={onChange} />
        </div>
      ))}
    </div>
  );
}

/** El único punto de decisión del fichero, y conmuta sobre `type`. */
function Control({
  field,
  value,
  onChange,
}: {
  field: ConstraintField;
  value: ConstraintValue | undefined;
  onChange: (key: string, value: ConstraintValue) => void;
}) {
  const set = (next: ConstraintValue) => onChange(field.key, next);

  switch (field.type) {
    case 'enum':
      return <EnumControl field={field} value={value} onChange={set} />;
    case 'bool':
      return <BoolControl field={field} value={value} onChange={set} />;
    case 'money':
      return <MoneyControl field={field} value={value} onChange={set} />;
    case 'int':
      return <IntControl field={field} value={value} onChange={set} />;
    case 'date':
      return <DateControl field={field} value={value} onChange={set} />;
    default:
      return <UnknownControl type={field.type} />;
  }
}

// ─── Normalización de opciones ───────────────────────────────────────────────
//
// `CONTRACTS.md` no fija la forma de `options`, así que toleramos las dos que
// P3 podría emitir: cadenas sueltas o pares valor/etiqueta.

interface NormalizedOption {
  value: string;
  label: string;
}

function normalizeOptions(options: ConstraintOption[] | undefined): NormalizedOption[] {
  if (!options) return [];
  return options.map((option) =>
    typeof option === 'string'
      ? { value: option, label: humanize(option) }
      : { value: option.value, label: option.label ?? humanize(option.value) },
  );
}

/**
 * `"refurbished"` → `"Refurbished"`, `"same_day"` → `"Same day"`.
 * Es cosmética sobre el **valor**, no interpretación de la clave: no cambia qué
 * control se pinta ni qué se envía, solo cómo se lee la etiqueta cuando P3 no
 * mandó una.
 */
function humanize(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ─── enum ────────────────────────────────────────────────────────────────────

function EnumControl({
  field,
  value,
  onChange,
}: {
  field: ConstraintField;
  value: ConstraintValue | undefined;
  onChange: (value: ConstraintValue) => void;
}) {
  const options = normalizeOptions(field.options);
  if (options.length === 0) return <UnknownControl type="enum sin opciones" />;

  // A3: selección única por defecto y valor escalar. Con `multiple: true` se
  // envía lista, y P1 normaliza el escalar a `[escalar]` antes del `IN` de la
  // compuerta.
  const multiple = field.multiple === true;
  const selected = multiple
    ? new Set(Array.isArray(value) ? value : value == null ? [] : [String(value)])
    : new Set(value == null ? [] : [String(value)]);

  const toggle = (optionValue: string) => {
    if (!multiple) {
      onChange(optionValue);
      return;
    }
    const next = new Set(selected);
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    onChange([...next]);
  };

  return (
    <div className="flex flex-wrap gap-1.5" role={multiple ? 'group' : 'radiogroup'}>
      {options.map((option) => {
        const active = selected.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role={multiple ? 'checkbox' : 'radio'}
            aria-checked={active}
            onClick={() => toggle(option.value)}
            className={clsx(
              'rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
              active
                ? 'border-mint-500 bg-mint-500/15 text-mint-300'
                : 'border-ink-500 text-slate-300 hover:border-ink-500 hover:bg-ink-700',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── bool ────────────────────────────────────────────────────────────────────

function BoolControl({
  field,
  value,
  onChange,
}: {
  field: ConstraintField;
  value: ConstraintValue | undefined;
  onChange: (value: ConstraintValue) => void;
}) {
  const checked = value === true;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`field-${field.key}`}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-lg border border-ink-500 bg-ink-700 px-3 py-2 transition hover:border-ink-500"
    >
      <span className="text-xs text-slate-300">{checked ? 'Sí' : 'No'}</span>
      <span
        className={clsx(
          'relative h-4 w-7 shrink-0 rounded-full transition',
          checked ? 'bg-mint-500' : 'bg-ink-500',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 size-3 rounded-full bg-white transition-all',
            checked ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}

// ─── money ───────────────────────────────────────────────────────────────────

function MoneyControl({
  field,
  value,
  onChange,
}: {
  field: ConstraintField;
  value: ConstraintValue | undefined;
  onChange: (value: ConstraintValue) => void;
}) {
  const cents = typeof value === 'number' ? value : null;

  // Borrador local: sin él, escribir "12," se normaliza a "12,00" en cada tecla
  // y el cursor salta. El valor que sale hacia arriba sigue siendo entero.
  const [draft, setDraft] = useState<string>(() => (cents == null ? '' : centsToInputValue(cents)));

  useEffect(() => {
    // Solo se resincroniza cuando el cambio viene de fuera, no de esta tecla.
    const parsed = parseInputToCents(draft);
    if (cents != null && parsed !== cents) setDraft(centsToInputValue(cents));
    if (cents == null && parsed != null) setDraft('');
  }, [cents]);

  return (
    <div className="relative">
      <input
        id={`field-${field.key}`}
        type="text"
        inputMode="decimal"
        className="input pr-7"
        placeholder="0,00"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(parseInputToCents(event.target.value));
        }}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">
        €
      </span>
    </div>
  );
}

// ─── int ─────────────────────────────────────────────────────────────────────

function IntControl({
  field,
  value,
  onChange,
}: {
  field: ConstraintField;
  value: ConstraintValue | undefined;
  onChange: (value: ConstraintValue) => void;
}) {
  const min = field.min ?? 0;
  const max = field.max ?? Number.MAX_SAFE_INTEGER;
  const current = typeof value === 'number' ? value : min;

  const step = (delta: number) =>
    onChange(Math.min(max, Math.max(min, Math.trunc(current) + delta)));

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        className="btn-ghost px-2 py-1.5"
        onClick={() => step(-1)}
        disabled={current <= min}
        aria-label={`Reducir ${field.label}`}
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      <input
        id={`field-${field.key}`}
        type="text"
        inputMode="numeric"
        className="input tabular w-14 text-center"
        value={String(current)}
        onChange={(event) => {
          const digits = event.target.value.replace(/[^\d]/g, '');
          if (digits === '') return onChange(min);
          onChange(Math.min(max, Math.max(min, Number(digits))));
        }}
      />
      <button
        type="button"
        className="btn-ghost px-2 py-1.5"
        onClick={() => step(1)}
        disabled={current >= max}
        aria-label={`Aumentar ${field.label}`}
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

// ─── date ────────────────────────────────────────────────────────────────────

function DateControl({
  field,
  value,
  onChange,
}: {
  field: ConstraintField;
  value: ConstraintValue | undefined;
  onChange: (value: ConstraintValue) => void;
}) {
  // Acota **solo** con lo que el esquema pida. El límite de 7 días es del plazo
  // del mandato, no de toda fecha que exista.
  return (
    <input
      id={`field-${field.key}`}
      type="date"
      className="input"
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value || null)}
    />
  );
}

// ─── type desconocido ────────────────────────────────────────────────────────

function UnknownControl({ type }: { type: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Tipo de control <code className="text-amber-100">{type}</code> todavía no soportado. El
        campo se ignora en el mandato.
      </span>
    </p>
  );
}

// ─── Inicialización ──────────────────────────────────────────────────────────

/**
 * Valores de partida desde los `default` del esquema. Recolectar por `key` es
 * legítimo y necesario — lo prohibido es **ramificar** según su contenido.
 */
export function defaultValuesFor(schema: ConstraintField[]): ConstraintValues {
  const values: ConstraintValues = {};
  for (const field of schema) {
    values[field.key] = field.default ?? fallbackFor(field);
  }
  return values;
}

function fallbackFor(field: ConstraintField): ConstraintValue {
  switch (field.type) {
    case 'bool':
      return false;
    case 'int':
      return field.min ?? 0;
    case 'enum':
      return field.multiple === true ? [] : null;
    case 'money':
    case 'date':
    default:
      return null;
  }
}
