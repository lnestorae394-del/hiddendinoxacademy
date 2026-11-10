/* Готовность Firebase для приложения: модуль firebase.js сообщает о себе через window.__vsFbResolve */
window.__vsFb = new Promise(function (res, rej) { window.__vsFbResolve = res; window.__vsFbReject = rej; setTimeout(function () { rej({ code: "NETWORK" }); }, 20000); });
window.__vsFb.catch(function () {});
