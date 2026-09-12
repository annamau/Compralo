/**
 * Backend simulado del panel, para `VITE_MOCK=true`.
 *
 * Lee los JSON de `mocks/` y `fixtures/` de la **raíz del monorepo** por alias
 * de build. Ninguna copia dentro de `src/`: cuando P1 y P3 sobrescriban los
 * suyos, esto los recoge sin tocar una línea. Ver `mocks/README.md`.
 *
 * Mantiene estado mutable en memoria (órdenes creadas, cancelaciones,
 * aprobaciones de sustituto) para que la extensión sea interactiva de verdad
 * offline, no una galería de pantallazos. El estado se pierde al cerrar el
 * panel, y eso está bien: el estado real vive en el servidor de P1.
 */

import discoverMock from '@mocks/discover.json';
import instructionsMock from '@mocks/instructions.json';
import understandMock from '@mocks/understand.json';
import { ApiError, type HttpMethod } from './http';
import type {
  AuthLoginResponse,
  AuthMeResponse,
  CancelResponse,
  CreateInstructionRequest,
  CreateInstructionResponse,
  DiscoverResponse,
  InstructionDetail,
  InstructionListResponse,
  InstructionSummary,
  SubstituteResponse,
  UnderstandResponse,
} from './api.types';
import type { StoredSession } from './storage';

// Los mocks son datos, no tipos: se afirma la forma una sola vez, aquí.
const UNDERSTAND = understandMock as unknown as UnderstandResponse;
const DISCOVER = discoverMock as unknown as DiscoverResponse;
const SEED = instructionsMock as unknown as {
  instructions: InstructionSummary[];
  details: Record<string, InstructionDetail>;
};

/**
 * Latencias deliberadas, no adornos. `/understand` tarda de verdad, y el panel
 * tiene que verse bien durante esos 1,4 s: es exactamente la ventana que el
 * esqueleto de 3 fases existe para cubrir.
 */
const LATENCY_MS = {
  login: 220,
  me: 120,
  understand: 1400,
  discover: 900,
  list: 160,
  detail: 180,
  arm: 700,
  mutate: 380,
} as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─── Estado mutable ──────────────────────────────────────────────────────────

const clone = <T>(value: T): T => structuredClone(value);

let summaries: InstructionSummary[] = clone(SEED.instructions ?? []);
let details: Record<string, InstructionDetail> = clone(SEED.details ?? {});

function nextId(): string {
  return `inst_${Date.now().toString(36)}${Math.floor(Math.random() * 1e3).toString(36)}`;
}

function requireSession(session: StoredSession | null): StoredSession {
  if (!session?.token) {
    // El mismo 401 que daría P1: la puerta de login es real incluso offline.
    throw new ApiError(401, 'Sesión caducada');
  }
  return session;
}

function requireDetail(id: string): InstructionDetail {
  const detail = details[id];
  if (!detail) throw new ApiError(404, `No existe la instrucción ${id}`);
  return detail;
}

