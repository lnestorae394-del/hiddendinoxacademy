"""Этап 4: Pre-Trade Routine — повторение → Daily Tests → Chart Training → итог; сохранение, выключенный модуль, языки, телефон.
Запуск: python3 tests/e2e/pretrade_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8812"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
def new_ctx(b, w=1280, lang=None, state=None):
    ctx = b.new_context(viewport={"width": w, "height": 900}, **({"storage_state": state} if state else {}))
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
def give_access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id={trader}&secret={sec}")
    p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id={trader}&amount=60&currency=USD&secret={sec}")
def routine(p):
    p.goto(B + "/academy/pre-trade.html"); p.wait_for_selector("#ptSummary", timeout=10000)
    return {k: p.get_attribute(f"[data-step={k}] .pt-st", "data-st") for k in ("review", "daily", "chart")}

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); register(ap, "owner@test.com"); get("/test/role?uid=owner_test_com&role=admin"); actx.close()
    admin("POST", "/daily/bank/import", {"confirm": True}); admin("POST", "/daily/run", {})
    for s in admin("GET", "/chart/scenarios")["scenarios"]:
        if s["id"] != "sim_range_chop_1": admin("POST", f"/chart/scenarios/{s['id']}/status", {"active": False})
    for f in ("daily_tests", "chart_training", "pre_trade"): admin("POST", f"/features/{f}/status", {"status": "ACTIVE"})
    sctx, sp = new_ctx(b); register(sp, "stu@test.com"); give_access(sp, "88800041")
    sp.goto(B + "/academy/academy.html"); sp.wait_for_selector("#secsList [data-feature]", timeout=10000)
    check("кабинет ученика: карточки «Подготовка к торговой сессии» нет (маршрут работает по прямой ссылке)", sp.locator("#secsList [data-feature=pre_trade]").count() == 0)
    st = routine(sp)
    check("новый ученик: все этапы «Ожидает», «Завершить» неактивна", st == {"review": "pending", "daily": "pending", "chart": "pending"} and sp.is_disabled("#ptComplete"), st)
    # Daily Tests: 5 ответов, 2 неверных
    date = sp.evaluate("new Date().toISOString().slice(0,10)")
    t = json.loads(sp.evaluate("""async()=>{const r=await call('GET','/api/daily/today');return JSON.stringify(r)}"""))
    corr = {q["id"]: q["correct"] for q in admin("GET", "/daily/sets/" + t["date"])["questions"]}
    for i, task in enumerate(t["tasks"]):
        ans = (corr[task["id"]] + 1) % len(task["options"]) if i < 2 else corr[task["id"]]
        sp.evaluate(f"""async()=>call('POST','/api/daily/answer',{{date:'{t["date"]}',qid:'{task["id"]}',answer:{ans}}})""")
    st = routine(sp)
    check("после Daily Tests: этап «Готово», «Пройдено 5 из 5, верно 3»", st["daily"] == "done" and "5 из 5, верно 3" in sp.inner_text("#ptDaily"), sp.inner_text("#ptDaily"))
    check("повторение: уроки по ошибкам", sp.locator("#ptRec li").count() >= 1, sp.inner_text("[data-step=review]"))
    check("итог: «3 верно из 5» и темы ошибок", "3 верно из 5" in sp.inner_text("#ptTests") and sp.inner_text("#ptMistakes") != "—")
    # Chart Training через интерфейс
    sp.click("[data-step=chart] a"); sp.wait_for_selector("#ctForm", timeout=10000)
    sp.check("input[name=dir][value=no_trade]"); sp.check("input[name=f][value=no_confirmation]"); sp.click("#ctSubmit"); sp.wait_for_selector("#ctScore")
    st = routine(sp)
    check("после Chart Training: этап «Готово», средний балл в итоге", st["chart"] == "done" and "/100" in sp.inner_text("#ptPractice"))
    check("«Завершить» неактивна, пока не отмечено повторение", sp.is_disabled("#ptComplete") and sp.is_visible("#ptNotReady"))
    sp.click("#ptReviewed"); sp.wait_for_function("document.querySelector('[data-step=review] .pt-st').dataset.st==='done'")
    check("«Повторил материал» → этап «Готово», «Завершить» активна", not sp.is_disabled("#ptComplete"))
    sp.click("#ptComplete"); sp.wait_for_selector("#ptCompleted")
    check("подготовка завершена; дата последней подготовки", "завершена" in sp.inner_text("#ptCompleted") and sp.inner_text("#ptLast") != "—")
    sp.reload(); sp.wait_for_selector("#ptCompleted"); check("после перезагрузки состояние сохранено", sp.is_visible("#ptCompleted"))
    check("дисклеймер: без обещаний прибыли", "не гарантирует прибыль" in sp.inner_text("main"))
    # модуль выключен — этап недоступен
    admin("POST", "/features/chart_training/status", {"status": "COMING_SOON"})
    st = routine(sp); check("Chart Training выключен → этап «Недоступен»", st["chart"] == "unavailable")
    admin("POST", "/features/chart_training/status", {"status": "ACTIVE"})
    state = sctx.storage_state()
    ectx, ep = new_ctx(b, lang="en", state=state); ep.goto(B + "/academy/pre-trade.html"); ep.wait_for_selector("#ptSummary")
    check("EN: маршрут и итог на английском", "Pre-Trade Routine" in ep.inner_text("main") and "Preparation summary" in ep.inner_text("main") and "correct of 5" in ep.inner_text("#ptTests"))
    ectx.close()
    mctx, mp = new_ctx(b, w=375, state=state); mp.goto(B + "/academy/pre-trade.html"); mp.wait_for_selector("#ptSummary")
    check("телефон 375px: без горизонтальной прокрутки", mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), mp.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    mp.screenshot(path="/tmp/pt_mobile.png", full_page=True); sp.goto(B + "/academy/pre-trade.html"); sp.wait_for_selector("#ptSummary"); sp.screenshot(path="/tmp/pt_desktop.png", full_page=True)
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
