# model-handoff

The active model hands the whole conversation to another configured tier,
mid-run, by calling `switch_model`. Same transcript, same tool state: a baton
pass, not a subagent. Spec: [#106](https://github.com/R-Dson/pi/issues/106).

## What happens on a handoff

The model calls `switch_model` with a tier name, a reason, and optionally a
brief. The extension switches the session model through the public
`pi.setModel`; because the agent loop re-reads the session model before every
provider request, the very next assistant turn of the same run comes from the
target tier. The tool result is the baton: it names who handed off, why, and
the brief, and is the first thing the incoming model reads. The switch has the
same side effects as a manual one: a `model_change` session entry, a
`model_select` event, and an announced `model-change` cache invalidation.

## Configuration

`~/.pi/agent/handoff.json` (machine-wide; `PI_HANDOFF_GLOBAL` overrides the
path as a test seam), plus `.pi/handoff.json` in trusted projects. Tiers merge
and the project file wins on a name collision. At least two registry-resolvable
tiers are required; otherwise the built-in stays inactive with a warning.

```json
{
	"tiers": {
		"fast": { "provider": "deepseek", "modelId": "deepseek-chat", "description": "mechanical edits" },
		"smart": { "provider": "anthropic", "modelId": "claude-opus-4-5", "description": "plans and reviews" }
	}
}
```

Tier names become the `target` enum, so the model can only name configured
tiers. Descriptions feed the tool description; the model reads them to choose.

## Refusals

A call changes nothing when: the target tier is already the active model; the
target held the baton earlier in the same settled run (bounce guard, tracking
every holder, reset at the first `agent_start` after an `agent_settled`); the
target provider has no credentials; or the tier is gone from the model registry
at call time (re-resolved on every call). Each refusal explains itself in the
tool result.

## returnAfterRun

`switch_model` accepts `returnAfterRun: true`: the calling model is recorded
in a single pending-return slot, and when the run settles (`agent_settled`,
not `agent_end`, which fires per loop iteration) the extension switches back
through the normal setModel path. A later handoff replaces the slot (flag) or
cancels it (no flag); a manual switch by the user (a `model_select` this
extension did not initiate) cancels it; the returning model is never prompted
automatically. The slot is memory only: a crash drops it and resume restores
the delegatee through the recorded model change.

## State and lifecycle

All state lives at factory scope (never module scope, which would leak across
session switches; never inside `session_start`, which the test harness
re-fires on one runner): the bounce-guard holder set, the pending-return slot,
and the in-flight target key that distinguishes this extension's model
switches from the user's. A merged tier set that drops below two tiers
deactivates by subtracting the tool from the active list; reactivation is
scoped to this extension's own deactivation so an earlier-loaded extension's
removal (a permission-policies hide rule) survives.

## Rendering

The transcript call row shows the tier, its model, and the reason on one line
(`Handoff -> fast (provider/model): reason`), with the brief on expansion. The
brief stays out of the collapsed row because HTML export renders calls
collapsed; it reaches export through the result text.

## Tests

`packages/coding-agent/test/suite/model-handoff.test.ts` covers activation,
the baton, all refusal paths, return semantics, project config, and the settle
window, on the harness with the faux provider.
