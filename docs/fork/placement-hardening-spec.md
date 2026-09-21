# Placement hardening spec

Status: implemented from the 2026-09-19 fork reality check. Not yet published to the
tracker (gh unauthenticated in the authoring session); publish as an issue with
`pkg:coding-agent` and `ready-for-agent` when convenient.

## Problem Statement

The fork placement review found four defects in shipped behavior:

1. The shipped `docs/usage.md` still carries upstream's design principles verbatim,
   including "intentionally does not include built-in ... sub-agents", while the fork
   ships a default-active built-in `task` sub-agent tool. The document states a
   philosophy the product contradicts.
2. A fused `thenRun` command runs bash inside the edit/write tool call without firing
   a `tool_call` event. Only the permission-policies builtin knows to peek at
   `thenRun.command`; any other gating extension (including upstream's
   confirm-destructive example) is blind to fused commands. The fused command also
   builds a fresh bash definition, so `commandPrefix` and `shellPath` settings do not
   apply to it.
3. The `task` tool sets no deadline on itself, so a hung sub-agent stream holds a
   limiter slot indefinitely, and its transcript excerpt caps line count but not line
   length, so one 200 KB single-line tool result survives the excerpt bound.
4. The cache-replay construction lives inside upstream-owned compaction files,
   interleaved with upstream function bodies, and the replay-context building is
   duplicated between compaction.ts and branch-summarization.ts. Upstream refactors
   conflict textually, and a semantic merge drift degrades the cache silently.

## Solution

1. `docs/usage.md` design principles state the fork's one deliberate divergence: the
   built-in `task` tool, with its constraint (one layer, same permission gate and
   output bounding).
2. The session injects a fused-command executor into the edit/write tool options.
   The executor fires a real `tool_call` event for the bash facet through the
   extension runner (so every extension sees it, including `ask` dialogs and input
   mutation), executes through the session's bash tool definition (inheriting its
   options), and fires the `tool_result` observation event. A blocked fused command
   appends a skip marker with the denial reason; the edit result stays non-error.
   The permission-policies fused special case is deleted.
3. The `task` tool gains `taskTimeoutMs` (top-level setting beside `maxSubAgents`;
   default 600000, 0 disables), enforced inside the tool by aborting the sub-agent
   on deadline, and excerpt lines are truncated per line.
4. Replay construction moves to fork-owned modules (`core/compaction/replay.ts`,
   `core/compaction/branch-units.ts`); upstream-owned files keep their structure and
   delegate. Public API and request bytes are unchanged, pinned by a
   characterization test that captures summarizer request contexts through the faux
   provider before and after the move.

## User Stories

1. As a pi fork user, I want the shipped documentation to describe the product I run,
   so I am not told core excludes sub-agents while a `task` tool is active.
2. As an extension author, I want fused `thenRun` commands to fire the same
   `tool_call` event a plain bash call fires, so my gating extension judges them
   without knowing the edit/write schema.
3. As a policy user, I want `ask` rules on bash to open the approval dialog for
   fused commands, so I approve shell execution exactly where shell executes.
4. As a policy user who denies bash, I want fused commands blocked with the rule's
   reason, so the deny cannot be routed around through `thenRun`.
5. As an extension author who rewrites tool arguments, I want my input mutation
   applied to the fused command, so argument filters work on it like any bash call.
6. As a user with `commandPrefix` or `shellPath` configured, I want fused commands
   to run under those settings, so verification runs in my shell environment.
7. As a user whose sub-agent stream hangs, I want the task tool to end with a
   timeout error after `tools.taskTimeoutMs`, so the limiter slot frees without my
   intervention.
8. As a user running long legitimate sub-agent tasks, I want to raise or disable the
   deadline via settings, so the cap never kills real work.
9. As a user expanding a Task N window, I want per-line truncation in the transcript
   excerpt, so one minified tool result does not blow up the persisted details.
10. As a fork maintainer, I want replay construction in fork-owned modules, so
    upstream compaction refactors merge mechanically instead of semantically.
11. As a fork maintainer, I want one shared replay-context builder, so compaction and
    branch summarization cannot drift apart in what bytes they replay.
12. As an SDK embedder, I want `compact()`/`generateSummary()` signatures and request
    bytes unchanged by this work, so my code and my cache assumptions survive the
    refactor.

## Implementation Decisions

- The fused-command executor is a callback injected through the edit/write tool
  options at runtime build time, not a new field on the extension context. The
  extension runner is read lazily at call time so extension reloads are picked up,
  matching how the session's tool hooks already behave.
- The synthetic bash event uses the toolCallId suffix `:thenRun` on the parent call's
  id, so events are attributable in logs and cannot collide with real call ids.
