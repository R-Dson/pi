import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export default function (pi: ExtensionAPI) {
	// TPS is generation throughput: output tokens divided by the time the model
	// was actually streaming, summed per provider request (message_start to
	// message_end). agent_start→agent_end wall time is NOT used — tool
	// execution and queue wait between requests would deflate the number
	// (a 25s bash call inside a run made a ~20 tok/s model read as 3.3).
	let streamingMs = 0;
	let requestStartMs: number | null = null;
	let input = 0;
	let output = 0;
	let reasoning = 0;
	let cacheRead = 0;
	let cacheWrite = 0;

	const reset = () => {
		streamingMs = 0;
		requestStartMs = null;
		input = output = reasoning = cacheRead = cacheWrite = 0;
	};
	reset();

	pi.on("agent_start", reset);

	pi.on("message_start", (event) => {
		if (!isAssistantMessage(event.message)) return;
		// Re-arm even if a previous request never fired message_end (aborted):
		// an unpaired window is dropped, never carried into the next request.
		requestStartMs = Date.now();
	});

	pi.on("message_end", (event) => {
		if (!isAssistantMessage(event.message)) return;
		if (requestStartMs !== null) {
			streamingMs += Date.now() - requestStartMs;
			requestStartMs = null;
		}
		const usage = event.message.usage;
		input += usage.input || 0;
		output += usage.output || 0;
		reasoning += usage.reasoning || 0;
		cacheRead += usage.cacheRead || 0;
		cacheWrite += usage.cacheWrite || 0;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (streamingMs <= 0 || output <= 0) return;

		const streamedSeconds = streamingMs / 1000;
		// usage.reasoning is a provider-reported subset of output; shown only
		// when the provider exposes a breakdown.
		const outputPart =
			reasoning > 0 ? `↓${formatTokens(output)} (${formatTokens(reasoning)} thinking)` : `↓${formatTokens(output)}`;
		const parts = [`${(output / streamedSeconds).toFixed(1)}tok/s`, `↑${formatTokens(input)}`, outputPart];
		if (cacheRead > 0 || cacheWrite > 0) {
			parts.push(`cache r/w ${formatTokens(cacheRead)}/${formatTokens(cacheWrite)}`);
		}
		// Sub-second streams get a second decimal; "0.0s" reads like a bug.
		parts.push(`${streamedSeconds.toFixed(streamingMs < 1000 ? 2 : 1)}s`);
		ctx.ui.notify(parts.join(" "), "info");
	});
}
