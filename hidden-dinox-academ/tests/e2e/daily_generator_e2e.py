"""Автопополнение Daily Tests в админке: панель, настройки, ручной запуск, ИИ-вопросы на проверке, одобрение в редакторе, предупреждение автопубликации.
Claude API имитируется тестовым сервером. Запуск: python3 tests/e2e/daily_generator_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); PORT = os.environ.get("PORT", "8828"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 900})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ap = ctx.new_page(); ap.on("pageerror", lambda e: js_errors.append(str(e)))
    ap.goto(B + "/"); ap.wait_for_selector("#loginForm"); ap.click("[data-go=register]")
    ap.fill("#email", "owner@test.com"); ap.fill("#password", "password1"); ap.fill("#password2", "password1"); ap.click("#regBtn"); ap.wait_for_url(re.compile(r".*broker\.html"))
    get("/test/role?uid=owner_test_com&role=admin")
    for f in ("content/hidden-reaction-course.json", "content/binary/smart_money_concepts_binary.json", "content/binary/risk_management_binary.json"):
        cid = admin("POST", "/import/course", {"confirm": True, "data": json.load(open(os.path.join(ROOT, f), encoding="utf-8"))})["course_id"]
        admin("POST", f"/courses/{cid}/ready-all", {"confirm": True}); admin("POST", f"/courses/{cid}/publish", {"confirm": True})
    admin("POST", "/daily/bank/import", {"confirm": True})
    hr = [q for q in admin("GET", "/daily/bank?course=hr&status=approved")["items"]]                     # низкий запас HR: оставить 4 одобренных (на 2 дня)
    for q in hr[4:]: admin("PUT", "/daily/bank/" + q["id"], {"status": "disabled"})
    ap.goto(B + "/admin/#/daily"); ap.wait_for_selector("#gCounts", timeout=20000)
    check("панель автопополнения: счётчики, запас по курсам, расход", "Ждут проверки" in ap.inner_text("#gCounts") and "Hidden Reaction:" in ap.inner_text("#gStock") and ap.inner_text("#gPending") == "0")
    ap.check("#gAuto"); check("автопубликация — с предупреждением", ap.is_visible("#gAutoWarn")); ap.uncheck("#gAuto")
    ap.fill("#gForm input[name=max_per_run]", "6"); ap.click("#gSave")
    ap.wait_for_function("document.getElementById('toast').textContent.includes('сохранены')", timeout=8000)
    ap.wait_for_selector("#gRun"); ap.click("#gRun"); ap.locator("#modalBody button", has_text="Сгенерировать").click()
    ap.wait_for_function("document.getElementById('toast').textContent.includes('Генерация')", timeout=60000)
    check("ручной запуск: создано 6 вопросов для HR", "создано вопросов — 6" in ap.inner_text("#toast"), ap.inner_text("#toast"))
    ap.wait_for_function("document.getElementById('gPending') && document.getElementById('gPending').textContent==='6'", timeout=15000)
    check("6 ИИ-вопросов ждут проверки; последний запуск в журнале", "generated" in ap.inner_text("#gLast"))
    ap.click("#gShowPending"); ap.wait_for_function("document.querySelectorAll('[data-qedit]').length>0 && [...document.querySelectorAll('#dBank .card')].every(c=>c.textContent.includes('сгенерированный вопрос'))", timeout=15000)
    check("«Показать»: банк отфильтрован по ИИ-вопросам на проверке", ap.locator("#dBank .card").count() == 6)
    ap.locator("[data-qedit]").first.click(); ap.wait_for_selector("#modalBody select[name=status]")
    ap.select_option("#modalBody select[name=status]", "approved"); ap.locator("#modalBody button", has_text="Сохранить").click()
    ap.wait_for_function("document.getElementById('toast').textContent.includes('Вопрос и переводы сохранены')", timeout=8000)
    ap.reload(); ap.wait_for_selector("#gPending", timeout=20000)
    check("после одобрения ждут проверки 5", ap.inner_text("#gPending") == "5", ap.inner_text("#gPending"))
    st = admin("GET", "/daily/generator"); check("одобренный вопрос: review_status approved", st["counts"]["ai_approved"] == 1)
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
