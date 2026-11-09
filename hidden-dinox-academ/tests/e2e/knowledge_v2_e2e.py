"""База знаний v2 в админке: dry-run → импорт (с копией) → проверка → включение → предпросмотр → скачивание копии; наставник использует v2; откат на v1.
Claude API имитируется тестовым сервером. Запуск: python3 tests/e2e/knowledge_v2_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); PORT = os.environ.get("PORT", "8823"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
def new_ctx(b, w=1280):
    ctx = b.new_context(viewport={"width": w, "height": 900}, accept_downloads=True)
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"))
def ask(p, text):
    n = p.locator(".mn-msg.assistant:not(.mn-welcome)").count(); p.fill("#mnInput", text); p.press("#mnInput", "Enter")
    p.wait_for_function(f"document.querySelectorAll('.mn-msg.assistant:not(.mn-welcome)').length>{n}", timeout=15000); return p.locator(".mn-msg.assistant").last.inner_text()

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); register(ap, "owner@test.com"); get("/test/role?uid=owner_test_com&role=admin")
    for f in ("content/hidden-reaction-course.json", "content/binary/smart_money_concepts_binary.json", "content/binary/risk_management_binary.json"):
        cid = admin("POST", "/import/course", {"confirm": True, "data": json.load(open(os.path.join(ROOT, f), encoding="utf-8"))})["course_id"]
        admin("POST", f"/courses/{cid}/ready-all", {"confirm": True}); admin("POST", f"/courses/{cid}/publish", {"confirm": True})
    admin("POST", "/features/ai_mentor/status", {"status": "ACTIVE"})
    ap.goto(B + "/admin/#/kv2"); ap.wait_for_selector("#kvActive", timeout=15000)
    check("раздел «База знаний v2»: активна v1, записей 0", ap.inner_text("#kvActive") == "v1" and ap.inner_text("#kvTotal") == "0")
    ap.click("#kvDry"); ap.wait_for_function("document.getElementById('kvOut').textContent.includes('Dry-run')", timeout=20000)
    check("dry-run: 2466 к добавлению, 0 ошибок", "добавить 2466" in ap.inner_text("#kvOut") and "ошибок 0" in ap.inner_text("#kvOut"), ap.inner_text("#kvOut"))
    ap.click("#kvImport"); ap.locator("#modalBody button", has_text="Импортировать").click(); ap.wait_for_function("document.getElementById('toast').textContent.includes('Импорт')", timeout=60000); ap.wait_for_selector("[data-kvbk]", timeout=20000)   # новая разметка после импорта
    check("импорт: записано 2466, создана резервная копия", "записано 2466" in ap.inner_text("#toast") and ap.locator("[data-kvbk]").count() == 1, ap.inner_text("#toast"))
    ap.click("#kvVerifyBtn"); ap.wait_for_function("document.getElementById('kvOut').textContent.includes('Проверка')", timeout=30000)
    check("проверка поиска: пройдена (42/42)", "42/42" in ap.inner_text("#kvOut") and "пройдена" in ap.inner_text("#kvOut"), ap.inner_text("#kvOut"))
    ap.click("#kvV2"); ap.locator("#modalBody button", has_text="Включить").click(); ap.wait_for_function("document.getElementById('kvActive') && document.getElementById('kvActive').textContent==='v2'", timeout=15000)
    check("v2 включена для AI Mentor", ap.inner_text("#kvActive") == "v2")
    ap.fill("#kvQ", "что такое ордер блок"); ap.click("#kvSearch"); ap.wait_for_selector("[data-kvres]", timeout=15000)
    first = ap.locator("[data-kvres]").first.inner_text()
    check("предпросмотр: первый результат — из урока про Order Block, источник — файл курса", re.search("order block", first, re.I) and "smart-money-concepts-binary#m5l0" in first and "smart_money_concepts_binary.json" in first, first[:300])
    with ap.expect_download() as dl: ap.click("[data-kvbk]")
    data = json.load(open(dl.value.path(), encoding="utf-8"))
    check("резервная копия скачивается: JSON со старой базой и пустой v2 на момент импорта", data.get("kind") == "hidden-dinox-knowledge-backup" and len(data["hd_knowledge_v2"]) == 0 and "hd_knowledge" in data)
    # наставник
    sctx, sp = new_ctx(b); register(sp, "staff@test.com"); get("/test/role?uid=staff_test_com&role=team_member")
    sp.goto(B + "/academy/mentor.html"); sp.wait_for_selector("#mnInput", timeout=15000)
    rep = ask(sp, "Что такое откат в системе Hidden Reaction?")
    check("наставник с v2: ответ по разделу урока из v2", re.search(r"Откат — ", rep) is not None, rep[:200])
    admin("POST", "/knowledge-v2/activate", {"version": "v1", "confirm": True})
    rep2 = ask(sp, "Что такое откат в системе Hidden Reaction?")
    check("после «Вернуть v1» — прежний поиск (без разделов v2)", re.search(r"Откат — ", rep2) is None, rep2[:200])
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
