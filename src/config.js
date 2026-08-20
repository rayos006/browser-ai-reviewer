'use strict';
// Config loading. Everything machine-specific lives in one JSON file so the same
// checkout works on anyone's machine:
//
//   ~/.config/browser-ai-reviewer/config.json   (override with $BAR_CONFIG)
//
// Missing keys fall back to DEFAULTS. A missing token is generated and written back
// on first run, so `npm start` works standalone without the installer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH =
  process.env.BAR_CONFIG ||
  path.join(os.homedir(), '.config', 'browser-ai-reviewer', 'config.json');

// Candidate clone locations, filtered to the ones that exist. The installer writes
// the resolved list into the config; this list is only the first-run guess.
const REPO_BASE_CANDIDATES = [
  '~/Documents/git', '~/Documents/projects', '~/src', '~/code', '~/Code',
  '~/dev', '~/git', '~/projects', '~/repos', '~/workspace',
];

const DEFAULTS = {
  port: 8765,
  host: '127.0.0.1',
  token: null, // generated on first run
  repoBases: REPO_BASE_CANDIDATES,
  rows: 30,
  cols: 100,
  // A session nobody has polled /output for this long is killed, so closing the tab
  // doesn't leave stray agent processes. Also the reconnect window after a refresh.
  idleTimeoutSec: 300,
  // Cap on retained scrollback per session (characters). Older output is dropped from
  // the front; offsets stay absolute, so clients never see it as corruption.
  scrollbackChars: 2_000_000,
  // Free-text instruction for agents that take a prompt rather than a slash command.
  reviewPrompt:
    'Review the changes on this branch against its merge-base with the default branch. ' +
    'Report correctness bugs, risks, and concrete suggestions.',
  // Ordered; ids are arbitrary but must be unique. `command` is run inside the PR
  // worktree by an interactive login shell, so you can keep typing at the agent.
  // {PROMPT} is substituted with reviewPrompt, {URL} with the PR URL, {PR} with its
  // number. Add or remove entries here — the userscript's tabs are generated from
  // this list, so the two can't drift apart.
  agents: [
    { id: 'claude', label: 'Claude', command: "claude '/code-review'" },
    { id: 'codex', label: 'Codex', command: 'codex {PROMPT}' },
  ],
};

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readFileIfPresent(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${p} is not valid JSON: ${e.message}`);
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // 0600: the file holds the shared secret that authorizes spawning shells.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function load() {
  const onDisk = readFileIfPresent(CONFIG_PATH) || {};
  const cfg = { ...DEFAULTS, ...onDisk };

  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    writeConfig({ ...onDisk, token: cfg.token });
    console.log(`[config] generated a token in ${CONFIG_PATH}`);
  }

  // Only keep bases that actually exist, so a missing default doesn't cost a stat
  // on every repo lookup.
  cfg.repoBases = cfg.repoBases
    .map(expandHome)
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });

  if (!cfg.agents.length) throw new Error('config.agents is empty — nothing to run');
  const ids = new Set();
  for (const a of cfg.agents) {
    if (!a.id || !a.command) throw new Error(`config.agents entry needs id + command: ${JSON.stringify(a)}`);
    if (ids.has(a.id)) throw new Error(`duplicate agent id '${a.id}'`);
    ids.add(a.id);
    a.label = a.label || a.id;
  }

  cfg.configPath = CONFIG_PATH;
  cfg.shell = process.env.SHELL || '/bin/zsh';
  return cfg;
}

module.exports = { load, writeConfig, CONFIG_PATH, DEFAULTS, REPO_BASE_CANDIDATES, expandHome };
