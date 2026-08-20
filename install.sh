#!/usr/bin/env bash
# browser-ai-reviewer installer.
#
#   ./install.sh              install deps, write config, start the service, open the
#                             userscript install page
#   ./install.sh --no-service run in the foreground instead of installing a service
#
# What it cannot do for you: install the Tampermonkey extension, click "Install" on the
# userscript page, or log you in to the agent CLIs. Those are browser/interactive steps.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.browser-ai-reviewer"
NO_SERVICE=0
[[ "${1:-}" == "--no-service" ]] && NO_SERVICE=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. prerequisites --------------------------------------------------------

bold "Checking prerequisites"
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node >= 18 is required (https://nodejs.org)"
command -v npm >/dev/null || die "npm is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "node >= 18 required, found $(node -v)"
ok "node $(node -v), $(git --version)"

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      die "unsupported platform $(uname -s) — Windows isn't handled yet" ;;
esac

# node-pty is a native module. On macOS a prebuilt binary usually covers it; if not,
# npm falls back to compiling and needs the Command Line Tools.
if [[ "$PLATFORM" == macos ]] && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools not found; if npm install fails run: xcode-select --install"
fi

# --- 2. dependencies ---------------------------------------------------------

bold "Installing dependencies"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null)
ok "node-pty installed"

# --- 3. config ---------------------------------------------------------------

bold "Configuring"
node "$DIR/scripts/init-config.js" | sed 's/^/  /'

# Warn about agents whose CLI isn't on PATH, since their tab will just show an error.
for agent in $(node -e '
  const c=require("'"$DIR"'/src/config").load();
  console.log(c.agents.map(a=>a.command.split(/\s+/)[0]).join(" "));
'); do
  if ! "${SHELL:-/bin/zsh}" -ilc "command -v $agent" >/dev/null 2>&1; then
    warn "'$agent' is configured but not on your PATH — install it or remove it from the config"
  fi
done

PORT="$(node -e 'console.log(require("'"$DIR"'/src/config").load().port)')"
# A fresh config already picks a free port; this catches an existing config whose port
# has since been taken (e.g. by the Hammerspoon bridge this project replaces).
if node -e 'require("'"$DIR"'/src/port").inUse(+process.argv[1]).then(u=>process.exit(u?0:1))' "$PORT"; then
  warn "something is already listening on 127.0.0.1:$PORT"
  warn "stop it, or change \"port\" in ~/.config/browser-ai-reviewer/config.json and re-run"
fi

# --- 4. service --------------------------------------------------------------

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  local logdir="$HOME/Library/Logs"
  mkdir -p "$(dirname "$plist")" "$logdir"

  # launchd starts jobs with a minimal PATH, so node is referenced absolutely. The
  # agents themselves are launched through an interactive login shell, which picks up
  # the user's real PATH — that's how `claude`/`codex` stay findable.
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$DIR/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$logdir/browser-ai-reviewer.log</string>
  <key>StandardErrorPath</key><string>$logdir/browser-ai-reviewer.log</string>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
  ok "launchd agent installed ($plist)"
  ok "logs: $logdir/browser-ai-reviewer.log"
}

install_systemd() {
  local unit="$HOME/.config/systemd/user/browser-ai-reviewer.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<UNIT
[Unit]
Description=browser-ai-reviewer (local AI PR review bridge)

[Service]
ExecStart=$(command -v node) $DIR/src/server.js
WorkingDirectory=$DIR
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now browser-ai-reviewer.service
  ok "systemd user unit installed ($unit)"
  ok "logs: journalctl --user -u browser-ai-reviewer -f"
}

if (( NO_SERVICE )); then
  bold "Skipping service install (--no-service)"
  URL="$(node "$DIR/src/server.js" --install-url)"
  printf '\nStart it yourself with:  \033[1mnpm start --prefix %s\033[0m\n' "$DIR"
  printf 'Then install the userscript from:\n  \033[1m%s\033[0m\n' "$URL"
  exit 0
fi

bold "Installing the background service"
case "$PLATFORM" in
  macos) install_launchd ;;
  linux) install_systemd ;;
esac

# --- 5. wait for it, then hand off to the browser ----------------------------

URL="$(node "$DIR/src/server.js" --install-url)"
HEALTH="http://127.0.0.1:$PORT/health"

bold "Waiting for the service"
for _ in $(seq 1 50); do
  if curl -sf "$HEALTH" >/dev/null 2>&1; then
    ok "listening on 127.0.0.1:$PORT"
    HEALTHY=1
    break
  fi
  sleep 0.2
done

if [[ -z "${HEALTHY:-}" ]]; then
  die "service didn't come up. Check the log, or run: node $DIR/src/server.js"
fi

# --- 6. the parts a script can't do for you ----------------------------------

cat <<BANNER

$(bold "Almost done — two manual steps left")

  1. Install Tampermonkey if you don't have it:  https://www.tampermonkey.net
  2. Install the userscript from the URL below and approve the
     "connect to 127.0.0.1" permission when Tampermonkey asks.

     $(printf '\033[1m%s\033[0m' "$URL")

Then open any GitHub PR for a repo you have cloned locally and click 🤖 AI Review.

  config:    ~/.config/browser-ai-reviewer/config.json
  uninstall: $DIR/uninstall.sh

BANNER

if command -v open >/dev/null 2>&1; then
  open "$URL" 2>/dev/null || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi
