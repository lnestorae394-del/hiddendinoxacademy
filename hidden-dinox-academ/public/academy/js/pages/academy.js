/* Страница 4 — главная академии (academy.html).
   «Активирован» показывается только из ответа сервера (academyAccess === true). */
let state="loading",profile=null;
function renderStatus(){const b=$("statusBody");
  if(state==="loading"){b.innerHTML=`<div class="rows">${[1,2,3].map(()=>`<div class="row"><span class="skel" style="width:46%"></span><span class="skel" style="width:24%"></span></div>`).join("")}</div>`;return}
  if(state==="error"){b.innerHTML=`<div class="errbox" role="alert">${t("loadErr")}<button type="button" class="btn btn-outline" id="retry"><span class="label">${t("retry")}</span></button></div>`;$("retry").onclick=load;return}
  const p=profile;
  b.innerHTML=`<div class="rows">
    <div class="row ${p.academyAccess===true?"key":""}"><span>${t("rAccess")}</span>${p.academyAccess===true?`<span class="dot ok">${t("rAccessOk")}</span>`:`<span class="dot mute">—</span>`}</div>
    <div class="row"><span>${t("rBroker")}<small>Trader ID ${esc(p.traderIdMasked||"")}</small></span>${p.brokerRegistrationConfirmed===true?`<span class="dot ok">${t("rBrokerOk")}</span>`:`<span class="dot mute">—</span>`}</div>
    <div class="row"><span>${t("rDep")}${p.firstDeposit?`<small>${money(p.firstDeposit.amount)}</small>`:""}</span>${p.firstDeposit?`<span class="dot ok">${t("rDepOk")}</span>`:`<span class="dot mute">—</span>`}</div></div>
    <div class="src">${t("src",{t:t("justNow")})}</div>`}
function renderProfile(){const email=(profile&&profile.email)||"";const ini=(email[0]||"·").toUpperCase();
  ["avH","avP"].forEach(id=>$(id).textContent=ini);["emH","emP","menuEmail"].forEach(id=>$(id).textContent=email);$("profBtn").setAttribute("aria-label",t("profile"))}
function render(){renderProfile();renderStatus();if(typeof renderLearning==="function")renderLearning();if(typeof renderBanners==="function"&&bannerData)renderBanners()}
async function load(){state="loading";renderStatus();
  // Курсы и афиши запрашиваются сразу, параллельно с профилем: сервер сам проверяет доступ (403 без него).
  const learning=loadLearning();
  try{const p=await guard("academy");if(!p)return;profile=p;state="ok"}catch(e){state="error"}
  render();await learning}
/* Опубликованные курсы, прогресс и афиши — только данные сервера */
const escH=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let learnData=null,annData=null,learnState="loading",bannerData=null;
/* Курсы переводит сервер, поэтому при смене языка нужны данные на новом языке: из кэша (мгновенно) или один запрос.
   Раньше страница перерисовывала данные, загруженные на прежнем языке, — название и описание курса не менялись. */
