<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

# Pi Fork

Pi Fork is a fork of [earendil-works/pi](https://github.com/earendil-works/pi), the interactive, self-extensible coding agent. Both meanings of the name are intended. The fork merges upstream regularly and stays close to it. Its headline work is cache-cost discipline: requests are built so the provider prompt cache covers them, which is what makes long sessions cheap (see [Cache discipline](#cache-discipline)). Four things differ out of the box: crashed sessions repair themselves on resume, tool output sent to the model is capped at 200 KB, the binary talks to no one but your providers, and thinking blocks start hidden behind a live preview. Everything else is opt-in. Every fork decision and changed upstream file is recorded in the [fork ledger](docs/fork/upstream-integration.md).

## Install

From this repo's GitHub Releases. Nothing is published to npmjs.org. Needs Node.js >= 22.19 with npm.

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install.sh | sh
```

Re-running the install upgrades in place. Pin a version with `| sh -s 0.85.5-fork.19`. The script checks Node and npm up front, falls back to a `~/.local` prefix when npm's global directory needs root, warns before a downgrade, tells you when PATH resolves `pi` somewhere else, and `--uninstall` removes the fork.

Alternatives:

- Tarball: `npm install -g --allow-remote=all https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz` (npm >= 12 blocks remote tarballs without the flag)
- `@r-dson/*` packages from GitHub Packages, for library use. Needs a `read:packages` PAT. [Docs](docs/fork/install-from-github.md)
- From source: `npm install --ignore-scripts && npm run build && ./pi-test.sh`

## Getting started

```sh
pi            # interactive mode; authenticate a provider on first run
pi -p "..."   # one-shot prompt
```

The first-run wizard picks a theme (live preview of every registered theme; the preselected Automatic follows the terminal's detected appearance at every startup) and asks the two privacy questions from [Zero telemetry](#what-else-the-fork-changes) once. It is not gated behind upstream's `PI_EXPERIMENTAL` flag.

Usage, providers, and extensions match upstream pi ([docs](https://pi.dev/docs/latest)).

## Cache discipline

A long session lives or dies by the provider prompt cache. A cached input token costs a fraction of an uncached one, roughly 1/120 on DeepSeek and 1/10 on Anthropic, and the cache only hits when each request extends the previous one byte for byte. The fork adapts three ideas from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (design reference: [A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)): an append-only transcript, byte-stable request prefixes, and summarization that does not discard the cached prefix. Concretely:

- **Compaction and branch summaries replay the previous request.** They used to serialize the whole conversation into a standalone summarizer request, a full cache miss at the exact moment the context is largest. They now send the same system prompt, tool list, and history with one appended instruction turn, so the largest call in a session runs almost entirely as a cache hit. This is where nearly all the savings are.
- **Restarts keep the prefix.** Auto-discovered extensions and skills sort by path instead of filesystem order, so a restarted session replays an identical tool list instead of busting the cache. Summarizer calls carry the session routing id, keeping them in the provider's session-scoped cache bucket where one exists (OpenAI `prompt_cache_key`, Mistral affinity).
- **Violations are visible, not silent.** A runtime monitor compares every outgoing request with the previous one. Legitimate rewrites (compaction, model switch, settings toggle, provider-side shaping) are announced and counted under their cause; anything else surfaces as an unexpected invalidation with the first diverging message index.
- **`/session` shows the money.** Cache usage split by request kind (turn, compaction, branch summary, retry), run hit rate, and invalidation counts with attribution.

The full design and slicing live in [docs/fork/cache-preserving-context-plan.md](docs/fork/cache-preserving-context-plan.md); the ledger records each shipped piece. A key-gated e2e test verifies real hit behavior against Anthropic when `ANTHROPIC_API_KEY` is set. SDK note: `compact()` and `generateSummary()` take a required `SummarizationPrefix` argument.

## What else the fork changes

- **Zero telemetry by default.** No install or version pings, no automatic extension updates, no remote model catalog; provider requests carry no app-identification headers. Two phone-home features exist and are strictly opt-in (default off, asked once by the first-run wizard, toggleable in `/settings`): an update check against this repo's GitHub releases, and OpenRouter attribution headers on OpenRouter requests only. A test asserts a representative default session performs zero non-provider fetches; the [endpoint audit](docs/fork/upstream-integration.md#outbound-traffic-audit-issue-32) lists every outbound call.
- **Crash-safe sessions.** Sessions are append-only JSONL. A torn tail is skipped on load; a tool call that never got its result gets a terminal error appended at resume, so the next request is accepted. `pi --validate-session <file>` diagnoses any session file with line numbers.
- **Tool runtime.** Tools can declare `timeoutMs` (the fork forwards it for extension tools) so a stuck call ends in a timeout error instead of hanging the run. Output to the model is capped at 200 KB by default (`tools.maxToolOutputBytes`, 0 disables): the model sees a head-and-tail excerpt, the full output spills to a file under `<sessionDir>/artifacts/<sessionId>/`. `/session` reports volume, truncated bytes, and artifact counts.
- **Fused edit verification.** `edit` and `write` accept `thenRun`, an optional command that runs via bash in the same tool call once the change succeeds, saving one model round-trip per edit-then-verify cycle. The change is kept when the command fails (the error carries both outputs), the command is skipped when the change fails, and permission policies judge the fused command under their shell rules like any other bash call.
- **Thinking hidden by default.** Reasoning blocks collapse behind a live preview: a header with an elapsed timer over a tail excerpt of the current run, an animated ellipsis while it streams, and on terminals that report their background color the oldest lines fade into it. The header freezes to `Thought for Ns` when the run ends; ctrl+t expands. Every reasoning window keeps its own header across tool calls, so a think-act-think cycle reads as alternating previews and tool calls instead of pages of gray text. Upstream shows full blocks by default; installs that ever pressed ctrl+t keep their choice. Reasoning models also offer an `xhigh` effort level, sent raw where the API accepts it and mapped to `high` where it does not.
- **A more legible transcript.** Collapsed `read` results render `N lines (ctrl+o to expand)` and `grep` leads with its match count, so results state their size before their content. A tool without a result yet ticks `Elapsed Ns` once per second, so slow calls visibly work. In mixed-model sessions (after a handoff or manual switch), an assistant message whose model differs from the previous assistant message's carries a muted model-id line above it.
- **Footer usage line.** The line reads traffic, cost, context, then cache detail: `↑66k ↓8.1k 8.3k/128k (6.5%) (auto) Cache 92.9%`. Context shows token count and window next to the percentage, and `?/128k` right after compaction instead of a fabricated `0.0%`. The `usageDisplay` setting (`"minimal"` by default, `"all"` in `/settings`) drops the cumulative cache read/write totals and keeps the hit rate.
- **Skills anywhere in the prompt.** `/skill:name` tokens expand in place wherever they appear and chain (`first do X /skill:tdd then Y`), keeping the surrounding text in order; typing `/` anywhere in the editor opens autocomplete for skill commands. Unknown names and tokens not at a whitespace boundary (`path/to/skill:x`) pass through as literal text, and the TUI renders each expanded block as its own collapsible `[skill]` entry.
- **Permissions, opt-in.** Restrict what the agent may do per project or machine: create `~/.pi/agent/permissions.json` (machine) or `.pi/permissions.json` (project, trusted only) and the built-in `permission-policies` extension activates; with no policy file it does nothing. Rules:
  ```json
  { "rules": [{ "tool": "bash", "command": "git push", "effect": "deny" }] }
  ```
  Rules match tool name, capability, path, or command (token boundary, normalized paths). Deny beats ask beats allow; your rules beat the profile presets (`code`, `review`, `minimal`); `hide: true` removes a tool from the model's list; `ask` opens an approval dialog. [`read-only-mode.ts`](packages/coding-agent/examples/extensions/read-only-mode.ts) is the minimal copy-me variant. The rule evaluator ships as exported library API for extension authors; core performs no permission enforcement, matching upstream's stance that permission flows are extension territory.
- **Model handoff, opt-in.** The model itself decides a task fits another tier and hands the whole conversation over mid-run: name two or more tiers in `~/.pi/agent/handoff.json` and a `switch_model` tool appears. A successful call makes the next assistant turn come from the target tier, the tool result is the baton (who handed off, why, the brief), and `returnAfterRun` gives control back when the run finishes, covering plan, delegate, review without re-switching by hand. A `.pi/handoff.json` in a trusted project adds project tiers on top (project wins on name collisions). Tiers:
  ```json
  {
    "tiers": {
      "fast": { "provider": "deepseek", "modelId": "deepseek-chat", "description": "mechanical edits" },
      "smart": { "provider": "anthropic", "modelId": "claude-opus-4-5", "description": "plans and reviews" }
    }
  }
  ```
  Refusals change nothing: an already-active tier, bouncing back to an earlier baton holder in the same run, a provider without credentials, or a tier gone from the registry each stay put with an explanation. Fewer than two resolvable tiers (or no file at all) leaves `switch_model` unregistered, and manual switching stays canonical over any delegation; a crash drops a pending return, and resuming the session restores the model that held the baton last. The transcript row shows the tier, its model, and the reason. A permission-policies rule on `switch_model` gates it like any other tool.

Each feature sits in core only as far as pi's extension API allows; the ledger records why, and what it would take to move each one out.

## Relationship to upstream

Pi is developed by [Mario Zechner (badlogic)](https://github.com/badlogic) and [earendil works](https://github.com/earendil-works). This fork builds on their work rather than diverging from it:

- Upstream's README is preserved at [docs/fork/upstream-README.md](docs/fork/upstream-README.md).
- The [fork ledger](docs/fork/upstream-integration.md) records every decision, every changed upstream file, and the sync procedure.
- Contributions and bug reports for core Pi belong upstream ([CONTRIBUTING.md](CONTRIBUTING.md), [Discord](https://discord.com/invite/3cU7Bz4UPx)).

The cache discipline and runtime layer were inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (see [Cache discipline](#cache-discipline)). For isolation stronger than permission rules, see the containerization patterns in [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md).

## Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI (the `pi` binary) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, …) |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-client](packages/client) / [pi-server](packages/server) / [pi-protocol](packages/protocol)** | RPC client/server and protocol types |
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts and schemas |

Fork releases publish these as `@r-dson/*` to GitHub Packages and as a standalone `@r-dson/pi-standalone` tarball.

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Releasing

Manual: Actions → **Fork Release** → Run workflow (empty version = `<upstream-version>-fork.<run number>`). Publishes `@r-dson/*` to GitHub Packages, attaches `pi-fork.tgz` to the release, tags `v<version>`. Details in [docs/fork/install-from-github.md](docs/fork/install-from-github.md).

## Supply-chain hardening

Dependency changes are treated as reviewed code changes:

- Direct deps pinned to exact versions; `package-lock.json` is ground truth and pre-commit blocks accidental lockfile commits (`PI_ALLOW_LOCKFILE_CHANGE=1` to override).
- `.npmrc` sets `save-exact=true` and `min-release-age=2`.
- Installs use `--ignore-scripts`; shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts.
- `npm run release:local` builds an unpublished release for isolated smoke testing before tagging.

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
