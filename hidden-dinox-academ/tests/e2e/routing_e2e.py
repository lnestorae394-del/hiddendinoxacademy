"""Маршрутизация: страница входа по чистому «/», старые адреса → «/», ресурсы, сценарии и API.
Запуск: python3 tests/e2e/routing_e2e.py"""
import os, re, json, subprocess, urllib.request, http.client
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8799"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors, bad_requests = [], [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def raw(path):
    c = http.client.HTTPConnection("127.0.0.1", int(PORT)); c.request("GET", path); r = c.getresponse(); body = r.read(); c.close(); return r.status, dict(r.getheaders()), body
def new_page(b, w=1280, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": 860})
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e)))
    p.on("response", lambda r: bad_requests.append((r.status, r.url)) if r.url.startswith(B) and r.status >= 400 and "/api/" not in r.url else None)
    return ctx, p
path_of = lambda url: url.split("://", 1)[-1].split("/", 1)[-1].split("#")[0]

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
    # ---------- HTTP ----------
    st, h, body = raw("/")
    check("GET / → 200, страница входа (не «Cannot GET /»)", st == 200 and b"Cannot GET" not in body and b'id="main"' in body and b"js/pages/login.js" in body, st)
    check("GET / отдаёт тот же файл public/academy/index.html (не копию)", body == open(os.path.join(HERE, "../../public/academy/index.html"), "rb").read())
    check("в странице <base href=\"/academy/\"> до первого относительного пути", body.index(b'<base href="/academy/">') < body.index(b'href="assets/'))
    for old, want in (("/academy/index.html", "/"), ("/academy/", "/"), ("/academy", "/"), ("/academy/index.html?via=abc&lang=en", "/?via=abc&lang=en")):
        st, h, _ = raw(old)
        check(f"{old} → 302 на {want}", st == 302 and h.get("Location") == want, (st, h.get("Location")))
    st, h, _ = raw("/academy/index.html?next=https://evil.example")
    check("перенаправление только на «/» (открытого редиректа нет)", h.get("Location", "").startswith("/?") and h.get("Location", "")[1:2] != "/", h.get("Location"))
    for pth in ("/academy/academy.html", "/academy/learn.html", "/academy/reset-password.html", "/academy/css/auth.css", "/academy/js/api.js", "/academy/assets/brand/hd-logo.png"):
        st, _, _ = raw(pth); check(f"{pth} → 200 (старые пути страниц и ресурсов работают)", st == 200, st)

    with sync_playwright() as pw:
        b = pw.chromium.launch()
        # ---------- «/» в браузере ----------
        ctx, p = new_page(b); bad_requests.clear()
        p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.wait_for_load_state("networkidle")
        check("в адресной строке «/», а не /academy/index.html", path_of(p.url) == "", p.url)
        check("все ресурсы страницы загрузились (CSS, JS, изображения) — без 404", not bad_requests, bad_requests[:5])
        check("стили применены (страница не «голая»)", p.evaluate("getComputedStyle(document.body).backgroundColor") not in ("rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"), p.evaluate("getComputedStyle(document.body).backgroundColor"))
        check("логотип и маскот отображаются", p.evaluate("[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length") >= 2)
        p.click(".langs button[data-lang=en]"); p.wait_for_timeout(300)
        check("переключение языка на «/» (EN)", "Sign in" in p.inner_text("main") or "Log in" in p.inner_text("main"), p.inner_text("main")[:80])
        p.click(".langs button[data-lang=ua]"); p.wait_for_timeout(300); check("переключение языка на «/» (UA)", "Увійти" in p.inner_text("main"), p.inner_text("main")[:80])
        p.click(".langs button[data-lang=ru]"); p.wait_for_timeout(300)
        # регистрация с «/»
        p.click("[data-go=register]"); p.fill("#email", "route@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn")
        p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000); check("регистрация с «/» → broker.html", "broker.html" in p.url)
        # выход → снова «/»
        p.evaluate("signOutAndLeave()"); p.wait_for_selector("#loginForm"); p.wait_for_load_state("networkidle")
        check("выход ведёт на «/» (без /academy/index.html)", path_of(p.url) == "", p.url)
        # вход с «/»
        p.fill("#email", "route@test.com"); p.fill("#password", "password1"); p.click("#loginBtn")
        p.wait_for_url(re.compile(r".*(broker|deposit|academy)\.html"), timeout=8000); check("вход с «/»", re.search(r"(broker|deposit|academy)\.html", p.url))
        ctx.close()
        # старый адрес в браузере → «/», якорь сохраняется
        ctx, p = new_page(b); p.goto(B + "/academy/index.html#register"); p.wait_for_selector("#regForm")
        check("старый адрес /academy/index.html#register → «/#register», открыт экран регистрации", path_of(p.url) == "" and p.url.endswith("#register"), p.url)
        ctx.close(); ctx, p = new_page(b)                      # «/#reset» — новая загрузка (смена одного #якоря страницу не перезагружает — так было и раньше)
        p.goto(B + "/#reset"); p.wait_for_selector("#resetForm")
        check("«/#reset» открывает восстановление пароля", p.is_visible("#resetForm"))
        p.fill("#email", "route@test.com")
        with p.expect_response(lambda r: "/api/auth/forgot-password" in r.url) as rr: p.click("#resetBtn")
        check("API с «/»: POST /api/auth/forgot-password → 200", rr.value.status == 200, rr.value.status)
        ctx.close()
        # страница сброса пароля: ссылки назад ведут на «/»
        ctx, p = new_page(b); p.goto(B + "/academy/reset-password.html"); p.wait_for_selector("#rpBadText")
        check("со страницы сброса «Запросить новую ссылку» → «/#reset», «Назад» → «/»", p.get_attribute("#rpNewLink", "href") == "/#reset" and p.get_attribute(".switch a", "href") == "/", (p.get_attribute("#rpNewLink", "href"), p.get_attribute(".switch a", "href")))
        p.click("#rpNewLink"); p.wait_for_selector("#resetForm"); check("переход по ней открывает восстановление на «/»", path_of(p.url) == "", p.url)
        ctx.close()
        # обучение без входа → «/»
        ctx, p = new_page(b); p.goto(B + "/academy/learn.html"); p.wait_for_selector("#loginForm", timeout=10000)
        check("обучение без входа → страница входа на «/»", path_of(p.url) == "", p.url); ctx.close()
        b.close()
    # старые «чистые» маршруты без файлов не дают 500 (на настоящем сервере проверяется boot-сценарием)
    st, _, _ = raw("/api/me"); check("API без токена → 401 (маршруты /api не перекрыты)", st == 401, st)
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
