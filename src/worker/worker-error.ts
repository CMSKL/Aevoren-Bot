export class WorkerError extends Error {
  constructor(readonly code: string, readonly status = 400, message = code, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}
