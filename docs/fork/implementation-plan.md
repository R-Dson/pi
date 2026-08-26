# Pi Fork Implementation Plan

> Superseded. This was the original phase plan; decisions that shipped live in the
> [fork ledger](upstream-integration.md) (Decisions Log plus per-file rows) and the cache work is
> planned in [cache-preserving-context-plan.md](cache-preserving-context-plan.md). Kept for
> history; where it disagrees with the ledger, the ledger wins. Notable descopes versus this
> plan: the `fork/` directory layout (neutral `core/sessions/` naming won), the
> `ExecutionScope` cleanup registry, the prompt-section framework, and the projection cache.

## Goals

Extend Pi with:

1. Incremental, append-only session processing.
2. Crash-safe persistence and recovery.
3. A canonical, cancellable tool-execution pipeline.
4. Lightweight capability and permission controls.
5. Deterministic prompt construction for better cache reuse.
6. Bounded tool outputs and useful runtime diagnostics.

Maintain:

- Existing Pi session compatibility.
- Existing extension and tool APIs.
- Existing default behavior.
- A small upstream patch surface.
- Easy rebasing and merging from upstream Pi.

---

# 1. Fork and compatibility strategy

## 1.1 Preserve upstream package boundaries

Do not move or rename upstream modules. Add fork functionality in isolated directories:

```text
packages/agent-core/src/
  fork/
    execution-scope.ts
    tool-pipeline.ts
    permissions.ts

packages/coding-agent/src/
  fork/
    sessions/
      event-types.ts
      session-index.ts
      projector.ts
      writer.ts
      recovery.ts
    prompts/
      assembler.ts
    artifacts/
      store.ts
    diagnostics/
      trace.ts
```

Use a neutral directory name instead of `fork/` if this work may later be proposed upstream, such as `runtime/` or `session-v2/`.

## 1.2 Minimize edits to upstream files

Integrate through thin adapters:

```ts
const sessionManager = createCompatibleSessionManager(upstreamOptions);
const toolExecutor = createCompatibleToolExecutor(upstreamTools);
```

Each upstream integration point should ideally require one import and one constructor call. Avoid spreading fork-specific conditionals across Pi.

## 1.3 Preserve public APIs

Existing extensions and tools should continue to compile unchanged.

Add optional fields instead of changing required fields:

```ts
interface ToolDefinition {
  // Existing fields remain unchanged.
  capability?: ToolCapability;
  outputPolicy?: ToolOutputPolicy;
}
```

When metadata is missing, derive conservative compatibility defaults:

```ts
function normalizeToolDefinition(tool: ToolDefinition): NormalizedTool {
  return {
    ...tool,
    capability: tool.capability ?? inferCapability(tool),
    outputPolicy: tool.outputPolicy ?? DEFAULT_OUTPUT_POLICY,
  };
}
```

## 1.4 Gate new behavior

Use one configuration section:

```ts
interface ForkRuntimeConfig {
  sessions?: {
    incrementalProjection?: boolean;
    durableFlush?: boolean;
  };
  tools?: {
    permissions?: "legacy" | "policy";
    outputLimits?: boolean;
  };
  prompts?: {
    deterministicAssembly?: boolean;
  };
}
```

Initial defaults:

- Incremental projections: enabled when behavior is equivalent.
- Durable flush: enabled.
- Recovery validation: enabled.
- Permissions: legacy behavior.
- Output limits: enabled only above a generous compatibility threshold.
- Prompt assembly: enabled after golden-output equivalence tests pass.

Remove flags once implementations are proven and stable.

## 1.5 Maintain an upstream integration ledger

Keep a short document:

```text
docs/fork/upstream-integration.md
```

For every changed upstream file, record:

- why it is modified;
- which fork module it calls;
- assumptions about the upstream API;
- relevant compatibility tests.

Keep upstream synchronization commits separate from feature commits:

```text
upstream-sync: merge pi <version>
fork-session: adapt session manager integration
fork-tools: adapt tool executor integration
```

---

# 2. Session architecture

## 2.1 Treat existing entries as append-only events

Do not introduce an incompatible session format. Define an internal alias or normalized representation over existing entries:

```ts
type SessionEvent = ExistingSessionEntry;

interface NormalizedSessionEvent {
  id: string;
  parentId: string | null;
  sequence: number;
  timestamp: string;
  type: string;
  source: SessionEvent;
}
```

Only add new serialized event types when existing entry types cannot express required state:

```ts
type ForkSessionEntry =
  | ContextCompactedEntry
  | TurnInterruptedEntry;
```

