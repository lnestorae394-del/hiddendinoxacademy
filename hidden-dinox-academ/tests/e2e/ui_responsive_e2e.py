"""Вёрстка кабинета ученика (две карточки) и чата AI Mentor на ширинах 320–1440 px: прокрутка, поле ввода, кнопки, миниатюры,
шапка, подпись отправки, отсутствие повторного приветствия, сохранение текста при сбое сети. Запуск: python3 tests/e2e/ui_responsive_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); IMG = os.path.join(os.path.dirname(HERE), "fixtures", "images")
PORT = os.environ.get("PORT", "8833"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
WIDTHS = [320, 360, 375, 390, 430, 768, 1280, 1440]
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
def ctx_for(b, w, state=None):
    c = b.new_context(viewport={"width": w, "height": 760 if w < 700 else 900}, **({"storage_state": state} if state else {}))
    c.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    c.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    c.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = c.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return c, p
LAYOUT = """(()=>{const W=innerWidth,H=innerHeight,r=id=>{const e=document.getElementById(id);return e?e.getBoundingClientRect():null};
  const a=r('mnAttachBtn'),t=r('mnInput'),s=r('mnSend'),f=r('mnForm');
  const thumbs=[...document.querySelectorAll('#mnAttach figure')].map(e=>e.getBoundingClientRect()); let overlap=0;
  for(let i=0;i<thumbs.length;i++)for(let j=i+1;j<thumbs.length;j++){const x=thumbs[i],y=thumbs[j];if(x.left<y.right-1&&y.left<x.right-1&&x.top<y.bottom-1&&y.top<x.bottom-1)overlap++}
  const acts=[...document.querySelectorAll('.mn-acts .lp-btn')].map(e=>e.getBoundingClientRect().right);
  const lbl=document.querySelector('.mn-send-t'); return {W,H,sw:document.documentElement.scrollWidth,
   attach:[Math.round(a.width),Math.round(a.height),Math.round(a.right)],send:[Math.round(s.width),Math.round(s.height),Math.round(s.right)],input:Math.round(t.width),
   formBottom:Math.round(f.bottom),formTop:Math.round(f.top),thumbs:thumbs.length,thumbOut:thumbs.filter(x=>x.right>W+1||x.left<-1).length,overlap,
   rmMin:Math.min(...[...document.querySelectorAll('#mnAttach [data-rm]')].map(e=>e.getBoundingClientRect().width)),
   actsOut:acts.filter(x=>x>W+1).length,label:lbl?getComputedStyle(lbl).display!=='none':false,welcome:document.querySelectorAll('.mn-welcome').length}})()"""

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    c, ap = ctx_for(b, 1280); ap.goto(B + "/"); ap.wait_for_selector("#loginForm"); ap.click("[data-go=register]")
    ap.fill("#email", "owner@test.com"); ap.fill("#password", "password1"); ap.fill("#password2", "password1"); ap.click("#regBtn"); ap.wait_for_url(re.compile(r".*broker\.html")); c.close()
    get("/test/role?uid=owner_test_com&role=admin")
    for f in ("ai_mentor", "daily_tests", "chart_training", "pre_trade"): admin("POST", f"/features/{f}/status", {"status": "ACTIVE"})
    c, sp = ctx_for(b, 1280); sp.goto(B + "/"); sp.wait_for_selector("#loginForm"); sp.click("[data-go=register]")
    sp.fill("#email", "stu@test.com"); sp.fill("#password", "password1"); sp.fill("#password2", "password1"); sp.click("#regBtn"); sp.wait_for_url(re.compile(r".*broker\.html"))
    sp.wait_for_selector("#idForm"); sp.click("#pocketBtn"); sp.wait_for_timeout(300); click = sp.evaluate("window.__opened")[0].split("click_id=")[1]; sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id=88800071&secret={sec}"); sp.fill("#traderId", "88800071"); sp.click("#idBtn"); sp.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id=88800071&amount=60&currency=USD&secret={sec}")
    sp.goto(B + "/academy/mentor.html"); sp.wait_for_selector("#mnInput")
    for q in ("Что такое BOS?", "А CHoCH?"):
        n = sp.locator(".mn-msg.assistant:not(.mn-welcome)").count(); sp.fill("#mnInput", q); sp.press("#mnInput", "Enter")
        sp.wait_for_function(f"document.querySelectorAll('.mn-msg.assistant:not(.mn-welcome)').length>{n}", timeout=15000)
    state = c.storage_state(); c.close()
    for w in WIDTHS:
        c, p = ctx_for(b, w, state)
        p.goto(B + "/academy/academy.html"); p.wait_for_selector("#secsList [data-feature]", timeout=15000)
        ids = p.eval_on_selector_all("#secsList [data-feature]", "a=>a.map(x=>x.dataset.feature)")
        check(f"{w}px кабинет: две карточки, без горизонтальной прокрутки", ids == ["ai_mentor", "daily_tests"] and p.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), ids)
        p.goto(B + "/academy/mentor.html"); p.wait_for_selector(".mn-msg.user", timeout=15000)
        p.set_input_files("#mnImage", [os.path.join(IMG, "chart.png"), os.path.join(IMG, "chart.webp")]); p.wait_for_function("document.querySelectorAll('#mnAttach figure').length===2")
        o = p.evaluate(LAYOUT)
        check(f"{w}px чат: без горизонтальной прокрутки, нет повторного приветствия над историей", o["sw"] <= o["W"] + 1 and o["welcome"] == 0, o)
        check(f"{w}px поле ввода: скрепка и отправка ≥ 40×40 и в пределах экрана, поле ≥ 120 px, поле видно", min(o["attach"][:2] + o["send"][:2]) >= 40 and max(o["attach"][2], o["send"][2]) <= o["W"] and o["input"] >= 120 and o["formBottom"] <= o["H"] + 1, o)
        check(f"{w}px миниатюры: 2, в пределах экрана, без наложений, «×» ≥ 24 px; кнопки шапки на экране", o["thumbs"] == 2 and o["thumbOut"] == 0 and o["overlap"] == 0 and o["rmMin"] >= 24 and o["actsOut"] == 0, o)
        check(f"{w}px подпись «Отправить»: {'видна' if w >= 768 else 'скрыта (иконка)'}", o["label"] == (w >= 768), o["label"])
        if w in (375, 1280): p.screenshot(path=f"/tmp/ui_mentor_{w}.png", full_page=False)
        if w == 375:
            p.route(re.compile(r".*/api/mentor/message.*"), lambda r: r.abort())
            p.fill("#mnInput", "Текст, который нельзя потерять"); p.click("#mnSend"); p.wait_for_selector("#mnErr:not([hidden])")
            check("375px сбой сети: текст сообщения сохранён в поле, есть «Повторить»", p.input_value("#mnInput") == "Текст, который нельзя потерять" and p.is_visible("#mnRetry"), p.input_value("#mnInput"))
            p.unroute(re.compile(r".*/api/mentor/message.*"))
        c.close()
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
