"""Этап 1: карточки функций Academy — администратор управляет в админке, ученик видит изменения сразу (без деплоя).
Запуск: python3 tests/e2e/feature_cards_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8801"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def api(method, path, uid, body=None):
    r = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-" + uid, **({"Content-Type": "application/json"} if body is not None else {})})
    try: return urllib.request.urlopen(r).status, None
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
def new_page(b, w=1280, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": 900})
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
def give_access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id={trader}&secret={sec}")
    p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id={trader}&amount=60&currency=USD&secret={sec}")
def home_cards(p):
    p.goto(B + "/academy/academy.html"); p.wait_for_selector("#secsList [data-feature]", timeout=10000)
    return p.eval_on_selector_all("#secsList [data-feature]", "a=>a.map(x=>({id:x.dataset.feature,tag:x.tagName,title:x.querySelector('h3').textContent,label:x.querySelector('.tag').textContent.trim(),href:x.getAttribute('href')}))")

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ученик с доступом
    sctx, sp = new_page(b); register(sp, "stu@test.com"); give_access(sp, "88800011")
    cards = home_cards(sp)
    check("главная ученика: только две карточки (ИИ-помощник, Ежедневные тесты), «Скоро», без ссылок; Тренировки и Подготовки нет",
          [c["id"] for c in cards] == ["ai_mentor", "daily_tests"] and all(c["tag"] == "ARTICLE" and c["href"] is None and c["label"] == "Скоро" for c in cards)
          and "Тренировка на графике" not in sp.inner_text("body") and "Подготовка к торговой сессии" not in sp.inner_text("body"), cards)
    sp.click("#secsList [data-feature=ai_mentor]"); sp.wait_for_selector("#toast.show")
    check("нажатие на «Скоро» не открывает несуществующую страницу, показывает подсказку", "academy.html" in sp.url and "разработке" in sp.inner_text("#toast"))
    st, err = api("GET", "/admin/api/features", "stu_test_com"); st2, _ = api("POST", "/admin/api/features/ai_mentor/status", "stu_test_com", {"status": "DISABLED"})
    check("ученик не может читать и менять карточки через API админки (403)", st == 403 and st2 == 403, (st, st2))
    # администратор
    actx, ap = new_page(b); register(ap, "owner@test.com"); get("/test/role?uid=owner_test_com&role=admin")
    ap.goto(B + "/admin/#/features"); ap.wait_for_selector("[data-fedit]", timeout=10000)
    check("админка: раздел «Функции Academy» со всеми стандартными карточками", ap.locator("[data-fedit]").count() == 4 and "Функции Academy" in ap.inner_text("#nav"))
    ap.select_option("select[data-fst=daily_tests]", "IN_DEVELOPMENT"); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit]")
    cards = home_cards(sp); dt = next(c for c in cards if c["id"] == "daily_tests")
    check("смена статуса в админке видна ученику сразу, без деплоя («В разработке»)", dt["label"] == "В разработке", dt)
    # редактирование с предпросмотром
    ap.click("[data-fedit=ai_mentor]"); ap.wait_for_selector("#fpv")
    ap.fill("input[name=title_ru]", "ИИ-наставник"); ap.fill("input[name=title_en]", "AI Coach"); ap.fill("input[name=description_ru]", "Повторение перед сессией")
    check("предпросмотр обновляется при вводе", "ИИ-наставник" in ap.inner_text("#fpv"))
    ap.select_option("#fLang", "en"); check("предпросмотр на EN", "AI Coach" in ap.inner_text("#fpv")); ap.select_option("#fLang", "ru")
    ap.locator("#modalBody button", has_text="Сохранить").click(); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit]")
    ru = next(c for c in home_cards(sp) if c["id"] == "ai_mentor")
    check("новые тексты у ученика (RU)", ru["title"] == "ИИ-наставник", ru)
    ectx, ep = new_page(b, lang="en"); ep.goto(B + "/academy/index.html"); ep.wait_for_selector("#loginForm"); ep.fill("#email", "stu@test.com"); ep.fill("#password", "password1")
    # аккаунт в подменном Firebase хранится в localStorage первого контекста — повторяем вход через регистрацию нельзя, поэтому проверяем EN во вкладке ученика
    ectx.close()
    sp.click(".langs button[data-lang=en]"); sp.wait_for_function("document.querySelector('#secsList [data-feature=ai_mentor] h3') && document.querySelector('#secsList [data-feature=ai_mentor] h3').textContent==='AI Coach'", timeout=8000)
    en = {c["id"]: c for c in home_cards(sp)}
    check("язык EN: свой текст и переведённые статусы", en["ai_mentor"]["title"] == "AI Coach" and en["daily_tests"]["label"] == "In development" and "chart_training" not in en, en)
    sp.click(".langs button[data-lang=ua]"); sp.wait_for_timeout(600); ua = {c["id"]: c for c in home_cards(sp)}
    check("язык UA: украинский текст карточки (не менялся администратором) и статус по-украински", ua["ai_mentor"]["title"] == "ШІ-помічник" and ua["daily_tests"]["label"] == "У розробці" and "chart_training" not in ua, ua)
    sp.click(".langs button[data-lang=ru]"); sp.wait_for_timeout(400)
    # отмена изменений
    ap.click("[data-fedit=daily_tests]"); ap.wait_for_selector("#fpv"); ap.fill("input[name=title_ru]", "НЕ СОХРАНЯТЬ")
    ap.locator("#modalBody button", has_text="Отмена").click(); ap.wait_for_timeout(300)
    check("«Отмена» не сохраняет изменения", next(c for c in home_cards(sp) if c["id"] == "daily_tests")["title"] == "Ежедневные тесты")
    # дополнительная карточка
    ap.click("#fNew"); ap.wait_for_selector("input[name=id]"); ap.fill("input[name=id]", "trade_journal"); ap.fill("input[name=title_ru]", "Журнал сделок"); ap.select_option("select[name=icon]", "book")
    ap.locator("#modalBody button", has_text="Сохранить").click(); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit=trade_journal]")
    # информационная карточка без модуля: «Открыть» недоступен (все стандартные модули уже реализованы)
    opt = ap.locator("select[data-fst=trade_journal] option[value=ACTIVE]")
    check("статус «Открыть» недоступен, пока модуль не реализован", opt.is_disabled() and "не реализован" in opt.inner_text())
    ap.click("[data-fedit=trade_journal]"); ap.wait_for_selector("#fpv"); ap.select_option("select[name=status]", "ACTIVE")
    check("форма предупреждает: «Открыть» для нереализованного модуля не сохранится", "не реализован" in ap.inner_text("#fNote"))
    ap.locator("#modalBody button", has_text="Сохранить").click(); ap.wait_for_function("document.getElementById('toast').textContent.includes('не реализован')", timeout=8000)
    check("сервер не сохранил ACTIVE для нереализованного модуля (сообщение об ошибке)", "не реализован" in ap.inner_text("#toast"), ap.inner_text("#toast"))
    ap.locator("#modalBody button", has_text="Отмена").click(); ap.wait_for_timeout(300)
    cards = home_cards(sp); tj = next((c for c in cards if c["id"] == "trade_journal"), None)
    check("дополнительная карточка появилась у ученика как информационная («Скоро», без ссылки)", tj and tj["tag"] == "ARTICLE" and tj["href"] is None and tj["label"] == "Скоро" and cards[-1]["id"] == "trade_journal", cards)
    for pos in (4, 3, 2):   # поднять «Журнал сделок» выше скрытых карточек и выше «Ежедневных тестов»
        ap.click(f"[data-fup='{pos}']"); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit]"); ap.wait_for_timeout(300)
    check("порядок: карточка поднята выше у ученика", [c["id"] for c in home_cards(sp)] == ["ai_mentor", "trade_journal", "daily_tests"], [c["id"] for c in home_cards(sp)])
    # отключение: скрыть / показать
    ap.select_option("select[data-fst=daily_tests]", "DISABLED"); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit]")
    check("«Отключено» + «Скрыть» → карточки нет у ученика", "daily_tests" not in [c["id"] for c in home_cards(sp)])
    ap.click("[data-fedit=daily_tests]"); ap.wait_for_selector("#fpv"); ap.select_option("select[name=disabled_display]", "show")
    ap.locator("#modalBody button", has_text="Сохранить").click(); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit]")
    ct = next((c for c in home_cards(sp) if c["id"] == "daily_tests"), None)
    check("«Отключено» + «Показать» → карточка с меткой «Отключено»", ct and ct["label"] == "Отключено", ct)
    sp.click("#secsList [data-feature=daily_tests]"); sp.wait_for_selector("#toast.show"); check("нажатие на отключённую: «Раздел временно отключён»", "отключён" in sp.inner_text("#toast"))
    # сброс
    ap.click("#fReset"); ap.locator("#modalBody button", has_text="Вернуть").click(); ap.wait_for_selector("#toast.show"); ap.wait_for_selector("[data-fedit]")
    cards = home_cards(sp)
    check("«Вернуть стандартные»: исходные тексты и «Скоро», дополнительная карточка осталась",
          [(c["id"], c["title"], c["label"]) for c in cards[:2]] == [("ai_mentor", "ИИ-помощник", "Скоро"), ("daily_tests", "Ежедневные тесты", "Скоро")] and cards[2]["id"] == "trade_journal" and len(cards) == 3, cards)
    # телефон
    mctx, mp = new_page(b, 375); sp.context.storage_state(path="/tmp/stu_state.json"); mctx.close()
    mctx = b.new_context(viewport={"width": 375, "height": 800}, storage_state="/tmp/stu_state.json")
    mctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    mctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    mp = mctx.new_page(); mp.on("pageerror", lambda e: js_errors.append(str(e))); n = len(home_cards(mp))
    check(f"телефон 375px: {n} карточки без горизонтальной прокрутки", n == 3 and mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), mp.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    mp.screenshot(path="/tmp/cards_mobile.png", full_page=True); sp.screenshot(path="/tmp/cards_desktop.png", full_page=True)
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