function patchSummary(id: string, patch: Partial<InstructionSummary>): void {
  summaries = summaries.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/** Solo para pruebas manuales: devuelve el mock a su estado de partida. */
export function resetMockStore(): void {
  summaries = clone(SEED.instructions ?? []);
  details = clone(SEED.details ?? {});
}

// ─── Enrutado ────────────────────────────────────────────────────────────────

const DETAIL_PATH = /^\/instructions\/([^/]+)$/;
const CANCEL_PATH = /^\/instructions\/([^/]+)\/cancel$/;
const SUBSTITUTE_PATH = /^\/instructions\/([^/]+)\/substitute$/;

export async function mockRequest(
  method: HttpMethod,
  path: string,
  body: unknown,
  session: StoredSession | null,
): Promise<unknown> {
  if (method === 'POST' && path === '/auth/login') {
    await sleep(LATENCY_MS.login);
    const email = (body as { email?: string } | undefined)?.email?.trim();
    if (!email) throw new ApiError(400, 'Falta el email');
    const response: AuthLoginResponse = {
      token: `mock_${btoa(email).replace(/=+$/, '')}`,
      user_id: `usr_mock_${email.split('@')[0] ?? 'demo'}`,
    };
    return response;
  }

  if (method === 'GET' && path === '/auth/me') {
    const active = requireSession(session);
    await sleep(LATENCY_MS.me);
    const response: AuthMeResponse = { user_id: active.user_id, email: active.email };
    return response;
  }

  if (method === 'POST' && path === '/understand') {
    requireSession(session);
    await sleep(LATENCY_MS.understand);
    return clone(UNDERSTAND);
  }

  if (method === 'POST' && path === '/discover') {
    requireSession(session);
    await sleep(LATENCY_MS.discover);
    return clone(DISCOVER);
  }

  if (method === 'GET' && path === '/instructions') {
    requireSession(session);
    await sleep(LATENCY_MS.list);
    const response: InstructionListResponse = { instructions: clone(summaries) };
    return response;
  }

  if (method === 'POST' && path === '/instructions') {
    requireSession(session);
    await sleep(LATENCY_MS.arm);
    return armInstruction(body as CreateInstructionRequest);
  }

  const cancelMatch = CANCEL_PATH.exec(path);
  if (method === 'POST' && cancelMatch?.[1]) {
    requireSession(session);
    await sleep(LATENCY_MS.mutate);
    return cancelInstruction(cancelMatch[1]);
  }

  const substituteMatch = SUBSTITUTE_PATH.exec(path);
  if (method === 'POST' && substituteMatch?.[1]) {
    requireSession(session);
    await sleep(LATENCY_MS.mutate);
    return resolveSubstitute(
      substituteMatch[1],
      body as { candidate_id?: string; approved?: boolean } | undefined,
    );
  }

  const detailMatch = DETAIL_PATH.exec(path);
  if (method === 'GET' && detailMatch?.[1]) {
    requireSession(session);
    await sleep(LATENCY_MS.detail);
    return clone(requireDetail(detailMatch[1]));
  }

  throw new ApiError(404, `El mock no implementa ${method} ${path}`);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function armInstruction(payload: CreateInstructionRequest): CreateInstructionResponse {
  const id = nextId();

  // El hold de P4 se autoriza por el techo y expira con el plazo. Lo replicamos
  // tal cual para que la pantalla de confirmación diga la verdad en modo mock.
  const funds = {
    hold_id: `pi_mock_${id}`,
    committed_cents: payload.max_total_cents,
    currency: payload.currency,
    expires: payload.deadline,
    status: 'committed' as const,
  };

  const summary: InstructionSummary = {
    id,
    canonical: payload.canonical,
    status: 'ARMED',
    max_total_cents: payload.max_total_cents,
    deadline: payload.deadline,
    last_checked_at: null,
  };

  const detail: InstructionDetail = {
    id,
    status: 'ARMED',
    canonical: payload.canonical,
    mandate: {
      max_total_cents: payload.max_total_cents,
      currency: payload.currency,
      deadline: payload.deadline,
      quantity: payload.quantity,
      retailers: payload.retailers,
      constraints: payload.constraints,
    },
    funds,
    offers: [],
    last_checked_at: null,
  };

  summaries = [summary, ...summaries];
  details = { ...details, [id]: detail };

  return { instruction_id: id, status: 'ARMED', funds };
}

function cancelInstruction(id: string): CancelResponse {
  const detail = requireDetail(id);
  const released = detail.funds?.committed_cents ?? 0;

  details = {
    ...details,
    [id]: {
      ...detail,
      status: 'CANCELLED',
      funds: { ...detail.funds, status: 'released' },
    },
  };
  patchSummary(id, { status: 'CANCELLED' });

  return { status: 'CANCELLED', released_cents: released };
}

function resolveSubstitute(
  id: string,
  body: { candidate_id?: string; approved?: boolean } | undefined,
): SubstituteResponse {
  const detail = requireDetail(id);
  const candidateId = body?.candidate_id;
  if (!candidateId) throw new ApiError(400, 'Falta candidate_id');

  const approved = body?.approved === true;
  const pending = detail.pending_alternative;

  // Aprobar o declinar, el agente vuelve a vigilar: AWAITING_APPROVAL no
  // retiene nada y no gasta nada. Solo cambia qué considera comprable.
  const next: InstructionDetail = {
    ...detail,
    status: 'ARMED',
    offers:
      approved || !pending
        ? detail.offers
        : [
            ...detail.offers,
            {
              offer_id: pending.offer_id,
              retailer: pending.retailer,
              total_cents: pending.total_cents,
              verdict: 'REJECTED',
              reason: 'Alternativa declinada por el usuario — el agente sigue buscando la exacta',
              at: new Date().toISOString(),
            },
          ],
  };
  delete next.pending_alternative;

  details = { ...details, [id]: next };
  patchSummary(id, { status: 'ARMED' });

  return {
    status: 'ARMED',
    accepted_alternatives: approved ? [candidateId] : [],
  };
}
