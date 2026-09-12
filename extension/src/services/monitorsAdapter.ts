/**
 * Capa de adaptación entre la extensión y el backend Rust real (`origin/rusty`).
 *
 * **Toda la divergencia contra `docs/CONTRACTS.md` vive en este fichero.** Hacia
 * arriba expone exactamente las firmas y los tipos de retorno de `apiClient.ts`
 * (los de `api.types.ts`, o sea CONTRACTS.md verbatim); hacia abajo habla el wire
 * de `backend.types.ts`. `api.types.ts` no se toca: si algo de nuestro contrato
 * no cabe, se documenta aquí y se escala, no se reescribe el contrato.
 *
 * Cuatro traducciones y una ausencia:
 *   1. `*_minor` ↔ `*_cents`. Ambos son enteros de unidad mínima: es un
 *      renombrado, no una conversión. Ningún float entra ni sale de aquí.
 *   2. `status` snake_case → la máquina SCREAMING de CONTRACTS.md.
 *   3. `EvaluationDecision` → `verdict` + `reason`, con `reason` redactado en
 *      español para leerse literal al usuario (ver `decisionToReason`).
 *   4. El log de eventos → el agregado `offers[]` / `purchase` / etc. del
 *      detalle, porque este backend no tiene endpoint de ofertas.
 *   5. Lo que no existe (auth, `/understand`, `/discover`, sustitución, Stripe)
 *      lanza `MissingBackendError`. Nunca datos plausibles en silencio: la UI
 *      tiene que poder distinguir «esto no existe» de «esto ha fallado».
 *
 * Nada de esto tiene autenticación: el servicio no la implementa y `CorsLayer`
 * es permisivo. No se manda `Authorization` a propósito — enviar el token a un
 * servicio que lo ignora solo lo expone sin ganar nada.
 */

import type {
  CancelResponse,
  Canonical,
  CheckoutAttempt,
  Cents,
  ConstraintValue,
  ConstraintValues,
  CreateInstructionRequest,
  CreateInstructionResponse,
  Currency,
  DiscoverRequest,
  DiscoverResponse,
  Funds,
  InstructionDetail,
  InstructionListResponse,
  InstructionStatus,
  IsoUtc,
  Mandate,
  Purchase,
  OfferRecord,
  SubstituteResponse,
  UnderstandRequest,
  UnderstandResponse,
  Verdict,
} from './api.types';
import type {
  BackendProductCondition,
  CanonicalProductWire,
  CreateMonitorRequestWire,
  DemoScenario,
  EvaluationDecisionWire,
  IdResponseWire,
  MinorUnits,
  MonitorEventKind,
  MonitorEventWire,
  MonitorStatusWire,
  MonitorWire,
  NormalizedOfferWire,
  PaymentAuthorizationRequestWire,
  PurchaseConstraintsWire,
  RejectionReason,
} from './backend.types';
import { ApiError, type HttpMethod } from './http';
import type { AuthMeResponse } from './api.types';
import type { StoredSession } from './storage';
import { formatCents } from '@/sidepanel/utils/currency';

// ─── Base y transporte ───────────────────────────────────────────────────────
//
// La URL se lee aquí y no de `apiClient.apiBaseUrl()` para no crear un ciclo de
// imports: `apiClient` importa este módulo. El valor por defecto es el mismo
// que el `BIND_ADDR` del servicio.

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:3000';

export function backendBaseUrl(): string {
  return API_URL;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** El servicio siempre responde `{"error": "..."}` cuando falla. */
function backendMessage(body: unknown): string | null {
  if (typeof body === 'string' && body.trim()) return body;
  const record = asRecord(body);
  const candidate = record?.['error'];
  return typeof candidate === 'string' ? candidate : null;
}

async function backendRequest<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // `status === 0` es la convención de `http.ts` para «no salió de casa»:
    // la UI puede ofrecer volver a modo mock en vez de un fallo opaco.
    throw new ApiError(0, `No se pudo contactar con ${API_URL}`, cause);
  }

  const raw = await response.text();
  const parsed: unknown = raw ? safeJson(raw) : null;

  if (!response.ok) {
    throw new ApiError(response.status, backendMessage(parsed) ?? `HTTP ${response.status}`, parsed);
  }
  return parsed as T;
}

// ─── Lo que este backend no tiene ────────────────────────────────────────────

/**
 * Un endpoint de CONTRACTS.md que **ningún proceso sirve hoy**.
 *
 * Es un `ApiError` para que el manejo de errores existente siga funcionando,
 * pero con `status` 501 y clase propia: la UI puede decir «esto todavía no está
 * implementado en el backend, usa el modo mock» en vez de «ha fallado algo».
 */
export class MissingBackendError extends ApiError {
  /** Siempre `true`: esta capacidad solo existe contra `mockStore`. */
  readonly mockOnly = true;

  constructor(
    /** La ruta de CONTRACTS.md que falta, p. ej. `POST /understand`. */
    readonly contractEndpoint: string,
    /** Qué falta exactamente al otro lado. */
    readonly detail: string,
  ) {
    super(
      501,
      `${contractEndpoint} no existe en el backend real: ${detail}. ` +
        `Solo hay mocks para esto — activa el modo mock (VITE_MOCK=true) para usarlo.`,
    );
    this.name = 'MissingBackendError';
  }
}

export const isMissingBackend = (error: unknown): error is MissingBackendError =>
  error instanceof MissingBackendError;

// ─── Dinero: renombrado, nunca aritmética ────────────────────────────────────
//
// `minor` y `cents` son el mismo entero con otro nombre. `Math.trunc` no
// convierte nada: está para que un float que llegue del wire muera aquí y no se
// propague, igual que hace `sidepanel/utils/currency.ts`.

export const minorToCents = (minor: MinorUnits): Cents => Math.trunc(minor);
export const centsToMinor = (cents: Cents): MinorUnits => Math.trunc(cents);

