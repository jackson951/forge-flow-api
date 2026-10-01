import { ErrorCategory } from '@prisma/client';
import { PermanentError } from '../errors';
import { NodeHandler } from './node-handler';

/** The trigger's output is the run's trigger input (manual input or normalised event). */
export const manualTriggerHandler: NodeHandler = {
  type: 'manual.trigger',
  kind: 'TRIGGER',
  sideEffect: 'none',
  execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
};

export const logHandler: NodeHandler<{ message: string }> = {
  type: 'util.log',
  kind: 'ACTION',
  sideEffect: 'none',
  execute: async ({ config, logger }) => {
    logger.info('Workflow log step', { length: config.message.length });
    return { output: { message: config.message } };
  },
};

/**
 * Placeholder until the safe condition evaluator lands (Part 11). Fails clearly instead of
 * guessing a branch. The engine's branching itself is implemented and tested here.
 */
export const conditionPlaceholderHandler: NodeHandler = {
  type: 'condition',
  kind: 'CONDITION',
  sideEffect: 'none',
  execute: async () => {
    throw new PermanentError(
      ErrorCategory.VALIDATION,
      'Condition evaluation is not available yet (Part 11)',
    );
  },
};

export const BUILT_IN_HANDLERS: NodeHandler[] = [
  manualTriggerHandler,
  logHandler as NodeHandler,
  conditionPlaceholderHandler,
];
