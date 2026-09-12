# Cómpralo

**Órdenes límite para productos de todos los días.** El comprador expresa una
intención persistente — *"compra esta PS5 cuando haya stock por menos de 450 €
puesto en casa"* — cierra el navegador, y un agente la ejecuta.

> **Regla de oro:** la IA gestiona la ambigüedad (entender qué es el producto).
> El software determinista gestiona el dinero (evaluar precios, retenciones y compras).

Empieza por [docs/product.md](docs/product.md) para la tesis, y por
[docs/CONTRACTS.md](docs/CONTRACTS.md) antes de escribir una línea de código.

---

## Las cuatro superficies

Un directorio por superficie despligable. Los carriles del equipo (P1–P4) son
organización de personas; las carpetas se nombran por lo que son.

| Dir | Carril | Qué es | Stack | Puerto |
|-----|--------|--------|-------|--------|
| [`backend/`](backend/) | P1 Core | API, cola de chequeo, worker, compuerta determinista, state machine | Rust (Axum + SQLite) | `:3000` |
| [`extension/`](extension/) | P2 Extension | Side panel, captura, login, renderizador genérico, watch list | Chrome MV3 (React + Vite) | Vite dev |
| [`intelligence/`](intelligence/) | P3 Intelligence | `/understand`, `/discover`, `/adjudicate` | por decidir | `:5000` |
| [`money/`](money/) | P4 Money | Retención de mandato, captura, release | Node + Express + Stripe | `:4242` |

**Frontera que sostiene el producto:** P1 nunca llama a un modelo. P3 nunca toca
el mandato. P4 no valida el techo — deja que Stripe lo rechace.

## Artefactos compartidos por las cuatro superficies

| Dir | Dueño | Qué hay | Congela |
|-----|-------|---------|---------|
| [`mocks/`](mocks/) | P1 (+P3) | Respuestas estáticas por endpoint. **Fuente única** — ningún cliente las duplica. | T+0:15 / T+0:20 |
| [`fixtures/`](fixtures/) | P3 | `offers.json`: las cuatro ofertas de la demo | T+2:45 |

## Cómo se levanta cada pieza

```bash
# P1 — backend
cd backend && cargo run -p server

# P4 — money (requiere STRIPE_SECRET_KEY de test)
cd money && npm install && npm start

# P4 — dispara las cuatro ofertas de la demo contra una instancia viva
cd money && npm run fixtures

# P2 — extensión (carga dist/ como extensión desempaquetada en Chrome)
cd extension && npm install && npm run dev
```

Copia `.env.example` a `.env` en la raíz y rellena solo lo de tu carril.

## Mapa de documentación

| Documento | Para qué |
|-----------|----------|
| [docs/product.md](docs/product.md) | La tesis completa: problema, producto, mercado, demo |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | **P1 es el dueño.** Endpoints, esquemas, la compuerta, mocks, fixtures |
| [docs/P1_P3_CONTRACT_REQUESTS.md](docs/P1_P3_CONTRACT_REQUESTS.md) | Enmiendas al contrato pedidas por P2 a P1/P3 antes del freeze |
| [docs/BOARD.md](docs/BOARD.md) | Hitos, seams de integración, el reloj, los beats de la demo |
| [docs/PAYMENTS.md](docs/PAYMENTS.md) | Modelo de retención en Stripe y por qué `amount_too_large` debe verse |
| [docs/backend.md](docs/backend.md) | Cómo se ejecuta y se usa el backend Rust *(llega con la rama de P1)* |
| [docs/scopes/](docs/scopes/) | Qué posee y qué no posee cada carril |
| [docs/plans/](docs/plans/) | Planes de implementación y contexto de handoff por carril |

## Tres reglas que cruzan todos los lenguajes

1. **El dinero es enteros en céntimos.** Nunca un float, en ningún sitio.
2. **`total_cents` significa siempre puesto en casa.** Un precio sin envío no es un precio.
3. **El plazo máximo es 7 días.** Las autorizaciones de tarjeta expiran ahí.

## Backend (Rust) — P1

The monitoring/execution core is a Cargo workspace at the repo root (`Cargo.toml`, `backend/crates/*`). See [backend/README.md](backend/README.md) to run it, and `Dockerfile` / `compose.yaml` / `deploy/gcp-startup.sh` to deploy it.
