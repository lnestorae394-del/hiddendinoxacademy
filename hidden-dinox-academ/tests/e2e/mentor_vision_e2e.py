"""AI Mentor Vision в браузере: прикрепление, ответ без служебной заметки, заметка в памяти, уточнение, два изображения,
лимит, уменьшение большого скриншота, вставка из буфера, повреждённый файл. Claude API имитируется. Запуск: python3 tests/e2e/mentor_vision_e2e.py"""
import os, re, json, base64, struct, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); IMG = os.path.join(os.path.dirname(HERE), "fixtures", "images")
PORT = os.environ.get("PORT", "8827"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors, bodies = [], [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
def dims(mime, data):
    b = base64.b64decode(data)
    if mime == "image/png": return struct.unpack(">II", b[16:24])
    i = 2
    while i < len(b):
        m, ln = b[i + 1], struct.unpack(">H", b[i + 2:i + 4])[0]
        if m in (0xC0, 0xC1, 0xC2): h, w = struct.unpack(">HH", b[i + 5:i + 9]); return (w, h)
        i += 2 + ln
def new_ctx(b):
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e)))
    p.on("request", lambda r: bodies.append(r.post_data_json) if "/api/mentor/message" in r.url and r.method == "POST" else None); return ctx, p
def register(p, email):
    p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"))
def wait_reply(p, n): p.wait_for_function(f"document.querySelectorAll('.mn-msg.assistant:not(.mn-welcome)').length>{n}", timeout=15000); return p.locator(".mn-msg.assistant").last.inner_text()

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); register(ap, "owner@test.com"); get("/test/role?uid=owner_test_com&role=admin"); actx.close()
    admin("POST", "/features/ai_mentor/status", {"status": "ACTIVE"})
    ctx, p = new_ctx(b); register(p, "staff@test.com"); get("/test/role?uid=staff_test_com&role=team_member")
    p.goto(B + "/academy/mentor.html"); p.wait_for_selector("#mnInput", timeout=15000)
    p.set_input_files("#mnImage", os.path.join(IMG, "chart.png")); p.wait_for_function("document.getElementById('mnAttach').textContent.includes('chart.png')")
    check("миниатюра прикреплённого файла: имя, размер, кнопка удаления", "chart.png" in p.inner_text("#mnAttach") and "КБ" in p.inner_text("#mnAttach") and p.locator("#mnAttach [data-rm]").count() == 1 and p.locator("#mnAttach img").count() == 1)
    n = p.locator(".mn-msg.assistant:not(.mn-welcome)").count(); p.fill("#mnInput", "Разбери структуру"); p.press("#mnInput", "Enter"); rep = wait_reply(p, n)
    sent = bodies[-1]
    check("отправлено как images: PNG 480×300 без изменений", sent.get("images") and sent["images"][0]["mime_type"] == "image/png" and dims("image/png", sent["images"][0]["data"]) == (480, 300), [x.get("mime_type") for x in sent.get("images", [])])
    check("ответ по скриншоту без служебной заметки", "Разбор скриншота (1 изобр.)" in rep and "chart_note" not in rep and "EUR/USD OTC; M1" not in rep, rep)
    p.click("#mnMemory"); p.wait_for_selector("#mnUseProfile")
    check("заметка по графику в «Что помнит наставник»", "EUR/USD OTC; M1; изображений 1" in p.inner_text("#mnMemPanel"))
    p.click("#mnMemClose")
    n = p.locator(".mn-msg.assistant:not(.mn-welcome)").count(); p.fill("#mnInput", "Почему структура нисходящая?"); p.press("#mnInput", "Enter"); wait_reply(p, n)
    check("уточнение отправлено текстом без изображений", not bodies[-1].get("images"))
    p.set_input_files("#mnImage", [os.path.join(IMG, "chart.png"), os.path.join(IMG, "chart.jpg")]); p.wait_for_function("document.getElementById('mnAttach').textContent.includes('chart.jpg')")
    p.set_input_files("#mnImage", os.path.join(IMG, "chart.webp")); p.wait_for_selector("#mnErr:not([hidden])")
    check("третье изображение — понятная ошибка", "не больше 2 изображений" in p.inner_text("#mnErrText"), p.inner_text("#mnErrText"))
    n = p.locator(".mn-msg.assistant:not(.mn-welcome)").count(); p.fill("#mnInput", "Сравни"); p.press("#mnInput", "Enter"); rep = wait_reply(p, n)
    check("два изображения в одном сообщении", len(bodies[-1].get("images", [])) == 2 and "(2 изобр.)" in rep)
    p.set_input_files("#mnImage", os.path.join(IMG, "big-3000x2000.png")); p.wait_for_function("document.querySelectorAll('#mnAttach figure').length>0")
    n = p.locator(".mn-msg.assistant:not(.mn-welcome)").count(); p.fill("#mnInput", "Большой скриншот"); p.press("#mnInput", "Enter"); wait_reply(p, n)
    im = bodies[-1]["images"][0]; w, h = dims(im["mime_type"], im["data"])
    check(f"большой скриншот 3000×2000 уменьшен в браузере до {w}×{h}", max(w, h) == 1568 and abs(w / h - 1.5) < 0.01, (w, h))
    data = base64.b64encode(open(os.path.join(IMG, "chart.jpg"), "rb").read()).decode()
    p.evaluate("""d => { const bin = atob(d), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], "pasted.jpg", { type: "image/jpeg" }));
      document.getElementById("mnInput").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }""", data)
    p.wait_for_function("document.getElementById('mnAttach').textContent.includes('pasted.jpg')", timeout=5000)
    check("скриншот вставлен из буфера обмена", "pasted.jpg" in p.inner_text("#mnAttach"))
    p.click("#mnAttach [data-rm]"); p.wait_for_selector("#mnAttach", state="hidden"); before = len(bodies)
    p.set_input_files("#mnImage", os.path.join(IMG, "corrupt.png")); p.wait_for_selector("#mnErr:not([hidden])")
    check("повреждённый файл — понятная ошибка, запрос не отправлен", p.locator("#mnAttach figure").count() == 0 and len(bodies) == before, p.inner_text("#mnErrText"))
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