- The `tool_result` observation fires for the fused command, but core output
  bounding is not applied a second time: the outer edit/write call's existing bound
  covers the combined content, and double bounding would double-spill artifacts.
- Outside a session (plain `createEditTool` public API), the fused command keeps the
  current behavior: a fresh local bash definition, no gate. There is no runner to
  gate with. The same fallback applies inside sessions built with tool overrides
  (`baseToolsOverride`): the embedder supplied their own edit/write AgentTools, the
  session cannot inject into already-constructed tools, and embedders wanting the
  gate construct their tools with `createSessionFusedCommandExecutor` directly.
- A throwing gate handler never rejects out of the fused path (the mutation
  has already succeeded; a raw rejection would drop its output from the result):
  gate errors map to the failed outcome with an extension-error message, keeping
  the mutation output and the `[thenRun:failed]` marker. The tool_result
  observation never throws (the runner catches per handler), and a blocked fused
  command emits only the tool_call, no tool_result — matching the agent loop,
  where blocked calls skip the afterToolCall path entirely.
- `taskTimeoutMs` validation (finite number >= 0, and <= 2^31-1 — the
  setTimeout ceiling, since setTimeout silently coerces larger values to a 1ms
  deadline; the tool's deadline setup enforces the same range for
  embedder-supplied getters, mirroring the agent loop's timeoutMs range check)
  mirrors the `maxSubAgents` getter's pattern rather than being left
  unvalidated.
- The task deadline lives inside the tool's execute (AbortController plus
  `AbortSignal.any` with the run signal, unref'd timer cleared on settle), reading
  the setting live per spawn, so settings changes apply without a runtime rebuild.
- The line-length bound reuses the existing `truncateLine` helper at 2000 chars.
- The prompt-constant edits moved into replay.ts with the builders, revising the
  original stay-in-place decision: the constants are fork-edited bytes (the
  checkpoint format and update instructions differ from upstream's), so keeping
  them in compaction.ts left fork-authored hunks inside an upstream-owned file
  with no dedup or test-gate benefit, and the move is conflict-neutral, not
  conflict-enlarging (a deletion hunk collides with an upstream edit exactly as
  an in-place edit does — the measured basis of the patch-surface policy ledger
  row); the golden digest test pins their bytes.
- `SummarizationPrefix` stays re-exported from compaction.ts; only its definition
  moves to the fork module.

## Testing Decisions

- Good tests here pin externally visible bytes and events, not module structure:
  captured provider contexts, emitted tool_call/tool_result events, tool results.
- Fix 2 is tested at three seams: the unit seam with a stub runner and stub bash
  definition for block/mutation/result-override/throwing-handler paths
  (`test/then-run.test.ts`), the session seam with inline extensions for deny,
  mutation, observation, and bash-settings inheritance
  (`test/suite/then-run-gate.test.ts`), and the session seam driving the real
  permission-policies builtin through policy files for deny and ask
  (same file; ask asserts the no-dialog block path; the dialog itself is
  handler-level coverage in `test/permission-policies-builtin.test.ts`).
- Fix 3 is tested at the tool seam with a fake model stream that never resolves
  (prior art: the never-settling-tool test in `packages/agent/test/agent-loop.test.ts`).
- Fix 4 is gated by a characterization test written against the current
  implementation first: it captures compaction and branch-summary summarizer request
  contexts through the faux provider (prior art: `test/suite/prompt-stable-prefix.test.ts`
  capture steps) and must stay byte-identical across the refactor. The fixtures
  carry tool-call/result pairs and a dangling trailing call, so the branch pairing
  and repair bytes are digest-pinned too, and the fresh-compaction path passes
  customInstructions to pin the instruction builder's focus branch. The existing
  golden, prefix-stable-prefix, cache-stats, and session-fixture suites must pass
  unchanged.

## Out of Scope

- Moving the `task` tool out of core (recorded deliberate divergence; stays).
- Making `SummarizationPrefix` optional or otherwise changing the compaction SDK.
- Changing what the replay sends: bytes are pinned, only code location moves.
- The TUI entanglement items (interactive-mode, assistant-message) from the review;
  they are irreducible given their features and carry their own ledger rows.
- Extracting the projector move further or reshaping session-manager.ts.

## Further Notes

- Ledger rows to update when landing: the thenRun row (seam fix supersedes the
  permission-policies special-case note), the task-tool row (deadline and excerpt
  bound), the compaction/replay rows (module locations), and the changed-upstream-files
  table entries for edit.ts/write.ts (executor injection point).
- Changelog entries under `## [Unreleased]` in coding-agent (and agent only if its
  loop changes, which it does not in this round).
