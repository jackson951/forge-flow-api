import { ErrorCategory } from '@prisma/client';
import { PermanentError } from '../errors';
import { ValueResolver } from '../execution/execution-engine';
import { mapConfig, MappingError } from './mapping';
import { ReferenceSyntaxError } from './reference';

/**
 * Production ValueResolver: renders `{{ }}` templates and `{ ref }` objects in action and
 * trigger configs. Condition configs are left as written — the condition handler resolves
 * its operands itself so it can tell "missing" from null.
 *
 * Missing references render as "" / null (documented behaviour); they are reported to the
 * optional callback for logging.
 */
export function createExpressionResolver(
  onMissing?: (nodeKey: string, references: string[]) => void,
): ValueResolver {
  return {
    resolve(config, scope, node) {
      if (node.kind === 'CONDITION') return config;
      try {
        const { value, missing } = mapConfig(config, {
          trigger: scope.triggerInput,
          outputs: scope.outputs,
        });
        if (missing.length) onMissing?.(node.key, missing);
        return value as Record<string, unknown>;
      } catch (err) {
        if (err instanceof ReferenceSyntaxError || err instanceof MappingError) {
          throw new PermanentError(ErrorCategory.VALIDATION, err.message);
        }
        throw err;
      }
    },
  };
}
