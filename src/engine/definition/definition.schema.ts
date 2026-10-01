import { z } from 'zod';

/**
 * Workflow definition, schemaVersion 1 (docs/backend/05-WORKFLOW-MANAGEMENT.md).
 * This module is pure TypeScript: no Nest, no database.
 *
 * The structural schema only checks shape. Graph rules and size limits are reported as
 * validation issues by `validateDefinition`, so a half-built draft can still be saved.
 */

export const NODE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const DEFINITION_LIMITS = {
  maxNodes: 50,
  maxEdges: 100,
  maxDefinitionBytes: 256 * 1024,
  maxNodeConfigBytes: 16 * 1024,
} as const;

/** Hard caps on raw input so absurd payloads are rejected before any graph work. */
const HARD_ARRAY_CAP = 1_000;

export const NODE_KINDS = ['TRIGGER', 'ACTION', 'CONDITION'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const nodeSchema = z
  .object({
    key: z
      .string()
      .regex(NODE_KEY_PATTERN, 'must start with a letter; letters, digits, _ (max 64)'),
    kind: z.enum(NODE_KINDS),
    type: z.string().min(1).max(100),
    config: z.record(z.unknown()).default({}),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  })
  .strict();

export const edgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    branch: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const definitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(nodeSchema).max(HARD_ARRAY_CAP),
    edges: z.array(edgeSchema).max(HARD_ARRAY_CAP),
  })
  .strict();

export type NodeDefinition = z.infer<typeof nodeSchema>;
export type EdgeDefinition = z.infer<typeof edgeSchema>;
export type WorkflowDefinition = z.infer<typeof definitionSchema>;

export const EMPTY_DEFINITION: WorkflowDefinition = { schemaVersion: 1, nodes: [], edges: [] };

export interface StructuralError {
  field: string;
  messages: string[];
}

export type ParseResult =
  { ok: true; definition: WorkflowDefinition } | { ok: false; errors: StructuralError[] };

/** Shape check only. Returns field-level errors in the API's validation format. */
export function parseDefinition(raw: unknown): ParseResult {
  const parsed = definitionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, definition: parsed.data };

  const byField = new Map<string, string[]>();
  for (const issue of parsed.error.issues) {
    const field = issue.path.length ? issue.path.join('.') : 'definition';
    byField.set(field, [...(byField.get(field) ?? []), issue.message]);
  }
  return {
    ok: false,
    errors: [...byField].map(([field, messages]) => ({ field, messages })),
  };
}
