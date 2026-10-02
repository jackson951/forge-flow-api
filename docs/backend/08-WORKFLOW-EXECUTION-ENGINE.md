# 08 — Workflow Execution Engine

**Status:** COMPLETE (2026-10-01) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Implement the engine that, given an immutable `WorkflowVersion` and trigger input, walks the graph, executes each node through a registered handler, persists every state transition, follows condition branches, and finishes in a predictable terminal state — independent of HTTP and of any specific integration.

## Why This Part Exists

This is FlowForge's core. Integrations are only useful if execution is deterministic, resumable and observable.

## Scope

Execution states and transitions, graph traversal, node handler contract and registry, step persistence, output passing, error handling, resume-after-crash behaviour, built-in handlers (`manual.trigger`, `condition`, `util.log`, test-only `util.fail`).

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-08.1 | Execution starts at the single trigger node; its output is the normalised trigger payload. |
| FR-08.2 | Nodes execute sequentially in deterministic order: depth-first from the trigger, children ordered by edge order in the definition. |
| FR-08.3 | Each executed node persists a `StepRun` (`RUNNING` before, `SUCCEEDED`/`FAILED` after) with timings, attempt count, sanitised input/output, error. |
| FR-08.4 | Condition nodes produce `{ result: boolean }`; only the matching branch executes; nodes on the other branch are recorded `SKIPPED`. |
| FR-08.5 | Outputs of executed nodes are available to later nodes as `steps.<key>.output` (resolution rules in Part 11). |
| FR-08.6 | A failed step fails the run (`FAILED`) unless the error is retryable and attempts remain, in which case the step is `RETRYING` and the job is retried. Remaining nodes are marked `SKIPPED` on terminal failure. |
| FR-08.7 | Run terminal states: `SUCCEEDED`, `FAILED`, `CANCELLED`. A cancelled run stops before its next step. |
| FR-08.8 | Re-processing a run (job retry or redelivery) resumes: `SUCCEEDED` steps are not re-executed; their stored outputs are reused. |

### State machines

```
WorkflowRun: QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED
             RUNNING → QUEUED (retry scheduled; attempt+1)
             QUEUED  → CANCELLED
StepRun:     PENDING → RUNNING → SUCCEEDED | FAILED | RETRYING
             RETRYING → RUNNING
             PENDING → SKIPPED
             PENDING → FAILED (fails before starting: missing handler, unresolvable config)
             RUNNING → RUNNING (idempotent step re-executed after a crash)
```

Transitions are implemented in one pure function (`transition(state, event)`) that rejects illegal moves; persistence uses conditional updates on the current status.

## Technical Requirements

- **Handler contract:**

  ```ts
  interface NodeHandler<C = unknown, O = unknown> {
    type: string;                         // 'slack.sendMessage'
    kind: 'TRIGGER' | 'ACTION' | 'CONDITION';
    configSchema: ZodType<C>;
    sideEffect: 'none' | 'idempotent' | 'non-idempotent';
    execute(ctx: NodeExecutionContext<C>): Promise<NodeResult<O>>;
  }
  ```

  `NodeExecutionContext` exposes resolved config, run/step IDs, `idempotencyKey` (`${runId}:${nodeKey}`), an `AbortSignal` for timeouts/cancellation, a scoped logger, and a `credentials` accessor limited to the node's `connectionId` within the run's workspace. Handlers never receive Prisma or other tenants' data.
- **Registry:** handlers registered via a Nest multi-provider token; the registry validates unique `type`s at startup.
- **Engine layers:** `ExecutionEngine` (pure orchestration over interfaces) + `RunStore` (Prisma persistence) — the engine can be unit-tested with an in-memory store.
- **Timeouts:** per-node default 30 s (`NODE_TIMEOUT_MS`), enforced with `AbortSignal.timeout`.
- **Output limits:** stored output ≤ 64 KB per step; larger outputs fail the step with `VALIDATION` (prevents unbounded rows).
- **Sanitisation:** input/output passed through the redactor (Part 17) before persistence.
- **Resume policy after crash (step found `RUNNING` on re-processing):**
  - `sideEffect: none | idempotent` → re-execute (attempt + 1).
  - `non-idempotent` → mark step `FAILED` with category `UNCERTAIN_OUTCOME`; run `FAILED`; operator may retry manually. (Full rationale in Part 15.)
- The run's `workflowVersionId` is the only definition source; the engine never reads `Workflow.draftDefinition`.

## API Changes

None directly (runs are started by Parts 07/09 and inspected in Part 16).

## Database Changes

Uses `WorkflowRun`, `StepRun` (Part 02). Adds `StepRun.sequence`, `errorCategory`, `errorMessage` (sanitised), `externalRef` if not present.

## Security Requirements

- Handlers resolve credentials only through the scoped accessor.
- Errors persisted on steps are sanitised; raw provider responses are not stored.
- No dynamic code execution anywhere in the engine.

## Testing Requirements

Unit (in-memory store, fake handlers):
- linear workflow executes in order; branch true/false; nested conditions; skipped nodes recorded;
- failure → run failed, downstream skipped; retryable failure with attempts left → `RETRYING` and rethrow;
- resume skips succeeded steps and reuses outputs;
- crashed `RUNNING` non-idempotent step → `UNCERTAIN_OUTCOME`; idempotent → re-executed;
- cancellation before next step; timeout; output size limit; illegal transitions rejected.

