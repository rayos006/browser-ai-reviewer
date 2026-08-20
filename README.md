# browser-ai-reviewer

One-click AI code review, embedded **inside** the GitHub PR page.

Clicking **🤖 AI Review** on any PR launches your local AI agents (Claude Code, Codex,
whatever you configure) against that PR — each running in a git worktree checked out at
the PR head — and streams their terminals into a tabbed panel on the page. The terminals
are live: you can type follow-up questions at the agent without leaving GitHub.

```
GitHub PR page                          your machine
┌──────────────────────────┐            ┌─────────────────────────────────┐
│ userscript + xterm.js    │            │ node src/server.js (port 8765)  │
│  ── POST /session ──────────────────▶ │   git worktree add pr-<n>       │
│  ── GET  /output (poll) ◀───────────  │   node-pty ─▶ zsh -ilc 'claude' │
│  ── POST /input (keys) ─────────────▶ │                                 │
│  ── POST /close ────────────────────▶ │                                 │
└──────────────────────────┘  GM_xhr    └─────────────────────────────────┘
```

## Install

```sh
git clone <this repo> && cd browser-ai-reviewer
./install.sh
```

The installer checks prerequisites, installs dependencies, writes a config with a
freshly generated token, installs a background service (launchd on macOS, systemd user
unit on Linux), and opens the userscript install page in your browser.

Two steps it can't do for you:

