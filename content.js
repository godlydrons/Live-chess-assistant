/**
 * Lichess Engine Pilot — content.js v11
 *
 * THE ACTUAL BUG (finally crystal clear):
 *
 * WS fires for every move. The "uci" field in the WS message
 * IS the move that was just played. We can determine whose move
 * it was by checking if it was our piece that moved.
 *
 * But simpler and more reliable: use PLY PARITY.
 *
 * We are Black. Our moves happen on even ply (2,4,6...).
 * After OUR move: ply is even → next turn is White (opponent).
 * After OPPONENT move: ply is odd → next turn is Black (us).
 *
 * So: fire engine only when (ply is ODD and we are Black)
 *                        or (ply is EVEN and we are White)
 *
 * This means: fire when it just became OUR turn.
 * = fire when the OPPONENT just moved.
 *
 * Previous bug: was computing "whose turn is it now" correctly,
 * but the WS event for OUR move also triggered the engine
 * because the guard "if (!ourTurn) return" was checking the
 * turn AFTER the move, but the FEN used was from BEFORE the move.
 *
 * Real issue: Lichess WS "move" message for your OWN move:
 *   - arrives AFTER you tap the board
 *   - ply increments, so now it looks like opponent's turn
 *   - but the FEN in the message is the position AFTER your move
 *   - engine runs on that FEN and suggests moves for opponent
 *
 * CORRECT LOGIC:
 * - Track the last FEN we suggested for
 * - When WS fires: check if ply parity matches "opponent just moved"
 * - Use the FEN from the WS message directly (it's always current)
 * - Never re-suggest for same FEN
 */