/**
 * La versión que respeta la ausencia. Un `total_minor: null` significa «no sé lo
 * que cuesta puesto en casa», que es lo contrario de «cuesta 0». Convertirlo a 0
 * haría que una oferta sin envío pareciera gratis y cupiera en cualquier techo.
 */
export const minorToCentsOrNull = (minor: MinorUnits | null | undefined): Cents | null =>
  minor === null || minor === undefined ? null : Math.trunc(minor);

/**
 * `OfferRecord.total_cents` y `Purchase.total_cents` son obligatorios en
 * CONTRACTS.md, pero este backend **no publica el total de una oferta
 * evaluada**: `offer_evaluated` lleva `{offer_id, decision}` y el cuerpo de la
 * oferta solo viaja en `initial_offer_observed`. Tampoco publica el importe del
 * pedido (`purchase_confirmed` lleva solo `order_id`).
 *
 * Se propaga la ausencia en el propio campo en vez de escribir `0`, porque un
 * total desconocido y 0 € significan cosas opuestas y 0 € cabe en cualquier
 * techo. El ensanchamiento de tipo está concentrado en esta constante para que
 * sea greppable: **pedido a P1 → `total_cents: Cents | null` en `OfferRecord` y
 * `Purchase`.** Ver el informe de esta tarea.
 */
const TOTAL_DESCONOCIDO = null as unknown as Cents;

// ─── Estados ─────────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, InstructionStatus> = {
  active: 'ARMED',
  evaluating: 'EVALUATING',
  executing: 'EXECUTING',
  purchased: 'PURCHASED',
  payment_required: 'NEEDS_ATTENTION',
  expired: 'EXPIRED',
  cancelled: 'CANCELLED',
  failed: 'FAILED',
};

/**
 * `active` → `ARMED` y compañía.
 *
 * Un valor que no conozcamos se degrada a su propio nombre en mayúsculas en vez
 * de romper o mentir: `InstructionStatus` es una unión abierta precisamente para
 * eso, la watch list pinta una etiqueta genérica y el valor crudo queda visible
 * para quien depure.
 *
 * No se corrige el estado por nuestra cuenta: un monitor cuyo plazo acaba de
 * pasar puede leerse `active` hasta un tick del worker (≤ 1 s). Mostrar lo que
 * dice el servidor es preferible a que dos clientes discrepen.
 */
export function mapMonitorStatus(status: MonitorStatusWire): InstructionStatus {
  return STATUS_MAP[status] ?? status.toUpperCase();
}

// ─── Veredicto y redacción del motivo ────────────────────────────────────────

export function decisionToVerdict(decision: EvaluationDecisionWire): Verdict {
  return decision.result === 'qualified' ? 'QUALIFIES' : 'REJECTED';
}

const QUALIFIED_PROSE =
  'Cumple el mandato: es el producto que vigilas, la tienda está autorizada y el total puesto en casa cabe en tu techo.';

/**
 * Orden de lectura de los motivos.
 *
 * El `rule-engine` los acumula en el orden de sus comprobaciones, que deja el
 * dinero para el final. Al leerse en voz alta, la frase que importa tiene que ir
 * primera: primero el techo, después la identidad del producto, después la
 * disponibilidad y al final los datos que la página no publica. El orden es
 * solo de presentación; no se descarta ni se añade ningún motivo.
 */
const REASON_PRIORITY: Record<string, number> = {
  total_above_maximum: 0,
  product_mismatch: 1,
  variant_mismatch: 2,
  bundle_not_allowed: 3,
  condition_mismatch: 4,
  retailer_not_approved: 5,
  out_of_stock: 6,
  total_unknown: 7,
  shipping_unknown: 8,
  item_price_unknown: 9,
  currency_mismatch: 10,
  currency_unknown: 11,
  deadline_expired: 12,
  monitor_not_active: 13,
};

const reasonCode = (reason: RejectionReason): string => {
  if (typeof reason === 'string') return reason;
  return Object.keys(reason)[0] ?? 'unknown';
};

/**
 * Un código de máquina → una frase en español que suene a alguien listo
 * señalando un casi-acierto.
 *
 * Sin punto final: lo pone `decisionToReason` al componer, que es quien sabe si
 * la frase va sola o encadenada. Los importes se formatean con `formatCents`,
 * que es el único sitio del proyecto que convierte céntimos en texto.
 */
