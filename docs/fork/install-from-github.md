# Installing the Fork

The fork distributes `pi` from GitHub only. Every release attaches a self-contained npm tarball (`pi-fork.tgz`) to its GitHub Release, and publishes the individual workspace packages to the GitHub Packages registry under the `@r-dson` scope. Nothing is published to npmjs.org.

## Triggering a release

Releases are manual:

1. Open the repo's **Actions** tab and select **Fork Release**.
2. Click **Run workflow**, choose `main` as the branch (the workflow refuses to release from any other ref).
3. Optionally fill **Release version**. Leave it empty for the default `<upstream-version>-fork.<run number>` (for example `0.84.2-fork.42`).

The workflow builds the workspace, verifies the `v<version>` tag does not already exist (before anything is published, so a colliding version fails while the run is still retryable), stages every public package with its manifest rewritten to the fork scope, publishes to GitHub Packages, tags `v<version>`, builds the standalone tarball, and creates the GitHub Release as a draft that is published and marked latest only after `pi-fork.tgz` is attached — `releases/latest/download/pi-fork.tgz` therefore never resolves to a release without its asset. It never modifies tracked files and creates no commits; the only git object it produces is the tag.

## Install (recommended: standalone, no configuration)

The standalone tarball carries the coding-agent release bundle — all workspace packages are already inlined into it — plus only the dependencies that resolve from the public npm registry. No `.npmrc` mapping, no PAT.

The install script is the zero-friction path. It runs preflight checks (curl, npm, Node >= 22.19), picks npm's global prefix when its bin directory is writable and falls back to `~/.local` otherwise (pass `--prefix DIR` or `PI_INSTALL_PREFIX` to choose explicitly), reports any existing `pi` on PATH — a mise-managed or no-fork-suffix (upstream) install gets a warning naming which binary will shadow which — and warns before a downgrade of the install it replaces (warning only; there are no prompts, since `curl | sh` gives no tty guarantee). The tarball downloads to a temp file with `curl` and installs with `npm install -g --ignore-scripts` (works on every npm version), then verifies the installed binary and tells you when PATH resolves `pi` somewhere else. `--uninstall` removes the fork from the install prefix:

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install-fork.sh | sh
```

Pass a release version (with or without the leading `v`) to pin instead of tracking the latest:

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install-fork.sh | sh -s 0.84.2-fork.42
```

The direct npm URL form also works, but npm >= 12 blocks remote-tarball installs by default (`EALLOWREMOTE`), so it needs one opt-in flag:

```sh
npm install -g --allow-remote=all https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz
```

The binary is `pi`, same as upstream; the installed package is `@r-dson/pi-standalone`. Re-running either command upgrades in place.

The asset filename is identical across releases, so `releases/latest/download/pi-fork.tgz` always resolves to the newest release. The tarball itself is served by GitHub Releases over TLS; its dependencies come from the public npm registry only, so installing never touches GitHub authentication.

## Install via GitHub Packages

Secondary channel: use it when you want the individual `@r-dson/*` packages as libraries rather than just the CLI. Unlike the standalone tarball, this channel always requires a PAT (see below).

Map the fork scope to the GitHub Packages registry in your `.npmrc` (usually `~/.npmrc`):

```sh
echo '@r-dson:registry=https://npm.pkg.github.com' >> ~/.npmrc
```

Then install globally:

```sh
npm install -g @r-dson/pi-coding-agent
```

The binary is `pi`, same as upstream.

### Authentication (required)

GitHub Packages always authenticates npm requests, even for public packages — anonymous installs fail with `E401`. Create a [classic PAT](https://github.com/settings/tokens) with the `read:packages` scope (no expiration or a long one is fine; it is only read) and add it to the same `.npmrc`:

```
//npm.pkg.github.com/:_authToken=<PAT>
```

Note: OAuth tokens from `gh auth login` are rejected by the npm registry; it must be a PAT.

## What gets published

- All public workspace packages (9 total), renamed `@earendil-works/X` → `@r-dson/X`. The rename happens at publish time only; repo manifests stay identical to upstream so merges stay clean.
- Inter-package dependencies are rewritten to the `@r-dson` scope and pinned to the exact release version, so a fork install cannot accidentally resolve upstream `@earendil-works` packages from npmjs.org.
- `pi-fork.tgz`, the standalone tarball: a `@r-dson/pi-standalone` package assembled from the coding-agent bundle. Its manifest is derived mechanically from `packages/coding-agent/package.json` — dependencies minus the `@earendil-works/*` entries (verbatim pins), `optionalDependencies`, `overrides`, and `engines` copied — so there is no curated dependency list to keep in sync.
- `npm-shrinkwrap.json` and `install-lock` are excluded from registry publishes: the shrinkwrap pins `@earendil-works/*` names that do not exist on the fork registry. Dependency integrity is partial by design: direct dependencies are pinned exactly in the rewritten manifests, the carried `overrides` block pins the known-bad transitives (`protobufjs`, `rimraf`), and no shrinkwrap ships, so full transitive resolution is npm's.
- Staging also drops `node_modules`, `src`, `test`, and dotfiles; the staged `.npmrc` is written by the publish script itself.

## Versioning scheme

- Lockstep, like upstream: every fork release publishes all packages at one version.
- Default version: `<upstream-version>-fork.<workflow run number>`, for example `0.84.2-fork.42`. The prerelease suffix keeps fork versions distinguishable from upstream releases of the same base.
- Explicit version: pass it in the workflow's **Release version** input (must match `x.y.z` with an optional `-prerelease`).
- Each release tags `v<version>` and creates a GitHub Release with `pi-fork.tgz` attached under that stable name; re-running the workflow for an already-published version skips the existing packages.
