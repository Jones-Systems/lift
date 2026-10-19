export class DomainError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 501 | 503,
    public readonly code: string, message = code, public readonly details?: unknown) {
    super(message);
  }
}

export function notFound(): never { throw new DomainError(404, 'not_found'); }
export function revision(actual: number, expected: number): void {
  if (actual !== expected) throw new DomainError(409, 'stale_revision', 'Refresh the resource before editing.', { revision: actual });
}
