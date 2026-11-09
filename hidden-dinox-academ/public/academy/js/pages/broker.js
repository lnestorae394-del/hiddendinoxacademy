/* Страница 2 — подключение брокера (broker.html) */
let profile=null;
function render(){
  $("main").innerHTML=`<div class="screen card">${progress(1)}<h1>${t("brokerTitle")}</h1><p class="sub">${t("brokerSub")}</p>
  <button type="button" class="btn btn-primary" id="pocketBtn" data-partner><span class="label">${t("pocket")}</span>${ICON.ext}</button>
  <div class="center" style="margin-top:10px"><button type="button" class="link" data-modal="howModal">${ICON.q}<span>${t("where")}</span></button></div>
  <div class="divider"></div>
  <form id="idForm" novalidate>${notice()}${field("traderId",t("idLabel"),"text","mono")}${btn("idBtn",t("confirmId"),"btn-outline")}</form>
  <div class="stack"><button type="button" class="ghost" data-modal="oldModal" style="width:100%">${t("oldAcc")}</button>${btn("leaveBtn",t("leave"),"btn-quiet","button",ICON.out)}</div></div>`;
  $("main").removeAttribute("aria-busy");bindCommon($("main"));bind();applyStatic();
}
async function openPartner(e){const b=e.currentTarget;if(b.disabled)return;b.disabled=true;
  try{try{await window.__hdVia}catch(x){}
    let base=null;try{const r=await call("GET","/api/broker-link");base=r&&r.url||null}catch(x){}   // ссылка партнёра, если закреплён; иначе основная
    const clickId=await api.getClickId();openExternal(partnerLink(clickId,base))} // click_id выдаёт сервер
  catch(err){toast(errMsg(err))}finally{b.disabled=false}}
function bind(){
  document.querySelectorAll("[data-partner]").forEach(b=>b.onclick=openPartner);
  const inp=$("traderId");inp.inputMode="numeric";inp.autocomplete="off";inp.maxLength=14;inp.placeholder=t("idPh");
  if(profile&&profile.traderId&&!inp.value)inp.value=profile.traderId;
  const sync=()=>$("idBtn").classList.toggle("ready",CONFIG.traderIdPattern.test(inp.value.replace(/\s+/g,"")));inp.addEventListener("input",sync);sync();
  $("idForm").onsubmit=async e=>{e.preventDefault();const v=inp.value.replace(/\s+/g,"");
    if(!v){setErr("traderId",t("eIdEmpty"),1);inp.focus();return}if(!CONFIG.traderIdPattern.test(v)){setErr("traderId",t("eIdFormat"),1);inp.focus();return}
    const b=$("idBtn");if(b.disabled)return;busy(b,true);
    try{await api.submitTraderId(v);location.replace(PAGES.deposit)}
    catch(err){const c=err&&err.code;if(["TRADER_TAKEN","INVALID","TRADER_NOT_CONFIRMED"].includes(c))setErr("traderId",t(c==="INVALID"?"eIdFormat":c),1);else showNotice(errMsg(err))}finally{busy(b,false)}};
  $("leaveBtn").onclick=signOutAndLeave;
}
// Скриншоты инструкции: показываем реальные файлы, если они есть
document.querySelectorAll(".shot[data-img]").forEach(s=>{const img=new Image();img.alt="";img.onload=()=>{s.classList.add("has-img");s.replaceChildren(img)};img.src=s.dataset.img});
initTelegram();initModals();initParticles();
// ?change=1 — пользователь пришёл со страницы проверки, чтобы исправить Trader ID
const changing=new URLSearchParams(location.search).get("change")==="1";
(async()=>{try{profile=await guard("broker",changing?["deposit"]:[]);if(!profile)return;
  if(changing&&profile.traderIdLocked){location.replace(PAGES.deposit);return}initLang(render);render()}catch(e){initLang(()=>{});$("main").innerHTML=`<div class="notice show"><span>${esc(errMsg(e))}</span></div>`}})();
