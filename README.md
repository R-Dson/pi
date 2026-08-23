<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

# Pi — fork with a hardened session and tool runtime

Pi is an interactive, self-extensible coding agent, plus the agent runtime and unified multi-provider LLM API underneath it.

This is R-Dson's fork of [earendil-works/pi](https://github.com/earendil-works/pi). The fork tracks upstream and adds a focused runtime layer on top: crash-safe sessions with validation and recovery, time-limited and output-bounded tool execution, opt-in permission policies, and runtime diagnostics. **Everything defaults to upstream behavior** — every fork decision and changed upstream file is recorded in the [fork ledger](docs/fork/upstream-integration.md).

## Install

From this repo's GitHub Releases (nothing is published to npmjs.org). Needs Node.js >= 22.19 with npm.

Zero configuration, no PAT, no `.npmrc`:

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install-fork.sh | sh
```

Alternatives:

- Direct tarball: `npm install -g --allow-remote=all https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz` (the flag is required on npm >= 12, which blocks remote-tarball installs by default)
- Individual `@r-dson/*` packages from GitHub Packages, for library use (requires a `read:packages` PAT): [install docs](docs/fork/install-from-github.md)
- From source: `npm install --ignore-scripts && npm run build && ./pi-test.sh`

The binary is `pi`, same as upstream. Re-running the install upgrades in place; pass a version to the script (`| sh -s 0.84.2-fork.2`) to pin.

## Getting started

```sh
pi            # interactive mode; authenticate a provider on first run
pi -p "..."   # one-shot prompt
```

Usage, providers, extensions, skills, and themes work exactly as upstream — see [pi.dev/docs](https://pi.dev/docs/latest). The rest of this README covers what the fork adds on top.

## What the fork adds

### Session reliability

Session files are validated and repaired instead of silently mis-loading:

```sh
$ pi --validate-session ~/.pi/agent/sessions/--.../2026-08-23T..._....jsonl
error torn-tail: final line is incomplete JSON (412 bytes); likely torn by an interrupted append (line 210)
1 error, 0 warnings
```

- Structural validation: torn tails, malformed lines, duplicate ids, broken/cyclic ancestry, orphan and duplicate tool results, off-path compactions, interrupted turns — reported with entry/line locations; loading itself stays tolerant.
- Interrupted-turn repair: resuming a session that crashed mid-tool-call appends terminal tool results for the dangling calls (append-only — history is never rewritten), so strict providers like Anthropic accept the next request.
- The context projector is a pure, golden-tested module (`core/sessions/`), pinning current behavior as the equivalence baseline for future work.

### Tool runtime

- Optional per-tool `timeoutMs` on `AgentTool`, enforced in the agent loop (stdlib `AbortSignal.any`/`AbortSignal.timeout`); a tool that exceeds its deadline gets a terminal timeout error result, and tools that never settle still terminate.
- Tool result text sent to the model is bounded (default 200 KB, `tools.maxToolOutputBytes` in settings; `<= 0` disables). Oversized output keeps a head+tail excerpt with an omitted-bytes marker; the full output spills to `<sessionDir>/artifacts/<sessionId>/` for persisted sessions.

### Permissions (opt-in)

Legacy behavior is the default. Opt in with `tools.permissions` in settings:

```json
{
  "tools": {
    "permissions": {
      "mode": "policy",
      "profile": "review",
      "rules": [{ "tool": "bash", "command": "git", "effect": "allow" }]
    }
  }
}
```

- Tools carry capability metadata (`filesystem.read`, `filesystem.write`, `process.execute`, `network.access`, `session.modify`).
- Rules match on tool, capability, path prefix, or command prefix; precedence is deny > ask > allow > default, with user rules overriding profile presets.
- `deny` rules with `hide: true` remove a tool from the model-visible tool list entirely.
- Profiles: `code` (default, everything), `review` (read-only), `minimal` (core editing tools only) — plain rule presets, no mode checks scattered through the runtime.

### Diagnostics

Session stats (`/session` panel) report tool output volume, truncated bytes, and artifact counts alongside the existing token/cache/cost stats.

## Relationship to upstream

Pi is built by [Mario Zechner (badlogic)](https://github.com/badlogic) and [earendil works](https://github.com/earendil-works) — this fork builds on their work and merges upstream regularly rather than diverging:

- Upstream's README is preserved verbatim at [docs/fork/upstream-README.md](docs/fork/upstream-README.md); upstream README changes get ported into this one during syncs.
- The [fork ledger](docs/fork/upstream-integration.md) records every decision, every changed upstream file, and the sync procedure.
- Contributions and bug reports for core Pi belong upstream ([CONTRIBUTING.md](CONTRIBUTING.md), [Discord](https://discord.com/invite/3cU7Bz4UPx), [pi.dev](https://pi.dev)).

For stronger isolation than permission policies, containerization patterns (Gondolin micro-VM, Docker, OpenShell) are documented in [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md).

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

Manual, fork-only: Actions → **Fork Release** → Run workflow (empty version = `<upstream-version>-fork.<run number>`). The workflow builds the workspace, publishes all public packages as `@r-dson/*` to GitHub Packages, attaches a self-contained `pi-fork.tgz` to the GitHub Release, and tags `v<version>`. Repo manifests are never modified; the scope rename happens at publish time. Details: [docs/fork/install-from-github.md](docs/fork/install-from-github.md).

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- Fork publishes exclude the shrinkwrap (it pins upstream package names that do not exist on the fork registry); dependency integrity comes from exact version pins in the published manifests.
- Pre-release smoke: `npm run release:local` builds an unpublished release (isolated npm and Bun installs outside the repo) for manual testing.
- Installs use `--ignore-scripts`; CI installs with `npm ci --ignore-scripts`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
