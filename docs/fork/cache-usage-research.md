# Prompt-cache usage reporting: vLLM and other harnesses

Research notes for `parseChunkUsage` in `packages/ai/src/api/openai-completions.ts`. Question: why does a vLLM backend with prefix caching enabled (engine logs show "Prefix cache hit rate: 75.7%") always report `cacheRead: 0`, and how do other harnesses count and display cache-hit tokens? All claims below are tied to source files on GitHub (main branch unless a tag is given), checked 2026-09-04.

## 1. What vLLM returns, and when

### Direct answer

vLLM's OpenAI-compatible server does report cache hits as `usage.prompt_tokens_details.cached_tokens`, but **only when the server is started with `--enable-prompt-tokens-details`**. The flag exists specifically for this and has been **off by default in every version since the feature was added** (v0.6.4, November 2024) through current main. The PR that added it says so verbatim: "This feature guarded by a flag in OpenAI endpoints and is OFF by default" ([vllm-project/vllm#10174](https://github.com/vllm-project/vllm/pull/10174), "[Frontend] Add per-request number of cached token stats", merged 2024-11-12).

So a server with prefix caching working perfectly (75.7% engine-side hit rate) still emits no `prompt_tokens_details` at all without the flag. Our adapter's parse order (`prompt_tokens_details.cached_tokens` → `prompt_cache_hit_tokens` → top-level `cached_tokens`) never fires because vLLM emits none of those fields; `prompt_cache_hit_tokens` and top-level `cached_tokens` are DeepSeek/Kimi wire shapes that vLLM has never produced. The fix is on the server side: add `--enable-prompt-tokens-details` to the `vllm serve` invocation.

### Where the usage object is built

Current main, after the entrypoints restructure:

- `vllm/entrypoints/openai/chat_completion/serving.py` — `OpenAIServingChat` takes `enable_prompt_tokens_details: bool = False` (constructor, line ~136). Both the non-streaming response (`usage.prompt_tokens_details = _make_prompt_tokens_details(self.enable_prompt_tokens_details, final_res.num_cached_tokens, ...)`, line ~1137) and the final streaming usage chunk (line ~831) call the same helper.
- `_make_prompt_tokens_details` (line 91): returns `None` if the flag is off; otherwise builds `PromptTokenUsageInfo(cached_tokens=..., created_cache_tokens=..., multimodal_tokens=...)`.
- `vllm/entrypoints/serve/engine/protocol.py` (line 122): `class PromptTokenUsageInfo` with `cached_tokens: int | None = None`, `created_cache_tokens: int | None = None`, `multimodal_tokens: dict[str, int] | None = None`. `UsageInfo` (line 136) has `prompt_tokens_details: PromptTokenUsageInfo | None = None`.
- The flag is an engine arg, default False: `vllm/entrypoints/launchers/cli_args.py` line 133 — `enable_prompt_tokens_details: bool = False`, "If set to True, enable prompt_tokens_details in usage."
- Pre-restructure versions are identical in behavior: at tag v0.10.2, `vllm/entrypoints/openai/serving_chat.py` lines 1093-1095 and 1404-1406 gate on `if self.enable_prompt_tokens_details and num_cached_tokens:`.

### Where the cached count comes from (engine side)

The count itself is computed regardless of the frontend flag; only the reporting is gated:

- Scheduler fills per-request stats on the first scheduled prefill: `vllm/v1/core/sched/scheduler.py` line ~937 — `request.prefill_stats.set(num_prompt_tokens=..., num_local_cached_tokens=num_new_local_computed_tokens, num_external_cached_tokens=num_external_computed_tokens)`. `PrefillStats.set` sums local + external into `num_cached_tokens` (`vllm/v1/metrics/stats.py` line ~262).
- `vllm/v1/engine/output_processor.py` line ~678 copies `engine_core_output.prefill_stats.num_cached_tokens` into `req_state.num_cached_tokens`, which rides on `RequestOutput.num_cached_tokens` ("The number of tokens with prefix cache hit", `vllm/outputs.py` line ~127).
- Serving layer reads `res.num_cached_tokens` on the first streaming iteration and attaches it to the final usage chunk.

Conditions:

