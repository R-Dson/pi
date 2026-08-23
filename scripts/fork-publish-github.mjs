#!/usr/bin/env node

// Fork-only publisher: stages every public workspace package, rewrites its manifest
// from @earendil-works/* to @<scope-owner>/* with the fork release version, and
// publishes to the GitHub Packages npm registry. Repo manifests are never modified.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STAGING_ROOT = join(REPO_ROOT, ".fork-publish");
const UPSTREAM_SCOPE = "@earendil-works/";
const DEFAULT_REGISTRY = "https://npm.pkg.github.com";
const DEFAULT_SCOPE_OWNER = "r-dson";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

// npm-shrinkwrap.json must never ship in a fork publish: npm forces it into the
// tarball and it pins @earendil-works/* names that do not exist on the fork registry.
// src/test/tests/install-lock only ever appear at a package root, so excluding them
// at any depth would also strip shipped nested sources (packages/tui/native/*/src).
// node_modules can nest anywhere, dotfiles never ship; the staging .npmrc is written
// by this script after staging, not copied from the source package.
const EXCLUDED_ROOT_ENTRIES = new Set(["src", "test", "tests", "install-lock", "npm-shrinkwrap.json"]);
const EXCLUDED_ANYWHERE = new Set(["node_modules"]);

export function rewriteForkManifest(manifest, { version, scopeOwner }) {
	const rewritten = { ...manifest, version };

	if (typeof manifest.name === "string" && manifest.name.startsWith(UPSTREAM_SCOPE)) {
		rewritten.name = `@${scopeOwner}/${manifest.name.slice(UPSTREAM_SCOPE.length)}`;
	}

	for (const section of DEPENDENCY_SECTIONS) {
		const dependencies = manifest[section];
		if (dependencies === undefined) {
			continue;
		}

		const entries = {};
		for (const [name, specifier] of Object.entries(dependencies)) {
			if (name.startsWith(UPSTREAM_SCOPE)) {
				entries[`@${scopeOwner}/${name.slice(UPSTREAM_SCOPE.length)}`] = version;
			} else {
				entries[name] = specifier;
			}
		}
		rewritten[section] = entries;
	}

	return rewritten;
}

export function stagePackageDirectory(sourceDir, destDir) {
	cpSync(sourceDir, destDir, {
		recursive: true,
		filter: (source) => {
			const segments = relative(sourceDir, source).split(sep);
			const [first, ...rest] = segments;
			if (first === "") {
				return true;
			}
			if (first.startsWith(".") || EXCLUDED_ANYWHERE.has(first)) {
				return false;
			}
			if (rest.length === 0 && EXCLUDED_ROOT_ENTRIES.has(first)) {
				return false;
			}
			return !rest.some((segment) => segment.startsWith(".") || EXCLUDED_ANYWHERE.has(segment));
		},
	});
}

function parseArgs(args) {
	const options = {
		version: undefined,
		auto: undefined,
		dryRun: false,
		registry: DEFAULT_REGISTRY,
		scopeOwner: DEFAULT_SCOPE_OWNER,
	};
	const valueArgs = {
		"--version": "version",
		"--auto": "auto",
		"--registry": "registry",
		"--scope-owner": "scopeOwner",
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}

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

	if ((options.version === undefined) === (options.auto === undefined)) {
		throw new Error(`Pass exactly one of --version <semver> or --auto <run-number>\n${usage()}`);
	}

	return options;
}

function usage() {
	return "Usage: node scripts/fork-publish-github.mjs (--version <semver> | --auto <run-number>) [--dry-run] [--registry <url>] [--scope-owner <owner>]";
}

function resolveVersion(options, packages) {
	if (options.version !== undefined) {
		if (!SEMVER_PATTERN.test(options.version)) {
			throw new Error(`Invalid version (expected x.y.z with optional -prerelease): ${options.version}`);
		}
		return options.version;
	}

	if (!/^\d+$/.test(options.auto)) {
		throw new Error(`Invalid run number: ${options.auto}`);
	}

	const versions = [...new Set(packages.map((pkg) => pkg.version))];
	if (versions.length !== 1) {
		throw new Error(`Public packages are not lockstep versioned: ${versions.join(", ")}`);
	}

	return `${versions[0]}-fork.${options.auto}`;
}

