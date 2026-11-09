"""Измерение: время от начала загрузки academy.html до появления карточки курса.
Firestore — тестовая база с ЗАДАННОЙ задержкой каждой операции (FAKE_FS_LATENCY, мс); это модель, не замер Render.
Запуск: FAKE_FS_LATENCY=150 python3 tests/e2e/measure_load.py"""
import os, re, json, time, subprocess, urllib.request, statistics
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8793"); B = f"http://127.0.0.1:{PORT}"; LAT = os.environ.get("FAKE_FS_LATENCY", "0")
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
COURSE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def ctx_page(b, w):
    ctx = b.new_context(viewport={"width": w, "height": 860})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    ctx.add_init_script("""(()=>{window.__m={};const mark=()=>{const sec=document.getElementById('learnPanel');
      if(sec&&!sec.hidden&&window.__m.section==null)window.__m.section=performance.now();
      if(document.querySelector('a.course-card')&&window.__m.card==null)window.__m.card=performance.now();
      if(window.__m.card!=null&&sec&&sec.hidden)window.__m.hiddenAfterCard=true;};
      new MutationObserver(mark).observe(document,{subtree:true,childList:true,attributes:true});})();""")
    return ctx, ctx.new_page()
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=20000)
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, stderr=open("/tmp/reqlog.txt", "w"), text=True, env={**os.environ, "PORT": PORT, "FAKE_FS_LATENCY": LAT, "MEASURE_LOG": "1"}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx, p = ctx_page(b, 1280); register(p, "owner@test.com"); get("/test/role?uid=owner_test_com&role=super_admin")
    p.goto(B + "/admin/#/import"); p.wait_for_selector("#if", timeout=30000); p.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json"))
    p.wait_for_selector("#ib:not([disabled])"); p.check("#ic"); p.click("#ib"); p.wait_for_selector("#readyall", timeout=60000)
    p.click("#readyall"); p.check("#rac"); p.click("#modalBody .mf .primary"); p.wait_for_selector("#pub:not([disabled])", timeout=60000); p.wait_for_timeout(500)
    p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); p.wait_for_selector(".pill.ok", timeout=60000); ctx.close()
    ctx, p = ctx_page(b, 375); register(p, "learner@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length > 0", timeout=30000); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id="88800071"); p.fill("#traderId", "88800071"); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"), timeout=20000)
    postback(type="ftd", click_id=click, trader_id="88800071", amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=30000)
    p.wait_for_selector("a.course-card", timeout=30000)
    times, ops, flash = [], [], []
    for i in range(5):
        get("/test/ops-reset")
        # Наблюдатель: исчезает ли карточка курса во время загрузки (был ли момент «курса нет»)
        p.add_init_script("") 
        t0 = time.perf_counter(); p.reload(wait_until="commit")
        p.wait_for_selector("a.course-card", timeout=60000); p.wait_for_timeout(400)
        m = p.evaluate("window.__m"); times.append(round(m["card"])); flash.append(round(m["section"]) if m.get("section") is not None else None)
        if m.get("hiddenAfterCard"): flash.append("СЕКЦИЯ СКРЫЛАСЬ ПОСЛЕ ПОЯВЛЕНИЯ КУРСА")
        p.wait_for_timeout(300); ops.append(get("/test/ops")["ops"])
    print(json.dumps({"latency_ms_per_op": int(LAT), "navigation_start_to_course_card_ms": times, "median_ms": statistics.median(times), "firestore_ops_per_page_load": ops, "learn_section_visible_at_ms": flash}, ensure_ascii=False))
    b.close()
finally:
    srv.terminate()
