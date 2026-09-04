#!/usr/bin/env node

// Fork-only packager: stages a self-contained @r-dson/pi-standalone package from
// the coding-agent release bundle and packs it to a stable pi-fork.tgz. The bundle
// inlines every workspace package except the ones the bundler keeps external
// (chord: its worker and bundler entry URLs must stay real files) — those are
// vendored into the tarball as bundled dependencies instead, with their own
// dependencies hoisted to the root manifest (npm never reifies a bundled
// package's dependency closure). The remaining dependencies are non-workspace
// (verbatim pins) and installs resolve them from the public npm registry — no
// GitHub authentication, no registry configuration.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UPSTREAM_SCOPE = "@earendil-works/";
const STANDALONE_NAME = "@r-dson/pi-standalone";
const CODING_AGENT_DIR = join(REPO_ROOT, "packages", "coding-agent");
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Sections copied verbatim from the source manifest when present. description,
// license, and type are scalars; engines and overrides are objects (overrides
// nests, so object sections are deep-copied). The overrides pin known-bad
// transitives (protobufjs, rimraf) that the excluded shrinkwrap would otherwise
// cover; their keys reference external packages only, so no scope rewrite.
const COPIED_SECTIONS = ["description", "license", "type", "engines", "overrides"];

export function deriveStandaloneManifest(manifest, { version, bundledDependencies = {}, vendoredDependencies = {} }) {
	const filterWorkspaceDeps = (deps) => {
		const filtered = {};
		for (const [name, specifier] of Object.entries(deps ?? {})) {
			if (!name.startsWith(UPSTREAM_SCOPE)) {
				filtered[name] = specifier;
			}
		}
		return filtered;
	};

	// The CLI reads package-relative assets at runtime (themes, export templates,
	// assets, docs, examples) outside dist/bundle, so the standalone ships the
	// same file set as the upstream npm package, minus the shrinkwrap.
	// bundledDependencies (the bundler's external workspace packages) are also
	// declared as regular dependencies and physically vendored under
	// node_modules/ by stageStandaloneDirectory, so installs never resolve them
	// from a registry: npm uses the bundled copy. npm does not reify a bundled
	// package's own dependencies, so vendoredDependencies hoists their pinned
	// specs into the manifest's dependencies for registry resolution — and the
	// staged vendored manifest drops them (see stageStandaloneDirectory), or
	// npm skips extracting the root-level copies entirely.
	const derived = {
		name: STANDALONE_NAME,
		version,
		bin: { pi: "dist/bundle/cli.js" },
		files: ["dist", "docs", "examples", "containerization.md", "CHANGELOG.md"],
		dependencies: {
			...filterWorkspaceDeps(manifest.dependencies),
			...vendoredDependencies,
			...bundledDependencies,
		},
		optionalDependencies: filterWorkspaceDeps(manifest.optionalDependencies),
	};

	if (Object.keys(bundledDependencies).length > 0) {
		derived.bundleDependencies = Object.keys(bundledDependencies);
	}

	if (Object.keys(derived.optionalDependencies).length === 0) {
		delete derived.optionalDependencies;
	}

	for (const section of COPIED_SECTIONS) {
		if (manifest[section] !== undefined) {
			derived[section] = typeof manifest[section] === "object" ? structuredClone(manifest[section]) : manifest[section];
		}
	}

	return derived;
}

