# Product intelligence implementation

The running AI reader is in [`autobuy/packages/backend`](../autobuy/packages/backend), implemented in TypeScript. This directory contains scope documentation, not a second service.

- HTTP endpoint: `src/index.ts`, `POST /understand` with `{url, html, screenshot?}`.
- Product extraction and controls: `src/ai.ts` and `src/claude.ts`.
- OpenRouter/Anthropic providers: `src/llm.ts`.
- Usage and request audit: `src/audit.ts`, persisted in `/app/data/audit.jsonl`.
- Container: [`deploy/Dockerfile.backend`](../deploy/Dockerfile.backend), Compose service `backend`, port 3000, `INTELLIGENCE_ONLY=true`.

Rust owns orders and monitoring. See [`deploy/HACKATHON.md`](../deploy/HACKATHON.md) for deployment and acceptance checks.

---

## Original scope (not a list of implemented endpoints)

# intelligence/ — P3

Todo lo derivado del screenshot: comprensión, metadatos y descubrimiento del
mismo producto en otras tiendas vía Exa.

**Alcance completo: [`docs/scopes/P3-intelligence.md`](../docs/scopes/P3-intelligence.md).**
Contrato de endpoints: [`docs/CONTRACTS.md § P3`](../docs/CONTRACTS.md).

## Superficie

| Endpoint | Entra | Sale |
|----------|-------|------|
| `POST /understand` | url, screenshot_b64, dom_hints | producto canónico, economía del listing, `constraint_schema` |
| `POST /discover` | producto canónico | el mismo producto en otras tiendas + `match_confidence` |
| `POST /adjudicate` | una oferta normalizada | veredicto y hechos resueltos |

## Frontera

> **Devuelves hechos y confianza, nunca "compra".**

No lees `max_total_cents`. No cualificas ofertas contra un mandato — eso es la
compuerta determinista de P1. No llamas a ninguna API de pago. No decides UI:
emites un esquema y P2 lo proyecta genéricamente por `type`.

## Pendiente de decidir

- **Stack** (Node + TypeScript o Python). Nada más arriba lo presupone.
- Puerto propuesto: `:5000` (ver [`README.md`](../README.md) de la raíz).
- Mocks a `../mocks/` a T+0:20 — antes de escribir código real.
