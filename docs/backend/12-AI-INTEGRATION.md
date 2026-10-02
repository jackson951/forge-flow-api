# 12 — AI Integration

**Status:** COMPLETE (2026-10-02) — evidence below; see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md)

## Objective

Add AI as a workflow capability — summarise, classify and structured extraction — executed only in the worker, with server-held credentials, strict limits and validation of every model output before downstream nodes can use it.

## Why This Part Exists

AI classification is what makes the flagship flow (issue → classify → branch → Slack) interesting. Model output is untrusted input; this part makes that explicit in code.

## Scope

`AiProvider` abstraction with one concrete provider plus a deterministic fake, three node handlers, input/output limits, schema validation, timeouts, error classification, usage metadata.

## Functional Requirements

| ID | Requirement |
| --- | --- |
| FR-12.1 | `ai.summarize`: config `{ text (template), maxWords (20–300) }` → `{ summary }`. |
| FR-12.2 | `ai.classify`: config `{ text, labels: string[2..20], field? }` → `{ label, confidence? }`; `label` must be one of `labels`. |
| FR-12.3 | `ai.extract`: config `{ text, fields: [{ name, type: string|number|boolean|enum, enumValues?, required }] (≤ 20) }` → object validated against a zod schema generated from `fields`. |
| FR-12.4 | Output failing validation → one repair attempt with the validation error; still invalid → step `FAILED` with `PERMANENT_PROVIDER_ERROR` (category `AI_INVALID_OUTPUT` sub-code). |
| FR-12.5 | Input text above `AI_MAX_INPUT_CHARS` (default 20 000) is truncated with a marker; truncation recorded in step metadata. |
| FR-12.6 | Step output includes `usage: { inputTokens, outputTokens, model }` when the provider returns it. |

## Technical Requirements

- `AiProvider` interface: `complete({ system, prompt, jsonSchema?, maxOutputTokens, signal }) → { text | json, usage }`. Implementations: one hosted LLM provider selected by `AI_PROVIDER` (chosen at implementation time and recorded here), and `FakeAiProvider` for tests/demo without a key.
- Prefer the provider's native structured-output / tool-schema feature; still validate locally with zod.
- Prompts are server-side templates; user text is placed in a delimited data section and the system prompt instructs the model to treat it as data (prompt-injection mitigation; not a guarantee — hence strict output validation).
- Timeout `AI_TIMEOUT_MS` (default 20 s) via `AbortSignal`; timeouts → `PROVIDER_TIMEOUT` (retryable). 429 → `PROVIDER_RATE_LIMIT`; 401/403 → `PROVIDER_AUTH` (permanent); 5xx → `TRANSIENT_INFRASTRUCTURE`.
- `sideEffect: 'idempotent'` (no external state change; re-running costs money but is safe).
- Handlers configured with no credentials in the workflow; the key is global config (`AI_API_KEY`). Per-workspace keys are out of scope.

## API Changes

None beyond node types appearing in the node catalogue (`GET /api/v1/node-types` if implemented in Part 05; otherwise Swagger schema only).

## Database Changes

None (usage stored inside `StepRun.sanitizedOutput`).

## Security Requirements

- API key only in server config; never in definitions, responses or logs.
- Prompts/outputs logged only as lengths and hashes, not content.
- Output validated before being exposed to later steps; `label` constrained to configured labels so conditions can't be steered to unexpected values.
- Disabled cleanly when no key is configured (`ai.*` nodes fail validation at publish with `PROVIDER_NOT_CONFIGURED`), unless `AI_PROVIDER=fake`.

## Testing Requirements

Unit with mocked provider: happy path per action; malformed JSON; valid JSON wrong schema; label outside set; repair succeeds / fails; timeout; 429; 401; truncation; usage mapping. No test calls the real provider (CI has no key). Optional manually-run smoke test gated on `AI_SMOKE_TEST=1`.

Integration: workflow with `ai.classify` via `FakeAiProvider` executes through the worker.

## Deliverables

`src/integrations/ai/` (provider interface, provider implementation, fake, handlers, schemas), config additions, tests.

## Acceptance Criteria

| ID | Criterion | Verification |
| --- | --- | --- |
| AC-12.1 | AI action executes through worker | Integration with fake provider |
| AC-12.2 | Malformed AI response handled (step fails cleanly or repaired) | Unit |
| AC-12.3 | Structured response validated against schema | Unit |
| AC-12.4 | Provider failures classified correctly | Unit |
| AC-12.5 | API key never reaches frontend or logs | Response scan + log capture tests |
| AC-12.6 | Tests use mocks, no real API calls in CI | CI config has no key; provider HTTP blocked in tests |

