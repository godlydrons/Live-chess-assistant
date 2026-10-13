/* popup.js — handles toggle, settings persistence, and live move log */

const toggle    = document.getElementById("toggleSwitch");
const dot       = document.getElementById("statusDot");
const statusTxt = document.getElementById("statusText");
const logEl     = document.getElementById("logEntries");

const depthVal  = document.getElementById("depthVal");
const delayVal  = document.getElementById("delayVal");

/* ── Load stored state ─────────────────────────────────────────── */
chrome.storage.local.get(["active", "depth", "delay", "moveLog"], (res) => {
  const isActive = !!res.active;
  const depth    = res.depth  ?? 12;
  const delay    = res.delay  ?? 180;
  const moves    = res.moveLog ?? [];

  toggle.checked  = isActive;
  depthVal.textContent = depth;
  delayVal.textContent = delay;
  setStatus(isActive);
  renderLog(moves);
});

/* ── Toggle ────────────────────────────────────────────────────── */
toggle.addEventListener("change", () => {
  const isActive = toggle.checked;
  chrome.storage.local.set({ active: isActive });
  setStatus(isActive);
  if (!isActive) chrome.storage.local.set({ moveLog: [] });
});

function setStatus(on) {
  dot.classList.toggle("on", on);
  statusTxt.classList.toggle("on", on);
  statusTxt.textContent = on
    ? "Active — watching for your turn…"
    : "Inactive — open a Lichess game";
}

/* ── Depth control (1–16) ──────────────────────────────────────── */
document.getElementById("depthDown").addEventListener("click", () => adjust("depth", -1,  1, 16, depthVal));
document.getElementById("depthUp"  ).addEventListener("click", () => adjust("depth", +1,  1, 16, depthVal));

/* ── Delay control (0–2000ms, step 50) ────────────────────────── */
document.getElementById("delayDown").addEventListener("click", () => adjust("delay", -50,  0, 2000, delayVal));
document.getElementById("delayUp"  ).addEventListener("click", () => adjust("delay", +50,  0, 2000, delayVal));

function adjust(key, delta, min, max, el) {
  const cur = parseInt(el.textContent) || 0;
  const next = Math.min(max, Math.max(min, cur + delta));
  el.textContent = next;
  chrome.storage.local.set({ [key]: next });
  // Notify content script of new settings
  chrome.storage.local.set({ settingsUpdated: Date.now() });
}

/* ── Live move log (poll storage every 800 ms while popup open) ── */
setInterval(() => {
  chrome.storage.local.get(["moveLog", "active"], (res) => {
    renderLog(res.moveLog ?? []);
    if (toggle.checked !== !!res.active) {
      toggle.checked = !!res.active;
      setStatus(!!res.active);
    }
  });
}, 800);

function renderLog(moves) {
  if (!moves.length) {
    logEl.innerHTML = '<div class="log-entry" style="color:#333">— no moves yet —</div>';
    return;
  }
  logEl.innerHTML = moves
    .slice(-6)
    .reverse()
    .map((m, i) => `<div class="log-entry${i === 0 ? " new" : ""}">${m}</div>`)
    .join("");
}
