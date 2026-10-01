# 12 — AI Integration

**Status:** NOT STARTED (see [00-BACKEND-ROADMAP.md](00-BACKEND-ROADMAP.md))

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
