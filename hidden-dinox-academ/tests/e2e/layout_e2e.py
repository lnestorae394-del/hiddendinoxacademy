"""Вёрстка RU/EN/UA на 320/375/390/430/1280 px: общая шапка без наложений, длинные названия не выходят за карточки,
новый курс получает общие компоненты, кабинет партнёра — компактный переключатель. Запуск: python3 tests/e2e/layout_e2e.py"""
import os, re, json, copy, hashlib, subprocess, urllib.request, tempfile
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8793"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:500]}"))
h12 = lambda s: hashlib.sha1(s.encode("utf-8")).hexdigest()[:12]
# второй курс с очень длинными названиями (новый курс через существующий импорт)
BASE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
def strip(o):
    if isinstance(o, dict): o.pop("tr", None); [strip(v) for v in o.values()]
    elif isinstance(o, list): [strip(v) for v in o]
    return o
LONG = {"course": ("Очень длинное название нового курса для проверки адаптивной вёрстки на узких экранах телефонов",
                   "An extraordinarily long course title used to verify that responsive layouts never overflow on narrow phone screens",
                   "Надзвичайно довга назва нового курсу для перевірки адаптивної верстки на вузьких екранах телефонів"),
        "module": ("Модуль с длинным названием, которое должно переноситься на следующую строку",
                   "A module with a deliberately long title that has to wrap onto the next line gracefully",
                   "Модуль із довгою назвою, яка має переноситися на наступний рядок"),
        "lesson": ("Урок с длинным названием: проверка переносов, отступов и границ карточек",
                   "A lesson with a long title: checking line wrapping, spacing and card boundaries on mobile",
                   "Урок із довгою назвою: перевірка переносів, відступів і меж карток на мобільних")}
c2 = strip(copy.deepcopy(BASE)); c2["course"]["slug"] = "layout-long-titles"; c2["course"]["title"] = LONG["course"][0]
c2["modules"] = [c2["modules"][0]]; c2["modules"][0]["title"] = LONG["module"][0]; c2["modules"][0]["lessons"] = [c2["modules"][0]["lessons"][0]]
c2["modules"][0]["lessons"][0]["title"] = LONG["lesson"][0]
for key, obj in (("course", c2["course"]), ("module", c2["modules"][0]), ("lesson", c2["modules"][0]["lessons"][0])):
    ru, en, ua = LONG[key]; obj["tr"] = {"en": {"title": en}, "ua": {"title": ua}, "src": {"title": h12(ru)}}
fx = os.path.join(tempfile.gettempdir(), "layout-course.json"); json.dump(c2, open(fx, "w", encoding="utf-8"), ensure_ascii=False)
def new_page(b, w, lang):
    ctx = b.new_context(viewport={"width": w, "height": 800})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};" + f"localStorage.setItem('hd_lang','{lang}');")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=10000)
GEOM = """(sel) => { const vw = innerWidth, H = document.querySelector('.hd-head'), r = e => e.getBoundingClientRect(), bad = [];
  if (H) { const b = r(H.querySelector('.hd-brand')), g = r(H.querySelector('.hd-head-r'));
    if (b.right > g.left + 0.5) bad.push('бренд заходит под переключатель: ' + Math.round(b.right) + ' > ' + Math.round(g.left));
    if (g.right > vw + 0.5) bad.push('правая часть шапки за экраном'); if (H.scrollWidth > H.clientWidth + 1) bad.push('шапка шире экрана');
    const sm = H.querySelector('.hd-brand-t small'); if (sm && r(sm).right > g.left + 0.5) bad.push('подпись под переключателем'); }
  if (document.documentElement.scrollWidth > vw + 1) bad.push('горизонтальная прокрутка ' + document.documentElement.scrollWidth);
  for (const e of document.querySelectorAll(sel)) { const x = r(e); if (x.width && (x.right > vw + 1 || x.left < -1)) bad.push('за экраном: ' + e.className + ' ' + e.textContent.slice(0, 40)); if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'auto') bad.push('текст не помещается: ' + e.className + ' ' + e.textContent.slice(0, 40)); }
  return bad; }"""
CRUMB = {"ru": "Обучение", "en": "Learning", "ua": "Навчання"}
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx, p = new_page(b, 1280, "ru"); register(p, "owner@test.com"); get("/test/role?uid=owner_test_com&role=super_admin")
    for f in (os.path.join(ROOT, "content", "hidden-reaction-course.json"), fx):
        p.goto(B + "/admin/#/import"); p.wait_for_selector("#if"); p.set_input_files("#if", f)
        p.wait_for_selector("#ib:not([disabled])"); p.check("#ic"); p.click("#ib"); p.wait_for_selector("#readyall", timeout=20000)
        p.click("#readyall"); p.check("#rac"); p.click("#modalBody .mf .primary"); p.wait_for_selector("#pub"); p.wait_for_timeout(400)
        p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); p.wait_for_selector(".pill.ok", timeout=20000)
    ctx.close()
    ctx, p = new_page(b, 390, "ru"); register(p, "lay@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id="88910001"); p.fill("#traderId", "88910001"); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id="88910001", amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    p.goto(B + "/academy/learn.html#/"); p.wait_for_selector(".lp-card")
    hrefs = p.eval_on_selector_all(".lp-card", "els=>els.map(e=>e.getAttribute('href'))")
    long_href = [h for h in hrefs if h][-1]
    p.goto(B + "/academy/learn.html" + long_href); p.wait_for_selector(".lp-les"); lesson_href = p.get_attribute(".lp-les", "href")
    state = ctx.storage_state(); ctx.close()
    problems = []
    for w in (320, 375, 390, 430, 1280):
        for lang in ("ru", "en", "ua"):
            c = b.new_context(viewport={"width": w, "height": 800}, storage_state=state)
            c.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
            c.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
            c.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
            q = c.new_page(); q.on("pageerror", lambda e: js_errors.append(str(e)))
            for route, sel, wait in (("#/", ".lp-card, .lp h1", ".lp-card"), (long_href, ".lp-les, .lp h1, .lp-meta, .lp-mod h2", ".lp-les"), (lesson_href, ".lp h1, .lp-course, .hdl-q, .lp-foot", ".hdl-quiz")):
                q.goto(B + "/academy/learn.html" + route); q.wait_for_selector(wait, timeout=10000)
                bad = q.evaluate(GEOM, sel)
                if q.inner_text("#crumb") != CRUMB[lang]: bad.append("подпись в шапке: " + q.inner_text("#crumb"))
                if bad: problems.append((w, lang, route[:18], bad[:3]))
            q.goto(B + "/academy/partner.html"); q.wait_for_selector(".pt-card", timeout=10000)
            bad = q.evaluate(GEOM, ".pt-card, .pt-stat, .pt-kv")
            lw = q.evaluate("document.querySelector('.hd-langs').getBoundingClientRect().width")
            if w >= 1000 and lw > 140: bad.append(f"переключатель растянут: {lw}px")
            if bad: problems.append((w, lang, "partner", bad[:3]))
            q.goto(B + "/academy/academy.html"); q.wait_for_selector(".p-progress .kv b", timeout=10000); q.wait_for_timeout(400)
            if q.evaluate("document.documentElement.scrollWidth") > w + 1: problems.append((w, lang, "academy", ["горизонтальная прокрутка"]))
            c.close()
    check("шапка и содержимое: 5 ширин × 3 языка × (курсы, курс с длинными названиями, урок, кабинет, главная) — без наложений и выхода за экран", not problems, problems[:6])
    b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
