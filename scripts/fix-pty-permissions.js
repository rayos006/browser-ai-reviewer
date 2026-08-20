#!/usr/bin/env node
'use strict';
// node-pty ships a small `spawn-helper` binary alongside its prebuilds, and depending
// on the npm/tar version that extracted the package it can land without the execute
// bit. When that happens every pty.spawn() fails with the deeply unhelpful
// "posix_spawnp failed." — so normalise it here rather than let each user hit it.
//
// Runs as a postinstall hook; a no-op on Windows and whenever the bit is already set.

const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const fixed = [];

function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'spawn-helper') {
      const mode = fs.statSync(p).mode;
      if (!(mode & 0o111)) {
        fs.chmodSync(p, mode | 0o755);
        fixed.push(p);
      }
    }
  }
}

walk(path.join(root, 'prebuilds'));
walk(path.join(root, 'build'));

if (fixed.length) {
  console.log(`[postinstall] made node-pty spawn-helper executable:\n  ${fixed.join('\n  ')}`);
}
