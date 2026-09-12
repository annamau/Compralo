/**
 * El único sitio de la extensión que habla por red.
 *
 * Tres responsabilidades:
 *   1. Inyectar `Authorization: Bearer <token>` en todo salvo el login.
 *   2. Ante un 401, limpiar el token y avisar a la UI para que vuelva a pedir
 *      credenciales. Nunca fallar en silencio.
 *   3. Conmutar entre backend real y `mocks/` de la raíz con un solo flag, para
 *      que el panel sea interactivo al 100 % sin que P1, P3 ni P4 estén en pie.
 */

import type {
  AuthLoginResponse,
  AuthMeResponse,
  CancelResponse,
  CreateInstructionRequest,
  CreateInstructionResponse,
  DiscoverRequest,
  DiscoverResponse,
  InstructionDetail,
  InstructionListResponse,
  SubstituteResponse,
  UnderstandRequest,
  UnderstandResponse,
} from './api.types';
import { ApiError, type HttpMethod } from './http';
import { mockRequest } from './mockStore';
import * as monitors from './monitorsAdapter';
import {
  clearSession,
  readSession,
  writeMockOverride,
  writeSession,
  type StoredSession,
} from './storage';

/** Mock por defecto: solo `VITE_MOCK=false` explícito apunta al backend real. */
// La extensión se apoya únicamente en la API Rust; no hay fallback de fixtures.
const ENV_MOCK = false;
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:3000';

export { ApiError, isNetworkError, isUnauthorized } from './http';
export type { HttpMethod } from './http';

// ─── Estado del cliente ──────────────────────────────────────────────────────

let session: StoredSession | null = null;
let mockMode = ENV_MOCK;
let ready = false;

/** Hidrata sesión y modo desde storage. Se espera antes del primer render. */
export async function initApiClient(): Promise<StoredSession | null> {
  session = await readSession();
  await writeMockOverride(null);
  ready = true;
  return session;
}

export function isApiClientReady(): boolean {
  return ready;
}

export function isMockMode(): boolean {
  return mockMode;
}

export function apiBaseUrl(): string {
  return API_URL;
}

/** Conmutación en caliente: pasar a backend real sin recompilar la extensión. */
export async function setMockMode(_value: boolean): Promise<void> {
  // Conservamos la firma para consumidores antiguos, pero nunca desviamos las
  // operaciones hacia mocks: esos recursos no existen en el backend.
  mockMode = false;
  await writeMockOverride(null);
}

export function currentSession(): StoredSession | null {
  return session;
}

// ─── Expiración de sesión ────────────────────────────────────────────────────

type AuthExpiredListener = () => void;
const authExpiredListeners = new Set<AuthExpiredListener>();

/**
 * La UI se suscribe aquí para volver a la pantalla de login. Un 401 que no
 * levanta esto es un panel que se queda en blanco sin decir por qué.
 */
export function onAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => authExpiredListeners.delete(listener);
}

async function handleUnauthorized(): Promise<void> {
  session = null;
  await clearSession();
  for (const listener of authExpiredListeners) listener();
}

// ─── Transporte ──────────────────────────────────────────────────────────────

async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  if (mockMode) {
    try {
      return (await mockRequest(method, path, body, session)) as T;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) await handleUnauthorized();
      throw error;
    }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session?.token) headers['Authorization'] = `Bearer ${session.token}`;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // Backend caído, CORS o red. Se distingue de un error HTTP a propósito:
    // la UI puede ofrecer volver a modo mock en vez de mostrar un fallo opaco.
    throw new ApiError(0, `No se pudo contactar con ${API_URL}`, cause);
  }

  if (response.status === 401) {
    await handleUnauthorized();
    throw new ApiError(401, 'Sesión caducada');
  }

  const raw = await response.text();
  const parsed: unknown = raw ? safeJson(raw) : null;

  if (!response.ok) {
    throw new ApiError(response.status, messageFrom(parsed) ?? `HTTP ${response.status}`, parsed);
  }

  return parsed as T;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function messageFrom(body: unknown): string | null {
  if (typeof body === 'string' && body.trim()) return body;
  if (body && typeof body === 'object') {
    const candidate = (body as Record<string, unknown>)['error'] ?? (body as Record<string, unknown>)['message'];
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function login(email: string): Promise<StoredSession> {
  if (!mockMode) return monitors.login(email);
  const res = await request<AuthLoginResponse>('POST', '/auth/login', { email });
  const next: StoredSession = { token: res.token, user_id: res.user_id, email };
  session = next;
  await writeSession(next);
  return next;
}

/**
 * Valida un token guardado al abrir el panel. Sin esta llamada, un token
 * caducado no se descubre hasta el primer 401 en medio de un flujo.
 */
export async function me(): Promise<AuthMeResponse> {
  if (!mockMode) return monitors.me();
  return request<AuthMeResponse>('GET', '/auth/me');
}

export async function logout(): Promise<void> {
  session = null;
  await clearSession();
}

// ─── P3 ──────────────────────────────────────────────────────────────────────

export async function understand(payload: UnderstandRequest): Promise<UnderstandResponse> {
  if (!mockMode) return monitors.understand(payload);
  return request<UnderstandResponse>('POST', '/understand', payload);
}

export async function discover(payload: DiscoverRequest): Promise<DiscoverResponse> {
  if (!mockMode) return monitors.discover(payload);
  return request<DiscoverResponse>('POST', '/discover', payload);
}

// ─── P1 ──────────────────────────────────────────────────────────────────────

export async function createInstruction(
  payload: CreateInstructionRequest,
): Promise<CreateInstructionResponse> {
  if (!mockMode) return monitors.createInstruction(payload);
  return request<CreateInstructionResponse>('POST', '/instructions', payload);
}

export async function listInstructions(): Promise<InstructionListResponse> {
  if (!mockMode) return monitors.listInstructions();
  return request<InstructionListResponse>('GET', '/instructions');
}

export async function getInstruction(id: string): Promise<InstructionDetail> {
  if (!mockMode) return monitors.getInstruction(id);
  return request<InstructionDetail>('GET', `/instructions/${encodeURIComponent(id)}`);
}

export async function cancelInstruction(id: string): Promise<CancelResponse> {
  if (!mockMode) return monitors.cancelInstruction(id);
  return request<CancelResponse>('POST', `/instructions/${encodeURIComponent(id)}/cancel`);
}

/** A1: aprobar o declinar el sustituto que el agente encontró. */
export async function respondToSubstitute(
  id: string,
  candidateId: string,
  approved: boolean,
): Promise<SubstituteResponse> {
  if (!mockMode) return monitors.respondToSubstitute(id, candidateId, approved);
  return request<SubstituteResponse>('POST', `/instructions/${encodeURIComponent(id)}/substitute`, {
    candidate_id: candidateId,
    approved,
  });
}
