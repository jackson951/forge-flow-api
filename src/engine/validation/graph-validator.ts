import { looksLikeSecret } from '../../common/security/redaction';
import { NodeTypeCatalog } from '../catalog/node-type-catalog';
import { collectReferences } from '../expressions/mapping';
import { parseReference, Reference } from '../expressions/reference';
import {
  DEFINITION_LIMITS,
  EdgeDefinition,
  NodeDefinition,
  WorkflowDefinition,
} from '../definition/definition.schema';

export type IssueCode =
  | 'NO_TRIGGER'
  | 'MULTIPLE_TRIGGERS'
  | 'DUPLICATE_NODE_KEY'
  | 'UNKNOWN_NODE_TYPE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INVALID_NODE_CONFIG'
  | 'SECRET_IN_CONFIG'
  | 'EDGE_UNKNOWN_NODE'
  | 'SELF_LOOP'
  | 'DUPLICATE_EDGE'
  | 'EDGE_INTO_TRIGGER'
  | 'BRANCH_REQUIRED'
  | 'BRANCH_NOT_ALLOWED'
  | 'DUPLICATE_BRANCH'
  | 'MULTIPLE_INCOMING'
  | 'CYCLE'
  | 'UNREACHABLE_NODE'
  | 'CONDITION_WITHOUT_BRANCH'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_CONDITION'
  | 'INVALID_REFERENCE'
  | 'UNKNOWN_REFERENCE_NODE'
  | 'NON_ANCESTOR_REFERENCE';

export interface ValidationIssue {
  code: IssueCode;
  severity: 'error' | 'warning';
  message: string;
  nodeKey?: string;
  edge?: { from: string; to: string; index: number };
  /** Path inside the node config, for INVALID_NODE_CONFIG / SECRET_IN_CONFIG. */
  path?: string;
}

/**
 * Config keys that look like credentials. Definitions are stored and snapshotted in plain
 * JSON; secrets must live in encrypted integration credentials and be referenced by
 * `connectionId` (Part 17). Deliberately exact-match so e.g. `maxTokens` is allowed.
 */
const SECRET_KEY =
  /^(access_?|refresh_?|api_?|auth_?|bearer_?|client_?|private_?)?(token|secret|password|passwd|apikey|key|authorization)$/i;