export function rejectionReasonToProse(reason: RejectionReason, currency: Currency = 'EUR'): string {
  if (typeof reason !== 'string') {
    if ('total_above_maximum' in reason) {
      const { maximum, actual } = reason.total_above_maximum;
      return (
        `Supera el techo: ${formatCents(minorToCents(actual), currency)} puesto en casa ` +
        `frente a un máximo de ${formatCents(minorToCents(maximum), currency)}`
      );
    }
    if ('variant_mismatch' in reason) {
      const { key, expected, actual } = reason.variant_mismatch;
      return actual === null
        ? `La página no dice nada de ${key}, y tú lo fijaste en «${expected}»: sin ese dato no me lanzo`
        : `No es la variante que pediste: ${key} viene como «${actual}» y tú fijaste «${expected}»`;
    }
    return `Motivo nuevo del backend que todavía no sé explicar: «${reasonCode(reason)}»`;
  }

  switch (reason) {
    case 'out_of_stock':
      return 'Está agotado ahora mismo, así que sigo vigilando';
    case 'product_mismatch':
      return 'Se parece mucho, pero no es el producto que vigilas: ni los identificadores ni el modelo cuadran';
    case 'bundle_not_allowed':
      return 'Viene en pack con extras que no pediste, y tu mandato no admite packs';
    case 'condition_mismatch':
      return 'El estado del producto no es el que pediste';
    case 'retailer_not_approved':
      return 'Esta tienda no está entre las que autorizaste';
    case 'item_price_unknown':
      return 'No consigo leer el precio en esta página';
    case 'shipping_unknown':
      return 'La página no publica los gastos de envío, y un precio sin envío no es un precio';
    case 'total_unknown':
      return 'Sin precio y envío completos no puedo calcular el total puesto en casa, y es ese el que tiene que caber';
    case 'currency_unknown':
      return 'La página no dice en qué divisa cobra';
    case 'currency_mismatch':
      return `Cobra en otra divisa que la de tu mandato (${currency.toUpperCase()}), así que el techo no es comparable`;
    case 'deadline_expired':
      return 'Se pasó el plazo que fijaste, así que ya no compro por esta orden';
    case 'monitor_not_active':
      return 'Esta orden ya no está vigilando, así que esta oferta no cuenta';
    default:
      return `Motivo nuevo del backend que todavía no sé explicar: «${reason}»`;
  }
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * La decisión completa → el `reason` que la UI muestra **literal** y que se lee
 * en voz alta. Un motivo va solo; varios se encadenan de corrido, porque una
 * lista de códigos separados por comas suena a informe de validación y no a
 * alguien explicando por qué no ha comprado.
 */
export function decisionToReason(decision: EvaluationDecisionWire, currency: Currency = 'EUR'): string {
  if (decision.result === 'qualified') return QUALIFIED_PROSE;

  const ordered = [...decision.reasons].sort(
    (a, b) => (REASON_PRIORITY[reasonCode(a)] ?? 99) - (REASON_PRIORITY[reasonCode(b)] ?? 99),
  );
  const phrases = ordered.map((reason) => rejectionReasonToProse(reason, currency));

  const first = phrases[0];
  // `Rejected` con la lista vacía no lo produce el rule-engine (devolvería
  // `Qualified`), pero llega por red: si pasa, se dice, no se inventa un motivo.
  if (first === undefined) return 'Rechazada, pero el backend no ha dicho por qué.';

  const rest = phrases.slice(1);
  if (rest.length === 0) return `${first}.`;
  return `${first}. Y además: ${rest.map(lowerFirst).join('; ')}.`;
}

/**
 * Los errores de ejecución llegan como el `Display` del error de Rust, en
 * inglés, dentro de `{error}`. Aquí se traducen los que el código puede emitir;
 * cualquier otro se muestra tal cual antes que perderlo.
 *
 * El primero de la lista es el importante: contra una tienda real **nunca** se
 * llega a `purchased`, porque `DemoMerchant::supports` solo acepta
 * `retailer == "demo"`. Decirlo claro es mejor que insinuar que hubo un pedido.
 */
export function describeBackendError(raw: string): string {
  const error = raw.trim();
  if (error.includes('does not support automatic checkout')) {
    return 'La oferta cumplía tu mandato, pero esta tienda no admite compra automática: hoy solo se puede cerrar el pedido en el comercio de demostración. No se ha pagado nada.';
  }
  if (error.includes('no payment authorization covers this purchase')) {
    return 'La oferta cumplía tu mandato, pero no hay una autorización de pago que cubra el importe. Hace falta armar la retención antes de que pueda comprar.';
  }
  if (error.includes('revalidation') || error.includes('no longer qualifies')) {
    return 'Al volver a leer la página justo antes de pagar, la oferta ya no cumplía el mandato. No se ha pagado nada: la relectura es obligatoria precisamente para esto.';
  }
  if (error.includes('payment authentication required')) {
    return 'El pago necesita autenticación: tienes que confirmarlo tú para que pueda continuar.';
  }
  if (error.includes('declined')) {
    return `El comercio rechazó el pago (${error}).`;
  }
  if (error.includes('unknown checkout result')) {
    return 'El comercio no ha confirmado si el pedido existe. Se ha comprobado con él antes de reintentar, así que no hay riesgo de comprar dos veces.';
  }
  if (error.includes('extraction') || error.includes('fetch failed') || error.includes('unsafe URL')) {
    return `No he podido leer la página en esta pasada (${error}).`;
  }
  return error;
}

// ─── Lectura defensiva del log de eventos ────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Una razón es una cadena o un objeto de una sola clave; nada más se acepta. */
function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === 'string' || asRecord(value) !== null;
}

function readDecision(value: unknown): EvaluationDecisionWire | null {
  const record = asRecord(value);
  const result = record?.['result'];
  if (result === 'qualified') return { result: 'qualified' };
  if (result === 'rejected') {
    const raw = record?.['reasons'];
    return { result: 'rejected', reasons: Array.isArray(raw) ? raw.filter(isRejectionReason) : [] };
  }
  return null;
}

function readOffer(value: unknown): NormalizedOfferWire | null {
  const record = asRecord(value);
  if (!record) return null;
  // Basta con que traiga lo que se va a leer; el resto se toma como venga.
  return typeof record['retailer'] === 'string' ? (record as unknown as NormalizedOfferWire) : null;
}

/** El `data` de un evento SSE: el objeto completo, serializado. */
function readMonitorEvent(data: unknown): MonitorEventWire | null {
  const parsed = typeof data === 'string' ? safeJson(data) : data;
  const record = asRecord(parsed);
  if (!record) return null;
  const kind = readString(record, 'kind');
  const id = readNumber(record, 'id');
  if (kind === null || id === null) return null;
  return {
    id,
    monitor_id: readString(record, 'monitor_id') ?? '',
    kind,
    payload: record['payload'],
    created_at: readString(record, 'created_at') ?? new Date().toISOString(),
  };
}

// ─── Producto y tienda ───────────────────────────────────────────────────────

/**
 * Misma derivación que `product_intelligence::retailer_name` en el backend
 * (hostname de la URL final menos `www.`) y que `domReader.retailerFromUrl` en
 * el panel. Se replica en vez de importarse para no arrastrar un módulo que
 * depende de `chrome.*` dentro de la capa de servicios.
 */
function retailerFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * `CanonicalProduct` del backend → `Canonical` de CONTRACTS.md.
 *
 * `identifiers` del backend es un mapa libre (el ejemplo de `API.md` usa `sku`)
 * y `Canonical.identifiers` solo admite `ean`/`gtin`/`mpn`. Se trasladan esos
 * tres y los demás se quedan fuera: no hay dónde ponerlos sin tocar
 * `api.types.ts`. Anotado en el informe.
 */
