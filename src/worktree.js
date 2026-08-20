'use strict';
// Per-PR git worktree setup.
//
// All agents for a PR share ONE worktree (<repo>/.claude/worktrees/pr-<n>, branch
// ai-pr-<n>), so there's exactly one fetch no matter how many agents you launch.
// The original bridge coordinated this with a `mkdir` lock and a sleep-poll loop in
// shell, because each agent was a separate process. Here every agent is a request to
// the same process, so a memoized promise does the same job exactly: the first caller
// runs the setup, later callers await the same promise.
//
// Note the shared worktree means agents see each other's edits. That's intentional
// for review (they're reading the same diff), but worth knowing if one starts writing.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const inFlight = new Map(); // `${repoPath}#${pr}` -> Promise<{worktree, branch}>

function git(repoPath, args, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...args], { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.message = `git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// `onProgress` receives human-readable status lines; the session pipes them into the
// terminal so a slow fetch doesn't look like a hang.
function ensure(repoPath, pr, onProgress = () => {}) {
  const key = `${repoPath}#${pr}`;
  if (inFlight.has(key)) {
    onProgress('waiting for the worktree another agent is creating…');
    return inFlight.get(key);
  }

  const branch = `ai-pr-${pr}`;
  const worktree = path.join(repoPath, '.claude', 'worktrees', `pr-${pr}`);

  const p = (async () => {
    if (fs.existsSync(worktree)) {
      onProgress(`reusing worktree ${worktree}`);
      return { worktree, branch, reused: true };
    }
    // pull/<n>/head rather than the PR's branch name, so PRs from forks work without
    // adding the fork as a remote. `+` forces the local branch to the PR head if a
    // previous run left it behind.
    onProgress(`fetching pull/${pr}/head…`);
    await git(repoPath, ['fetch', 'origin', `+pull/${pr}/head:${branch}`]);

    onProgress(`creating worktree ${worktree}…`);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await git(repoPath, ['worktree', 'add', worktree, branch]);

    // Base refs, so the agent can diff against the default branch. Best-effort: a
    // failure here (offline, no perms) shouldn't block the review.
    try {
      await git(repoPath, ['fetch', 'origin'], 120_000);
    } catch (e) {
      onProgress(`warning: ${e.message}`);
    }
    return { worktree, branch, reused: false };
  })();

  // Retain only while pending: a failed setup must be retryable on the next click,
  // and a succeeded one is cheap to re-check via existsSync.
  inFlight.set(key, p);
  p.finally(() => inFlight.delete(key)).catch(() => {});
  return p;
}

module.exports = { ensure };
