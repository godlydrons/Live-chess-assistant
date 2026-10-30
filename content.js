(function () {
  "use strict";

  const PIECE_FEN = {
    "white king": "K", "white queen": "Q", "white rook": "R", "white bishop": "B", "white knight": "N", "white pawn": "P",
    "black king": "k", "black queen": "q", "black rook": "r", "black bishop": "b", "black knight": "n", "black pawn": "p"
  };

  const START_ROWS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

  let cfg = { depth: 9, delay: 15, orientation: "auto", mode: "autoplay", bulletMode: false, racerMode: false };
  let active = false;
  let busy = false;
  let busySince = 0;

  let lastOurTurnBoard = null;
  let expectedAfterOurMoveRows = null; // Blocks Bullet from thinking our own move is the opponent's move!
  let prevGrid = null;
  let prevRows = null;

  let searchWave = 0;
  let lastWaveTimestamp = 0;
  let autoPlayedThisTurn = false;
  let lastAutoClickTime = 0;
  let autoClickRetries = 0;
  let multiDepthArrows = [];
  let pendingPromoChar = "q";

  let castlingRights = { K: true, Q: true, k: true, q: true };
  let enPassantSq = "-";
  let fullMoveNum = 1;
  let prevPieceCount = 0;

  let shadowHost = null;
  let shadowRoot = null;
  let shadowSvg = null;

  function setBusy(val) {
    busy = val;
    busySince = val ? Date.now() : 0;
  }

  chrome.storage.local.get(["depth", "delay", "orientation", "mode", "bulletMode", "racerMode", "active"], (r) => {
    if (r.depth != null) cfg.depth = r.depth;
    if (r.delay != null) cfg.delay = r.delay;
    if (r.orientation != null) cfg.orientation = r.orientation;
    if (r.mode != null) cfg.mode = r.mode;
    if (r.bulletMode != null) cfg.bulletMode = r.bulletMode;
    if (r.racerMode != null) cfg.racerMode = r.racerMode;
    active = !!r.active;
  });

  chrome.storage.onChanged.addListener((ch) => {
    if (ch.depth) cfg.depth = ch.depth.newValue;
    if (ch.delay) cfg.delay = ch.delay.newValue;
    if (ch.orientation) cfg.orientation = ch.orientation.newValue;
    if (ch.mode) cfg.mode = ch.mode.newValue;
    if (ch.bulletMode) cfg.bulletMode = ch.bulletMode.newValue;
    if (ch.racerMode) cfg.racerMode = ch.racerMode.newValue;
    if (ch.active) {
      active = !!ch.active.newValue;
      resetState();
      if (!active) clearHighlights();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.action === "toggleActive") {
      active = msg.value;
      resetState();
      if (!active) clearHighlights();
    }
    if (msg.action === "setMode") cfg.mode = msg.value;
    if (msg.action === "setBulletMode") cfg.bulletMode = msg.value;
    if (msg.action === "setRacerMode") cfg.racerMode = msg.value;
    if (msg.action === "setDepth") cfg.depth = msg.value;
    sendResponse({ ok: true });
    return true;
  });

  function resetState() {
    setBusy(false);
    lastOurTurnBoard = null;
    expectedAfterOurMoveRows = null;
    multiDepthArrows = [];
    searchWave = 0;
    lastWaveTimestamp = 0;
    autoPlayedThisTurn = false;
    lastAutoClickTime = 0;
    autoClickRetries = 0;
  }

  function getOurColor() {
    if (cfg.orientation === "white" || cfg.orientation === "black") return cfg.orientation;
    const wrap = document.querySelector(".cg-wrap");
    return wrap?.classList.contains("orientation-black") ? "black" : "white";
  }

  function isLiveClockGame() {
    return !!document.querySelector(".rclock");
  }

  function isPuzzleStreakOrTraining() {
    const p = location.pathname;
    return p.includes("/streak") || p.includes("/training");
  }

  function isPuzzleStormOrRacer() {
    if (isLiveClockGame()) return false; // NEVER treat a 1+0 or 3+2 game as Racer!
    const p = location.pathname;
    return cfg.racerMode || p.includes("/storm") || p.includes("/racer");
  }

  // Predicts the exact board `rows` string after `uci` is played on `grid`
  // so we NEVER mistake our own optimistic move on the board for the opponent's reply!
  function computeRowsAfterMove(grid, uci) {
    if (!grid || !uci || uci.length < 4) return null;
    const g = grid.map(row => row.slice());
    const f1 = uci.charCodeAt(0) - 97, r1 = 8 - parseInt(uci[1], 10);
    const f2 = uci.charCodeAt(2) - 97, r2 = 8 - parseInt(uci[3], 10);
    const promo = uci[4];
    const p = g[r1]?.[f1];
    if (!p) return null;

    g[r1][f1] = null;
    // En-passant capture cleanup
    if ((p === "P" || p === "p") && f1 !== f2 && !g[r2][f2]) {
      g[r1][f2] = null;
    }
    // Castling rook jump
    if (p === "K" && f1 === 4 && f2 === 6) { g[7][7] = null; g[7][5] = "R"; }
    if (p === "K" && f1 === 4 && f2 === 2) { g[7][0] = null; g[7][3] = "R"; }
    if (p === "k" && f1 === 4 && f2 === 6) { g[0][7] = null; g[0][5] = "r"; }
    if (p === "k" && f1 === 4 && f2 === 2) { g[0][0] = null; g[0][3] = "r"; }

    if (promo) {
      g[r2][f2] = p === p.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
    } else {
      g[r2][f2] = p;
    }

    let rows = "";
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const cell = g[r][f];
        if (cell) {
          if (empty) { rows += empty; empty = 0; }
          rows += cell;
        } else {
          empty++;
        }
      }
      if (empty) rows += empty;
      if (r < 7) rows += "/";
    }
    return rows;
  }

  function detectTurn(grid, rows, lastMoveSquares, ori) {
    const ourChar = ori === "black" ? "b" : "w";
    const oppChar = ourChar === "w" ? "b" : "w";

    // 0. ANTI-PREMOVE LOCK: If the board on screen is the exact board produced by OUR last move,
    //    it is 100% the OPPONENT'S turn (even if Lichess's clock hasn't updated over the network yet)!
    if (expectedAfterOurMoveRows && rows === expectedAfterOurMoveRows) {
      return oppChar;
    }

    // 1. STORM, RACER, STREAK, TRAINING: Once animations settle and it's not our own post-move board,
    //    it is ALWAYS our turn to solve!
    if (isPuzzleStormOrRacer() || isPuzzleStreakOrTraining()) {
      return ourChar;
    }

    // 2. LIVE 1+0 & 3+2 GAMES:
    //    Priority A: 0ms Board Ground Truth (`square.last-move`).
    //    In a normal game, there are 2 `last-move` squares (origin = empty, dest = piece that just moved).
    //    Because Chessground updates `square.last-move` at 0ms when we move (whereas `.rclock` lags by ~100ms),
    //    checking `lastMoveSquares` first prevents all false premoves!
    if (lastMoveSquares.length === 2) {
      const occupied = [];
      for (const lm of lastMoveSquares) {
        const p = grid[lm.r]?.[lm.f];
        if (p) occupied.push(p);
      }
      if (occupied.length >= 1) {
        const movedPiece = occupied[0];
        return movedPiece === movedPiece.toUpperCase() ? "b" : "w";
      }
    }

    //    Priority B: Move-List Structure (<i5z>MoveNum</i5z><kwdb>WhiteMove</kwdb><kwdb>BlackMove</kwdb>)
    const allKwdb = document.querySelectorAll("kwdb");
    if (allKwdb.length > 0) {
      const lastKwdb = allKwdb[allKwdb.length - 1];
      const prevEl = lastKwdb.previousElementSibling;
      if (prevEl) {
        const tag = prevEl.tagName.toLowerCase();
        if (tag === "i5z" || tag === "index") return "b";
        if (tag === "kwdb") return "w";
      }
    }

    //    Priority C: Running clock fallback
    if (document.querySelector(".rclock-bottom.running")) return ourChar;
    if (document.querySelector(".rclock-top.running")) return oppChar;

    //    Priority D: Starting position is always White's turn
    if (rows === START_ROWS) return "w";

    return ourChar;
  }

  function countGridDiffs(g1, g2) {
    if (!g1 || !g2) return 99;
    let diffs = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (g1[r][f] !== g2[r][f]) diffs++;
      }
    }
    return diffs;
  }

  function updateChainState(grid, rows, placedCount) {
    const diffs = countGridDiffs(prevGrid, grid);
    if (rows === START_ROWS || placedCount > prevPieceCount + 1 || diffs > 4 || isPuzzleStormOrRacer()) {
      castlingRights = { K: true, Q: true, k: true, q: true };
      enPassantSq = "-";
      fullMoveNum = 1;
    }
    prevPieceCount = placedCount;

    if (grid[7][4] !== "K") { castlingRights.K = false; castlingRights.Q = false; }
    if (grid[7][7] !== "R") castlingRights.K = false;
    if (grid[7][0] !== "R") castlingRights.Q = false;

    if (grid[0][4] !== "k") { castlingRights.k = false; castlingRights.q = false; }
    if (grid[0][7] !== "r") castlingRights.k = false;
    if (grid[0][0] !== "r") castlingRights.q = false;

    enPassantSq = "-";
    if (prevGrid && diffs === 2 && !isPuzzleStormOrRacer()) {
      for (let f = 0; f < 8; f++) {
        if (prevGrid[6][f] === "P" && !grid[6][f] && !grid[5][f] && grid[4][f] === "P") {
          enPassantSq = String.fromCharCode(97 + f) + "3";
          break;
        }
        if (prevGrid[1][f] === "p" && !grid[1][f] && !grid[2][f] && grid[3][f] === "p") {
          enPassantSq = String.fromCharCode(97 + f) + "6";
          break;
        }
      }
    }
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
    let wKings = 0, bKings = 0;

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

    for (const p of boardEl.children) {
      if (p.tagName.toLowerCase() !== "piece") continue;
      if (p.classList.contains("ghost") || p.classList.contains("dragging") || p.classList.contains("fading")) continue;
      const cleanClass = p.className.replace(/\b(anim|fading|selected|check|last-dest|current)\b/g, "").trim().replace(/\s+/g, " ");
      const letter = PIECE_FEN[cleanClass];
      if (!letter) continue;
      const c = coordsFromStyle(p);
      if (!c) continue;

      if ((letter === "P" || letter === "p") && (c.r === 0 || c.r === 7)) return null;
      if (letter === "K") wKings++;
      if (letter === "k") bKings++;

      grid[c.r][c.f] = letter;
      placed++;
    }

    if (wKings !== 1 || bKings !== 1 || placed < 2) return null;

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

    const detectedTurn = detectTurn(grid, rows, lastMoveSquares, ori);

    if (rows !== prevRows) {
      updateChainState(grid, rows, placed);
      if (detectedTurn === "w") fullMoveNum++;
      prevGrid = grid;
      prevRows = rows;
    } else {
      if (grid[7][4] !== "K") { castlingRights.K = false; castlingRights.Q = false; }
      if (grid[7][7] !== "R") castlingRights.K = false;
      if (grid[7][0] !== "R") castlingRights.Q = false;
      if (grid[0][4] !== "k") { castlingRights.k = false; castlingRights.q = false; }
      if (grid[0][7] !== "r") castlingRights.k = false;
      if (grid[0][0] !== "r") castlingRights.q = false;
    }

    let cas = "";
    if (castlingRights.K) cas += "K";
    if (castlingRights.Q) cas += "Q";
    if (castlingRights.k) cas += "k";
    if (castlingRights.q) cas += "q";

    return {
      rows,
      grid,
      fen: `${rows} ${detectedTurn} ${cas || "-"} ${enPassantSq} 0 ${fullMoveNum}`,
      turn: detectedTurn,
      ori,
      rect
    };
  }

  function isUciLegalOnGrid(grid, uci, ourTurnChar) {
    if (!uci || uci.length < 4 || !grid) return false;
    const f1 = uci.charCodeAt(0) - 97, r1 = 8 - parseInt(uci[1], 10);
    const f2 = uci.charCodeAt(2) - 97, r2 = 8 - parseInt(uci[3], 10);
    if (f1 === f2 && r1 === r2) return false;

    const srcPiece = grid[r1]?.[f1];
    if (!srcPiece) return false;

    const isWhitePiece = srcPiece === srcPiece.toUpperCase();
    if ((ourTurnChar === "w" && !isWhitePiece) || (ourTurnChar === "b" && isWhitePiece)) return false;

    const dstPiece = grid[r2]?.[f2];
    if (dstPiece) {
      const isDstWhite = dstPiece === dstPiece.toUpperCase();
      if (isWhitePiece === isDstWhite) return false;
    }

    if ((srcPiece === "K" || srcPiece === "k") && Math.abs(f2 - f1) === 2) {
      if (uci === "e1g1" && (!castlingRights.K || grid[7][5] || grid[7][6] || grid[7][7] !== "R")) return false;
      if (uci === "e1c1" && (!castlingRights.Q || grid[7][1] || grid[7][2] || grid[7][3] || grid[7][0] !== "R")) return false;
      if (uci === "e8g8" && (!castlingRights.k || grid[0][5] || grid[0][6] || grid[0][7] !== "r")) return false;
      if (uci === "e8c8" && (!castlingRights.q || grid[0][1] || grid[0][2] || grid[0][3] || grid[0][0] !== "r")) return false;
    }

    return true;
  }

  function requestAnalysis(fen, options) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: "analyze",
        fen,
        depth: options.depth,
        movetime: options.movetime
      }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.superseded) return resolve({ superseded: true });
        if (res?.ok && res.uci) resolve(res);
        else reject(new Error(res?.error || "Engine error"));
      });
    });
  }

  async function handleOpenPromotionModal() {
    const promoModal = document.querySelector("#promotion-choice");
    if (!promoModal) return false;
    const roleMap = { q: "queen", n: "knight", r: "rook", b: "bishop" };
    const targetRole = roleMap[pendingPromoChar] || "queen";
    const pieceEl = promoModal.querySelector(`piece.${targetRole}`) || promoModal.querySelector("piece.queen") || promoModal.querySelector("piece");
    if (pieceEl) {
      const r = pieceEl.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      chrome.runtime.sendMessage({ action: "cdpMove", sx: cx, sy: cy, dx: cx, dy: cy }, () => {});
      return true;
    }
    return false;
  }

  async function tick() {
    if (!active) return;

    if (document.querySelector("#promotion-choice")) {
      if (!busy) {
        setBusy(true);
        await handleOpenPromotionModal();
        await sleep(50);
        setBusy(false);
      }
      return;
    }

    const state = scrapeBoardState();
    if (!state) return;

    syncOverlayPos(state.rect);

    const ourColorChar = state.ori[0];
    const isOurTurn = state.turn === ourColorChar;

    // 1. OPPONENT'S TURN
    if (!isOurTurn) {
      lastOurTurnBoard = null;
      searchWave = 0;
      autoPlayedThisTurn = false;
      autoClickRetries = 0;
      ping("status", "👀 Opponent's turn...");
      return;
    }

    // 2. OUR TURN: If the board changed, clear our post-move lock and reset wave state
    if (state.rows !== lastOurTurnBoard) {
      expectedAfterOurMoveRows = null;
      lastOurTurnBoard = state.rows;
      searchWave = 0;
      lastWaveTimestamp = 0;
      autoPlayedThisTurn = false;
      lastAutoClickTime = 0;
      autoClickRetries = 0;
      multiDepthArrows = [];
      clearHighlights();
    }

    const inStreak = isPuzzleStreakOrTraining();
    const inRacer = isPuzzleStormOrRacer();

    // Give Streak up to 1800ms before busy timeout; fast modes 750ms
    const busyTimeoutMs = inStreak ? 1800 : 750;
    if (busy) {
      if (busySince > 0 && Date.now() - busySince > busyTimeoutMs) {
        setBusy(false);
        lastOurTurnBoard = null;
        searchWave = 0;
      }
      return;
    }

    // SMART RETRY GUARD: If Auto-Play clicked 350ms ago and the board still hasn't changed:
    if (
      cfg.mode === "autoplay" &&
      autoPlayedThisTurn &&
      multiDepthArrows.length > 0 &&
      lastAutoClickTime > 0
    ) {
      if (Date.now() - lastAutoClickTime <= 350) return;

      const latestArrow = multiDepthArrows[multiDepthArrows.length - 1];
      if (autoClickRetries < 1 && isUciLegalOnGrid(state.grid, latestArrow.uci, ourColorChar)) {
        setBusy(true);
        autoClickRetries++;
        lastAutoClickTime = Date.now();
        try {
          expectedAfterOurMoveRows = computeRowsAfterMove(state.grid, latestArrow.uci);
          await playMove(latestArrow.uci, state.ori);
        } finally {
          setBusy(false);
        }
        return;
      } else {
        if (latestArrow.uci === "e1g1") castlingRights.K = false;
        if (latestArrow.uci === "e1c1") castlingRights.Q = false;
        if (latestArrow.uci === "e8g8") castlingRights.k = false;
        if (latestArrow.uci === "e8c8") castlingRights.q = false;

        expectedAfterOurMoveRows = null;
        lastOurTurnBoard = null;
        searchWave = 0;
        autoPlayedThisTurn = false;
        autoClickRetries = 0;
        multiDepthArrows = [];
        clearHighlights();
        return;
      }
    }

    if (autoPlayedThisTurn || searchWave >= 3) return;
    if (cfg.mode === "autoplay" && searchWave >= 1) return;

    // MODE-SPECIFIC DEPTH SELECTION:
    // - Streak / Training: Depth 12 (Maximum accuracy, zero blunders!)
    // - Storm / Racer: Depth 9 (High tactical accuracy, ~40ms on easy puzzles, ~250ms on hard ones)
    // - Bullet Mode (1+0): Depth 6 (Instant speed)
    // - Normal (3+2): User popup depth
    const wave0Depth = inStreak
      ? Math.max(cfg.depth, 12)
      : inRacer
        ? Math.max(cfg.depth, 9)
        : cfg.bulletMode
          ? 6
          : cfg.depth;

    const waveDepths = [wave0Depth, wave0Depth + 2, wave0Depth + 4];

    if (searchWave > 0 && Date.now() - lastWaveTimestamp < 300) return;

    setBusy(true);
    const currentWave = searchWave;
    const boardAtStart = state.rows;
    const fenAtStart = state.fen;
    const waveColors = ["#14c83c", "#f59e0b", "#06b6d4"];
    const targetDepth = waveDepths[currentWave];

    try {
      const movetimeCap = inStreak
        ? 1350
        : inRacer
          ? 420
          : cfg.bulletMode
            ? 180
            : 450;

      ping("status", currentWave === 0 ? `⚡ Calc D${targetDepth}...` : `🔥 Deepening D${targetDepth}...`);

      const res = await requestAnalysis(fenAtStart, { depth: targetDepth, movetime: movetimeCap });
      if (res?.superseded) return;

      if (res?.fen && res.fen !== fenAtStart) {
        lastOurTurnBoard = null;
        searchWave = 0;
        return;
      }

      const verifyState = scrapeBoardState();
      if (!verifyState || verifyState.rows !== boardAtStart) return;

      const uciToPlay = res.uci;
      const ponderToDraw = res.ponder;
      const moveEval = res.eval || "0.00";
      const actualDepth = res.depth || targetDepth;

      if (!uciToPlay || !isUciLegalOnGrid(verifyState.grid, uciToPlay, ourColorChar)) {
        if (uciToPlay === "e1g1") castlingRights.K = false;
        if (uciToPlay === "e1c1") castlingRights.Q = false;
        if (uciToPlay === "e8g8") castlingRights.k = false;
        if (uciToPlay === "e8c8") castlingRights.q = false;
        lastOurTurnBoard = null;
        searchWave = 0;
        return;
      }

      searchWave = currentWave + 1;
      lastWaveTimestamp = Date.now();

      multiDepthArrows.push({
        uci: uciToPlay,
        ponder: ponderToDraw,
        depth: actualDepth,
        eval: moveEval,
        wave: currentWave,
        color: waveColors[currentWave]
      });

      const summary = multiDepthArrows.map(a => `D${a.depth}:${a.uci}`).join(" | ");
      ping("status", `♟ ${summary} (${moveEval})`);
      drawMultiDepthOverlay(multiDepthArrows, verifyState.ori);
      logMove(uciToPlay, `${moveEval} D${actualDepth}`);

      if (cfg.mode === "autoplay" && !autoPlayedThisTurn) {
        autoPlayedThisTurn = true;
        await sleep(Math.max(10, cfg.delay));
        const checkBeforeClick = scrapeBoardState();
        if (checkBeforeClick && checkBeforeClick.rows === boardAtStart) {
          // Record the exact board state our move will create so we NEVER play on our own move!
          expectedAfterOurMoveRows = computeRowsAfterMove(checkBeforeClick.grid, uciToPlay);
          lastAutoClickTime = Date.now();
          await playMove(uciToPlay, verifyState.ori);
        }
      }
    } catch (e) {
      lastOurTurnBoard = null;
      searchWave = 0;
    } finally {
      setBusy(false);
    }
  }

  /* ── Closed Shadow DOM Multi-Depth Overlay ────────────────────── */
  function ensureShadowOverlay() {
    if (shadowHost && document.documentElement.contains(shadowHost)) return;
    shadowHost = document.createElement("div");
    shadowHost.style.cssText = "position:fixed; pointer-events:none; z-index:2147483647; top:0; left:0; width:0; height:0;";
    shadowRoot = shadowHost.attachShadow({ mode: "closed" });
    shadowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    shadowSvg.setAttribute("viewBox", "0 0 800 800");
    shadowSvg.style.cssText = "position:fixed; pointer-events:none; overflow:visible;";
    shadowRoot.appendChild(shadowSvg);
    document.documentElement.appendChild(shadowHost);
  }

  function syncOverlayPos(rect) {
    if (!shadowSvg || !rect) return;
    shadowSvg.style.left = rect.left + "px";
    shadowSvg.style.top = rect.top + "px";
    shadowSvg.style.width = rect.width + "px";
    shadowSvg.style.height = rect.height + "px";
  }

  function clearHighlights() {
    if (shadowSvg) shadowSvg.innerHTML = "";
  }

  function drawMultiDepthOverlay(arrows, ori) {
    const boardEl = document.querySelector("cg-board");
    if (!boardEl || !arrows.length) return;
    ensureShadowOverlay();
    syncOverlayPos(boardEl.getBoundingClientRect());

    function sqCenterSvg(sq) {
      const f = sq.charCodeAt(0) - 97;
      const rk = parseInt(sq[1], 10) - 1;
      const col = ori === "white" ? f : 7 - f;
      const row = ori === "white" ? 7 - rk : rk;
      return { x: col * 100 + 50, y: row * 100 + 50, rx: col * 100, ry: row * 100 };
    }

    const grouped = new Map();
    for (const a of arrows) {
      if (!grouped.has(a.uci)) {
        grouped.set(a.uci, { ...a, depths: [`D${a.depth}`] });
      } else {
        const g = grouped.get(a.uci);
        g.color = a.color;
        g.eval = a.eval;
        g.ponder = a.ponder || g.ponder;
        g.wave = a.wave;
        if (!g.depths.includes(`D${a.depth}`)) g.depths.push(`D${a.depth}`);
      }
    }

    let defsHtml = `
      <marker id="ep-pnd" markerWidth="3.5" markerHeight="3.5" refX="1.8" refY="1.75" orient="auto">
        <polygon points="0,0 3.5,1.75 0,3.5" fill="#38bdf8" />
      </marker>
    `;
    let shapesHtml = "";

    const latest = arrows[arrows.length - 1];
    if (latest?.ponder && latest.ponder.length >= 4) {
      const ps = sqCenterSvg(latest.ponder.slice(0, 2));
      const pd = sqCenterSvg(latest.ponder.slice(2, 4));
      const dx = pd.x - ps.x, dy = pd.y - ps.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = pd.x - (dx / len) * 28, ey = pd.y - (dy / len) * 28;
      shapesHtml += `
        <line x1="${ps.x}" y1="${ps.y}" x2="${ex}" y2="${ey}"
              stroke="#38bdf8" stroke-opacity="0.5" stroke-width="10"
              stroke-dasharray="18,12" stroke-linecap="round" marker-end="url(#ep-pnd)" />
      `;
    }

    let idx = 0;
    for (const [uci, item] of grouped.entries()) {
      const mId = `ep-m-${idx++}`;
      defsHtml += `
        <marker id="${mId}" markerWidth="3.5" markerHeight="3.5" refX="1.8" refY="1.75" orient="auto">
          <polygon points="0,0 3.5,1.75 0,3.5" fill="${item.color}" />
        </marker>
      `;
      const s = sqCenterSvg(uci.slice(0, 2));
      const d = sqCenterSvg(uci.slice(2, 4));
      const dx = d.x - s.x, dy = d.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      const ex = d.x - (dx / len) * 28;
      const ey = d.y - (dy / len) * 28;
      const mx = (s.x + ex) / 2;
      const my = (s.y + ey) / 2;
      const label = item.depths.join("·");

      shapesHtml += `
        <rect x="${s.rx}" y="${s.ry}" width="100" height="100" fill="${item.color}" fill-opacity="0.18" />
        <rect x="${d.rx}" y="${d.ry}" width="100" height="100" fill="${item.color}" fill-opacity="0.28" />
        <line x1="${s.x}" y1="${s.y}" x2="${ex}" y2="${ey}"
              stroke="${item.color}" stroke-opacity="0.92" stroke-width="14"
              stroke-linecap="round" marker-end="url(#${mId})" />
        <rect x="${mx - 42}" y="${my - 16}" width="84" height="32" rx="8"
              fill="#0f172a" fill-opacity="0.88" stroke="${item.color}" stroke-width="2.5" />
        <text x="${mx}" y="${my + 7}" fill="#ffffff" font-family="monospace" font-weight="bold"
              font-size="19" text-anchor="middle">${label}</text>
      `;
    }

    shadowSvg.innerHTML = `<defs>${defsHtml}</defs>${shapesHtml}`;
  }

  /* ── Auto-Move: Trusted Two-Click CDP ─────────────────────────── */
  function sqScreenCenter(sq, ori) {
    const b = document.querySelector("cg-board");
    const r = b.getBoundingClientRect();
    const sqW = r.width / 8, sqH = r.height / 8;
    const f = sq.charCodeAt(0) - 97, rk = parseInt(sq[1], 10) - 1;
    const col = ori === "white" ? f : 7 - f;
    const row = ori === "white" ? 7 - rk : rk;
    return { x: Math.round(r.left + col * sqW + sqW / 2), y: Math.round(r.top + row * sqH + sqH / 2), sqH };
  }

  async function playMove(uci, ori) {
    const board = document.querySelector("cg-board");
    if (!board) return;
    const src = sqScreenCenter(uci.slice(0, 2), ori);
    const dst = sqScreenCenter(uci.slice(2, 4), ori);
    const promo = (uci[4] || "").toLowerCase() || null;

    let px = null, py = null;
    if (promo) {
      pendingPromoChar = promo;
      const offsetIdx = promo === "n" ? 1 : promo === "r" ? 2 : promo === "b" ? 3 : 0;
      const dstRank = parseInt(uci[3], 10);
      const isTopEdge = (ori === "white" && dstRank === 8) || (ori === "black" && dstRank === 1);
      const dir = isTopEdge ? 1 : -1;
      px = dst.x;
      py = Math.round(dst.y + dir * offsetIdx * dst.sqH);
    }

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "cdpMove",
        sx: src.x,
        sy: src.y,
        dx: dst.x,
        dy: dst.y,
        px,
        py
      }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) resolve(false);
        else resolve(true);
      });
    });

    if (promo) {
      await sleep(80);
      if (document.querySelector("#promotion-choice")) {
        await handleOpenPromotionModal();
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

  setInterval(tick, 30);

  function attachObserver() {
    const board = document.querySelector("cg-board");
    if (!board) {
      setTimeout(attachObserver, 200);
      return;
    }
    const obs = new MutationObserver(() => tick());
    obs.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
  }
  attachObserver();
})();
