# CONTEXTO MAESTRO PARA CLAUDE CODE: P2 (CHROME EXTENSION UI)

> **Documento de Handoff y Alineación Técnica**
> **Proyecto:** Cómpralo — Agente de Compras con Órdenes Límite (*"Limit orders for everyday products"*)
> **Rol Asignado:** **P2 — Extension Developer** (Interfaz Chrome MV3, Captura, Login, Renderizador Dinámico y Watchlist)
> **Tiempo total del proyecto:** 4 horas (Hackathon MVP). Foco absoluto en el spine de la demo y cero sobreingeniería.

---

## 1. Tesis del Producto y Regla de Oro

* **La Tesis:** Los compradores habituales ya saben lo que quieren, pero pierden ante bots y falta de tiempo. Cómpralo traslada el concepto de *órdenes límite* de Wall Street al e-commerce: *"Compra esta PS5 cuando haya stock por menos de 450€ puesto en casa. Cierra el navegador y el agente se encarga"*.
* **La Regla de Oro:**
  > **"La IA gestiona la ambigüedad (entender qué es el producto). El software determinista gestiona el dinero (evaluar precios, retenciones y compras)."**

---

## 2. Mapa del Equipo y Límites de Responsabilidad (Scopes)

El proyecto está dividido en 4 carriles paralelos estrictos documentados en el repositorio:

| Lane | Responsable | Superficie | Qué posee | Qué NO debe tocar |
| :--- | :--- | :--- | :--- | :--- |
| **P1** | Core | Rust API + Workers | Backend, cola de chequeo, compuerta determinista, state machine, contratos (`CONTRACTS.md`). | **No llama a la IA** ni procesa pagos. |
| **P2** | **Extension (TÚ / CLAUDE CODE)** | **Chrome MV3** | **Shell MV3, Side Panel, Login/Auth, captura de pantalla, skeleton <200ms, renderizador genérico de esquema, formulario de mandato y lista de órdenes.** | **No inventa los controles** (vienen de P3), no evalúa ofertas ni toca la pasarela de pagos. |
| **P3** | Intelligence | Modelos + Exa | Screenshot → `/understand` (genera `constraint_schema`), `/discover` (cross-store), `/adjudicate` (veredicto de hechos). | **No decide si se compra**. Solo devuelve hechos. |
| **P4** | Money | Stripe (`money/`) | Retención de mandato (*mandate hold*), captura manual, límite bancario (`amount_too_large`). | No valida antes de Stripe. Deja que Stripe aplique el techo. |

---

## 3. Las 5 Reglas Inquebrantables para P2 (Extension)

Claude Code debe tener estas directrices grabadas en piedra al generar o modificar código:

### 1. Regla de Frontera: NUNCA hacer branching por `key`
* **PROHIBIDO:** `if (field.key === "generation") { ... }` o `if (field.key === "size")`.
* **OBLIGATORIO:** El formulario dinámico se renderiza **estrictamente por `type`**:
  * `enum` → Segmented control / botones pill.
  * `bool` → Toggle switch.
  * `money` → Input monetario en centavos.
  * `date` → Date picker (validando siempre ≤ 7 días).
  * `int` → Stepper numérico (+ / -).
* *Por qué:* El "Beat 2" de la demo ante los jueces es demostrar que **nadie hardcodeó el formulario**: la IA envió un esquema abstracto y la extensión lo proyectó genéricamente.

### 2. El dinero se maneja en centavos enteros (`cents`)
* Nunca usar `floats` para importes monetarios. Siempre enteros: `max_total_cents`, `price_cents`, `shipping_cents`, `total_cents`.
* `total_cents` siempre significa **puesto en casa (con envío incluido)**. Un precio sin envío no es un precio.

### 3. Skeleton instantáneo en < 200 ms (Emoción de la Demo)
* Al abrir la extensión o iniciar orden, extraer metadatos locales del DOM (OpenGraph / JSON-LD / Título) y pintar inmediatamente un esqueleto visual con thumbnail y título.
* Cero spinners vacíos. La llamada pesada a `/understand` llega después y actualiza la tarjeta con una animación sutil.

