/**
 * Tipos del wire del backend Rust de `origin/rusty`, **tal cual son**.
 *
 * Este fichero no traduce nada. Es el espejo fiel del otro lado: `snake_case`,
 * `*_minor` en vez de `*_cents`, y `null` exactamente donde el `Option<T>` de
 * Rust lo permite. Toda la divergencia contra `docs/CONTRACTS.md` vive en
 * `monitorsAdapter.ts`; si algo de aquí se parece a nuestro contrato es
 * coincidencia, no diseño.
 *
 * Verificado leyendo el fuente, no la documentación (commit `origin/rusty`):
 *   - `backend/crates/domain/src/lib.rs`        → Monitor, NormalizedOffer, MonitorStatus
 *   - `backend/crates/rule-engine/src/lib.rs`   → EvaluationDecision, RejectionReason
 *   - `backend/crates/persistence/src/lib.rs`   → MonitorEvent y los payloads de evento
 *   - `backend/crates/server/src/lib.rs`        → rutas y cuerpos de petición
 *
 * Los nombres JSON salen de los `#[derive(Serialize, Deserialize)]` y de los
 * atributos `#[serde(...)]` que los acompañan, que es lo único que manda.
 */

/**
 * Entero en unidad mínima de la divisa. Mismo concepto que `Cents` de
 * `api.types.ts` — solo cambia el nombre del campo en el wire, nunca la escala.
 */
export type MinorUnits = number;

/** RFC 3339 UTC, tal como serializa `chrono::DateTime<Utc>`. */
export type BackendTimestamp = string;

/** UUID en cadena, tal como serializa `uuid::Uuid`. */
export type BackendUuid = string;

/**
 * Igual que el `Open<T>` de `api.types.ts`: acepta valores que el backend
 * empiece a emitir mañana sin perder el autocompletado de los de hoy.
 */
type Open<T extends string> = T | (string & {});

// ─── Producto y restricciones ────────────────────────────────────────────────

/** `domain::ProductCondition`, `#[serde(rename_all = "snake_case")]`. */
export type BackendProductCondition = 'new' | 'refurbished' | 'used' | 'unknown';

/**
 * `domain::CanonicalProduct`. Sin `rename_all`, así que los nombres son los del
 * struct. `identifiers` es un `HashMap<String,String>`: siempre presente,
 * posiblemente vacío, nunca `null`.
 */
export interface CanonicalProductWire {
  name: string;
  brand: string | null;
  model: string | null;
  identifiers: Record<string, string>;
}

/**
 * `domain::PurchaseConstraints`. Aquí vive el techo de gasto que el
 * `rule-engine` aplica de verdad, dos veces (al observar y al revalidar).
 */