const ALLOWED_KEY_NAMES = new Set(['key']); // a bare "key" is a common, harmless field name

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Semantic validation of a structurally valid definition. Pure and deterministic: issues are
 * ordered by rule, then by position in the definition. A definition is publishable when no
 * issue has severity "error".
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  catalog: NodeTypeCatalog,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (issue: Omit<ValidationIssue, 'severity'>) =>
    issues.push({ severity: 'error', ...issue });

  // ── limits ────────────────────────────────────────────────────────────────
  const { nodes, edges } = definition;
  if (nodes.length > DEFINITION_LIMITS.maxNodes) {
    error({ code: 'LIMIT_EXCEEDED', message: `At most ${DEFINITION_LIMITS.maxNodes} nodes` });
  }
  if (edges.length > DEFINITION_LIMITS.maxEdges) {
    error({ code: 'LIMIT_EXCEEDED', message: `At most ${DEFINITION_LIMITS.maxEdges} edges` });
  }
  if (byteLength(definition) > DEFINITION_LIMITS.maxDefinitionBytes) {
    error({
      code: 'LIMIT_EXCEEDED',
      message: `Definition exceeds ${DEFINITION_LIMITS.maxDefinitionBytes / 1024} KB`,
    });
  }

  // ── nodes ─────────────────────────────────────────────────────────────────
  const nodesByKey = new Map<string, NodeDefinition>();
  for (const node of nodes) {
    if (nodesByKey.has(node.key)) {
      error({
        code: 'DUPLICATE_NODE_KEY',
        nodeKey: node.key,
        message: `Node key "${node.key}" is used more than once`,
      });
      continue;
    }
    nodesByKey.set(node.key, node);
  }

  const triggers = [...nodesByKey.values()].filter((n) => n.kind === 'TRIGGER');
  if (triggers.length === 0) {
    error({ code: 'NO_TRIGGER', message: 'A workflow needs exactly one trigger node' });
  }
  for (const extra of triggers.slice(1)) {
    error({
      code: 'MULTIPLE_TRIGGERS',
      nodeKey: extra.key,
      message: 'Only one trigger node is supported',
    });
  }

  for (const node of nodesByKey.values()) {
    if (byteLength(node.config) > DEFINITION_LIMITS.maxNodeConfigBytes) {
      error({
        code: 'LIMIT_EXCEEDED',
        nodeKey: node.key,
        message: `Node config exceeds ${DEFINITION_LIMITS.maxNodeConfigBytes / 1024} KB`,
      });
    }
    for (const path of findSecretKeys(node.config)) {
      error({
        code: 'SECRET_IN_CONFIG',
        nodeKey: node.key,
        path,
        message:
          'Secrets must not be stored in workflow definitions; connect an integration and reference it by connectionId',
      });
    }

    const type = catalog.get(node.type);
    if (!type || type.kind !== node.kind) {
      error({
        code: 'UNKNOWN_NODE_TYPE',
        nodeKey: node.key,
        message: type
          ? `Node type "${node.type}" is a ${type.kind} node, not ${node.kind}`
          : `Unknown node type "${node.type}"`,
      });
      continue;
    }
    if (type.unavailableReason) {
      error({
        code: 'PROVIDER_NOT_CONFIGURED',
        nodeKey: node.key,
        message: type.unavailableReason,
      });
    }
    const config = type.configSchema.safeParse(node.config);
    if (!config.success) {
      for (const issue of config.error.issues) {
        error({
          code: node.kind === 'CONDITION' ? 'INVALID_CONDITION' : 'INVALID_NODE_CONFIG',
          nodeKey: node.key,
          path: issue.path.join('.') || undefined,
          message: issue.message,
        });
      }
    }
  }

  // ── edges ─────────────────────────────────────────────────────────────────
  const validEdges: EdgeDefinition[] = [];
  const seenEdges = new Set<string>();
  const seenBranches = new Set<string>();

  edges.forEach((edge, index) => {
    const ref = { from: edge.from, to: edge.to, index };
    const from = nodesByKey.get(edge.from);
    const to = nodesByKey.get(edge.to);

    if (!from || !to) {
      const missing = [!from && edge.from, !to && edge.to].filter(Boolean).join('", "');
      error({
        code: 'EDGE_UNKNOWN_NODE',
        edge: ref,
        message: `Edge references unknown node "${missing}"`,
      });
      return;
    }
    if (edge.from === edge.to) {
      error({ code: 'SELF_LOOP', edge: ref, message: 'A node cannot connect to itself' });
      return;
    }
    const id = `${edge.from}->${edge.to}`;
    if (seenEdges.has(id)) {
      error({ code: 'DUPLICATE_EDGE', edge: ref, message: 'Duplicate edge' });
      return;
    }
    seenEdges.add(id);

    if (to.kind === 'TRIGGER') {
      error({
        code: 'EDGE_INTO_TRIGGER',
        edge: ref,
        message: 'Trigger nodes cannot have incoming edges',
      });
      return;
    }
    if (from.kind === 'CONDITION' && !edge.branch) {
      error({
        code: 'BRANCH_REQUIRED',
        edge: ref,
        message: 'Edges from a condition need branch "true" or "false"',
      });
      return;
    }
    if (from.kind !== 'CONDITION' && edge.branch) {
      error({
        code: 'BRANCH_NOT_ALLOWED',
        edge: ref,
        message: 'Only edges from a condition may have a branch',
      });
      return;
    }
    if (edge.branch) {
      const branchId = `${edge.from}:${edge.branch}`;
      if (seenBranches.has(branchId)) {
        error({
          code: 'DUPLICATE_BRANCH',
          edge: ref,
          message: `Condition "${edge.from}" already has a "${edge.branch}" edge`,
        });
        return;
      }
      seenBranches.add(branchId);
    }
    validEdges.push(edge);
  });

  // ── graph shape (over valid edges only) ──────────────────────────────────
  const incoming = new Map<string, number>();
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const edge of validEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
    if (!parent.has(edge.to)) parent.set(edge.to, edge.from);
  }

  for (const [key, count] of incoming) {
    if (count > 1) {
      error({
        code: 'MULTIPLE_INCOMING',
        nodeKey: key,
        message: 'Each node may have only one incoming edge (joins are not supported)',
      });
    }
  }

  for (const cycle of findCycles([...nodesByKey.keys()], children)) {
    error({
      code: 'CYCLE',
      nodeKey: cycle[0],
      message: `Cycle detected: ${[...cycle, cycle[0]].join(' → ')}`,
    });
  }

  if (triggers.length === 1) {
    const reachable = reachableFrom(triggers[0].key, children);
    for (const key of nodesByKey.keys()) {
      if (!reachable.has(key)) {
        error({
          code: 'UNREACHABLE_NODE',
          nodeKey: key,
          message: 'Node is not reachable from the trigger',
        });
      }
    }
  }

  // ── data references (Part 11) ─────────────────────────────────────────────
  for (const node of nodesByKey.values()) {
    const ancestors = ancestorsOf(node.key, parent);
    const references = collectReferences(node.config, { templates: node.kind !== 'CONDITION' });
    for (const text of references) {
      let ref: Reference;
      try {
        ref = parseReference(text);
      } catch (err) {
        error({ code: 'INVALID_REFERENCE', nodeKey: node.key, message: (err as Error).message });
        continue;
      }
      if (ref.root !== 'steps') continue;
      if (!nodesByKey.has(ref.nodeKey!)) {
        error({
          code: 'UNKNOWN_REFERENCE_NODE',
          nodeKey: node.key,
          message: `"${text}" refers to unknown node "${ref.nodeKey}"`,
        });
      } else if (!ancestors.has(ref.nodeKey!)) {
        error({
          code: 'NON_ANCESTOR_REFERENCE',
          nodeKey: node.key,
          message: `"${text}" refers to "${ref.nodeKey}", which does not run before this node`,
        });
      }
    }
  }

  for (const node of nodesByKey.values()) {
    if (node.kind === 'CONDITION' && !children.has(node.key)) {
      issues.push({
        code: 'CONDITION_WITHOUT_BRANCH',
        severity: 'warning',
        nodeKey: node.key,
        message: 'Condition has no outgoing edges, so its result is unused',
      });
    }
  }

  return issues;
}

