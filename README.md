<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>

# Pi

Pi is an interactive, self-extensible coding agent, plus the agent runtime and unified multi-provider LLM API underneath it.

This fork of [earendil-works/pi](https://github.com/earendil-works/pi) merges upstream regularly and changes as little as possible on top of it: sessions that survive crashes, tools with timeouts and output caps, opt-in permission policies. **Out of the box it behaves like upstream**, apart from two safety nets: a 200 KB cap on tool output and automatic repair of crashed sessions. Fork decisions and changed files live in the [fork ledger](docs/fork/upstream-integration.md).

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

Usage, providers, extensions, and everything else match upstream pi ([docs](https://pi.dev/docs/latest)). What follows is what the fork changes.

## What the fork adds

### Session reliability

A session is an append-only JSONL file. If pi dies mid-turn, the file can end with a torn tail or a tool call that never got its result, and resuming then fails because Anthropic rejects a tool call without its result. The fork handles both: a torn tail is skipped on load, and resume appends a final error result to each dangling tool call so the next request is accepted. History is only ever appended to, never rewritten.

`pi --validate-session <file>` reports what is wrong with any session file, with line numbers:

```sh
$ pi --validate-session ~/.pi/agent/sessions/--.../2026-08-23T..._....jsonl
error torn-tail: final line is incomplete JSON (412 bytes); likely torn by an interrupted append (line 210)
1 error, 0 warnings
```

It detects torn tails, malformed lines, duplicate ids, broken or cyclic ancestry, orphaned and duplicate tool results, compactions that summarize from the wrong point in history, and interrupted turns. Loading tolerates all of these; the flag is for diagnosing a session that resumes oddly.

### Tool runtime

- A tool that never settles used to hang the whole run. Tools can now declare `timeoutMs`; past its deadline the call ends in a timeout error and the run continues.
- An extension or MCP tool returning megabytes used to pass all of it to the model. Tool output sent to the model is now capped at 200 KB by default (`tools.maxToolOutputBytes`; 0 or less disables the cap). The model receives a head-and-tail excerpt with an omitted-bytes marker, and the full output spills to a file under `<sessionDir>/artifacts/<sessionId>/` (persisted sessions). Builtin tools already truncate their own output, so in practice this caps tools that don't.
- To see what the caps did to a run, the `/session` panel reports tool output volume, truncated bytes, and artifact file counts.

### Permissions (opt-in)

For runs where the agent should not do everything it can: a read-only review pass, an untrusted repo, a shared machine. Opt in with `tools.permissions` in settings:

```json
{
  "tools": {
    "permissions": {
      "mode": "policy",
      "rules": [{ "tool": "bash", "command": "git push", "effect": "deny" }]
    }
  }
}
```

Policy mode keeps upstream's allow-by-default: rules opt calls out. This one blocks `git push` and changes nothing else.

- Rules match on tool name, capability (`process.execute`, `filesystem.write`, `filesystem.read`, ...), path prefix, or command prefix. Deny beats ask beats allow, and your rules beat the profile's presets. `ask` blocks the call with a reason explaining how to allow it; there is no approval prompt yet.
- Profiles are plain rule presets: `code` (default, everything), `review` (read-only: writes and process execution hidden), `minimal` (read/search tools only; bash, powershell, edit, and write are hidden).
- A `deny` rule with `hide: true` removes the tool from the model's tool list entirely, so the model cannot even try to call it.

## Relationship to upstream

Pi is developed by [Mario Zechner (badlogic)](https://github.com/badlogic) and [earendil works](https://github.com/earendil-works). This fork builds on their work rather than diverging from it:

- Upstream's README is preserved verbatim at [docs/fork/upstream-README.md](docs/fork/upstream-README.md); upstream README changes get ported into this one during syncs.
- The [fork ledger](docs/fork/upstream-integration.md) records every decision, every changed upstream file, and the sync procedure.
- Contributions and bug reports for core Pi belong upstream ([CONTRIBUTING.md](CONTRIBUTING.md), [Discord](https://discord.com/invite/3cU7Bz4UPx), [pi.dev](https://pi.dev)).

The fork's runtime layer was inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

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