export interface PurchaseConstraintsWire {
  maximum_total_minor: MinorUnits;
  currency: string;
  condition: BackendProductCondition | null;
  /** `HashMap<String,String>`: ejes de variante exigidos, todos obligatorios. */
  variants: Record<string, string>;
  bundles_allowed: boolean;
  /** Vacío significa «cualquier tienda», no «ninguna». */
  approved_retailers: string[];
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

/**
 * `domain::MonitorStatus`, `#[serde(rename_all = "snake_case")]`.
 *
 * Los ocho existen en el enum, pero solo seis son observables hoy: ningún
 * `SET status=` de `persistence` escribe `evaluating`, y `fail_execution`
 * escribe `active` o `payment_required`, nunca `failed`. Se tipan los ocho
 * igualmente porque el enum los declara y podrían empezar a escribirse.
 */
export type MonitorStatusWire = Open<
  | 'active'
  | 'evaluating'
  | 'executing'
  | 'purchased'
  | 'payment_required'
  | 'failed'
  | 'expired'
  | 'cancelled'
>;

/** `domain::Monitor`. `url` es un `url::Url`, que serializa como cadena. */
export interface MonitorWire {
  id: BackendUuid;
  url: string;
  /** `Option<CanonicalProduct>`: `null` hasta que el primer scrape fija la línea base. */
  product: CanonicalProductWire | null;
  constraints: PurchaseConstraintsWire;
  deadline: BackendTimestamp;
  status: MonitorStatusWire;
  check_interval_seconds: number;
  created_at: BackendTimestamp;
}

/**
 * `domain::NormalizedOffer`.
 *
 * Cuidado con la asimetría: aquí `product` **no** es `Option`, al contrario que
 * en `Monitor`. Los importes, la divisa y el estado sí lo son, y un `null` en
 * `total_minor` es lo normal en una página real (solo se calcula cuando el
 * JSON-LD trae precio *y* gastos de envío).
 */
export interface NormalizedOfferWire {
  product: CanonicalProductWire;
  /** Hostname sin `www.`, derivado de la URL final, no un nombre comercial. */
  retailer: string;
  available: boolean;
  item_price_minor: MinorUnits | null;
  shipping_minor: MinorUnits | null;
  /** Puesto en casa. `null` cuando falta precio o envío: un precio sin envío no es un precio. */
  total_minor: MinorUnits | null;
  currency: string | null;
  condition: BackendProductCondition | null;
  variants: Record<string, string>;
  source_url: string;
  checked_at: BackendTimestamp;
}

// ─── Decisión del rule-engine ────────────────────────────────────────────────

/** Códigos de rechazo sin payload: en el wire son cadenas sueltas. */
export type PlainRejectionCode = Open<
  | 'monitor_not_active'
  | 'deadline_expired'
  | 'product_mismatch'
  | 'bundle_not_allowed'
  | 'condition_mismatch'
  | 'retailer_not_approved'
  | 'out_of_stock'
  | 'currency_unknown'
  | 'currency_mismatch'
  | 'item_price_unknown'
  | 'shipping_unknown'
  | 'total_unknown'
>;

export interface TotalAboveMaximumDetail {
  maximum: MinorUnits;
  actual: MinorUnits;
}

export interface VariantMismatchDetail {
  key: string;
  expected: string;
  /** `null` cuando la oferta simplemente no publica ese eje. */
  actual: string | null;
}

/**
 * `rule_engine::RejectionReason`, enum externamente etiquetado con
 * `#[serde(rename_all = "snake_case")]`.
 *
 * De ahí la forma mixta: **las variantes unitarias viajan como cadena y las dos
 * que llevan datos como objeto de una sola clave.** `API.md` las lista todas
 * como cadenas planas y en eso `API.md` se equivoca.
 */
export type RejectionReason =
  | PlainRejectionCode
  | { total_above_maximum: TotalAboveMaximumDetail }
  | { variant_mismatch: VariantMismatchDetail };

/**
 * `rule_engine::EvaluationDecision`.
 *
 * El atributo real es `#[serde(tag = "result", content = "reasons", rename_all =
 * "snake_case")]`, es decir **adyacentemente** etiquetado, no internamente como
 * dice la referencia. El JSON resultante coincide con sus ejemplos
 * (`{"result":"qualified"}` y `{"result":"rejected","reasons":[…]}`) porque
 * `Qualified` es una variante unitaria y serde omite el contenido; la distinción
 * importa si mañana `Qualified` pasa a llevar datos.
 */
export type EvaluationDecisionWire =
  | { result: 'qualified' }
  | { result: 'rejected'; reasons: RejectionReason[] };

// ─── Log de eventos ──────────────────────────────────────────────────────────

/** Todos los `kind` que emite el código, de `append_event` / `append_event_tx`. */
export type MonitorEventKind = Open<
  | 'monitor_created'
  | 'initial_offer_observed'
  | 'product_baseline_established'
  | 'offer_evaluated'
  | 'monitor_check_failed'
  | 'payment_authorized'
  | 'execution_started'
  | 'purchase_confirmed'
  | 'payment_required'
  | 'execution_failed'
  | 'qualified_offer_not_executed'
  | 'monitor_cancelled'
  | 'monitor_expired'
>;

/**
 * `persistence::MonitorEvent`. `payload` se deja en `unknown` a propósito: su
 * forma depende de `kind` y el JSON de red no es de fiar hasta que alguien lo
 * estrecha. Los lectores están en `monitorsAdapter.ts`.
 */
export interface MonitorEventWire {
  /** Entero autoincremental, no UUID. Es también el `id` del evento SSE. */
  id: number;
  monitor_id: BackendUuid;
  kind: MonitorEventKind;
  payload: unknown;
  created_at: BackendTimestamp;
}

// ─── Payloads de evento (uno por `kind`) ─────────────────────────────────────

export interface MonitorCreatedPayload {
  url: string;
}

export interface InitialOfferObservedPayload {
  /** El único sitio del log donde viaja el cuerpo completo de una oferta. */
  offer: NormalizedOfferWire;
}

export interface ProductBaselineEstablishedPayload {
  product: CanonicalProductWire;
}

export interface OfferEvaluatedPayload {
  /**
   * Fila de la tabla `offers`, que **ninguna ruta HTTP expone**. Es un id de
   * correlación opaco: no se puede resolver a un cuerpo de oferta.
   */
  offer_id: BackendUuid;
  decision: EvaluationDecisionWire;
}

/** `monitor_check_failed`, `payment_required`, `execution_failed` y `qualified_offer_not_executed`. */
export interface ErrorPayload {
  /** `Display` del error de Rust, en inglés. Ver `describeBackendError`. */
  error: string;
}

export interface PaymentAuthorizedPayload {
  authorization_id: BackendUuid;
  maximum_minor: MinorUnits;
  currency: string;
}

export interface ExecutionStartedPayload {
  attempt_id: BackendUuid;
}

export interface PurchaseConfirmedPayload {
  /** Id del pedido en el comercio. No trae importe: el total no está en el log. */
  order_id: string;
}

// ─── Cuerpos de petición y respuesta ─────────────────────────────────────────

/**
 * `server::CreateMonitorRequest`.
 *
 * `url` es obligatoria y el servidor la valida contra SSRF: solo http(s), sin
 * credenciales embebidas y con host público — **`localhost` está prohibido**.
 * `check_interval_seconds` tiene `#[serde(default)]` a 60 y se exige en [10, 86400].
 */
export interface CreateMonitorRequestWire {
  url: string;
  product: CanonicalProductWire | null;
  constraints: PurchaseConstraintsWire;
  deadline: BackendTimestamp;
  check_interval_seconds?: number;
}

/** `POST /v1/monitors/{id}/payment-authorizations`. */
export interface PaymentAuthorizationRequestWire {
  /** Tiene que cubrir `constraints.maximum_total_minor`, o el servidor da 400. */
  maximum_minor: MinorUnits;
  currency: string;
}

/** `server::IdResponse` — lo único que devuelve la autorización de pago. */
export interface IdResponseWire {
  id: BackendUuid;
}

/** Forma única de error del servicio: `{"error": "..."}` con 400/404/409/500. */
export interface BackendErrorWire {
  error: string;
}

/** `POST /v1/demo/scenarios/{scenario}`. Selección **global al proceso**, no por monitor. */
export type DemoScenario =
  | 'success'
  | 'payment_required'
  | 'declined'
  | 'timeout_before_order'
  | 'timeout_after_order';
