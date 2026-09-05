import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForForkUpdate } from "../src/core/update-check.ts";

describe("checkForForkUpdate", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns a notice when the latest release is newer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ tag_name: "v0.86.0-fork.1" })),
		);
		const notice = await checkForForkUpdate("0.85.4-fork.4");
		expect(notice).toContain("0.86.0-fork.1");
		expect(notice).toContain("pi update --self");
	});

	it("returns undefined when up to date or older", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ tag_name: "v0.85.4-fork.4" })),
		);
		expect(await checkForForkUpdate("0.85.4-fork.4")).toBeUndefined();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ tag_name: "v0.85.4-fork.1" })),
		);
		expect(await checkForForkUpdate("0.85.4-fork.4")).toBeUndefined();
	});

	it("returns undefined for malformed payloads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ tag_name: "not-semver" })),
		);
		expect(await checkForForkUpdate("0.85.4-fork.4")).toBeUndefined();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		expect(await checkForForkUpdate("0.85.4-fork.4")).toBeUndefined();
	});

	it("returns undefined when the endpoint errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("rate limited", { status: 403 })),
		);
		expect(await checkForForkUpdate("0.85.4-fork.4")).toBeUndefined();
	});

	it("returns undefined when the network fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		expect(await checkForForkUpdate("0.85.4-fork.4")).toBeUndefined();
	});

	it("aborts a hung connection and returns undefined", async () => {
		vi.useFakeTimers();
		try {
			// Hangs forever unless the fetch carries an abort signal that fires.
			vi.stubGlobal(
				"fetch",
				vi.fn(
					(_url: unknown, opts?: { signal?: AbortSignal }) =>
						new Promise((_resolve, reject) => {
							if (!opts?.signal) return; // never settles
							opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
						}),
				),
			);
			const pending = checkForForkUpdate("0.85.4-fork.4");
			vi.advanceTimersByTime(10_000);
			await expect(pending).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
