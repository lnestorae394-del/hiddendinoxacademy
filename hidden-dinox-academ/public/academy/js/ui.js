/* HIDDEN DINOX ACADEMY — общие утилиты интерфейса (обычный скрипт, без модулей:
   все функции доступны страницам как глобальные). */
const $ = id => document.getElementById(id);
const ls = { get(k){try{return localStorage.getItem(k)}catch(e){return null}}, set(k,v){try{localStorage.setItem(k,v)}catch(e){}} };
// localStorage хранит только язык интерфейса — не статусы и не доступ
let lang = T[ls.get("hd_lang")] ? ls.get("hd_lang") : "ru";
const t = (k, v) => { let s = T[lang][k] ?? T.ru[k]; if (s == null) { if (window.console) console.warn("i18n: нет строки", k); s = ""; }   // ключ пользователю не показываем   // нет перевода — русский по умолчанию, не ключ
  if (v) for (const [a, b] of Object.entries(v)) s = s.replace("{" + a + "}", b); return s; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
let toastTimer; function toast(m){ const el=$("toast"); if(!el)return; el.textContent=m; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),3400); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const errMsg = e => (T[lang] && T[lang][e && e.code]) || t("GENERIC");

const ICON = {
 eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
 out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg>',
 ext:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>',
 q:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/></svg>',
 refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>'
};
const field=(id,label,type,extra="")=>`<div class="field" id="f_${id}"><label for="${id}">${label}</label><div class="control ${type==="password"?"has-toggle":""} ${extra}">
  <input id="${id}" type="${type==="password"?"password":"text"}" ${type==="email"?'inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="name@mail.com"':""}${type==="password"?' placeholder="••••••••"':""}>
  ${type==="password"?`<button type="button" class="eye" data-eye="${id}" aria-label="${t("pass")}">${ICON.eye}</button>`:""}</div><div class="err" id="e_${id}" role="alert"></div></div>`;
const btn=(id,label,cls="btn-primary",type="submit",icon="")=>`<button type="${type}" class="btn ${cls}" id="${id}"><span class="label">${label}</span>${icon}<span class="spin" aria-hidden="true"></span></button>`;
const progress=step=>`<div class="progress">${["p1","p2","p3"].map((k,i)=>`<div class="${i<step?"done":i===step?"now":""}">${t(k)}</div>`).join("")}</div>`;
const notice=()=>`<div class="notice" id="notice" role="status" aria-live="polite"><span id="noticeText"></span></div>`;
function setErr(id,msg,shake){const f=$("f_"+id);if(!f)return;f.classList.toggle("invalid",!!msg);$("e_"+id).textContent=msg||"";$(id).setAttribute("aria-invalid",!!msg);if(msg&&shake){f.classList.remove("shake");void f.offsetWidth;f.classList.add("shake")}}
function showNotice(msg,ok){const n=$("notice");if(!n)return;$("noticeText").textContent=msg;n.classList.toggle("ok",!!ok);n.classList.add("show")}
function busy(b,on){if(!b)return;b.disabled=on;b.classList.toggle("loading",on)}
function bindCommon(root=document){
  root.querySelectorAll("[data-modal]").forEach(b=>b.onclick=()=>openModal(b.dataset.modal));
  root.querySelectorAll("[data-eye]").forEach(b=>b.onclick=()=>{const i=$(b.dataset.eye);i.type=i.type==="password"?"text":"password"});
  root.querySelectorAll(".field input").forEach(i=>i.addEventListener("input",()=>setErr(i.id,"")));
}

