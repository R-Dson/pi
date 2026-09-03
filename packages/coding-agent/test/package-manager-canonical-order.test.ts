import type * as fs from "node:fs";
import type { PathLike } from "node:fs";

type NodeFsModule = typeof fs;

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// readdir order is filesystem-dependent (ext4 htree re-bucketing, cross-machine
// restarts). The local tmpfs enumerates alphabetically, so nondeterminism is
// simulated by reversing dirents under the fixture root on demand.
const readdirSimulation = vi.hoisted(() => ({
	reverse: false,
	root: "",
}));

vi.mock("node:fs", async () => {
	const actual = (await vi.importActual("node:fs")) as NodeFsModule & Record<string, unknown>;
	return {
		...actual,
		readdirSync: ((path: PathLike, options?: unknown) => {
			const entries = actual.readdirSync(path as string, options as { withFileTypes: true });
			const reversable =
				readdirSimulation.reverse &&
				Boolean(options && typeof options === "object" && (options as { withFileTypes?: boolean }).withFileTypes) &&
				String(path).startsWith(readdirSimulation.root);
			return reversable ? [...entries].reverse() : entries;
		}) as typeof actual.readdirSync,
	};
});

import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("DefaultPackageManager canonical ordering under nondeterministic readdir", () => {
	let tempDir: string;
	let agentDir: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		previousHome = process.env.HOME;
		tempDir = join(tmpdir(), `pm-order-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		readdirSimulation.reverse = false;
		readdirSimulation.root = tempDir;
		process.env.HOME = tempDir;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		readdirSimulation.reverse = false;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeFixtures(): void {
		const extDir = join(agentDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "zeta.ts"), "export default function() {}");
		writeFileSync(join(extDir, "mid.ts"), "export default function() {}");
		writeFileSync(join(extDir, "alpha.ts"), "export default function() {}");

		const userSkillsDir = join(agentDir, "skills");
		mkdirSync(join(userSkillsDir, "zeta-skill"), { recursive: true });
		writeFileSync(join(userSkillsDir, "zeta-skill", "SKILL.md"), "---\nname: zeta\ndescription: z\n---\n");
		mkdirSync(join(userSkillsDir, "alpha-skill"), { recursive: true });
		writeFileSync(join(userSkillsDir, "alpha-skill", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n");

		const projectSkillsDir = join(tempDir, ".pi", "skills");
		mkdirSync(join(projectSkillsDir, "y-skill"), { recursive: true });
		writeFileSync(join(projectSkillsDir, "y-skill", "SKILL.md"), "---\nname: y\ndescription: y\n---\n");
		mkdirSync(join(projectSkillsDir, "b-skill"), { recursive: true });
		writeFileSync(join(projectSkillsDir, "b-skill", "SKILL.md"), "---\nname: b\ndescription: b\n---\n");
	}

	function createPackageManager(): DefaultPackageManager {
		return new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
	}

	it("should resolve auto-discovered extensions and skills in path order when readdir enumerates in reverse", async () => {
		writeFixtures();
		readdirSimulation.reverse = true;

		const result = await createPackageManager().resolve();

		expect(result.extensions.map((r) => r.path)).toEqual([
			join(agentDir, "extensions", "alpha.ts"),
			join(agentDir, "extensions", "mid.ts"),
			join(agentDir, "extensions", "zeta.ts"),
		]);
		expect(result.skills.map((r) => r.path)).toEqual([
			join(tempDir, ".pi", "skills", "b-skill", "SKILL.md"),
			join(tempDir, ".pi", "skills", "y-skill", "SKILL.md"),
			join(agentDir, "skills", "alpha-skill", "SKILL.md"),
			join(agentDir, "skills", "zeta-skill", "SKILL.md"),
		]);
	});

	it("should produce the same resolved order across two collections whose readdir order differs", async () => {
		writeFixtures();
		const packageManager = createPackageManager();

		readdirSimulation.reverse = false;
		const forward = await packageManager.resolve();

		readdirSimulation.reverse = true;
		const reversed = await packageManager.resolve();

		expect(reversed.extensions.map((r) => r.path)).toEqual(forward.extensions.map((r) => r.path));
		expect(reversed.skills.map((r) => r.path)).toEqual(forward.skills.map((r) => r.path));
	});

	// #139
	it("should sort discovery groups by path but keep manifest-declared order inside a package", async () => {
		writeFixtures();
		const pkgDir = join(agentDir, "extensions", "zeta-pkg");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "zeta-pkg", pi: { extensions: ["./second.ts", "./first.ts"] } }),
		);
		writeFileSync(join(pkgDir, "second.ts"), "export default function() {}");
		writeFileSync(join(pkgDir, "first.ts"), "export default function() {}");
		readdirSimulation.reverse = true;

		const result = await createPackageManager().resolve();

		// Loose files sort by their own path; the package is one group at its
		// directory path, its entries in manifest order regardless of sorting.
		expect(result.extensions.map((r) => r.path)).toEqual([
			join(agentDir, "extensions", "alpha.ts"),
			join(agentDir, "extensions", "mid.ts"),
			join(agentDir, "extensions", "zeta-pkg", "second.ts"),
			join(agentDir, "extensions", "zeta-pkg", "first.ts"),
			join(agentDir, "extensions", "zeta.ts"),
		]);
	});
});
