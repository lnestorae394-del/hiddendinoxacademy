"""Восстановление пароля письмом Hidden Dinox Academy: «Забыли пароль?» → POST /api/auth/forgot-password (настоящий обработчик)
→ письмо (почта тестового сервера) → ссылка на /academy/reset-password.html → новый пароль (Firebase SDK) → вход.
Запуск: python3 tests/e2e/forgot_e2e.py"""
import os, re, json, subprocess, urllib.request, urllib.parse
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8798"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
ACC = "if(!localStorage.getItem('fakeFbAccounts'))localStorage.setItem('fakeFbAccounts',JSON.stringify({'learner@test.com':'password1'}));"   # только при первом открытии — не затирает новый пароль
def new_page(b, w=1280, lang=None, init=""):
    ctx = b.new_context(viewport={"width": w, "height": 860})
    ctx.add_init_script(("localStorage.setItem('hd_lang','%s');" % lang if lang else "") + init)
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
ON_LOGIN = lambda url: url.split("#")[0].split("?")[0].endswith(("/academy/index.html", PORT + "/"))   # страница входа: «/» или старый адрес
def forgot(p, email):
    p.goto(B + "/academy/index.html#reset"); p.wait_for_selector("#resetForm"); p.fill("#email", email)
    with p.expect_response(lambda r: "/api/auth/forgot-password" in r.url) as rr: p.click("#resetBtn")
    p.wait_for_selector("#notice.show"); return rr.value, p.inner_text("#noticeText")

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    get("/test/fb-user?email=learner@test.com")
    ctx, p = new_page(b, init=ACC)
    resp, msg_ok = forgot(p, "learner@test.com")
    check("форма отправляет запрос на наш сервер, ответ 200", resp.status == 200 and resp.request.method == "POST", resp.status)
    check("Firebase sendPasswordResetEmail больше не вызывается", p.evaluate("window.__resetSentTo") is None)
    box = get("/test/outbox"); mail = box[-1] if box else {}
    check("письмо отправлено на адрес пользователя", mail.get("to") == "learner@test.com", mail.get("to"))
    check("тема и текст — Hidden Dinox Academy, кнопка «Сбросить пароль», срок действия, без ai-boost", "Hidden Dinox Academy" in mail.get("subject", "") and "Сбросить пароль" in mail.get("html", "") and "около 1 часа" in mail.get("html", "") and not re.search("ai-boost", mail.get("html", "") + mail.get("subject", ""), re.I))
    link = re.search(r"https://academy\.example/academy/reset-password\.html\?mode=resetPassword&oobCode=([^&\s]+)&lang=ru", mail.get("text", ""))
    check("ссылка ведёт на существующую страницу /academy/reset-password.html с oobCode и языком", bool(link), mail.get("text", "")[:300])
    code = link.group(1) if link else "X"
    # второй адрес — несуществующий: то же сообщение, письма нет
    resp2, msg_no = forgot(p, "nobody@test.com")
    n_before = len(box); box2 = get("/test/outbox")
    check("несуществующий email: тот же ответ и то же сообщение, письмо не отправлено", resp2.status == 200 and msg_no == msg_ok and len(box2) == n_before, (resp2.status, msg_no, len(box2)))
    ctx.close()
    # переход по ссылке из письма → новый пароль (Firebase confirmPasswordReset) → вход
    seed = ACC + "if(!localStorage.getItem('fakeFbCodes'))localStorage.setItem('fakeFbCodes',JSON.stringify({%s:{email:'learner@test.com',state:'ok'}}));" % json.dumps(code)
    ctx, p = new_page(b, init=seed)
    p.goto(B + f"/academy/reset-password.html?mode=resetPassword&oobCode={urllib.parse.quote(code)}&lang=ru"); p.wait_for_selector("#rpForm")
    check("страница из письма открывает форму нового пароля для этого email", "learner@test.com" in p.inner_text("main"))
    p.fill("#password", "brandnew77"); p.fill("#password2", "brandnew77"); p.click("#rpBtn"); p.wait_for_selector("#toLogin")
    check("пароль изменён через Firebase", "Пароль изменён" in p.inner_text("main"))
    p.click("#toLogin"); p.wait_for_selector("#loginForm"); p.fill("#email", "learner@test.com"); p.fill("#password", "brandnew77"); p.click("#loginBtn")
    for _ in range(40):
        if not ON_LOGIN(p.url) or p.is_visible("#notice.show"): break
        p.wait_for_timeout(200)
    bad = p.is_visible("#notice.show") and p.inner_text("#noticeText")
    check("вход с новым паролем (страница входа пройдена, ошибки пароля нет)", not ON_LOGIN(p.url) and not bad, (p.url, bad))
    ctx.close()
    # язык письма = язык интерфейса
    ctx, p = new_page(b, lang="en", init=ACC); forgot(p, "learner@test.com"); m = get("/test/outbox")[-1]
    check("язык интерфейса EN → письмо на английском (Reset password, lang=en)", "Reset password" in m["html"] and "lang=en" in m["text"]); ctx.close()
    ctx, p = new_page(b, lang="ua", init=ACC); forgot(p, "learner@test.com"); m = get("/test/outbox")[-1]
    check("UA → письмо на украинском (Скинути пароль, lang=uk)", "Скинути пароль" in m["html"] and "lang=uk" in m["text"]); ctx.close()
    # лимит: 3 письма на адрес в час → 4-й запрос 429 и понятное сообщение
    ctx, p = new_page(b, init=ACC); resp4, msg4 = forgot(p, "learner@test.com")
    check("4-й запрос на тот же адрес за час → 429 и сообщение «слишком много попыток»", resp4.status == 429 and len(msg4) > 5, (resp4.status, msg4)); ctx.close()
    # почта на сервере не настроена (503) → запасной вариант: письмо Firebase, пользователь видит то же сообщение
    get("/test/forgot-off?on=1")
    ctx, p = new_page(b, init=ACC); resp5, msg5 = forgot(p, "other@test.com"); p.wait_for_function("window.__resetSentTo")
    check("почта не настроена (503) → запасной вариант Firebase, то же сообщение", resp5.status == 503 and p.evaluate("window.__resetSentTo") == "other@test.com" and msg5 == msg_ok, (resp5.status, msg5)); ctx.close()
    get("/test/forgot-off?on=0")
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
