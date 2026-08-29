<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

# Pi

Pi is an interactive, self-extensible coding agent. This fork of [earendil-works/pi](https://github.com/earendil-works/pi) merges upstream regularly and stays close to it. Its headline work is cache-cost discipline: requests are built so the provider prompt cache covers them, which is what makes long sessions cheap (see [Cache discipline](#cache-discipline)). Three things differ out of the box: crashed sessions repair themselves on resume, tool output sent to the model is capped at 200 KB, and the binary talks to no one but your providers. Everything else is opt-in. Every fork decision and changed upstream file is recorded in the [fork ledger](docs/fork/upstream-integration.md).

## Install

From this repo's GitHub Releases. Nothing is published to npmjs.org. Needs Node.js >= 22.19 with npm.

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install-fork.sh | sh
```

Re-running the install upgrades in place. Pin a version with `| sh -s 0.84.2-fork.2`.

Alternatives:

- Tarball: `npm install -g --allow-remote=all https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz` (npm >= 12 blocks remote tarballs without the flag)
- `@r-dson/*` packages from GitHub Packages, for library use. Needs a `read:packages` PAT. [Docs](docs/fork/install-from-github.md)
- From source: `npm install --ignore-scripts && npm run build && ./pi-test.sh`

## Getting started

```sh
pi            # interactive mode; authenticate a provider on first run
pi -p "..."   # one-shot prompt
```

Usage, providers, and extensions match upstream pi ([docs](https://pi.dev/docs/latest)).

## Cache discipline

A long session lives or dies by the provider prompt cache. A cached input token costs a fraction of an uncached one, roughly 1/120 on DeepSeek and 1/10 on Anthropic, and the cache only hits when each request extends the previous one byte for byte. The fork adapts three ideas from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (design reference: [A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)): an append-only transcript, byte-stable request prefixes, and summarization that does not discard the cached prefix. Concretely:

- **Compaction and branch summaries replay the previous request.** They used to serialize the whole conversation into a standalone summarizer request, a full cache miss at the exact moment the context is largest. They now send the same system prompt, tool list, and history with one appended instruction turn, so the largest call in a session runs almost entirely as a cache hit. This is where nearly all the savings are.
- **Restarts keep the prefix.** Auto-discovered extensions and skills sort by path instead of filesystem order, so a restarted session replays an identical tool list instead of busting the cache. Summarizer calls carry the session routing id, keeping them in the provider's session-scoped cache bucket where one exists (OpenAI `prompt_cache_key`, Mistral affinity).
- **Violations are visible, not silent.** A runtime monitor compares every outgoing request with the previous one. Legitimate rewrites (compaction, model switch, settings toggle, provider-side shaping) are announced and counted under their cause; anything else surfaces as an unexpected invalidation with the first diverging message index.
- **`/session` shows the money.** Cache usage split by request kind (turn, compaction, branch summary, retry), run hit rate, and invalidation counts with attribution.

The full design and slicing live in [docs/fork/cache-preserving-context-plan.md](docs/fork/cache-preserving-context-plan.md); the ledger records each shipped piece. A key-gated e2e test verifies real hit behavior against Anthropic when `ANTHROPIC_API_KEY` is set. SDK note: `compact()` and `generateSummary()` take a required `SummarizationPrefix` argument.

## What else the fork changes

- **Zero telemetry.** No install or version pings, no startup update check, no automatic extension updates, no remote model catalog. Provider requests carry no app-identification headers. A test asserts a representative session performs zero non-provider fetches; the [endpoint audit](docs/fork/upstream-integration.md#outbound-traffic-audit-issue-32) lists every outbound call.
- **Crash-safe sessions.** Sessions are append-only JSONL. A torn tail is skipped on load; a tool call that never got its result gets a terminal error appended at resume, so the next request is accepted. `pi --validate-session <file>` diagnoses any session file with line numbers.
- **Tool runtime.** Tools can declare `timeoutMs` (the fork forwards it for extension tools) so a stuck call ends in a timeout error instead of hanging the run. Output to the model is capped at 200 KB by default (`tools.maxToolOutputBytes`, 0 disables): the model sees a head-and-tail excerpt, the full output spills to a file under `<sessionDir>/artifacts/<sessionId>/`. `/session` reports volume, truncated bytes, and artifact counts.
- **Permissions, opt-in.** Restrict what the agent may do per project or machine with the [`permission-policies.ts`](packages/coding-agent/examples/extensions/permission-policies.ts) extension (copy it into `~/.pi/agent/extensions/` or a project's `.pi/extensions/`), configured by `.pi/permissions.json`:
  ```json
  { "rules": [{ "tool": "bash", "command": "git push", "effect": "deny" }] }
  ```
  Rules match tool name, capability, path, or command (token boundary, normalized paths). Deny beats ask beats allow; your rules beat the profile presets (`code`, `review`, `minimal`); `hide: true` removes a tool from the model's list; `ask` opens an approval dialog. [`read-only-mode.ts`](packages/coding-agent/examples/extensions/read-only-mode.ts) is the minimal variant. The rule evaluator ships as exported library API for extension authors; core performs no permission enforcement, matching upstream's stance that permission flows are extension territory.

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
