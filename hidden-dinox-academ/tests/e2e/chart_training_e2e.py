"""Этап 3: Chart Training — админ (сценарии, CSV), ученик (график, гипотеза, раскрытие, разбор, история), языки, телефон.
Запуск: python3 tests/e2e/chart_training_e2e.py"""
import os, re, json, subprocess, urllib.request, datetime
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8808"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors, leaks = [], [], []
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
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e)))
    def watch(r):
        if "/api/chart/next" in r.url:
            try:
                if re.search(r'expected|"dir"|pattern|"seed"', r.text()): leaks.append(r.url)
            except Exception: pass
    p.on("response", watch); return ctx, p
def register(p, email):
    p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
def give_access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id={trader}&secret={sec}")
    p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id={trader}&amount=60&currency=USD&secret={sec}")
painted = "(()=>{const c=document.getElementById('ctChart');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let g=0;for(let i=0;i<d.length;i+=16){if(d[i+1]>200&&d[i]>100&&d[i+2]<90)g++}return g})()"

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); register(ap, "owner@test.com"); get("/test/role?uid=owner_test_com&role=admin")
    ap.goto(B + "/admin/#/chart"); ap.wait_for_selector("#cList", timeout=10000)
    check("админка: Chart Training — 12 сценариев-симуляций", ap.locator("#cList [data-sc]").count() == 12 and ap.inner_text("#cList").count("Симуляция") == 12)
    for s in admin("GET", "/chart/scenarios")["scenarios"]:
        if s["id"] != "sim_trend_up_pullback_1": admin("POST", f"/chart/scenarios/{s['id']}/status", {"active": False})
    ap.reload(); ap.wait_for_selector("#cList")
    check("отключение сценариев отражается в списке", ap.locator("[data-cact]:checked").count() == 1)
    ap.goto(B + "/admin/#/features"); ap.wait_for_selector("select[data-fst=chart_training]"); ap.select_option("select[data-fst=chart_training]", "ACTIVE"); ap.wait_for_selector("#toast.show")
    sctx, sp = new_ctx(b); register(sp, "stu@test.com"); give_access(sp, "88800031")
    sp.goto(B + "/academy/academy.html"); sp.wait_for_selector("#secsList [data-feature]", timeout=10000)
    check("кабинет ученика: карточки «Тренировка на графике» нет (модуль работает по прямой ссылке)", sp.locator("#secsList [data-feature=chart_training]").count() == 0)
    sp.goto(B + "/academy/chart-training.html")
    sp.wait_for_selector("#ctChart", timeout=10000); sp.wait_for_function(painted + ">50")
    check("карточка ведёт на тренировку; пометка «Симуляция — не реальные рыночные данные»", "Симуляция — не реальные рыночные данные" in sp.inner_text("#ctLabel"))
    check("график нарисован на canvas", sp.evaluate(painted) > 50)
    box = sp.locator("#ctChart").bounding_box(); sp.mouse.click(box["x"] + box["width"] * 0.4, box["y"] + box["height"] * 0.85)
    inv = sp.input_value("#ctInval"); check("щелчок по графику ставит уровень отмены", re.match(r"^\d\.\d{5}$", inv or ""), inv)
    sp.click("#ctSubmit"); check("без гипотезы ответ не отправляется", "гипотезу" in sp.inner_text("#ctFormErr"))
    sp.check("input[name=dir][value=up]"); sp.click("#ctSubmit"); check("без объяснения — подсказка на языке ученика", "минимум 10" in sp.inner_text("#ctFormErr"))
    sp.check("input[name=f][value=structure]"); sp.check("input[name=f][value=premium_discount]"); sp.fill("#ctExpl", "Восходящая структура, откат в дисконт, жду продолжения.")
    with sp.expect_response(lambda r: "/api/chart/answer" in r.url) as rr: sp.click("#ctSubmit")
    res = rr.value.json(); sp.wait_for_selector("#ctScore")
    check(f"после ответа раскрыты следующие свечи ({res['visible']} → {len(res['candles'])})", len(res["candles"]) > res["visible"])
    check(f"разбор: баллы {sp.inner_text('#ctScore')}, 4 критерия, тип результата", re.match(r"^\d+/100$", sp.inner_text("#ctScore")) and sp.locator("#ctCrit div").count() == 4 and len(sp.inner_text("#ctKind")) > 20)
    check("будущие свечи не приходили до ответа (нет ожидаемого ответа в /api/chart/next)", not leaks, leaks)
    sp.reload(); sp.wait_for_selector("#ctScore", timeout=10000); check("разбор открывается после перезагрузки (#review/…)", sp.inner_text("#ctScore") == f"{res['grade']['score']}/100")
    sp.click("[data-tab=history]"); sp.wait_for_selector("#ctHist"); check("история: тренировка с баллами", sp.locator("#ctHist > div").count() == 1 and "/100" in sp.inner_text("#ctHist"))
    sp.screenshot(path="/tmp/chart_hist.png")
    sp.click("#ctHist a"); sp.wait_for_selector("#ctScore"); sp.wait_for_function(painted + ">50"); sp.screenshot(path="/tmp/chart_review.png", full_page=True)
    check("разбор из истории тоже помечен «Симуляция — не реальные рыночные данные»", sp.is_visible("#ctLabel") and "не реальные" in sp.inner_text("#ctLabel"))
    # импорт CSV через форму админки
    rows = ["Time,Open,High,Low,Close"]; p0 = 1.1
    for i in range(70):
        o = p0; c = round(o + (0.0003 if i < 50 else -0.0004), 5); ts = (datetime.datetime(2025, 6, 2, 8) + datetime.timedelta(minutes=15 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows.append(f"{ts},{o:.5f},{max(o, c) + 0.0002:.5f},{min(o, c) - 0.0002:.5f},{c:.5f}"); p0 = c
    ap.goto(B + "/admin/#/chart"); ap.wait_for_selector("#cImport"); ap.click("#cImport"); ap.wait_for_selector("textarea[name=csv]")
    ap.fill("input[name=id]", "eurusd_csv_e2e"); ap.fill("input[name=instrument]", "EUR/USD"); ap.fill("input[name=timeframe]", "M15"); ap.fill("input[name=data_source]", "Экспорт из терминала, учебное использование")
    ap.fill("input[name=visible]", "50"); ap.select_option("select[name=expected_dir]", "up"); ap.check("input[name=f_structure]"); ap.fill("textarea[name=csv]", "\n".join(rows))
    ap.locator("#modalBody button", has_text="Импортировать").click(); ap.wait_for_selector("#toast.show")
    ap.wait_for_function("document.getElementById('toast').textContent.length>3")
    check("импорт CSV через форму админки: 70 свечей", "70" in ap.inner_text("#toast"))
    admin("POST", "/chart/scenarios/sim_trend_up_pullback_1/status", {"active": False})
    sp.goto(B + "/academy/chart-training.html#train"); sp.reload(); sp.wait_for_selector("#ctLabel", timeout=10000)
    check("исторический сценарий: пометка с инструментом, таймфреймом и источником", "EUR/USD M15" in sp.inner_text("#ctLabel") and "источник" in sp.inner_text("#ctLabel"))
    state = sctx.storage_state()
    ectx, ep = new_ctx(b, lang="en", state=state); ep.goto(B + "/academy/chart-training.html"); ep.wait_for_selector("#ctForm")
    check("EN: вопрос и форма на английском", "Which scenario" in ep.inner_text("main") and "Lock in the answer" in ep.inner_text("main")); ectx.close()
    mctx, mp = new_ctx(b, w=375, state=state); mp.goto(B + "/academy/chart-training.html"); mp.wait_for_selector("#ctForm")
    check("телефон 375px: без горизонтальной прокрутки", mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), mp.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    mp.screenshot(path="/tmp/chart_mobile.png", full_page=True)
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