function canonicalFromWire(product: CanonicalProductWire, url: string): Canonical {
  const identifiers: NonNullable<Canonical['identifiers']> = {};
  for (const [key, value] of Object.entries(product.identifiers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'ean') identifiers.ean = value;
    else if (lower === 'gtin') identifiers.gtin = value;
    else if (lower === 'mpn') identifiers.mpn = value;
  }
  const canonical: Canonical = { name: product.name };
  if (product.brand !== null) canonical.brand = product.brand;
  if (product.model !== null) canonical.model = product.model;
  if (Object.keys(identifiers).length > 0) canonical.identifiers = identifiers;
  canonical.category = retailerFromUrl(url);
  return canonical;
}

/**
 * `Monitor.product` es `null` hasta que el primer scrape fija la línea base, y
 * `Canonical.name` es obligatorio. Se dice la verdad en vez de inventar un
 * nombre de producto: la watch list tiene que poder mostrar una orden armada
 * cuya identidad el backend todavía no ha establecido.
 */
const SIN_PRODUCTO_TODAVIA = 'Producto sin identificar todavía';

function canonicalOf(monitor: MonitorWire): Canonical {
  return monitor.product === null
    ? { name: SIN_PRODUCTO_TODAVIA, category: retailerFromUrl(monitor.url) }
    : canonicalFromWire(monitor.product, monitor.url);
}

function canonicalToWire(canonical: Canonical): CanonicalProductWire {
  const identifiers: Record<string, string> = {};
  for (const [key, value] of Object.entries(canonical.identifiers ?? {})) {
    if (typeof value === 'string' && value.trim()) identifiers[key] = value;
  }
  return {
    name: canonical.name,
    brand: canonical.brand ?? null,
    model: canonical.model ?? null,
    identifiers,
  };
}

// ─── Restricciones ───────────────────────────────────────────────────────────

/** De más estricto a menos. El orden es el criterio de desempate, ver abajo. */
const CONDITIONS: BackendProductCondition[] = ['new', 'refurbished', 'used', 'unknown'];

/**
 * Claves de `ConstraintValues` que no son ejes de variante: o tienen su propio
 * campo en `PurchaseConstraints`, o son metadatos nuestros.
 *
 * `bundle` está en la lista a propósito: el rule-engine lee `variants["bundle"]`
 * **de la oferta** para decidir si es un pack. Mandarlo como restricción de
 * variante crearía una exigencia de igualdad exacta sobre ese eje, que no es lo
 * que significa «no quiero packs»; eso lo lleva `bundles_allowed`.
 */
const NON_VARIANT_KEYS = new Set([
  'condition',
  'bundles_allowed',
  'bundle',
  'url',
  'source_url',
  'page_url',
  'retailers',
  'quantity',
  'currency',
  'deadline',
  'max_total_cents',
]);

/**
 * `PurchaseConstraints.condition` es **un solo valor**, y nuestro `enum` puede
 * traer varios (`multiple: true`).
 *
 * Cuando hay varios se queda el más estricto. Recortar el mandato puede hacer
 * que el agente deje pasar algo que el usuario aceptaba; ensancharlo podría
 * hacerle comprar algo que no aceptaba. De los dos errores, solo uno cuesta
 * dinero.
 */
function conditionToWire(value: ConstraintValue | undefined): BackendProductCondition | null {
  const candidates = (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase());
  for (const condition of CONDITIONS) {
    if (candidates.includes(condition)) return condition;
  }
  return null;
}

/**
 * El resto de `ConstraintValues` → `constraints.variants`, que es
 * `Record<string,string>` comparado por **igualdad exacta** (sin distinguir
 * mayúsculas) contra los ejes de la oferta.
 *
 * Consecuencias que no son elección nuestra sino del motor:
 *   - una lista de valores aceptados se recorta al primero, por el mismo
 *     criterio que `conditionToWire`: el mandato se estrecha, nunca se ensancha;
 *   - un `bool` en `true` es una exigencia y viaja como `"true"`; en `false` no
 *     exige nada y no viaja;
 *   - un `int` o un `money` viaja como igualdad exacta, que **no** es el umbral
 *     que probablemente significaba. Sin un operador de comparación en
 *     `PurchaseConstraints` no hay traducción fiel. Anotado en el informe.
 */
function variantsToWire(constraints: ConstraintValues): Record<string, string> {
  const variants: Record<string, string> = {};
  for (const [key, value] of Object.entries(constraints)) {
    if (NON_VARIANT_KEYS.has(key) || value === null || value === undefined) continue;
    if (typeof value === 'string') {
      if (value.trim()) variants[key] = value;
    } else if (typeof value === 'number') {
      variants[key] = String(Math.trunc(value));
    } else if (typeof value === 'boolean') {
      if (value) variants[key] = 'true';
    } else if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim());
      if (first !== undefined) variants[key] = first;
    }
  }
  return variants;
}

function constraintsToWire(payload: CreateInstructionRequest): PurchaseConstraintsWire {
  return {
    maximum_total_minor: centsToMinor(payload.max_total_cents),
    currency: payload.currency,
    condition: conditionToWire(payload.constraints['condition']),
    variants: variantsToWire(payload.constraints),
    // Ausente equivale a «no quiero packs»: es la lectura conservadora, y
    // coincide con el valor por defecto del formulario del mandato.
    bundles_allowed: payload.constraints['bundles_allowed'] === true,
    approved_retailers: payload.retailers,
  };
}

/**
 * El camino de vuelta, para el `mandate` del detalle. Son **valores**, no
 * esquema: este backend no emite `constraint_schema`, así que el renderizador
 * genérico de P2 sigue alimentándose solo de mocks (§8 de BACKEND_REFERENCE).
 */
