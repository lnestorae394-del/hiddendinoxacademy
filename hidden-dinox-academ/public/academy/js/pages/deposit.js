/* Страница 3 — проверка баланса брокера (deposit.html).
   Сумма и статус берутся только из ответа сервера. */
let depUI={data:null,manualNone:false,lastAt:0,err:false},profile=null;
function render(){
  $("main").innerHTML=`<div class="screen card">${progress(2)}<h1>${t("depTitle")}</h1><p class="sub">${t("depSub")}</p>
  <div class="req"><b>$${CONFIG.minFirstDeposit}</b><span>${t("minDep")}</span></div>
  <div id="depStatus"></div>
  <div class="stack" style="margin-top:4px">${notice()}${btn("checkBtn",t("checkBal"),"btn-outline","button",ICON.refresh)}</div>
  <div class="poll" id="poll"></div>
  <div class="divider"></div>
  <div class="idbox"><div><small>${t("yourId")}</small><b id="depTid"></b></div><button type="button" class="link" id="changeId">${t("change")}</button></div>
  <div class="stack">${btn("leaveBtn",t("leave"),"btn-quiet","button",ICON.out)}</div></div>`;
  $("main").removeAttribute("aria-busy");
  $("checkBtn").onclick=()=>poller.manual();
  $("changeId").onclick=()=>location.href=PAGES.broker+"?change=1";
  $("leaveBtn").onclick=()=>{poller.stop();signOutAndLeave()};
  renderDeposit();applyStatic();
}
function renderDeposit(){
  const box=$("depStatus");if(!box)return;const d=depUI.data||{};const min=CONFIG.minFirstDeposit;
  let cls="",title,note,dot,amount=null,meter=0,low=false;
  if(depUI.err&&!depUI.data){cls="s-err";title=t("stErr");note=t("stErrN");dot=`<span class="dot bad">${t("dErr")}</span>`}
  const pg=d.progress||null,sum=pg?pg.confirmed_cents/100:(d.firstDeposit?d.firstDeposit.amount:null),pend=pg&&pg.pending_count>0;
  if(d.state==="ok"){cls="s-ok";title=t("stOk");note=t("stOkN");dot=`<span class="dot ok">${t("dOk")}</span>`;amount=sum;meter=100}
  else if(d.state==="low"){cls="s-low";title=t("stLow");dot=`<span class="dot wait">${t("dLow")}</span>`;amount=sum;meter=Math.min(100,amount/min*100);low=true;
    // «Подтверждено: $20 из $50. Осталось внести $30» + подсказка о суммировании
    note=t("depSumLine").replace("{c}",money(sum)).replace("{m}",money(min)).replace("{r}",money(pg?pg.remaining_cents/100:Math.max(0,min-sum)))+" "+t("stLowN")}
  else if(depUI.manualNone){cls="s-none";title=t("stNone");note=t("stNoneN");dot=`<span class="dot wait">${t("dNo")}</span>`}
  else{title=t("stWait");note=t("stWaitN");dot=`<span class="dot wait">${t("dWait")}</span>`}
  if(pend&&d.state!=="ok")note+=" "+t("depPendingN");                        // есть событие, ожидающее проверки сервером
  const reg=!!d.brokerRegistrationConfirmed,dep=d.state==="ok";
  box.innerHTML=`<div class="statuscard ${cls}" aria-live="polite"><div class="sc-top"><span class="sc-title">${title}</span>${dot}</div>
    <div class="amount-note">${t("confirmedAmount")}</div>
    <div class="amount ${amount==null?"dim":""}">${amount==null?"$ —":money(amount)}</div>
    <div class="meter ${low?"low":""}"><span style="width:${meter}%"></span></div>
    <div class="amount-note">${note}</div></div>
    <ul class="checks" style="margin:0 0 14px"><li class="ok">${t("ckId")}</li><li class="${reg?"ok":"wait"}">${t("ckReg")}</li><li class="${dep?"ok":"wait"}">${t("ckDep")}</li></ul>`;
  if($("depTid"))$("depTid").textContent=d.traderId||(profile&&profile.traderId)||"";
  const locked=(depUI.data?depUI.data.traderIdLocked:profile&&profile.traderIdLocked)===true;
  if($("changeId"))$("changeId").hidden=locked;
  renderPoll();
}
function renderPoll(){const p=$("poll");if(!p)return;
  if(poller.final){p.className="poll paused";p.innerHTML="";return}
  if(depUI.err){p.className="poll err";p.innerHTML=`<i></i>${t("autoRetry",{s:Math.round(poller.delay/1000)})}`;return}
  if(document.hidden){p.className="poll paused";p.innerHTML=`<i></i>${t("autoPaused")}`;return}
  const ago=depUI.lastAt?Math.round((Date.now()-depUI.lastAt)/1000):null;
  p.className="poll";p.innerHTML=`<i></i>${t("auto")}${ago!=null?" · "+(ago<1?t("justNow"):t("lastCheck",{s:ago})):""}`}
const isValid=r=>r&&["none","low","ok"].includes(r.state)&&(r.state==="none"||(r.firstDeposit&&typeof r.firstDeposit.amount==="number"));
const poller={
  timer:null,inflight:null,delay:CONFIG.pollMs,final:false,active:false,
  start(){this.active=true;this.tick()},
  stop(){this.active=false;clearTimeout(this.timer)},
  schedule(){clearTimeout(this.timer);if(!this.active||this.final||document.hidden)return;this.timer=setTimeout(()=>this.tick(),this.delay)},
  check(){ // один запрос за раз; ручная проверка использует тот же запрос
    if(this.inflight)return this.inflight;
    this.inflight=api.getDepositStatus().then(r=>{
      if(!isValid(r))throw{code:"GENERIC"}; // неполный ответ не открывает доступ
      depUI.data=r;depUI.err=false;depUI.lastAt=Date.now();this.delay=CONFIG.pollMs;
      if(r.state==="ok"&&r.academyAccess===true){this.final=true;setTimeout(async()=>{try{const p=await api.getProfile();location.replace(PAGES[stageOf(p)])}catch(e){}},1700)}
      if(r.state==="low")this.delay=Math.max(CONFIG.pollMs,CONFIG.lowPollMs||30000);   // сумма ниже $50: ждём пополнение того же аккаунта — проверяем реже, но не прекращаем
      return r;
    }).catch(e=>{if(e&&e.code==="UNAUTHENTICATED"){location.replace(PAGES.login)}depUI.err=true;this.delay=Math.min(this.delay*2,CONFIG.maxBackoffMs);throw e})
      .finally(()=>{this.inflight=null;renderDeposit()});
    return this.inflight;
  },
  async tick(){if(!this.active)return;try{await this.check()}catch(e){}this.schedule()},
  async manual(){const b=$("checkBtn");busy(b,true);
    try{const r=await this.check();if(r.state==="none"){depUI.manualNone=true;renderDeposit()}}
    catch(e){showNotice(errMsg(e))}finally{busy($("checkBtn"),false);if(!this.final){if(!(depUI.data&&depUI.data.state==="low"))this.delay=CONFIG.pollMs;this.schedule()}}}
};
document.addEventListener("visibilitychange",()=>{if(!poller.active)return;if(document.hidden)clearTimeout(poller.timer);else poller.tick();renderPoll()});
addEventListener("pagehide",()=>poller.stop());
setInterval(renderPoll,1000);
initTelegram();initParticles();
(async()=>{try{profile=await guard("deposit");if(!profile)return;initLang(render);render();poller.start()}catch(e){initLang(()=>{});$("main").innerHTML=`<div class="notice show"><span>${esc(errMsg(e))}</span></div>`}})();
