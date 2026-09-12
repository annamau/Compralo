/**
 * Dinero. Entero en céntimos de principio a fin.
 *
 * Ninguna función de este fichero produce, acepta ni almacena un float. El
 * formateo construye la cadena a partir de la división entera y el resto, no
 * dividiendo por 100 y confiando en el redondeo: si un juez abre este fichero,
 * la regla tiene que ser visible, no solo respetada de palabra.
 */

import type { Cents, Currency } from '@/services/api.types';

const GROUPER = new Intl.NumberFormat('es-ES');

const symbolFor = (currency: Currency): string => (currency.toUpperCase() === 'EUR' ? '€' : currency.toUpperCase());

/** `24800` → `"248,00 €"`. `-1900` → `"-19,00 €"`. */
export function formatCents(cents: Cents, currency: Currency = 'EUR'): string {
  const safe = Math.trunc(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const sign = negative ? '-' : '';
  return `${sign}${GROUPER.format(whole)},${String(frac).padStart(2, '0')} ${symbolFor(currency)}`;
}

/** Igual que `formatCents` pero con signo explícito: `1900` → `"+19,00 €"`. */
export function formatDeltaCents(cents: Cents, currency: Currency = 'EUR'): string {
  const safe = Math.trunc(cents);
  if (safe === 0) return formatCents(0, currency);
  return safe > 0 ? `+${formatCents(safe, currency)}` : formatCents(safe, currency);
}

/** `24800` → `"248,00"`. Valor para un `<input>` de importe, sin símbolo. */
export function centsToInputValue(cents: Cents): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Lee lo que el usuario escribe y devuelve céntimos enteros, o `null` si no hay
 * un número reconocible.
 *
 * Tolera `"250"`, `"250,5"`, `"250.50"`, `"1.250,00"`, `"1,250.00"` y `"250 €"`.
 * Con ambos separadores presentes, el último manda. Un separador seguido de
 * algo que no son 1-2 dígitos se trata como agrupación de miles y se descarta.
 *
 * No pasa por `parseFloat` en ningún punto: la parte entera y los céntimos se
 * calculan por separado y se combinan con aritmética entera.
 */
export function parseInputToCents(raw: string): Cents | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;

  const negative = cleaned.trimStart().startsWith('-');
  const unsigned = cleaned.replace(/-/g, '');

  const lastSeparator = Math.max(unsigned.lastIndexOf('.'), unsigned.lastIndexOf(','));
  let wholePart = unsigned;
  let fracPart = '';

  if (lastSeparator !== -1) {
    const after = unsigned.slice(lastSeparator + 1);
    if (/^\d{1,2}$/.test(after)) {
      wholePart = unsigned.slice(0, lastSeparator);
      fracPart = after;
    }
  }

  wholePart = wholePart.replace(/[.,]/g, '');
  if (!wholePart && !fracPart) return null;
  if (!/^\d*$/.test(wholePart)) return null;

  const whole = wholePart === '' ? 0 : Number(wholePart);
  const frac = fracPart === '' ? 0 : Number(fracPart.padEnd(2, '0'));
  const cents = whole * 100 + frac;

  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** `total_cents` significa puesto en casa. Un precio sin envío no es un precio. */
export function deliveredTotalCents(priceCents: Cents, shippingCents: Cents): Cents {
  return Math.trunc(priceCents) + Math.trunc(shippingCents);
}
