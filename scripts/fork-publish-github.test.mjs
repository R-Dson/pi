import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { rewriteForkManifest, stagePackageDirectory } from "./fork-publish-github.mjs";

test("rewriteForkManifest renames the scope, sets the version, and pins workspace deps exactly", () => {
	const manifest = {
		name: "@earendil-works/pi-coding-agent",
		version: "0.84.2",
		bin: { pi: "dist/bundle/cli.js" },
		files: ["dist", "docs", "CHANGELOG.md", "npm-shrinkwrap.json"],
		engines: { node: ">=22.19.0" },
		dependencies: {
			"@earendil-works/pi-agent-core": "^0.84.2",
			"@earendil-works/pi-ai": "^0.84.2",
			chalk: "5.6.2",
		},
		peerDependencies: {
			"@earendil-works/pi-protocol": "^0.84.2",
		},
		optionalDependencies: {
			"@earendil-works/pi-telemetry": "^0.84.2",
			"@mariozechner/clipboard": "0.3.9",
		},
		devDependencies: {
			"@earendil-works/pi-tui": "^0.84.2",
			typescript: "5.9.3",
		},
	};

	const rewritten = rewriteForkManifest(manifest, { version: "0.84.2-fork.7", scopeOwner: "r-dson" });

	assert.equal(rewritten.name, "@r-dson/pi-coding-agent");
	assert.equal(rewritten.version, "0.84.2-fork.7");
	assert.deepEqual(rewritten.dependencies, {
		"@r-dson/pi-agent-core": "0.84.2-fork.7",
		"@r-dson/pi-ai": "0.84.2-fork.7",
		chalk: "5.6.2",
	});
	assert.deepEqual(rewritten.peerDependencies, { "@r-dson/pi-protocol": "0.84.2-fork.7" });
	assert.deepEqual(rewritten.optionalDependencies, {
		"@r-dson/pi-telemetry": "0.84.2-fork.7",
		"@mariozechner/clipboard": "0.3.9",
	});
	assert.deepEqual(rewritten.devDependencies, {
		"@r-dson/pi-tui": "0.84.2-fork.7",
		typescript: "5.9.3",
	});
	assert.deepEqual(rewritten.bin, { pi: "dist/bundle/cli.js" });
	assert.deepEqual(rewritten.files, ["dist", "docs", "CHANGELOG.md", "npm-shrinkwrap.json"]);
	assert.deepEqual(rewritten.engines, { node: ">=22.19.0" });
});

test("rewriteForkManifest returns a new manifest and leaves the input untouched", () => {
	const manifest = {
		name: "@earendil-works/pi-ai",
		version: "0.84.2",
		dependencies: {
			"@earendil-works/pi-telemetry": "^0.84.2",
			typebox: "1.3.7",
		},
	};

	const rewritten = rewriteForkManifest(manifest, { version: "0.85.0-fork.1", scopeOwner: "r-dson" });

	assert.notEqual(rewritten, manifest);
	assert.notEqual(rewritten.dependencies, manifest.dependencies);
	assert.equal(manifest.name, "@earendil-works/pi-ai");
	assert.equal(manifest.version, "0.84.2");
	assert.deepEqual(manifest.dependencies, {
		"@earendil-works/pi-telemetry": "^0.84.2",
		typebox: "1.3.7",
	});
});

test("rewriteForkManifest leaves foreign-scope and unscoped names untouched", () => {
	const manifest = {
		name: "pi",
		version: "1.0.0",
		dependencies: {
			"@mariozechner/clipboard": "0.3.9",
			"@types/node": "22.19.19",
		},
	};

	const rewritten = rewriteForkManifest(manifest, { version: "1.0.0-fork.1", scopeOwner: "r-dson" });

	assert.equal(rewritten.name, "pi");
	assert.deepEqual(rewritten.dependencies, {
		"@mariozechner/clipboard": "0.3.9",
		"@types/node": "22.19.19",
	});
});

test("stagePackageDirectory copies shippable content and excludes dev artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-stage-"));
	try {
		const source = join(root, "packages", "fixture-pkg");
		const files = [
			["package.json", "{}"],
			["README.md", "# fixture"],
			["CHANGELOG.md", "# Changelog"],
			["dist/index.js", "export {};"],
			["docs/guide.md", "# Guide"],
			["native/win32/src/native.c", "int main() { return 0; }"],
			["npm-shrinkwrap.json", "{}"],
			["src/index.ts", "export {};"],
			["test/index.test.ts", "export {};"],
			["node_modules/chalk/index.js", "export {};"],
			["dist/node_modules/stale/index.js", "export {};"],
			["install-lock/package.json", "{}"],
			[".turbo/cache.txt", "stale"],
		];
		for (const [file, content] of files) {
			await mkdir(dirname(join(source, file)), { recursive: true });
			await writeFile(join(source, file), content);
		}

		const dest = join(root, "staged", "fixture-pkg");
		stagePackageDirectory(source, dest);

		const kept = [
			"package.json",
			"README.md",
			"CHANGELOG.md",
			"dist/index.js",
			"docs/guide.md",
			"native/win32/src/native.c",
		];
		for (const file of kept) {
			assert.ok(existsSync(join(dest, file)), `expected ${file} to be staged`);
		}

		const excluded = ["npm-shrinkwrap.json", "src", "test", "node_modules", "install-lock", ".turbo", "dist/node_modules"];
		for (const file of excluded) {
			assert.ok(!existsSync(join(dest, file)), `expected ${file} to be excluded`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
