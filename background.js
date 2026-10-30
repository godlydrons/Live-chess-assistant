//final update//

const BASE_URL = self.location.href.replace(/[^/]*$/, '');
let sendToEngine = null;
let engineReady = false;
let engineSearching = false;
let currentEval = '0.00';
let currentPv = [];
let latestDepthReached = 0;

let activeJob = null;
let queuedJob = null;
let stopWatchdog = null;
let hardKillWatchdog = null;

const attachedTabs = new Set();

function clearWatchdogs() {
  if (stopWatchdog) {
    clearTimeout(stopWatchdog);
    stopWatchdog = null;
  }
  if (hardKillWatchdog) {
    clearTimeout(hardKillWatchdog);
    hardKillWatchdog = null;
  }
}

function handleEngineLine(line) {
  if (typeof line !== 'string') return;

  if (line === 'readyok') {
    engineReady = true;
    console.log('[BG] stockfish-19-asm.js Ready!');
    if (!engineSearching && queuedJob) {
      const next = queuedJob;
      queuedJob = null;
      startAsmSearch(next);
    }
    return;
  }

  if (line.startsWith('info ') && line.includes(' pv ')) {
    const dm = line.match(/\bdepth\s+(\d+)/);
    const sc = line.match(/\bscore\s+cp\s+(-?\d+)/);
    const sm = line.match(/\bscore\s+mate\s+(-?\d+)/);
    const pvPart = line.split(' pv ')[1];

    if (dm) latestDepthReached = parseInt(dm[1], 10);
    if (sc) currentEval = (parseInt(sc[1], 10) / 100).toFixed(2);
    if (sm) currentEval = `M${sm[1]}`;

    if (pvPart) {
      const moves = pvPart.trim().split(/\s+/).filter(m => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m));
      if (moves.length > 0) currentPv = moves;
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    clearWatchdogs();
    engineSearching = false;

    const finishedJob = activeJob;
    activeJob = null;

    // If a newer board arrived while this search was running, discard the old result
    // and immediately launch the newest board!
    if (queuedJob) {
      if (finishedJob && finishedJob.resolve) {
        finishedJob.resolve({ ok: false, superseded: true });
      }
      const next = queuedJob;
      queuedJob = null;
      startAsmSearch(next);
      return;
    }

    if (!finishedJob || !finishedJob.resolve) return;

    const bm = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)(?:\s+ponder\s+([a-h][1-8][a-h][1-8][qrbn]?))?/);
    const bestUci = bm ? bm[1] : currentPv[0];
    const ponderUci = bm ? (bm[2] || (currentPv[0] === bestUci ? currentPv[1] : null)) : null;

    if (bestUci) {
      finishedJob.resolve({
        ok: true,
        fen: finishedJob.fen,
        uci: bestUci,
        ponder: ponderUci || null,
        pv: currentPv,
        depth: latestDepthReached || finishedJob.depth || 7,
        eval: currentEval,
        source: 'asm-local'
      });
    } else {
      finishedJob.resolve({ ok: false, error: 'No bestmove' });
    }
  }
}

self.postMessage = function (msg) {
  handleEngineLine(typeof msg === 'string' ? msg : (msg?.data || ''));
};

function initAsmEngine() {
  try {
    importScripts(BASE_URL + 'stockfish-19-asm.js');

    if (typeof self.Stockfish === 'function') {
      self.Stockfish({
        listener: (line) => handleEngineLine(line)
      }).then((instance) => {
        if (instance.addMessageListener) {
          instance.addMessageListener((line) => handleEngineLine(line));
        }
        sendToEngine = (cmd) => {
          if (instance.postMessage) instance.postMessage(cmd);
          else if (instance.ccall) instance.ccall('command', null, ['string'], [cmd]);
        };
        sendToEngine('uci');
        sendToEngine('setoption name Threads value 1');
        sendToEngine('setoption name Hash value 32');
        sendToEngine('isready');
      }).catch((err) => console.warn('[BG] Stockfish factory error:', err));
    } else if (typeof self.onmessage === 'function') {
      sendToEngine = (cmd) => self.onmessage({ data: cmd });
      sendToEngine('uci');
      sendToEngine('setoption name Threads value 1');
      sendToEngine('setoption name Hash value 32');
      sendToEngine('isready');
    }
  } catch (e) {
    console.warn('[BG] Failed to import stockfish-19-asm.js:', e.message);
  }
}

initAsmEngine();

