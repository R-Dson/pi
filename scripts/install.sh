#!/bin/sh
# Installs the pi fork from GitHub Releases; no registry configuration or PAT needed.
#
# Usage:
#   install.sh [version]      install latest release, or a pinned version
#   install.sh --uninstall    remove the fork from the install prefix
#
# PI_INSTALL_PREFIX selects the install prefix (bin in DIR/bin); the default is
# ~/.local for the binary method, npm's global prefix (or ~/.local) for the
# npm method. PI_INSTALL_METHOD=binary|npm forces a method; unset picks the
# prebuilt binary when the platform has one, else the npm tarball.
#
# The binary path needs only curl and tar; npm and node are required only by
# the npm path. No interactive prompts: the script runs under `curl | sh`
# with no tty guarantee, so every decision has a safe default and warnings
# name the command to run instead of asking questions.
set -eu

repo="R-Dson/pi"
package="@r-dson/pi-standalone"
# The bin/pi symlink target (relative, so the prefix stays relocatable).
# Creation, ownership check, and uninstall must share one spelling.
pi_link="../lib/pi-fork/pi"

# Best-effort semver compare for the downgrade warning: exits 0 when $1 > $2.
# Handles x.y.z with an optional -fork.N prerelease (x.y.z > x.y.z-fork.N).
# Unparseable input compares as not-greater; the check is advisory only.
semver_gt() {
  awk 'function norm(v,  parts, base, pre, fields, out, i) {
    sub(/^v/, "", v)
    split(v, parts, "-")
    base = parts[1]
    pre = (parts[2] == "" ? "" : parts[2])
    split(base, fields, ".")
    for (i = 1; i <= 3; i++) out = out sprintf("%012d", fields[i] + 0)
    if (pre == "") return out "2"
    if (pre ~ /^fork\.[0-9]+$/) return out "1" sprintf("%012d", substr(pre, 6) + 0)
    return out "0" pre
  }
  BEGIN { exit !(norm(ARGV[1]) > norm(ARGV[2])) }' "$1" "$2"
}

usage() {
  cat <<'EOF'
Usage: install.sh [version]     install latest release, or a pinned version
       install.sh --uninstall   remove the fork from the install prefix
Env:  PI_INSTALL_PREFIX=DIR     install under DIR (bin in DIR/bin)
      PI_INSTALL_METHOD=METHOD  force binary or npm (default: auto)
EOF
  exit 0
}

# ANSI escapes only when stdout is a tty; `curl | sh` output must stay plain.
c_bold=""; c_green=""; c_yellow=""; c_red=""; c_reset=""
if [ -t 1 ]; then
  c_bold="$(printf '\033[1m')"
  c_green="$(printf '\033[32m')"
  c_yellow="$(printf '\033[33m')"
  c_red="$(printf '\033[31m')"
  c_reset="$(printf '\033[0m')"
fi

step() { printf '%s\n' "${c_bold}$*${c_reset}"; }
success() { printf '%s\n' "${c_green}$*${c_reset}"; }
note() { printf '%s\n' "${c_yellow}note: $*${c_reset}" >&2; }
warn() { printf '%s\n' "${c_yellow}warning: $*${c_reset}" >&2; }

die() {
  printf '%s\n' "${c_red}error: $2${c_reset}" >&2
  exit "$1"
}

# --- Arguments ----------------------------------------------------------------

version=""
want_uninstall=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) want_uninstall=1 ;;
    -h|--help) usage ;;
    -*) die 2 "unknown option: $arg (try --help)" ;;
    *)
      [ -z "$version" ] || die 2 "unexpected extra argument: $arg"
      version="${arg#v}"
      echo "$version" | grep -Eq '^[0-9A-Za-z._-]+$' || die 2 "invalid version: $arg"
      ;;
  esac
done

case "${PI_INSTALL_METHOD:-}" in
  ""|binary|npm) ;;
  *) die 2 "invalid PI_INSTALL_METHOD: ${PI_INSTALL_METHOD} (expected binary or npm)" ;;
esac
forced_method="${PI_INSTALL_METHOD:-}"

# --- Uninstall ----------------------------------------------------------------
# Dispatched before any preflight and before tmpdir setup: removing a binary
# install must work on machines without npm or node, so npm is touched only
# when the bin entry could be an npm install.

