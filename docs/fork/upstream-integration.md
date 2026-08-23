# Upstream Integration Ledger

Fork-specific integration bookkeeping. Update this file whenever fork work touches files that upstream also owns.

## Purpose

This fork evolves pi's session layer toward incremental append-only session processing with crash-safe recovery, a canonical tool pipeline, and bounded tool outputs, while keeping the upstream-visible patch surface small so merges from upstream `main` stay mechanical and easy. Everything outside the fork's own modules is treated as upstream code and changed only through entries in the table below.

## Decisions Log

Pre-made architectural decisions, with one-line rationales. Do not revisit without updating this ledger.

| Decision | Rationale |
| --- | --- |
| Projection cache skipped | `buildSessionContext` runs only on resume, session switch, and compaction — never per turn — because the agent mutates `state.messages` in memory. No hot path, so no cache. |
| Perf/token/cache baselines deferred | Tests must not use real providers or keys, and the faux provider cannot measure provider cache tokens, so there is nothing trustworthy to baseline against yet. |
| Upstream behavior kept: session file creation deferred until first assistant message | Forcing a flush on user-message commit would create session files for abandoned prompts. |
| Neutral directory naming: new session modules live in `core/sessions/` | Upstream-contribution friendly; does not advertise fork ownership in the path. |
| Incremental-index/projection-cache work folded into session validation | No serialized format changes; file order is the sequence, so correctness is validated before any indexing is added. |
| Full `ExecutionScope` (defer/dispose cleanup registry) skipped | Tools already receive an abort signal and clean up on it; a deferred-cleanup registry has no consumer today. Per-tool `timeoutMs` covers the deadline case. |

## Changed Upstream Files

Every upstream file the fork modifies, and the assumptions each change rests on.

| File | Why | Fork module called | Assumptions | Tests |
| --- | --- | --- | --- | --- |
| `.github/workflows/ci.yml` | Fork runs stacked PRs whose bases are feature branches, so CI must not filter `pull_request` to `main`; `workflow_dispatch` allows manual runs | none (trigger-only change) | Trigger-only change; job steps (build, check, test) identical to upstream, so upstream merges only ever conflict on the `on:` block | The CI run on every stacked PR |
| `packages/coding-agent/src/core/session-manager.ts` | Extraction of pure projection into `core/sessions/projector.ts` | `core/sessions/projector.ts` | Re-export surface keeps external imports stable: all previously-exported entry types, `CURRENT_SESSION_VERSION`, and projection functions are re-exported from session-manager.ts, so no other file changes. `loadEntriesFromFile` and `SessionManager.open` stay tolerant and silent; validation/recovery live in the validator module | `packages/coding-agent/test/session-fixtures-golden.test.ts`, `packages/coding-agent/test/session-projector.test.ts` |
| `packages/coding-agent/src/cli/args.ts` | `--validate-session <path>` flag and help entry (one-shot validate command) | `core/sessions/validator.ts` | Diagnostic-only flag parsed like other value flags (missing value is an args diagnostic error); no other flag or runtime behavior changes | `packages/coding-agent/test/args.test.ts` |
| `packages/coding-agent/src/main.ts` | Early one-shot branch (like `--export`) that prints the validation report and exits | `core/sessions/validator.ts` | Runs before session creation and stdout takeover; exit 0 when clean or warnings-only, exit 1 on error-severity issues or unreadable file | `packages/coding-agent/test/session-validator.test.ts` |
| `packages/agent/src/types.ts` | Additive optional `timeoutMs` field on `AgentTool` | none (type-only) | Optional field: all existing tool definitions compile unchanged and behave as before; no default timeouts | `packages/agent/test/agent-loop.test.ts` |
| `packages/agent/src/agent-loop.ts` | Timeout enforcement in `executePreparedToolCall`: tool signal aborts on parent signal or deadline; deadline expiry yields the standard error tool result | none (loop-local) | Uses stdlib `AbortSignal.any`/`AbortSignal.timeout` (Node engines floor >=22.19.0); `AbortSignal.timeout` timers are unref'd so pending deadlines never keep the event loop alive; tools without `timeoutMs` receive the run signal unchanged | `packages/agent/test/agent-loop.test.ts` |

## Upstream Sync Procedure

1. Merge upstream `main` into fork `main` as a dedicated `upstream-sync:` commit; never mix fork feature changes into a sync commit.
2. Rebase or merge stacked fork branches onto the updated fork `main` afterwards.
3. Run `npm run check` and `./test.sh` from the repo root; fix fallout before continuing.
4. If a sync invalidated an assumption recorded in the table above, update that row and the associated test in the same change.
