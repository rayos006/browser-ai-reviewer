'use strict';
// Input validation for anything that reaches the filesystem or a git ref.
//
// These values are post-authentication (the token gates every route), so this is
// defence in depth rather than the front line. It matters anyway: `repo` is joined
// onto a base directory and `pr` onto a worktree path, so without a charset check
// a value like `../../../../tmp` walks straight out of the configured repoBases.
// GitHub's own charsets are narrow, so nothing legitimate is lost.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // GitHub: alphanumeric + hyphen, <=39
const REPO = /^[A-Za-z0-9._-]{1,100}$/;              // GitHub: alphanumeric . _ -
const PR = /^[0-9]{1,10}$/;                          // digits only

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

// Returns normalised {owner, repo, pr}; throws a 400 otherwise.
function prTarget({ owner, repo, pr }) {
  // `.` and `..` pass the charset test but are still directory traversal.
  if (!REPO.test(String(repo || '')) || repo === '.' || repo === '..') {
    throw bad('invalid repo name');
  }
  if (!PR.test(String(pr || ''))) throw bad('invalid pr number');
  if (owner != null && owner !== '' && !OWNER.test(String(owner))) {
    throw bad('invalid owner name');
  }
  return { owner: owner ? String(owner) : null, repo: String(repo), pr: String(pr) };
}

// Only requests addressed to this machine by loopback name are served. Without this
// a page on evil.com can point its own hostname at 127.0.0.1 (DNS rebinding) and then
// same-origin policy lets it read our responses, which is the one thing the missing
// CORS headers are there to prevent.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).replace(/:\d+$/, ''); // strip port
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

module.exports = { prTarget, hostAllowed };
