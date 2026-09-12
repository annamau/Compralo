# P2 → P1/P3: Contract Amendments & Clarifications (Freeze at T+1:00)

Este documento recoge los ajustes críticos de contrato detectados por **P2 (Extension)** necesarios para que la UI, la Approval Card y el Decision Log funcionen sin fricciones antes del freeze de **T+2:00**.

---

## 1. [A1] Approval Card: Exponer `candidate_id` y `pending_alternative`

**Problema:**
* `POST /instructions/:id/substitute` requiere `{ candidate_id, approved }`.
* Sin embargo, `/adjudicate` devuelve `alternative: { is_credible_substitute, delta_cents, what_changes }` **sin `candidate_id`**.
* `GET /instructions/:id` devuelve `offers` sin `candidate_id` ni el bloque `alternative`. P2 no puede renderizar la tarjeta de aprobación ni saber qué `candidate_id` enviar.

**Solución acordada para P1:**
En `GET /instructions/:id`, cuando el estado sea `AWAITING_APPROVAL`, incluir el bloque:
```json
{
  "status": "AWAITING_APPROVAL",
  "pending_alternative": {
    "candidate_id": "cand_123",
    "offer_id": "off_456",
    "retailer": "mediamarkt",
    "total_cents": 27000,
    "delta_cents": 2000,
    "what_changes": "PS5 Slim 2TB en lugar de 1TB, mismo vendedor"
  }
}
```
Y asegurar que P3 incluya `candidate_id` en el contexto o payload de `/adjudicate`.

---

## 2. [A2] El Beat 4 (Rechazo de Stripe `amount_too_large`) en `GET /instructions/:id`

**Problema:**
* El fixture 4 (€465) califica por producto pero **es rechazado por Stripe en checkout** (`amount_too_large`).
* Como el rechazo de Stripe ocurre en el checkout (P4), no es un `verdict` de P3 (`QUALIFIES`/`REJECTED`).
* Para que la UI pueda pintar en el log de auditoría el motivo literal de Stripe:
  > *"Stripe: DECLINED — amount_too_large (enforced by payment layer)"*

**Solución acordada para P1:**
En `GET /instructions/:id`, exponer los intentos de checkout fallidos en una lista o en `last_checkout_attempt`:
```json
{
  "status": "ARMED",
  "last_checkout_attempt": {
    "offer_id": "off_789",
    "retailer": "mediamarkt",
    "attempted_cents": 46500,
    "status": "DECLINED",
    "decline_reason": "amount_too_large",
    "enforced_by": "stripe",
    "message": "Capture amount exceeds authorized mandate hold"
  }
}
```

---

## 3. [A3] Multiplicidad de `enum` y normalización en la Gate

**Problema:**
* La compuerta de P1 evalúa `resolved.condition IN instruction.constraints.condition` (espera un array).
* Si P3 emite un campo `type: 'enum'`, P2 renderizará un segmented control de selección única por defecto.

**Solución acordada:**
* P2 renderizará **selección única** por defecto enviando el valor escalar (`"new"`).
* Si P3 añade `multiple: true` en el campo del `constraint_schema`, P2 permitirá selección múltiple enviando `["new", "refurbished"]`.
* P1 normaliza internamente: si recibe un escalar `"new"`, lo envuelve a `["new"]` antes de aplicar el operador `IN`.

---

## 4. [A4] Forma formal de `mandate` y `funds` en `GET /instructions/:id`

Para evitar campos opacos en TypeScript:
```json
{
  "mandate": {
    "max_total_cents": 25000,
    "currency": "EUR",
    "deadline": "2026-09-19T12:00:00Z",
    "quantity": 1,
    "retailers": ["amazon", "mediamarkt", "pccomponentes"],
    "constraints": {
      "edition": "digital",
      "condition": "new"
    }
  },
  "funds": {
    "hold_id": "pi_12345",
    "committed_cents": 25000,
    "currency": "EUR",
    "expires": "2026-09-19T12:00:00Z",
    "status": "committed"
  }
}
```

---

## 5. [A5] Formatos Congelados

1. **Fechas (`deadline`, `expires`, `at`):** ISO-8601 UTC con sufijo `Z` (ej. `"2026-09-19T12:00:00Z"`).
2. **Moneda (`currency`):** Código ISO-4217 en mayúsculas `"EUR"`. P4 normaliza a `"eur"` en sus llamadas a Stripe.
3. **Screenshot (`screenshot_b64`):** Cadena base64 pura sin prefijo `data:image/jpeg;base64,`. Imagen JPEG comprimida con ancho ≤ 1024px.
4. **Idempotency Key:** Generado siempre como `purchase_{instruction_id}`.
