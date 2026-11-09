"use strict";
/* Письмо восстановления пароля Hidden Dinox Academy (RU / EN / UA): HTML для Gmail (таблицы, встроенные стили) + текст. */
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TX = {
  ru: { subject: "Сброс пароля — Hidden Dinox Academy", pre: "Ссылка для сброса пароля в Hidden Dinox Academy. Действует около 1 часа.", title: "Сброс пароля",
        p1: "Мы получили запрос на сброс пароля для аккаунта", p2: "Нажмите кнопку, чтобы задать новый пароль.", btn: "Сбросить пароль",
        alt: "Если кнопка не работает, скопируйте ссылку в браузер:", secT: "Безопасность.",
        sec: "Ссылка одноразовая и действует ограниченное время — около 1 часа. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо — пароль не изменится. Мы никогда не просим пароль в письмах и сообщениях.",
        sign1: "С уважением,", sign2: "команда Hidden Dinox Academy" },
  en: { subject: "Password reset — Hidden Dinox Academy", pre: "Your Hidden Dinox Academy password reset link. Valid for about 1 hour.", title: "Password reset",
        p1: "We received a request to reset the password for", p2: "Click the button to set a new password.", btn: "Reset password",
        alt: "If the button doesn't work, copy this link into your browser:", secT: "Security.",
        sec: "This link can be used once and expires after a limited time — about 1 hour. If you didn't request a password reset, just ignore this email — your password won't change. We never ask for your password by email or message.",
        sign1: "Best regards,", sign2: "the Hidden Dinox Academy team" },
  ua: { subject: "Скидання пароля — Hidden Dinox Academy", pre: "Посилання для скидання пароля в Hidden Dinox Academy. Діє близько 1 години.", title: "Скидання пароля",
        p1: "Ми отримали запит на скидання пароля для акаунта", p2: "Натисніть кнопку, щоб встановити новий пароль.", btn: "Скинути пароль",
        alt: "Якщо кнопка не працює, скопіюйте посилання в браузер:", secT: "Безпека.",
        sec: "Посилання одноразове й діє обмежений час — близько 1 години. Якщо ви не запитували скидання пароля, просто проігноруйте цей лист — пароль не зміниться. Ми ніколи не просимо пароль у листах і повідомленнях.",
        sign1: "З повагою,", sign2: "команда Hidden Dinox Academy" }
};
function renderResetEmail({ link, email, lang = "ru", baseUrl }) {
  const t = TX[lang] || TX.ru, L = esc(link), E = esc(email), logo = esc(baseUrl + "/academy/assets/brand/hd-logo-email.png");
  const html = `<!DOCTYPE html><html lang="${lang === "ua" ? "uk" : lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#050705;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#050705;font-size:1px;line-height:1px;">${esc(t.pre)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#050705" style="background:#050705;width:100%;"><tr><td align="center" style="padding:32px 12px;">
 <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0B0F0B" style="max-width:560px;width:100%;background:#0B0F0B;border:1px solid #1E3A12;border-radius:18px;">
  <tr><td align="center" style="padding:32px 28px 8px 28px;">
   <img src="${logo}" width="96" height="72" alt="Hidden Dinox Academy" style="display:block;border:0;outline:none;width:96px;height:auto;">
   <div style="margin-top:14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:3px;font-weight:bold;color:#8BEA24;">HIDDEN DINOX ACADEMY</div></td></tr>
  <tr><td style="padding:18px 28px 0 28px;font-family:Arial,Helvetica,sans-serif;">
   <h1 style="margin:0 0 12px 0;font-size:26px;line-height:1.25;color:#FFFFFF;font-weight:bold;">${esc(t.title)}</h1>
   <p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#E6EBE3;">${esc(t.p1)} <span style="color:#FFFFFF;font-weight:bold;">${E}</span>.</p>
   <p style="margin:0;font-size:15px;line-height:1.6;color:#E6EBE3;">${esc(t.p2)}</p></td></tr>
  <tr><td align="center" style="padding:26px 28px 6px 28px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
   <td align="center" bgcolor="#8BEA24" style="border-radius:12px;background:#8BEA24;"><a href="${L}" target="_blank" style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#061006;text-decoration:none;border-radius:12px;">${esc(t.btn)}</a></td></tr></table></td></tr>
  <tr><td style="padding:18px 28px 0 28px;font-family:Arial,Helvetica,sans-serif;">
   <p style="margin:0 0 6px 0;font-size:13px;line-height:1.5;color:#9AA595;">${esc(t.alt)}</p>
   <p style="margin:0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${L}" target="_blank" style="color:#8BEA24;text-decoration:underline;">${L}</a></p></td></tr>
  <tr><td style="padding:22px 28px 0 28px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0F160D" style="background:#0F160D;border-left:3px solid #8BEA24;border-radius:8px;"><tr>
   <td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#C9D1C5;"><b style="color:#FFFFFF;">${esc(t.secT)}</b> ${esc(t.sec)}</td></tr></table></td></tr>
  <tr><td style="padding:24px 28px 30px 28px;font-family:Arial,Helvetica,sans-serif;"><div style="height:1px;background:#1E3A12;line-height:1px;font-size:1px;">&nbsp;</div>
   <p style="margin:16px 0 0 0;font-size:13px;line-height:1.5;color:#9AA595;">${esc(t.sign1)}<br><span style="color:#8BEA24;font-weight:bold;">${esc(t.sign2)}</span></p></td></tr>
 </table></td></tr></table></body></html>`;
  const text = `${t.title}\n\n${t.p1} ${email}.\n${t.p2}\n\n${t.btn}: ${link}\n\n${t.secT} ${t.sec}\n\n${t.sign1}\n${t.sign2}\n`;
  return { subject: t.subject, html, text };
}
module.exports = { renderResetEmail };