export function stageStandaloneDirectory(sourcePackageDir, packDirectory, manifest, bundledPackageDirs = {}) {
	rmSync(packDirectory, { recursive: true, force: true });
	mkdirSync(packDirectory, { recursive: true });
	for (const entry of ["dist", "docs", "examples", "containerization.md", "CHANGELOG.md"]) {
		const source = join(sourcePackageDir, entry);
		if (existsSync(source)) {
			cpSync(source, join(packDirectory, entry), { recursive: true });
		}
	}
	for (const [packageName, packageDir] of Object.entries(bundledPackageDirs)) {
		// Stage each vendored package under node_modules/<name> with package.json
		// plus its own `files` entries, matching what npm pack would include for
		// it as a bundled dependency.
		const packageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		const target = join(packDirectory, "node_modules", packageName);
		mkdirSync(target, { recursive: true });
		for (const entry of packageManifest.files ?? []) {
			const source = join(packageDir, entry);
			if (existsSync(source)) {
				cpSync(source, join(target, entry), { recursive: true });
			}
		}
		// The staged manifest drops the vendored package's `dependencies`. npm
		// counts a bundled package's dependency closure as covered by the
		// bundle, so leaving them declared makes npm skip extracting the
		// root-level copies: v0.85.0-fork.8 installs on npm 11.13 shipped an
		// empty node_modules/esbuild and crashed at startup (chord imports
		// esbuild; the requirement is identical at the root, so npm deduped
		// the extraction away). Every dependency is hoisted into the root
		// manifest's dependencies by deriveStandaloneManifest, and Node still
		// resolves them from the root node_modules for the vendored code.
		const unhoisted = Object.keys(packageManifest.dependencies ?? {}).filter(
			(name) => manifest.dependencies?.[name] === undefined,
		);
		if (unhoisted.length > 0) {
			throw new Error(
				`Vendored ${packageName} declares dependencies not hoisted into the standalone manifest: ${unhoisted.join(", ")}`,
			);
		}
		const staged = { ...packageManifest };
		delete staged.dependencies;
		writeFileSync(join(target, "package.json"), `${JSON.stringify(staged, null, "\t")}\n`);
	}
	writeFileSync(join(packDirectory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

function parseArgs(args) {
	const options = {
		version: undefined,
		packDirectory: join(REPO_ROOT, ".fork-publish", "standalone"),
		output: join(REPO_ROOT, ".fork-publish", "pi-fork.tgz"),
	};
	const valueArgs = {
		"--version": "version",
		"--pack-directory": "packDirectory",
		"--output": "output",
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const key = valueArgs[arg];
		if (key === undefined) {
			throw new Error(`Unknown argument: ${arg}\n${usage()}`);
		}

		const value = args[++index];
		if (value === undefined) {
			throw new Error(`Missing value for ${arg}\n${usage()}`);
		}
		options[key] = value;
	}

	if (options.version === undefined) {
		throw new Error(`--version <semver> is required\n${usage()}`);
	}
	if (!SEMVER_PATTERN.test(options.version)) {
		throw new Error(`Invalid version (expected x.y.z with optional -prerelease): ${options.version}`);
	}

	return options;
}

function usage() {
	return "Usage: node scripts/fork-standalone-package.mjs --version <semver> [--pack-directory <dir>] [--output <path>]";
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function pack(directory) {
	const result = run("npm", ["pack", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	// npm emits either an array (npm <=11.0) or an object keyed by package name (npm >=11.1).
	const parsed = JSON.parse(result.stdout);
	const packed = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
	if (!packed || typeof packed !== "object") {
		throw new Error(`Unexpected npm pack output shape in ${directory}`);
	}
	return {
		filename: packed.filename,
		fileCount: packed.files.length,
		size: packed.size,
		unpackedSize: packed.unpackedSize,
	};
}

function main() {
	const options = parseArgs(process.argv.slice(2));

	const bundleEntry = join(CODING_AGENT_DIR, "dist", "bundle", "cli.js");
	if (!existsSync(bundleEntry)) {
		throw new Error(`${relative(REPO_ROOT, bundleEntry)} does not exist. Run npm run build before packaging the standalone tarball.`);
	}

	const sourceManifest = JSON.parse(readFileSync(join(CODING_AGENT_DIR, "package.json"), "utf8"));
	// The bundler keeps chord external (real worker/bundler entry files), so the
	// standalone tarball vendors it — see the header comment.
	const CHORD_DIR = join(REPO_ROOT, "packages", "chord");
	const chordEntry = join(CHORD_DIR, "dist", "index.js");
	if (!existsSync(chordEntry)) {
		throw new Error(`${relative(REPO_ROOT, chordEntry)} does not exist. Run npm run build before packaging the standalone tarball.`);
	}
	const chordManifest = JSON.parse(readFileSync(join(CHORD_DIR, "package.json"), "utf8"));
	const bundledDependencies = { "@earendil-works/chord": chordManifest.version };
	const manifest = deriveStandaloneManifest(sourceManifest, {
		version: options.version,
		bundledDependencies,
		vendoredDependencies: chordManifest.dependencies ?? {},
	});

	const packDirectory = resolve(REPO_ROOT, options.packDirectory);
	const output = resolve(REPO_ROOT, options.output);
	// Only the standalone staging directory is wiped, never .fork-publish itself:
	// the release workflow still reads .fork-publish/summary.json afterwards.
	stageStandaloneDirectory(CODING_AGENT_DIR, packDirectory, manifest, {
		"@earendil-works/chord": CHORD_DIR,
	});

	const packed = pack(packDirectory);
	mkdirSync(dirname(output), { recursive: true });
	renameSync(join(packDirectory, packed.filename), output);

	console.log(`${STANDALONE_NAME}@${options.version} -> ${relative(REPO_ROOT, output)}`);
	console.log(`  ${packed.fileCount} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
	console.log("Dependencies resolved from the public npm registry:");
	for (const [name, specifier] of Object.entries(manifest.dependencies)) {
		if (manifest.bundleDependencies?.includes(name)) {
			console.log(`  ${name}@${specifier} (vendored into the tarball)`);
		} else {
			console.log(`  ${name}@${specifier}`);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
