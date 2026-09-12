import type { ApiErrorBody } from '../shared/contracts';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): AppError {
  return new AppError(400, code, message);
}

export function unauthorized(message = 'Missing or invalid admin token'): AppError {
  return new AppError(401, 'unauthorized', message);
}

export function notFound(code: string, message: string): AppError {
  return new AppError(404, code, message);
}

export function gone(code: string, message: string): AppError {
  return new AppError(410, code, message);
}

export function upstreamError(message = 'The Jellyfin server could not be reached'): AppError {
  return new AppError(502, 'upstream_unavailable', message);
}

export function unprocessable(code: string, message: string): AppError {
  return new AppError(422, code, message);
}

export function toErrorBody(error: AppError): ApiErrorBody {
  return { error: { code: error.code, message: error.message } };
}
