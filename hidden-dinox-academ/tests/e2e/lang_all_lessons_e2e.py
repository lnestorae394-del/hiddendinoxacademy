"""Все 29 уроков и 96 вопросов на выбранном языке — в браузере, по фактическому интерфейсу.
Запуск: python3 tests/e2e/lang_all_lessons_e2e.py en|ua|ru
Для каждого урока сверяется с переводами курса (content/hidden-reaction-course.json, поле tr): заголовок урока, текст каждого вопроса
и каждого варианта ответа, объяснения после ответа; для EN — ни одной кириллической буквы на странице урока."""
import os, re, sys, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
LANG = sys.argv[1] if len(sys.argv) > 1 else "en"
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", {"en": "8781", "ua": "8782", "ru": "8783"}[LANG]); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
COURSE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
LESSONS = [l for m in COURSE["modules"] for l in m["lessons"]]
def tr(l, key, ru):
    if LANG == "ru": return ru
    return ((l.get("tr") or {}).get(LANG) or {}).get(key, None)
results, js_errors, fails = [], [], []
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:400]}"))
def new_page(b, w, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": 900})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};" + (f"localStorage.setItem('hd_lang','{lang}');" if lang else ""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=10000)
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx, p = new_page(b, 1280); register(p, "owner@test.com"); get("/test/role?uid=owner_test_com&role=super_admin")
    p.goto(B + "/admin/#/import"); p.wait_for_selector("#if"); p.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json"))
    p.wait_for_selector("#ib:not([disabled])"); p.check("#ic"); p.click("#ib"); p.wait_for_selector("#readyall", timeout=20000)
    p.click("#readyall"); p.check("#rac"); p.click("#modalBody .mf .primary"); p.wait_for_selector("#pub"); p.wait_for_timeout(400)
    p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); p.wait_for_selector(".pill.ok", timeout=20000); ctx.close()
    ctx, p = new_page(b, 390, LANG); register(p, f"lang_{LANG}@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    tid = {"en": "88870001", "ua": "88870002", "ru": "88870003"}[LANG]
    postback(type="registration", click_id=click, trader_id=tid); p.fill("#traderId", tid); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id=tid, amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    p.wait_for_selector("a.course-card"); p.click("a.course-card"); p.wait_for_selector(".lp-mod")
    ids = [h.split("/lesson/")[1] for h in p.eval_on_selector_all(".lp-les", "els=>els.map(e=>e.getAttribute('href'))")]
    check(f"{LANG.upper()}: в курсе 29 уроков", len(ids) == 29, len(ids))
    nq = 0; nopt = 0; nexp = 0
    prev = None
    for i, (lid, L) in enumerate(zip(ids, LESSONS)):
        # переход по #… не перезагружает страницу: ждём ответ сервера по ЭТОМУ уроку и смену заголовка
        with p.expect_response(lambda r: f"/api/learn/lessons/{lid}?" in r.url, timeout=10000):
            p.goto(B + "/academy/learn.html#/lesson/" + lid)
        p.wait_for_function("(t)=>{const h=document.querySelector('#lp h1');return h&&h.textContent!==t&&document.querySelector('.hdl-quiz')}", arg=prev, timeout=10000)
        prev = p.inner_text("#lp h1")
        h1 = p.inner_text("#lp h1"); want = tr(L, "title", L["title"])
        if h1 != want: fails.append((i + 1, "title", h1, want)); continue
        if p.locator(".lp-trnote").count(): fails.append((i + 1, "пометка о неполном переводе", "", ""))
        quiz_text = p.inner_text(".hdl-quiz")
        qb = [(bi, bl) for bi, bl in enumerate(L["blocks"]) if bl["type"] == "quiz"]
        answers = []
        for bi, bl in qb:
            for qi, q in enumerate(bl["questions"]):
                wq = tr(L, f"blocks/{bi}/questions/{qi}/q", q["q"]); nq += 1
                if wq is None or wq not in quiz_text: fails.append((i + 1, f"вопрос {qi + 1}", wq, ""))
                for oi, o in enumerate(q["options"]):
                    wo = tr(L, f"blocks/{bi}/questions/{qi}/options/{oi}", o); nopt += 1
                    if wo is None and not re.search(r"[A-Za-zА-Яа-яІіЇїЄє]", o): wo = o            # варианты из одних цифр не переводятся
                    if wo is None or wo not in quiz_text: fails.append((i + 1, f"вопрос {qi + 1} вариант {oi + 1}", wo, ""))
                answers.append((q["correct"] + 1) % len(q["options"]))
        for qi, a in enumerate(answers): p.locator(".hdl-q").nth(qi).locator(f"input[value='{a}']").check()
        p.click("[data-quiz-submit]"); p.wait_for_selector(".hdl-quiz-total:not([hidden])")
        after = p.inner_text(".hdl-quiz")
        for bi, bl in qb:
            for qi, q in enumerate(bl["questions"]):
                we = tr(L, f"blocks/{bi}/questions/{qi}/explanation", q["explanation"]); nexp += 1
                if we is None or we not in after: fails.append((i + 1, f"объяснение {qi + 1}", we, after[:120]))
        if LANG == "en":
            cyr = re.findall(r"[А-Яа-яЁёІіЇїЄєҐґ]+", p.inner_text("#lp"))
            if cyr: fails.append((i + 1, "кириллица на странице", cyr[:5], ""))
    check(f"{LANG.upper()}: все 29 уроков — заголовки, вопросы ({nq}), варианты ({nopt}), объяснения ({nexp}) на выбранном языке", not fails and nq == 96 and nexp == 96, fails[:6])
    p.reload(); p.wait_for_selector(".hdl-quiz")
    check(f"{LANG.upper()}: после обновления страницы язык сохраняется", p.inner_text("#lp h1") == tr(LESSONS[-1], "title", LESSONS[-1]["title"]))
    ctx.close(); b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