## Definition of Done

Common DoD in [00](00-BACKEND-ROADMAP.md#definition-of-done).

## Out of Scope

Chat UIs, embeddings, RAG, per-workspace model selection, streaming, cost billing.

## Dependencies

Parts 08, 11.

## Risks / Design Questions

- **Prompt injection** from issue bodies can influence labels; constrained outputs limit the blast radius (worst case: wrong branch).
- **Cost control:** per-workspace daily AI step cap may be needed (future).

## Implementation Notes

Replaces scaffold `AiService` stub. Check the chosen provider's current model IDs and structured-output API at implementation time rather than hard-coding from memory.

## Implementation decisions

| Question | Decision |
| --- | --- |
| Hosted provider (`AI_PROVIDER`) | **Anthropic Messages API** (`anthropic`), called with `fetch` (no SDK). Default model `claude-haiku-4-5-20251001` (fast, low cost; override with `AI_MODEL`). API version header `2023-06-01`. |
| Structured output | One forced tool (`tool_choice: { type: "tool", name: "respond" }`) whose `input_schema` is the expected object; text answers are still accepted and parsed (code fences stripped). Always validated locally with zod. |
| Location | `src/modules/ai/` (replaces the scaffold `AiService`), next to the other modules, rather than `src/integrations/ai/`. The API process does not import it; only the worker's `ExecutionModule` does (architecture test). |
| `ai.classify` `field` | Optional description of what is classified (e.g. "issue type"), used only in the prompt. Labels are matched case-insensitively and mapped back to the configured spelling. |
| `ai.extract` output | Extracted fields at the top level of the output (`steps.x.output.<field>`); optional fields are `null` when absent; unknown keys are dropped. `usage` and `meta` are reserved field names. |
| Step metadata | Output adds `usage` (summed across the repair attempt) and `meta: { attempts, inputChars, truncated }`. |
| `AI_INVALID_OUTPUT` | `ErrorCategory` stays `PERMANENT_PROVIDER_ERROR` (no schema change); the error message starts with `AI_INVALID_OUTPUT:`. The message never contains model output (zod type errors and our own messages only). |
| Long input vs. the Part 11 template cap | Templates render to at most 16 KB (Part 11; above that the step fails with `Rendered text exceeds 16 KB`). `text` therefore also accepts `{ "ref": "trigger.body" }`, which passes the raw value without that cap; it is then truncated to `AI_MAX_INPUT_CHARS` with a marker. |
| `AI_PROVIDER=fake` | Deterministic, schema-driven fake (first allowed label found in the text, `name: value` lines for extraction, first 20 words for summaries). Allowed outside production only (startup validation). |
| Smoke test (`AI_SMOKE_TEST=1`) | Not implemented (optional in this spec). |

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | unset | `anthropic` or `fake`; unset → `ai.*` nodes fail validation with `PROVIDER_NOT_CONFIGURED` and `GET /node-types` reports `available: false` |
| `AI_API_KEY` | — | Required when `AI_PROVIDER=anthropic` |
| `AI_API_URL` | `https://api.anthropic.com` | |
| `AI_MODEL` | `claude-haiku-4-5-20251001` | |
| `AI_TIMEOUT_MS` | 20000 | Per call; the engine's `NODE_TIMEOUT_MS` bounds the whole step (including a repair) |
| `AI_MAX_INPUT_CHARS` | 20000 | 1 000–200 000 |
| `AI_MAX_OUTPUT_TOKENS` | 1024 | 64–8 192 |

### Error classification

| Condition | Category | Retry |
| --- | --- | --- |
| `AI_TIMEOUT_MS` elapsed, HTTP 408 | `PROVIDER_TIMEOUT` | yes |
| HTTP 429 | `PROVIDER_RATE_LIMIT` (honours `retry-after`, default 30 s) | yes |
| HTTP 401 / 403 | `PROVIDER_AUTH` | no |
| HTTP 5xx (incl. 529 overloaded), network failure | `TRANSIENT_INFRASTRUCTURE` | yes |
| Other 4xx | `PERMANENT_PROVIDER_ERROR` | no |
| Output invalid after one repair | `PERMANENT_PROVIDER_ERROR` (`AI_INVALID_OUTPUT: …`) | no |
| Engine timeout / cancellation | left to the engine (not re-labelled) | engine rules |

## Implementation Evidence

Verified 2026-10-02 on branch `feat/part-12-ai` (from `main` at `4ce5f8b`).

### What was implemented

| Item | Location |
| --- | --- |
| Provider interface and token | `src/modules/ai/ai-provider.ts` |
| Anthropic provider, HTTP error mapping | `src/modules/ai/anthropic.provider.ts` |
| Deterministic fake provider | `src/modules/ai/fake-ai.provider.ts` |
| Config schemas, prompts (data in a `<data>` section, delimiters neutralised), output schemas, validation, single repair, truncation, usage | `src/modules/ai/ai-tasks.ts` |
| Node types `ai.summarize` / `ai.classify` / `ai.extract` (`unavailableReason` when unconfigured) and idempotent worker handlers; logs only lengths and a SHA-256 prefix | `src/modules/ai/ai.node-types.ts` |
| Provider factory; worker-only wiring | `src/modules/ai/ai.module.ts`, `src/execution/execution.module.ts`, `src/engine/engine.module.ts` |
| `PROVIDER_NOT_CONFIGURED` validation issue; `available` in `GET /api/v1/node-types` | `src/engine/validation/graph-validator.ts`, `src/engine/catalog/node-type-catalog.ts`, `node-types.controller.ts` |
| Config keys and guards (key required for `anthropic`; `fake` refused in production; empty values = unset) | `src/config/env.schema.ts`, `app-config.service.ts`, `.env.example` |
| Tests cannot reach external hosts: `fetch` to anything but localhost rejects, in unit, e2e and integration runs; test env forces `AI_PROVIDER=fake` and sets a canary `AI_API_KEY` | `test/support/block-external-http.ts`, `package.json`, `test/setup-env.ts`, `test/setup-int-env.ts` |

### Command results

| Command | Result |
| --- | --- |
| prettier check, lint (0 warnings), typecheck, build | pass |
| `npm test` | 439 passed (49 in `src/modules/ai/ai.spec.ts`, AI config cases in `env.schema.spec.ts`, AI boundary in `security-architecture.spec.ts`) |
| `npm run test:e2e` | 16 passed |
| `npm run test:int` | 211 passed (8 in `test/integration/ai.int-spec.ts`) |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| AC-12.1 | PASS | Integration: manual trigger → `ai.classify` → condition on `steps.classify.output.label` → log, executed by the real `WorkerModule` with the fake provider; both branches; `ai.extract` + `ai.summarize` chain feeding a later template; stored output includes `usage` and `meta` |
| AC-12.2 | PASS | Unit: malformed JSON → repair with reason → success; invalid twice → `PermanentError` `PERMANENT_PROVIDER_ERROR`, message `AI_INVALID_OUTPUT: …` without model text |
| AC-12.3 | PASS | Unit: generated JSON schema for `ai.extract`; wrong types repaired; enum values normalised; unknown keys dropped; label outside the set rejected; confidence range; summary word limit |
| AC-12.4 | PASS | Unit: 429 (with/without `retry-after`), 401, 403, 408, 500, 529, 400, own timeout, network failure, engine abort passed through; messages never include the key or response body |
| AC-12.5 | PASS | Integration: every `PinoLogger` call in API + worker captured — contains `AI step completed` but not the canary key, issue text or model output; API responses and stored step rows scanned for the canary. Unit: handler log fields contain no content. Architecture test: only `execution.module.ts` imports the AI module/providers; `AppModule` imports neither |
| AC-12.6 | PASS | CI workflow defines no `AI_*` variables; test setup forces `AI_PROVIDER=fake`; a unit test shows `fetch("https://api.anthropic.com/…")` and the real provider are blocked |

Also verified: FR-12.5 truncation (unit; integration with `{ ref }` input of 24 000 chars → `meta.truncated: true`), `PROVIDER_NOT_CONFIGURED` on publish (unit + integration with an unconfigured catalog: draft saved, publish 422, node type `available: false`).

Mutation checks (each made tests fail, then reverted): accepting labels outside the configured set; removing the repair attempt; logging the input text; removing the `<data>` delimiter neutralisation.

### Found and fixed during this part

- **Long input could never be truncated.** Part 11 fails templates rendering above 16 KB, so FR-12.5 was unreachable through `{{ }}`. `text` now also accepts `{ "ref": … }` (raw value), and an integration test covers both paths.

### Notes / follow-ups

- Prompt injection can still steer a label within the configured set (worst case: wrong branch), as stated in the risks.
- No per-workspace cost cap yet (risk noted above); usage is recorded per step for Part 16.
- Not verified against the live Anthropic API (no key in this environment, by design of AC-12.6). The request follows the Messages API tool-use contract; a manual run with a real key is recommended before relying on it.