function npmrcContent(registry, scopeOwner, token) {
	const lines = [`@${scopeOwner}:registry=${registry}`];
	if (token) {
		lines.push(`//${new URL(registry).host}/:_authToken=${token}`);
	}
	return `${lines.join("\n")}\n`;
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

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function isPublished(directory, name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		cwd: directory,
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
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
	const packages = getPublicWorkspacePackages();
	const version = resolveVersion(options, packages);

	const token = process.env.NODE_AUTH_TOKEN;
	if (!options.dryRun && !token) {
		throw new Error("NODE_AUTH_TOKEN is not set; refusing to publish. Set it or pass --dry-run.");
	}

	const staged = packages.map((pkg) => {
		if (!pkg.name.startsWith(UPSTREAM_SCOPE)) {
			throw new Error(`Public package is not in the ${UPSTREAM_SCOPE} scope: ${pkg.name}`);
		}
		return {
			...pkg,
			stagingDir: join(STAGING_ROOT, basename(pkg.directory)),
			forkName: `@${options.scopeOwner}/${pkg.name.slice(UPSTREAM_SCOPE.length)}`,
		};
	});

	const basenames = staged.map((pkg) => basename(pkg.directory));
	if (new Set(basenames).size !== basenames.length) {
		throw new Error(`Duplicate package directory basenames: ${basenames.join(", ")}`);
	}

	console.log(
		`Staging ${staged.length} packages as @${options.scopeOwner}/* at ${version} for ${options.registry}${options.dryRun ? " (dry run)" : ""}\n`,
	);

	rmSync(STAGING_ROOT, { recursive: true, force: true });
	mkdirSync(STAGING_ROOT, { recursive: true });

	for (const pkg of staged) {
		// Dry run intentionally skips the dist assertion so staging and manifest
		// rewriting can be exercised without a full build.
		if (!options.dryRun) {
			assertBuildOutputExists(pkg.directory);
		}

		stagePackageDirectory(pkg.directory, pkg.stagingDir);
		const manifest = rewriteForkManifest(JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8")), {
			version,
			scopeOwner: options.scopeOwner,
		});
		writeFileSync(join(pkg.stagingDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		writeFileSync(join(pkg.stagingDir, ".npmrc"), npmrcContent(options.registry, options.scopeOwner, token));
	}

	const summary = {
		version,
		registry: options.registry,
		scopeOwner: options.scopeOwner,
		dryRun: options.dryRun,
		packages: [],
	};

	for (const pkg of staged) {
		const packed = validatePack(pkg.stagingDir);
		console.log(`${pkg.forkName}@${version}`);
		console.log(`  ${packed.filename}: ${packed.fileCount} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
		summary.packages.push({ name: pkg.forkName, version, outcome: "staged", ...packed });
		console.log();
	}

	writeFileSync(join(STAGING_ROOT, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);

	if (options.dryRun) {
		console.log(`Dry run complete; staged packages and summary.json are in ${STAGING_ROOT}`);
		return;
	}

	console.log("All packages validated; starting publication.\n");

	for (const entry of summary.packages) {
		const pkg = staged.find((candidate) => candidate.forkName === entry.name);
		if (isPublished(pkg.stagingDir, entry.name, version)) {
			console.log(`Skipping ${entry.name}@${version}: already published\n`);
			entry.outcome = "skipped-existing";
			continue;
		}

		run("npm", ["publish", "--access", "public", "--ignore-scripts"], { cwd: pkg.stagingDir });
		console.log(`Published ${entry.name}@${version}\n`);
		entry.outcome = "published";
	}

	writeFileSync(join(STAGING_ROOT, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);
	console.log(`Publication complete; summary written to ${join(STAGING_ROOT, "summary.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
