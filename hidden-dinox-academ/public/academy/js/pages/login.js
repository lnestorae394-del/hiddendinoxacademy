/* Страница 1 — вход, регистрация, восстановление пароля (index.html) */
let screen = location.hash === "#register" ? "register" : location.hash === "#reset" ? "reset" : "login", draft = {};   // index.html#register — сразу экран регистрации
const SCREENS = {
login:()=>`<div class="screen">
  <div class="hero with-mascot">${$("mascotTpl").innerHTML}<h1>${t("loginTitle")}</h1><p class="sub">${t("loginSub")}</p></div>
  <form id="loginForm" novalidate>${notice()}${field("email",t("email"),"email")}${field("password",t("pass"),"password")}
    <div class="row-end"><button type="button" class="link" data-go="reset">${t("forgot")}</button></div>${btn("loginBtn",t("signIn"))}</form>
  <div class="switch">${t("newHere")} <button type="button" class="link" data-go="register">${t("createLink")}</button></div></div>`,
register:()=>`<div class="screen card">${progress(0)}<h1>${t("regTitle")}</h1><p class="sub">${t("regSub")}</p>
  <form id="regForm" novalidate>${notice()}${field("email",t("email"),"email")}${field("password",t("pass"),"password")}<div class="hint" style="margin-top:-8px">${t("hint")}</div>${field("password2",t("pass2"),"password")}${btn("regBtn",t("regBtn"))}</form>
  <div class="switch">${t("have")} <button type="button" class="link" data-go="login">${t("toLogin")}</button></div></div>`,
reset:()=>`<div class="screen"><div class="hero"><h1>${t("resetTitle")}</h1><p class="sub">${t("resetSub")}</p></div>
  <form id="resetForm" novalidate>${notice()}${field("email",t("email"),"email")}${btn("resetBtn",t("resetBtn"))}</form>
  <div class="switch"><button type="button" class="link" data-go="login">${t("back")}</button></div></div>`
};
function go(s){screen=s;render()}
function render(){
  const keep={};["email","password","password2"].forEach(id=>{if($(id))keep[id]=$(id).value});
  $("main").innerHTML=SCREENS[screen]();$("main").removeAttribute("aria-busy");bindCommon($("main"));
  Object.entries({...draft,...keep}).forEach(([id,v])=>{if($(id)&&v)$(id).value=v});
  $("main").querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
  bind();applyStatic();
}
async function routeFromServer(){ // этап выбирает сервер
  try{const p=await api.getProfile();location.replace(PAGES[stageOf(p)])}catch(e){showNotice(errMsg(e))}
}
function bind(){
  const lf=$("loginForm");if(lf)lf.onsubmit=async e=>{e.preventDefault();const em=$("email").value.trim(),pw=$("password").value;let ok=true;
    if(!em){setErr("email",t("eReq"),1);ok=false}else if(!EMAIL_RE.test(em)){setErr("email",t("eEmail"),1);ok=false}
    if(!pw){setErr("password",t("eReq"),1);ok=false}if(!ok)return;const b=$("loginBtn");if(b.disabled)return;busy(b,true);
    try{await api.signIn(em,pw);await routeFromServer()}catch(err){showNotice(errMsg(err))}finally{busy(b,false)}};
  const rf=$("regForm");if(rf)rf.onsubmit=async e=>{e.preventDefault();const em=$("email").value.trim(),pw=$("password").value,pw2=$("password2").value;let ok=true;
    if(!em){setErr("email",t("eReq"),1);ok=false}else if(!EMAIL_RE.test(em)){setErr("email",t("eEmail"),1);ok=false}
    if(!pw){setErr("password",t("eReq"),1);ok=false}else if(pw.length<CONFIG.minPassword){setErr("password",t("ePass"),1);ok=false}
    if(pw2!==pw){setErr("password2",t("ePass2"),1);ok=false}if(!ok)return;const b=$("regBtn");if(b.disabled)return;busy(b,true);
    try{await api.signUp(em,pw);location.replace(PAGES.broker)}catch(err){showNotice(errMsg(err));if(err&&err.code==="EMAIL_EXISTS")draft={email:em}}finally{busy(b,false)}};
  const sf=$("resetForm");if(sf)sf.onsubmit=async e=>{e.preventDefault();const em=$("email").value.trim();
    if(!EMAIL_RE.test(em)){setErr("email",em?t("eEmail"):t("eReq"),1);return}const b=$("resetBtn");if(b.disabled)return;busy(b,true);
    try{await api.resetPassword(em);showNotice(t("resetSent"),true)}catch(err){showNotice(errMsg(err))}finally{busy(b,false)}};
}
initTelegram();initModals();initParticles();initLang(render);render();
// Уже вошедший пользователь сразу уходит на свой этап
api.getProfile().then(p=>location.replace(PAGES[stageOf(p)])).catch(()=>{});
