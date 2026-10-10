import type { ApiErrorCode } from './types.js';

export const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.status = status ?? STATUS[code];
  }
}

export const bad = (m: string): ApiError => new ApiError('invalid', m);
export const forbidden = (m = 'Недоступно'): ApiError => new ApiError('forbidden', m);
export const notFound = (m = 'Не найдено'): ApiError => new ApiError('not_found', m);
export const conflict = (m: string): ApiError => new ApiError('conflict', m);
