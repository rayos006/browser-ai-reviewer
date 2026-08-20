#!/usr/bin/env node
'use strict';
// browser-ai-reviewer — localhost bridge between a GitHub PR page and local AI agents.
//
//   POST /session {owner,repo,pr,url,agent} -> {sessionId}  (worktree + PTY)
//   GET  /output?sessionId=..&since=N       -> {offset,data(base64),done}
//   POST /input   {sessionId,data(base64)}                  (keystrokes -> PTY)
//   POST /resize  {sessionId,cols,rows}
//   POST /close   {sessionId}
//   GET  /browser-ai-reviewer.user.js       -> the userscript, config injected
//   GET  /health
//
// Transport shape: the page can't open a socket to us (GitHub's CSP connect-src has no
// localhost) so everything goes through Tampermonkey's privileged GM_xmlhttpRequest,
// and output is short-polled by absolute offset rather than streamed. Polling also
// doubles as the liveness signal the idle reaper uses.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const { Sessions } = require('./sessions');
const { inUse } = require('./port');

const pkg = require('../package.json');
const USERSCRIPT_PATH = path.join(__dirname, '..', 'userscript', 'browser-ai-reviewer.user.js');
const USERSCRIPT_ROUTE = '/browser-ai-reviewer.user.js';

const cfg = config.load();
const sessions = new Sessions(cfg);

function installUrl() {
  return `http://${cfg.host}:${cfg.port}${USERSCRIPT_ROUTE}?token=${cfg.token}`;
}

// --- userscript rendering ---------------------------------------------------

// The agent list, terminal size and token are injected here rather than duplicated in
// a checked-in script, so the page's tabs always match the agents this service can
// actually run. @version carries the config's mtime so editing the config makes
// Tampermonkey pull a fresh copy on its next update check.
function renderUserscript() {
  let mtimeMin = 0;
  try { mtimeMin = Math.floor(fs.statSync(cfg.configPath).mtimeMs / 60_000); } catch {}

  const agents = cfg.agents.map((a) => ({ id: a.id, label: a.label }));
  return fs.readFileSync(USERSCRIPT_PATH, 'utf8')
    .replace(/__VERSION__/g, `${pkg.version}.${mtimeMin}`)
    .replace(/__INSTALL_URL__/g, installUrl())
    .replace(/__SERVER__/g, `http://${cfg.host}:${cfg.port}`)
    .replace(/__HOST__/g, cfg.host)
    .replace(/__TOKEN__/g, cfg.token)
    .replace(/__COLS__/g, String(cfg.cols))
    .replace(/__ROWS__/g, String(cfg.rows))
    .replace(/__AGENTS__/g, JSON.stringify(agents));
}

// --- http helpers -----------------------------------------------------------

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  // Deliberately no Access-Control-Allow-Origin. GM_xmlhttpRequest is a privileged
  // request and doesn't need it; omitting it means an ordinary page can never read a
  // response from us even if it somehow learned the token.
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json');

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 1_000_000) { b = ''; req.destroy(); } // no request here is large
    });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function tokenOk(supplied) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- routes -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${cfg.host}`);
  const route = u.pathname;

  // Unauthenticated, and deliberately says nothing beyond "the service is up" — the
  // installer polls this before it opens the browser.
  if (route === '/health') {
    return json(res, 200, { ok: true, name: pkg.name, version: pkg.version });
  }

  // Everything else needs the token. It's the only thing standing between a random
  // page in your browser and a shell on your machine: the page can't *read* our
  // responses cross-origin, but without a secret it could still fire off a POST
  // /session and start processes.
  if (!tokenOk(u.searchParams.get('token') || req.headers['x-token'])) {
    return send(res, 403, 'forbidden');
  }

  if (req.method === 'GET' && route === USERSCRIPT_ROUTE) {
    // Tampermonkey needs this content type to offer the install page.
    return send(res, 200, renderUserscript(), 'text/javascript; charset=utf-8');
  }

  if (req.method === 'POST' && route === '/session') {
    const { owner, repo, pr, url, agent } = await readJson(req);
    if (!repo || !pr) return send(res, 400, 'missing repo/pr');
    try {
      return json(res, 200, { sessionId: sessions.create({ owner, repo, pr, url, agent }) });
    } catch (e) {
      return send(res, e.status || 500, e.message);
    }
  }

  if (req.method === 'GET' && route === '/output') {
    const out = sessions.read(u.searchParams.get('sessionId'), Number(u.searchParams.get('since')) || 0);
    return out ? json(res, 200, out) : send(res, 404, 'no session');
  }

  if (req.method === 'POST' && route === '/input') {
    const { sessionId, data } = await readJson(req);
    sessions.write(sessionId, data);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/resize') {
    const { sessionId, cols, rows } = await readJson(req);
    sessions.resize(sessionId, cols, rows);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/close') {
    const { sessionId } = await readJson(req);
    sessions.close(sessionId);
    return json(res, 200, { ok: true });
  }

  return send(res, 404, 'not found');
});

// --- cli --------------------------------------------------------------------

if (process.argv.includes('--install-url')) {
  console.log(installUrl());
  process.exit(0);
}
if (process.argv.includes('--print-config')) {
  console.log(JSON.stringify({ ...cfg, token: '<hidden>' }, null, 2));
  process.exit(0);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${cfg.port} is already in use — another copy is probably running.`);
    process.exit(1);
  }
  throw e;
});

// Bind succeeding doesn't mean the port is ours: see src/port.js. Probe first so a
// leftover listener shows up as a warning here rather than as requests mysteriously
// going somewhere else.
inUse(cfg.port, cfg.host).then((used) => {
  if (used) {
    console.warn(
      `WARNING: something is already listening on ${cfg.host}:${cfg.port}.\n` +
      `         Stop it, or change "port" in ${cfg.configPath} and reinstall the userscript.`,
    );
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`${pkg.name} ${pkg.version} listening on http://${cfg.host}:${cfg.port}`);
  console.log(`config:     ${cfg.configPath}`);
  console.log(`repo bases: ${cfg.repoBases.join(', ') || '(none found — set repoBases in the config)'}`);
  console.log(`agents:     ${cfg.agents.map((a) => a.id).join(', ')}`);
  console.log(`userscript: ${installUrl()}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — stopping ${sessions.map.size} session(s)`);
    sessions.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
