import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveStandaloneManifest, stageStandaloneDirectory } from "./fork-standalone-package.mjs";

const sourceManifest = {
	name: "@earendil-works/pi-coding-agent",
	version: "0.84.2",
	description: "Coding agent CLI with read, bash, edit, write tools and session management",
	license: "MIT",
	type: "module",
	bin: { pi: "dist/bundle/cli.js" },
	files: ["dist", "docs"],
	scripts: { build: "tsgo" },
	dependencies: {
		"@earendil-works/pi-agent-core": "^0.84.2",
		"@earendil-works/pi-ai": "^0.84.2",
		"@silvia-odwyer/photon-node": "0.3.4",
		chalk: "5.6.2",
		jiti: "2.7.0",
		undici: "8.9.0",
	},
	optionalDependencies: {
		"@earendil-works/pi-telemetry": "^0.84.2",
		"@mariozechner/clipboard": "0.3.9",
	},
	devDependencies: { typescript: "5.9.3" },
	overrides: {
		protobufjs: "7.6.5",
		rimraf: "6.1.2",
		gaxios: {
			rimraf: "6.1.2",
		},
	},
	engines: { node: ">=22.19.0" },
};

test("deriveStandaloneManifest drops workspace deps and keeps foreign deps verbatim", () => {
	const derived = deriveStandaloneManifest(sourceManifest, { version: "0.84.2-fork.7" });

	assert.equal(derived.name, "@r-dson/pi-standalone");
	assert.equal(derived.version, "0.84.2-fork.7");
	assert.deepEqual(derived.dependencies, {
		"@silvia-odwyer/photon-node": "0.3.4",
		chalk: "5.6.2",
		jiti: "2.7.0",
		undici: "8.9.0",
	});
	assert.deepEqual(derived.optionalDependencies, {
		"@mariozechner/clipboard": "0.3.9",
	});
	assert.deepEqual(derived.bin, { pi: "dist/bundle/cli.js" });
	assert.deepEqual(derived.files, ["dist", "docs", "examples", "containerization.md", "CHANGELOG.md"]);
	assert.deepEqual(derived.engines, { node: ">=22.19.0" });
	assert.equal(derived.description, sourceManifest.description);
	assert.equal(derived.license, "MIT");
	assert.equal(derived.type, "module");
});

test("deriveStandaloneManifest carries the overrides block through derivation", () => {
	const manifest = structuredClone(sourceManifest);

	const derived = deriveStandaloneManifest(manifest, { version: "0.84.2-fork.7" });

	// Overrides reference external packages only (no @earendil-works/* keys), so
	// they must survive verbatim: they pin known-bad transitives that the
	// shrinkwrap (excluded from fork publishes) would otherwise cover.
	assert.deepEqual(derived.overrides, {
		protobufjs: "7.6.5",
		rimraf: "6.1.2",
		gaxios: {
			rimraf: "6.1.2",
		},
	});
	// Nested override values must not be shared with the source manifest.
	derived.overrides.gaxios.rimraf = "0.0.0";
	assert.deepEqual(manifest.overrides, sourceManifest.overrides);
});

test("deriveStandaloneManifest carries over nothing but the derived and copied sections", () => {
	const derived = deriveStandaloneManifest(sourceManifest, { version: "0.84.2-fork.7" });

	assert.deepEqual(Object.keys(derived), [
		"name",
		"version",
		"bin",
		"files",
		"dependencies",
		"optionalDependencies",
		"description",
		"license",
		"type",
		"engines",
		"overrides",
	]);
	for (const section of ["scripts", "devDependencies", "main", "exports", "repository", "keywords", "author"]) {
		assert.ok(!(section in derived), `expected ${section} to be absent`);
	}
});

test("deriveStandaloneManifest omits sections the source manifest lacks", () => {
	const derived = deriveStandaloneManifest(
		{ name: "@earendil-works/pi-coding-agent", version: "1.0.0", dependencies: { "@earendil-works/pi-ai": "^1.0.0", chalk: "5.6.2" } },
		{ version: "1.0.0-fork.1" },
	);

	assert.deepEqual(Object.keys(derived), ["name", "version", "bin", "files", "dependencies"]);
	assert.deepEqual(derived.dependencies, { chalk: "5.6.2" });
});

