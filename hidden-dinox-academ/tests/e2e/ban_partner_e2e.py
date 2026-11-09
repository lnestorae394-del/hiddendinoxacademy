"""Блокировка аккаунта (админка → страница «аккаунт не активен» → прямые URL → разблокировка), мобильный кабинет партнёра
(ID без посимвольного переноса, карточки, без переполнения), отклонение с причиной на UA, отсутствие ключей локализации,
экран итогов незавершённого курса. Запуск: python3 tests/e2e/ban_partner_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8794"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
COURSE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
results, js_errors = [], []
KEY_RE = re.compile(r"\b(?:pt|cg|prog|learn|st|dep|reg)[A-Z][A-Za-z_]{2,}\b")
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:500]}"))
def ctx_page(b, w, lang=None, state=None):
    c = b.new_context(viewport={"width": w, "height": 860}, **({"storage_state": state} if state else {}))
    c.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    c.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    c.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};" + (f"localStorage.setItem('hd_lang','{lang}');" if lang else ""))
    p = c.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return c, p
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=10000)
def give_access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id=trader); p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id=trader, amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
def goto_follow(p, url, pattern):                       # страница может сама перейти на blocked.html во время загрузки
    try: p.goto(url)
    except Exception: pass
    for _ in range(60):                                  # ждём итоговый адрес, не реагируя на прерванные промежуточные переходы
        if re.search(pattern, p.url): break
        p.wait_for_timeout(200)
    try: p.wait_for_load_state("load")
    except Exception: pass
def keys_in(p): return sorted(set(KEY_RE.findall(p.evaluate("document.body.innerText"))))
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT, "REFERRAL_MODE": "test", "REFERRAL_PAYOUTS_ENABLED": "1"}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    ac, ap = ctx_page(b, 1280); register(ap, "boss@test.com"); get("/test/role?uid=boss_test_com&role=super_admin")
    ap.goto(B + "/admin/#/import"); ap.wait_for_selector("#if"); ap.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json"))
    ap.wait_for_selector("#ib:not([disabled])"); ap.check("#ic"); ap.click("#ib"); ap.wait_for_selector("#readyall", timeout=20000)
    ap.click("#readyall"); ap.check("#rac"); ap.click("#modalBody .mf .primary"); ap.wait_for_selector("#pub"); ap.wait_for_timeout(400)
    ap.click("#pub"); ap.check("#cf"); ap.click("#modalBody .mf .primary"); ap.wait_for_selector(".pill.ok", timeout=20000)
    # ---------- ученик: частичный прогресс, экран итогов незавершённого курса ----------
    sc, sp = ctx_page(b, 390, "ru"); register(sp, "stud@test.com"); give_access(sp, "88920001")
    sp.goto(B + "/academy/learn.html#/"); sp.wait_for_selector(".lp-card"); sp.click(".lp-card"); sp.wait_for_selector(".lp-les")
    ids = [h.split("/lesson/")[1] for h in sp.eval_on_selector_all(".lp-les", "els=>els.map(e=>e.getAttribute('href'))")]
    cid = sp.evaluate("location.hash").split("/course/")[1]
    sp.evaluate("async ([id, a]) => { await call('POST', `/api/learn/lessons/${id}/quiz`, { answers: a }); }", [ids[0], [q["correct"] for bl in COURSE["modules"][0]["lessons"][0]["blocks"] if bl["type"] == "quiz" for q in bl["questions"]]])
    for lang, badge, nxt in (("ru", "КУРС В ПРОЦЕССЕ", "Продолжить"), ("en", "COURSE IN PROGRESS", "Continue"), ("ua", "КУРС У ПРОЦЕСІ", "Продовжити")):
        if "#/done/" not in sp.url: sp.goto(B + "/academy/learn.html#/done/" + cid); sp.wait_for_selector(".cg")
        sp.click(f".hd-langs [data-lang={lang}]"); sp.wait_for_function("(b)=>document.querySelector('.cg .cg-badge') && document.querySelector('.cg .cg-badge').textContent===b", arg=badge, timeout=8000)
        cg = sp.inner_text(".cg")
        check(f"итоги незавершённого курса ({lang.upper()}): реальный прогресс 1 / 29, следующий шаг, без «поздравляем»", badge in cg and "1 / 29" in cg and nxt in cg and "ПОЗДРАВЛЯЕМ" not in cg and "CONGRATULATIONS" not in cg, cg[:200])
    sp.click(".hd-langs [data-lang=ru]")
    # ---------- блокировка в админке ----------
    ap.goto(B + "/admin/#/bans"); ap.wait_for_selector("#buid"); ap.fill("#buid", "stud_test_com"); ap.click("#bf .btn"); ap.wait_for_selector("#bblk")
    ap.fill("#brsn", "Тест: внутренняя причина"); ap.click("#bblk"); ap.wait_for_function("document.getElementById('toast').textContent.includes('Укажите причину')")
    ap.check("#bcf"); ap.click("#bblk"); ap.wait_for_selector("#bun", timeout=8000)
    info = ap.inner_text("#bres")
    check("админка: статус «заблокирован», дата, администратор, внутренняя причина", "заблокирован" in info and "boss_test_com" in info and "Тест: внутренняя причина" in info and re.search(r"\d{2}\.\d{2}\.\d{4}", info), info)
    goto_follow(sp, B + "/academy/academy.html", r".*blocked\.html"); sp.wait_for_selector("#blT")
    txt = sp.inner_text("main")
    check("RU: после обновления — «Ваш аккаунт не активен», без внутренней причины", "Ваш аккаунт не активен" in txt and "Доступ к академии для этого аккаунта приостановлен" in txt and "внутренняя причина" not in txt and "Тест:" not in txt)
    check("кнопка поддержки → https://t.me/hiddendinoxsupport (новая вкладка)", sp.get_attribute("#blSupport", "href") == "https://t.me/hiddendinoxsupport" and sp.get_attribute("#blSupport", "target") == "_blank")
    for lang, title, sup, new in (("en", "Your account is inactive", "Contact Support", "Create a New Account"), ("ua", "Ваш акаунт неактивний", "Звернутися до підтримки", "Створити новий акаунт")):
        sp.click(f".hd-langs [data-lang={lang}]")
        check(f"{lang.upper()}: текст и кнопки страницы блокировки", sp.inner_text("#blT") == title and sp.inner_text("#blSupport") == sup and sp.inner_text("#blNew") == new)
    sp.click(".hd-langs [data-lang=ru]")
    goto_follow(sp, B + "/academy/learn.html#/lesson/" + ids[1], r".*blocked\.html")
    check("прямой URL урока → страница блокировки", "blocked.html" in sp.url)
    st = sp.evaluate("call('GET','/api/learn/courses').then(()=>200).catch(e=>e.code)")
    check("API академии со старой сессией → ACCOUNT_BLOCKED (сервер)", st == "ACCOUNT_BLOCKED", st)
    # ---------- разблокировка ----------
    ap.click("#bun"); ap.wait_for_selector("#bblk", timeout=8000)
    sp.goto(B + "/academy/academy.html"); sp.wait_for_function("document.querySelector('.p-progress') && document.querySelector('.p-progress').innerText.includes('Пройдено 1 из 29')", timeout=12000)
    check("после разблокировки: доступ и прогресс на месте (1 из 29)", "academy.html" in sp.url)
    # ---------- «Создать новый аккаунт»: выход и экран регистрации ----------
    ap.click("#brsn") if False else None
    ap.fill("#brsn", "повторная проверка"); ap.check("#bcf"); ap.click("#bblk"); ap.wait_for_selector("#bun", timeout=8000)
    goto_follow(sp, B + "/academy/academy.html", r".*blocked\.html"); sp.wait_for_selector("#blNew")
    sp.click("#blNew"); sp.wait_for_url(re.compile(r"^https?://[^/]+/(academy/index\.html)?#register$"), timeout=10000)   # регистрация — «/#register»; sp.wait_for_selector("#regBtn", timeout=8000)
    check("«Создать новый аккаунт» → выход и существующий экран регистрации", sp.locator("#password2").count() == 1)
    ap.click("#bun"); ap.wait_for_selector("#bblk", timeout=8000); sc.close()
    # ---------- кабинет партнёра: данные с длинными ID ----------
    pc, pp = ctx_page(b, 390, "ru"); register(pp, "partner@test.com"); give_access(pp, "88920100")
    ap.goto(B + "/admin/#/partners/partner_test_com"); ap.reload(); ap.wait_for_selector("#adj")
    for i, amt in enumerate(("120", "5")):
        ap.fill("#aam", amt); ap.fill("#ars", f"Тестовое начисление {i}"); ap.check("#acf"); ap.click("#adj .btn"); ap.wait_for_function("document.getElementById('toast').textContent.includes('Операция записана')", timeout=8000); ap.wait_for_selector("#adj")
    pp.evaluate("async () => { for (const r of ['req-ban-e2e-1','req-ban-e2e-2']) await call('POST','/api/referral/withdrawals',{ amount: 50, trader_id: '88920100', request_id: r }); }")
    ap.reload(); ap.wait_for_selector("[data-ws=rejected]")
    ap.locator("[data-ws=rejected]").first.click(); ap.wait_for_selector("#rsn")
    ap.fill("#rsn", "Заявка отклонена: тестовая причина для проверки."); ap.fill("#rsnEn", "Request rejected: a test reason."); ap.fill("#rsnUa", "Заявку відхилено: тестова причина.")
    ap.click("#modalBody .mf .danger, #modalBody .mf .primary"); ap.wait_for_function("document.getElementById('toast').textContent.length>0", timeout=8000)
    pp.goto(B + "/academy/partner.html"); pp.wait_for_selector(".pt-table")
    t_ru = pp.inner_text("#pt")
    check("причина отказа (RU) внутри заявки; верхнего уведомления нет", "Заявка отклонена: тестовая причина" in t_ru and t_ru.count("тестовая причина") == 1 and pp.locator(".pt-reason").count() == 1)
    pp.click(".langs [data-lang=ua]"); pp.wait_for_timeout(300)
    t_ua = pp.inner_text("#pt")
    check("причина отказа (UA) — на украинском, без русского текста", "Заявку відхилено: тестова причина." in t_ua and "тестовая причина" not in t_ua, t_ua[-400:])
    pp.click(".langs [data-lang=en]"); pp.wait_for_timeout(300)
    check("причина отказа (EN)", "Request rejected: a test reason." in pp.inner_text("#pt"))
    bal = pp.inner_text("#pt")
    check("отклонение вернуло резерв: доступно $75.00, в резерве $50.00", "$75.00" in bal and "$50.00" in bal, bal[:300])
    # ---------- мобильная вёрстка таблиц ----------
    state = pc.storage_state(); probs = []
    for w in (320, 360, 375, 390, 430, 1280):
        for lang in ("ru", "en", "ua"):
            c, q = ctx_page(b, w, lang, state); q.goto(B + "/academy/partner.html"); q.wait_for_selector(".pt-table")
            r = q.evaluate("""() => { const vw = innerWidth, bad = [];
              if (document.documentElement.scrollWidth > vw + 1) bad.push('страница шире экрана ' + document.documentElement.scrollWidth);
              for (const e of document.querySelectorAll('.pt-id')) { const h = e.getBoundingClientRect().height, lh = parseFloat(getComputedStyle(e).lineHeight) || 18; if (h > lh * 1.6) bad.push('ID в несколько строк: ' + e.textContent + ' h=' + h); }
              for (const e of document.querySelectorAll('.pt-table tr')) { const x = e.getBoundingClientRect(); if (x.right > vw + 1) bad.push('строка за экраном'); if (x.height > 420) bad.push('слишком высокая строка ' + Math.round(x.height)); }
              const ids = [...document.querySelectorAll('.pt-id')].map(e => e.textContent); if (ids.some(x => x.length > 15)) bad.push('ID не сокращён: ' + ids.find(x => x.length > 15));
              const head = getComputedStyle(document.querySelector('.pt-table thead')).display; if (vw <= 640 && head !== 'none') bad.push('на телефоне таблица, а не карточки'); if (vw > 640 && head === 'none') bad.push('на компьютере нет таблицы');
              return bad; }""")
            k = keys_in(q)
            if k: r.append("ключи: " + ",".join(k))
            if w == 375 and lang == "ua":
                q.locator(".pt-card").filter(has_text="Trader ID").last.screenshot(path="/tmp/partner_wd_375_ua.png")
                q.locator(".pt-card").nth(3).screenshot(path="/tmp/partner_acc_375_ua.png")
            if r: probs.append((w, lang, r[:3]))
            c.close()
    check("кабинет: 6 ширин × 3 языка — ID в одну строку и сокращены, карточки на телефоне, таблица на компьютере, без переполнения, без ключей", not probs, probs[:5])
    pp.click("[data-copy-id]") if False else None
    check("полный ID доступен: подсказка и кнопка копирования", pp.locator("[data-copy-id]").count() >= 2 and len(pp.get_attribute(".pt-id", "title")) > 15)
    # ---------- ключи на других страницах ----------
    leaks = []
    for page in ("academy.html", "learn.html#/", "story.html", "reader.html"):
        for lang in ("ru", "en", "ua"):
            pp.evaluate(f"localStorage.setItem('hd_lang','{lang}')"); pp.goto(B + "/academy/" + page); pp.wait_for_timeout(1500)
            k = keys_in(pp)
            if k: leaks.append((page, lang, k))
    check("главная, обучение, история, читалка (RU/EN/UA) — без технических ключей", not leaks, leaks)
    pc.close(); ac.close(); b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
