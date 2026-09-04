# Plan: cache-preserving context handling

Adapts three DeepSeek Harness ideas to the pi fork: the append-only transcript discipline, byte-stable request prefixes for provider caching, and summarization that does not discard the cached prefix. Source design: deepseek-ai/deepseek-harness. We implement the ideas natively; per the fork rules we import no DSH code or dependencies.

## Where the fork already matches DSH (do not rebuild)

- **Append-only log.** Session files are append-only JSONL. The projector rebuilds the derived history from the log, the validator enforces the structural invariants, and the append-immutability property test pins that prior bytes never change. This is DSH's "do not disturb the bytes that came before" at the persistence layer.
- **Byte-stable request prefixes.** The golden prompt tests and the stable-prefix suite (issue #12, PR #17) proved that within a session, across turns, and across sessions with identical state, the system prompt, tool list, and tool schemas are byte-identical and message history only ever extends. Default prompt assembly is already cache-friendly.
- **Cache metrics.** Upstream pi tracks cache read/write tokens, per-turn cache misses with cost, and a hit-rate line in the `/session` panel.

The gaps are enforcement (nothing observes a prefix violation at runtime) and, most importantly, the compaction call, which throws the prefix away exactly when the transcript is largest.

## Problem 1: the summarizer call is a full cache miss by construction

Trace of today's compaction (compaction.ts):

1. `prepareCompaction` picks a cut point.
2. `generateSummaryWithUsage` serializes the entire derived history into one text blob, wraps it in `<conversation>` tags, and appends the summarization instruction.
3. `buildSummarizationContext` sends that single user message under a dedicated `SUMMARIZATION_SYSTEM_PROMPT`, with no tool definitions.

Every byte of this request is new to the provider. The provider prices the full context at the uncached rate at the exact moment the context is largest. The token volume is roughly the same as a replay of the real transcript would be; the difference is cached versus uncached.

DSH instead replays the previous request byte for byte and appends the summarize instruction as a final user turn. The summarizer call then runs almost entirely as a cache hit. On DeepSeek pricing an uncached input token costs about 120x a cached one; on Anthropic the uncached premium is roughly 10x. Either way, one full-context uncached read per compaction is the single largest avoidable cost in a long session.

### Solution: phase A, prefix-replaying compaction

Build the summarizer request from the same context the model just saw:

1. The request context is the exact prior request: same system prompt (including ALL tool definitions, unchanged; removing unused tool schemas shifts byte offsets and busts the cache), same message history, same provider options that affect cache placement.
2. Append one final user message containing the summarization instruction. Adapt the existing `SUMMARIZATION_PROMPT` wording from "The messages above" framing to an appended-turn framing ("Summarize the conversation above..."), keeping the checkpoint output format identical so downstream consumers do not change.
3. Nothing else changes: the summary is still stored as a `compaction` entry, the kept tail still follows it, and the next regular turn starts a new prefix (that miss is inherent to compaction and not avoidable).

Mechanics:

- Reconstruct the replay context from the session through the same deterministic assembly path the regular turn uses (the golden tests prove determinism), rather than capturing the wire request. The compaction call sites in `agent-session.ts` already have the model, context messages, and system prompt in hand.
- pi-ai computes Anthropic `cache_control` breakpoints from the context, so a byte-identical context inherits the cache with no provider-specific code here. The trick is provider-agnostic on the wire: same bytes, whatever prefix caching the provider offers applies.
- `previousSummary` (update summaries) and `customInstructions` fold into the appended instruction text; they no longer change the system prompt.

Tests (TDD, faux provider):

- Capture the summarizer request; assert its serialized bytes equal the previous regular request's bytes plus exactly one appended user turn.
- Tool list in the summarizer request equals the regular tool list, same order, same schemas.
- Existing compaction tests (scripted replies) keep passing; summary-format tests unchanged.

Risks:

- Summary quality may shift because the model sees the real system prompt and tools instead of a summarizer persona. The instruction text must carry the persona ("act as a summarizer for this one turn" style). Scripted-reply tests cover mechanics; quality gets a manual check on a real provider before release.
- Providers without prefix caching see a slightly larger prompt (real system prompt versus the short summarizer one). The system prompt is a few KB against a context that triggered compaction, so the overhead is noise.

## Problem 2: prefix stability is proven by tests, not enforced at runtime

The stable-prefix suite pins the default path, but nothing watches production traffic. An extension using `transformContext` or a future regression can silently rewrite history mid-run and eat the cache, and nothing names the culprit.

### Solution: phase B, prefix-stability monitor with attribution

One diagnostic pass, not a framework:

1. Before each provider request, compare the serialized prefix against the previous request (the comparison the stable-prefix tests already perform; reuse that logic as a shared helper).
2. On violation, attribute the change: system prompt changed, tool set changed, history mutated at offset N, or legitimate invalidation (compaction, model switch, tool-set change, extension override). Emit a diagnostic event and count it in session stats.
3. Surface, do not crash. DSH errors on transcript mutation because its extension model forbids it. Pi's extension API intentionally allows `transformContext`, so the fork enforces the invariant as an observable signal with attribution. This is a deliberate divergence; the ledger records it.

Tests: inject a history-rewriting extension in the suite harness; assert the monitor fires with the right attribution; assert normal turns and tool-set changes attribute correctly.

## Problem 3: cache economics are visible per turn but not per decision

The `/session` panel shows cache hit rate. It does not answer "did the last compaction pay the uncached premium" or "how many prefix invalidations did this session accumulate".

### Solution: phase C, cache-economics attribution

- Record per-request cache usage (read, write, uncached input) with the request kind: regular turn, compaction call, branch summary, retry.
- Add session stats: invalidation count by cause, and cache usage split by request kind.
- Render a compact block in the `/session` panel.

Tests: unit-test the attribution from scripted usage payloads; extend the stats panel assertions.

## Out of scope

- Replacing the in-memory `state.messages` array with event-sourced state. The log is already authoritative and the loop is upstream code; the win does not justify the upstream divergence.
- Removing or gating `transformContext`. Extensions keep their contract; the monitor observes.
- New serialized session formats, prompt-section restructuring (descoped with rationale in the ledger), and any DSH dependency imports.
- CI performance thresholds on cache rates. CI has no real providers; the runtime monitor from phase B is the oracle.

## Slicing and order

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| A | Prefix-replaying compaction call | nothing |
| B | Runtime prefix-stability monitor with attribution | A (uses the shared prefix-comparison helper) |
| C | Cache-economics attribution in stats | A (request kinds exist once compaction replays) |

One PR per phase, one issue per PR, each with the two-axis review pass. Ledger rows for every touched upstream file. Phase A alone captures nearly all the cost win; B and C make regressions visible instead of silent.