if [ "$want_uninstall" = 1 ]; then
  prefix="${PI_INSTALL_PREFIX:-}"
  if [ -z "$prefix" ]; then
    prefix="$HOME/.local"
    # A default npm install may live under npm's global prefix instead of
    # ~/.local; consult it only when ~/.local has nothing, so an npm-less
    # machine stays npm-free.
    if [ ! -e "$prefix/bin/pi" ] && command -v npm >/dev/null 2>&1; then
      candidate="$(npm prefix -g 2>/dev/null || true)"
      if [ -n "$candidate" ] && ! is_version_managed_prefix "$candidate" && [ -e "$candidate/bin/pi" ]; then
        prefix="$candidate"
      fi
    fi
  fi
  bin_dir="$prefix/bin"
  if [ ! -e "$bin_dir/pi" ] && [ ! -L "$bin_dir/pi" ]; then
    die 1 "pi is not installed under $prefix. Nothing removed."
  fi
  if [ -L "$bin_dir/pi" ] && [ "$(readlink "$bin_dir/pi")" = "$pi_link" ]; then
    rm -f "$bin_dir/pi"
    rm -rf "$prefix/lib/pi-fork"
  else
    npm ls -g --prefix "$prefix" --depth=0 "$package" >/dev/null 2>&1 ||
      die 1 "$bin_dir/pi was not installed by this script; nothing removed."
    npm uninstall -g --prefix "$prefix" "$package"
  fi
  success "Uninstalled."
  exit 0
fi

# --- Shared helpers -----------------------------------------------------------

fetch() {
  # curl draws its own meter when stderr is a tty (`curl | sh` keeps stderr on
  # the terminal); -sS keeps piped runs silent while still surfacing errors.
  if [ -t 2 ]; then
    curl -fL "$1" -o "$2"
  else
    curl -fsSL "$1" -o "$2"
  fi
}

starts() {
  # Startup smoke test, not just a version read: --version imports the whole
  # CLI (chord included), so a broken dependency or asset tree surfaces here
  # instead of as a crash on the first real prompt.
  "$bin_dir/pi" --version >/dev/null 2>&1
}

npm_owns() {
  npm ls -g --prefix "$prefix" --depth=0 "$package" >/dev/null 2>&1
}

