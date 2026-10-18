/**VAMOS
 */
(function () {
  "use strict";

  const PIECE_FEN = {
    "white king": "K", "white queen": "Q", "white rook": "R", "white bishop": "B", "white knight": "N", "white pawn": "P",
    "black king": "k", "black queen": "q", "black rook": "r", "black bishop": "b", "black knight": "n", "black pawn": "p"
  };

  let cfg = { depth: 10, delay: 40, orientation: "auto", mode: "autoplay", bulletMode: false };
  let active = false;
  let busy = false;
  let lastOurTurnBoard = null;
  let lastPonderBoard = null;
  let prevGrid = null;
  let lastDetectedTurn = "w";
  let queuedResponse = null;

  chrome.storage.local.get(["depth", "delay", "orientation", "mode", "bulletMode", "active"], (r) => {
    if (r.depth != null) cfg.depth = r.depth;
    if (r.delay != null) cfg.delay = r.delay;
    if (r.orientation != null) cfg.orientation = r.orientation;
    if (r.mode != null) cfg.mode = r.mode;
    if (r.bulletMode != null) cfg.bulletMode = r.bulletMode;
    active = !!r.active;
  });

  chrome.storage.onChanged.addListener((ch) => {
    if (ch.depth) cfg.depth = ch.depth.newValue;
    if (ch.delay) cfg.delay = ch.delay.newValue;
    if (ch.orientation) cfg.orientation = ch.orientation.newValue;
    if (ch.mode) cfg.mode = ch.mode.newValue;
    if (ch.bulletMode) cfg.bulletMode = ch.bulletMode.newValue;
  });

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.action === "toggleActive") {
      active = msg.value;
      busy = false;
      lastOurTurnBoard = null;
      lastPonderBoard = null;
      queuedResponse = null;
      if (!active) clearHighlights();
    }
    if (msg.action === "setMode") cfg.mode = msg.value;
    if (msg.action === "setBulletMode") cfg.bulletMode = msg.value;
    if (msg.action === "setDepth") cfg.depth = msg.value;
    sendResponse({ ok: true });
    return true;
  });

  function getOurColor() {
    if (cfg.orientation === "white" || cfg.orientation === "black") return cfg.orientation;
    const wrap = document.querySelector(".cg-wrap");
    return wrap?.classList.contains("orientation-black") ? "black" : "white";
  }

  function getOpponentRating() {
    try {
      const ourColor = getOurColor();
      const oppSelector = ourColor === "white" ? ".player.top rating, .ruser-top rating" : ".player.bottom rating, .ruser-bottom rating";
      const ratingEl = document.querySelector(oppSelector) || document.querySelector("rating");
      if (ratingEl) {
        const val = parseInt(ratingEl.textContent.replace(/\D/g, ""), 10);
        if (!isNaN(val) && val > 100) return val;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function detectTurn(grid, lastMoveSquares, ori) {
    // 1. Lichess live move list (<kwdb>)
    const moveNodes = document.querySelectorAll("kwdb, rm6 kwdb, l4x kwdb");
    if (moveNodes.length > 0) {
      return moveNodes.length % 2 === 0 ? "w" : "b";
    }

    // 2. Grid diff from previous frame
    if (prevGrid) {
      let whiteChanged = false;
      let blackChanged = false;
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const oldP = prevGrid[r][f];
          const newP = grid[r][f];
          if (oldP !== newP && newP) {
            if (newP === newP.toUpperCase()) whiteChanged = true;
            else blackChanged = true;
          }
        }
      }
      if (whiteChanged && !blackChanged) return "b";
      if (blackChanged && !whiteChanged) return "w";
    }

    // 3. Running clock
    if (document.querySelector(".rclock-bottom.running")) return ori === "white" ? "w" : "b";
    if (document.querySelector(".rclock-top.running")) return ori === "white" ? "b" : "w";

    // 4. Occupied square.last-move (for Puzzle Streak / Racer initial position)
    for (const lm of lastMoveSquares) {
      const p = grid[lm.r]?.[lm.f];
      if (p) {
        return p === p.toUpperCase() ? "b" : "w";
      }
    }

    return lastDetectedTurn || "w";
  }

  function scrapeBoardState() {
    const boardEl = document.querySelector("cg-board");
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    if (rect.width < 50) return null;
    if (boardEl.querySelector("piece.anim")) return null;

    const ori = getOurColor();
    const sqW = rect.width / 8;
    const sqH = rect.height / 8;
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    const lastMoveSquares = [];
    let placed = 0;

    function coordsFromStyle(el) {
      const style = el.getAttribute("style") || "";
      const tf = style.match(/translate(?:3d)?\(\s*([-\d.]+)px(?:,\s*([-\d.]+)px)?/);
      if (!tf) return null;
      const x = parseFloat(tf[1]);
      const y = tf[2] !== undefined ? parseFloat(tf[2]) : 0;
      const col = Math.max(0, Math.min(7, Math.round(x / sqW)));
      const row = Math.max(0, Math.min(7, Math.round(y / sqH)));
      const file = ori === "white" ? col : 7 - col;
      const rank = ori === "white" ? 7 - row : row;
      return { r: 7 - rank, f: file };
    }

    for (const sq of boardEl.querySelectorAll("square.last-move")) {
      const c = coordsFromStyle(sq);
      if (c) lastMoveSquares.push(c);
    }

    for (const p of boardEl.querySelectorAll("piece")) {
      if (p.classList.contains("ghost") || p.classList.contains("dragging") || p.classList.contains("fading")) continue;
      const cleanClass = p.className.replace(/\b(anim|fading|selected|check)\b/g, "").trim().replace(/\s+/g, " ");
      const letter = PIECE_FEN[cleanClass];
      if (!letter) continue;
      const c = coordsFromStyle(p);
      if (!c) continue;
      grid[c.r][c.f] = letter;
      placed++;
    }

    if (placed < 2) return null;

    let rows = "";
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = grid[r][f];
        if (p) {
          if (empty) { rows += empty; empty = 0; }
          rows += p;
        } else {
          empty++;
        }
      }
      if (empty) rows += empty;
      if (r < 7) rows += "/";
    }

    const prevRows = prevGrid ? prevGrid.map(r => r.map(c => c || ".").join("")).join("/") : null;
    const curRows = grid.map(r => r.map(c => c || ".").join("")).join("/");
    const detectedTurn = detectTurn(grid, lastMoveSquares, ori);

    if (curRows !== prevRows) {
      prevGrid = grid;
      lastDetectedTurn = detectedTurn;
    }

    let cas = "";
    if (grid[7][4] === "K") { if (grid[7][7] === "R") cas += "K"; if (grid[7][0] === "R") cas += "Q"; }
    if (grid[0][4] === "k") { if (grid[0][7] === "r") cas += "k"; if (grid[0][0] === "r") cas += "q"; }

    return {
      rows,
      fen: `${rows} ${detectedTurn} ${cas || "-"} - 0 1`,
      turn: detectedTurn,
      ori
    };
  }

  function applyUciToRows(rows, uci) {
    try {
      const b = rows.split("/").map(r => {
        const arr = [];
        for (const ch of r) {
          if (/\d/.test(ch)) for (let i = 0; i < parseInt(ch, 10); i++) arr.push(null);
          else arr.push(ch);
        }
        return arr;
      });
      const f1 = uci.charCodeAt(0) - 97, r1 = 8 - parseInt(uci[1], 10);
      const f2 = uci.charCodeAt(2) - 97, r2 = 8 - parseInt(uci[3], 10);
      const piece = b[r1][f1];
      if (!piece) return null;
      b[r1][f1] = null;
      b[r2][f2] = uci[4] ? (piece === piece.toUpperCase() ? uci[4].toUpperCase() : uci[4].toLowerCase()) : piece;

      return b.map(row => {
        let s = "", e = 0;
        for (const cell of row) {
          if (cell) { if (e) { s += e; e = 0; } s += cell; }
          else e++;
        }
        if (e) s += e;
        return s;
      }).join("/");
    } catch (_) {
      return null;
    }
  }

  function requestAnalysis(fen, options, oppRating) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: "analyze",
        fen,
        depth: options.depth,
        movetime: options.movetime,
        opponentRating: oppRating
      }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.ok && res.uci) resolve(res);
        else reject(new Error(res?.error || "Engine error"));
      });
    });
  }

  async function tick() {
    if (!active || busy) return;
    const state = scrapeBoardState();
    if (!state) return;

    const ourColorChar = state.ori[0];
    const isOurTurn = state.turn === ourColorChar;

    // 1. OPPONENT'S TURN -> PONDER / QUEUE MODE
    if (!isOurTurn) {
      if (state.rows === lastPonderBoard) return;
      lastPonderBoard = state.rows;
      ping("status", "🧠 Pondering opponent...");

      busy = true;
      try {
        const oppRes = await requestAnalysis(state.fen, { depth: Math.min(cfg.depth, 10), movetime: 300 }, null);
        if (oppRes?.uci && oppRes?.ponder) {
          const expectedRowsAfterOpp = applyUciToRows(state.rows, oppRes.uci);
          if (expectedRowsAfterOpp) {
            queuedResponse = {
              expectedRows: expectedRowsAfterOpp,
              ourMove: oppRes.ponder,
              eval: oppRes.eval || "0.00"
            };
            ping("status", `🎯 Queued: ${oppRes.ponder} (if ${oppRes.uci})`);
          }
        }
      } catch (_) {
      } finally {
        busy = false;
      }
      return;
    }

    // 2. OUR TURN
    if (state.rows === lastOurTurnBoard) return;
    busy = true;
    lastOurTurnBoard = state.rows;

    try {
      let uciToPlay = null;
      let ponderToDraw = null;
      let moveEval = "0.00";
      let moveSource = "asm-local";

      if (queuedResponse && queuedResponse.expectedRows === state.rows) {
        uciToPlay = queuedResponse.ourMove;
        moveEval = queuedResponse.eval;
        moveSource = "queue⚡";
        queuedResponse = null;
      } else {
        queuedResponse = null;
        const oppRating = getOpponentRating();
        ping("status", oppRating ? `⚡ Calc (vs ${oppRating})...` : "⚡ Calculating...");

        const options = cfg.bulletMode
          ? { movetime: 150, depth: 8 }
          : { depth: cfg.depth };

        const res = await requestAnalysis(state.fen, options, oppRating);
        uciToPlay = res.uci;
        ponderToDraw = res.ponder;
        moveEval = res.eval || "0.00";
        moveSource = res.source || "asm-local";
      }

      if (!uciToPlay) throw new Error("No move found");

      ping("status", `♟ ${uciToPlay} (${moveEval}) [${moveSource}]`);
      drawBoardOverlay(uciToPlay, ponderToDraw, state.ori);
      logMove(uciToPlay, moveEval);

      if (cfg.mode === "autoplay") {
        await sleep(Math.max(15, cfg.delay));
        await playMove(uciToPlay, state.ori);
      }
    } catch (e) {
      ping("status", "❌ " + e.message);
      lastOurTurnBoard = null;
    } finally {
      busy = false;
    }
  }

  function clearHighlights() {
    const existing = document.getElementById("ep-svg-overlay");
    if (existing) existing.remove();
  }

  function drawBoardOverlay(bestUci, ponderUci, ori) {
    const boardEl = document.querySelector("cg-board");
    if (!boardEl) return;

    let svg = document.getElementById("ep-svg-overlay");
    if (!svg || !boardEl.contains(svg)) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "ep-svg-overlay";
      svg.setAttribute("viewBox", "0 0 800 800");
      Object.assign(svg.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "99"
      });
      boardEl.appendChild(svg);
    }

    function sqCenterSvg(sq) {
      const f = sq.charCodeAt(0) - 97;
      const rk = parseInt(sq[1], 10) - 1;
      const col = ori === "white" ? f : 7 - f;
      const row = ori === "white" ? 7 - rk : rk;
      return { x: col * 100 + 50, y: row * 100 + 50, rx: col * 100, ry: row * 100 };
    }

    function buildArrow(uci, color, markerId, opacity) {
      if (!uci || uci.length < 4) return "";
      const s = sqCenterSvg(uci.slice(0, 2));
      const d = sqCenterSvg(uci.slice(2, 4));
      const dx = d.x - s.x, dy = d.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = d.x - (dx / len) * 28;
      const ey = d.y - (dy / len) * 28;
      return `
        <rect x="${s.rx}" y="${s.ry}" width="100" height="100" fill="${color}" fill-opacity="0.22" />
        <rect x="${d.rx}" y="${d.ry}" width="100" height="100" fill="${color}" fill-opacity="0.32" />
        <line x1="${s.x}" y1="${s.y}" x2="${ex}" y2="${ey}"
              stroke="${color}" stroke-opacity="${opacity}" stroke-width="14"
              stroke-linecap="round" marker-end="url(#${markerId})" />
      `;
    }

    svg.innerHTML = `
      <defs>
        <marker id="ep-g" markerWidth="3.5" markerHeight="3.5" refX="1.8" refY="1.75" orient="auto">
          <polygon points="0,0 3.5,1.75 0,3.5" fill="#14c83c" />
        </marker>
        <marker id="ep-b" markerWidth="3.5" markerHeight="3.5" refX="1.8" refY="1.75" orient="auto">
          <polygon points="0,0 3.5,1.75 0,3.5" fill="#38bdf8" />
        </marker>
      </defs>
      ${ponderUci ? buildArrow(ponderUci, "#38bdf8", "ep-b", "0.55") : ""}
      ${buildArrow(bestUci, "#14c83c", "ep-g", "0.9")}
    `;
  }

  function sqScreenCenter(sq, ori) {
    const b = document.querySelector("cg-board");
    const r = b.getBoundingClientRect();
    const sqW = r.width / 8, sqH = r.height / 8;
    const f = sq.charCodeAt(0) - 97, rk = parseInt(sq[1], 10) - 1;
    const col = ori === "white" ? f : 7 - f;
    const row = ori === "white" ? 7 - rk : rk;
    return { x: r.left + col * sqW + sqW / 2, y: r.top + row * sqH + sqH / 2 };
  }

  function firePointerAndMouse(el, type, x, y, buttons) {
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons
    };
    if (typeof PointerEvent !== "undefined") {
      el.dispatchEvent(new PointerEvent(type.replace("mouse", "pointer"), { ...opts, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
    }
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  async function playMove(uci, ori) {
    const board = document.querySelector("cg-board");
    if (!board) return;
    const src = sqScreenCenter(uci.slice(0, 2), ori);
    const dst = sqScreenCenter(uci.slice(2, 4), ori);
    const promo = uci[4] || null;

    firePointerAndMouse(board, "mousedown", src.x, src.y, 1);
    await sleep(20);
    firePointerAndMouse(board, "mousemove", dst.x, dst.y, 1);
    await sleep(20);
    firePointerAndMouse(board, "mousedown", dst.x, dst.y, 1);
    firePointerAndMouse(board, "mouseup", dst.x, dst.y, 0);

    if (promo) {
      await sleep(90);
      const promoEl = document.querySelector(
        `.promotion-choice [data-symbol="${promo.toUpperCase()}"], .promotion-choice .${promo}, .cg-promotion .${promo}`
      );
      if (promoEl) {
        const pr = promoEl.getBoundingClientRect();
        firePointerAndMouse(promoEl, "mousedown", pr.left + pr.width / 2, pr.top + pr.height / 2, 1);
        firePointerAndMouse(promoEl, "mouseup", pr.left + pr.width / 2, pr.top + pr.height / 2, 0);
        promoEl.click();
      }
    }
  }

  function logMove(uci, currentEval) {
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    chrome.storage.local.get(["moveLog"], (r) => {
      const arr = (r.moveLog || []).slice(-49);
      arr.push(`${now}  ${uci}  [${currentEval}]`);
      chrome.storage.local.set({ moveLog: arr });
    });
  }

  function ping(k, v) { chrome.storage.local.set({ [k]: v }); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  setInterval(tick, 200);

  function attachObserver() {
    const board = document.querySelector("cg-board");
    if (!board) {
      setTimeout(attachObserver, 300);
      return;
    }
    const obs = new MutationObserver(() => setTimeout(tick, 30));
    obs.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  }
  attachObserver();
})();