### 4. Flujo de Autenticación (`Bearer <token>`) y Manejo de 401
* Toda petición lleva `Authorization: Bearer <token>`.
* El login se realiza contra `POST /auth/login { email }` devolviendo `{ token, user_id }`.
* Si cualquier petición devuelve **HTTP 401**, la extensión **NO debe fallar en silencio**: debe limpiar el token y re-solicitar el login en la UI.

### 5. Plazo de Orden: Máximo 7 Días
* Las autorizaciones bancarias de Stripe (*mandate hold*) expiran a los ~7 días. Las órdenes de la demo no pueden superar los 7 días.

---

## 4. Las Dos Pantallas Clave de la UI

La extensión opera en el **Side Panel de Chrome** (`chrome.sidePanel`) con navegación por pestañas:

### Vista A: "Nueva Orden" (Creación del Mandato)
1. **Captura:** Disparo de `chrome.tabs.captureVisibleTab` (reescalado a max 1024px, JPEG 70%).
2. **Tarjeta de Producto:** Skeleton <200ms que actualiza a los datos canónicos de la IA.
3. **Controles Genéricos:** Proyección de hasta 5 campos de `constraint_schema`.
4. **Tiendas Aprobadas:** Toggles de tiendas descubiertas vía `/discover` (Amazon, MediaMarkt, etc.).
5. **Techo de Mandato:** Input de `max_total_cents` con checkbox *"Incluir envío"* activo.
6. **Botón de Acción:** *"Autorizar retención en Stripe y Armar Agente"*.

### Vista B: "Mis Órdenes" (Watch List y Auditoría)
1. **Tarjetas de Órdenes:** Estados `ARMED`, `EVALUATING`, `PURCHASED`, `DECLINED`, `FAILED`.
2. **Tarjeta Especial `AWAITING_APPROVAL`:** Cuando se detecta un sustituto creíble (ej: versión de 2TB por +20€), muestra qué cambia, la diferencia en `delta_cents`, y botones de **[Aprobar]** o **[Declinar]**.
3. **Log de Decisiones Transparente:** Muestra las razones literales de descarte de ofertas (las 4 ofertas de `fixtures/offers.json`):
   * *219€ → Descartado: Generación anterior con título casi idéntico.*
   * *244€ + envío (total 282€) → Descartado: Supera el techo de 250€.*
   * *465€ → DECLINED: Rechazado por la pasarela de pagos (`amount_too_large`).*
   * *248€ → QUALIFIES: Compra ejecutada con éxito.*

---

## 5. Estrategia de Implementación Desacoplada (`VITE_MOCK=true`)

Para que Claude Code pueda implementar y probar la UI de inmediato sin esperar a que P1 levante el backend ni P4 configure la pasarela:
* Toda la comunicación de red pasa por `src/services/apiClient.ts`.
* Por defecto, la extensión incluye un mock server local / fixtures JSON basados fielmente en los contratos de `CONTRACTS.md`.
* Conmutar a backend real será tan sencillo como cambiar `VITE_MOCK=false` y definir `VITE_API_URL`.

---

## 6. Documentos de Referencia Obligatoria en el Repositorio

1. **`docs/CONTRACTS.md`:** Especificación exacta de endpoints (`POST /understand`, `POST /instructions`, etc.) y esquemas JSON.
2. **`docs/BOARD.md`:** Cronograma de hitos, los 6 beats de la demo y los congelamientos de contratos.
3. **`docs/PAYMENTS.md`:** Detalles del modelo de retención de mandato en Stripe y por qué `amount_too_large` debe ser visible.
4. **`docs/scopes/P2-extension.md`:** Lista de tareas y checklist oficial de P2.
5. **`docs/plans/IMPLEMENTATION_PLAN_P2.md`:** Plan de implementación técnico paso a paso con los componentes y arquitectura de archivos.
