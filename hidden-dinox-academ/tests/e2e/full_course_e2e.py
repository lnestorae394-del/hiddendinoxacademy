"""Полный путь по курсу Hidden Reaction в браузере (Playwright):
администратор импортирует курс → «все уроки готовы» → публикация; ученик с доступом проходит ВСЕ уроки по порядку
(тест → завершение → следующий урок), с перезагрузкой страницы в середине. Сервер — настоящие обработчики академии
на тестовой Firestore (с ограничениями настоящего Firestore). Запуск: python3 tests/e2e/full_course_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8794"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
COURSE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
LESSONS = [l for m in COURSE["modules"] for l in m["lessons"]]
results, js_errors = [], []
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def new_page(b, w, h=860, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": h})
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.click("[data-go=register]"); p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn")
    p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
def toast(p):
    p.wait_for_function("(()=>{const t=document.getElementById('toast');return t&&t.classList.contains('show')&&t.textContent})()", timeout=10000)
    t = p.inner_text("#toast"); p.evaluate("(()=>{const t=document.getElementById('toast');t.className='toast';t.textContent=''})()"); return t
n_charts = lambda l: sum(1 for b in l["blocks"] if b["type"] == "chart" or (b["type"] != "chart" and b.get("chart")))

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ---------- Администратор: импорт → все готовы → публикация ----------
    ctx, p = new_page(b, 1280)
    register(p, "owner@test.com"); get("/test/role?uid=owner_test_com&role=super_admin")
    p.goto(B + "/admin/#/import"); p.wait_for_selector("#if")
    p.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json")); p.wait_for_selector("#ib:not([disabled])")
    p.check("#ic"); p.click("#ib"); t = toast(p)
    check("импорт курса: 6 модулей, 29 уроков", "модулей 6, уроков 29" in t, t)
    p.wait_for_selector(".mod")
    check("после импорта: уроки в модулях 4/6/7/5/3/4, пустых модулей нет", p.eval_on_selector_all(".mod", "e=>e.map(x=>x.querySelectorAll('.les a').length)") == [4, 6, 7, 5, 3, 4])
    p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); t = toast(p)
    check("публикация, пока уроки черновые, отклоняется", "Нет уроков" in t or "готов" in t.lower(), t)
    p.keyboard.press("Escape")
    p.click("#readyall"); p.click("#modalBody .mf .primary"); t = toast(p)
    check("«все уроки готовы» без галочки не выполняется", "Подтвердите" in t, t)
    p.check("#rac"); p.click("#modalBody .mf .primary"); t = toast(p)
    check("все 29 уроков отмечены готовыми", "29 из 29" in t, t)
    p.wait_for_selector("#pub"); p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); t = toast(p)
    check("полный курс опубликован: 29 уроков", "Опубликовано уроков: 29" in t, t)
    ctx.close()

    # ---------- Ученик с подтверждённым депозитом, телефон ----------
    ctx, p = new_page(b, 375)
    register(p, "learner@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id="88800077")
    p.fill("#traderId", "88800077"); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id="88800077", amount="60", currency="USD")
    p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    p.wait_for_selector("#learnPanel:not([hidden]) a.course-card", timeout=8000)
    check("академия: курс виден, 0/29", "0/29" in p.inner_text("#learnList"), p.inner_text("#learnList"))
    p.click("a.course-card"); p.wait_for_selector(".lp-mod")
    check("страница курса: 6 модулей, 29 уроков", p.locator(".lp-mod").count() == 6 and p.locator(".lp-les").count() == 29)
    p.click("text=Начать обучение")
    leaks, chart_ok, done = [], [], 0
    pending = None
    for i, src in enumerate(LESSONS):
        if pending is not None: body, pending = pending, None          # урок уже открыт кнопкой «Продолжить»
        else:
            with p.expect_response(re.compile(r".*/api/learn/lessons/[^/]+$")) as resp:
                if i > 0: p.click("text=Следующий урок")
            body = resp.value.json()
        p.wait_for_selector(".hdl-quiz", timeout=8000)
        if p.inner_text("#lp h1") != src["title"]: check(f"урок {i+1}: порядок", False, [p.inner_text("#lp h1"), src["title"]]); break
        qfields = {k for bl in body["lesson"]["blocks"] if bl.get("type") == "quiz" for q in bl["questions"] for k in q}
        if qfields & {"correct", "explanation"}: leaks.append(src["title"])
        chart_ok.append(p.locator("#body svg").count() >= n_charts(src))
        qs = [q for bl in src["blocks"] if bl["type"] == "quiz" for q in bl["questions"]]
        for qi, q in enumerate(qs): p.locator(".hdl-q").nth(qi).locator(f"input[value='{q['correct']}']").check()
        p.click("[data-quiz-submit]"); p.wait_for_selector(".hdl-quiz-total:not([hidden])")
        if "тест пройден" not in p.inner_text(".hdl-quiz-total"): check(f"урок {i+1}: тест", False, p.inner_text(".hdl-quiz-total")); break
        p.wait_for_selector("#doneWrap .lp-done", timeout=8000); done += 1          # успешный тест завершает урок сам
        if i == 9:   # перезагрузка посреди курса
            p.reload(); p.wait_for_selector(".lp-done", timeout=8000)
            check("после перезагрузки урок 10 остаётся пройденным", "Урок пройден" in p.inner_text("#doneWrap"))
            p.goto(B + "/academy/learn.html#/"); p.wait_for_selector(".lp-card")
            check("список курсов после перезагрузки: пройдено 10 из 29", "10 из 29" in p.inner_text(".lp-card"), p.inner_text(".lp-card"))
            p.click(".lp-card"); p.wait_for_selector(".lp-mod")
            nxt = p.get_attribute(".lp .lp-btn.primary", "href")
            check("«Продолжить» ведёт к уроку 11", "Продолжить" in p.inner_text(".lp .lp-btn.primary"), p.inner_text(".lp"))
            with p.expect_response(re.compile(r".*/api/learn/lessons/[^/]+$")) as resp: p.click(".lp .lp-btn.primary")
            pending = resp.value.json(); p.wait_for_selector(".hdl-quiz")
            check("открыт урок 11 — " + LESSONS[10]["title"], p.inner_text("#lp h1") == LESSONS[10]["title"], p.inner_text("#lp h1"))
    check(f"пройдено уроков подряд: {done} из {len(LESSONS)}", done == len(LESSONS))
    check("правильные ответы не приходили до попытки ни в одном уроке", not leaks, leaks)
    check("графики на месте во всех уроках (25 графиков)", all(chart_ok) and len(chart_ok) == len(LESSONS), chart_ok)
    check("последний урок: кнопки «Следующий урок» нет", p.locator("text=Следующий урок").count() == 0)
    p.goto(B + "/academy/learn.html#/"); p.wait_for_selector(".lp-card"); p.click(".lp-card"); p.wait_for_selector(".lp-mod")
    check("страница курса: «КУРС ЗАВЕРШЁН», 29 из 29, 6 из 6 модулей, кнопка «Посмотреть результаты»", "КУРС ЗАВЕРШЁН" in p.inner_text(".lp") and "Пройдено 29 из 29 уроков" in p.inner_text(".lp") and "Завершено модулей: 6 из 6" in p.inner_text(".lp") and "Посмотреть результаты" in p.inner_text(".lp"), p.inner_text(".lp")[:300])
    p.goto(B + "/academy/academy.html"); p.wait_for_selector("a.course-card")
    check("академия: 29/29, 100%", "29/29" in p.inner_text("#learnList") and "100%" in p.inner_text("#learnList"), p.inner_text("#learnList"))
    p.screenshot(path="/tmp/full_course_done.png", full_page=True)
    ctx.close()
    # ---------- Курс на английском и украинском ----------
    L0 = LESSONS[0]; Q0 = [q for bl in L0["blocks"] if bl["type"] == "quiz" for q in bl["questions"]]
    for lang, mod1, title1, check_btn, expl, done_btn in (
        ("en", "Foundations of the Hidden Reaction system", "The market is not chaos: the idea of the system", "Check answers", "P. 3", "Mark lesson as completed"),
        ("ua", "Основи системи Hidden Reaction", "Ринок — не хаос: ідея системи", "Перевірити відповіді", "Стор. 3", "Позначити урок пройденим")):
        ctx, p = new_page(b, 375, lang=lang); register(p, f"learner_{lang}@test.com"); p.wait_for_selector("#idForm")
        p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
        tid = "8880009" + ("1" if lang == "en" else "2")
        postback(type="registration", click_id=click, trader_id=tid); p.fill("#traderId", tid); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
        postback(type="ftd", click_id=click, trader_id=tid, amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
        p.wait_for_selector("a.course-card"); p.click("a.course-card"); p.wait_for_selector(".lp-mod")
        check(f"{lang.upper()}: модули курса переведены", mod1 in p.inner_text(".lp-mod h2"), p.inner_text(".lp-mod h2"))
        p.click(".lp .lp-btn.primary"); p.wait_for_selector(".hdl-quiz")
        check(f"{lang.upper()}: урок переведён, без пометки о неполном переводе", p.inner_text("#lp h1") == title1 and p.locator(".lp-trnote").count() == 0, p.inner_text("#lp h1"))
        check(f"{lang.upper()}: кнопки и метки урока переведены", p.inner_text("[data-quiz-submit]") == check_btn and done_btn in p.inner_text("#doneWrap"))
        for qi, q in enumerate(Q0): p.locator(".hdl-q").nth(qi).locator(f"input[value='{(q['correct'] + 1) % len(q['options'])}']").check()
        p.click("[data-quiz-submit]"); p.wait_for_selector(".hdl-quiz-total:not([hidden])")
        check(f"{lang.upper()}: объяснение ошибки на выбранном языке", expl in p.inner_text(".hdl-quiz"), p.inner_text(".hdl-quiz")[:200])
        if lang == "en": check("EN: на странице урока нет кириллицы", re.search(r"[А-Яа-яЁё]", p.inner_text("#lp")) is None, re.findall(r"[А-Яа-яЁё]+", p.inner_text("#lp"))[:5])
        ctx.close()

    # ---------- Ученик без доступа ----------
    ctx, p = new_page(b, 375); register(p, "nodep@test.com")
    p.goto(B + "/academy/learn.html"); p.wait_for_timeout(1500)
    check("без депозита курс недоступен", "learn.html" not in p.url, p.url); ctx.close()
    b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5])
print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
