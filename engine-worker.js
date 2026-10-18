/**
 * engine-worker.js
 */
const BASE_URL = self.location.href.replace(/[^/]*$/, '');
importScripts(BASE_URL + 'stockfish-19-asm.js');


let sf = null;
let ready = false;
let buffer = [];
let currentEval = '0.00';
let searching = false;
let pendingSearch = null;

Stockfish({
  locateFile: (path) => BASE_URL + (path.endsWith('.wasm') ? 'stockfish-19-lite.wasm' : path)
}).then((engine) => {
  sf = engine;

  sf.addMessageListener((line) => {
    const scoreMatch = line.match(/score cp (-?\d+)/);
    if (scoreMatch) currentEval = (parseInt(scoreMatch[1], 10) / 100).toFixed(2);

    const mateMatch = line.match(/score mate (-?\d+)/);
    if (mateMatch) currentEval = `M${mateMatch[1]}`;

    if (line.startsWith('bestmove')) {
      searching = false;
      // If a newer search arrived while stopping the old one, run the newer one instead
      if (pendingSearch) {
        const next = pendingSearch;
        pendingSearch = null;
        startSearch(next);
        return;
      }

      const bm = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)(?:\s+ponder\s+([a-h][1-8][a-h][1-8][qrbn]?))?/);
      if (bm) {
        postMessage({
          type: 'bestmove',
          uci: bm[1],
          ponder: bm[2] || null,
          eval: currentEval
        });
      }
    }

    if (line === 'readyok') {
      ready = true;
      postMessage({ type: 'ready' });
      buffer.forEach((cmd) => sf.postMessage(cmd));
      buffer = [];
    }
  });

  sf.postMessage('uci');
  sf.postMessage('setoption name Threads value 1');
  sf.postMessage('setoption name Hash value 64');
  sf.postMessage('isready');
});

function send(cmd) {
  if (sf && ready) sf.postMessage(cmd);
  else buffer.push(cmd);
}

function startSearch(data) {
  currentEval = '0.00';
  searching = true;
  send('position fen ' + data.fen);
  if (data.movetime) {
    send('go movetime ' + data.movetime);
  } else {
    send('go depth ' + (data.depth || 12));
  }
}

onmessage = (e) => {
  if (e.data.cmd === 'analyze') {
    if (searching) {
      pendingSearch = e.data;
      send('stop');
    } else {
      startSearch(e.data);
    }
  }
};
