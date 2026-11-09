"""Состояния загрузки обучения на главной странице (телефон): обновление, медленная сеть, временная ошибка, прогресс после урока,
повторный вход, пользователь без доступа. Ловит «ложное отсутствие курса» и «ложный нулевой прогресс». Запуск: python3 tests/e2e/load_states_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8792"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
COURSE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
results, js_errors = [], []
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:300]}"))
OBS = """(()=>{window.__m={texts:[],msgs:[]};const f=()=>{const a=document.querySelector('a.course-card');if(a){const s=a.querySelector('small');if(s&&!window.__m.texts.includes(s.textContent))window.__m.texts.push(s.textContent)}
 const m=document.querySelector('#learnList .learn-msg');if(m&&!window.__m.msgs.includes(m.textContent))window.__m.msgs.push(m.textContent);
 const sec=document.getElementById('learnPanel');if(sec&&sec.hidden&&document.readyState!=='loading')window.__m.hidden=(window.__m.hidden||0)+1};
 new MutationObserver(f).observe(document,{subtree:true,childList:true,attributes:true});})();"""
def new_page(b, w=375):
    ctx = b.new_context(viewport={"width": w, "height": 860})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};"); ctx.add_init_script(OBS)
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
    p.wait_for_selector("#ib:not([disabled])"); p.check("#ic"); p.click("#ib"); p.wait_for_selector("#readyall"); p.click("#readyall"); p.check("#rac"); p.click("#modalBody .mf .primary")
    p.wait_for_selector("#pub"); p.wait_for_timeout(400); p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); p.wait_for_selector(".pill.ok"); ctx.close()

    ctx, p = new_page(b); register(p, "learner@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id="88800072"); p.fill("#traderId", "88800072"); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id="88800072", amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    p.wait_for_selector("a.course-card")
    # 1. обычное обновление
    p.reload(); p.wait_for_selector("a.course-card"); p.wait_for_timeout(300); m = p.evaluate("window.__m")
    check("обновление: секция не скрывалась, ложного «курсов нет» не было", not m.get("hidden") and not m["msgs"], m)
    # 2. медленная сеть: API отвечает через 2,5 с
    slow = lambda r: (p.wait_for_timeout(2500), r.continue_())
    p.route(re.compile(r".*/api/(me|learn/courses|announcements)$"), slow)
    p.reload(wait_until="domcontentloaded"); p.wait_for_timeout(800)
    check("медленная сеть: пока ждём — заглушка в секции, не пусто и не «курсов нет»", p.locator("#learnList .skel").count() == 1 and p.locator("#learnPanel").is_visible() and not p.evaluate("window.__m").get("msgs"))
    check("медленная сеть: блок прогресса не показывает ложное «Обучение ещё не началось»", "не началось" not in p.inner_text(".p-progress"), p.inner_text(".p-progress"))
    p.wait_for_selector("a.course-card", timeout=15000); p.unroute(re.compile(r".*/api/(me|learn/courses|announcements)$"))
    check("медленная сеть: курс появился после ответа", p.locator("a.course-card").count() == 1)
    # 3. временная ошибка Firestore
    get("/test/fail-learn?n=1"); p.reload(); p.wait_for_selector("#learnRetry", timeout=10000)
    txt = p.inner_text("#learnList")
    check("временная ошибка: понятная ошибка с повтором, а не «курсов нет»", "Не удалось загрузить" in txt and "появятся" not in txt, txt)
    p.click("#learnRetry"); p.wait_for_selector("a.course-card", timeout=10000)
    check("временная ошибка: «Повторить» загружает курс", p.locator("a.course-card").count() == 1)
    # 4. прогресс после завершённого урока: при обновлении сразу 1/29, без ложного 0/29
    p.click("a.course-card"); p.wait_for_selector(".lp-mod"); p.click("text=Начать обучение"); p.wait_for_selector(".hdl-quiz")
    for qi, q in enumerate([q for bl in COURSE["modules"][0]["lessons"][0]["blocks"] if bl["type"] == "quiz" for q in bl["questions"]]): p.locator(".hdl-q").nth(qi).locator(f"input[value='{q['correct']}']").check()
    p.click("[data-quiz-submit]"); p.wait_for_selector(".hdl-quiz-total:not([hidden])"); p.wait_for_selector("#doneWrap .lp-done")   # урок завершён тестом
    p.goto(B + "/academy/academy.html"); p.wait_for_selector("a.course-card"); p.wait_for_timeout(300)
    p.reload(); p.wait_for_selector("a.course-card"); p.wait_for_timeout(300); m = p.evaluate("window.__m")
    check("после урока и обновления: прогресс сразу 1/29, ложного 0/29 не было", m["texts"] and all(x.startswith("1/29") for x in m["texts"]), m["texts"])
    # 5. повторный вход
    p.click("#profBtn"); p.click("[data-signout]"); p.wait_for_url(re.compile(r"^https?://[^/]+/(academy/(index\.html)?)?(\?[^#]*)?(#.*)?$"), timeout=10000)   # вход — «/» или старый адрес
    p.fill("#email", "learner@test.com"); p.fill("#password", "password1"); p.click("#loginBtn")
    p.wait_for_url(re.compile(r".*academy\.html"), timeout=10000); p.wait_for_selector("a.course-card", timeout=10000)
    check("повторный вход: курс и прогресс на месте (1/29)", "1/29" in p.inner_text("#learnList"), p.inner_text("#learnList"))
    ctx.close()
    # 6. пользователь без доступа: курс не показывается, перенаправление
    ctx, p = new_page(b); register(p, "nodep@test.com"); p.goto(B + "/academy/academy.html"); p.wait_for_timeout(1500)
    check("без доступа: перенаправление, курс не показан", "academy.html" not in p.url and p.locator("a.course-card").count() == 0, p.url); ctx.close()
    b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
