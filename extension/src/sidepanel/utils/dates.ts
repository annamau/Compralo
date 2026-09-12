/**
 * Plazos. La regla dura: **7 días como máximo**.
 *
 * No es una preferencia de producto. La autorización de tarjeta que sostiene el
 * mandato expira sobre los 7 días (ver `docs/PAYMENTS.md`), así que una orden a
 * 30 días sería una promesa que el hold no puede cumplir.
 *
 * Este clamp pertenece **solo** al `deadline` del mandato. El control genérico
 * de `type: 'date'` no lo aplica: ahí una fecha es una restricción de producto
 * cualquiera, y recortarla a 7 días sería meter semántica en el renderizador.
 */

import type { IsoUtc } from '@/services/api.types';

export const MAX_DEADLINE_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** ISO-8601 UTC con sufijo `Z`. Formato congelado en A5. */
export const toIsoUtc = (date: Date): IsoUtc => date.toISOString();

/** Valor para un `<input type="date">`: `YYYY-MM-DD` en hora local. */
export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function fromDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** El último instante que una retención puede cubrir desde ahora. */
export function maxDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + MAX_DEADLINE_DAYS * MS_PER_DAY);
}

/** Plazo por defecto del formulario: el máximo, porque es lo que el usuario quiere. */
export function defaultDeadline(from: Date = new Date()): Date {
  return maxDeadline(from);
}

/** Recorta al rango permitido: nunca en el pasado, nunca más allá de 7 días. */
export function clampDeadline(date: Date, from: Date = new Date()): Date {
  const ceiling = maxDeadline(from);
  if (date.getTime() > ceiling.getTime()) return ceiling;
  if (date.getTime() < from.getTime()) return from;
  return date;
}

export function isWithinDeadlineLimit(date: Date, from: Date = new Date()): boolean {
  return date.getTime() <= maxDeadline(from).getTime() && date.getTime() >= from.getTime();
}

/** Días enteros que quedan, hacia arriba. `0` significa que vence hoy. */
export function daysUntil(iso: IsoUtc, from: Date = new Date()): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.ceil((target - from.getTime()) / MS_PER_DAY));
}

const LONG = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const SHORT = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long' });

/** `"19 sept, 10:00"` — para el resumen del mandato y las tarjetas de orden. */
export function formatDateTime(iso: IsoUtc): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : LONG.format(date);
}

/** `"19 de septiembre"` — para la frase de confianza de la confirmación. */
export function formatDayMonth(iso: IsoUtc): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : SHORT.format(date);
}

/**
 * `"hace 12 s"`, `"hace 4 min"`. Devuelve `null` cuando no hay marca de tiempo,
 * para que sea quien llama el que redacte la frase: componer un prefijo fijo con
 * un texto de ausencia produce cosas como «Comprobado sin comprobar todavía».
 */
export function formatRelative(iso: IsoUtc | null | undefined, from: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;

  const seconds = Math.max(0, Math.round((from.getTime() - then) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
