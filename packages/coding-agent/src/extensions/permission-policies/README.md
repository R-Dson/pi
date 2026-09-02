# permission-policies

Restrict what the agent may do per project or machine with allow/ask/deny
rules. Core performs no permission enforcement (upstream's stance: permission
flows are extension territory); this built-in is the fork's engine for it.

## Configuration

`~/.pi/agent/permissions.json` (machine-wide) and `.pi/permissions.json`
(project, trusted projects only — a built-in loads in every directory, so an
untrusted checkout's policy file must not steer enforcement). With no policy
file anywhere, the extension is fully inert.

```json
{
	"profile": "review",
	"rules": [
		{ "tool": "bash", "command": "git push", "effect": "deny" },
		{ "capability": "process.execute", "effect": "ask" },
		{ "path": "~/notes", "effect": "deny", "hide": false }
	]
]
```

Rules match tool name, capability, path prefix, or command prefix (token
boundary, normalized paths). Precedence: a matching project rule decides
outright; otherwise the global rules and the profile preset (`code`, `review`,
`minimal`) compose as one base layer under deny > ask > allow — a global rule
can strengthen a profile (deny over its ask/allow) but a global allow cannot
un-deny a profile preset, so put allow-overrides in the project file.

## How it works

At `session_start` the extension re-reads both files and re-applies
visibility: a `deny` rule carrying `hide: true` removes the tool from the
active list, so the model never sees it (a plain `deny` blocks the call but
keeps the tool visible). Visibility changes
land at the next `session_start` or `/reload`. At `tool_call` time every call
is evaluated against the rules regardless of visibility; `deny` blocks with a
reason naming the deciding file, and `ask` opens an interactive approval
dialog when the mode has UI (in print and json modes it blocks with a reason
the model can relay). Trust granted mid-session starts call-time enforcement
at the next tool call.

Handlers run in extension load order (built-ins before discovered
extensions): rules judge the call as this extension sees it, an earlier-loaded
extension may have mutated the arguments, and a later one can still rewrite an
allowed call. Deny and ask rules are the safe use; real isolation needs
containerization (see `docs/containerization.md`).

The rule evaluator ships as exported library API from the package root, so
extension authors reuse the exact semantics;
`examples/extensions/read-only-mode.ts` is the minimal copy-me variant.

## Tests

`packages/coding-agent/test/permission-policies-builtin.test.ts` covers
registration, config gating, trust, precedence, and the ask dialog.