(function () {
  "use strict";

  const PIECE_FEN = {
    "white king":"K","white queen":"Q","white rook":"R",
    "white bishop":"B","white knight":"N","white pawn":"P",
    "black king":"k","black queen":"q","black rook":"r",
    "black bishop":"b","black knight":"n","black pawn":"p",
  };

  /* ── Config ──────────────────────────────────────────────────── */
  let cfg = { depth:8, delay:80, orientation:"auto", cropBox:null, mode:"autoplay" };
  chrome.storage.local.get(["depth","delay","orientation","cropBox","mode"], (r) => {
    if (r.depth       != null) cfg.depth       = r.depth;
    if (r.delay       != null) cfg.delay       = r.delay;
    if (r.orientation != null) cfg.orientation = r.orientation;
    if (r.cropBox     != null) cfg.cropBox     = r.cropBox;
    if (r.mode        != null) cfg.mode        = r.mode;
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.depth)       cfg.depth       = ch.depth.newValue;
    if (ch.delay)       cfg.delay       = ch.delay.newValue;
    if (ch.orientation) cfg.orientation = ch.orientation.newValue;
    if (ch.cropBox)     cfg.cropBox     = ch.cropBox.newValue;
    if (ch.mode)        cfg.mode        = ch.mode.newValue;
    if (ch.cropDraw?.newValue) launchCropOverlay();
  });

  /* ── Inject WS sniffer at document_start ────────────────────── */
  const injectScript = document.createElement("script");
  injectScript.textContent = `
(function(){
  if (window.__epInjected) return;
  window.__epInjected = true;
  window.__epColor = null;

  function detectColor() {
    try {
      for (const s of document.querySelectorAll("script:not([src])")) {
        const m = s.textContent.match(/"color"\s*:\s*"(white|black)"/);
        if (m) { window.__epColor = m[1]; return; }
      }
    } catch(_) {}
  }
  detectColor();
  document.addEventListener("DOMContentLoaded", detectColor);
  setTimeout(detectColor, 2000);

  const _WS = window.WebSocket;
  window.WebSocket = function(...a) {
    const ws = new _WS(...a);
    ws.addEventListener("message", function(e) {
      try {
        const d = JSON.parse(e.data);
        if (!d) return;
        if (d.t === "move" && d.d) {
          window.dispatchEvent(new CustomEvent("__ep_move", {
            detail: {
              fen: d.d.fen || null,
              ply: d.d.ply,
              uci: d.d.uci || "",
            }
          }));
        }
        if (d.t === "state" && d.d && d.d.moves !== undefined) {
          const moves = (d.d.moves||"").trim().split(/\s+/).filter(Boolean);
          window.dispatchEvent(new CustomEvent("__ep_move", {
            detail: { fen: null, ply: moves.length, uci: moves.at(-1)||"" }
          }));
        }
      } catch(_) {}
    });
    return ws;
  };
  Object.assign(window.WebSocket, _WS);
})();
  `;
  (document.head || document.documentElement).prepend(injectScript);
  injectScript.remove();

  /* ── State ───────────────────────────────────────────────────── */
  let active = false, busy = false;
  let lastHandledFen = null, playerColor = null;
  let wsReceived = false;
  const isPuzzle = /\/(training|puzzle)/.test(location.pathname);

  chrome.storage.local.get(["active"], (r) => {
    active = !!r.active;
    ping("status", active ? "🟢 Watching…" : "⚫ Inactive");
    if (active) setTimeout(pollCheck, 1200);
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.active == null) return;
    active = ch.active.newValue;
    if (!active) {
      ping("status","⚫ Inactive");
      clearHighlights(); busy = false; lastHandledFen = null;
    } else {
      ping("status","🟢 Watching…");
      playerColor = null; wsReceived = false;
      setTimeout(pollCheck, 800);
    }
  });

  /* ══════════════════════════════════════════════════════════════
     REACTIVE PATH

     KEY INSIGHT:
     The WS "move" message fires for EVERY move.
     d.ply = total moves played INCLUDING the one just made.

     We are e.g. Black.
     - White plays e4  → ply becomes 1 (odd)  → FEN has Black to move  → OUR TURN ✓
     - We play e5      → ply becomes 2 (even) → FEN has White to move  → NOT OUR TURN ✗
     - White plays Nf3 → ply becomes 3 (odd)  → FEN has Black to move  → OUR TURN ✓
     - We play Nc6     → ply becomes 4 (even) → FEN has White to move  → NOT OUR TURN ✗

     Rule for Black:  fire when ply is ODD  (opponent White just moved)
     Rule for White:  fire when ply is EVEN (opponent Black just moved)

     The FEN in the WS message is the position AFTER the move just played.
     So when ply is odd (White just moved), FEN shows Black to move → correct.
  ══════════════════════════════════════════════════════════════ */
  window.addEventListener("__ep_move", async (e) => {
    if (!active) return;
    wsReceived = true;

    const { fen, ply, uci } = e.detail;
    if (!playerColor) playerColor = getPlayerColor();
    if (!playerColor) {
      setTimeout(() => { playerColor = getPlayerColor(); }, 500);
      return;
    }

    /*
     * After this WS move, whose turn is it?
     * The FEN's active color tells us directly.
     * We can also derive from ply:
     *   odd ply  → White just moved → Black's turn now
     *   even ply → Black just moved → White's turn now
     */
    const turnInFen = fen ? fen.split(" ")[1] : ((ply % 2 === 1) ? "b" : "w");

    // Is it NOW our turn (after this move landed)?
    const ourTurn = (turnInFen === "w" && playerColor === "white") ||
                    (turnInFen === "b" && playerColor === "black");

    log(`WS ply=${ply} uci=${uci} turnInFen=${turnInFen} playerColor=${playerColor} ourTurn=${ourTurn}`);
    ping("status", `${ourTurn ? "🎯 Our turn" : "⏳ Opponent"} [${playerColor}/${turnInFen}]`);

    if (!ourTurn || busy) return;
    if (!fen) { log("No FEN in WS"); return; }
    if (fen === lastHandledFen) return;

    // This FEN already has the correct turn (opponent just moved, it's our turn)
    await go(fen);
  });

  /* ── Poll path: first move as White + puzzles ────────────────── */
  function pollCheck() {
    if (!active || busy) return;
    if (!isPuzzle && wsReceived) return;
    if (!playerColor) playerColor = getPlayerColor();

    const state = getBoardState();
    if (!state) { ping("status","⚠️ Board not found"); return; }
    const { fen, turnInFen } = state;
    const ourTurn = (turnInFen === "w" && playerColor === "white") ||
                    (turnInFen === "b" && playerColor === "black");

    ping("status", `${ourTurn ? "🎯 Our turn" : "⏳ Opponent"} [${playerColor||"?"}/${turnInFen}]`);
    if (!ourTurn || fen === lastHandledFen) return;
    go(fen);
  }
  setInterval(pollCheck, 500);

  /* ── Engine handler ──────────────────────────────────────────── */
  async function go(fen) {
    if (busy) return;
    busy = true;
    lastHandledFen = fen;
    try {
      ping("status","🔍 Engine…");
      const uci = await getBestMove(fen);
      if (!uci) throw new Error("No move");
      ping("status","♟ " + uci);
      log("Best: " + uci + " | fen: " + fen.slice(0,40));
      const ori = getOrientation();
      drawHighlight(uci, ori);
      if (cfg.mode === "autoplay") {
        await sleep(cfg.delay);
        playMove(uci, ori);
      }
      logMove(uci, fen);
    } catch(e) {
      ping("status","❌ " + e.message);
      log("Error: " + e.message);
      lastHandledFen = null;
    } finally {
      busy = false;
    }
  }

  /* ── Board state (poll path) ─────────────────────────────────── */
  function getBoardState() {
    const boardEl = document.querySelector("cg-board");
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    if (rect.width < 50) return null;
    const ply = getDomPly();
    const turnInFen = (ply % 2 === 0) ? "w" : "b";
    const fen = scrapeFen(turnInFen);
    if (!fen) return null;
    return { fen, turnInFen };
  }

  /* ── Engine calls ────────────────────────────────────────────── */
  async function getBestMove(fen) {
    // Primary: Lichess cloud eval (fast, same-domain, no CORS)
    try {
      const res = await fetch(
        `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`,
        { credentials: "omit" }
      );
      if (res.ok) {
        const data = await res.json();
        const move = data?.pvs?.[0]?.moves?.split(" ")?.[0];
        if (move && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
          log("cloud-eval: " + move); return move;
        }
      }
    } catch(e) { log("cloud-eval err: " + e.message); }

    // Fallback: stockfish.online
    try {
      const res = await fetch(
        `https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${cfg.depth}`,
        { credentials: "omit" }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          const m = (data.bestmove||"").match(/[a-h][1-8][a-h][1-8][qrbn]?/);
          if (m) { log("stockfish: " + m[0]); return m[0]; }
        }
      }
    } catch(e) { log("stockfish err: " + e.message); }

    throw new Error("Engine unavailable");
  }

  /* ── Player color ────────────────────────────────────────────── */
  function getPlayerColor() {
    try {
      const c = window.__epColor;
      if (c === "white" || c === "black") return c;
    } catch(_) {}
    try {
      for (const s of document.querySelectorAll("script:not([src])")) {
        const m = s.textContent.match(/"color"\s*:\s*"(white|black)"/);
        if (m) return m[1];
      }
    } catch(_) {}
    return getOrientation();
  }

  function getOrientation() {
    if (cfg.orientation !== "auto") return cfg.orientation;
    const wrap = document.querySelector("cg-wrap,.cg-wrap");
    return wrap?.classList.contains("orientation-black") ? "black" : "white";
  }

  /* ── DOM ply ─────────────────────────────────────────────────── */
  function getDomPly() {
    let max = 0;
    for (const el of document.querySelectorAll("[data-ply]")) {
      const v = parseInt(el.getAttribute("data-ply"));
      if (!isNaN(v) && v > max) max = v;
    }
    if (max > 0) return max;
    for (const sel of ["l4x m2","rm6 m2",".tview2 move","move","kwdb"]) {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) return n;
    }
    return 0;
  }

  /* ── FEN scraper ─────────────────────────────────────────────── */
  function scrapeFen(turn) {
    const boardEl = document.querySelector("cg-board");
    if (!boardEl) return null;
    const rect = boardEl.getBoundingClientRect();
    if (rect.width < 50) return null;
    const ori = getOrientation();
    const sqW = rect.width/8, sqH = rect.height/8;
    const grid = Array.from({length:8},()=>Array(8).fill(null));
    let placed = 0;
    for (const p of boardEl.querySelectorAll("piece")) {
      const letter = PIECE_FEN[p.className.trim()];
      if (!letter) continue;
      const tf = (p.getAttribute("style")||"").match(/translate\(\s*([\d.]+)px,\s*([\d.]+)px\s*\)/);
      if (!tf) continue;
      let col=Math.floor(parseFloat(tf[1])/sqW), row=Math.floor(parseFloat(tf[2])/sqH);
      col=Math.max(0,Math.min(7,col)); row=Math.max(0,Math.min(7,row));
      let file,rank;
      if(ori==="white"){file=col;rank=7-row;}else{file=7-col;rank=row;}
      grid[7-rank][file]=letter; placed++;
    }
    if (placed < 2) return null;
    let rows="";
    for(let r=0;r<8;r++){
      let e=0;
      for(let f=0;f<8;f++){
        const p=grid[r][f];
        if(p){if(e){rows+=e;e=0;}rows+=p;}else e++;
      }
      if(e)rows+=e; if(r<7)rows+="/";
    }
    const t = turn||(getDomPly()%2===0?"w":"b");
    let cas="";
    if(grid[7][4]==="K"){if(grid[7][7]==="R")cas+="K";if(grid[7][0]==="R")cas+="Q";}
    if(grid[0][4]==="k"){if(grid[0][7]==="r")cas+="k";if(grid[0][0]==="r")cas+="q";}
    return `${rows} ${t} ${cas||"-"} - 0 1`;
  }

  /* ── Highlight overlay ───────────────────────────────────────── */
  let hlOverlay=null, hlTimer=null;

  function clearHighlights(){
    if(hlOverlay) hlOverlay.innerHTML="";
    if(hlTimer){clearTimeout(hlTimer);hlTimer=null;}
  }

  function drawHighlight(uci, ori){
    const boardEl=document.querySelector("cg-board");
    if(!boardEl) return;
    const rect=cfg.cropBox||boardEl.getBoundingClientRect();
    if(!rect||rect.width<50) return;
    if(!hlOverlay||!document.body.contains(hlOverlay)){
      hlOverlay=document.createElement("div");
      hlOverlay.id="ep-hl";
      Object.assign(hlOverlay.style,{position:"fixed",pointerEvents:"none",
        zIndex:"9999",overflow:"hidden"});
      document.body.appendChild(hlOverlay);
    }
    Object.assign(hlOverlay.style,{left:rect.left+"px",top:rect.top+"px",
      width:rect.width+"px",height:rect.height+"px"});
    hlOverlay.innerHTML="";
    const from=uci.slice(0,2),to=uci.slice(2,4);
    const sqW=rect.width/8,sqH=rect.height/8;
    function sqXY(s){
      const f=s.charCodeAt(0)-97,rk=parseInt(s[1])-1;
      let c,r;
      if(ori==="white"){c=f;r=7-rk;}else{c=7-f;r=rk;}
      return{x:c*sqW,y:r*sqH};
    }
    const sp=sqXY(from),dp=sqXY(to);
    const se=document.createElement("div");
    Object.assign(se.style,{position:"absolute",left:sp.x+"px",top:sp.y+"px",
      width:sqW+"px",height:sqH+"px",background:"rgba(255,210,0,0.45)",
      border:"2px solid rgba(255,170,0,0.9)",boxSizing:"border-box"});
    const de=document.createElement("div");
    Object.assign(de.style,{position:"absolute",left:dp.x+"px",top:dp.y+"px",
      width:sqW+"px",height:sqH+"px",background:"rgba(20,200,60,0.4)",
      border:"3px solid rgba(20,200,60,0.95)",boxSizing:"border-box"});
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    Object.assign(svg.style,{position:"absolute",left:0,top:0,
      width:"100%",height:"100%",overflow:"visible",pointerEvents:"none"});
    const x1=sp.x+sqW/2,y1=sp.y+sqH/2,x2=dp.x+sqW/2,y2=dp.y+sqH/2;
    const dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy)||1;
    const ux=dx/len,uy=dy/len,sw=Math.max(3,sqW*0.13);
    const ex=x2-ux*sqW*0.3,ey=y2-uy*sqH*0.3;
    svg.innerHTML=`<defs><marker id="epa" markerWidth="4" markerHeight="4"
      refX="2" refY="2" orient="auto">
      <polygon points="0,0 4,2 0,4" fill="rgba(20,200,60,0.95)"/></marker></defs>
      <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}"
        stroke="rgba(20,200,60,0.85)" stroke-width="${sw}"
        stroke-linecap="round" marker-end="url(#epa)"/>`;
    hlOverlay.appendChild(se);hlOverlay.appendChild(de);hlOverlay.appendChild(svg);
    if(hlTimer) clearTimeout(hlTimer);
    hlTimer=setTimeout(clearHighlights,6000);
  }

  /* ── Move execution ──────────────────────────────────────────── */
  function sqCenter(sq,ori){
    const b=document.querySelector("cg-board");
    const r=cfg.cropBox||b.getBoundingClientRect();
    const sqW=r.width/8,sqH=r.height/8;
    const f=sq.charCodeAt(0)-97,rk=parseInt(sq[1])-1;
    let c,row;
    if(ori==="white"){c=f;row=7-rk;}else{c=7-f;row=rk;}
    return{x:r.left+c*sqW+sqW/2,y:r.top+row*sqH+sqH/2};
  }

  function ptr(type,x,y,btn){
    return new PointerEvent(type,{bubbles:true,cancelable:true,
      clientX:x,clientY:y,screenX:x,screenY:y,
      pointerId:1,pointerType:"mouse",isPrimary:true,
      button:btn>0?0:-1,buttons:btn,pressure:btn>0?0.5:0});
  }

  function playMove(uci,ori){
    const from=uci.slice(0,2),to=uci.slice(2,4),promo=uci[4]||null;
    const src=sqCenter(from,ori),dst=sqCenter(to,ori);
    const board=document.querySelector("cg-board");
    const sEl=document.elementFromPoint(src.x,src.y)||board;
    const dEl=document.elementFromPoint(dst.x,dst.y)||board;
    sEl.dispatchEvent(ptr("pointerover",src.x,src.y,0));
    sEl.dispatchEvent(ptr("pointerdown",src.x,src.y,1));
    board.dispatchEvent(ptr("pointermove",(src.x+dst.x)/2,(src.y+dst.y)/2,1));
    board.dispatchEvent(ptr("pointermove",dst.x,dst.y,1));
    dEl.dispatchEvent(ptr("pointerup",dst.x,dst.y,0));
    setTimeout(()=>{
      const s2=document.elementFromPoint(src.x,src.y)||board;
      s2.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,clientX:src.x,clientY:src.y,button:0,buttons:1}));
      s2.dispatchEvent(new MouseEvent("mouseup",  {bubbles:true,cancelable:true,clientX:src.x,clientY:src.y,button:0,buttons:0}));
      s2.dispatchEvent(new MouseEvent("click",    {bubbles:true,cancelable:true,clientX:src.x,clientY:src.y,button:0,buttons:0}));
      setTimeout(()=>{
        const d2=document.elementFromPoint(dst.x,dst.y)||board;
        d2.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,clientX:dst.x,clientY:dst.y,button:0,buttons:1}));
        d2.dispatchEvent(new MouseEvent("mouseup",  {bubbles:true,cancelable:true,clientX:dst.x,clientY:dst.y,button:0,buttons:0}));
        d2.dispatchEvent(new MouseEvent("click",    {bubbles:true,cancelable:true,clientX:dst.x,clientY:dst.y,button:0,buttons:0}));
        if(promo) setTimeout(()=>handlePromotion(promo),200);
      },80);
    },100);
  }

  function handlePromotion(p){
    for(const s of[`.promotion-choice [data-symbol="${p.toUpperCase()}"]`,
      `.promotion-choice .${p}`,`.cg-promotion .${p}`]){
      const el=document.querySelector(s);if(el){el.click();return;}
    }
    const fb=document.querySelector(".promotion-choice piece,.cg-promotion piece");
    if(fb)fb.click();
  }

  /* ── Crop overlay ────────────────────────────────────────────── */
  function launchCropOverlay(){
    if(document.getElementById("ep-crop")) return;
    const ov=Object.assign(document.createElement("div"),{id:"ep-crop"});
    Object.assign(ov.style,{position:"fixed",inset:"0",zIndex:"2147483647",
      cursor:"crosshair",background:"rgba(0,0,0,.45)"});
    const hint=Object.assign(document.createElement("div"),
      {textContent:"✏️  Drag around the chess board"});
    Object.assign(hint.style,{position:"absolute",top:"16px",left:"50%",
      transform:"translateX(-50%)",background:"#111",color:"#3ecf74",
      padding:"8px 18px",borderRadius:"8px",fontFamily:"system-ui,sans-serif",
      fontSize:"14px",pointerEvents:"none",whiteSpace:"nowrap"});
    const box=document.createElement("div");
    Object.assign(box.style,{position:"fixed",border:"2px solid #3ecf74",
      background:"rgba(62,207,116,.1)",pointerEvents:"none",display:"none",
      boxSizing:"border-box"});
    ov.appendChild(hint);ov.appendChild(box);document.body.appendChild(ov);
    let sx=0,sy=0,drag=false;
    const xy=e=>e.touches?{x:e.touches[0].clientX,y:e.touches[0].clientY}:{x:e.clientX,y:e.clientY};
    const down=e=>{e.preventDefault();const p=xy(e);sx=p.x;sy=p.y;drag=true;Object.assign(box.style,{display:"block",left:sx+"px",top:sy+"px",width:"0",height:"0"});};
    const move=e=>{if(!drag)return;e.preventDefault();const p=xy(e);Object.assign(box.style,{left:Math.min(p.x,sx)+"px",top:Math.min(p.y,sy)+"px",width:Math.abs(p.x-sx)+"px",height:Math.abs(p.y-sy)+"px"});};
    const up=e=>{if(!drag)return;drag=false;const r=box.getBoundingClientRect();
      if(r.width<40||r.height<40){ov.remove();ping("cropResult","too_small");return;}
      cfg.cropBox={left:r.left,top:r.top,width:r.width,height:r.height};
      chrome.storage.local.set({cropBox:cfg.cropBox,cropDraw:false});
      ping("cropResult","ok");ov.remove();};
    ov.addEventListener("mousedown",down,{passive:false});
    ov.addEventListener("touchstart",down,{passive:false});
    ov.addEventListener("mousemove",move,{passive:false});
    ov.addEventListener("touchmove",move,{passive:false});
    ov.addEventListener("mouseup",up);
    ov.addEventListener("touchend",up);
  }

  /* ── Utils ───────────────────────────────────────────────────── */
  function logMove(uci,fen){
    const now=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    const t=typeof fen==="string"?(fen.split(" ")[1]==="w"?"White":"Black"):"?";
    chrome.storage.local.get(["moveLog"],r=>{
      const arr=(r.moveLog||[]).slice(-49);
      arr.push(`${now}  ${uci}  (${t})`);
      chrome.storage.local.set({moveLog:arr});
    });
  }
  function ping(k,v){chrome.storage.local.set({[k]:v});}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  function log(msg){console.log("[EnginePilot] "+msg);}

})();