function constraintValuesFromWire(constraints: PurchaseConstraintsWire): ConstraintValues {
  const values: ConstraintValues = {
    bundles_allowed: constraints.bundles_allowed,
  };
  if (constraints.condition !== null) values['condition'] = constraints.condition;
  for (const [key, value] of Object.entries(constraints.variants ?? {})) values[key] = value;
  return values;
}

// ─── URL vigilada ────────────────────────────────────────────────────────────

let defaultMonitorUrl: string | null = null;

/**
 * `POST /instructions` de CONTRACTS.md **no lleva URL** y `POST /v1/monitors`
 * la exige: un monitor vigila exactamente una página. El panel sí la conoce
 * (`domReader` la saca de la pestaña activa), así que la registra aquí y las
 * firmas de `apiClient` no cambian.
 */
export function setMonitoredUrl(url: string | null): void {
  defaultMonitorUrl = url;
}

function resolveMonitorUrl(payload: CreateInstructionRequest, explicit?: string): string {
  const fromConstraints = ['url', 'source_url', 'page_url']
    .map((key) => payload.constraints[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const url = explicit ?? fromConstraints ?? defaultMonitorUrl;
  if (!url) {
    throw new MissingBackendError(
      'POST /instructions',
      'este backend vigila una URL concreta y el contrato de creación no la incluye; ' +
        'registra la página con `setMonitoredUrl()` o pásala en `constraints.url`',
    );
  }
  return url;
}

// ─── GET /instructions ───────────────────────────────────────────────────────

function toSummary(monitor: MonitorWire) {
  return {
    id: monitor.id,
    canonical: canonicalOf(monitor),
    status: mapMonitorStatus(monitor.status),
    max_total_cents: minorToCents(monitor.constraints.maximum_total_minor),
    deadline: monitor.deadline,
    // `last_checked_at` vive en `monitor_jobs` y ninguna ruta lo expone. Se
    // podría deducir del último evento de cada monitor, pero eso son N
    // peticiones para pintar una lista: en el detalle sí se deduce.
    last_checked_at: null,
  };
}

/**
 * `GET /v1/monitors` devuelve **todos** los monitores del servicio, sin ámbito
 * por usuario: no hay tabla de usuarios ni autenticación. Lo que se pinta es lo
 * que hay en la máquina, no «lo mío».
 */
export async function listInstructions(): Promise<InstructionListResponse> {
  const monitors = await backendRequest<MonitorWire[]>('GET', '/v1/monitors');
  return { instructions: (Array.isArray(monitors) ? monitors : []).map(toSummary) };
}

// ─── GET /instructions/:id ───────────────────────────────────────────────────

/**
 * `OfferRecord` con el total honestamente ausente. Ver `TOTAL_DESCONOCIDO`.
 * La aserción a `OfferRecord[]` es legal porque solo ensancha `total_cents`.
 */
type OfferRecordConTotal = Omit<OfferRecord, 'total_cents'> & { total_cents: Cents | null };

/** El log no tiene veredicto para estos dos casos, y forzarlos a REJECTED mentiría. */
const VERDICT_OBSERVED: Verdict = 'OBSERVED';
const VERDICT_CHECK_FAILED: Verdict = 'CHECK_FAILED';

/**
 * El agregado del detalle, ensamblado de `GET /v1/monitors/{id}` +
 * `GET /v1/monitors/{id}/events`. Dos llamadas porque el backend no tiene
 * agregado: `mandate` sale del monitor y todo lo demás del log de eventos.
 */
export async function getInstruction(id: string): Promise<InstructionDetail> {
  const encoded = encodeURIComponent(id);
  const [monitor, events] = await Promise.all([
    backendRequest<MonitorWire>('GET', `/v1/monitors/${encoded}`),
    backendRequest<MonitorEventWire[]>('GET', `/v1/monitors/${encoded}/events`),
  ]);

  const currency = monitor.constraints.currency;
  const retailer = retailerFromUrl(monitor.url);
  const log = Array.isArray(events) ? events : [];

  const offers: OfferRecordConTotal[] = [];
  let purchase: Purchase | undefined;
  let attempt: CheckoutAttempt | undefined;
  let lastCheckedAt: IsoUtc | null = null;
  let lastOfferId = '';
  let authorization: { id: string; committed: Cents; currency: string } | null = null;

  for (const event of log) {
    const payload = asRecord(event.payload);

    switch (event.kind) {
      case 'initial_offer_observed': {
        // El único evento con el cuerpo completo de la oferta. La pasada que
        // establece la línea base no evalúa (el worker vuelve antes), así que
        // esta observación no tiene decisión: se marca como tal en vez de
        // colarla como veredicto.
        const offer = readOffer(payload?.['offer']);
        lastCheckedAt = event.created_at;
        if (!offer) break;
        offers.push({
          retailer: offer.retailer,
          total_cents: minorToCentsOrNull(offer.total_minor),
          verdict: VERDICT_OBSERVED,
          reason:
            'Primera lectura de la página: sirve para fijar qué producto es. ' +
            'En esa pasada el agente no compra, por diseño.',
          at: event.created_at,
        });
        break;
      }

      case 'offer_evaluated': {
        const decision = readDecision(payload?.['decision']);
        lastCheckedAt = event.created_at;
        lastOfferId = readString(payload, 'offer_id') ?? lastOfferId;
        if (!decision) break;

        // El total solo es recuperable cuando el propio motivo lo trae; el
        // payload no incluye la oferta. Ver `TOTAL_DESCONOCIDO`.
        let total: Cents | null = null;
        if (decision.result === 'rejected') {
          for (const reason of decision.reasons) {
            if (typeof reason !== 'string' && 'total_above_maximum' in reason) {
              total = minorToCents(reason.total_above_maximum.actual);
            }
          }
        }

        const record: OfferRecordConTotal = {
          // Un monitor vigila una sola URL, así que la tienda de cualquier
          // oferta evaluada es el host de esa URL — la misma derivación que hace
          // el backend. Una oferta inyectada por `/v1/demo/offers` puede traer
          // otra (`"demo"`), y entonces `retailer_not_approved` lo delata.
          retailer,
          total_cents: total,
          verdict: decisionToVerdict(decision),
          reason: decisionToReason(decision, currency),
          at: event.created_at,
        };
        const offerId = readString(payload, 'offer_id');
        if (offerId !== null) record.offer_id = offerId;
        offers.push(record);
        break;
      }

      case 'monitor_check_failed': {
        // No es una oferta rechazada: es una página que no se pudo leer. El
        // detalle no tiene otro sitio donde contarlo y el log de auditoría es
        // justo donde el usuario lo va a buscar.
        lastCheckedAt = event.created_at;
        offers.push({
          retailer,
          total_cents: null,
          verdict: VERDICT_CHECK_FAILED,
          reason: describeBackendError(readString(payload, 'error') ?? 'error desconocido'),
          at: event.created_at,
        });
        break;
      }

      case 'payment_authorized': {
        const authId = readString(payload, 'authorization_id');
        const maximum = readNumber(payload, 'maximum_minor');
        if (authId === null || maximum === null) break;
        authorization = {
          id: authId,
          committed: minorToCents(maximum),
          currency: readString(payload, 'currency') ?? currency,
        };
        break;
      }

      case 'purchase_confirmed': {
        purchase = {
          // `purchase_confirmed` lleva solo `order_id`: el importe del pedido no
          // está en el log ni en ninguna ruta. Ver `TOTAL_DESCONOCIDO`.
          total_cents: TOTAL_DESCONOCIDO,
          retailer,
          order_ref: readString(payload, 'order_id') ?? '',
          at: event.created_at,
        };
        attempt = {
          offer_id: lastOfferId,
          retailer,
          attempted_cents: TOTAL_DESCONOCIDO,
          status: 'PURCHASED',
          at: event.created_at,
        };
        break;
      }

      case 'payment_required':
      case 'execution_failed':
      case 'qualified_offer_not_executed': {
        const error = readString(payload, 'error') ?? 'error desconocido';
        attempt = {
          offer_id: lastOfferId,
          retailer,
          attempted_cents: TOTAL_DESCONOCIDO,
          status: event.kind === 'payment_required' ? 'NEEDS_ATTENTION' : 'FAILED',
          decline_reason: error,
          message: describeBackendError(error),
          // CONTRACTS.md pide que se vea quién impuso el límite.
          // `qualified_offer_not_executed` lo impone nuestro código antes de
          // tocar al comercio; los otros dos vienen del comercio. Ninguno es
          // Stripe: aquí no hay capa de pago real que pueda rechazar nada.
          enforced_by: event.kind === 'qualified_offer_not_executed' ? 'rule-engine' : 'demo-merchant',
          at: event.created_at,
        };
        break;
      }

      default:
        // `monitor_created`, `product_baseline_established`, `execution_started`,
        // `monitor_cancelled` y `monitor_expired` no añaden nada al agregado que
        // el estado del monitor no diga ya.
        break;
    }
  }

  const mandate: Mandate = {
    max_total_cents: minorToCents(monitor.constraints.maximum_total_minor),
    currency,
    deadline: monitor.deadline,
    // No hay `quantity` en el wire, y no es un hueco que rellenar a ojo: un
    // índice único en la base de datos garantiza **una** ejecución con éxito por
    // monitor, así que la cantidad que este backend puede comprar es 1.
    quantity: 1,
    retailers: monitor.constraints.approved_retailers,
    constraints: constraintValuesFromWire(monitor.constraints),
  };

  const detail: InstructionDetail = {
    id: monitor.id,
    status: mapMonitorStatus(monitor.status),
    mandate,
    funds: fundsFrom(monitor, authorization),
    offers: offers as OfferRecord[],
    canonical: canonicalOf(monitor),
    // Deducido del último evento de comprobación. No es el `last_checked_at` de
    // `monitor_jobs` (que nadie expone), pero es el mismo hecho: cuándo se miró
    // la página por última vez.
    last_checked_at: lastCheckedAt,
  };
  if (purchase) detail.purchase = purchase;
  if (attempt) detail.last_checkout_attempt = attempt;
  // `pending_alternative` se queda siempre ausente: no hay `AWAITING_APPROVAL`
  // ni `alternative` en este backend, así que la Approval Card es solo-mock.
  return detail;
}

/**
 * El bloque `funds`.
 *
 * **Lo que no tiene backend detrás:** no hay Stripe, ni `client_secret`, ni
 * caducidad de la retención, ni ruta de liberación. Lo único real es
 * `POST /v1/monitors/{id}/payment-authorizations`, que inserta una fila
 * `status='authorized'` con `provider_reference = "demo-<uuid>"`.
 *
 * Por eso:
 *   - sin autorización, `committed_cents` es 0 y no hay `hold_id` ni `status`.
 *     Eso es literalmente cierto: no hay nada retenido;
 *   - con autorización, `expires` se rellena con el plazo del mandato. La fila
 *     no caduca, pero pasado el plazo el worker expira el monitor y deja de
 *     poder gastar, así que el plazo es la cota superior verdadera de cuándo
 *     este mandato puede seguir comprando. `dates.ts` lo recorta a 7 días, que
 *     es la vida que PAYMENTS.md asume para una autorización de tarjeta;
 *   - `status` no pasa nunca a `released`, porque cancelar no libera nada aquí.
 */
function fundsFrom(
  monitor: MonitorWire,
  authorization: { id: string; committed: Cents; currency: string } | null,
): Funds {
  if (!authorization) {
    return {
      committed_cents: 0,
      currency: monitor.constraints.currency,
      // Sin retención no hay fecha de caducidad que mostrar. `formatDateTime`
      // resuelve esto como «—», que es lo que hay que decir.
      expires: '',
    };
  }
  return {
    hold_id: authorization.id,
    committed_cents: authorization.committed,
    currency: authorization.currency,
    expires: monitor.deadline,
    status: 'committed',
  };
}

// ─── POST /instructions ──────────────────────────────────────────────────────

/**
 * Crea el monitor y arma la autorización de pago.
 *
 * `sourceUrl` es opcional para no cambiar la firma de `apiClient`: ver
 * `setMonitoredUrl`.
 */
export async function createInstruction(
  payload: CreateInstructionRequest,
  sourceUrl?: string,
): Promise<CreateInstructionResponse> {
  if (payload.quantity > 1) {
    // Silenciar esto sería prometer 3 unidades y comprar 1: el índice único de
    // `merchant_orders` garantiza una sola ejecución con éxito por monitor.
    throw new MissingBackendError(
      'POST /instructions',
      `este backend compra una unidad por orden y se han pedido ${payload.quantity}; ` +
        'no hay forma de expresar la cantidad sin crear varias órdenes',
    );
  }

  const body: CreateMonitorRequestWire = {
    url: resolveMonitorUrl(payload, sourceUrl),
    // Se manda nuestro canónico en vez de `null`: la identidad del producto es
    // la que fijó el usuario, no la que diga la página. El coste es que un
    // canónico impreciso produce `product_mismatch` de forma permanente, que se
    // ve en el log; delegar la identidad a la primera lectura sería peor, porque
    // haría comprable cualquier cosa que esa página anunciara ese día.
    product: canonicalToWire(payload.canonical),
    constraints: constraintsToWire(payload),
    deadline: payload.deadline,
  };

  const monitor = await backendRequest<MonitorWire>('POST', '/v1/monitors', body);

  return {
    instruction_id: monitor.id,
    status: mapMonitorStatus(monitor.status),
    funds: await armPaymentAuthorization(monitor),
  };
}

/**
 * Sin autorización el motor rechaza la compra con
 * `no payment authorization covers this purchase`, así que armar incluye
 * crearla — es el «ONE TAP» de PAYMENTS.md con lo que este backend tiene.
 *
 * Un fallo aquí no tumba la creación: el monitor ya existe y ya está vigilando,
 * y fallar dejaría una orden huérfana que el usuario no vería. Se devuelve el
 * bloque vacío, que dice la verdad (no hay nada retenido), y se avisa por
 * consola.
 */
async function armPaymentAuthorization(monitor: MonitorWire): Promise<Funds> {
  try {
    const authorization = await authorizePayment(
      monitor.id,
      minorToCents(monitor.constraints.maximum_total_minor),
      monitor.constraints.currency,
    );
    return fundsFrom(monitor, {
      id: authorization.id,
      committed: minorToCents(monitor.constraints.maximum_total_minor),
      currency: monitor.constraints.currency,
    });
  } catch (cause) {
    console.warn('[compralo] monitor creado sin autorización de pago', cause);
    return fundsFrom(monitor, null);
  }
}

/**
 * `POST /v1/monitors/{id}/payment-authorizations`. Lo más cercano a
 * `/funds/commit` que existe, y deliberadamente con otro nombre: no es una
 * retención de tarjeta, es una fila en SQLite. El servidor exige que cubra
 * `constraints.maximum_total_minor` y que la divisa coincida.
 */
export async function authorizePayment(
  monitorId: string,
  maximumCents: Cents,
  currency: Currency,
): Promise<IdResponseWire> {
  const body: PaymentAuthorizationRequestWire = {
    maximum_minor: centsToMinor(maximumCents),
    currency,
  };
  return backendRequest<IdResponseWire>(
    'POST',
    `/v1/monitors/${encodeURIComponent(monitorId)}/payment-authorizations`,
    body,
  );
}

// ─── POST /instructions/:id/cancel ───────────────────────────────────────────

/**
 * `POST /v1/monitors/{id}/cancel` responde `204` sin cuerpo, y `409` cuando el
 * estado no admite la transición — es decir, cuando la orden ya estaba
 * liquidada (`purchased`, `expired`, `cancelled`). Eso no es un error que
 * merezca alarmar al usuario: se consulta el estado real y se devuelve.
 *
 * `released_cents` es 0 siempre: **este backend no libera nada**. No hay ruta de
 * liberación y la fila de autorización se queda en `authorized` después de
 * cancelar. Devolver el importe retenido aquí diría que se ha liberado algo que
 * sigue comprometido.
 */
export async function cancelInstruction(id: string): Promise<CancelResponse> {
  const encoded = encodeURIComponent(id);
  try {
    await backendRequest<null>('POST', `/v1/monitors/${encoded}/cancel`);
    return { status: 'CANCELLED', released_cents: 0 };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const monitor = await backendRequest<MonitorWire>('GET', `/v1/monitors/${encoded}`);
      return { status: mapMonitorStatus(monitor.status), released_cents: 0 };
    }
    throw error;
  }
}

// ─── SSE: GET /v1/monitors/{id}/events/stream ────────────────────────────────

/** Todos los `kind` que el backend emite hoy. */
export const MONITOR_EVENT_KINDS: readonly string[] = [
  'monitor_created',
  'initial_offer_observed',
  'product_baseline_established',
  'offer_evaluated',
  'monitor_check_failed',
  'payment_authorized',
  'execution_started',
  'purchase_confirmed',
  'payment_required',
  'execution_failed',
  'qualified_offer_not_executed',
  'monitor_cancelled',
  'monitor_expired',
];

/**
 * Los tres eventos tras los que el monitor ya no cambia, en el mismo orden que
 * `MonitorStatus::is_terminal` (`purchased`, `expired`, `cancelled`).
 */
export const TERMINAL_EVENT_KINDS: readonly string[] = [
  'purchase_confirmed',
  'monitor_expired',
  'monitor_cancelled',
];

export interface MonitorEventStreamOptions {
  onEvent?: (event: MonitorEventWire) => void;
  /** Se invoca una vez, después de cerrar el stream. */
  onTerminal?: (kind: MonitorEventKind) => void;
  onError?: (error: unknown) => void;
  /** `kind` adicionales, por si el backend añade alguno antes que nosotros. */
  extraKinds?: readonly string[];
}

/**
 * Suscripción al log en vivo. Devuelve la función de desuscripción.
 *
 * Dos trampas de este stream:
 *
 *  1. **Nunca termina por sí solo.** Está implementado como un poll de 1 s sobre
 *     la tabla de eventos, con keep-alive, y sigue abierto después de un estado
 *     terminal. Lo cierra este helper al ver el primer evento terminal; el
 *     `EventSource` que no se cierra se queda reconectando para siempre.
 *  2. **El servidor nombra todos los eventos** (`SSE event: <kind>`), así que
 *     `onmessage` no se dispara nunca: hay que suscribirse `kind` a `kind`. Se
 *     deja `onmessage` puesto solo como red por si algún día llega un evento sin
 *     nombre.
 */
export function subscribeToMonitorEvents(
  monitorId: string,
  options: MonitorEventStreamOptions = {},
): () => void {
  const source = new EventSource(
    `${API_URL}/v1/monitors/${encodeURIComponent(monitorId)}/events/stream`,
  );

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  const handle = (raw: Event): void => {
    const event = readMonitorEvent((raw as MessageEvent).data);
    if (!event) return;
    options.onEvent?.(event);
    if (TERMINAL_EVENT_KINDS.includes(event.kind)) {
      close();
      options.onTerminal?.(event.kind);
    }
  };

  for (const kind of [...MONITOR_EVENT_KINDS, ...(options.extraKinds ?? [])]) {
    source.addEventListener(kind, handle);
  }
  source.onmessage = handle;
  source.onerror = (event) => options.onError?.(event);

  return close;
}

// ─── Palancas de demo ────────────────────────────────────────────────────────

export interface DemoOfferResult {
  /** La decisión cruda, por si la UI quiere mostrar los códigos de máquina. */
  decision: EvaluationDecisionWire;
  verdict: Verdict;
  /** Ya redactado: se muestra literal. */
  reason: string;
}

/**
 * `POST /v1/demo/offers/{monitor_id}` — la palanca para dirigir la demo con
 * veredictos reales del backend y sin scraping.
 *
 * Evalúa y registra un `offer_evaluated`, pero **no ejecuta checkout**. O sea:
 * mueve el log de auditoría y el stream SSE, no el estado del monitor. Para
 * llegar a `purchased` hace falta el worker sobre una oferta cuyo
 * `retailer === "demo"`.
 */
export async function submitDemoOffer(
  monitorId: string,
  offer: NormalizedOfferWire,
): Promise<DemoOfferResult> {
  const decision = await backendRequest<EvaluationDecisionWire>(
    'POST',
    `/v1/demo/offers/${encodeURIComponent(monitorId)}`,
    offer,
  );
  const currency = offer.currency ?? 'EUR';
  return {
    decision,
    verdict: decisionToVerdict(decision),
    reason: decisionToReason(decision, currency),
  };
}

/**
 * `POST /v1/demo/scenarios/{scenario}`. La selección es **global al proceso**,
 * no por monitor, y vuelve a `success` al reiniciar el servidor: si esto acaba
 * en una pantalla de ajustes, tiene que presentarse como un interruptor global.
 */
export async function setDemoScenario(scenario: DemoScenario): Promise<void> {
  await backendRequest<null>('POST', `/v1/demo/scenarios/${encodeURIComponent(scenario)}`);
}

// ─── Lo que no existe: errores claros, nunca datos inventados ────────────────

export function login(_email: string): Promise<StoredSession> {
  return Promise.reject(
    new MissingBackendError(
      'POST /auth/login',
      'el servicio no tiene autenticación, ni tabla de usuarios, ni ámbito por usuario ' +
        '(`GET /v1/monitors` devuelve los monitores de todo el mundo)',
    ),
  );
}

export function me(): Promise<AuthMeResponse> {
  return Promise.reject(
    new MissingBackendError('GET /auth/me', 'no hay sesiones que validar: el servicio no autentica'),
  );
}

export function understand(_payload: UnderstandRequest): Promise<UnderstandResponse> {
  return Promise.reject(
    new MissingBackendError(
      'POST /understand',
      'no acepta capturas de pantalla y la extracción es HTML del lado servidor (JSON-LD → OpenGraph, sin IA); ' +
        'sobre todo **no emite `constraint_schema`**, así que el renderizador genérico no tiene fuente',
    ),
  );
}

export function discover(_payload: DiscoverRequest): Promise<DiscoverResponse> {
  return Promise.reject(
    new MissingBackendError(
      'POST /discover',
      'no existe el concepto de candidato: un monitor vigila exactamente una URL',
    ),
  );
}

export function respondToSubstitute(
  _id: string,
  _candidateId: string,
  _approved: boolean,
): Promise<SubstituteResponse> {
  return Promise.reject(
    new MissingBackendError(
      'POST /instructions/:id/substitute',
      'no hay estado `AWAITING_APPROVAL` ni alternativa que aprobar; el rule-engine no emite `alternative`',
    ),
  );
}

export function commitFunds(): Promise<never> {
  return Promise.reject(
    new MissingBackendError(
      'POST /funds/commit',
      'no hay Stripe, ni `client_secret`, ni caducidad; lo más parecido es ' +
        '`POST /v1/monitors/{id}/payment-authorizations`, expuesto aquí como `authorizePayment()`',
    ),
  );
}

export function releaseFunds(): Promise<never> {
  return Promise.reject(
    new MissingBackendError(
      'POST /funds/release',
      'no hay ruta de liberación: la fila de autorización se queda en `authorized` incluso tras cancelar',
    ),
  );
}

export function checkout(): Promise<never> {
  return Promise.reject(
    new MissingBackendError(
      'POST /checkout',
      'el checkout no es alcanzable por HTTP: solo lo dispara el worker cuando una oferta cualifica',
    ),
  );
}
