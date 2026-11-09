"""Сквозные проверки интерфейса академии в браузере (Chromium через Playwright).
Запуск: node tests/e2e/test-server.js & python3 tests/e2e/e2e_test.py
Firebase Auth подменяется тестовыми модулями; /api и postback — настоящие обработчики academy/."""
import json, os, re, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8790; B = f"http://127.0.0.1:{PORT}"
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": str(PORT)})
import atexit; atexit.register(lambda: srv.poll() is None and srv.terminate())
assert srv.stdout.readline().strip() == "ready"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))

results = []; errors = []
def check(name, cond, extra=""):
    results.append(("✔ " if cond else "✘ ") + name + (f" — {extra}" if extra and not cond else ""))

def new_page(b, w=375):
    ctx = b.new_context(viewport={"width": w, "height": 812})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"),
              lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: errors.append(str(e)))
    return ctx, p

def page_name(p):                                         # страница входа теперь по «/» (старый адрес /academy/index.html → «/»)
    path = p.url.split("#")[0].split("?")[0].split("://", 1)[-1].split("/", 1)[-1]
    return "index.html" if path in ("", "academy/", "academy/index.html") else (p.url.split("/academy/")[-1] or "index.html")
def wait_page(p, name, t=6000):
    # страница входа открывается по «/» (старый адрес /academy/index.html перенаправляется туда же)
    rx = r"^https?://[^/]+/(academy/index\.html)?(\?[^#]*)?(#.*)?$" if name == "index.html" else ".*/academy/" + re.escape(name) + r"(\?.*)?$"
    try: p.wait_for_url(re.compile(rx), timeout=t); return True
    except Exception: return False

