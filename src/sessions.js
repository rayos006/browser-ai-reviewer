'use strict';
// Live agent sessions: one PTY each, an append-only output buffer the page polls,
// and an idle reaper so closing the tab doesn't leave agents running.

const crypto = require('crypto');
const pty = require('node-pty');
const repos = require('./repos');
const worktree = require('./worktree');

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

class Sessions {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new Map(); // id -> session
    this.reaper = setInterval(() => this.reap(), 30_000);
    this.reaper.unref();
  }

  agent(id) {
    return this.cfg.agents.find((a) => a.id === id);
  }

  // Output is served by absolute offset. Trimming old scrollback therefore has to
  // account for what was dropped, otherwise every client's `since` silently points
  // at the wrong place and the terminal fills with garbage.
  _append(sess, text) {
    sess.buffer += text;
    const max = this.cfg.scrollbackChars;
    if (sess.buffer.length > max) {
      const cut = sess.buffer.length - Math.floor(max / 2);
      sess.buffer = sess.buffer.slice(cut);
      sess.dropped += cut;
    }
  }

  // A status line from the bridge itself (not the agent). Dimmed so it reads as
  // distinct from agent output.
  _status(sess, line) {
    this._append(sess, `\x1b[2m[bridge] ${line}\x1b[0m\r\n`);
  }

  _fail(sess, line) {
    this._append(sess, `\r\n\x1b[31m[bridge] ${line}\x1b[0m\r\n`);
    sess.done = true;
  }

  // Returns the id synchronously; the worktree setup and PTY spawn continue in the
  // background, reporting progress into the buffer. That way the page can start
  // polling immediately and a slow `git fetch` looks like progress, not a hang.
  create({ owner, repo, pr, url, agent: agentId }) {
    const agent = this.agent(agentId);
    if (!agent) throw Object.assign(new Error(`unknown agent '${agentId}'`), { status: 400 });

    const repoPath = repos.find(owner, repo, this.cfg.repoBases);
    if (!repoPath) {
      throw Object.assign(
        new Error(`no local clone of '${owner ? owner + '/' : ''}${repo}' under: ${this.cfg.repoBases.join(', ')}`),
        { status: 404 },
      );
    }

    const id = crypto.randomBytes(8).toString('hex');
    const sess = {
      id, agentId, repo, pr, repoPath,
      buffer: '', dropped: 0, done: false,
      lastPolled: Date.now(), pty: null,
    };
    this.map.set(id, sess);

    this._status(sess, `${agent.label} · ${repo} #${pr} · ${repoPath}`);
    this._start(sess, agent, url).catch((e) => this._fail(sess, e.message));
    console.log(`[session ${id}] ${agent.label} ${owner || '?'}/${repo}#${pr} -> ${repoPath}`);
    return id;
  }

  async _start(sess, agent, url) {
    const { worktree: wt, branch } = await worktree.ensure(sess.repoPath, sess.pr, (line) =>
      this._status(sess, line),
    );
    if (sess.closed) return;

    // Substituted values arrive already shell-quoted, so templates must not add their
    // own quotes (`codex {PROMPT}`, not `codex '{PROMPT}'`) and a quote inside a
    // prompt can't break out of the command.
    const command = agent.command
      .replace(/\{PROMPT\}/g, shQuote(this.cfg.reviewPrompt))
      .replace(/\{URL\}/g, shQuote(url || ''))
      .replace(/\{PR\}/g, shQuote(sess.pr))
      .replace(/\{BRANCH\}/g, shQuote(branch))
      .replace(/\{WORKTREE\}/g, shQuote(wt));

    this._status(sess, `${branch} · running: ${command}`);

    // A login+interactive shell so the agent binary is found via the user's normal
    // PATH and so the session stays interactive for follow-up questions.
    const term = pty.spawn(this.cfg.shell, ['-ilc', command], {
      name: 'xterm-256color',
      cwd: wt,
      cols: this.cfg.cols,
      rows: this.cfg.rows,
      env: { ...process.env, TERM: 'xterm-256color', BAR_PR: String(sess.pr), BAR_WORKTREE: wt },
    });
    sess.pty = term;

    term.onData((d) => this._append(sess, d));
    term.onExit(({ exitCode }) => {
      this._append(sess, `\r\n\x1b[2m[bridge] ${agent.label} exited (${exitCode})\x1b[0m\r\n`);
      sess.done = true;
      sess.pty = null;
    });
  }

  // { offset, data(base64), done } — base64 so terminal control bytes survive JSON.
  read(id, since) {
    const sess = this.map.get(id);
    if (!sess) return null;
    sess.lastPolled = Date.now();

    const total = sess.dropped + sess.buffer.length;
    // since < dropped means the client fell far enough behind that we discarded what
    // it asked for; give it everything retained rather than nothing.
    const from = Math.max(0, Math.min(since, total) - sess.dropped);
    const chunk = sess.buffer.slice(from);
    return {
      offset: total,
      data: chunk ? Buffer.from(chunk, 'utf8').toString('base64') : '',
      done: sess.done,
    };
  }

  write(id, b64) {
    const sess = this.map.get(id);
    if (!sess || !sess.pty) return false;
    sess.lastPolled = Date.now();
    sess.pty.write(Buffer.from(b64 || '', 'base64').toString('utf8'));
    return true;
  }

  resize(id, cols, rows) {
    const sess = this.map.get(id);
    if (!sess || !sess.pty) return false;
    try { sess.pty.resize(cols || this.cfg.cols, rows || this.cfg.rows); } catch { return false; }
    return true;
  }

  close(id) {
    const sess = this.map.get(id);
    if (!sess) return false;
    sess.closed = true;
    if (sess.pty) { try { sess.pty.kill(); } catch {} }
    this.map.delete(id);
    console.log(`[session ${id}] closed`);
    return true;
  }

  // Kill sessions nobody has polled for idleTimeoutSec. A page that refreshed
  // resumes polling well inside the window, so this only catches real orphans.
  reap() {
    const cutoff = Date.now() - this.cfg.idleTimeoutSec * 1000;
    for (const [id, sess] of this.map) {
      if (sess.lastPolled < cutoff) {
        console.log(`[session ${id}] idle > ${this.cfg.idleTimeoutSec}s — reaping`);
        this.close(id);
      }
    }
  }

  closeAll() {
    for (const id of [...this.map.keys()]) this.close(id);
  }
}

module.exports = { Sessions, shQuote };
