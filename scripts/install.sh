#!/bin/sh
# Installs the pi fork from GitHub Releases; no registry configuration or PAT needed.
#
# Usage:
#   install.sh [version]        install latest release, or a pinned version
#   install.sh --uninstall      remove the fork from the install prefix
#   install.sh --prefix DIR     install under DIR (bin in DIR/bin); same as PI_INSTALL_PREFIX
#
# Design rules (see docs/fork/upstream-integration.md): POSIX sh + curl + npm
# only; no interactive prompts (the script runs under `curl | sh` with no tty
# guarantee, so every decision has a safe default and warnings name the exact
# command to run instead of asking questions); no update checks or install
# registration — the script runs only when the user runs it.
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
  [ -f "$0" ] && sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' || true
  exit "${1:-0}"
}

die() {
  echo "error: $2" >&2
  exit "$1"
}

# --- Arguments ---------------------------------------------------------------

version=""
want_uninstall=0
prefix_override=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --uninstall) want_uninstall=1 ;;
    --prefix)
      [ "$#" -ge 2 ] || die 2 "--prefix requires a directory"
      prefix_override="$2"
      shift
      ;;
    --prefix=*) prefix_override="${1#--prefix=}" ;;
    -h|--help) usage 0 ;;
    -*) die 2 "unknown option: $1 (try --help)" ;;
    *)
      [ -z "$version" ] || die 2 "unexpected extra argument: $1"
      version="${1#v}"
      echo "$version" | grep -Eq '^[0-9A-Za-z._-]+$' || die 2 "invalid version: $1"
      ;;
  esac
  shift
done
# An explicit --prefix wins over a pre-set PI_INSTALL_PREFIX.
[ -z "$prefix_override" ] || PI_INSTALL_PREFIX="$prefix_override"

# --- Preflight ---------------------------------------------------------------

command -v curl >/dev/null 2>&1 || die 1 "curl not found."
command -v npm >/dev/null 2>&1 || die 1 "npm not found. Install Node.js >= 22.19 (https://nodejs.org)."
command -v node >/dev/null 2>&1 || die 1 "node not found. Install Node.js >= 22.19 (https://nodejs.org)."
node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
node_ok=0
[ -n "$node_version" ] && node_ok="$(awk -v v="$node_version" 'BEGIN {
  split(v, f, ".")
  ok = (f[1] + 0 > 22) || (f[1] + 0 == 22 && f[2] + 0 >= 19)
  print ok ? 1 : 0
}')"
[ "$node_ok" = 1 ] || die 1 "Node.js >= 22.19 required, found ${node_version:-unknown}. See https://nodejs.org."

echo "Preflight: node ${node_version}, $(uname -s) $(uname -m)"

# --- Install prefix ----------------------------------------------------------
# npm's global prefix when its bin dir is usable, else ~/.local. An explicit
# PI_INSTALL_PREFIX (or --prefix) always wins. Whenever the chosen prefix is
# not npm's own global prefix, every npm command below passes --prefix.

npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"
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

npm_with_prefix() {
  if [ "$prefix" = "$npm_global_prefix" ]; then
    npm "$@"
  else
    mkdir -p "$bin_dir"
    npm --prefix "$prefix" "$@"
  fi
}

[ "$prefix" = "$npm_global_prefix" ] || echo "Using install prefix: $prefix"

# --- Existing pi: channel report and downgrade warning -----------------------

existing_path="$(command -v pi 2>/dev/null || true)"
existing_version=""
if [ -n "$existing_path" ]; then
  # Last line only: shim wrappers can print their own notices first.
  existing_version="$(pi --version 2>/dev/null | tail -n 1 || true)"
  case "$existing_path" in
    */.local/share/mise/*|*/mise/shims/*)
      echo "Found pi ${existing_version:-?} managed by mise at $existing_path."
      echo "  The fork installs to $bin_dir/pi; if mise's shim shadows it, remove the mise copy with: mise rm pi"
      ;;
    *)
      case "$existing_version" in
        *-fork.*) ;;
        *)
          echo "Found pi ${existing_version:-?} at $existing_path (no fork version suffix)."
          echo "  That looks like an upstream install; this fork install lands at $bin_dir/pi."
          echo "  If both stay on PATH, whichever comes first wins — check with: command -v pi"
          ;;
      esac
      ;;
  esac
fi

# Warn before downgrading: a typo naming an older real release must not
# quietly replace a newer install. Warning only; downgrades stay possible.
# The comparison targets the install this run replaces (the prefix's own pi
# when present), falling back to whatever pi is on PATH. The latest path needs
# no check: releases/latest always serves the newest complete release.
replaced_version=""
if [ -n "$version" ]; then
  if [ -x "$bin_dir/pi" ]; then
    replaced_version="$("$bin_dir/pi" --version 2>/dev/null | tail -n 1 || true)"
  else
    replaced_version="$existing_version"
  fi
  if [ -n "$replaced_version" ] && semver_gt "$replaced_version" "$version"; then
    echo "warning: downgrade requested: pi ${replaced_version} is installed, but version ${version} was asked for." >&2
    echo "  To keep ${replaced_version}, re-run with: sh -s ${replaced_version} (or omit the version to track the latest release)." >&2
  fi
fi

# --- Uninstall ---------------------------------------------------------------

if [ "$want_uninstall" = 1 ]; then
  if npm ls -g --prefix "$prefix" --depth=0 "$package" >/dev/null 2>&1; then
    echo "Removing $package from $prefix"
    npm uninstall -g --prefix "$prefix" "$package"
    [ ! -e "$bin_dir/pi" ] || echo "note: $bin_dir/pi still exists; another install owns it." >&2
    echo "Uninstalled."
  else
    die 1 "$package is not installed under $prefix. Nothing removed."
  fi
  exit 0
fi

# --- Install -----------------------------------------------------------------

if [ -n "$version" ]; then
  url="https://github.com/${repo}/releases/download/v${version}/pi-fork.tgz"
else
  url="https://github.com/${repo}/releases/latest/download/pi-fork.tgz"
fi

# Refuse to clobber a binary npm does not own (a wrapper script, a manually
# placed file): npm would fail with EEXIST anyway, so fail first with the fix.
if [ -e "$bin_dir/pi" ] && [ ! -L "$bin_dir/pi" ] &&
  ! npm ls -g --prefix "$prefix" --depth=0 "$package" >/dev/null 2>&1; then
  die 1 "$bin_dir/pi exists and was not installed by npm under this prefix. Move it aside first (it is yours, not this installer's):
  mv \"$bin_dir/pi\" \"${bin_dir}/pi.bak\""
fi

# Keep the .tgz suffix: npm infers tarball-vs-directory from the file name.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading ${url}"
curl -fsSL "$url" -o "$tmpdir/pi-fork.tgz"
npm_with_prefix install -g --ignore-scripts "$tmpdir/pi-fork.tgz"

# --- Verify and report -------------------------------------------------------

if [ -x "$bin_dir/pi" ]; then
  echo "Installed pi $("$bin_dir/pi" --version 2>/dev/null || echo '(version unknown)') at $bin_dir/pi"
else
  die 1 "install finished but $bin_dir/pi is missing; check the npm output above."
fi

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