1. Install [Tampermonkey](https://www.tampermonkey.net) if you don't have it.
2. Click **Install** on the userscript page, and approve the `connect to 127.0.0.1`
   permission prompt.

Then open a PR for a repo you have cloned locally and click 🤖 AI Review.

Prerequisites: Node 18+, git, and at least one agent CLI (`claude` and/or `codex`)
installed and logged in. macOS or Linux.

`./install.sh --no-service` skips the service and just prints how to run it manually.
`./uninstall.sh` removes the service; `--purge` also drops the config.

## Why it's shaped like this

GitHub's CSP blocks the obvious transports: `connect-src` has no localhost, so the page
can't `fetch` or open a WebSocket to a local server, and `frame-src` blocks a localhost
iframe. The one channel that works is Tampermonkey's privileged **`GM_xmlhttpRequest`**,
which runs outside page CSP (hence `@connect 127.0.0.1`).

That request is one-shot rather than streaming, so agent output is **short-polled** by
absolute offset — `GET /output?since=N` returns everything after `N`, base64 encoded so
arbitrary terminal control bytes survive JSON. Polling doubles as the liveness signal
the idle reaper uses.

Agents need a real TTY (their TUIs won't render into a pipe), which is what `node-pty`
provides.

## Configuration

Everything machine-specific lives in `~/.config/browser-ai-reviewer/config.json`:

| Key | Meaning |
| --- | --- |
| `port` | Service port. The installer picks the first free port from 8765. |
| `token` | Shared secret, generated at install. See [Security](#security). |
| `repoBases` | Directories holding your clones. Auto-detected at install. |
| `rows`, `cols` | Size of the embedded terminal. |
| `idleTimeoutSec` | Kill sessions nobody has polled for this long (default 300). |
| `scrollbackChars` | Retained output per session before old scrollback is dropped. |
| `reviewPrompt` | Free-text instruction for agents that take a prompt. |
| `agents` | The list of agents, in tab order. |

An agent entry is `{ id, label, command }`. The command runs inside the PR worktree via
an interactive login shell, so it inherits your normal PATH and stays interactive:

```json
{ "id": "claude", "label": "Claude", "command": "claude '/code-review'" }
```

`{PROMPT}`, `{URL}`, `{PR}`, `{BRANCH}` and `{WORKTREE}` are substituted, already
shell-quoted — so write `codex {PROMPT}`, not `codex '{PROMPT}'`.

**The userscript is generated from this config.** The service serves it at
`/browser-ai-reviewer.user.js` with the token, port, terminal size and agent list
injected, which is why the tabs on the page can never disagree with the agents the
service knows how to run. Editing the config bumps the served `@version`, so
Tampermonkey picks up the change on its next update check.

After editing the config, restart the service:

```sh
launchctl kickstart -k gui/$(id -u)/com.browser-ai-reviewer   # macOS
systemctl --user restart browser-ai-reviewer                  # Linux
```

## How repos are resolved

A PR at `github.com/acme/widgets/pull/42` is matched against your clones two ways:
first a directory named `widgets` under one of your `repoBases`, then — failing that —
a scan of each base one level deep matching on the actual git remote. So a checkout at
`~/code/widgets-fork` whose origin points at `acme/widgets` still resolves. All remotes
are considered, not just `origin`, so fork clones with an upstream remote work too.

## Worktrees

All agents for a PR share **one** worktree: `<repo>/.claude/worktrees/pr-<n>` on branch
`ai-pr-<n>`, fetched via `pull/<n>/head` so PRs from forks work without adding the fork
as a remote. Whichever agent starts first creates it; the others wait on the same
promise, so there's exactly one fetch no matter how many agents you launch.

Sharing means agents see each other's edits — fine for review, worth knowing if one
starts writing. Worktrees are left behind on purpose (they're cheap and reusable):

```sh
git -C <repo> worktree remove .claude/worktrees/pr-<n>
git -C <repo> branch -D ai-pr-<n>
```

## Refresh and reconnect

The panel is DOM and disappears on reload, but the **session** survives. The userscript
stores the session id per PR and agent; on load it checks whether the session is still
alive and silently reattaches, replaying the buffer. So a refresh within `idleTimeoutSec`
brings the review back where it left off; longer and the reaper has cleaned it up.

Closing the panel with ✕ stops the agents immediately.

## Security

The service binds `127.0.0.1` only, but that alone isn't enough: any page in your
browser can still *send* a cross-origin request to localhost, and `POST /session` starts
a process. Four layers, then:

- **Token on every route** except `/health`, compared in constant time. It's generated
  at install, never leaves your machine, and is stored in a `0600` config.
- **No CORS headers, anywhere.** `GM_xmlhttpRequest` is privileged and doesn't need
  them; without them an ordinary page can't read our responses even if it learned the
  token. The userscript route is authenticated too, so the token can't be harvested by
  fetching the script.
- **Loopback `Host` header required.** Binding `127.0.0.1` stops traffic from off the
  machine, but not a browser tricked into resolving an attacker's hostname to
  `127.0.0.1` (DNS rebinding) — under that hostname the page's own origin matches and
  same-origin policy would let it read responses. Requests not addressed to a loopback
  name get a 403.
- **Charset validation** on `owner`, `repo` and `pr` before they reach a path or a git
  ref (`src/validate.js`). These are post-authentication, but `repo` is joined onto a
  base directory and `pr` onto a worktree path, so a value like `../../../../tmp` would
  otherwise walk out of your configured `repoBases`.

Worth being clear about the trust model: this runs AI agents with your credentials
against branches from a PR, in a worktree inside your clone. Point it at repos whose
PRs you'd be willing to check out and run locally anyway.

## Layout

```
src/server.js      HTTP routes, userscript rendering, auth
src/sessions.js    PTY sessions, output buffering, idle reaper
src/worktree.js    per-PR worktree setup, shared across agents
src/repos.js       GitHub repo -> local clone resolution
src/config.js      config loading and defaults
userscript/        the userscript template the service renders
install.sh         prerequisites, deps, config, service, browser hand-off
```

## Troubleshooting

**`posix_spawnp failed.`** — node-pty's `spawn-helper` lost its execute bit during
extraction. `npm run postinstall` fixes it (the installer runs this automatically).

**The button appears but nothing happens** — check the service is up
(`curl -s localhost:8765/health`) and that Tampermonkey's `connect to 127.0.0.1`
permission was approved.

**"no local clone of ..."** — the repo isn't under any `repoBases` entry. Add its parent
directory to the config.

**Agent tab shows "command not found"** — the agent CLI isn't on the PATH your login
shell sets up. Check with `zsh -ilc 'command -v claude'`.

## License

MIT