Readers must tolerate unknown optional fields. Writers should continue emitting the existing Pi format wherever possible.

## 2.2 Extract a pure context projector

Move context derivation into a pure function:

```ts
function projectModelContext(
  entries: readonly SessionEvent[],
  leafId: string,
  options: ProjectionOptions,
): ModelContext;
```

Requirements:

- No filesystem access.
- No global state.
- No TUI dependencies.
- Deterministic output.
- Exact compatibility with current Pi context generation.
- Handles branches, compaction, tool results, and model changes.

Initially run both implementations in tests and compare their outputs.

## 2.3 Build an incremental session index

Maintain:

```ts
interface SessionIndex {
  byId: Map<string, SessionEvent>;
  childrenByParent: Map<string | null, string[]>;
  sequenceById: Map<string, number>;
  leaves: Set<string>;
  latestCompactionByLeaf: Map<string, string>;
}
```

Update the index on append instead of rescanning the session.

Cache context projections by:

```ts
type ProjectionKey =
  `${string}:${string}:${number}`;
// sessionId : leafId : projectorVersion
```

When a new event is appended, extend the parent projection where possible. Fall back to a full replay if the cache is unavailable or incompatible.

Projection caches remain disposable. The session log stays authoritative.

## 2.4 Preserve non-destructive compaction

Represent compaction as an appended record:

```ts
interface ContextCompactedEntry {
  type: "context_compacted";
  id: string;
  parentId: string;
  compactedThroughId: string;
  summary: string;
  projectorVersion: number;
}
```

The model projector uses the newest applicable compaction on the selected branch. Transcript rendering retains the original history.

Do not rewrite prior entries.

## 2.5 Add explicit persistence barriers

Extend the existing writer:

