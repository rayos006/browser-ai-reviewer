'use strict';
// Port availability, done by probing for a listener rather than trying to bind.
//
// A bind test gives the wrong answer here: a wildcard listener (0.0.0.0:8765) does not
// prevent binding the more specific 127.0.0.1:8765, so both end up listening and
// loopback traffic silently goes to whichever bound more specifically. That's exactly
// the situation on a machine still running the Hammerspoon bridge this replaces, and
// it produces a baffling "my changes do nothing" failure.

const net = require('net');

function inUse(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (used) => { sock.destroy(); resolve(used); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false)); // ECONNREFUSED — nothing listening
    sock.connect(port, host);
  });
}

// First port at or above `start` with nothing listening on it.
async function pickFree(start, span = 20, host = '127.0.0.1') {
  for (let p = start; p < start + span; p++) {
    if (!(await inUse(p, host))) return p;
  }
  return start;
}

module.exports = { inUse, pickFree };