function startAsmSearch(job) {
  currentEval = '0.00';
  currentPv = [];
  latestDepthReached = 0;
  engineSearching = true;
  activeJob = job;

  clearWatchdogs();
  const softCapMs = job.movetime || 350;

  // Stage 1 Watchdog: Ask Stockfish cleanly to stop and emit bestmove
  stopWatchdog = setTimeout(() => {
    if (engineSearching && sendToEngine) {
      sendToEngine('stop');
    }
  }, softCapMs);

  // Stage 2 Watchdog: If Stockfish ignored `go` (e.g. bad FEN) and never emitted `bestmove`,
  // force-unlock after softCapMs + 250ms so content.js NEVER gets stuck on "Calc D7..."!
  hardKillWatchdog = setTimeout(() => {
    if (engineSearching) {
      engineSearching = false;
      const stuckJob = activeJob;
      activeJob = null;
      if (stuckJob && stuckJob.resolve) {
        if (currentPv.length > 0) {
          stuckJob.resolve({
            ok: true,
            fen: stuckJob.fen,
            uci: currentPv[0],
            ponder: currentPv[1] || null,
            pv: currentPv,
            depth: latestDepthReached || stuckJob.depth || 7,
            eval: currentEval,
            source: 'asm-watchdog'
          });
        } else {
          stuckJob.resolve({ ok: false, error: 'Watchdog unlock' });
        }
      }
      if (queuedJob) {
        const next = queuedJob;
        queuedJob = null;
        startAsmSearch(next);
      }
    }
  }, softCapMs + 250);

  sendToEngine('position fen ' + job.fen);
  if (job.depth && job.movetime) {
    sendToEngine('go depth ' + job.depth + ' movetime ' + job.movetime);
  } else if (job.depth) {
    sendToEngine('go depth ' + job.depth);
  } else if (job.movetime) {
    sendToEngine('go movetime ' + job.movetime);
  } else {
    sendToEngine('go depth 7');
  }
}

function queryLocalAsm(fen, depth, movetime) {
  return new Promise((resolve) => {
    if (!sendToEngine || !engineReady) {
      return resolve({ ok: false });
    }

    const newJob = { fen, depth, movetime, resolve };

    if (engineSearching) {
      // If activeJob is already searching the EXACT same FEN, supersede the duplicate request
      if (activeJob && activeJob.fen === fen) {
        return resolve({ ok: false, superseded: true });
      }
      if (queuedJob && queuedJob.resolve) {
        queuedJob.resolve({ ok: false, superseded: true });
      }
      queuedJob = newJob;
      sendToEngine('stop');
    } else {
      startAsmSearch(newJob);
    }
  });
}

/* ── Chrome Debugger Protocol (CDP) Hardware-Trusted Mouse Move ── */
if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attachedTabs.delete(source.tabId);
  });
}

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function ensureDebuggerAttached(tabId) {
  if (!chrome.debugger) throw new Error('Debugger API unsupported');
  if (attachedTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '';
        if (msg.includes('Already attached')) {
          attachedTabs.add(tabId);
          resolve();
        } else {
          reject(new Error(msg));
        }
      } else {
        attachedTabs.add(tabId);
        resolve();
      }
    });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function executeCdpMove(tabId, msg) {
  await ensureDebuggerAttached(tabId);
  const { sx, sy, dx, dy, px, py } = msg;

  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy, button: 'none', buttons: 0 });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y: sy, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(16);

  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: dx, y: dy, button: 'none', buttons: 0 });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: dx, y: dy, button: 'left', buttons: 1, clickCount: 1 });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: dx, y: dy, button: 'left', buttons: 0, clickCount: 1 });

  if (px != null && py != null) {
    await sleep(95);
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1 });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1 });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'analyze') {
    handleAnalyze(msg, sendResponse);
    return true;
  }
  if (msg.action === 'cdpMove') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false });
      return false;
    }
    executeCdpMove(tabId, msg)
      .then(() => sendResponse({ ok: true, method: 'cdp' }))
      .catch((err) => {
        attachedTabs.delete(tabId);
        executeCdpMove(tabId, msg)
          .then(() => sendResponse({ ok: true, method: 'cdp-retry' }))
          .catch((err2) => sendResponse({ ok: false, error: err2.message }));
      });
    return true;
  }
});

async function handleAnalyze(msg, sendResponse) {
  const targetDepth = msg.depth || 7;
  const targetMovetime = msg.movetime || 350;

  const asmRes = await queryLocalAsm(msg.fen, targetDepth, targetMovetime);
  if (asmRes && asmRes.superseded) {
    sendResponse({ ok: false, superseded: true });
    return;
  }
  if (asmRes && asmRes.ok && asmRes.uci) {
    sendResponse(asmRes);
    return;
  }

  sendResponse({ ok: false, error: 'Engine unavailable' });
}