/* Язык */
let onLangChange = () => {};
function placePill(){const pill=document.querySelector(".langs .pill");const b=[...document.querySelectorAll(".langs button")].find(x=>x.dataset.lang===lang);if(pill&&b){pill.style.width=b.offsetWidth+"px";pill.style.transform=`translateX(${b.offsetLeft-3}px)`}}
function applyStatic(){document.documentElement.lang=lang==="ua"?"uk":lang;
  document.querySelectorAll("[data-t]").forEach(el=>el.textContent=t(el.dataset.t));
  document.querySelectorAll("[data-ta]").forEach(el=>el.setAttribute("aria-label",t(el.dataset.ta)));
  document.querySelectorAll(".langs button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.lang===lang));placePill()}
function initLang(cb){onLangChange=cb||onLangChange;
  document.querySelectorAll(".langs button").forEach(b=>b.onclick=()=>{lang=b.dataset.lang;ls.set("hd_lang",lang);applyStatic();onLangChange();
    try{call("POST","/api/lang",{lang}).catch(()=>{})}catch(e){}});   // сохранить выбор в профиле (не блокирует)
  addEventListener("resize",placePill);if(document.fonts)document.fonts.ready.then(placePill);applyStatic()}

/* Модальные окна */
let lastFocus=null;
function openModal(id){const m=$(id);if(!m)return;lastFocus=document.activeElement;m.classList.add("open");document.body.style.overflow="hidden";setTimeout(()=>{const c=m.querySelector(".close");c&&c.focus()},50)}
function closeModal(m){m.classList.remove("open");if(!document.querySelector(".modal.open"))document.body.style.overflow="";lastFocus&&lastFocus.focus&&lastFocus.focus()}
function initModals(){document.querySelectorAll(".modal").forEach(m=>m.querySelectorAll("[data-close]").forEach(x=>x.addEventListener("click",()=>closeModal(m))));
  document.addEventListener("keydown",e=>{if(e.key==="Escape"){const m=[...document.querySelectorAll(".modal.open")].pop();if(m)closeModal(m)}})}

/* Фоновые частицы: лёгкие, пауза в фоне, отключены при reduced motion */
function initParticles(density=20000,max=32){const c=$("particles");if(!c||matchMedia("(prefers-reduced-motion: reduce)").matches)return;const ctx=c.getContext("2d");let W,H,P=[],raf;
  function size(){const d=Math.min(devicePixelRatio||1,2);W=innerWidth;H=innerHeight;c.width=W*d;c.height=H*d;ctx.setTransform(d,0,0,d,0,0)}
  function mk(y){return{x:Math.random()*W,y:y??Math.random()*H,r:Math.random()*1.5+.4,s:Math.random()*.22+.06,d:(Math.random()-.5)*.14,a:Math.random()*.45+.12,p:Math.random()*6.28}}
  function init(){size();P=Array.from({length:Math.round(Math.min(max,W*H/density))},()=>mk())}
  function tick(){ctx.clearRect(0,0,W,H);for(const q of P){q.y-=q.s;q.x+=q.d;q.p+=.02;if(q.y<-6)Object.assign(q,mk(H+6));ctx.beginPath();ctx.arc(q.x,q.y,q.r,0,6.283);ctx.fillStyle=`rgba(150,240,60,${q.a*(.6+.4*Math.sin(q.p))})`;ctx.shadowColor="rgba(139,234,36,.9)";ctx.shadowBlur=6;ctx.fill()}raf=requestAnimationFrame(tick)}
  init();tick();addEventListener("resize",init);document.addEventListener("visibilitychange",()=>{cancelAnimationFrame(raf);if(!document.hidden)tick()})}

/* Telegram Web App */
function initTelegram(){if(window.Telegram&&Telegram.WebApp){try{Telegram.WebApp.ready();Telegram.WebApp.expand()}catch(e){}}}
function openExternal(url){const tg=window.Telegram&&Telegram.WebApp;if(tg&&tg.openLink)tg.openLink(url);else window.open(url,"_blank","noopener")}

/* Маршрутизация по серверному статусу.
   Это удобство для пользователя, а не защита: доступ к данным проверяет сервер. */
/* Код приглашения из ссылки ?ref=XXXXXXXX: сохраняется до регистрации, после входа один раз отправляется серверу.
   Сервер сам решает, можно ли привязать (новый аккаунт, не сам себя, один раз). */
(function(){try{const q=new URLSearchParams(location.search),r=q.get("ref"),v=q.get("via");if(r&&/^[A-Za-z2-9]{8}$/.test(r))localStorage.setItem("hd_ref",r.toUpperCase());
  if(v&&/^[a-z0-9][a-z0-9_-]{2,31}$/i.test(v)&&!localStorage.getItem("hd_via"))localStorage.setItem("hd_via",v.toLowerCase())}catch(e){}})();   // via: первый источник, не перезаписывается
/* Партнёрский источник (?via=код): закрепляется на сервере один раз (сервер проверяет код, новизну аккаунта и отсутствие Trader ID) */
async function attachVia(){let v=null;try{v=localStorage.getItem("hd_via")}catch(e){}if(!v)return;
  try{await call("POST","/api/via/attach",{code:v})}catch(e){if(e&&(e.code==="UNAUTHENTICATED"||e.code==="NETWORK"||e.code==="UNAVAILABLE"))return}
  try{localStorage.removeItem("hd_via")}catch(e){}}
async function attachReferral(){let r=null;try{r=localStorage.getItem("hd_ref")}catch(e){}if(!r)return;
  try{await call("POST","/api/referral/attach",{code:r})}catch(e){if(e&&(e.code==="UNAUTHENTICATED"||e.code==="NETWORK"||e.code==="UNAVAILABLE"))return}
  try{localStorage.removeItem("hd_ref")}catch(e){}}
async function guard(expected,also=[]){
  let p;
  try{p=await api.getProfile()}
  catch(e){ if((e&&e.code)==="UNAUTHENTICATED"){location.replace(PAGES.login);return null} throw e }
  attachReferral();                                   // не блокирует страницу
  if(p&&p.lang&&!ls.get("hd_lang")&&T[p.lang]&&p.lang!==lang){ls.set("hd_lang",p.lang);location.reload();return null}   // язык из профиля на новом устройстве
  window.__hdVia=attachVia();
  const s=stageOf(p); if(s!==expected&&!also.includes(s)){location.replace(PAGES[s]);return null}
  return p;
}
function signOutAndLeave(){api.signOut().finally(()=>location.replace(PAGES.login))}
