#!/usr/bin/env bash
set -euo pipefail

# claw installer — builds the claw CLI from source and (optionally) wires it
# into your AI agent's MCP config. No npm registry required; the repo is public.
#
#   curl -fsSL https://raw.githubusercontent.com/z-zawhtet-a/claw/main/install.sh | bash
#
# Prefer to read before piping to a shell? Download, inspect, then run:
#   curl -fsSL https://raw.githubusercontent.com/z-zawhtet-a/claw/main/install.sh -o install.sh
#   less install.sh && bash install.sh
#
# Works offline too: run it from inside a copied claw checkout and it installs
# from that local source instead of downloading.
#
# Environment:
#   CLAW_REF=<branch|tag|sha>   Source ref to install (default: main). Remote only.
#   CLAW_SRC=<path>             Install from a local source dir; skip downloading.
# Flags:
#   --no-configure              Don't touch the agent's MCP config.
#   -h, --help                  Show this help.

REPO="z-zawhtet-a/claw"
REF="${CLAW_REF:-main}"
MIN_NODE_MAJOR=20
CONFIGURE=1
SRC="${CLAW_SRC:-}"
MODE=""
SCRATCH=""

# ---------- output ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; RED=""; GRN=""; YLW=""; CYN=""; RST=""
fi
info() { printf '%s\n' "${CYN}==>${RST} $*"; }
step() { printf '%s\n' "  ${BOLD}•${RST} $*"; }
warn() { printf '%s\n' "${YLW}warning:${RST} $*" >&2; }
die()  { printf '%s\n' "${RED}error:${RST} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
claw installer — builds the claw CLI from source and (optionally) wires it into
your AI agent's MCP config. No npm registry required; the repo is public.

Usage:
  curl -fsSL https://raw.githubusercontent.com/z-zawhtet-a/claw/main/install.sh | bash
  ./install.sh [--no-configure]        # from inside a copied checkout (offline)

Environment:
  CLAW_REF=<branch|tag|sha>   Source ref to install (default: main). Remote only.
  CLAW_SRC=<path>             Install from a local source dir; skip downloading.

Flags:
  --no-configure              Don't touch the agent's MCP config.
  -h, --help                  Show this help.
EOF
}

# ---------- preflight ----------
node_hint() {
  if command -v brew >/dev/null 2>&1; then
    echo "Install it with: brew install node"
  else
    echo "Install Node from https://nodejs.org or via nvm (https://github.com/nvm-sh/nvm)."
  fi
}

check_node() {
  command -v node >/dev/null 2>&1 \
    || die "Node.js not found. claw needs Node ${MIN_NODE_MAJOR}+. $(node_hint)"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$major" in
    ''|*[!0-9]*) die "Could not determine Node version from '$(node -v 2>/dev/null)'." ;;
  esac
  [ "$major" -ge "$MIN_NODE_MAJOR" ] \
    || die "Node $(node -v) found, but claw needs Node ${MIN_NODE_MAJOR}+. $(node_hint)"
  command -v npm >/dev/null 2>&1 \
    || die "npm not found next to node. $(node_hint)"
}

# ---------- source resolution ----------
is_checkout() {
  [ -f "$1/package.json" ] \
    && grep -q '"name":[[:space:]]*"@z-zawhtet-a/claw"' "$1/package.json" 2>/dev/null
}

resolve_source() {
  if [ -n "$SRC" ]; then
    is_checkout "$SRC" || die "CLAW_SRC=$SRC is not a claw source checkout (no matching package.json)."
    SRC="$(cd "$SRC" && pwd)"
    MODE="local"
    return
  fi
  # Running from a script file that lives inside a checkout?
  local self="${BASH_SOURCE[0]:-}"
  if [ -n "$self" ] && [ -f "$self" ]; then
    local d
    d="$(cd "$(dirname "$self")" && pwd)"
    if is_checkout "$d"; then SRC="$d"; MODE="local"; return; fi
  fi
  # Invoked from within a checkout?
  if is_checkout "$PWD"; then SRC="$PWD"; MODE="local"; return; fi
  MODE="remote"
}

cleanup() {
  if [ -n "$SCRATCH" ]; then rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT

fetch_remote() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download the source."
  command -v tar  >/dev/null 2>&1 || die "tar is required to unpack the source."
  SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/claw-install.XXXXXX")"
  local url="https://github.com/${REPO}/archive/${REF}.tar.gz"
  step "Downloading ${REPO}@${REF}…"
  curl -fsSL "$url" | tar -xzf - --strip-components=1 -C "$SCRATCH" \
    || die "failed to download or unpack $url (bad ref '${REF}'?)"
  is_checkout "$SCRATCH" || die "downloaded archive does not look like claw source."
  SRC="$SCRATCH"
}

# ---------- build + install ----------
build_and_install() {
  step "Installing build dependencies (first run can take a minute)…"
  if [ "$MODE" = "remote" ] && [ -f "$SRC/package-lock.json" ]; then
    (cd "$SRC" && npm ci --no-audit --no-fund) || die "'npm ci' failed."
  else
    (cd "$SRC" && npm install --no-audit --no-fund) || die "'npm install' failed."
  fi

  step "Building…"
  (cd "$SRC" && npm run build) || die "'npm run build' failed."

  step "Installing claw globally…"
  # `npm install -g .` packs dist/ (per package.json "files") and installs the
  # production deps into a self-contained global location — the build scratch
  # dir is disposable afterward.
  (cd "$SRC" && npm install -g . --no-audit --no-fund) || {
    local prefix
    prefix="$(npm prefix -g 2>/dev/null || echo '?')"
    die "global install failed. If this is a permissions error, the npm prefix ($prefix) isn't writable — re-run with sudo, or switch to a user-level Node (nvm/fnm), then retry."
  }
}

verify_bin() {
  if command -v claw >/dev/null 2>&1; then
    step "${GRN}claw $(claw --version 2>/dev/null || echo '?')${RST} installed → $(command -v claw)"
    return
  fi
  local bindir
  bindir="$(npm prefix -g 2>/dev/null || echo '')/bin"
  warn "claw was installed to ${bindir}, but that directory is not on your PATH."
  warn "Add it, e.g.:  echo 'export PATH=\"${bindir}:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
}

configure_agent() {
  if [ "$CONFIGURE" != "1" ]; then
    step "Skipping agent configuration (--no-configure)."
    return
  fi
  if ! command -v claw >/dev/null 2>&1; then
    warn "claw not on PATH yet; skipping auto-config. Once on PATH, run: claw install claude-code"
    return
  fi
  step "Wiring claw into Claude Code's MCP config…"
  claw install claude-code \
    || warn "could not configure Claude Code automatically; run it yourself: claw install claude-code"
}

# ---------- main ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --no-configure) CONFIGURE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

printf '%s\n' "${BOLD}🦞 claw installer${RST}"
[ "$(uname -s)" = "Darwin" ] || warn "claw is intended for macOS; continuing anyway on $(uname -s)."
check_node
resolve_source
if [ "$MODE" = "remote" ]; then
  fetch_remote
  info "Installing from ${REPO}@${REF}"
else
  info "Installing from local source: ${SRC}"
fi
build_and_install
verify_bin
configure_agent

info "Done."
cat <<EOF

${BOLD}Next steps${RST}
  1. Restart Claude Code so it loads the new MCP server.
  2. Add machines:
       claw init --from-ssh            # import from ~/.ssh/config
       claw add prod --ssh user@host   # or add one manually
  3. Ask your agent to do something on a machine.

Docs: https://github.com/${REPO}
EOF
