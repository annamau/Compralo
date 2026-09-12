/**
 * Primitivas de transporte compartidas por el cliente real y el mock.
 *
 * Viven aparte a propósito: `apiClient` importa `mockStore` y `mockStore`
 * necesita lanzar `ApiError`. Con la clase aquí, no hay ciclo entre ambos.
 */

export type HttpMethod = 'GET' | 'POST';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `status === 0` significa que la petición no llegó a salir: red, CORS o backend caído. */
export const isNetworkError = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 0;

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;
