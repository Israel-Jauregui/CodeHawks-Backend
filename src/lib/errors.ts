export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'bad_request', message, details);
}

export function unauthorized(message = 'A valid UNG access token is required.'): AppError {
  return new AppError(401, 'unauthorized', message);
}

export function forbidden(message = 'You do not have permission to perform this action.'): AppError {
  return new AppError(403, 'forbidden', message);
}

export function notFound(resource: string): AppError {
  return new AppError(404, 'not_found', `${resource} was not found.`);
}

export function conflict(message: string): AppError {
  return new AppError(409, 'conflict', message);
}

