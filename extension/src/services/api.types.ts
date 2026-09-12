/**
 * Contratos de red, copiados de `docs/CONTRACTS.md` y de las enmiendas
 * acordadas en `docs/P1_P3_CONTRACT_REQUESTS.md` (A1–A5).
 *
 * P1 es el dueño del contrato. Este fichero solo lo refleja: si divergen, gana
 * CONTRACTS.md y este fichero está mal.
 *
 * Tres invariantes que el tipado hace visibles:
 *   1. El dinero es siempre entero en céntimos (`Cents`). Nunca un float.
 *   2. `total_cents` significa puesto en casa, con envío incluido.
 *   3. El cliente nunca envía `user_id`: el servidor lo resuelve del token.
 */

// ─── Primitivas ──────────────────────────────────────────────────────────────

/** Entero en céntimos. Un float aquí es un bug, no una imprecisión. */
export type Cents = number;

/** ISO-8601 UTC con sufijo `Z`. Congelado en A5. */
export type IsoUtc = string;

/** ISO-4217 en mayúsculas (`"EUR"`). P4 lo normaliza a minúsculas para Stripe. */
export type Currency = string;

/**
 * Permite valores desconocidos del servidor sin perder el autocompletado de los
 * conocidos. P2 renderiza lo que llega; un estado nuevo en el backend degrada a
 * una etiqueta genérica en vez de romper la watch list.
 */
type Open<T extends string> = T | (string & {});

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface AuthLoginRequest {
  email: string;
}

export interface AuthLoginResponse {
  token: string;
  user_id: string;
}

/** `GET /auth/me` — valida un token guardado al abrir el panel. */
export interface AuthMeResponse {
  user_id: string;
  email: string;
}

// ─── constraint_schema (P3 → el renderizador genérico de P2) ─────────────────

/**
 * Los cinco tipos que el renderizador proyecta. Esta unión es la frontera
 * completa: el renderizador conmuta por `type` y por nada más. En el momento en
 * que alguien escriba `if (field.key === ...)`, el Beat 2 de la demo deja de ser
 * cierto.
 */
export type ConstraintFieldType = 'enum' | 'bool' | 'money' | 'date' | 'int';

/**
 * `CONTRACTS.md` no fija la forma de `options`. Toleramos ambas para no
 * depender de cómo lo emita P3: una cadena suelta o un par valor/etiqueta.
 */
export type ConstraintOption = string | { value: string; label?: string };

export type ConstraintValue = string | string[] | boolean | number | null;

/** El payload `constraints` de `POST /instructions`, indexado por `field.key`. */
export type ConstraintValues = Record<string, ConstraintValue>;

export interface ConstraintField {
  key: string;
  label: string;
  type: Open<ConstraintFieldType>;
  options?: ConstraintOption[];
  default?: ConstraintValue;

  /**
   * A3: sin este flag, `enum` es selección única y P2 envía un escalar; P1
   * envuelve a lista antes de aplicar el `IN` de la compuerta.
   */
  multiple?: boolean;

  /** Pedidos a P3 como opcionales. Si no llegan, el control no acota. */
  min?: number;
  max?: number;
}

// ─── POST /understand (P3) ───────────────────────────────────────────────────

export interface Canonical {
  name: string;
  brand?: string;
  model?: string;
  generation?: string;
  category?: string;
  variant_axes?: Record<string, unknown>;
  identifiers?: {
    ean?: string;
    gtin?: string;
    mpn?: string;
  };
}

export interface Listing {
  retailer: string;
  price_cents: Cents;
  shipping_cents: Cents;
  total_cents: Cents;
  currency: Currency;
  condition?: string;
  seller_type?: string;
}

/**
 * El subconjunto **congelado** que viaja a P3 (seam de captura, T+0:45).
 * Lo que la UI necesita de más para pintar el esqueleto vive en `PageHints` y
 * se queda en local — ver `sidepanel/utils/domReader.ts`.
 */
export interface DomHints {
  title: string | null;
  price: string | null;
  jsonld: unknown;
}

export interface UnderstandRequest {
  url: string;
  /** Base64 puro, sin prefijo `data:`. JPEG, ancho ≤ 1024 px. Congelado en A5. */
  screenshot_b64: string;
  dom_hints: DomHints;
}

export interface UnderstandResponse {
  canonical: Canonical;
  listing: Listing;
  constraint_schema: ConstraintField[];
  /** 0.0–1.0. Por debajo de 0.7 la UI pregunta en vez de asumir. */
  confidence: number;
}

// ─── POST /discover (P3) ─────────────────────────────────────────────────────

export interface Candidate {
  /** A1: necesario para poder devolverlo en `POST /instructions/:id/substitute`. */
  candidate_id?: string;
  retailer: string;
  url: string;
  ean?: string;
  mpn?: string;
  /** 0.0–1.0. Un EAN que coincide vale 1.0 y no se consulta al modelo. */
  match_confidence: number;
  why: Open<'same EAN' | 'title+spec match'>;
}