```ts
interface SessionWriter {
  append(entry: SessionEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

Flush at:

- user-message commit;
- completed tool result;
- end of assistant turn;
- before branch creation;
- before compaction;
- session switch;
- shutdown.

Serialize writes through one queue to preserve ordering.

## 2.6 Add lightweight recovery

On session open:

1. Read complete records.
2. Ignore or quarantine a truncated final JSONL line.
3. Build and validate the session index.
4. Detect an incomplete final turn.
5. Preserve all committed records.
6. Mark the interrupted turn without rewriting history.
7. Resume from the last valid projection.

Validation rules:

- unique IDs;
- monotonic sequence order;
- valid parent references;
- acyclic ancestry;
- tool results reference valid calls;
- no duplicate terminal tool result;
- valid compaction boundaries.

Expose:

```bash
pi --validate-session <path>
```

---

# 3. Canonical tool-execution pipeline

## 3.1 Route model tool calls through one executor

Implement:

```ts
interface ToolExecutor {
  execute(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
```

Execution order:

```text
Resolve tool
→ Validate arguments
→ Check capability visibility
→ Evaluate permission
→ Request approval if required
→ Execute with cancellation and timeout
→ Bound and normalize output
→ Persist terminal result
→ Return result to the agent
```

Existing tools remain unchanged and are wrapped by an adapter:

```ts
function adaptLegacyTool(tool: ExistingTool): ExecutableTool;
```

No extension API break is required.

## 3.2 Add execution scopes

Every turn receives an `AbortController`. Each model request and tool execution receives a child scope.

```ts
interface ExecutionScope {
  signal: AbortSignal;
  deadline?: number;
  defer(cleanup: () => Promise<void> | void): void;
  dispose(): Promise<void>;
}
```

Use it for:

- model-stream cancellation;
- subprocess termination;
- temporary-file cleanup;
- timers;
- tool cleanup.

The existing cancel key should abort the root turn scope.

A cancelled tool must append a terminal result:

```ts
{
  status: "cancelled",
  reason: "user_abort"
}
```

## 3.3 Add time and output limits

Provide compatibility-safe defaults:

```ts
interface ToolExecutionLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
}
```

Apply strict limits primarily to subprocess and external tools. Preserve a configurable override.

Tool output should be divided into:

```ts
interface ToolExecutionResult {
  modelOutput: string;
  uiOutput?: string;
  artifact?: ArtifactReference;
  metadata: {
    durationMs: number;
    originalBytes?: number;
    truncated?: boolean;
  };
}
```

When output exceeds the limit:

- preserve a useful head and tail;
- report omitted byte count;
- optionally save complete output as an artifact;
- send only bounded content to the model.

---

# 4. Capabilities and permissions

## 4.1 Add optional capability metadata

Use a small fixed set:

```ts
type ToolCapability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.execute"
  | "network.access"
  | "session.modify";
```

Tools without metadata receive compatibility defaults.

Do not build a generic capability framework.

## 4.2 Separate tool visibility from execution permission

```ts
interface ToolAccess {
  visible: boolean;
  effect: "allow" | "ask" | "deny";
}
```

Filtering tool visibility happens before prompt construction. Permission evaluation happens again at execution.

This reduces tool-schema prompt size without relying on prompt-level controls for security.

## 4.3 Implement a small rule evaluator

```ts
interface PermissionRule {
  tool?: string;
  capability?: ToolCapability;
  path?: string;
  command?: string;
  effect: "allow" | "ask" | "deny";
}
```

Precedence:

```text
deny > ask > allow > default
```

Return structured decisions:

```ts
type PermissionDecision =
  | { kind: "allow"; ruleId?: string }
  | { kind: "ask"; reason: string; ruleId?: string }
  | { kind: "deny"; reason: string; ruleId?: string };
```

Start in legacy mode so current behavior is preserved. Users can opt into policy mode until it is mature.

## 4.4 Keep profiles minimal

Ship only three profiles:

```text
code      Existing Pi behavior and tools
review    Read-only repository analysis
minimal   Core tools and reduced prompt
```

Profiles resolve to ordinary configuration:

```ts
interface AgentProfile {
  capabilities: CapabilityPolicy;
  permissions: PermissionPolicy;
  enabledTools?: string[];
  promptSections?: string[];
}
```

Do not scatter mode checks through the runtime.

---

# 5. Deterministic prompt assembly

## 5.1 Introduce ordered prompt sections

```ts
interface PromptSection {
  id: string;
  priority: number;
  stability: "static" | "session" | "turn";
  content: string;
}
```

Assembly order:

1. Static core instructions.
2. Static tool policy.
3. Deterministically ordered tool definitions.
4. Project instructions.
5. Session context or compaction summary.
6. Volatile turn information.
7. Current user message.

## 5.2 Preserve current prompt behavior first

Phase one must reproduce current Pi prompts exactly.

Add golden tests for:

- base startup;
- project instructions;
- extension-provided prompt content;
- tools enabled and disabled;
- model changes;
- compaction;
- branch resume.

Only reorganize sections after output-equivalence tests exist.

## 5.3 Stabilize serialized tool definitions

Normalize:

- tool order;
- JSON Schema property order where safe;
- optional metadata;
- descriptions;
- provider conversion.

Do not include volatile values in stable sections.

Add a stable-prefix regression test:

```ts
assertStableRequestPrefix(previousRequest, nextRequest);
```

The addition of a normal user turn should not mutate previous messages, prompt sections, or tool schemas.

---

# 6. Diagnostics

Add lightweight metrics rather than a general tracing framework:

```ts
interface TurnMetrics {
  projectionMs: number;
  replayedEvents: number;
  reusedEvents: number;
  modelCalls: number;
  toolCalls: number;
  toolOutputBytes: number;
  truncatedToolOutputBytes: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  persistenceMs: number;
}
```

Expose through a diagnostic command or optional status panel:

```text
Projection: 8 ms, 97% reused
Prompt cache: 42k read, 1.2k written
Tools: 4 calls, 31 KB sent to model, 2.4 MB truncated
Persistence: 6 ms
```

Do not persist high-frequency telemetry in the session log.

---

# 7. Implementation sequence

## Phase 0: Upstream baseline

- Pin the current upstream commit.
- Run all existing tests.
- Add fork integration documentation.
- Create representative session fixtures.
- Record baseline latency, token use, and cache metrics.

**Exit criteria**

- Clean test baseline.
- Repeatable upstream merge procedure.
- No fork features added yet.

## Phase 1: Pure session projection

- Extract the model-context projector.
- Add golden tests against current behavior.
- Cover branching, compaction, tools, model switching, and resume.
- Keep existing storage and execution unchanged.

**Exit criteria**

- Projected context matches current Pi behavior.
- No session-format changes.
- No public API changes.

## Phase 2: Incremental index and projection cache

- Add `SessionIndex`.
- Update it on append.
- Reuse ancestor projections.
- Version and invalidate projection caches.
- Add reuse metrics.

**Exit criteria**

- Identical context output.
- New turns do not replay the full session under normal operation.
- Cache deletion causes a correct full rebuild.

## Phase 3: Durable writer and recovery

- Add ordered append queue.
- Add `flush()` and `close()`.
- Flush at tool and turn boundaries.
- Detect truncated tails and interrupted turns.
- Add session validation command.

**Exit criteria**

- Simulated crashes never corrupt prior records.
- Completed tool results survive restart.
- Old Pi sessions open without migration.

## Phase 4: Canonical tool executor

- Wrap existing tools.
- Centralize validation and execution.
- Add cancellation, timeout, and terminal-result persistence.
- Ensure all model-requested tools use the pipeline.

**Exit criteria**

- Existing tools and extensions work unchanged.
- Cancellation terminates active work.
- Every tool call has one persisted terminal result.

## Phase 5: Output bounding and artifacts

- Limit content returned to models.
- Preserve head/tail excerpts.
- Store complete oversized output as optional artifacts.
- Add output-size diagnostics.

**Exit criteria**

- Large command output cannot consume context without bounds.
- Full output remains accessible when artifact storage is enabled.

## Phase 6: Capabilities and permissions

- Add optional tool capability metadata.
- Add visibility filtering.
- Implement `allow`, `ask`, and `deny`.
- Ship policy mode as opt-in.
- Add `code`, `review`, and `minimal` profiles.

**Exit criteria**

- Legacy mode matches current behavior.
- Explicit deny overrides broader allow rules.
- Hidden tools are absent from model schemas.
- All visible tools still pass execution-time checks.

## Phase 7: Deterministic prompt assembly

- Introduce named sections.
- Preserve extension contributions through adapters.
- Normalize tool ordering and schema serialization.
- Add stable-prefix tests and section token metrics.

**Exit criteria**

- Existing prompt behavior remains compatible.
- Identical state produces identical model requests.
- Appending a turn preserves the prior request prefix where provider formats permit.

## Phase 8: Remove temporary compatibility paths

Only after at least one stable release:

- remove dual projection execution;
- remove obsolete feature flags;
- retain old session readers;
- keep legacy tool adapters;
- document any intended behavior changes.

---

# 8. Testing requirements

## Compatibility tests

- Existing sessions load unchanged.
- Existing extensions compile unchanged.
- Existing tools execute unchanged.
- Existing configuration remains valid.
- Existing prompts retain required content.
- New sessions remain readable by the fork after future upstream merges.

## Golden tests

Store fixtures for:

- normal conversation;
- tool success;
- tool failure;
- tool cancellation;
- model switch;
- compacted session;
- branched session;
- interrupted turn;
- truncated session tail;
- unknown optional event field.

## Property tests

Validate:

- unique event IDs;
- ancestry is acyclic;
- projection is deterministic;
- append does not alter previous events;
- each tool call has at most one terminal result;
- deny always overrides allow;
- cache removal does not change projected output.

## Crash tests

Terminate the process:

- after user-message append;
- during model streaming;
- during tool execution;
- after tool completion but before the next model call;
- during compaction;
- while the writer queue contains records.

## Performance tests

Measure:

- session load time;
- append latency;
- context projection time;
- incremental event reuse;
- prompt token count;
- provider cache-read tokens;
- tool-output tokens.

Set regression thresholds in CI where results are deterministic.

---

# 9. Upstream maintenance rules

1. Do not rename upstream files solely for fork organization.
2. Do not reformat unrelated upstream code.
3. Keep fork behavior behind narrow adapters.
4. Avoid changes to public types unless fields are optional.
5. Keep session readers backward-compatible indefinitely.
6. Keep feature commits independent and revertible.
7. Merge upstream frequently instead of accumulating large divergences.
8. Add compatibility tests before modifying an upstream integration point.
9. Prefer composition over replacing upstream implementations.
10. Do not import DeepSeek Harness or Cordis dependencies.

---

# 10. Explicitly out of scope

Do not implement:

- a service container;
- an “everything is a plugin” architecture;
- a generic event bus;
- hot-swappable core subsystems;
- a database persistence backend;
- distributed workers;
- cron scheduling;
- autonomous background agents;
- a general workflow engine;
- complete sandbox/container infrastructure;
- persistence of streaming token deltas;
- unrestricted hook-based mutation;
- a second extension system.

---

# Final deliverable

The fork should add four contained runtime components:

```text
SessionRuntime
  append-only indexing, projection, flush, recovery

ToolRuntime
  validation, permissions, cancellation, output shaping

PromptAssembler
  deterministic, cache-aware request construction

RuntimeDiagnostics
  projection, cache, tool-output, and persistence metrics
```

The highest-priority release should include phases 1–5. Capabilities, permissions, profiles, and prompt-section restructuring should follow only after session and tool compatibility are proven. This delivers the main reliability and efficiency gains while keeping the upstream diff small and manageable.
