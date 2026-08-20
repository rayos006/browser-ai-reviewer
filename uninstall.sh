#!/usr/bin/env bash
# Removes the background service. Keeps your config by default (--purge drops it too).
# The userscript itself has to be removed from Tampermonkey's dashboard by hand.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.browser-ai-reviewer"
CONFIG="$HOME/.config/browser-ai-reviewer/config.json"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

case "$(uname -s)" in
  Darwin)
    plist="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "launchd agent removed"
    ;;
  Linux)
    systemctl --user disable --now browser-ai-reviewer.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/browser-ai-reviewer.service"
    systemctl --user daemon-reload 2>/dev/null || true
    ok "systemd unit removed"
    ;;
esac

if (( PURGE )); then
  rm -f "$CONFIG"
  ok "config removed ($CONFIG)"
else
  ok "config kept ($CONFIG) — pass --purge to remove it"
fi

cat <<TXT

Still to do by hand:
  - remove the "AI PR Review" script in the Tampermonkey dashboard
  - the per-PR worktrees are left in place; remove one with:
      git -C <repo> worktree remove .claude/worktrees/pr-<n>
      git -C <repo> branch -D ai-pr-<n>
TXT
