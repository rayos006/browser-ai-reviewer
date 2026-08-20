#!/usr/bin/env node
'use strict';
// Creates ~/.config/browser-ai-reviewer/config.json on first install: generates the
// shared token, picks the clone directories that actually exist on this machine, and
// keeps only the agents whose CLI is installed. Re-running never overwrites an
// existing config — it just reports what's there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { CONFIG_PATH, DEFAULTS, REPO_BASE_CANDIDATES, expandHome } = require('../src/config');
const { pickFree } = require('../src/port');

function hasCommand(cmd) {
  // Login shell, because `claude` and `codex` are usually installed somewhere only
  // the user's profile puts on PATH (nvm, ~/.local/bin, homebrew on Apple silicon).
  try {
    execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', `command -v ${cmd}`], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    });
    return true;
  } catch { return false; }
}

function isGitRepo(p) {
  return fs.existsSync(path.join(p, '.git'));
}


// Keep a candidate only if it exists AND holds at least one clone, so we don't add
// an empty ~/code that just costs a stat on every lookup.
function detectRepoBases() {
  const found = [];
  for (const cand of REPO_BASE_CANDIDATES) {
    const p = expandHome(cand);
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
    if (entries.some((e) => e.isDirectory() && !e.name.startsWith('.') && isGitRepo(path.join(p, e.name)))) {
      found.push(cand);
    }
  }
  return found;
}

if (fs.existsSync(CONFIG_PATH)) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log(`config already exists: ${CONFIG_PATH}`);
  console.log(`  repoBases: ${(cfg.repoBases || DEFAULTS.repoBases).join(', ')}`);
  console.log(`  agents:    ${(cfg.agents || DEFAULTS.agents).map((a) => a.id).join(', ')}`);
  process.exit(0);
}

async function main() {
const repoBases = detectRepoBases();
const installed = DEFAULTS.agents.filter((a) => hasCommand(a.command.split(/\s+/)[0]));
// If we can't find any agent CLI, keep the full list rather than shipping an empty
// config — the user probably just needs to install one, and the tabs show the error.
const agents = installed.length ? installed : DEFAULTS.agents;

const port = await pickFree(DEFAULTS.port);
if (port !== DEFAULTS.port) {
  console.log(`port ${DEFAULTS.port} is in use — using ${port} instead`);
}

const cfg = {
  port,
  token: crypto.randomBytes(24).toString('hex'),
  repoBases: repoBases.length ? repoBases : [path.join('~', 'src')],
  rows: DEFAULTS.rows,
  cols: DEFAULTS.cols,
  idleTimeoutSec: DEFAULTS.idleTimeoutSec,
  reviewPrompt: DEFAULTS.reviewPrompt,
  agents,
};

fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });

console.log(`wrote ${CONFIG_PATH}`);
console.log(`  repoBases: ${cfg.repoBases.join(', ')}${repoBases.length ? '' : '  (nothing detected — edit this)'}`);
console.log(`  agents:    ${cfg.agents.map((a) => a.id).join(', ')}`);

const missing = DEFAULTS.agents.filter((a) => !installed.includes(a)).map((a) => a.id);
if (missing.length) console.log(`  not installed, left out: ${missing.join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