- **Prefix caching must be active** for the count to be nonzero. Default is on: `enable_prefix_caching: bool = True` in `vllm/config/cache.py` line 140 (V1). V0-era versions needed `--enable-prefix-cache`. The user's engine logs prove it is active.
- **Chunked prefill has no effect** on reporting; nothing in the chain conditions on it.
- In P/D-disaggregated setups `num_cached_tokens` includes external KV-transfer tokens; several open PRs (#46666, #46898) are still fixing over/under-counting there. Irrelevant for single-node serving.
- **Streaming**: `cached_tokens` appears only on the final usage chunk, and that chunk exists only when the request sends `stream_options.include_usage: true` (or the server sets `--enable-force-include-usage`, also default False — see `should_include_usage` usage in serving_chat.py and the arg at `cli_args.py` line 139). Our adapter already sends it (`openai-completions.ts` line 818).

### Version history

| Version | Behavior |
|---|---|
| ≤ v0.6.3 | No `prompt_tokens_details` at all; `usage` has only prompt/completion/total tokens (`UsageInfo` in `vllm/entrypoints/openai/protocol.py`). |
| v0.6.4 → ~v0.15.x | `prompt_tokens_details.cached_tokens` added, gated behind `--enable-prompt-tokens-details` (default off). Zero-hit requests omit the details object entirely (truthiness check `and num_cached_tokens`). |
| Current main (2026) | Same flag, still default off. [#44383](https://github.com/vllm-project/vllm/pull/44383) (merged 2026-06-12) fixed zero-omission: details are now emitted with `cached_tokens: 0`. Extensions: `created_cache_tokens` (prefix-cache **writes**) and `multimodal_tokens` ([#45458](https://github.com/vllm-project/vllm/pull/45458)). |

`created_cache_tokens` is vLLM-specific naming; nothing else in the survey uses it. Note its semantics ("Tokens computed and written to the prefix cache") match what we call cacheWrite, under a different field name than the OpenRouter/ds4 `cache_write_tokens`.

## 2. Harness survey

### antirez/ds4 (C; local engine + OpenAI/Anthropic-compatible server)

ds4 is both sides of the wire, so it is a good contract reference.

- **As a server** ([ds4#29 "Report cache usage"](https://github.com/antirez/ds4/pull/29), merged 2026-05-15; `ds4_server.c`): chat-completions usage is emitted with `prompt_tokens_details: {cached_tokens, cache_write_tokens}`, where `cached_tokens` is deliberately **reads plus writes** and `cache_write_tokens` is reported separately so clients can subtract (`append_openai_usage_json`: `reported_cached_tokens = clamp(cached + cache_write, prompt_tokens)`). The Responses API path mirrors this as `input_tokens_details: {cached_tokens, cache_write_tokens}`. The Anthropic-compatible path emits `cache_read_input_tokens` / `cache_creation_input_tokens` with `input_tokens` exclusive of both. Values come from the local session sync (`j->req.cache_read_tokens = cached` where `cached` is the retained common prefix; see `ds4_server.c` around line 12140).
- **As an agent** (`ds4_agent.c`): no wire parsing at all — cache accounting is local: `cached = common == old_pos && tokens->len >= old_pos ? common : 0`, then only the suffix is prefilled (`agent_worker_sync_tokens`, line ~4792). Display is prefill progress ("prefill sync done prompt=N cached=N suffix=N"); there is no cache-hit-rate percentage in the UI.

### openai/codex (Rust; Responses API only)

Codex never parses chat-completions usage — no `prompt_tokens_details` anywhere in the repo.

- `codex-rs/codex-api/src/sse/responses.rs` (line ~141): `From<ResponseCompletedUsage> for TokenUsage` maps `usage.input_tokens_details.cached_tokens` → `cached_input_tokens`, `input_tokens_details.cache_write_tokens` → `cache_write_input_tokens` (serde default; the same extension field ds4 emits), and `output_tokens_details.reasoning_tokens` → `reasoning_output_tokens`. The struct is in `codex-rs/protocol/src/protocol.rs` line ~2217.
- Display: `codex-rs/tui/src/token_usage.rs` `Display` renders `input={non_cached} (+ {cached} cached)` where `non_cached_input = input_tokens - cached_input`. The status view (`codex-rs/tui/src/status/thread_usage.rs`) shows `({} cached)`. Counts only — no hit-rate formula.

### sst/opencode (TypeScript)

- Current parsing lives in the new `packages/llm` layer: `packages/llm/src/protocols/openai-chat.ts` — the usage schema accepts only `prompt_tokens_details.cached_tokens` (plus `completion_tokens_details.reasoning_tokens`), and `mapUsage` (line ~394) sets `cacheReadInputTokens = cached`, keeps `inputTokens = prompt_tokens` (inclusive), and derives `nonCachedInputTokens = prompt_tokens - cached`. Requests always send `stream_options: { include_usage: true }` (line 361). **No DeepSeek/Kimi fallbacks** — opencode would also show 0 against an unflagged vLLM or DeepSeek's field.
- Anthropic protocol (`packages/llm/src/protocols/anthropic-messages.ts` line ~574): `cache_read_input_tokens` / `cache_creation_input_tokens` → `cacheReadInputTokens` / `cacheWriteInputTokens`, `inputTokens` = sum of the three.
- The AI SDK bridge (`packages/opencode/src/session/llm/ai-sdk.ts` line 46) reads `cachedInputTokens` or `inputTokenDetails.cacheReadTokens` / `cacheWriteTokens`.
- UI: no cache-hit rate. The TUI footer (`packages/tui/src/component/prompt/index.tsx` line ~272) shows context size `N (X%)` where tokens = `input + output + reasoning + cache.read + cache.write` over the context limit.

### charmbracelet/crush (Go, via charm.land/fantasy)

- `fantasy` (github.com/charmbracelet/fantasy) providers/openai: `providers/openai/language_model_hooks.go` maps `promptTokenDetails.CachedTokens` (the official openai-go type for `prompt_tokens_details.cached_tokens`) → `Usage.CacheReadTokens`, both for non-streaming (line ~241) and streaming (line ~269, requires `chunk.Usage.TotalTokens != 0`). The client always sets `StreamOptions.IncludeUsage = true` (`providers/openai/language_model.go` line ~462). Only the OpenAI field; no DeepSeek/Kimi fallbacks, no cache-write parsing on this path.
- Anthropic: `providers/anthropic/anthropic.go` line ~1423 maps `cache_creation_input_tokens` / `cache_read_input_tokens` → `CacheCreationTokens` / `CacheReadTokens`.
- crush consumes these in `internal/agent/agent.go` (line ~1854: cost = `CostPer1MInCached * CacheCreationTokens + CostPer1MOutCached * CacheReadTokens + ...`; `session.PromptTokens = InputTokens + CacheReadTokens`) and logs them (`internal/agent/event.go`: "cache read tokens", "cache creation tokens"). No cache-hit-rate display in the TUI.

### google-gemini/gemini-cli (TypeScript; Gemini API)

Gemini reports `usageMetadata` on generateContent responses: `promptTokenCount` (inclusive — per the API docs, when cachedContent is used it "remains the total effective prompt size, including the number of tokens in the cached content"), `cachedContentTokenCount` (subset of prompt), `thoughtsTokenCount` (output-side, separate from `candidatesTokenCount`; `totalTokenCount` = prompt + thoughts + candidates), `toolUsePromptTokenCount`, `totalTokenCount` ([ai.google.dev/api/generate-content](https://ai.google.dev/api/generate-content)).

- Parsing: `packages/core/src/agent/event-translator.ts` `mapUsage` (line ~459) maps `promptTokenCount` → inputTokens, `candidatesTokenCount` → outputTokens, `cachedContentTokenCount` → cachedTokens. Telemetry (`packages/core/src/telemetry/types.ts` line ~688, `packages/core/src/telemetry/uiTelemetry.ts` line ~315) accumulates all five fields, deriving `input = max(0, prompt - cached)`.
- **Hit-rate formula**: `packages/cli/src/ui/utils/computeStats.ts` line 28: `calculateCacheHitRate = (tokens.cached / tokens.prompt) * 100`, i.e. cached / total input (prompt count is inclusive of cached). The session aggregate uses the same formula on totals (`cacheEfficiency`). The `/stats` table renders a per-model "Cache Reads" column (`packages/cli/src/ui/components/StatsDisplay.tsx`).

### Anthropic API shape (for comparison)

From the prompt-caching docs ([platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)): `usage.input_tokens` = "input tokens which were not read from or used to create a cache"; `cache_read_input_tokens` = tokens retrieved from cache; `cache_creation_input_tokens` = tokens written. Relationship: `total_input = cache_read + cache_creation + input` — the three buckets are disjoint, unlike the OpenAI shape where `prompt_tokens` is inclusive and `cached_tokens` a subset. Thinking tokens are billed as output; the breakdown is in `usage.output_tokens_details.thinking_tokens` ("reports how many of the billed output tokens were internal reasoning"), on the final `message_delta` when streaming (extended-thinking docs).

## 3. Implications for our adapter

**Nothing to fix for the vLLM case.** Our first-priority field (`prompt_tokens_details.cached_tokens`) is exactly what vLLM emits, and we already send `stream_options.include_usage` on streaming. The reported zeros are the server's default-off flag. Recommend telling affected users to launch vLLM with `--enable-prompt-tokens-details` (available v0.6.4+); no code change can conjure the number client-side.

Coverage vs. the survey:

- `prompt_tokens_details.cached_tokens` — covered; this is the only field codex, opencode, and fantasy/crush parse on OpenAI-style paths, and the only one vLLM emits.
- `prompt_cache_hit_tokens` (DeepSeek) and top-level `cached_tokens` (Kimi) — covered; these fallbacks put us ahead of opencode and crush, which would read 0 against those providers.
- `prompt_tokens_details.cache_write_tokens` (OpenRouter, ds4 server, and now codex's Responses parsing) — covered for chat-completions; codex parses the same field on `input_tokens_details` for the Responses API.
- vLLM's `prompt_tokens_details.created_cache_tokens` (cache writes, current main) — **not covered**. If we want cache-write attribution against vLLM backends, add `created_cache_tokens` as a secondary cacheWrite source in `parseChunkUsage` (after `cache_write_tokens`). The engine only populates it for tokens actually prefilled and written, so a fully-cached turn reports 0 — consistent with our cacheWrite semantics. Low priority: single field, vLLM-only, and only matters once the user has the report flag on.
- Hit-rate formula: our UI shows `cacheRead / (input + cacheRead + cacheWrite)` (`interactive-mode.ts` ~6155). Since our `input` excludes cache tokens, the denominator reconstructs the inclusive prompt — the same formula gemini-cli displays. No divergence to fix.
