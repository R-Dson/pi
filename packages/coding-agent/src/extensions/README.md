# Built-in extensions

Extensions that ship in the `pi` binary. They load through the same public
extension API as any user extension; nothing here is special-cased in core.

## Layout

| Entry | Owner | What it is |
|---|---|---|
| `codemode/` | upstream | scriptable tool-calling mode |
| `llama/` | upstream | llama.cpp router integration |
| `mcp/` | upstream | MCP server connections |
| `tool-search/` | upstream | on-demand tool discovery |
| `permission-policies/` | fork | config-gated tool permission engine |
| `model-handoff/` | fork | config-gated mid-session model switching |

## How a built-in is registered

`index.ts` exports `builtInExtensions`, an array of `{ name, factory, builtin: true }`
entries (plus `replaceable: true` where a third-party extension may take over a
shared tool, command, or flag name). `main.ts` merges it ahead of
caller-provided factories, so built-ins load before discovered extensions:
their event handlers (for example `tool_call` interception) run first, and a
later-loaded extension can still rewrite what they allowed. A `builtin:` entry
loads as a `builtin:<name>` extension resource: enabled by default, listed by
`pi config`, disable-able with `-<name>` in the `extensions` setting or
`--no-extensions`, loadable explicitly with `-e builtin:<name>`, and hidden
from the startup Extensions list.

`index.ts` is the only upstream-owned file this directory touches (the change
within it is just the `builtInExtensions` array and its imports); everything
else is fork-owned. Upstream merges conflict at most on that file, and an
entry re-adds mechanically. See the fork ledger's placement
ladder row (`docs/fork/upstream-integration.md`) for when a feature belongs
here versus an example extension or core.

## The config-gated pattern

Both fork built-ins are opt-in through config files. Extensions can read
settings (`pi.getSettings()`), but a config file gives this shape instead:

- No config file anywhere: the extension is fully inert. No tool registered,
  no prompt bytes, no call-time decisions. Sessions behave exactly as upstream.
- A project carries its rules in the checkout (`.pi/` file), and trust
  scoping decides whether an untrusted checkout's file is read at all.
- Config present but unusable (fewer tiers than required, no resolvable
  rules): the extension warns once through the UI notify channel and stays
  inactive.
- Config valid: the extension activates at the next `session_start`, which
  fires for every reason (startup, new, resume, fork, reload), so `/reload`
  picks up edits.

Each extension re-reads its config in the `session_start` handler, the only
place with the context (cwd, project trust, model registry) that config
reading needs, and registers or adjusts its tools there. Registration is
idempotent: `registerTool` overwrites by name.

See each folder's README for the extension's behavior and configuration.
