import { ErrorCategory } from '@prisma/client';

export interface ErrorCategoryInfo {
  /** Whether errors of this category are normally retried automatically. */
  retryable: boolean;
  /** Shown to users next to a failed run or step. */
  description: string;
}

/**
 * The error category catalogue (Part 16): one place that says what each category means and
 * whether it is retried. Handlers still decide per error (RetryableError / PermanentError);
 * this table is the default and what the API shows.
 */
export const ERROR_CATEGORIES: Record<ErrorCategory, ErrorCategoryInfo> = {
  VALIDATION: {
    retryable: false,
    description: 'The step configuration or its data is invalid; fix the workflow',
  },
  AUTHORIZATION: {
    retryable: false,
    description: 'FlowForge refused the action for this workspace or user',
  },
  PROVIDER_AUTH: {
    retryable: false,
    description: 'The provider rejected the connection; reconnect the integration',
  },
  PROVIDER_RATE_LIMIT: {
    retryable: true,
    description: 'The provider is rate limiting; retried after the requested delay',
  },
  PROVIDER_TIMEOUT: {
    retryable: true,
    description: 'The provider did not answer in time; retried',
  },
  TRANSIENT_INFRASTRUCTURE: {
    retryable: true,
    description: 'A temporary failure (network, database, provider outage); retried',
  },
  PERMANENT_PROVIDER_ERROR: {
    retryable: false,
    description: 'The provider rejected the request; retrying would not help',
  },
  UNCERTAIN_OUTCOME: {
    retryable: false,
    description:
      'The action may or may not have happened (crash or timeout mid-call); check the provider before retrying',
  },
  CANCELLED: { retryable: false, description: 'The run was cancelled' },
  INTERNAL: { retryable: false, description: 'An unexpected FlowForge error' },
};

export const describeError = (category: ErrorCategory | null, message: string | null) =>
  category ? { category, message, ...ERROR_CATEGORIES[category] } : null;
