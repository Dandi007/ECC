#!/usr/bin/env bash
# ecc.parity.v1 e2e runner — run the same scenario on real Claude Code and real
# OpenCode inside fully isolated sandboxes, collect hook effects, normalize, diff.
#
# Usage: ./run.sh <scenario.json> [cc|oc|both]   (default: both)
#
# Isolation (golden order: tests MUST NOT touch real usage):
#   - HOME      -> $SANDBOX/<side>/home      (hooks state root ~/.claude/*)
#   - TMPDIR    -> $SANDBOX/<side>/tmp       (ecc-metrics-*.json)
#   - OC: XDG_CONFIG_HOME/XDG_DATA_HOME/OPENCODE_DB sandboxed,
#         OPENCODE_HOST/OPENCODE_SERVER_PASSWORD/OPENCODE_SKIP_START/OPENCODE_PORT scrubbed
#         (otherwise `opencode run` silently attaches to the production server)
#   - CC: CLAUDE_CONFIG_DIR sandboxed
#   - osascript stubbed via PATH so desktop-notify lands in notify.log
# LLM traffic: both sides go through CC Switch proxy (127.0.0.1:15721).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/parity/e2e"
SCENARIO="${1:?usage: run.sh <scenario.json> [cc|oc|both]}"
SIDE="${2:-both}"

CCS_URL="${ECC_PARITY_CCS_URL:-http://127.0.0.1:15721}"
CC_MODEL="${ECC_PARITY_CC_MODEL:-lingzhi/claude-haiku-4-5-20251001}"
OC_MODEL="${ECC_PARITY_OC_MODEL:-ccs/lingzhi/claude-haiku-4-5-20251001}"

PROMPT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).prompt)" "$SCENARIO")"

SANDBOX="${ECC_PARITY_SANDBOX:-$(mktemp -d /tmp/ecc-parity-e2e-XXXXXX)}"
echo "[e2e] sandbox: $SANDBOX"

make_side() { # $1 = cc|oc
  local side="$1" home tmp
  home="$SANDBOX/$side/home"; tmp="$SANDBOX/$side/tmp"
  mkdir -p "$home/.claude" "$tmp" "$SANDBOX/$side/proj" "$SANDBOX/$side/bin"
  # osascript stub -> notify.log (contract: stop-desktop-notify verify: stub)
  cat > "$SANDBOX/$side/bin/osascript" <<STUB
#!/usr/bin/env bash
echo "\$@" >> "$SANDBOX/$side/notify.log"
STUB
  chmod +x "$SANDBOX/$side/bin/osascript"
}

run_cc() {
  make_side cc
  local home="$SANDBOX/cc/home" tmp="$SANDBOX/cc/tmp" proj="$SANDBOX/cc/proj"
  # hook wiring: same run-with-flags tuples the ECC plugin registers (subset under test)
  node "$E2E/lib/gen-cc-settings.js" "$ROOT" > "$home/.claude/settings.json"
  printf '{"hasCompletedOnboarding": true}\n' > "$home/.claude.json"
  echo "[e2e] cc: running claude -p ..."
  (
    cd "$proj"
    env -u CLAUDE_CONFIG_DIR \
      HOME="$home" TMPDIR="$tmp" PATH="$SANDBOX/cc/bin:$PATH" \
      ANTHROPIC_BASE_URL="$CCS_URL" ANTHROPIC_API_KEY="ecc-parity" ANTHROPIC_AUTH_TOKEN="ecc-parity" \
      NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
      ECC_HOOK_PROFILE=standard ECC_DISABLED_HOOKS="post:bash:command-log-cost,stop:cost-tracker" \
      claude -p --model "$CC_MODEL" --permission-mode bypassPermissions "$PROMPT" \
      > "$SANDBOX/cc/run.out" 2> "$SANDBOX/cc/run.err"
  ) || { echo "[e2e] cc run FAILED"; tail -5 "$SANDBOX/cc/run.err" || true; }
  collect cc "$home" "$tmp"
}

run_oc() {
  make_side oc
  local home="$SANDBOX/oc/home" tmp="$SANDBOX/oc/tmp" proj="$SANDBOX/oc/proj"
  mkdir -p "$SANDBOX/oc/xdg-config/opencode" "$SANDBOX/oc/xdg-data" "$proj/.opencode/plugin"
  node "$E2E/lib/gen-oc-config.js" "$OC_MODEL" "$CCS_URL" > "$SANDBOX/oc/xdg-config/opencode/opencode.json"
  ln -sf "$ROOT/parity/adapter/opencode/ecc-parity.ts" "$proj/.opencode/plugin/ecc-parity.ts"
  echo "[e2e] oc: running opencode run ..."
  (
    cd "$proj"
    env -u OPENCODE_HOST -u OPENCODE_SERVER_PASSWORD -u OPENCODE_SKIP_START -u OPENCODE_PORT \
      HOME="$home" TMPDIR="$tmp" PATH="$SANDBOX/oc/bin:$PATH" \
      XDG_CONFIG_HOME="$SANDBOX/oc/xdg-config" XDG_DATA_HOME="$SANDBOX/oc/xdg-data" \
      OPENCODE_DB="$SANDBOX/oc/xdg-data/opencode.db" \
      ECC_PARITY_ROOT="$ROOT" \
      NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
      ECC_HOOK_PROFILE=standard ECC_DISABLED_HOOKS="post:bash:command-log-cost,stop:cost-tracker" \
      opencode run "$PROMPT" \
      > "$SANDBOX/oc/run.out" 2> "$SANDBOX/oc/run.err"
  ) || { echo "[e2e] oc run FAILED"; tail -5 "$SANDBOX/oc/run.err" || true; }
  collect oc "$home" "$tmp"
}

collect() { # $1 side, $2 home, $3 tmp — gather contract effect files
  local side="$1" home="$2" tmp="$3" out="$SANDBOX/$1/collected"
  mkdir -p "$out"
  cp "$home/.claude/session-data/"*-session.tmp "$out/session.md" 2>/dev/null || true
  cp "$home/.claude/session-data/compaction-log.txt" "$out/" 2>/dev/null || true
  cp "$home/.claude/bash-commands.log" "$out/" 2>/dev/null || true
  ls "$tmp"/ecc-metrics-*.json >/dev/null 2>&1 && cp "$tmp"/ecc-metrics-*.json "$out/metrics.json" || true
  ls "$tmp"/ecc-ctx-warn-*.json >/dev/null 2>&1 && cp "$tmp"/ecc-ctx-warn-*.json "$out/ctx-warn.json" || true
  cp "$SANDBOX/$side/notify.log" "$out/" 2>/dev/null || true
  echo "[e2e] $side collected: $(ls "$out" 2>/dev/null | tr '\n' ' ')"
}

[ "$SIDE" = cc ] || [ "$SIDE" = both ] && run_cc
[ "$SIDE" = oc ] || [ "$SIDE" = both ] && run_oc

if [ "$SIDE" = both ]; then
  node "$E2E/lib/check.js" "$SCENARIO" "$SANDBOX"
fi
