/**
 * background.js — Runs stockfish-19-asm.js directly in the Service Worker
 * Works natively on Android Chromium (no chrome.offscreen needed) & Desktop!
 */

const BASE_URL = self.location.href.replace(/[^/]*$/, '');
let sendToEngine = null;
let engineReady = false;
let engineSearching = false;
let currentEval = '0.00';
let activeResolve = null;
let queuedJob = null;

function handleEngineLine(line) {
  if (typeof line !== 'string') return;

  const sc = line.match(/score cp (-?\d+)/);
  if (sc) currentEval = (parseInt(sc[1], 10) / 100).toFixed(2);

  const sm = line.match(/score mate (-?\d+)/);
  if (sm) currentEval = `M${sm[1]}`;

  if (line === 'readyok') {
    engineReady = true;
    console.log('[BG] stockfish-19-asm.js Ready!');
  }

  if (line.startsWith('bestmove')) {
    engineSearching = false;
    if (queuedJob) {
      const next = queuedJob;
      queuedJob = null;
      startAsmSearch(next.fen, next.depth, next.movetime, next.resolve);
      return;
    }

    const bm = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)(?:\s+ponder\s+([a-h][1-8][a-h][1-8][qrbn]?))?/);
    if (activeResolve) {
      const resolve = activeResolve;
      activeResolve = null;
      if (bm) {
        resolve({ ok: true, uci: bm[1], ponder: bm[2] || null, eval: currentEval, source: 'asm-local' });
      } else {
        resolve({ ok: false });
      }
    }
  }
}

// 1. Provide a global postMessage hook in case nmrugg's stockfish-19-asm.js
// treats the ServiceWorkerGlobalScope as a dedicated Web Worker
self.postMessage = function (msg) {
  handleEngineLine(typeof msg === 'string' ? msg : (msg?.data || ''));
};

function initAsmEngine() {
  try {
    importScripts(BASE_URL + 'stockfish-19-asm.js');

    // Case A: nmrugg exported the Stockfish() factory function
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
    }
    // Case B: nmrugg auto-initialized in WorkerGlobalScope and attached self.onmessage
    else if (typeof self.onmessage === 'function') {
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

function startAsmSearch(fen, depth, movetime, resolve) {
  currentEval = '0.00';
  engineSearching = true;
  activeResolve = resolve;
  sendToEngine('position fen ' + fen);
  if (movetime) {
    sendToEngine('go movetime ' + movetime);
  } else {
    sendToEngine('go depth ' + (depth || 10));
  }
}

function queryLocalAsm(fen, depth, movetime) {
  return new Promise((resolve) => {
    if (!sendToEngine || !engineReady) {
      return resolve({ ok: false });
    }
    const timeoutMs = (movetime || 2000) + 1500;
    const timer = setTimeout(() => {
      if (activeResolve === wrappedResolve) {
        activeResolve = null;
        engineSearching = false;
        resolve({ ok: false });
      }
    }, timeoutMs);

    const wrappedResolve = (res) => {
      clearTimeout(timer);
      resolve(res);
    };

    if (engineSearching) {
      queuedJob = { fen, depth, movetime, resolve: wrappedResolve };
      sendToEngine('stop');
    } else {
      startAsmSearch(fen, depth, movetime, wrappedResolve);
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'analyze') {
    handleAnalyze(msg, sendResponse);
    return true;
  }
});

async function handleAnalyze(msg, sendResponse) {
  let targetMovetime = msg.movetime;
  let targetDepth = msg.depth || 10;

  if (msg.opponentRating) {
    const r = parseInt(msg.opponentRating, 10);
    if (r < 1200) {
      targetMovetime = Math.min(targetMovetime || 250, 150);
      targetDepth = Math.min(targetDepth, 8);
    } else if (r >= 2000) {
      targetDepth = Math.max(targetDepth, 14);
      targetMovetime = Math.max(targetMovetime || 1000, 1300);
    }
  }

  // 1. Primary: Local stockfish-19-asm.js inside Service Worker
  const asmRes = await queryLocalAsm(msg.fen, targetDepth, targetMovetime);
  if (asmRes && asmRes.ok && asmRes.uci) {
    sendResponse(asmRes);
    return;
  }

  // 2. Fallback: stockfish.online
  try {
    const d = Math.min(targetDepth, 13);
    const sfUrl = `https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(msg.fen)}&depth=${d}`;
    const res = await fetch(sfUrl);
    if (res.ok) {
      const data = await res.json();
      const m = (data.bestmove || '').match(/[a-h][1-8][a-h][1-8][qrbn]?/);
      const p = (data.bestmove || '').match(/ponder\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
      if (m) {
        sendResponse({
          ok: true,
          uci: m[0],
          ponder: p ? p[1] : null,
          eval: data.evaluation != null ? String(data.evaluation) : '0.00',
          source: 'sf.online'
        });
        return;
      }
    }
  } catch (_) {}

  // 3. Fallback: Lichess Cloud Eval
  try {
    const res = await fetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(msg.fen)}&multiPv=1`);
    if (res.ok) {
      const data = await res.json();
      const moves = data?.pvs?.[0]?.moves?.split(' ') || [];
      if (moves[0] && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moves[0])) {
        const cp = data?.pvs?.[0]?.cp;
        sendResponse({
          ok: true,
          uci: moves[0],
          ponder: moves[1] || null,
          eval: cp != null ? (cp / 100).toFixed(2) : 'cloud',
          source: 'cloud'
        });
        return;
      }
    }
  } catch (_) {}

  sendResponse({ ok: false, error: 'Engine unavailable' });
}
