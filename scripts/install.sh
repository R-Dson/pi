#!/bin/sh
# Installs the pi fork from GitHub Releases; no registry configuration or PAT needed.
#
# Usage:
#   install.sh [version]      install latest release, or a pinned version
#   install.sh --uninstall    remove the fork from the install prefix
#
# PI_INSTALL_PREFIX selects the install prefix (bin in DIR/bin); default is
# npm's global prefix, or ~/.local when that needs root.
#
# POSIX sh + curl + npm only. No interactive prompts: the script runs under
# `curl | sh` with no tty guarantee, so every decision has a safe default and
# warnings name the command to run instead of asking questions.
set -eu

repo="R-Dson/pi"
package="@r-dson/pi-standalone"

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
Env:   PI_INSTALL_PREFIX=DIR    install under DIR (bin in DIR/bin)
EOF
  exit 0
}

die() {
  echo "error: $2" >&2
  exit "$1"
}

version=""
want_uninstall=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) want_uninstall=1 ;;
    -h|--help) usage 0 ;;
    -*) die 2 "unknown option: $arg (try --help)" ;;
    *)
      [ -z "$version" ] || die 2 "unexpected extra argument: $arg"
      version="${arg#v}"
      echo "$version" | grep -Eq '^[0-9A-Za-z._-]+$' || die 2 "invalid version: $arg"
      ;;
  esac
done

# --- Preflight ---------------------------------------------------------------

command -v curl >/dev/null 2>&1 || die 1 "curl not found."
command -v npm >/dev/null 2>&1 || die 1 "npm not found. Install Node.js >= 22.19 (https://nodejs.org)."
node -e 'const [maj,min]=process.versions.node.split(".").map(Number);process.exit(maj>22||(maj===22&&min>=19)?0:1)' ||
  die 1 "Node.js >= 22.19 required, found $(node -p 'process.versions.node' 2>/dev/null || echo unknown). See https://nodejs.org."

# --- Prefix ------------------------------------------------------------------
# npm's global prefix when its bin dir is writable, else ~/.local — except a
# version-managed prefix (mise/nvm/asdf/volta/fnm): globals installed there
# vanish when the version manager switches or upgrades node, so ~/.local wins.

npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"
case "$npm_global_prefix" in
  */.local/share/mise/*|*/.nvm/*|*/.asdf/*|*/.volta/*|*/.fnm/*) npm_global_prefix="" ;;
esac
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
[ "$prefix" = "$npm_global_prefix" ] || echo "Using install prefix: $prefix"

# --- Uninstall ---------------------------------------------------------------

if [ "$want_uninstall" = 1 ]; then
  npm ls -g --prefix "$prefix" --depth=0 "$package" >/dev/null 2>&1 ||
    die 1 "$package is not installed under $prefix. Nothing removed."
  npm uninstall -g --prefix "$prefix" "$package"
  echo "Uninstalled."
  exit 0
fi

# Refuse to clobber a binary npm does not own (a wrapper script, a symlink, a
# manually placed file): npm would fail with EEXIST anyway, so fail first with
# the fix. Runs before anything executes the existing binary.
if [ -e "$bin_dir/pi" ] &&
  ! npm ls -g --prefix "$prefix" --depth=0 "$package" >/dev/null 2>&1; then
  die 1 "$bin_dir/pi exists and was not installed by npm under this prefix. Move it aside first (it is yours, not this installer's):
  mv \"$bin_dir/pi\" \"${bin_dir}/pi.bak\""
fi

# --- Downgrade warning -------------------------------------------------------
# Advisory only, against the install this run replaces. The latest path needs
# no check: releases/latest always serves the newest complete release.

if [ -n "$version" ] && [ -x "$bin_dir/pi" ]; then
  installed="$("$bin_dir/pi" --version 2>/dev/null | tail -n 1 || true)"
  [ -n "$installed" ] || installed="(version unknown)"
  if semver_gt "$installed" "$version"; then
    echo "warning: downgrade requested: pi ${installed} is installed, but version ${version} was asked for." >&2
    echo "  To keep ${installed}, re-run this script with version ${installed} (or omit the version to track the latest release)." >&2
  fi
fi

# --- Install -----------------------------------------------------------------

if [ -n "$version" ]; then
  url="https://github.com/${repo}/releases/download/v${version}/pi-fork.tgz"
else
  url="https://github.com/${repo}/releases/latest/download/pi-fork.tgz"
fi

# Keep the .tgz suffix: npm infers tarball-vs-directory from the file name.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading ${url}"
curl -fsSL "$url" -o "$tmpdir/pi-fork.tgz"
if [ "$prefix" = "$npm_global_prefix" ]; then
  npm install -g --ignore-scripts "$tmpdir/pi-fork.tgz"
else
  mkdir -p "$bin_dir"
  npm install -g --ignore-scripts --prefix "$prefix" "$tmpdir/pi-fork.tgz"
fi

# --- Report ------------------------------------------------------------------

[ -x "$bin_dir/pi" ] || die 1 "install finished but $bin_dir/pi is missing; check the npm output above."
installed="$("$bin_dir/pi" --version 2>/dev/null | tail -n 1 || true)"
[ -n "$installed" ] || installed="(version unknown)"
echo "Installed pi ${installed} at $bin_dir/pi"

active_path="$(command -v pi 2>/dev/null || true)"
if [ "$active_path" = "$bin_dir/pi" ]; then
  echo "Run it with: pi"
elif [ -n "$active_path" ]; then
  echo "note: your shell resolves pi to $active_path, not the new install." >&2
  echo "  Move $bin_dir earlier in PATH, or add to your shell profile:" >&2
  echo "    export PATH=\"$bin_dir:\$PATH\"" >&2
else
  echo "pi is not on PATH yet. Add to your shell profile:"
  echo "  export PATH=\"$bin_dir:\$PATH\""
fi
echo "Re-run this script any time to upgrade; --uninstall removes it."
