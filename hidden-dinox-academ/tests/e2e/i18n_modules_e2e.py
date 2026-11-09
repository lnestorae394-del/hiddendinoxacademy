"""Языки модулей: карточки, Ежедневные тесты, Тренировка на графике, Подготовка — без смешения языков (RU/EN/UA).
Запуск: python3 tests/e2e/i18n_modules_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8814"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:400]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
def new_ctx(b, lang=None, state=None, w=1280):
    ctx = b.new_context(viewport={"width": w, "height": 900}, **({"storage_state": state} if state else {}))
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
CYR = re.compile(r"[А-Яа-яЁёІіЇїЄєҐґ]")
EN_UI = re.compile(r"\b(AI Mentor|Daily Tests|Chart Training|Pre-Trade|Routine|Training|History|Today|Completed|Open|Start|Review|Next|Score|Submit|Skip|Correct|Incorrect|Explanation|Loading|Error|Back|Retry|Simulation|Hypothesis|Summary)\b")
RU_ONLY = re.compile(r"[ЫыЭэЪъЁё]")
def texts(p, sel="body"): return p.evaluate(f"(document.title+'\\n'+document.querySelector('{sel}').innerText)")
def lang_ok(lang, t):
    if lang == "en": return not CYR.search(t), CYR.findall(t)[:10]
    bad = EN_UI.findall(t)
    if lang == "ua": bad += RU_ONLY.findall(t)
    return not bad, bad[:10]

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); ap.goto(B + "/"); ap.wait_for_selector("#loginForm"); ap.click("[data-go=register]")
    ap.fill("#email", "owner@test.com"); ap.fill("#password", "password1"); ap.fill("#password2", "password1"); ap.click("#regBtn"); ap.wait_for_url(re.compile(r".*broker\.html")); actx.close()
    get("/test/role?uid=owner_test_com&role=admin")
    admin("POST", "/daily/bank/import", {"confirm": True}); admin("POST", "/daily/run", {})
    for f in ("daily_tests", "chart_training", "pre_trade"): admin("POST", f"/features/{f}/status", {"status": "ACTIVE"})
    sctx, sp = new_ctx(b); sp.goto(B + "/"); sp.wait_for_selector("#loginForm"); sp.click("[data-go=register]")
    sp.fill("#email", "stu@test.com"); sp.fill("#password", "password1"); sp.fill("#password2", "password1"); sp.click("#regBtn"); sp.wait_for_url(re.compile(r".*broker\.html"))
    sp.wait_for_selector("#idForm"); sp.click("#pocketBtn"); sp.wait_for_timeout(300); click = sp.evaluate("window.__opened")[0].split("click_id=")[1]
    sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id=88800051&secret={sec}")
    sp.fill("#traderId", "88800051"); sp.click("#idBtn"); sp.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id=88800051&amount=60&currency=USD&secret={sec}")
    # один ответ в тестах и одна тренировка — чтобы проверить экраны результата
    sp.goto(B + "/academy/daily-tests.html"); sp.wait_for_selector(".dt-task"); href = sp.get_attribute(".dt-task a", "href")
    sp.goto(B + "/academy/daily-tests.html" + href); sp.wait_for_selector("#dtAnswer"); sp.click("[data-opt='0']"); sp.click("#dtAnswer"); sp.wait_for_selector("#dtResult")
    sp.goto(B + "/academy/chart-training.html"); sp.wait_for_selector("#ctForm"); sp.check("input[name=dir][value=no_trade]"); sp.click("#ctSubmit"); sp.wait_for_selector("#ctScore")
    review = sp.url.split("#")[1]
    state = sctx.storage_state(); sctx.close()
    names = {"ru": ["ИИ-помощник", "Ежедневные тесты", "Тренировка на графике", "Подготовка к торговой сессии"],
             "en": ["AI Mentor", "Daily Tests", "Chart Training", "Pre-Trade Routine"], "ua": ["ШІ-помічник", "Щоденні тести", "Тренування на графіку", "Підготовка до торгової сесії"]}
    for lang in ("ru", "en", "ua"):
        ctx, p = new_ctx(b, lang=lang, state=state)
        p.goto(B + "/academy/academy.html"); p.wait_for_selector("#secsList [data-feature]")
        titles = p.eval_on_selector_all("#secsList [data-feature] h3", "a=>a.map(x=>x.textContent)")
        check(f"[{lang.upper()}] карточки ученика: {', '.join(titles)}", titles == names[lang][:2], titles)
        ok, bad = lang_ok(lang, texts(p, "#secsList")); check(f"[{lang.upper()}] карточки без смешения языков", ok, bad)
        pages = [("ежедневные тесты — список", "/academy/daily-tests.html", ".dt-task"), ("ежедневные тесты — разбор", "/academy/daily-tests.html" + href, "#dtResult"),
                 ("ежедневные тесты — пройденные", "/academy/daily-tests.html#done", "#dtDone"), ("тренировка — форма", "/academy/chart-training.html#train", "#ctForm"),
                 ("тренировка — разбор", "/academy/chart-training.html#" + review, "#ctScore"), ("тренировка — история", "/academy/chart-training.html#history", "#ctHist"),
                 ("подготовка к сессии", "/academy/pre-trade.html", "#ptSummary")]
        for name, url, sel in pages:
            p.goto(B + "/academy/academy.html"); p.goto(B + url); p.wait_for_selector(sel, timeout=10000); p.wait_for_timeout(300)
            ok, bad = lang_ok(lang, texts(p)); check(f"[{lang.upper()}] {name}: без смешения языков", ok, bad)
        check(f"[{lang.upper()}] заголовок вкладки и подпись в шапке переведены", names[lang][1] in p.evaluate("document.title") or names[lang][3] in p.evaluate("document.title"), p.evaluate("document.title"))
        ctx.close()
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
