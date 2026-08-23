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

## Changed Upstream Files

Every upstream file the fork modifies, and the assumptions each change rests on. Later tickets fill this in.

| File | Why | Fork module called | Assumptions | Tests |
| --- | --- | --- | --- | --- |
| `.github/workflows/ci.yml` | Fork runs stacked PRs whose bases are feature branches, so CI must not filter `pull_request` to `main`; `workflow_dispatch` allows manual runs | none (trigger-only change) | Trigger-only change; job steps (build, check, test) identical to upstream, so upstream merges only ever conflict on the `on:` block | The CI run on every stacked PR |
| `packages/coding-agent/src/core/session-manager.ts` | Extraction of pure projection into `core/sessions/projector.ts` | `core/sessions/projector.ts` | Re-export surface keeps external imports stable: all previously-exported entry types, `CURRENT_SESSION_VERSION`, and projection functions are re-exported from session-manager.ts, so no other file changes | `packages/coding-agent/test/session-fixtures-golden.test.ts`, `packages/coding-agent/test/session-projector.test.ts` |

## Upstream Sync Procedure

1. Merge upstream `main` into fork `main` as a dedicated `upstream-sync:` commit; never mix fork feature changes into a sync commit.
2. Rebase or merge stacked fork branches onto the updated fork `main` afterwards.
3. Run `npm run check` and `./test.sh` from the repo root; fix fallout before continuing.
4. If a sync invalidated an assumption recorded in the table above, update that row and the associated test in the same change.
