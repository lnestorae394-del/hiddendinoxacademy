"""Баннеры главной, встроенная читалка книги, реферальная цепочка и админ-раздел партнёров — в браузере (Playwright).
Сервер — настоящие обработчики академии (книга, рефералы, CMS) на тестовой Firestore. Запуск: python3 tests/e2e/features_e2e.py"""
import os, re, json, subprocess, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8791"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def status_of(path, headers=None):
    try: return urllib.request.urlopen(urllib.request.Request(B + path, headers=headers or {})).status
    except urllib.error.HTTPError as e: return e.code
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:300]}"))
def new_page(b, w=375, h=860, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": h})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};" + (f"localStorage.setItem('hd_lang','{lang}');" if lang else ""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email, start="/academy/"):
    p.goto(B + start); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=10000)
def access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id=trader); p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id=trader, amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT, "REFERRAL_MODE": "test"}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ---------- Баннеры главной: компьютер ----------
    ctx, p = new_page(b, 1280); register(p, "reader@test.com"); access(p, "77700011")
    p.wait_for_selector("#bannerSec:not([hidden]) a.hd-banner")
    boxes = p.eval_on_selector_all("a.hd-banner", "els=>els.map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})")
    texts = p.eval_on_selector_all("a.hd-banner", "els=>els.map(e=>[e.querySelector('.hb-title').textContent,e.querySelector('.hb-cta').textContent,e.getAttribute('href')])")
    check("компьютер: три баннера одинакового размера", len(boxes) == 3 and boxes[0] == boxes[1] == boxes[2], boxes)
    LAYOUT = "[...document.querySelectorAll('.hd-banner')].map(b=>{const r=x=>b.querySelector(x).getBoundingClientRect(),bb=b.getBoundingClientRect(),c=r('.hb-cat'),t=r('.hb-title'),a=r('.hb-cta');return c.bottom<=t.top+0.5&&t.bottom<=a.top+0.5&&a.bottom<=bb.bottom&&c.top>=bb.top&&c.right<=bb.right})"
    check("компьютер: в каждой карточке плашка, заголовок и кнопка не перекрываются и не выходят за край", all(p.evaluate(LAYOUT)), p.evaluate(LAYOUT))
    check("1-я карточка — ПРИГЛАШАЙ И ЗАРАБАТЫВАЙ («Мой кабинет» → кабинет)", texts[0] == ["ПРИГЛАШАЙ И ЗАРАБАТЫВАЙ", "Мой кабинет", "partner.html"], texts)
    check("2-я — книга («Читать книгу» → читалка)", texts[1] == ["THE HIDDEN REACTION SYSTEM", "Читать книгу", "reader.html"], texts)
    check("3-я — ИСТОРИЯ СОЗДАНИЯ HIDDEN DINOX («Читать историю» → история)", texts[2] == ["ИСТОРИЯ СОЗДАНИЯ HIDDEN DINOX", "Читать историю", "story.html"], texts)
    check("честная сумма: «$10 за квалифицированного реферала», нигде нет +$100", "$10 за квалифицированного реферала" in p.inner_text("#bannerSec").lower() and "100" not in p.inner_text("#bannerSec"), p.inner_text("#bannerSec")[:200])
    order = p.evaluate("[...document.querySelectorAll('main > section, .app > section, section')].map(s=>s.id||s.className.split(' ').slice(-1)[0]).filter(x=>['p-status','p-progress','bannerSec'].includes(x))")
    check("порядок на главной: статус → прогресс → карусель", order == ["p-status", "p-progress", "bannerSec"], order)
    check("у кнопок есть круглая стрелка; описаний под баннерами нет", p.locator("a.hd-banner .hb-arrow").count() == 3 and p.locator("#bannerSec p").count() == 0)
    check("компьютер: карусель прокручивается стрелкой", p.is_visible("#bNext") and p.evaluate("(()=>{const r=document.getElementById('bannerRow');const x=r.scrollLeft;document.getElementById('bNext').click();return new Promise(ok=>setTimeout(()=>ok(r.scrollLeft>x),700))})()"))
    p.wait_for_function("[...document.querySelectorAll('a.hd-banner img')].every(i=>i.complete&&i.naturalWidth>0)", timeout=10000)
    p.wait_for_selector("#learnList .learn-msg", timeout=8000)
    check("курсов нет: блок прогресса не остаётся заглушкой загрузки", p.locator(".p-progress .sk").count() == 0 and p.inner_text(".p-progress").strip() != "", p.inner_text(".p-progress")[:120])
    check("изображения баннеров загружены", all(p.eval_on_selector_all("a.hd-banner img", "els=>els.map(e=>e.complete&&e.naturalWidth>0)")))
    p.screenshot(path="/tmp/feat_home_desktop.png")
    # ---------- Читалка ----------
    p.click("a.hd-banner >> nth=1"); p.wait_for_url(re.compile(r".*reader\.html")); p.wait_for_selector("#page:not([hidden])", timeout=20000)
    check("читалка (RU): оригинальный PDF открыт, страниц 49", p.inner_text("#of") == "/ 49" and p.evaluate("document.body.dataset.bookLang") == "ru", p.inner_text("#of"))
    filled = p.evaluate("(()=>{const c=document.getElementById('page');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4000)if(d[i]+d[i+1]+d[i+2]>60)n++;return n})()")
    check("страница действительно отрисована (не пустой холст)", filled > 20, filled)
    p.click("#next"); p.wait_for_function("document.body.dataset.page==='2'"); check("«Вперёд» → страница 2", p.input_value("#num") == "2")
    p.fill("#num", "18"); p.press("#num", "Enter"); p.wait_for_function("document.body.dataset.page==='18'"); check("переход к странице 18", p.input_value("#num") == "18")
    w0 = p.evaluate("document.getElementById('page').getBoundingClientRect().width"); p.click("#zin"); p.wait_for_timeout(600)
    w1 = p.evaluate("document.getElementById('page').getBoundingClientRect().width"); check("масштаб «+» увеличивает страницу", w1 > w0 * 1.15, [w0, w1])
    p.click("#zfit"); p.wait_for_timeout(600); check("«По ширине» возвращает исходный масштаб", abs(p.evaluate("document.getElementById('page').getBoundingClientRect().width") - w0) < 2)
    p.wait_for_timeout(1000); p.reload(); p.wait_for_function("document.body.dataset.page==='18'", timeout=20000)
    check("после перезагрузки открылась последняя страница (18) — прогресс на сервере", p.input_value("#num") == "18")
    p.click("#back"); p.wait_for_url(re.compile(r".*academy\.html")); check("возврат в академию", "academy.html" in p.url)
    ctx.close()
    # ---------- Читалка на телефоне и на английском ----------
    ctx, p = new_page(b, 375, lang="en"); register(p, "mob@test.com"); access(p, "77700012")
    p.wait_for_selector("a.hd-banner"); boxes = p.eval_on_selector_all("a.hd-banner", "els=>els.map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})")
    check("телефон: баннеры одинакового размера, лента листается", boxes[0] == boxes[1] == boxes[2] and p.evaluate("(()=>{const r=document.getElementById('bannerRow');return r.scrollWidth>r.clientWidth})()"), boxes)
    check("телефон: плашка, заголовок и кнопка не перекрываются ни в одной карточке", all(p.evaluate("[...document.querySelectorAll('.hd-banner')].map(b=>{const r=x=>b.querySelector(x).getBoundingClientRect(),bb=b.getBoundingClientRect(),c=r('.hb-cat'),t=r('.hb-title'),a=r('.hb-cta');return c.bottom<=t.top+0.5&&t.bottom<=a.top+0.5&&a.bottom<=bb.bottom})")))
    check("EN: кнопки баннеров переведены", p.eval_on_selector_all("a.hd-banner .hb-cta", "e=>e.map(x=>x.textContent)") == ["My dashboard", "Read the book", "Read the story"])
    check("EN: заголовки 1-й и 3-й карточек на английском", p.eval_on_selector_all("a.hd-banner .hb-title", "e=>e.map(x=>x.textContent)") == ["INVITE & EARN", "THE HIDDEN REACTION SYSTEM", "THE STORY BEHIND HIDDEN DINOX"])
    # история основателя: открывается третьей карточкой
    p.click("a.hd-banner >> nth=2"); p.wait_for_url(re.compile(r".*story\.html")); p.wait_for_selector(".st-final")
    st = p.inner_text("#story")
    check("история (EN): заголовок, 6 глав, финал, слоган и оговорка", "THE STORY BEHIND" in p.inner_text("h1") and p.locator(".st-ch").count() == 6 and "Built by experience. Defined by discipline." in st and "not a promise of future earnings" in st and "$5,000" in st and "$300,000" in st)
    check("история (EN): без кириллицы и без горизонтальной прокрутки на телефоне", not re.search(r"[А-Яа-яЁёІіЇїЄєҐґ]", st) and p.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    check("история: изображения маскота загружены", p.evaluate("[...document.querySelectorAll('#story img')].every(i=>i.complete&&i.naturalWidth>0)") or (p.wait_for_timeout(1500) or p.evaluate("[...document.querySelectorAll('#story img')].every(i=>i.complete&&i.naturalWidth>0)")))
    p.click(".st-langs [data-lang=ua]"); p.wait_for_timeout(200)
    check("история (UA): переключение на украинский", "ІСТОРІЯ СТВОРЕННЯ" in p.inner_text("h1") and "Створений досвідом. Визначений дисципліною." in p.inner_text("#story"))
    p.click(".st-langs [data-lang=ru]"); p.wait_for_timeout(200)
    check("история (RU): утверждённый текст", "Я начинал с $5 000" in p.inner_text("#story") and "Создан опытом. Определён дисциплиной." in p.inner_text("#story"))
    p.screenshot(path="/tmp/feat_story_mobile.png", full_page=False)
    p.evaluate("localStorage.setItem('hd_lang','en')")
    p.screenshot(path="/tmp/feat_home_mobile.png")
    book_reqs = []; p.on("request", lambda r: book_reqs.append(r.url) if "/books/hidden-reaction-system/file" in r.url else None)
    p.goto(B + "/academy/reader.html"); p.wait_for_selector("#page:not([hidden])", timeout=20000)
    check("EN: читалка открыла английскую книгу (lang=en), 49 страниц", p.evaluate("document.body.dataset.bookLang") == "en" and any("lang=en" in u for u in book_reqs) and p.inner_text("#of") == "/ 49", [p.evaluate("document.body.dataset.bookLang"), book_reqs[:1]])
    check("телефон: нет горизонтальной прокрутки страницы", p.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    check("EN: интерфейс читалки на английском", p.inner_text("#zfit") == "Fit width" and "Academy" in p.inner_text("#back"))
    check("EN: нет пометки «только на русском» — перевод есть", p.locator("#rdLang").count() == 0)
    p.click("#next"); p.wait_for_function("document.body.dataset.page==='2'"); check("EN: перелистывание работает", p.input_value("#num") == "2")
    check("после открытия блок загрузки скрыт (не висит над страницей)", not p.is_visible("#msg"))
    over = p.evaluate("[...document.querySelectorAll('.rd-bar button, .rd-bar input')].filter(e=>{const r=e.getBoundingClientRect();return r.right>window.innerWidth+0.5||r.left<-0.5}).map(e=>e.id)")
    check("телефон: все кнопки нижней панели помещаются по ширине", over == [], over)
    check("телефон: страница книги не шире экрана при масштабе «по ширине»", p.evaluate("document.getElementById('page').getBoundingClientRect().right <= window.innerWidth"))
    p.screenshot(path="/tmp/feat_reader_mobile.png")
    ctx.close()
    # ---------- Защита PDF ----------
    check("PDF не доступен по прямому пути", status_of("/private/books/the-hidden-reaction-system-v1.0-ru.pdf") == 404 and status_of("/academy/../private/books/the-hidden-reaction-system-v1.0-ru.pdf") in (403, 404))
    check("PDF без входа → 401", status_of("/api/learn/books/hidden-reaction-system/file") == 401)
    ctx, p = new_page(b); register(p, "nodep@test.com")
    tok = "testtoken-nodep_test_com"
    check("PDF без доступа к академии → 403", status_of("/api/learn/books/hidden-reaction-system/file", {"Authorization": "Bearer " + tok}) == 403)
    ctx.close()
    # ---------- Реферальная цепочка ----------
    ctx, p = new_page(b); register(p, "partner@test.com"); access(p, "77700013")
    p.goto(B + "/academy/partner.html"); p.wait_for_selector("#lnk")
    link = p.input_value("#lnk"); code = link.split("ref=")[1]
    check("кабинет: персональная ссылка с кодом", re.fullmatch(r"[A-Z2-9]{8}", code) is not None, link)
    check("кабинет: тестовый режим явно обозначен", "Тестовый режим" in p.inner_text("#pt"))
    ctx2, q = new_page(b); register(q, "friend@test.com", start="/academy/?ref=" + code); q.wait_for_timeout(800); ctx2.close()
    p.reload(); p.wait_for_selector("#lnk")
    check("приглашённый виден у партнёра: 1, статус «Зарегистрирован», без email", "Зарегистрирован" in p.inner_text("#pt") and "friend" not in p.inner_text("#pt"), p.inner_text("#pt")[:300])
    bal_txt = p.inner_text("#pt")
    check("новый партнёр: баланс $0.00 по всем четырём строкам", bal_txt.count("$0.00") >= 4 and "Всего заработано" in bal_txt and "Всего выплачено" not in bal_txt or bal_txt.count("$0.00") >= 4, bal_txt[:300])
    check("кнопка «Вывести средства» есть, но недоступна при балансе ниже $50 — с причиной", p.is_disabled("#wopen") and "Вывод доступен от $50.00" in bal_txt)
    p.screenshot(path="/tmp/feat_partner.png", full_page=True)
    pctx, pp = ctx, p                                      # контекст партнёра оставляем открытым (тестовый вход живёт внутри контекста)
    # ---------- Админка: партнёры и баннер из CMS ----------
    ctx, p = new_page(b, 1280); register(p, "boss@test.com"); get("/test/role?uid=boss_test_com&role=super_admin")
    p.goto(B + "/admin/#/partners"); p.wait_for_selector("#pq"); p.fill("#pq", code); p.click("#pf .primary"); p.wait_for_selector("#pr a")
    check("админка: поиск партнёра по реферальному коду", "partner" in p.inner_text("#pr"))
    p.click("#pr a"); p.wait_for_selector("#pev"); check("карточка партнёра: приглашённый виден с email для администратора", "friend" in p.inner_text("#main"))
    partner_url = p.url
    p.fill("#aam", "60"); p.fill("#ars", "Тестовое начисление"); p.click("#adj .btn"); p.wait_for_function("document.getElementById('toast').textContent.includes('Подтвердите')")
    check("ручное начисление без подтверждения не проводится", True)
    p.check("#acf"); p.click("#adj .btn"); p.wait_for_function("document.getElementById('toast').textContent.includes('Операция записана')", timeout=8000)
    p.wait_for_selector("#pev"); check("начисление видно в журнале админки с причиной", "Тестовое начисление" in p.inner_text("#main"))
    # --- партнёр выводит средства (тестовый режим) ---
    pp.reload(); pp.wait_for_selector("#wopen:not([disabled])", timeout=8000)
    check("после начисления $60: доступно $60.00, кнопка вывода активна", "$60.00" in pp.inner_text("#pt"))
    pp.click("#wopen"); pp.wait_for_selector("#wf")
    form = pp.inner_text("#wf")
    check("форма вывода: уведомление о сроках (RU, дословно), полный Trader ID, доступно и остаток после резерва",
          "Обычно вывод средств обрабатывается в течение 24 часов. В отдельных случаях обработка может занять до 3 дней. После отправки заявки сумма будет зарезервирована до завершения обработки." in form
          and pp.locator("#wtid").count() == 1 and "$60.00" in form and "$10.00" in form, form)
    pp.fill("#amt", "49.99"); pp.click("#wbtn"); pp.wait_for_timeout(500)
    check("$49.99 — браузер не отправляет форму (минимум $50), заявка не создана", pp.evaluate("document.getElementById('amt').validity.rangeUnderflow") and "wd_" not in pp.inner_text("#pt"))
    pp.fill("#wtid", "77700099"); pp.fill("#amt", "50"); pp.click("#wbtn"); pp.wait_for_selector("#wback", timeout=8000)
    conf = pp.inner_text("#wf")
    check("шаг подтверждения: показаны сумма $50.00 и введённый Trader ID, заявка ещё не создана", "Проверьте сумму" in conf and "$50.00" in conf and "77700099" in conf and "wd_" not in pp.inner_text("#pt"), conf[:200])
    pp.click("#wbtn"); pp.wait_for_selector("#werr:not([hidden])", timeout=8000)
    check("вывод: чужой Trader ID отклонён, сумма не зарезервирована", "не совпадает" in pp.inner_text("#werr") and "$60.00" in pp.inner_text("#pt"), pp.inner_text("#werr"))
    pp.click("#wback"); pp.wait_for_selector("#wtid")
    check("«Изменить» возвращает к форме с прежней суммой", pp.input_value("#amt") == "50")
    pp.fill("#wtid", "77700013"); pp.click("#wbtn"); pp.wait_for_selector("#wback"); pp.click("#wbtn"); pp.wait_for_selector(".pt-ok[role=status]", timeout=8000)
    done_txt = pp.inner_text("#pt")
    check("заявка создана: сумма в резерве, уведомление о сроках показано снова", "создана" in done_txt and "$50.00" in done_txt and done_txt.count("Обычно вывод средств обрабатывается") >= 1)
    check("история выплат: ID заявки, полный Trader ID, статус «Ожидает»", re.search(r"wd_[a-f0-9]{24}", done_txt) is not None and "77700013" in done_txt and "Ожидает" in done_txt)
    # --- администратор: в обработку → подтверждение выплаты ---
    p.goto(partner_url); p.reload(); p.wait_for_selector("[data-ws=processing]")
    check("админка: заявка с полным Trader ID", "77700013" in p.inner_text("#main"))
    p.click("[data-ws=processing]"); p.wait_for_selector("[data-ws=paid]", timeout=8000)
    p.click("[data-ws=paid]"); p.fill("#pref", "PP-TRANSFER-1"); p.click("#modalBody .mf .primary"); p.wait_for_function("document.getElementById('toast').classList.contains('bad')")
    check("«Подтвердить выплату» без галочки не проходит", True)
    p.check("#pcf"); p.click("#modalBody .mf .primary"); p.wait_for_function("document.getElementById('toast').textContent.includes('Выплата отмечена')", timeout=8000)
    pp.reload(); pp.wait_for_selector(".pt-table")
    fin = pp.inner_text("#pt")
    check("партнёр видит «Выплачено» и дату выплаты; всего выплачено $50.00", "Выплачено" in fin and fin.count("$50.00") >= 2 and re.search(r"\d{2}\.\d{2}\.\d{4}", fin) is not None, fin[:500])
    pctx.close()
    p.goto(B + "/admin/#/announcements"); p.wait_for_selector("#na"); p.click("#na")
    p.select_option("#modalBody [name=kind]", "banner"); p.fill("#modalBody [name=title]", "Новый курс скоро")
    p.fill("#modalBody [name=title_i18n_ru]", "НОВЫЙ КУРС"); p.fill("#modalBody [name=cta_i18n_ru]", "Узнать"); p.select_option("#modalBody [name=action_type]", "soon")
    p.select_option("#modalBody [name=image_builtin]", "mascot"); p.select_option("#modalBody [name=status]", "published"); p.check("#modalBody [name=confirm]")
    check("админка: живой предпросмотр баннера", "НОВЫЙ КУРС" in p.inner_text("#annpv") and "Скоро" in p.inner_text("#annpv"))
    p.click("#modalBody .mf .primary"); p.wait_for_function("document.getElementById('toast').textContent.includes('Афиша сохранена')", timeout=10000)
    p.wait_for_function("document.getElementById('al') && document.getElementById('al').textContent.includes('Новый курс скоро')", timeout=10000)   # запись реально в списке
    ctx.close()
    ctx, p = new_page(b, 1280); register(p, "viewer@test.com"); access(p, "77700014"); p.wait_for_selector(".hd-banner")
    cards = p.eval_on_selector_all(".hd-banner", "els=>els.map(e=>[e.tagName,e.querySelector('.hb-title').textContent,e.querySelector('.hb-cta').textContent])")
    check("главная: новый баннер добавился, стандартные НЕ пропали; порядок INVITE → книга → новые; «Скоро» без ссылки",
          cards == [["A", "ПРИГЛАШАЙ И ЗАРАБАТЫВАЙ", "Мой кабинет"], ["A", "THE HIDDEN REACTION SYSTEM", "Читать книгу"], ["A", "ИСТОРИЯ СОЗДАНИЯ HIDDEN DINOX", "Читать историю"], ["DIV", "НОВЫЙ КУРС", "Скоро"]], cards)
    ctx.close()
    # ---------- Партнёрские ссылки Pocket Partners ----------
    PP = "https://u3.shortink.io/register?utm_campaign=836358&utm_source=affiliate&utm_medium=sr&a=STREAMER123&al=1805745&ac=stream&cid=1&code=XYZ"
    ctx, p = new_page(b, 1280); register(p, "linkadmin@test.com"); get("/test/role?uid=linkadmin_test_com&role=admin")
    p.goto(B + "/admin/#/links"); p.wait_for_selector("#nl"); p.click("#nl")
    p.fill("#lname", "Стример 123"); p.fill("#lcode", "streamer123"); p.fill("#lurl", PP); p.click("#modalBody .mf .primary")
    p.wait_for_selector("[data-edit=streamer123]", timeout=8000)
    check("админка: партнёр создан, видны обе ссылки", "/academy/?via=streamer123" in p.inner_text("#ll") and "a=STREAMER123" in p.inner_text("#ll"))
    ctx.close()
    ctx, p = new_page(b); register(p, "fan@test.com", start="/academy/?via=streamer123"); p.wait_for_selector("#pocketBtn")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0")
    opened = p.evaluate("window.__opened")[0]
    check("пришёл по ?via=: кнопка брокера открывает ссылку партнёра целиком + click_id", opened.startswith(PP + "&click_id="), opened)
    ctx.close()
    ctx, p = new_page(b); register(p, "plainuser@test.com"); p.wait_for_selector("#pocketBtn")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); opened = p.evaluate("window.__opened")[0]
    check("без партнёра — основная ссылка академии", "a=h9nxhW8rfWngjm" in opened and "STREAMER123" not in opened and "click_id=" in opened, opened)
    ctx.close(); b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
