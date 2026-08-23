# Installing the Fork from GitHub Packages

The fork publishes its own npm packages to the GitHub Packages registry (`npm.pkg.github.com`) under the `@r-dson` scope. Nothing is published to npmjs.org.

## Triggering a release

Releases are manual:

1. Open the repo's **Actions** tab and select **Fork Release**.
2. Click **Run workflow**, choose `main` as the branch.
3. Optionally fill **Release version**. Leave it empty for the default `<upstream-version>-fork.<run number>` (for example `0.84.2-fork.42`).

The workflow builds the workspace, stages every public package with its manifest rewritten to the fork scope, publishes to GitHub Packages, then tags `v<version>` and creates a GitHub Release listing the published packages. It never modifies tracked files and creates no commits; the only git object it produces is the tag.

## Installing

Map the fork scope to the GitHub Packages registry in your `.npmrc` (usually `~/.npmrc`):

```sh
echo '@r-dson:registry=https://npm.pkg.github.com' >> ~/.npmrc
```

Then install globally:

```sh
npm install -g @r-dson/pi-coding-agent
```

The binary is `pi`, same as upstream.

### Authentication

GitHub Packages requires authentication even for public-package installs. If `npm install` prompts for credentials or fails with `E401`, create a [classic PAT](https://github.com/settings/tokens) with the `read:packages` scope and add it to the same `.npmrc`:

```
//npm.pkg.github.com/:_authToken=<PAT>
```

## What gets published

- All public workspace packages (9 total), renamed `@earendil-works/X` → `@r-dson/X`. The rename happens at publish time only; repo manifests stay identical to upstream so merges stay clean.
- Inter-package dependencies are rewritten to the `@r-dson` scope and pinned to the exact release version, so a fork install cannot accidentally resolve upstream `@earendil-works` packages from npmjs.org.
- `npm-shrinkwrap.json` and `install-lock` are excluded: the shrinkwrap pins `@earendil-works/*` names that do not exist on the fork registry. Dependency integrity comes from the exact version pins in the rewritten manifests instead.
- Staging also drops `node_modules`, `src`, `test`, and dotfiles; the staged `.npmrc` is written by the publish script itself.

## Versioning scheme

- Lockstep, like upstream: every fork release publishes all packages at one version.
- Default version: `<upstream-version>-fork.<workflow run number>`, for example `0.84.2-fork.42`. The prerelease suffix keeps fork versions distinguishable from upstream releases of the same base.
- Explicit version: pass it in the workflow's **Release version** input (must match `x.y.z` with an optional `-prerelease`).
- Each release tags `v<version>` and creates a GitHub Release; re-running the workflow for an already-published version skips the existing packages.
