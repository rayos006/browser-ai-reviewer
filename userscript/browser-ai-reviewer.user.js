// ==UserScript==
// @name         AI PR Review
// @namespace    browser-ai-reviewer
// @version      __VERSION__
// @description  Adds an "AI Review" button to GitHub PR pages that runs local AI agents on the PR in a git worktree and streams their terminals into a tabbed panel on the page.
// @match        https://github.com/*/*/pull/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js
// @resource     XTERM_CSS https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      __HOST__
// @updateURL    __INSTALL_URL__
// @downloadURL  __INSTALL_URL__
// @noframes
// ==/UserScript==

// NOTE: this file is a template. The local browser-ai-reviewer service serves it with
// the placeholders filled in from your config, which is why the agent tabs below always
// match the agents the service knows how to run. Don't install this file directly --
// install from the URL the installer prints.

(function () {
  'use strict';

  const SERVER = '__SERVER__';
  const TOKEN = '__TOKEN__';
  const COLS = __COLS__, ROWS = __ROWS__; // must match the PTY size the service allocates
  const AGENTS = __AGENTS__;              // [{id,label}], generated from the service config

  // Namespaced deliberately. The Hammerspoon-era script this replaces used the bare
  // 'ai-review-btn' / 'ai-review-panel', and since both guard on "does this id already
  // exist?", having both installed meant whichever loaded first won and the other
  // silently did nothing — one button on the page, no way to tell which script owned it.
  const BTN_ID = 'bar-ai-review-btn';
  const PANEL_ID = 'bar-ai-review-panel';

  GM_addStyle(GM_getResourceText('XTERM_CSS'));

  // ---- PR context ----------------------------------------------------------

  function prInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    const [, owner, repo, pr] = m;
    return { owner, repo, pr, url: `https://github.com/${owner}/${repo}/pull/${pr}` };
  }

  // Persisted per PR *and* agent so a refresh can reconnect to running sessions.
  const sessKey = (info, agentId) =>
    `bar:session:${info.owner}/${info.repo}#${info.pr}:${agentId}`;

  // ---- transport -----------------------------------------------------------

  // GM_xmlhttpRequest is the only channel that works here: GitHub's CSP has no
  // localhost in connect-src (so fetch/WebSocket from the page is blocked) and no
  // localhost in frame-src (so an iframe is blocked too). Tampermonkey's privileged
  // request runs outside page CSP.
  function gm(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SERVER + path + sep + 'token=' + encodeURIComponent(TOKEN),
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        onload: resolve,
        onerror: () => reject(new Error('cannot reach the review service — is it running? (browser-ai-reviewer)')),
        ontimeout: () => reject(new Error('timeout talking to the review service')),
      });
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64 || '');
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // Base64 so control bytes (Enter \r, Ctrl-C \x03, arrow escapes) survive JSON.
  function strToB64(s) {
    const u8 = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }

  async function isAlive(sessionId) {
    try {
      const r = await gm('GET', `/output?sessionId=${encodeURIComponent(sessionId)}&since=0`);
      return r.status === 200;
    } catch {
      return false;
    }
  }

  // ---- panel ---------------------------------------------------------------

  function buildPanel(info) {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', bottom: '16px', right: '16px',
      zIndex: '99999', background: '#0d1117',
      border: '1px solid #6b46c1', borderRadius: '8px',
      boxShadow: '0 8px 30px rgba(0,0,0,.5)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    });

    const bar = document.createElement('div');
    Object.assign(bar.style, {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px',
      background: '#161b22', color: '#c9d1d9',
      font: '12px -apple-system,system-ui,sans-serif', cursor: 'move',
      userSelect: 'none', flex: '0 0 auto',
    });

    const title = document.createElement('span');
    title.textContent = '🤖 AI Review';
    title.style.fontWeight = '600';
    bar.appendChild(title);

    const sub = document.createElement('span');
    sub.textContent = `${info.repo} #${info.pr}`;
    sub.style.opacity = '.7';
    sub.style.marginRight = '6px';
    bar.appendChild(sub);

    // --- tabs ---
    const tabs = {};  // agentId -> tab button
    const hosts = {}; // agentId -> terminal host div
    const terms = {}; // agentId -> xterm Terminal
    let active = AGENTS[0].id;

    const paintTabs = () => {
      for (const a of AGENTS) {
        const on = a.id === active;
        Object.assign(tabs[a.id].style, {
          background: on ? '#6b46c1' : 'transparent',
          color: on ? '#fff' : '#c9d1d9',
          fontWeight: on ? '600' : '400',
        });
        hosts[a.id].style.display = on ? '' : 'none';
      }
    };

    const setActive = (id) => {
      active = id;
      tabs[id].dataset.unread = ''; // clear the new-output dot
      tabs[id].textContent = tabs[id].dataset.label;
      paintTabs();
      terms[id].focus();
    };

    for (const a of AGENTS) {
      const t = document.createElement('button');
      t.dataset.label = a.label;
      t.textContent = a.label;
      Object.assign(t.style, {
        border: '1px solid #30363d', borderRadius: '5px',
        padding: '2px 10px', cursor: 'pointer', fontSize: '12px',
      });
      t.addEventListener('click', () => setActive(a.id));
      tabs[a.id] = t;
      bar.appendChild(t);
    }

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    bar.appendChild(spacer);

    const mkBtn = (label, tip) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = tip;
      Object.assign(b.style, {
        background: 'transparent', color: '#c9d1d9', border: 'none',
        cursor: 'pointer', fontSize: '14px', lineHeight: '1', padding: '2px 4px',
      });
      bar.appendChild(b);
      return b;
    };
    const minBtn = mkBtn('—', 'Minimize');
    const closeBtn = mkBtn('✕', 'Close (stops every running agent)');

    // --- terminal hosts (one per agent, only the active one visible) ---
    const body = document.createElement('div');
    Object.assign(body.style, { padding: '4px' });

    for (const a of AGENTS) {
      const host = document.createElement('div');
      body.appendChild(host);
      hosts[a.id] = host;

      const term = new window.Terminal({
        cols: COLS, rows: ROWS,
        cursorBlink: true,
        fontSize: 12, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: { background: '#0d1117' },
      });
      term.open(host);
      terms[a.id] = term;
    }

    panel.appendChild(bar);
    panel.appendChild(body);
    document.body.appendChild(panel);
    makeDraggable(panel, bar);
    paintTabs();

    let minimized = false;
    minBtn.addEventListener('click', () => {
      minimized = !minimized;
      body.style.display = minimized ? 'none' : '';
      minBtn.textContent = minimized ? '▢' : '—';
      minBtn.title = minimized ? 'Restore' : 'Minimize';
    });

    // Mark a background tab as having new output.
    const markUnread = (id) => {
      if (id === active) return;
      if (tabs[id].dataset.unread) return;
      tabs[id].dataset.unread = '1';
      tabs[id].textContent = tabs[id].dataset.label + ' •';
    };

    return { panel, terms, closeBtn, markUnread };
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = ox + (e.clientX - sx) + 'px';
      panel.style.top = oy + (e.clientY - sy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => (dragging = false));
  }

  // ---- one agent's session (start-or-reattach + I/O loop) -------------------

  // mode: 'start' = create if none, 'attach' = only reattach an existing live session.
  async function runAgent(info, agent, term, markUnread, mode) {
    const key = sessKey(info, agent.id);
    let sessionId = GM_getValue(key, null);
    let stopped = false, since = 0;

    if (sessionId && !(await isAlive(sessionId))) {
      GM_deleteValue(key);
      sessionId = null;
    }

    if (!sessionId) {
      if (mode === 'attach') {
        term.write(`\x1b[2m[${agent.label}: not running — click AI Review to start]\x1b[0m\r\n`);
        return { stop() {} };
      }
      term.write(`\x1b[2mStarting ${agent.label}…\x1b[0m\r\n`);
      let res;
      try {
        res = await gm('POST', '/session', {
          owner: info.owner, repo: info.repo, pr: info.pr, url: info.url, agent: agent.id,
        });
      } catch (e) {
        term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
        return { stop() {} };
      }
      if (res.status !== 200) {
        term.write(`\r\n\x1b[31m[service ${res.status}] ${res.responseText}\x1b[0m\r\n`);
        return { stop() {} };
      }
      sessionId = JSON.parse(res.responseText).sessionId;
    } else {
      term.write(`\x1b[2mReconnecting to ${agent.label}…\x1b[0m\r\n`);
    }
    GM_setValue(key, sessionId);

    // Adaptive polling: snappy while output is flowing, backing off when idle.
    const FAST = 50, SLOW = 400;
    let delay = FAST;

    term.onData((d) => {
      if (stopped) return;
      delay = FAST;
      gm('POST', '/input', { sessionId, data: strToB64(d) }).catch(() => {});
    });

    async function poll() {
      if (stopped) return;
      let r;
      try {
        r = await gm('GET', `/output?sessionId=${encodeURIComponent(sessionId)}&since=${since}`);
      } catch {
        if (!stopped) setTimeout(poll, 500);
        return;
      }
      if (r.status === 404) {
        term.write('\r\n\x1b[2m[session no longer available]\x1b[0m\r\n');
        GM_deleteValue(key);
        return;
      }
      if (r.status === 200) {
        const j = JSON.parse(r.responseText);
        if (j.data) {
          term.write(b64ToBytes(j.data));
          markUnread(agent.id);
          delay = FAST;
        } else {
          delay = Math.min(SLOW, Math.round(delay * 1.3));
        }
        since = j.offset;
        if (j.done) {
          term.write(`\r\n\x1b[2m[${agent.label} session ended]\x1b[0m\r\n`);
          GM_deleteValue(key);
          return;
        }
      }
      if (!stopped) setTimeout(poll, delay);
    }
    poll();

    return {
      stop() {
        stopped = true;
        gm('POST', '/close', { sessionId }).catch(() => {});
        GM_deleteValue(key);
      },
    };
  }

  // ---- open the panel and run every agent ----------------------------------

  async function openPanel(info, mode) {
    if (document.getElementById(PANEL_ID)) return;
    const { panel, terms, closeBtn, markUnread } = buildPanel(info);

    // Wire close immediately so it works before/while sessions start.
    const handles = [];
    closeBtn.addEventListener('click', () => {
      handles.forEach((h) => h && h.stop());
      panel.remove();
    });

    // Launch all agents concurrently; each drives its own tab.
    AGENTS.forEach((agent, i) => {
      runAgent(info, agent, terms[agent.id], markUnread, mode).then((h) => (handles[i] = h));
    });
  }

  // ---- button + init -------------------------------------------------------

  function ensureButton(info) {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '🤖 AI Review';
    btn.title = `Review PR #${info.pr} with ` + AGENTS.map((a) => a.label).join(' + ');
    btn.className = 'btn btn-sm';
    btn.style.cssText =
      'position:fixed;top:72px;right:16px;z-index:99999;margin:0;padding:8px 14px;' +
      'background:#6b46c1;color:#fff;border-color:#6b46c1;font-weight:600;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);';
    btn.addEventListener('click', () => openPanel(info, 'start'));
    document.body.appendChild(btn);
  }

  // On (re)load: if any agent still has a live session, reopen the panel and reattach.
  async function autoReconnect(info) {
    if (document.getElementById(PANEL_ID)) return;
    for (const a of AGENTS) {
      const sid = GM_getValue(sessKey(info, a.id), null);
      if (sid && (await isAlive(sid))) {
        openPanel(info, 'attach');
        return;
      }
      if (sid) GM_deleteValue(sessKey(info, a.id));
    }
  }

  let seenKey = null;
  function tick() {
    const info = prInfo();
    if (!info) return;
    ensureButton(info);
    const key = `${info.owner}/${info.repo}#${info.pr}`;
    if (key !== seenKey) {
      seenKey = key; // run reconnect once per PR (also covers SPA nav)
      autoReconnect(info);
    }
  }

  tick();
  setInterval(tick, 1000);
  document.addEventListener('turbo:load', tick);
  document.addEventListener('pjax:end', tick);
})();