# Globals under a version-managed prefix (mise/nvm/asdf/volta/fnm) vanish when
# the version manager switches or upgrades node, so they never win as a prefix.
is_version_managed_prefix() {
  case "$1" in
    */.local/share/mise/*|*/.nvm/*|*/.asdf/*|*/.volta/*|*/.fnm/*) return 0 ;;
  esac
  return 1
}

is_binary_install() {
  [ -L "$bin_dir/pi" ] && [ "$(readlink "$bin_dir/pi")" = "$pi_link" ]
}

installed_version() {
  installed="$("$bin_dir/pi" --version 2>/dev/null | tail -n 1 || true)"
  [ -n "$installed" ] || installed="(version unknown)"
}

warn_downgrade() {
  # Advisory only, against the install this run replaces. The latest path
  # needs no check: releases/latest always serves the newest complete
  # release. Must run before the old tree is swapped out.
  if [ -z "$version" ] || [ ! -x "$bin_dir/pi" ]; then
    return 0
  fi
  installed_version
  if semver_gt "$installed" "$version"; then
    warn "downgrade requested: pi ${installed} is installed, but version ${version} was asked for."
    printf '%s\n' "  To keep ${installed}, re-run this script with version ${installed} (or omit the version to track the latest release)." >&2
  fi
}

report() {
  installed_version
  success "Installed pi ${installed} via $method at $bin_dir/pi"

  active_path="$(command -v pi 2>/dev/null || true)"
  if [ "$active_path" = "$bin_dir/pi" ]; then
    printf '%s\n' "Run it with: pi"
  elif [ -n "$active_path" ]; then
    note "your shell resolves pi to $active_path, not the new install."
    printf '%s\n' "  Move $bin_dir earlier in PATH, or add to your shell profile:" >&2
    printf '%s\n' "    export PATH=\"$bin_dir:\$PATH\"" >&2
  else
    printf '%s\n' "pi is not on PATH yet. Add to your shell profile:"
    printf '%s\n' "  export PATH=\"$bin_dir:\$PATH\""
  fi
  printf '%s\n' "Re-run this script any time to upgrade; --uninstall removes it."
}

map_platform() {
  case "$1-$2" in
    Darwin-arm64|Darwin-aarch64) echo darwin-arm64 ;;
    Darwin-x86_64|Darwin-amd64) echo darwin-x64 ;;
    Linux-arm64|Linux-aarch64) echo linux-arm64 ;;
    Linux-x86_64|Linux-amd64) echo linux-x64 ;;
  esac
}

npm_install() {
  if [ "$prefix" = "$npm_global_prefix" ]; then
    npm install -g --ignore-scripts "$tmpdir/pi-fork.tgz"
  else
    mkdir -p "$bin_dir"
    npm install -g --ignore-scripts --prefix "$prefix" "$tmpdir/pi-fork.tgz"
  fi
}

install_binary() {
  step "Installing pi via the prebuilt binary (${platform})"

  # No npm consult on this path: the default is simply ~/.local, and
  # version-managed-prefix exclusion is an npm-only concern.
  prefix="${PI_INSTALL_PREFIX:-$HOME/.local}"
  bin_dir="$prefix/bin"
  [ "$prefix" = "$HOME/.local" ] || printf '%s\n' "Using install prefix: $prefix"

  if ! mkdir -p "$prefix/lib" "$bin_dir" 2>/dev/null; then
    die 1 "cannot create $prefix/lib or $prefix/bin; pick a writable prefix with PI_INSTALL_PREFIX."
  fi
  if [ ! -w "$prefix/lib" ] || [ ! -w "$bin_dir" ]; then
    die 1 "$prefix is not writable; pick another prefix with PI_INSTALL_PREFIX."
  fi

  # Ownership: our own symlink is replaced below; anything else — an npm
  # install or a foreign file — is refused. Switching methods or owners needs
  # an explicit uninstall (or the user's own mv), never a silent clobber.
  if [ -e "$bin_dir/pi" ]; then
    if is_binary_install; then
      :
    elif npm_owns; then
      die 1 "$bin_dir/pi was installed by npm under this prefix. Run 'install.sh --uninstall' first to switch to the binary method."
    else
      die 1 "$bin_dir/pi exists and was not installed by this installer. Move it aside first (it is yours, not this installer's):
  mv \"$bin_dir/pi\" \"${bin_dir}/pi.bak\""
    fi
  fi
  warn_downgrade

  # Stage inside $prefix/lib so the swap never crosses filesystems; the old
  # install is removed only after the new tree is fully extracted.
  stage="$(mktemp -d "$prefix/lib/pi-fork.stage.XXXXXXXX")"
  if ! tar -xzf "$archive" -C "$stage"; then
    die 1 "failed to extract the release tarball; re-run this script."
  fi
  [ -f "$stage/pi/pi" ] ||
    die 1 "the release tarball did not contain pi/pi; nothing was installed."

  # mktemp creates 0700 directories; other users of a shared prefix must be
  # able to traverse the install dir.
  chmod 755 "$stage/pi"
  rm -rf "$prefix/lib/pi-fork"
  mv "$stage/pi" "$prefix/lib/pi-fork"
  # Safe because the pi executable resolves its own real path for asset
  # lookup. Never copy it out of its dir.
  ln -sf "$pi_link" "$bin_dir/pi"

  if ! starts; then
    die 1 "install finished but $bin_dir/pi does not start. Run '$bin_dir/pi --version' to see the error, then re-run this script."
  fi
  report
}

install_npm() {
  if [ -z "$forced_method" ] && [ -z "$platform" ]; then
    step "Installing pi via the npm package (no prebuilt binary for this platform)"
  else
    step "Installing pi via the npm package"
  fi

  command -v npm >/dev/null 2>&1 || die 1 "npm not found. Install Node.js >= 22.19 (https://nodejs.org)."
  node -e 'const [maj,min]=process.versions.node.split(".").map(Number);process.exit(maj>22||(maj===22&&min>=19)?0:1)' ||
    die 1 "Node.js >= 22.19 required, found $(node -p 'process.versions.node' 2>/dev/null || echo unknown). See https://nodejs.org."

  # npm's global prefix when its bin dir is writable, else ~/.local — except a
  # version-managed prefix (mise/nvm/asdf/volta/fnm): globals installed there
  # vanish when the version manager switches or upgrades node, so ~/.local wins.
  npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"
  if is_version_managed_prefix "$npm_global_prefix"; then
    npm_global_prefix=""
  fi
  prefix="${PI_INSTALL_PREFIX:-}"
  if [ -z "$prefix" ]; then
    prefix="$HOME/.local"
    if [ -n "$npm_global_prefix" ] &&
      mkdir -p "$npm_global_prefix/lib" "$npm_global_prefix/bin" 2>/dev/null &&
      [ -w "$npm_global_prefix/bin" ]; then
      prefix="$npm_global_prefix"
    fi
  fi
  bin_dir="$prefix/bin"
  [ "$prefix" = "$npm_global_prefix" ] || printf '%s\n' "Using install prefix: $prefix"

  # Ownership: npm may replace its own install (re-running upgrades in place);
  # a binary-method install or a foreign file is refused.
  if [ -e "$bin_dir/pi" ] && ! npm_owns; then
    if is_binary_install; then
      die 1 "$bin_dir/pi was installed by the binary method. Run 'install.sh --uninstall' first to switch to npm."
    fi
    die 1 "$bin_dir/pi exists and was not installed by npm under this prefix. Move it aside first (it is yours, not this installer's):
  mv \"$bin_dir/pi\" \"${bin_dir}/pi.bak\""
  fi
  warn_downgrade

  if [ -n "$version" ]; then
    url="https://github.com/${repo}/releases/download/v${version}/pi-fork.tgz"
  else
    url="https://github.com/${repo}/releases/latest/download/pi-fork.tgz"
  fi
  # Keep the .tgz suffix on the file: npm infers tarball-vs-directory from the
  # file name.
  step "Downloading ${url}"
  fetch "$url" "$tmpdir/pi-fork.tgz"
  npm_install

  if ! starts; then
    # npm installs of this tarball have landed broken while npm still exits 0
    # (v0.85.0-fork.8: an empty esbuild directory). Removing the package
    # directory and reinstalling from the downloaded tarball has produced a
    # correct tree in every reproduction, so retry once from clean state.
    warn "installed pi failed to start; retrying from a clean package directory."
    rm -rf "${prefix}/lib/node_modules/${package}"
    npm_install
    starts ||
      die 1 "install finished but $bin_dir/pi does not start. Run '$bin_dir/pi --version' to see the error, then re-run this script."
  fi

  [ -x "$bin_dir/pi" ] || die 1 "install finished but $bin_dir/pi is missing; check the npm output above."
  report
}

# --- Main ----------------------------------------------------------------------

command -v curl >/dev/null 2>&1 || die 1 "curl not found."

platform=""
method="$forced_method"
if [ "$method" != npm ]; then
  platform="$(map_platform "$(uname -s)" "$(uname -m)")"
fi
if [ -z "$method" ]; then
  if [ -n "$platform" ]; then
    method=binary
  else
    method=npm
  fi
elif [ "$method" = binary ] && [ -z "$platform" ]; then
  die 1 "no prebuilt binary for this platform; use PI_INSTALL_METHOD=npm."
fi

stage=""
tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
  if [ -n "$stage" ]; then
    rm -rf "$stage"
  fi
}
trap 'cleanup' EXIT

if [ "$method" = binary ]; then
  # Download here, not inside install_binary: a function called from an if
  # condition runs without errexit, so only the fetch (whose failure is the
  # fallback trigger) sits in the conditional; install_binary keeps set -e.
  if [ -n "$version" ]; then
    dl_url="https://github.com/${repo}/releases/download/v${version}/pi-${platform}.tar.gz"
  else
    dl_url="https://github.com/${repo}/releases/latest/download/pi-${platform}.tar.gz"
  fi
  archive="$tmpdir/pi-${platform}.tar.gz"
  step "Downloading ${dl_url}"
  if ! fetch "$dl_url" "$archive"; then
    if [ -n "$forced_method" ]; then
      die 1 "failed to download ${dl_url}"
    fi
    note "binary download failed; falling back to the npm package."
    method=npm
  fi
fi

if [ "$method" = binary ]; then
  install_binary
else
  install_npm
fi
