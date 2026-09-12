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

---

## 6. [A6] `constraint_schema` no debe emitir los campos universales

**Problema:**
El techo (`max_total_cents`), el plazo (`deadline`), la cantidad (`quantity`) y las
tiendas (`retailers[]`) son campos **raíz** de `POST /instructions` y tienen su
propio sitio en el formulario de mandato de P2. Si `/understand` también los
emite dentro de `constraint_schema`, aparecen **dos veces** en pantalla: una como
control genérico y otra como campo del mandato.

**Por qué P2 no puede arreglarlo en el cliente:**
La solución obvia sería filtrar por clave en el renderizador — descartar los
campos cuya `key` sea `price`, `condition`, `deadline`, `quantity`, `retailer`…
**Eso es exactamente `if (field.key === ...)`, y mata el Beat 2.** Un juez que
abra el fichero y vea una lista de claves descartadas tiene razón al concluir que
el formulario sí estaba programado a mano.

Así que el solape se resuelve en el **productor**, no en el consumidor.

**Solución pedida a P3:**
Añadir al prompt de `/understand` una regla explícita en esta línea:

> Nunca produzcas controles para precio, techo, condición de pago, tienda,
> cantidad, envío como campo de mandato, ni plazo. La aplicación tiene campos
> universales para todo eso. Los controles que emitas describen **qué cuenta como
> este producto**, no qué está dispuesto a pagar el usuario.

Mientras esa regla no esté, P2 **pintará todo lo que llegue**, incluido lo
redundante. Un control duplicado en pantalla es un bug menor; un filtro por clave
es una violación de la tesis del producto. No se va a añadir el filtro.

Nota relacionada: un campo `type: 'money'` que llegue en el esquema se trata como
una restricción ordinaria y va dentro de `constraints` (p. ej. "envío máximo
aceptable"), no como el techo del mandato. Eso ya está decidido y es coherente
con lo anterior.

---

## 7. [A7] La redacción de `reason`: instrucción concreta para el prompt de P3

**Contexto:**
`CONTRACTS.md` ya dice que `reason` *"is shown to the user verbatim and read
aloud on stage. It must sound like a sharp friend catching a near-miss, not a
validation error."* Es el requisito correcto, pero está expresado como intención,
no como instrucción operativa para un modelo.

**Solución pedida a P3:** llevar el requisito al prompt de `/adjudicate` en forma
imperativa y verificable. Tres reglas, y la primera es la que importa:

1. **`reason`**: una sola frase, máximo ~160 caracteres, que diga de qué elemento
   tomaste el precio, qué te indicó el estado de stock, y nombre cualquier coste
   oculto que hayas encontrado. **Escríbela como una frase llana que una persona
   diría en voz alta, no como un error de formulario. Se muestra al usuario
   literal.**
2. **`resolved.hidden_costs`**: cada cargo obligatorio más allá de precio y envío
   que el comprador solo descubre después — gestión, aduanas, seguro obligatorio,
   recargo por tarjeta, "protección" premarcada en la cesta. **Etiqueta cada uno
   con las palabras de la propia tienda.**
3. Cualquier texto de disponibilidad, **citado literal** de la página, máximo 100
   caracteres.

**Por qué las palabras importan tanto:** que el motivo suene a persona se
consigue porque **las palabras vienen de la tienda, no de nuestro validador**. Un
motivo compuesto en código a partir de códigos de check produce cosas como
`variant:edition (edition is disc, want digital)`, que leído ante un jurado es un
mensaje de compilador.

**Ejemplos del tono buscado**, para calibrar:

> MediaMarkt lo anuncia a 244,00 € pero en el checkout añade una protección
> obligatoria de 38,00 € — el total real puesto en casa es 282,00 €.

> Este anuncio es la generación anterior con un título casi idéntico: el modelo
> es el CFI-1216, no el Slim.

> PcComponentes lo tenía a 440,00 € y en el checkout pide 470,00 € — abortado, no
> se ha cobrado nada, sigo vigilando.

El patrón de los tres: **hecho → consecuencia → qué NO ha pasado / sigo
trabajando.** Ese cierre tranquilizador es lo que separa un agente que da
confianza de uno que da miedo.