export interface DiscoverRequest {
  canonical: Canonical;
  currency: Currency;
  region: string;
}

export interface DiscoverResponse {
  candidates: Candidate[];
}

// ─── Veredictos (P3 escribe, P2 solo los muestra) ────────────────────────────

export type Verdict = Open<'QUALIFIES' | 'REJECTED'>;

// ─── Instrucciones (P1) ──────────────────────────────────────────────────────

/**
 * Los diez estados de la máquina de `CONTRACTS.md`, más `DECLINED`, que aparece
 * como resultado de `POST /checkout`. Pendiente de confirmar con P1 si se
 * persiste como estado de instrucción o solo como intento de cobro — ver A2.
 */
export type InstructionStatus = Open<
  | 'DRAFT'
  | 'ARMED'
  | 'EVALUATING'
  | 'EXECUTING'
  | 'PURCHASED'
  | 'AWAITING_APPROVAL'
  | 'NEEDS_ATTENTION'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'DECLINED'
>;

/** `POST /instructions` — crea y arma. Sin `user_id`: lo resuelve el token. */
export interface CreateInstructionRequest {
  canonical: Canonical;
  constraints: ConstraintValues;
  max_total_cents: Cents;
  currency: Currency;
  /** ≤ 7 días desde ahora. La retención de tarjeta expira ahí. */
  deadline: IsoUtc;
  quantity: number;
  retailers: string[];
}

/** A4: la forma del bloque de fondos que P1 devuelve tras el commit de P4. */
export interface Funds {
  hold_id?: string;
  committed_cents: Cents;
  currency?: Currency;
  expires: IsoUtc;
  status?: Open<'committed' | 'spent' | 'released'>;
}

export interface CreateInstructionResponse {
  instruction_id: string;
  status: InstructionStatus;
  funds: Funds;
}

/** `GET /instructions` — la watch list. Deliberadamente delgado. */
export interface InstructionSummary {
  id: string;
  canonical: Canonical;
  status: InstructionStatus;
  max_total_cents: Cents;
  deadline: IsoUtc;
  last_checked_at: IsoUtc | null;
}

export interface InstructionListResponse {
  instructions: InstructionSummary[];
}

/** A4: el mandato tal y como quedó armado. */
export interface Mandate {
  max_total_cents: Cents;
  currency: Currency;
  deadline: IsoUtc;
  quantity: number;
  retailers: string[];
  constraints: ConstraintValues;
}

export interface OfferRecord {
  offer_id?: string;
  retailer: string;
  total_cents: Cents;
  verdict: Verdict;
  /** Se muestra al usuario **literal**. No lo reescribas en la UI. */
  reason: string;
  at: IsoUtc;
}

/** A1: sin esto, la Approval Card no tiene ni texto ni `candidate_id` que devolver. */
export interface PendingAlternative {
  candidate_id: string;
  offer_id: string;
  retailer: string;
  total_cents: Cents;
  /** Positivo = más caro que el techo. Entero en céntimos. */
  delta_cents: Cents;
  what_changes: string;
}

/**
 * A2: dónde vive el Beat final. El rechazo de €465 es de Stripe, no un veredicto
 * de P3 ni un `if` nuestro, y el log de auditoría tiene que poder decirlo.
 */
export interface CheckoutAttempt {
  offer_id: string;
  retailer: string;
  attempted_cents: Cents;
  status: Open<'PURCHASED' | 'NEEDS_ATTENTION' | 'DECLINED' | 'FAILED'>;
  decline_reason?: string;
  /** `"stripe"` cuando el techo lo impuso la capa de pago y no nuestro código. */
  enforced_by?: string;
  message?: string;
  at?: IsoUtc;
}

export interface Purchase {
  total_cents: Cents;
  retailer: string;
  order_ref: string;
  at: IsoUtc;
}

/** `GET /instructions/:id` — todo lo que renderiza el detalle. */
export interface InstructionDetail {
  id?: string;
  status: InstructionStatus;
  mandate: Mandate;
  funds: Funds;
  offers: OfferRecord[];
  purchase?: Purchase;
  pending_alternative?: PendingAlternative;
  last_checkout_attempt?: CheckoutAttempt;
  /** Aditivo: ahorra un join en la UI al abrir el detalle desde la lista. */
  canonical?: Canonical;
  last_checked_at?: IsoUtc | null;
}

export interface SubstituteRequest {
  candidate_id: string;
  approved: boolean;
}

export interface SubstituteResponse {
  status: InstructionStatus;
  accepted_alternatives: string[];
}

export interface CancelResponse {
  status: InstructionStatus;
  released_cents: Cents;
}
