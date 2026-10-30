const tog       = document.getElementById("tog");
const bulletTog = document.getElementById("bulletTog");
const racerTog  = document.getElementById("racerTog");
const sb        = document.getElementById("sb");
const dV        = document.getElementById("dV");
const lV        = document.getElementById("lV");
const ori       = document.getElementById("ori");
const log       = document.getElementById("log");
const mA        = document.getElementById("mAuto");
const mH        = document.getElementById("mHL");
const cBtn      = document.getElementById("cropBtn");
const cClr      = document.getElementById("cropClr");

chrome.storage.local.get(
  ["active","bulletMode","racerMode","depth","delay","orientation","cropBox","moveLog","status","mode"],
  (r) => {
    tog.checked       = !!r.active;
    bulletTog.checked = !!r.bulletMode;
    racerTog.checked  = !!r.racerMode;
    dV.textContent    = r.depth ?? 7;
    lV.textContent    = r.delay ?? 15;
    ori.value         = r.orientation ?? "auto";
    setMode(r.mode ?? "autoplay");
    renderLog(r.moveLog ?? []);
    setSt(r.status ?? (r.active ? "🟢 Watching…" : "⚫ Inactive"), !!r.active);
    setCrop(!!r.cropBox);
  }
);

tog.addEventListener("change", () => {
  const on = tog.checked;
  chrome.storage.local.set({ active: on });
  if (!on) chrome.storage.local.set({ moveLog:[], status:"⚫ Inactive" });
  sendMsg({ action:"toggleActive", value:on });
  setSt(on ? "🟢 Watching…" : "⚫ Inactive", on);
});

bulletTog.addEventListener("change", () => {
  chrome.storage.local.set({ bulletMode: bulletTog.checked });
  sendMsg({ action:"setBulletMode", value: bulletTog.checked });
});

racerTog.addEventListener("change", () => {
  chrome.storage.local.set({ racerMode: racerTog.checked });
  sendMsg({ action:"setRacerMode", value: racerTog.checked });
});

mA.addEventListener("click", () => { setMode("autoplay");  chrome.storage.local.set({mode:"autoplay"});  sendMsg({action:"setMode",value:"autoplay"}); });
mH.addEventListener("click", () => { setMode("highlight"); chrome.storage.local.set({mode:"highlight"}); sendMsg({action:"setMode",value:"highlight"}); });
function setMode(m) { mA.classList.toggle("on",m==="autoplay"); mH.classList.toggle("on",m==="highlight"); }

document.getElementById("dD").onclick = () => adj("depth",-1,1,16,dV);
document.getElementById("dU").onclick = () => adj("depth",+1,1,16,dV);
document.getElementById("lD").onclick = () => adj("delay",-5,0,2000,lV);
document.getElementById("lU").onclick = () => adj("delay",+5,0,2000,lV);
function adj(k,d,mn,mx,el){
  const v=Math.min(mx,parseInt(el.textContent)+d < mn ? mn : parseInt(el.textContent)+d);
  el.textContent=v; chrome.storage.local.set({[k]:v});
  if (k === "depth") sendMsg({action:"setDepth",value:v});
}

ori.addEventListener("change",()=>chrome.storage.local.set({orientation:ori.value}));

cBtn.addEventListener("click",()=>{ chrome.storage.local.set({cropDraw:true,cropResult:null}); window.close(); });
cClr.addEventListener("click",()=>{ chrome.storage.local.set({cropBox:null}); setCrop(false); });
function setCrop(h){ cBtn.textContent=h?"✅ Crop active":"✏️ Draw crop box"; cBtn.classList.toggle("set",h); cClr.style.display=h?"block":"none"; }

function sendMsg(msg){
  chrome.tabs.query({active:true,currentWindow:true},tabs=>{
    if(tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id,msg).catch(()=>{});
  });
}

setInterval(()=>{
  chrome.storage.local.get(["active","status","moveLog","cropBox"],r=>{
    if(tog.checked!==!!r.active) tog.checked=!!r.active;
    if(r.status) setSt(r.status,!!r.active);
    renderLog(r.moveLog??[]);
    setCrop(!!r.cropBox);
  });
},500);

function setSt(msg,on){
  sb.textContent=msg; sb.className="status-bar";
  if(msg.startsWith("❌")||msg.startsWith("⚠️")) sb.classList.add("warn");
  else if(on) sb.classList.add("live");
}
function renderLog(moves){
  if(!moves.length){log.innerHTML='<div class="log-e" style="color:#222">— no moves yet —</div>';return;}
  log.innerHTML=moves.slice(-6).reverse().map((m,i)=>`<div class="log-e${i===0?" new":""}">${m}</div>`).join("");
}
