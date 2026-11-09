/* ИИ-помощник Hidden Dinox Academy — чат (ответы формирует сервер через Claude API; ключ на сервере). */
(function () {
  let LANG = "ru"; try { const x = localStorage.getItem("hd_lang"); if (["ru", "en", "ua"].includes(x)) LANG = x; } catch (e) {}
  document.documentElement.lang = LANG === "ua" ? "uk" : LANG;
  const S = {
    ru: { memory: "Что помнит наставник", memTitle: "Что помнит наставник", memProfile: "Ваше обучение (прогресс и слабые темы)", memSummary: "Краткое содержание этого диалога", memNotes: "Заметки по графикам в этом диалоге", memNone: "Пока ничего", memUse: "Учитывать мой прогресс в ответах", memForget: "Забыть", memForgetQ: "Стереть краткое содержание диалога и заметки по графикам? Ваш прогресс в обучении не изменится.", memClose: "Закрыть", page: "ИИ-помощник", welcome: "Привет! Я твой ИИ-помощник Hidden Dinox Academy. Можешь задавать вопросы по Hidden Reaction, Smart Money Concepts и Risk Management. Я помогу разобраться в материалах и объяснить сложные моменты.",
      place: "Спросите о трейдинге, курсах или пришлите скриншот графика…", send: "Отправить", attach: "Прикрепить график", imageBad: "Выберите JPEG, PNG или WebP до 5 МБ.", imageTooBig: "Файл больше 5 МБ.", removeImage: "Убрать изображение", typing: "ИИ-помощник печатает", newChat: "Новый диалог", clear: "Очистить историю", clearQ: "Удалить всю историю переписки с ИИ-помощником? Это действие нельзя отменить.",
      yes: "Удалить", no: "Отмена", left: "Осталось сообщений сегодня: {n} из {t}", src: "Источник", sources: "📚 Материалы академии", retry: "Повторить",
      note: "ИИ может ошибаться — сверяйтесь с уроками. Ответы не являются финансовой рекомендацией и не гарантируют результат.",
      IMAGE_INVALID: "Неподдерживаемый формат изображения.", USER_BUDGET: "Ваш месячный лимит ИИ-помощника исчерпан. Уроки и тесты доступны как обычно.", IMAGE_LIMIT: "Лимит разборов скриншотов на сегодня исчерпан. Текстовые вопросы можно задавать дальше.", attachTitle: "Добавить изображение", removeOne: "Удалить изображение", kb: "КБ", IMAGE_COUNT: "Можно прикрепить не больше 2 изображений к одному сообщению.", IMAGE_DIMENSIONS: "Изображение слишком маленькое или слишком большое: нужно от 64 до 8000 пикселей по каждой стороне.", IMAGE_TOO_LARGE: "Изображение должно быть до 5 МБ.", AI_NOT_CONFIGURED: "ИИ-помощник ещё не подключён. Попробуйте позже.", AI_UNAVAILABLE: "ИИ-помощник временно недоступен. Попробуйте ещё раз через минуту.",
      USER_LIMIT: "Лимит сообщений на сегодня исчерпан. Новые сообщения будут доступны завтра.", BUDGET_EXHAUSTED: "ИИ-помощник временно недоступен: исчерпан общий лимит. Уроки и тесты работают как обычно.",
      BUSY: "Дождитесь ответа на предыдущее сообщение.", TOO_LONG: "Сообщение слишком длинное — не больше 1000 символов.", EMPTY: "Напишите вопрос.",
      NETWORK: "Нет связи с сервером. Попробуйте ещё раз.", FEATURE_UNAVAILABLE: "Раздел пока недоступен.", generic: "Не удалось получить ответ. Попробуйте ещё раз." },
    en: { memory: "What the mentor remembers", memTitle: "What the mentor remembers", memProfile: "Your learning (progress and weak topics)", memSummary: "Summary of this chat", memNotes: "Chart notes in this chat", memNone: "Nothing yet", memUse: "Use my progress in answers", memForget: "Forget", memForgetQ: "Erase the chat summary and chart notes? Your learning progress will not change.", memClose: "Close", page: "AI Mentor", welcome: "Hi! I'm your Hidden Dinox Academy AI mentor. You can ask me questions about Hidden Reaction, Smart Money Concepts and Risk Management. I'll help you make sense of the materials and explain the tricky parts.",
      place: "Ask about trading, the courses, or send a chart screenshot…", send: "Send", attach: "Attach chart", imageBad: "Choose JPEG, PNG or WebP up to 5 MB.", imageTooBig: "File is larger than 5 MB.", removeImage: "Remove image", typing: "AI Mentor is typing", newChat: "New chat", clear: "Clear history", clearQ: "Delete your entire chat history with the AI mentor? This cannot be undone.",
      yes: "Delete", no: "Cancel", left: "Messages left today: {n} of {t}", src: "Source", sources: "📚 Academy materials", retry: "Retry",
      note: "AI can make mistakes — check against the lessons. Answers are not financial advice and do not guarantee results.",
      IMAGE_INVALID: "Unsupported image format.", USER_BUDGET: "Your monthly AI mentor limit has been reached. Lessons and tests are available as usual.", IMAGE_LIMIT: "Today's screenshot review limit has been reached. You can still ask text questions.", attachTitle: "Add an image", removeOne: "Remove image", kb: "KB", IMAGE_COUNT: "You can attach up to 2 images to one message.", IMAGE_DIMENSIONS: "The image is too small or too large: each side must be 64 to 8000 pixels.", IMAGE_TOO_LARGE: "Image must be up to 5 MB.", AI_NOT_CONFIGURED: "The AI mentor is not connected yet. Please try later.", AI_UNAVAILABLE: "The AI mentor is temporarily unavailable. Please try again in a minute.",
      USER_LIMIT: "You've reached today's message limit. New messages will be available tomorrow.", BUDGET_EXHAUSTED: "The AI mentor is temporarily unavailable: the overall limit has been reached. Lessons and tests work as usual.",
      BUSY: "Please wait for the answer to your previous message.", TOO_LONG: "The message is too long — up to 1000 characters.", EMPTY: "Type a question.",
      NETWORK: "No connection to the server. Please try again.", FEATURE_UNAVAILABLE: "This section is not available yet.", generic: "Could not get an answer. Please try again." },
    ua: { memory: "Що пам’ятає наставник", memTitle: "Що пам’ятає наставник", memProfile: "Ваше навчання (прогрес і слабкі теми)", memSummary: "Короткий зміст цього діалогу", memNotes: "Нотатки щодо графіків у цьому діалозі", memNone: "Поки нічого", memUse: "Враховувати мій прогрес у відповідях", memForget: "Забути", memForgetQ: "Стерти короткий зміст діалогу й нотатки щодо графіків? Ваш прогрес у навчанні не зміниться.", memClose: "Закрити", page: "ШІ-помічник", welcome: "Привіт! Я твій ШІ-помічник Hidden Dinox Academy. Можеш ставити запитання з Hidden Reaction, Smart Money Concepts і Risk Management. Я допоможу розібратися в матеріалах і пояснити складні моменти.",
      place: "Запитайте про трейдинг, курси або надішліть скриншот графіка…", send: "Надіслати", attach: "Додати графік", imageBad: "Оберіть JPEG, PNG або WebP до 5 МБ.", imageTooBig: "Файл більший за 5 МБ.", removeImage: "Прибрати зображення", typing: "ШІ-помічник друкує", newChat: "Новий діалог", clear: "Очистити історію", clearQ: "Видалити всю історію листування з ШІ-помічником? Цю дію не можна скасувати.",
      yes: "Видалити", no: "Скасувати", left: "Залишилося повідомлень сьогодні: {n} з {t}", src: "Джерело", sources: "📚 Матеріали академії", retry: "Повторити",
      note: "ШІ може помилятися — звіряйтеся з уроками. Відповіді не є фінансовою рекомендацією й не гарантують результату.",
      IMAGE_INVALID: "Непідтримуваний формат зображення.", USER_BUDGET: "Ваш місячний ліміт ШІ-помічника вичерпано. Уроки й тести доступні як зазвичай.", IMAGE_LIMIT: "Ліміт розборів скриншотів на сьогодні вичерпано. Текстові запитання можна ставити далі.", attachTitle: "Додати зображення", removeOne: "Видалити зображення", kb: "КБ", IMAGE_COUNT: "До одного повідомлення можна прикріпити не більше 2 зображень.", IMAGE_DIMENSIONS: "Зображення замале або завелике: потрібно від 64 до 8000 пікселів по кожній стороні.", IMAGE_TOO_LARGE: "Зображення має бути до 5 МБ.", AI_NOT_CONFIGURED: "ШІ-помічник ще не підключено. Спробуйте пізніше.", AI_UNAVAILABLE: "ШІ-помічник тимчасово недоступний. Спробуйте ще раз за хвилину.",
      USER_LIMIT: "Ліміт повідомлень на сьогодні вичерпано. Нові повідомлення будуть доступні завтра.", BUDGET_EXHAUSTED: "ШІ-помічник тимчасово недоступний: вичерпано загальний ліміт. Уроки й тести працюють як зазвичай.",
      BUSY: "Дочекайтеся відповіді на попереднє повідомлення.", TOO_LONG: "Повідомлення задовге — не більше 1000 символів.", EMPTY: "Напишіть запитання.",
      NETWORK: "Немає зв’язку із сервером. Спробуйте ще раз.", FEATURE_UNAVAILABLE: "Розділ поки недоступний.", generic: "Не вдалося отримати відповідь. Спробуйте ще раз." }
  };
  const s = (k, v) => { let x = S[LANG][k] != null ? S[LANG][k] : S.ru[k] != null ? S.ru[k] : k; if (v) for (const [a, b] of Object.entries(v)) x = x.split("{" + a + "}").join(String(b)); return x; };
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const main = document.getElementById("lp");
  document.title = s("page") + " — HIDDEN DINOX ACADEMY"; { const c = document.getElementById("crumb"); if (c) c.textContent = s("page"); }
  { const bk = document.getElementById("back"); if (bk) bk.textContent = "← " + ({ ru: "Академия", en: "Academy", ua: "Академія" })[LANG]; }
  /* безопасная разметка ответа: экранирование, абзацы, списки «- », **жирный** */
  function fmt(t) {
    const out = []; let list = null;
    for (const line of String(t).split("\n")) {
      const li = /^\s*[-•*]\s+(.*)$/.exec(line), x = esc(li ? li[1] : line).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      if (li) { if (!list) { list = []; } list.push(`<li>${x}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
      if (line.trim()) out.push(`<p>${x}</p>`);
    }
    if (list) out.push(`<ul>${list.join("")}</ul>`);
    return out.join("");
  }
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : (Date.now().toString(36) + Math.random().toString(36).slice(2))).slice(0, 32);
  let state = { messages: [], limit: null, busy: false, pending: null, images: [] };
  function bubble(m) {
    const sources = (m.sources || []).length
      ? `<details class="mn-src"><summary>${esc(s("sources"))}</summary><ul>${m.sources.map(x => `<li>${esc(x.course)} → ${esc(x.lesson)}</li>`).join("")}</ul></details>`
      : "";
    return `<div class="mn-msg ${m.role}${m.welcome ? " mn-welcome" : ""}" data-role="${m.role}">${m.role === "assistant" ? fmt(m.text) : `<p>${esc(m.text).replace(/\n/g, "<br>")}</p>`}${sources}</div>`;
  }
  function render() {
    main.innerHTML = `<div class="mn-top"><h1>${esc(s("page"))}</h1><div class="mn-acts"><button class="lp-btn" id="mnMemory" type="button" aria-expanded="false" aria-controls="mnMemPanel">${esc(s("memory"))}</button><button class="lp-btn" id="mnNew" type="button">${esc(s("newChat"))}</button><button class="lp-btn" id="mnClear" type="button">${esc(s("clear"))}</button></div></div>
      <section class="mn-mem" id="mnMemPanel" hidden aria-label="${esc(s("memTitle"))}"></section>
      <div class="mn-confirm" id="mnClearBox" hidden><p style="margin:0 0 10px">${esc(s("clearQ"))}</p><div class="mn-acts"><button class="lp-btn" id="mnClearNo" type="button">${esc(s("no"))}</button><button class="lp-btn primary" id="mnClearYes" type="button">${esc(s("yes"))}</button></div></div>
      <p class="mn-limit" id="mnLimit"></p>
      <div class="mn-log" id="mnLog" aria-live="polite"></div>
      <div class="mn-err" id="mnErr" hidden><span id="mnErrText"></span><button class="lp-btn" id="mnRetry" type="button" hidden>${esc(s("retry"))}</button></div>
      <div class="mn-composer-wrap">
      <div class="mn-attachments" id="mnAttach" hidden></div>
      <form class="mn-composer" id="mnForm" novalidate>
        <input id="mnImage" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
        <button type="button" class="mn-icon" id="mnAttachBtn" aria-label="${esc(s("attachTitle"))}" title="${esc(s("attachTitle"))}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M21 11.5 12.6 19.9a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <div class="mn-field"><textarea id="mnInput" rows="1" maxlength="1000" placeholder="${esc(s("place"))}" aria-label="${esc(s("place"))}"></textarea><span class="mn-count" id="mnCount" aria-hidden="true">0/1000</span></div>
        <button class="mn-send" id="mnSend" type="submit" aria-label="${esc(s("send"))}" title="${esc(s("send"))}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M4 12 20 4l-6 16-3-7-7-1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span class="mn-send-t">${esc(s("send"))}</span></button>
      </form></div>
      <p class="mn-note">${esc(s("note"))}</p>`;
    bind(); paint();
  }
  function paint() {
    const log = document.getElementById("mnLog");
    // приветствие — только в пустом диалоге (без повторов после восстановления истории)
    log.innerHTML = (state.messages.length ? "" : bubble({ role: "assistant", text: s("welcome"), welcome: true })) + state.messages.map(bubble).join("") + (state.busy ? `<div class="mn-typing" id="mnTyping">${esc(s("typing"))} <i></i><i></i><i></i></div>` : "");
    log.scrollTop = log.scrollHeight;
    const l = state.limit; document.getElementById("mnLimit").textContent = l ? s("left", { n: l.remaining_today, t: l.per_day }) : "";
    const send = document.getElementById("mnSend"); send.disabled = state.busy; send.setAttribute("aria-busy", String(state.busy)); send.classList.toggle("loading", state.busy);
    document.getElementById("mnAttachBtn").disabled = state.busy || state.images.length >= MAX_IMAGES;
    const box = document.getElementById("mnAttach"); box.hidden = !state.images.length;
    box.innerHTML = state.images.map((x, i) => `<figure class="mn-thumb" data-img="${i}"><img src="data:${x.mime_type};base64,${x.data}" alt=""><figcaption><span class="mn-thumb-n">${esc(x.name)}</span><span class="mn-thumb-s">${Math.max(1, Math.round(x.size / 1024))} ${esc(s("kb"))}</span></figcaption>
      <button type="button" class="mn-thumb-x" data-rm="${i}" aria-label="${esc(s("removeOne"))} ${esc(x.name)}" title="${esc(s("removeOne"))}">×</button></figure>`).join("");
    box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { state.images.splice(Number(b.dataset.rm), 1); paint(); document.getElementById("mnInput").focus(); });
  }
  function showErr(code, canRetry) {
    const box = document.getElementById("mnErr"); document.getElementById("mnErrText").textContent = s(S.ru[code] ? code : "generic");
    document.getElementById("mnRetry").hidden = !canRetry; box.hidden = false; box.dataset.code = code || "generic";
  }
  async function sendMsg(text, id, images = []) {
    document.getElementById("mnErr").hidden = true;
    state.busy = true; state.pending = { text, id, images }; state.messages.push({ role: "user", text: text || "[Скриншот графика]", local: id }); paint();
    try {
      const r = await call("POST", "/api/mentor/message?lang=" + LANG, { text, client_id: id, ...(images.length ? { images: images.map(x => ({ mime_type: x.mime_type, data: x.data })) } : {}) });
      state.messages.push(r.reply); state.pending = null; if (state.limit) state.limit.remaining_today = Math.max(0, state.limit.remaining_today - (r.duplicate ? 0 : 1));
    } catch (e) {
      state.messages = state.messages.filter(m => m.local !== id);   // не показываем неотправленное как часть диалога
      const code = e && e.code; if (code === "UNAUTHENTICATED") return location.replace("/");
      showErr(code, code === "NETWORK" || code === "AI_UNAVAILABLE" || code === "UNAVAILABLE");
      if (code !== "NETWORK" && code !== "AI_UNAVAILABLE") state.pending = null; else document.getElementById("mnInput").value = text;
    } finally { state.busy = false; paint(); }
  }
  /* «Что помнит наставник»: профиль обучения, сводка и заметки текущего диалога; отключение профиля и «Забыть» */
  async function memoryPanel() {
    const box = document.getElementById("mnMemPanel"), btn = document.getElementById("mnMemory");
    if (!box.hidden) { box.hidden = true; btn.setAttribute("aria-expanded", "false"); return; }
    box.hidden = false; btn.setAttribute("aria-expanded", "true"); box.innerHTML = `<p class="mn-note">…</p>`;
    try {
      const m = await call("GET", "/api/mentor/memory?lang=" + LANG);
      const block = (t, body) => `<div class="mn-mem-b"><b>${esc(t)}</b><div>${body}</div></div>`;
      box.innerHTML = `<h2>${esc(s("memTitle"))}</h2>
        ${block(s("memProfile"), m.profile ? esc(m.profile).replace(/\n/g, "<br>") : esc(m.use_profile ? (m.profile_empty || s("memNone")) : s("memNone")))}
        ${block(s("memSummary"), m.summary ? esc(m.summary) : esc(s("memNone")))}
        ${block(s("memNotes"), (m.chart_notes || []).length ? `<ul>${m.chart_notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : esc(s("memNone")))}
        <label class="mn-mem-use"><input type="checkbox" id="mnUseProfile" ${m.use_profile ? "checked" : ""}> ${esc(s("memUse"))}</label>
        <div class="mn-acts"><button class="lp-btn" id="mnForget" type="button">${esc(s("memForget"))}</button><button class="lp-btn" id="mnMemClose" type="button">${esc(s("memClose"))}</button></div>
        <div class="mn-confirm" id="mnForgetBox" hidden><p style="margin:0 0 10px">${esc(s("memForgetQ"))}</p><div class="mn-acts"><button class="lp-btn" id="mnForgetNo" type="button">${esc(s("no"))}</button><button class="lp-btn primary" id="mnForgetYes" type="button">${esc(s("memForget"))}</button></div></div>`;
      document.getElementById("mnUseProfile").onchange = async e => { try { await call("POST", "/api/mentor/memory/profile", { use: e.target.checked }); } catch (er) { e.target.checked = !e.target.checked; } };
      document.getElementById("mnMemClose").onclick = () => { box.hidden = true; btn.setAttribute("aria-expanded", "false"); btn.focus(); };
      const fb = document.getElementById("mnForgetBox");
      document.getElementById("mnForget").onclick = () => { fb.hidden = false; document.getElementById("mnForgetNo").focus(); };
      document.getElementById("mnForgetNo").onclick = () => { fb.hidden = true; };
      document.getElementById("mnForgetYes").onclick = async () => { try { await call("POST", "/api/mentor/memory/forget", { confirm: true }); box.hidden = true; memoryPanel(); } catch (er) { showErr(er && er.code, false); } };
    } catch (e) { box.innerHTML = `<p class="mn-note">${esc(s("generic"))}</p>`; }
  }
  /* Изображение для отправки: JPEG/PNG/WebP до 5 МБ; длинная сторона > 1568 px уменьшается (API всё равно уменьшает такие изображения);
     формат сохраняется, если файл помещается, иначе JPEG 0.92 — цены и свечи остаются читаемыми */
  const MAX_IMAGES = 2, MAX_SIDE = 1568, MAX_BYTES = 5 * 1024 * 1024;
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function prepareImage(f) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) throw { code: "IMAGE_INVALID" };
    let bmp; try { bmp = await createImageBitmap(f); } catch (e) { throw { code: "IMAGE_INVALID" }; }   // файл не открывается как изображение
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && f.size <= MAX_BYTES) { const out = { name: f.name || "screenshot", mime_type: f.type, data: await toB64(f), w: bmp.width, h: bmp.height, size: f.size }; bmp.close && bmp.close(); return out; }
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    const g = cv.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close && bmp.close();
    let type = f.type === "image/jpeg" ? "image/jpeg" : f.type, blob = await new Promise(r => cv.toBlob(r, type, 0.92));
    if (!blob || blob.size > MAX_BYTES) { type = "image/jpeg"; blob = await new Promise(r => cv.toBlob(r, type, 0.92)); }
    if (!blob || blob.size > MAX_BYTES) throw { code: "IMAGE_TOO_LARGE" };
    return { name: f.name || "screenshot", mime_type: type, data: await toB64(blob), w: cv.width, h: cv.height, size: blob.size };
  }
  function bind() {
    document.getElementById("mnMemory").onclick = memoryPanel;
    const ta = document.getElementById("mnInput"), cnt = document.getElementById("mnCount");
    const picker = document.getElementById("mnImage");
    const addFiles = async files => {
      for (const f of [...files]) { if (state.images.length >= MAX_IMAGES) { showErr("IMAGE_COUNT", false); break; }
        try { state.images.push(await prepareImage(f)); } catch (e) { showErr(e && e.code || "IMAGE_INVALID", false); } }
      picker.value = ""; paint(); };
    picker.onchange = () => addFiles(picker.files || []);
    ta.addEventListener("paste", e => { const fl = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => /^image\//.test(f.type)); if (fl.length) { e.preventDefault(); addFiles(fl); } });   // вставка скриншота из буфера
    document.getElementById("mnAttachBtn").onclick = () => picker.click();
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 6 * 22 + 20) + "px"; };   // поле подрастает до 6 строк
    const count = () => { cnt.textContent = ta.value.length + "/1000"; cnt.hidden = ta.value.length < 800; };   // счётчик — только когда до лимита близко
    ta.oninput = () => { count(); grow(); }; count();
    ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.getElementById("mnForm").requestSubmit(); } };
    document.getElementById("mnForm").onsubmit = e => {
      e.preventDefault(); if (state.busy) return; const text = ta.value.trim(); const images = state.images.slice();
      if (!text && !images.length) { showErr("EMPTY", false); return; } if (text.length > 1000) { showErr("TOO_LONG", false); return; }
      const id = state.pending && state.pending.text === text ? state.pending.id : newId();   // повтор того же текста — тот же client_id (без дублей)
      ta.value = ""; cnt.textContent = "0/1000"; state.images = []; picker.value = ""; paint(); sendMsg(text, id, images);
    };
    document.getElementById("mnRetry").onclick = () => { if (state.pending && !state.busy) { document.getElementById("mnInput").value = ""; sendMsg(state.pending.text, state.pending.id, state.pending.images || []); } };
    document.getElementById("mnNew").onclick = async () => { try { await call("POST", "/api/mentor/new", {}); state.messages = []; state.pending = null; document.getElementById("mnErr").hidden = true; paint(); } catch (e) { showErr(e && e.code, false); } };
    const box = document.getElementById("mnClearBox");
    document.getElementById("mnClear").onclick = () => { box.hidden = false; document.getElementById("mnClearNo").focus(); };
    document.getElementById("mnClearNo").onclick = () => { box.hidden = true; };
    document.getElementById("mnClearYes").onclick = async () => { try { await call("POST", "/api/mentor/clear", { confirm: true }); state.messages = []; state.pending = null; box.hidden = true; paint(); } catch (e) { showErr(e && e.code, false); } };
  }
  async function load() {
    try { const t = await call("GET", "/api/mentor/thread"); state.messages = t.messages; state.limit = t.limit; render(); if (!t.configured) showErr("AI_NOT_CONFIGURED", false); }
    catch (e) {
      if (e && e.code === "UNAUTHENTICATED") return location.replace("/");
      if (e && e.code === "NO_ACCESS") return location.replace("academy.html");
      main.innerHTML = `<h1>${esc(s("page"))}</h1><p class="lp-err" id="mnFail">${esc(s(e && ["FEATURE_UNAVAILABLE", "NETWORK"].includes(e.code) ? e.code : "generic"))}</p><div class="lp-foot"><a class="lp-btn" href="academy.html">←</a></div>`;
    }
  }
  document.querySelectorAll(".lp-langs [data-lang]").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.lang === LANG));
    b.onclick = () => { LANG = b.dataset.lang; try { localStorage.setItem("hd_lang", LANG); } catch (e) {} location.reload(); }; });
  (async () => { try { const f = await fb(); if (!f.auth.currentUser) return location.replace("/"); } catch (e) { return; } load(); })();
})();
