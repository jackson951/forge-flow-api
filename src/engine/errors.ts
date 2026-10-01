import { ErrorCategory, Prisma } from '@prisma/client';

/**
 * Execution errors carry a category (persisted on runs/steps, Part 16) and whether a retry
 * may help. Handlers throw these; anything else is classified by `classifyError`.
 */
export abstract class ExecutionError extends Error {
  abstract readonly retryable: boolean;

  constructor(
    readonly category: ErrorCategory,
    message: string,
    /** For rate limits: the provider's requested wait before retrying. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class RetryableError extends ExecutionError {
  readonly retryable = true;
}

export class PermanentError extends ExecutionError {
  readonly retryable = false;
}

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  /** Safe to persist and show to users: never raw provider bodies or stack traces. */
  message: string;
  retryAfterMs?: number;
}

/** Prisma errors that mean "database unreachable/overloaded", worth retrying. */
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ExecutionError) {
    return {
      category: err.category,
      retryable: err.retryable,
      message: truncate(err.message),
      retryAfterMs: err.retryAfterMs,
    };
  }
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_PRISMA_CODES.has(err.code))
  ) {
    return {
      category: ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      retryable: true,
      message: 'Database temporarily unavailable',
    };
  }
  // Unknown errors are bugs until proven otherwise: retrying would just repeat them.
  return { category: ErrorCategory.INTERNAL, retryable: false, message: 'Internal error' };
}

const truncate = (message: string) =>
  message.length > 500 ? `${message.slice(0, 497)}...` : message;