export const hasErrors = (issues: ValidationIssue[]) => issues.some((i) => i.severity === 'error');

/** Paths of credential-like keys or token-shaped values inside a node config. */
function findSecretKeys(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'string') return looksLikeSecret(value) ? [path.join('.')] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findSecretKeys(item, [...path, String(i)]));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = [...path, key];
    if (SECRET_KEY.test(key) && !ALLOWED_KEY_NAMES.has(key)) return [here.join('.')];
    return findSecretKeys(child, here);
  });
}

/** Nodes guaranteed to have run before `key`: its chain of parents (graphs are trees). */
function ancestorsOf(key: string, parent: Map<string, string>): Set<string> {
  const ancestors = new Set<string>();
  let current = parent.get(key);
  while (current !== undefined && !ancestors.has(current)) {
    ancestors.add(current);
    current = parent.get(current);
  }
  return ancestors;
}

function reachableFrom(start: string, children: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of children.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Iterative DFS colouring; returns each cycle once (as the nodes on it, in order). */
function findCycles(keys: string[], children: Map<string, string[]>): string[][] {
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[][] = [];

  for (const root of keys) {
    if (state.has(root)) continue;
    const path: string[] = [];
    const stack: { key: string; next: number }[] = [{ key: root, next: 0 }];
    state.set(root, 'visiting');
    path.push(root);

    while (stack.length) {
      const frame = stack[stack.length - 1];
      const kids = children.get(frame.key) ?? [];
      if (frame.next < kids.length) {
        const child = kids[frame.next++];
        if (state.get(child) === 'visiting') {
          cycles.push(path.slice(path.indexOf(child)));
        } else if (!state.has(child)) {
          state.set(child, 'visiting');
          path.push(child);
          stack.push({ key: child, next: 0 });
        }
      } else {
        state.set(frame.key, 'done');
        path.pop();
        stack.pop();
      }
    }
  }
  return cycles;
}
