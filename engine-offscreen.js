const worker = new Worker(chrome.runtime.getURL(' stockfish-19-asm.js'));

let sfReady = false;
let searching = false;
let currentEval = '0.00';
let pendingRespond = null;
let queuedCmd = null;
let timeoutTimer = null;

sfWorker.onmessage = (e) => {
  const line = typeof e.data === 'string' ? e.data : '';
  if (!line) return;

  const sc = line.match(/score cp (-?\d+)/);
  if (sc) currentEval = (parseInt(sc[1], 10) / 100).toFixed(2);

  const sm = line.match(/score mate (-?\d+)/);
  if (sm) currentEval = `M${sm[1]}`;

  if (line === 'readyok') {
    sfReady = true;
  }

  if (line.startsWith('bestmove')) {
    searching = false;
    if (queuedCmd) {
      const next = queuedCmd;
      queuedCmd = null;
      startSearch(next);
      return;
    }

    const bm = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)(?:\s+ponder\s+([a-h][1-8][a-h][1-8][qrbn]?))?/);
    if (pendingRespond) {
      const respond = pendingRespond;
      pendingRespond = null;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (bm) {
        respond({
          ok: true,
          uci: bm[1],
          ponder: bm[2] || null,
          eval: currentEval
        });
      } else {
        respond({ ok: false, error: 'No bestmove parsed' });
      }
    }
  }
};

sfWorker.postMessage('uci');
sfWorker.postMessage('setoption name Threads value 1');
sfWorker.postMessage('setoption name Hash value 64');
sfWorker.postMessage('isready');

function startSearch(msg) {
  currentEval = '0.00';
  searching = true;
  sfWorker.postMessage('position fen ' + msg.fen);
  if (msg.movetime) {
    sfWorker.postMessage('go movetime ' + msg.movetime);
  } else {
    sfWorker.postMessage('go depth ' + (msg.depth || 12));
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'engineAnalyze') {
    if (pendingRespond) {
      pendingRespond({ ok: false, error: 'Superseded' });
    }
    if (timeoutTimer) clearTimeout(timeoutTimer);

    pendingRespond = sendResponse;
    timeoutTimer = setTimeout(() => {
      if (pendingRespond) {
        const respond = pendingRespond;
        pendingRespond = null;
        searching = false;
        respond({ ok: false, error: 'WASM timeout' });
      }
    }, (msg.movetime || 2000) + 1200);

    if (searching) {
      queuedCmd = msg;
      sfWorker.postMessage('stop');
    } else {
      startSearch(msg);
    }
    return true;
  }
  return false;
});
