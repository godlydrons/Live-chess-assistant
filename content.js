/**
 * Lichess Engine Pilot — content.js
 *
 * 1. Polls the board every POLL_INTERVAL_MS
 * 2. Detects our turn via FEN + player colour
 * 3. Fetches best move from stockfish.online REST API
 * 4. Fires mouse events on cg-board to execute the move
 */
(function () {
  "use strict";

  /* ── Constants ────────────────────────────────────────────── */
  const POLL_INTERVAL_MS = 600;
  const STOCKFISH_API    = "https://stockfish.online/api/s/v2.php";

  /* ── Live config (synced with popup) ─────────────────────── */
  let cfg = { depth: 12, delay: 180 };

  chrome.storage.local.get(["depth", "delay"], (r) => {
    if (r.depth != null) cfg.depth = r.depth;
    if (r.delay != null) cfg.delay = r.delay;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.depth) cfg.depth = changes.depth.newValue;
    if (changes.delay) cfg.delay = changes.delay.newValue;
  });

  /* ── State ────────────────────────────────────────────────── */
  let active    = false;
  let busy      = false;
  let lastFen   = "";
  let pollTimer = null;

  /* ── Bootstrap ────────────────────────────────────────────── */
  chrome.storage.local.get(["active"], (r) => {
    active = !!r.active;
    if (active) startPolling();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.active !== undefined) {
      active = changes.active.newValue;
      active ? startPolling() : stopPolling();
      log(active ? "▶ Engine Pilot ON" : "⏹ Engine Pilot OFF");
    }
  });

  /* ── Polling ──────────────────────────────────────────────── */
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
    log("Polling started");
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    busy = false;
  }

  async function tick() {
    if (!active || busy) return;

    const state = getBoardState();
    if (!state)           return;
    if (!state.isOurTurn) return;
    if (state.fen === lastFen) return;

    busy    = true;
    lastFen = state.fen;
    log("Our turn — FEN: " + state.fen);

    try {
      const uci = await fetchBestMove(state.fen);
      if (!uci || uci.length < 4) throw new Error("Bad UCI: " + uci);
      log("Best move: " + uci);
      await sleep(cfg.delay);
      playMove(uci, state.orientation);
      logMove(uci, state.fen);
    } catch (e) {
      log("Error: " + e.message);
    } finally {
      busy = false;
    }
  }

  /* ── Board state ──────────────────────────────────────────── */
  function getBoardState() {
    // Surface A: window.__pg (page data injected by Lichess)
    try {
      const pg = window.__pg;
      if (pg?.game?.fen && pg?.player?.color) {
        const color = pg.player.color;
        const turn  = fenTurn(pg.game.fen);
        return { fen: pg.game.fen, isOurTurn: turn === color[0], orientation: color };
      }
    } catch (_) {}

    // Surface B: window.lichess.round / .analysis
    try {
      const src = window.lichess?.round || window.lichess?.analysis;
      if (src) {
        const fen   = src.node?.fen || src.data?.game?.fen;
        const color = src.data?.player?.color || "white";
        if (fen) return { fen, isOurTurn: fenTurn(fen) === color[0], orientation: color };
      }
    } catch (_) {}

    // Surface C: data-fen attribute + orientation class
    try {
      const fenEl = document.querySelector("[data-fen]");
      if (fenEl) {
        const fen  = fenEl.getAttribute("data-fen");
        const wrap = document.querySelector("cg-wrap, .cg-wrap");
        const orientation = wrap?.classList.contains("orientation-black") ? "black" : "white";
        return { fen, isOurTurn: fenTurn(fen) === orientation[0], orientation };
      }
    } catch (_) {}

    return null;
  }

  function fenTurn(fen) {
    return (fen.split(" ")[1] || "w");
  }

  /* ── Engine ───────────────────────────────────────────────── */
  async function fetchBestMove(fen) {
    const url = `${STOCKFISH_API}?fen=${encodeURIComponent(fen)}&depth=${cfg.depth}`;
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data.success) throw new Error("Engine: " + JSON.stringify(data));
    const raw   = data.bestmove || "";
    const match = raw.match(/[a-h][1-8][a-h][1-8][qrbn]?/);
    return match ? match[0] : null;
  }

  /* ── Move execution ───────────────────────────────────────── */
  function squareToCoords(sq, rect, orientation) {
    const file = sq.charCodeAt(0) - 97;   // a=0…h=7
    const rank = parseInt(sq[1]) - 1;      // 1=0…8=7
    const sqW  = rect.width  / 8;
    const sqH  = rect.height / 8;
    let col, row;
    if (orientation === "white") { col = file;     row = 7 - rank; }
    else                         { col = 7 - file; row = rank;     }
    return { x: rect.left + col * sqW + sqW / 2,
             y: rect.top  + row * sqH + sqH / 2 };
  }

  function fire(el, type, x, y, buttons) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0, buttons,
    }));
  }

  function click(el, x, y) {
    fire(el, "mousedown", x, y, 1);
    fire(el, "mouseup",   x, y, 0);
    fire(el, "click",     x, y, 0);
  }

  function playMove(uci, orientation) {
    const from  = uci.slice(0, 2);
    const to    = uci.slice(2, 4);
    const promo = uci[4] || null;

    const board = document.querySelector("cg-board");
    if (!board) { log("No cg-board found"); return; }

    const rect = board.getBoundingClientRect();
    const src  = squareToCoords(from, rect, orientation);
    const dst  = squareToCoords(to,   rect, orientation);

    // Click source → small gap → click destination
    click(board, src.x, src.y);
    setTimeout(() => {
      click(board, dst.x, dst.y);
      if (promo) setTimeout(() => handlePromotion(promo), 150);
    }, 80);
  }

  function handlePromotion(piece) {
    const candidates = [
      `.promotion-choice [data-symbol="${piece.toUpperCase()}"]`,
      `.promotion-choice .${piece}`,
      `.cg-promotion .${piece}`,
      `.promotion-choice piece.${piece}`,
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) { el.click(); log("Promoted to " + piece); return; }
    }
    // Last resort: first available piece in dialog
    const fallback = document.querySelector(".promotion-choice piece, .cg-promotion piece");
    if (fallback) fallback.click();
  }

  /* ── Move log (written to storage for popup) ──────────────── */
  function logMove(uci, fen) {
    const now   = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const side  = fenTurn(fen) === "w" ? "White" : "Black";
    const entry = `${now}  ${uci}  (${side})`;
    chrome.storage.local.get(["moveLog"], (r) => {
      const moves = (r.moveLog ?? []).slice(-49);
      moves.push(entry);
      chrome.storage.local.set({ moveLog: moves });
    });
  }

  /* ── Utils ────────────────────────────────────────────────── */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function log(msg)  { console.log("[EnginePilot] " + msg); }

})();
