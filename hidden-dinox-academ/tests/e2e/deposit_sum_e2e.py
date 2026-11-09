"""Сумма депозитов в браузере: $20 → «Подтверждено $20 из $50, осталось $30» → +$30 → академия открывается сама.
Плюс сообщение на EN и карточка пользователя в админке. Запуск: python3 tests/e2e/deposit_sum_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8791"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:300]}"))
def new_page(b, w, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": 900})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};" + (f"localStorage.setItem('hd_lang','{lang}');" if lang else ""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def to_deposit(p, email, tid):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=10000)
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id=tid); p.fill("#traderId", tid); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    return click
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx, p = new_page(b, 390); click = to_deposit(p, "sum@test.com", "88800001")
    postback(type="ftd", click_id=click, trader_id="88800001", amount="20", currency="USD")
    p.click("#checkBtn"); p.wait_for_function("document.getElementById('depStatus') && document.getElementById('depStatus').textContent.includes('Подтверждено')", timeout=10000)
    st = p.inner_text("#depStatus")
    check("$20: «Подтверждено: $20 из $50. Осталось внести $30»", re.search(r"Подтверждено: \$20(\.00)? из \$50(\.00)?\. Осталось внести \$30(\.00)?", st) is not None, st)
    check("$20: подсказка — можно пополнить тот же аккаунт, депозиты суммируются; доступ закрыт", "пополнить тот же аккаунт" in st and "суммируются" in st and "deposit.html" in p.url, st)
    check("$20: нет прежней фразы «повторные пополнения не засчитываются»", "не засчитываются" not in st)
    postback(type="redeposit", click_id=click, trader_id="88800001", amount="30", currency="USD")
    p.click("#checkBtn"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    check("+$30: сумма $50 — академия открылась сама, без новой регистрации", "academy.html" in p.url)
    ctx.close()
    ctx, p = new_page(b, 390, "en"); click = to_deposit(p, "sumen@test.com", "88800002")
    postback(type="ftd", click_id=click, trader_id="88800002", amount="10", currency="USD")
    p.click("#checkBtn"); p.wait_for_function("document.getElementById('depStatus').textContent.includes('Confirmed')", timeout=10000)
    st = p.inner_text("#depStatus")
    check("EN: «Confirmed: $10 of $50. $40 left to deposit» и подсказка о суммировании", re.search(r"Confirmed: \$10(\.00)? of \$50(\.00)?\. \$40(\.00)? left to deposit", st) is not None and "confirmed deposits add up" in st, st)
    ctx.close()
    ctx, p = new_page(b, 1280); p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", "boss@test.com"); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"))
    get("/test/role?uid=boss_test_com&role=super_admin")
    p.goto(B + "/admin/#/users"); p.wait_for_selector("#main"); p.goto(B + "/admin/#/users/sum_test_com"); p.wait_for_function("document.getElementById('main').textContent.includes('Депозиты и доступ')", timeout=10000)
    m = p.inner_text("#main")
    check("админка: карточка — Trader ID, подтверждено $50.00 из $50.00, доступ открыт (сумма), оба депозита", "88800001" in m and "$50.00 из $50.00" in m and "сумма депозитов от $50" in m and m.count("засчитан") >= 2, m[m.find("Депозиты и доступ"):][:400])
    ctx.close(); b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
