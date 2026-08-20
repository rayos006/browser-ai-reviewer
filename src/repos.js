'use strict';
// Map a GitHub `owner/repo` to a local clone.
//
// The original bridge required the local directory to be named exactly like the repo,
// which breaks for anyone whose layout differs. Here the directory-name match is only
// a fast path; the fallback scans each base one level deep and matches on the actual
// git remote, so `~/code/my-fork` pointing at `acme/widgets` still resolves.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCAN_TTL_MS = 60_000; // rescan at most once a minute; clones appear rarely
let scanCache = { at: 0, byFullName: new Map() };

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isGitRepo(p) {
  // A worktree checkout has .git as a file, a normal clone as a directory.
  return fs.existsSync(path.join(p, '.git'));
}

function remoteFullNames(repoPath) {
  // All remotes, not just origin: a fork clone often has the upstream repo as a
  // second remote, and a PR against upstream should still find this checkout.
  let out;
  try {
    out = execFileSync('git', ['-C', repoPath, 'remote', '-v'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return []; }

  const names = new Set();
  for (const line of out.split('\n')) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    // git@github.com:owner/repo.git | https://github.com/owner/repo(.git) | ssh://...
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    if (m) names.add(`${m[1].toLowerCase()}/${m[2].toLowerCase()}`);
  }
  return [...names];
}

function scan(repoBases) {
  const now = Date.now();
  if (now - scanCache.at < SCAN_TTL_MS) return scanCache.byFullName;

  const byFullName = new Map();
  for (const base of repoBases) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(base, e.name);
      if (!isGitRepo(p)) continue;
      for (const full of remoteFullNames(p)) {
        if (!byFullName.has(full)) byFullName.set(full, p); // first base wins
      }
    }
  }
  scanCache = { at: now, byFullName };
  return byFullName;
}

// Returns an absolute path, or null. `owner` is optional (older clients omit it),
// in which case only the directory-name fast path applies.
function find(owner, repo, repoBases) {
  for (const base of repoBases) {
    const p = path.join(base, repo);
    if (isDir(p) && isGitRepo(p)) return p;
  }
  if (!owner) return null;

  const full = `${owner}/${repo}`.toLowerCase();
  let hit = scan(repoBases).get(full);
  if (hit) return hit;

  // A clone added since the last scan: bust the cache and try once more.
  scanCache.at = 0;
  hit = scan(repoBases).get(full);
  return hit || null;
}

module.exports = { find, remoteFullNames };
