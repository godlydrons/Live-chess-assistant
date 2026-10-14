/* popup.js v6 */
const toggle   = document.getElementById("toggle");
const statusB  = document.getElementById("statusBar");
const depthV   = document.getElementById("depthV");
const delayV   = document.getElementById("delayV");
const oriSel   = document.getElementById("oriSel");
const cropBtn  = document.getElementById("cropBtn");
const cropClr  = document.getElementById("cropClear");
const logEl    = document.getElementById("logEl");
const modeAuto = document.getElementById("modeAutoplay");
const modeHl   = document.getElementById("modeHighlight");

chrome.storage.local.get(
  ["active","depth","delay","orientation","cropBox","moveLog","status","mode"],
  (r) => {
    toggle.checked       = !!r.active;
    depthV.textContent   = r.depth ?? 8;
    delayV.textContent   = r.delay       ?? 100;
    oriSel.value         = r.orientation ?? "auto";
    setMode(r.mode       ?? "autoplay");
    renderLog(r.moveLog  ?? []);
    setStatus(r.status   ?? (r.active ? "🟢 Watching…" : "⚫ Inactive"), !!r.active);
    setCropUI(!!r.cropBox);
  }
);

toggle.addEventListener("change", () => {
  const on = toggle.checked;
  chrome.storage.local.set({ active: on });
  if (!on) { chrome.storage.local.set({ moveLog:[], status:"⚫ Inactive" }); setStatus("⚫ Inactive",false); }
});

document.getElementById("dD").onclick = () => adj("depth", -1,  1, 16, depthV);
document.getElementById("dU").onclick = () => adj("depth", +1,  1, 16, depthV);
document.getElementById("lD").onclick = () => adj("delay",-50,  0,2000,delayV);
document.getElementById("lU").onclick = () => adj("delay",+50,  0,2000,delayV);
function adj(key,delta,min,max,el){
  const next=Math.min(max,Math.max(min,parseInt(el.textContent)+delta));
  el.textContent=next; chrome.storage.local.set({[key]:next});
}

oriSel.addEventListener("change", () => chrome.storage.local.set({ orientation: oriSel.value }));

modeAuto.addEventListener("click", () => { setMode("autoplay");   chrome.storage.local.set({mode:"autoplay"}); });
modeHl.addEventListener(  "click", () => { setMode("highlight");  chrome.storage.local.set({mode:"highlight"}); });
function setMode(m){
  modeAuto.classList.toggle("active", m==="autoplay");
  modeHl.classList.toggle(  "active", m==="highlight");
}

cropBtn.addEventListener("click", () => {
  chrome.storage.local.set({ cropDraw: true, cropResult: null });
  window.close();
});
cropClr.addEventListener("click", () => {
  chrome.storage.local.set({ cropBox: null });
  setCropUI(false);
});
function setCropUI(has){
  cropBtn.textContent = has ? "✅  Crop box active" : "✏️  Draw board crop box";
  cropBtn.classList.toggle("set", has);
  cropClr.style.display = has ? "block" : "none";
}

setInterval(() => {
  chrome.storage.local.get(["active","status","moveLog","cropBox","cropResult","mode"], (r) => {
    if (toggle.checked !== !!r.active) toggle.checked = !!r.active;
    if (r.status) setStatus(r.status, !!r.active);
    renderLog(r.moveLog ?? []);
    setCropUI(!!r.cropBox);
    setMode(r.mode ?? "autoplay");
    if (r.cropResult === "too_small") {
      chrome.storage.local.set({cropResult:null});
      setStatus("⚠️ Box too small — try again", false);
    }
  });
}, 700);

function setStatus(msg, active) {
  statusB.textContent = msg;
  statusB.className = "status-bar";
  if (msg.startsWith("❌")||msg.startsWith("⚠️")) statusB.classList.add("warn");
  else if (active) statusB.classList.add("live");
}

function renderLog(moves) {
  if (!moves.length) {
    logEl.innerHTML = '<div class="log-entry" style="color:#2a2a2a">— no moves yet —</div>';
    return;
  }
  logEl.innerHTML = moves.slice(-6).reverse()
    .map((m,i) => `<div class="log-entry${i===0?" fresh":""}">${m}</div>`).join("");
}