test("deriveStandaloneManifest returns a new manifest and leaves the input untouched", () => {
	const manifest = structuredClone(sourceManifest);

	const derived = deriveStandaloneManifest(manifest, { version: "0.85.0-fork.1" });

	assert.notEqual(derived, manifest);
	assert.notEqual(derived.dependencies, manifest.dependencies);
	assert.notEqual(derived.optionalDependencies, manifest.optionalDependencies);
	assert.notEqual(derived.engines, manifest.engines);
	assert.notEqual(derived.bin, manifest.bin);
	assert.deepEqual(manifest, sourceManifest);
});

test("stageStandaloneDirectory stages dist, docs, and the derived manifest", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-standalone-stage-"));
	try {
		const packageDir = join(root, "source");
		const bundleDir = join(packageDir, "dist", "bundle");
		await mkdir(join(bundleDir, "chunks"), { recursive: true });
		await writeFile(join(bundleDir, "cli.js"), "#!/usr/bin/env node\n");
		await writeFile(join(bundleDir, "chunks", "shared-abc123.js"), "export {};\n");
		// Runtime assets outside the bundle (themes, docs) must ship too.
		await mkdir(join(packageDir, "dist", "modes", "interactive", "theme"), { recursive: true });
		await writeFile(join(packageDir, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
		await mkdir(join(packageDir, "docs"), { recursive: true });
		await writeFile(join(packageDir, "docs", "sdk.md"), "docs\n");
		await writeFile(join(packageDir, "CHANGELOG.md"), "changelog\n");

		// Stale files from a previous staging run must not leak into the tarball.
		const packDirectory = join(root, "staged", "standalone");
		await mkdir(join(packDirectory, "dist", "bundle"), { recursive: true });
		await writeFile(join(packDirectory, "dist", "bundle", "stale.js"), "export {};\n");

		const manifest = deriveStandaloneManifest(sourceManifest, { version: "0.84.2-fork.7" });
		stageStandaloneDirectory(packageDir, packDirectory, manifest);

		assert.ok(existsSync(join(packDirectory, "dist", "bundle", "cli.js")), "expected dist/bundle/cli.js to be staged");
		assert.ok(existsSync(join(packDirectory, "dist", "bundle", "chunks", "shared-abc123.js")), "expected chunks to be staged");
		assert.ok(
			existsSync(join(packDirectory, "dist", "modes", "interactive", "theme", "dark.json")),
			"expected runtime theme assets outside the bundle to be staged",
		);
		assert.ok(existsSync(join(packDirectory, "docs", "sdk.md")), "expected docs to be staged");
		assert.ok(existsSync(join(packDirectory, "CHANGELOG.md")), "expected CHANGELOG to be staged");
		assert.ok(!existsSync(join(packDirectory, "dist", "bundle", "stale.js")), "expected stale staging output to be removed");

		const staged = JSON.parse(readFileSync(join(packDirectory, "package.json"), "utf8"));
		assert.equal(staged.name, "@r-dson/pi-standalone");
		assert.equal(staged.version, "0.84.2-fork.7");
		assert.deepEqual(staged.bin, { pi: "dist/bundle/cli.js" });
		assert.deepEqual(staged.files, ["dist", "docs", "examples", "containerization.md", "CHANGELOG.md"]);
		assert.ok(!("scripts" in staged));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("deriveStandaloneManifest declares vendored packages and hoists their pinned deps", () => {
	const derived = deriveStandaloneManifest(sourceManifest, {
		version: "0.85.0-fork.6",
		bundledDependencies: { "@earendil-works/chord": "0.85.0" },
		vendoredDependencies: { esbuild: "0.28.1" },
	});

	assert.deepEqual(derived.bundleDependencies, ["@earendil-works/chord"]);
	assert.deepEqual(derived.dependencies, {
		"@silvia-odwyer/photon-node": "0.3.4",
		chalk: "5.6.2",
		jiti: "2.7.0",
		undici: "8.9.0",
		esbuild: "0.28.1",
		"@earendil-works/chord": "0.85.0",
	});
});

test("stageStandaloneDirectory vendors bundled packages under node_modules per their files list", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-standalone-bundled-"));
	try {
		const packageDir = join(root, "source");
		await mkdir(join(packageDir, "dist", "bundle"), { recursive: true });
		await writeFile(join(packageDir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
		const chordDir = join(root, "chord");
		await mkdir(join(chordDir, "dist", "context"), { recursive: true });
		await writeFile(join(chordDir, "dist", "index.js"), "export {};\n");
		await writeFile(join(chordDir, "dist", "context", "index.js"), "export {};\n");
		await writeFile(join(chordDir, "README.md"), "chord\n");
		// Outside the files list: must not be staged.
		await writeFile(join(chordDir, "tsconfig.build.json"), "{}\n");
		await writeFile(
			join(chordDir, "package.json"),
			JSON.stringify({
				name: "@earendil-works/chord",
				version: "0.85.0",
				files: ["dist", "README.md"],
				dependencies: { esbuild: "0.28.1" },
			}),
		);

		const manifest = deriveStandaloneManifest(sourceManifest, {
			version: "0.85.0-fork.6",
			bundledDependencies: { "@earendil-works/chord": "0.85.0" },
			vendoredDependencies: { esbuild: "0.28.1" },
		});
		const packDirectory = join(root, "staged");
		stageStandaloneDirectory(packageDir, packDirectory, manifest, { "@earendil-works/chord": chordDir });

		const chordTarget = join(packDirectory, "node_modules", "@earendil-works", "chord");
		assert.ok(existsSync(join(chordTarget, "package.json")), "expected the vendored manifest to be staged");
		assert.ok(existsSync(join(chordTarget, "dist", "context", "index.js")), "expected the files-listed dist to be staged");
		assert.ok(existsSync(join(chordTarget, "README.md")), "expected the files-listed README to be staged");
		assert.ok(!existsSync(join(chordTarget, "tsconfig.build.json")), "expected non-files entries to stay out");

		// The vendored manifest drops `dependencies` (they are hoisted to the
		// root manifest): npm counts a bundled package's dependency closure as
		// covered by the bundle and skips extracting the root-level copies when
		// the vendored manifest still declares them (v0.85.0-fork.8 regression:
		// empty node_modules/esbuild, crash at startup).
		const stagedChord = JSON.parse(readFileSync(join(chordTarget, "package.json"), "utf8"));
		assert.ok(!("dependencies" in stagedChord), "expected the vendored manifest to drop dependencies");
		assert.equal(manifest.dependencies.esbuild, "0.28.1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stageStandaloneDirectory refuses a vendored package with unhoisted dependencies", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-standalone-unhoisted-"));
	try {
		const packageDir = join(root, "source");
		await mkdir(join(packageDir, "dist", "bundle"), { recursive: true });
		await writeFile(join(packageDir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
		const chordDir = join(root, "chord");
		await mkdir(join(chordDir, "dist"), { recursive: true });
		await writeFile(join(chordDir, "dist", "index.js"), "export {};\n");
		await writeFile(
			join(chordDir, "package.json"),
			JSON.stringify({
				name: "@earendil-works/chord",
				version: "0.85.0",
				files: ["dist"],
				dependencies: { esbuild: "0.28.1", "not-hoisted-pkg": "1.0.0" },
			}),
		);

		const manifest = deriveStandaloneManifest(sourceManifest, {
			version: "0.85.0-fork.6",
			bundledDependencies: { "@earendil-works/chord": "0.85.0" },
			vendoredDependencies: { esbuild: "0.28.1" },
		});

		// A vendored dependency missing from the root manifest would be
		// uninstallable (npm skips the bundle closure), so staging must fail
		// loudly instead of shipping a broken tarball.
		assert.throws(
			() => stageStandaloneDirectory(packageDir, join(root, "staged"), manifest, { "@earendil-works/chord": chordDir }),
			/not-hoisted-pkg/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