with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ---------- Новый пользователь: регистрация → брокер ----------
    ctx, p = new_page(b)
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    check("страница входа открывается по адресу /academy/", p.is_visible("#loginBtn"))
    p.click("[data-go=register]"); p.fill("#email", "anna@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1")
    p.click("#regBtn")
    check("после регистрации — страница брокера", wait_page(p, "broker.html"))
    p.wait_for_selector("#idForm")
    check("Firebase инициализирован один раз", p.evaluate("window.__fbInitCount") == 1)
    check("на localhost — эмулятор Auth и демо-проект", p.evaluate("window.__emulatorUrl") == "http://127.0.0.1:9099" and p.evaluate("window.HD_FIREBASE_CONFIG.projectId") == "demo-hd-academy")
    # Партнёрская ссылка с устойчивым click_id
    p.click("#pocketBtn"); p.wait_for_timeout(400)
    p.click("#pocketBtn"); p.wait_for_timeout(400)
    opened = p.evaluate("window.__opened")
    base = "https://u3.shortink.io/register?utm_campaign=836358&utm_source=affiliate&utm_medium=sr&a=h9nxhW8rfWngjm&al=1805745&ac=academy&cid=987453&code=BTM134&click_id="
    check("кнопка POCKET открывает партнёрскую ссылку без изменений + click_id", len(opened) == 2 and opened[0].startswith(base) and re.fullmatch(r"hd_[0-9a-f]{32}", opened[0][len(base):]) is not None, str(opened[:1]))
    check("click_id одинаковый при повторных нажатиях", len(set(opened)) == 1)
    click_id = opened[0][len(base):]
    # Trader ID: формат, затем случайный ID без postback
    p.fill("#traderId", "12ab"); p.click("#idBtn"); p.wait_for_timeout(200)
    check("неверный формат Trader ID — ошибка у поля", p.is_visible("#e_traderId") and p.inner_text("#e_traderId") != "")
    p.fill("#traderId", "55500011"); p.click("#idBtn"); p.wait_for_timeout(700)
    check("ID без подтверждённой регистрации отклонён, понятная ошибка", "не подтверждён для вашего аккаунта" in p.inner_text("#e_traderId") and "broker.html" in p.url, p.inner_text("#e_traderId"))
    # Pocket Partners присылает регистрацию → ID принимается
    r0 = postback(click_id=click_id, trader_id="55500011")
    check("Registration postback принят", r0["status"] == "registration_confirmed" and r0["http"] == 200, str(r0))
    p.click("#idBtn")
    check("после подтверждения ID принят — страница проверки баланса", wait_page(p, "deposit.html"))
    p.wait_for_selector(".statuscard")
    check("состояние «ожидание», сумма не подтверждена", "Ожидаем подтверждение депозита" in p.inner_text(".statuscard") and "$ —" in p.inner_text(".amount"))
    check("на странице депозита показан минимум $50", "$50" in p.inner_text(".req"))
    # «Изменить ID» без цикла; новый ID тоже должен быть подтверждён
    p.click("#changeId")
    check("«Изменить» открывает ввод ID и не возвращает обратно", wait_page(p, "broker.html") and (p.wait_for_timeout(1500) or True) and "broker.html" in p.url)
    p.wait_for_selector("#idForm")
    check("поле заполнено текущим ID", p.input_value("#traderId") == "55500011")
    p.fill("#traderId", "55500012"); p.click("#idBtn"); p.wait_for_timeout(700)
    check("смена на неподтверждённый ID отклонена", "не подтверждён" in p.inner_text("#e_traderId"))
    postback(click_id=click_id, trader_id="55500012")
    p.click("#idBtn")
    check("смена на подтверждённый ID — снова проверка баланса", wait_page(p, "deposit.html"))
    p.wait_for_selector("#depTid"); p.wait_for_timeout(500)
    check("показан новый Trader ID", p.inner_text("#depTid") == "55500012")
    # Подтверждения от «партнёра» (настоящий обработчик postback)
    r2 = postback(click_id=click_id, trader_id="55500012", amount="39.99", currency="USD")
    check("First Deposit $39.99 принят", r2["status"] == "ftd_recorded", str(r2))
    p.wait_for_selector(".statuscard.s-low", timeout=8000)
    txt = p.inner_text("#main")
    check("$39.99: доступ закрыт, понятное сообщение «подтверждено $39.99 из $50, осталось $10.01»", "Депозит пока меньше $50" in txt and re.search(r"Подтверждено: \$39\.99 из \$50(\.00)?\. Осталось внести \$10\.01", txt) is not None and "academy.html" not in p.url, txt[:300])
    check("порог $40 нигде не показан", not re.search(r"\$\s?40\b", txt))
    check("пункт «Первый депозит подтверждён» без галочки", p.locator(".checks li", has_text="Первый депозит подтверждён").get_attribute("class") == "wait")
    check("смена ID скрыта после подтверждённого депозита", not p.is_visible("#changeId"))
    p.click(".langs button[data-lang=en]"); p.wait_for_timeout(300)
    check("перевод EN для недостаточного депозита", "Deposits are below $50 so far" in p.inner_text("#main"))
    p.click(".langs button[data-lang=ru]")
    r3 = postback(click_id=click_id, trader_id="55500012", amount="5", currency="USD", type="redeposit")
    p.reload(); p.wait_for_selector(".statuscard"); p.wait_for_timeout(1500)
    check("пополнение $5 суммируется: $44.99 из $50 — доступ ещё закрыт", r3["status"] == "redeposit_recorded" and "deposit.html" in p.url and "$44.99" in p.inner_text("#depStatus"), [str(r3)[:60], p.inner_text("#depStatus")[:300]])
    # прямое открытие академии и попытка сменить ID через URL
    p.goto(B + "/academy/academy.html")
    check("прямое открытие academy.html без доступа → страница проверки", wait_page(p, "deposit.html"))
    p.goto(B + "/academy/broker.html?change=1")
    check("broker.html?change=1 при заблокированном ID → обратно на проверку", wait_page(p, "deposit.html"))
    ctx.close()

    # ---------- Второй пользователь: $40.00 → ещё закрыто; +$10 на тот же аккаунт → академия ----------
    ctx, p = new_page(b)
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.click("[data-go=register]"); p.fill("#email", "boris@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn")
    wait_page(p, "broker.html"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_timeout(300); cid2 = p.evaluate("window.__opened")[0][len(base):]
    p.fill("#traderId", "55500012"); p.click("#idBtn"); p.wait_for_timeout(800)
    check("чужой подтверждённый Trader ID нельзя привязать", "не подтверждён для вашего аккаунта" in p.inner_text("#e_traderId"), p.inner_text("#e_traderId"))
    postback(click_id=cid2, trader_id="55500020")
    p.fill("#traderId", "55500020"); p.click("#idBtn"); wait_page(p, "deposit.html"); p.wait_for_selector(".statuscard")
    postback(click_id=cid2, trader_id="55500020", amount="40.00", currency="USD")
    p.wait_for_selector(".statuscard.s-low", timeout=8000)
    check("$40.00: доступ ещё закрыт — «Осталось внести $10»", re.search(r"Осталось внести \$10(\.00)?", p.inner_text("#depStatus")) is not None and "deposit.html" in p.url, p.inner_text("#depStatus")[:200])
    postback(click_id=cid2, trader_id="55500020", amount="10.00", currency="USD", type="redeposit")
    # страница сама проверяет пополнение (раз в 30 с при сумме ниже $50) — без нажатия кнопки и без новой регистрации
    check("+$10 на тот же аккаунт: сумма $50 — страница сама замечает пополнение и открывает академию", wait_page(p, "academy.html", 40000))
    p.wait_for_selector(".row.key .dot.ok", timeout=6000)
    check("в академии «Активирован» из ответа сервера", "Активирован" in p.inner_text("#statusBody"))
    check("Trader ID в академии замаскирован", "••••0020" in p.inner_text("#statusBody") and "55500020" not in p.inner_text("#statusBody"))
    p.reload(); p.wait_for_selector(".row.key .dot.ok", timeout=6000)
    check("после обновления страницы сессия восстановлена, этап — академия", "academy.html" in p.url)
    sw = p.evaluate("document.documentElement.scrollWidth")
    check("академия без горизонтальной прокрутки на 375 px", sw == 375, str(sw))
    # Ошибка сервера: доступ не показывается
    get("/test/outage?on=1"); p.reload(); p.wait_for_selector(".errbox", timeout=6000)
    check("сбой базы: показана ошибка, «Активирован» не показан", "Активирован" not in p.inner_text("#statusBody"))
    get("/test/outage?on=0")
    # Выход и повторный вход
    p.reload(); p.wait_for_selector(".row.key"); p.click(".p-profile [data-signout]")
    check("выход → страница входа", wait_page(p, "index.html"))
    p.goto(B + "/academy/academy.html")
    check("после выхода academy.html недоступна → вход", wait_page(p, "index.html"))
    p.wait_for_selector("#loginForm"); p.fill("#email", "boris@test.com"); p.fill("#password", "wrongpass"); p.click("#loginBtn"); p.wait_for_timeout(500)
    check("неверный пароль — понятная ошибка", "Неверный email или пароль" in p.inner_text("#noticeText"))
    p.fill("#password", "password1"); p.click("#loginBtn")
    check("повторный вход → сразу академия", wait_page(p, "academy.html"))
    ctx.close()

    # ---------- Повторная регистрация того же email, сброс пароля, сбой сети ----------
    ctx, p = new_page(b)
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.evaluate("localStorage.setItem('fakeFbAccounts', JSON.stringify({'anna@test.com':'password1'}))")
    p.click("[data-go=register]"); p.fill("#email", "anna@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_timeout(500)
    check("повторная регистрация email — предложение войти", "уже есть" in p.inner_text("#noticeText"))
    p.click("[data-go=login]"); p.click("[data-go=reset]"); p.fill("#email", "nobody@test.com"); p.click("#resetBtn"); p.wait_for_timeout(400)
    check("сброс пароля не раскрывает, есть ли аккаунт", "Если аккаунт с этим email существует" in p.inner_text("#noticeText"))
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.evaluate("window.__fakeNetDown=true")
    p.click("[data-go=register]"); p.fill("#email", "c@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_timeout(500)
    check("ошибка сети при регистрации — сообщение, кнопка снова активна", "Нет связи" in p.inner_text("#noticeText") and p.is_enabled("#regBtn"))
    ctx.close()

    # ---------- Тестовый депозит $69 по Trader ID 142807701 (без click_id) ----------
    ctx, p = new_page(b)
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.click("[data-go=register]"); p.fill("#email", "tester142807701@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn")
    wait_page(p, "broker.html"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_timeout(300); tclick = p.evaluate("window.__opened")[0][len(base):]
    postback(click_id=tclick, trader_id="142807701")
    p.fill("#traderId", "142807701"); p.click("#idBtn")
    check("142807701: ID подтверждён и привязан — страница проверки баланса", wait_page(p, "deposit.html"))
    p.wait_for_selector(".statuscard")
    link = B + "/test/deposit?trader_id=142807701&amount=69&currency=USD&test_secret=local-test-deposit-secret-only-0001"
    tab = ctx.new_page(); resp = tab.goto(link); body = json.loads(tab.inner_text("body"))
    check("тестовая ссылка $69 USD → 200 ftd_recorded", resp.status == 200 and body["status"] == "ftd_recorded", str(body))
    resp2 = tab.goto(link); body2 = json.loads(tab.inner_text("body"))
    check("повторное открытие ссылки → duplicate, без двойного учёта", body2["status"] == "duplicate", str(body2))
    bad = tab.goto(B + "/test/deposit?trader_id=142807701&amount=69&currency=USD&test_secret=wrong-secret-xxxxxxxxxxxxxxxx")
    check("ссылка с неверным test_secret → 403", bad.status == 403)
    tab.close()
    check("интерфейс сам увидел депозит и перевёл в академию", wait_page(p, "academy.html", 12000))
    p.wait_for_selector(".row.key .dot.ok", timeout=6000)
    st = p.inner_text("#statusBody")
    check("в академии: «Активирован», первый депозит $69, ID ••••7701", "Активирован" in st and "$69" in st and "••••7701" in st, st)
    p.screenshot(path="/tmp/e2e_academy_142807701.png", full_page=True)
    ctx.close()

    # ---------- Pocket Partners со своим click_id: пользователь вводит только Trader ID ----------
    ctx, p = new_page(b)
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.click("[data-go=register]"); p.fill("#email", "pp-user@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn")
    wait_page(p, "broker.html"); p.wait_for_selector("#idForm")
    rr = postback(type="registration", click_id="ppclick_555001", trader_id="77700001")
    check("PP: регистрация с click_id платформы сохранена по trader_id", rr["status"] == "registration_confirmed" and rr["http"] == 200, str(rr))
    p.fill("#traderId", "77700001"); p.click("#idBtn")
    check("PP: пользователь ввёл только Trader ID — принят, страница проверки баланса", wait_page(p, "deposit.html"))
    p.wait_for_selector(".statuscard")
    calls = []
    p.on("request", lambda r: calls.append(r.url) if "/check-deposit" in r.url else None)
    p.wait_for_timeout(3500)
    check("страница проверки баланса опрашивает /check-deposit (без trader_id в адресе)", len(calls) >= 1 and all("trader_id=" not in c for c in calls), str(calls[:2]))
    rf = postback(type="ftd", click_id="ppclick_555001", trader_id="77700001", amount="69", currency="USD")
    check("PP: FTD $69 по trader_id учтён", rf["status"] == "ftd_recorded", str(rf))
    check("PP: интерфейс перевёл в академию", wait_page(p, "academy.html", 12000))
    p.wait_for_selector(".row.key .dot.ok", timeout=6000)
    check("PP: в академии «Активирован», $69", "Активирован" in p.inner_text("#statusBody") and "$69" in p.inner_text("#statusBody"))
    # подмена в браузере не даёт доступа другому пользователю
    ctx2, q = new_page(b)
    q.goto(B + "/academy/"); q.wait_for_selector("#loginForm")
    q.click("[data-go=register]"); q.fill("#email", "eve-pp@test.com"); q.fill("#password", "password1"); q.fill("#password2", "password1"); q.click("#regBtn")
    wait_page(q, "broker.html"); q.wait_for_selector("#idForm")
    q.fill("#traderId", "77700001"); q.click("#idBtn"); q.wait_for_timeout(800)
    check("другой пользователь не может привязать занятый Trader ID", "broker.html" in q.url and q.inner_text("#e_traderId") != "", q.inner_text("#e_traderId"))
    st = q.evaluate("""async () => { const t = await (await window.__hdFbResolve, Promise.resolve()); 
        const tok = 'testtoken-' + 'eve_pp_test_com';
        const r = await fetch('/check-deposit?trader_id=77700001', { headers: { Authorization: 'Bearer ' + tok } }); return [r.status, await r.text()]; }""")
    check("/check-deposit с чужим trader_id из браузера → 403, сумма не раскрыта", st[0] == 403 and "69" not in st[1], str(st))
    nt = q.evaluate("async () => { const r = await fetch('/check-deposit?trader_id=77700001'); return r.status; }")
    check("/check-deposit без входа → 401", nt == 401, str(nt))
    ctx2.close(); ctx.close()

    # ---------- На не-локальном адресе — настоящий проект, без эмулятора ----------
    ctx, p = new_page(b)
    ctx.route(re.compile(r"https://academy\.example/.*"), lambda r: r.fulfill(response=r.fetch(url=r.request.url.replace("https://academy.example", B))))
    p.goto("https://academy.example/academy/"); p.wait_for_selector("#loginForm")
    check("на production-адресе — проект ai-boost-10540, эмулятор не подключается",
          p.evaluate("window.HD_FIREBASE_CONFIG.projectId") == "ai-boost-10540" and p.evaluate("window.__emulatorUrl") is None)
    ctx.close()

    # ---------- Адаптивность 320 px ----------
    for h in [568, 640, 700, 812]:
        ctx, p = new_page(b, 320); p.set_viewport_size({"width": 320, "height": h})
        p.goto(B + "/academy/"); p.wait_for_selector("#main .screen"); p.wait_for_timeout(900)
        check(f"вход: нет горизонтальной прокрутки на 320×{h}", p.evaluate("document.documentElement.scrollWidth") == 320)
        if h == 700: p.screenshot(path="/tmp/e2e_login_320.png")
        ctx.close()
    b.close()

srv.terminate()
print("\n".join(results))
print("ошибки JavaScript на страницах:", errors or "нет")
fails = sum(1 for r in results if r.startswith("✘"))
print(f"итого: {len(results) - fails} из {len(results)}")
sys.exit(1 if fails or errors else 0)