const learnCache={};let langReq=0;
async function refreshLang(){
  if(!learnData||learnState==="no_access")return;
  if(learnCache[lang]){learnData=learnCache[lang];renderLearning();return}
  const my=++langReq,l=lang;
  try{const r=await call("GET","/api/learn/courses?lang="+l);learnCache[l]=r.courses||[];if(my===langReq&&l===lang){learnData=learnCache[l];renderLearning()}}catch(e){}
}
/* Баннеры главной: один компонент для всех. Ссылку присылает сервер (по типу действия); здесь — только вывод. */
const tr=(o,fb)=>(o&&(o[lang]||o.ru||o.en||o.ua))||fb||"";
const ARROW='<span class="hb-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
function renderBanners(){
  const sec=$("bannerSec"),row=$("bannerRow");if(!bannerData||!bannerData.length){sec.hidden=true;return}
  sec.hidden=false;
  row.innerHTML=bannerData.map(b=>{const title=tr(b.title_i18n,b.title),cta=tr(b.cta_i18n,b.cta_label)||t("bannerOpen"),cat=tr(b.category_i18n,"");
    const soonTxt=b.release_at?t("bannerSoonDate",{date:new Date(b.release_at).toLocaleDateString(lang==="en"?"en-GB":lang==="ua"?"uk-UA":"ru-RU",{day:"numeric",month:"long"})}):t("bannerSoon");
    const inner=`${b.image_url?`<img class="hb-img" src="${escH(b.image_url)}" alt="" loading="lazy" onerror="this.remove()">`:""}<span class="hb-shade" aria-hidden="true"></span><span class="hb-body">${cat?`<span class="hb-cat">${escH(cat)}</span>`:""}<span class="hb-title">${escH(title)}</span><span class="hb-cta${b.soon?" soon":""}">${escH(b.soon?soonTxt:cta)}${b.soon?"":ARROW}</span></span>`;
    return b.soon||!b.href?`<div class="hd-banner is-soon" data-id="${escH(b.id)}" aria-disabled="true">${inner}</div>`
      :`<a class="hd-banner" data-id="${escH(b.id)}" href="${escH(b.href)}"${b.external?' target="_blank" rel="noopener noreferrer"':""}>${inner}</a>`}).join("");
  const upd=()=>{const over=row.scrollWidth>row.clientWidth+4;$("bPrev").hidden=!over||row.scrollLeft<8;$("bNext").hidden=!over||row.scrollLeft+row.clientWidth>=row.scrollWidth-8};
  row.onscroll=upd;window.addEventListener("resize",upd);upd();
  $("bPrev").onclick=()=>row.scrollBy({left:-row.clientWidth*0.9,behavior:"smooth"});$("bNext").onclick=()=>row.scrollBy({left:row.clientWidth*0.9,behavior:"smooth"});
}
const skel='<div class="course-card skel" aria-hidden="true"><div><span class="sk sk-t"></span><span class="sk sk-p"></span><span class="sk sk-b"></span></div></div>';
// Исходное содержимое блока прогресса — чтобы вернуть его, если курсов нет или загрузка не удалась (не оставлять заглушку навсегда)
const progEl=document.querySelector(".p-progress .prog-empty"),progHTML=progEl?progEl.innerHTML:"";
function restoreProgress(){const pl=$("progList"),kv=document.querySelector(".p-progress .kv");if(pl){pl.hidden=true;pl.innerHTML=""}if(kv)kv.hidden=false;const pe=document.querySelector(".p-progress .prog-empty");if(pe)pe.hidden=false;if(pe&&pe.dataset.skel){delete pe.dataset.skel;pe.innerHTML=progHTML;pe.querySelectorAll("[data-t]").forEach(e=>e.textContent=t(e.dataset.t))}}
function renderProgressList(courses){
  const pe=document.querySelector(".p-progress .prog-empty"),kv=document.querySelector(".p-progress .kv"),pl=$("progList");
  if(!pl)return;
  if(pe){delete pe.dataset.skel;pe.hidden=true}if(kv)kv.hidden=true;pl.hidden=false;
  pl.innerHTML=courses.map(c=>{
    const st=c.course_completed?"done":c.completed>0?"prog":"new";
    const next=c.course_completed?`<a class="prog-link" href="learn.html#/done/${encodeURIComponent(c.id)}">${t("courseDoneLink")}</a>`
      :c.next?`<a class="prog-link" href="learn.html#/lesson/${encodeURIComponent(c.next.lesson_id)}">${escH(c.next.title)}</a>`:"—";
    return `<article class="prog-course" data-course="${escH(c.id)}"><div class="ring" aria-hidden="true" style="--p:${c.percent}">${c.percent}%</div>
      <div class="pc-main"><p class="pc-title">${escH(c.title)} <span class="pc-st pc-${st}">${t(st==="done"?"progStDone":st==="prog"?"progStProg":"progStNew")}</span></p>
      <div class="cbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent}" aria-label="${escH(c.title)}"><i style="width:${c.percent}%"></i></div>
      <small>${t("progLessonsLine",{d:c.completed,t:c.lessons})}${c.modules_total?` · ${t("progM")}: ${c.modules_completed} / ${c.modules_total}`:""}</small>
      <small class="pc-next">${t("progN")}: ${next}</small></div></article>`}).join("");
}
function renderLearning(){
  const panel=$("learnPanel"),list=$("learnList");
  if(learnState==="no_access"){panel.hidden=true;restoreProgress();return}
  panel.hidden=false;
  if(learnData&&learnData.length){   // уже полученные данные не стираются при повторной загрузке или ошибке
    list.removeAttribute("aria-busy");
    list.innerHTML=learnData.map(c=>`<a class="course-card" href="learn.html#/course/${encodeURIComponent(c.id)}">${c.cover_url?`<img src="${escH(c.cover_url)}" alt="" loading="lazy">`:""}<div><h3>${escH(c.title)}</h3>${c.description?`<p>${escH(c.description.slice(0,160))}${c.description.length>160?"…":""}</p>`:""}
      <div class="cbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent}"><i style="width:${c.percent}%"></i></div><small>${c.completed}/${c.lessons} ${t("learnLessons")} · ${c.percent}% ${t("learnDone")}</small></div><span class="go">${t(c.completed?"learnCont":"learnOpen")}</span></a>`).join("");
    // Прогресс — по КАЖДОМУ опубликованному курсу, доступному ученику (список приходит с сервера; названия и ID не зашиты).
    // Данные — сводка сервера по сохранённому прогрессу: уроки, модули, следующий шаг, завершение.
    renderProgressList(learnData);
  } else if(learnState==="loading"){
    list.setAttribute("aria-busy","true");list.innerHTML=skel;
    const pe=document.querySelector(".p-progress .prog-empty");
    if(pe&&!pe.dataset.skel&&!($("progList")&&!$("progList").hidden)){pe.dataset.skel="1";pe.innerHTML='<span class="sk sk-ring" aria-hidden="true"></span><div style="flex:1"><span class="sk sk-t"></span><span class="sk sk-p"></span></div>'}
  } else if(learnState==="empty"){list.removeAttribute("aria-busy");list.innerHTML=`<p class="learn-msg">${t("learnEmpty")}</p>`;restoreProgress()}
  else if(learnState==="error"){list.removeAttribute("aria-busy");restoreProgress();list.innerHTML=`<p class="learn-msg">${t("learnErr")}</p><button type="button" class="learn-retry" id="learnRetry">${t("retry")}</button>`;$("learnRetry").onclick=()=>{learnState="loading";renderLearning();loadLearning()}}
  if(annData&&annData.length){$("annPanel").hidden=false;
    $("annList").innerHTML=annData.map(a=>`<article class="ann">${a.image_url?`<img src="${escH(a.image_url)}" alt="" loading="lazy">`:""}<div>${a.event_at?`<time>${escH(new Date(a.event_at).toLocaleString(lang==="en"?"en-GB":lang==="ua"?"uk-UA":"ru-RU",{day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"}))}</time>`:""}<h3>${escH(a.title)}</h3>${a.body?`<p>${escH(a.body)}</p>`:""}${a.cta_url&&a.cta_label?`<a class="ann-cta" href="${escH(a.cta_url)}" target="_blank" rel="noopener noreferrer">${escH(a.cta_label)}</a>`:""}</div></article>`).join("");}
}
async function loadLearning(){
  if(!learnData)learnState="loading";renderLearning();
  const reqLang=lang;
  const [c,a,bn]=await Promise.allSettled([call("GET","/api/learn/courses?lang="+reqLang),call("GET","/api/announcements"),call("GET","/api/home/banners")]);   // параллельно
  if(bn.status==="fulfilled"){bannerData=bn.value.banners||[];renderBanners()}
  if(c.status==="fulfilled"){learnData=c.value.courses||[];learnCache[reqLang]=learnData;learnState=learnData.length?"ok":"empty"}
  else{const code=c.reason&&c.reason.code;
    if(code==="NO_ACCESS"||code==="UNAUTHENTICATED"){learnState="no_access";learnData=null}
    else learnState=learnData&&learnData.length?"ok":"error"}            // временная ошибка не стирает уже показанный курс
  if(a.status==="fulfilled")annData=a.value.announcements||[];
  renderLearning()}
/* Карточки функций Academy — из админки (GET /api/home/features). Тексты вставляются только экранированными;
   ссылка есть лишь у статуса ACTIVE с реализованным модулем (решает сервер). При ошибке остаются статичные заглушки. */
const FICON={mentor:'<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>',
  tests:'<path d="M9 4h6M9 4a1 1 0 0 0-1 1v1h8V5a1 1 0 0 0-1-1M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2"/><path d="m9 14 2 2 4-4"/>',
  chart:'<path d="M4 19h16M7 15l4-4 3 3 5-6"/><path d="M15 8h4v4"/>',book:'<path d="M4 5h11a3 3 0 0 1 3 3v12H7a3 3 0 0 1-3-3z"/><path d="M8 9h6M8 13h4"/>',
  star:'<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',bell:'<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  target:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".5"/>',shield:'<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/>'};
const LOCK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
let featureData=null;
function renderFeatures(){
  const box=$("secsList");if(!box||!featureData)return;
  const panel=box.closest(".p-secs");if(panel)panel.hidden=!featureData.length;
  const ic=k=>`<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FICON[k]||FICON.star}</svg></div>`;
  const body=c=>`<div><h3>${escH(c.title)}</h3>${c.description?`<p>${escH(c.description)}</p>`:""}</div>`;
  box.innerHTML=featureData.map(c=>c.status==="ACTIVE"&&c.href
    ?`<a class="sec sec-open" href="${escH(c.href)}" data-feature="${escH(c.id)}">${ic(c.icon)}${body(c)}<span class="tag tag-open">${escH(c.button||t("stOpen"))}</span></a>`
    :`<article class="sec" aria-disabled="true" data-feature="${escH(c.id)}" data-st="${escH(c.status)}">${ic(c.icon)}${body(c)}<span class="tag">${LOCK}<span>${escH(t(c.status==="IN_DEVELOPMENT"?"stDev":c.status==="DISABLED"?"stOff":"soon"))}</span></span></article>`).join("");
  box.querySelectorAll("article.sec").forEach(s=>s.onclick=()=>toast(t(s.dataset.st==="DISABLED"?"stOffToast":"soonToast")));
}
async function loadFeatures(){
  try{const r=await call("GET","/api/home/features?lang="+lang);featureData=r.cards||[];renderFeatures()}
  catch(e){/* остаются статичные заглушки — страница не ломается */}
}
function closeMenu(){$("menu").hidden=true;$("profBtn").setAttribute("aria-expanded","false")}
$("profBtn").onclick=e=>{e.stopPropagation();const o=$("menu").hidden;$("menu").hidden=!o;$("profBtn").setAttribute("aria-expanded",o)};
document.addEventListener("click",e=>{if(!$("menu").hidden&&!$("menu").contains(e.target))closeMenu()});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeMenu()});
document.querySelectorAll("[data-signout]").forEach(b=>b.onclick=()=>{closeMenu();signOutAndLeave()});
document.querySelectorAll(".sec").forEach(s=>s.onclick=()=>toast(t("soonToast")));   // статичные заглушки до загрузки карточек
initTelegram();initParticles(24000,30);initLang(()=>{render();refreshLang();loadFeatures()});render();load();loadFeatures();