Integration: full run through queue with built-in handlers persisting to Postgres.

## Deliverables

`src/engine/` (engine, transitions, registry, contracts, run store, built-in handlers), worker wiring, tests, a restart/failure behaviour section in this doc.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-08.1 | Simple sequential workflow executes and all steps SUCCEEDED | Unit + integration |
| AC-08.2 | Condition chooses correct branch; other branch SKIPPED | Unit |
| AC-08.3 | Failed step fails run; downstream SKIPPED | Unit + integration |
| AC-08.4 | Execution state persisted at each transition | Integration inspects rows mid-run (latch) and after |
| AC-08.5 | Outputs passed to later steps | Unit |
| AC-08.6 | Resume after simulated crash behaves per policy | Unit |
| AC-08.7 | Restart/failure behaviour documented | This document |
| AC-08.8 | Engine has no imports from HTTP controllers or integration SDKs | Lint rule / dependency test |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Parallel branch execution, loops, joins, sub-workflows, per-node retry policies configurable by users, human-approval steps.

## Dependencies

Parts 06, 07. Part 11 extends value resolution (the engine ships with a minimal resolver interface that Part 11 implements fully).

## Risks / Design Questions

- **Sequential execution of fan-out** is simpler and deterministic but slower; acceptable for the target scale.
- **Whole-job retry vs per-step retry:** retries re-run the job, which resumes at the failed step. This keeps one retry mechanism (BullMQ) rather than two.

## Implementation Notes

Replaces scaffold stubs `WorkflowExecutorService`, `NodeRegistryService`, `NodeHandler` contract.

## Implementation Evidence

Verified 2026-10-01 on branch `feat/part-07-08-queue-and-engine`.

### What was implemented

| Item | Location |
| --- | --- |
| `ExecutionEngine`: DFS order from the trigger, steps planned PENDING up front, branch selection, output passing, resume, uncertain-outcome rule, timeouts, output size limit, cancellation, classified failures | `src/engine/execution/execution-engine.ts` |
| Explicit run/step state machines; conditional (race-safe) updates built from them | `transitions.ts`, `src/execution/prisma-run-store.ts` |
| Handler contract with `sideEffect`, registry with catalog consistency check | `node-handler.ts`, `handler-registry.ts` |
| `RunStore` port; Prisma implementation; in-memory implementation for unit tests (same transition rules) | `run-store.ts`, `src/execution/prisma-run-store.ts`, `testing/in-memory-run-store.ts` |
| Built-in handlers `manual.trigger`, `util.log`; `condition` placeholder (see limitations) | `built-in-handlers.ts` |
| Storage sanitisation of step input/output (credential-like keys redacted, plain JSON) | `sanitize.ts` |
| `ValueResolver` port (identity until Part 11) | `execution-engine.ts` |
| Architecture test: pure engine folders import no Nest, Prisma service, HTTP, queue or provider SDK | `src/engine/architecture.spec.ts` |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-08.1 | PASS | Unit: linear and fan-out order; integration and live: two-step workflow SUCCEEDED with sequences 1..n |
| AC-08.2 | PASS | Unit: true/false branch each run only their subtree, others SKIPPED; condition without a matching edge ends the path. Integration with a real worker: same |
| AC-08.3 | PASS | Unit + integration: failed step FAILED, everything after it SKIPPED, run FAILED with category |
| AC-08.4 | PASS | Integration: while a step is held, DB shows run RUNNING and steps SUCCEEDED / RUNNING / PENDING; afterwards all SUCCEEDED with timings |
| AC-08.5 | PASS | Unit + integration: later steps receive `outputs` of earlier steps and `triggerInput` |
| AC-08.6 | PASS | Unit: retry resumes at the failed step without re-running succeeded ones; idempotent step left RUNNING is re-executed; non-idempotent step left RUNNING fails with UNCERTAIN_OUTCOME without calling the handler. Integration: a non-idempotent step before a flaky one ran exactly once across three job attempts |
| AC-08.7 | PASS | Restart/failure behaviour documented in this spec and in the engine's header comment |
| AC-08.8 | PASS | Architecture test over 14 engine source files |

Also covered by unit tests: unknown errors become INTERNAL with a generic stored message (no leakage); timeouts are retryable PROVIDER_TIMEOUT for idempotent steps but UNCERTAIN_OUTCOME (never retried) for non-idempotent ones; outputs over the limit fail with VALIDATION; non-boolean condition results fail; missing handler and resolver errors fail the step before it starts; illegal transitions are rejected; stored outputs redact credential-like keys; cancellation stops before the next step.

### Found and fixed during this part

- **Steps failing before they start were left PENDING.** A missing handler or unresolvable config tried PENDING → FAILED, which the first transition table did not allow; the store rejected it, and because the failure write and the "skip the rest" write shared one `try`, downstream steps were not skipped either. PENDING → FAILED is now a legal transition, and the two writes are independent. Found by the engine unit tests.

### Limitations

- ~~The built-in `condition` node fails at runtime until Part 11.~~ Resolved in Part 11 (real condition handler and expression resolver).
- On resume, earlier steps' outputs are the *stored* (sanitised) versions, so a credential-like key in an output arrives as `[REDACTED]` to later steps after a retry. Handlers must not pass secrets through outputs (Part 17).
- Step log lines carry `runId` and `nodeKey`; adding `correlationId` and `stepRunId` to every step line is Part 16.
