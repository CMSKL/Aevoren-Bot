import type { ApiResult, AppError } from "@shared/contracts";

export class MsBotError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeMessage: string,
    public readonly retryable = false,
    public readonly details?: AppError["details"],
  ) {
    super(safeMessage);
    this.name = "MsBotError";
  }

  toAppError(): AppError {
    return {
      code: this.code,
      safeMessage: this.safeMessage,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof MsBotError) return error.toAppError();
  return {
    code: "INTERNAL_ERROR",
    retryable: false,
    safeMessage: "操作失败，请稍后重试。",
  };
}

export async function apiResult<T>(operation: () => T | Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: asAppError(error) };
  }
}
