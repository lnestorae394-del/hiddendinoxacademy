"""ИИ-помощник: чат, ответы по каждому курсу, «нет в материалах», история, новый диалог/очистка, ошибки и лимиты, языки, телефон.
Claude API имитируется тестовым сервером (настоящий вызов — на Render с ключом). Запуск: python3 tests/e2e/mentor_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); PORT = os.environ.get("PORT", "8819"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors, api_posts = [], [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:400]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def admin(method, path, body=None):
    r = urllib.request.Request(B + "/admin/api" + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer testtoken-owner_test_com", **({"Content-Type": "application/json"} if body is not None else {})})
    return json.loads(urllib.request.urlopen(r).read())
def new_ctx(b, w=1280, lang=None, state=None):
    ctx = b.new_context(viewport={"width": w, "height": 900}, **({"storage_state": state} if state else {}))
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e)))
    p.on("request", lambda r: api_posts.append(r.url) if "/api/mentor/message" in r.url else None); return ctx, p
def ask(p, text, expect_reply=True):
    n = p.locator(".mn-msg.assistant:not(.mn-welcome)").count(); p.fill("#mnInput", text); p.press("#mnInput", "Enter")
    if expect_reply: p.wait_for_function(f"document.querySelectorAll('.mn-msg.assistant:not(.mn-welcome)').length>{n}", timeout=10000); return p.locator(".mn-msg.assistant").last.inner_text()

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); ap.goto(B + "/"); ap.wait_for_selector("#loginForm"); ap.click("[data-go=register]")
    ap.fill("#email", "owner@test.com"); ap.fill("#password", "password1"); ap.fill("#password2", "password1"); ap.click("#regBtn"); ap.wait_for_url(re.compile(r".*broker\.html"))
    get("/test/role?uid=owner_test_com&role=admin")
    for f in ("content/hidden-reaction-course.json", "content/binary/smart_money_concepts_binary.json", "content/binary/risk_management_binary.json"):
        cid = admin("POST", "/import/course", {"confirm": True, "data": json.load(open(os.path.join(ROOT, f), encoding="utf-8"))})["course_id"]
        admin("POST", f"/courses/{cid}/ready-all", {"confirm": True}); admin("POST", f"/courses/{cid}/publish", {"confirm": True})
    admin("POST", "/features/ai_mentor/status", {"status": "ACTIVE"})
    ap.goto(B + "/admin/#/mentor"); ap.wait_for_selector("#mUsage", timeout=10000)
    check("админка: модель claude-haiku-5-5, ключ подключён (без показа ключа)", ap.inner_text("#mModel") == "claude-haiku-5-5" and ap.inner_text("#mKey") == "подключён" and "test-key" not in ap.content())
    # ученик
    sctx, sp = new_ctx(b); sp.goto(B + "/"); sp.wait_for_selector("#loginForm"); sp.click("[data-go=register]")
    sp.fill("#email", "stu@test.com"); sp.fill("#password", "password1"); sp.fill("#password2", "password1"); sp.click("#regBtn"); sp.wait_for_url(re.compile(r".*broker\.html"))
    sp.wait_for_selector("#idForm"); sp.click("#pocketBtn"); sp.wait_for_timeout(300); click = sp.evaluate("window.__opened")[0].split("click_id=")[1]; sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id=88800061&secret={sec}"); sp.fill("#traderId", "88800061"); sp.click("#idBtn"); sp.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id=88800061&amount=60&currency=USD&secret={sec}")
    sp.goto(B + "/academy/academy.html"); sp.wait_for_selector("#secsList a[data-feature=ai_mentor]", timeout=10000)
    check("карточка «ИИ-помощник» ведёт в чат", sp.inner_text("#secsList a[data-feature=ai_mentor] h3") == "ИИ-помощник")
    sp.click("#secsList a[data-feature=ai_mentor]"); sp.wait_for_selector("#mnLog .mn-msg")
    check("приветствие ИИ-помощника (RU)", "Я твой ИИ-помощник Hidden Dinox Academy" in sp.inner_text("#mnLog"))
    n0 = len(api_posts); sp.click("#mnSend"); sp.wait_for_selector("#mnErr:not([hidden])")
    check("пустое сообщение не отправляется", len(api_posts) == n0 and "Напишите вопрос" in sp.inner_text("#mnErrText"))
    sp.fill("#mnInput", "строка 1"); sp.press("#mnInput", "Shift+Enter"); sp.type("#mnInput", "строка 2")
    check("Shift+Enter — перенос строки, без отправки", sp.input_value("#mnInput") == "строка 1\nстрока 2" and len(api_posts) == n0); sp.fill("#mnInput", "")
    for q, course in (("Что такое BOS и CHoCH в Smart Money Concepts?", "SMART MONEY"), ("Как посчитать безубыточную долю прибыльных сделок при выплате 92%?", "RISK MANAGEMENT"), ("Что такое скрытая реакция рынка в системе Hidden Reaction?", "HIDDEN")):
        rep = ask(sp, q); check(f"вопрос по курсу {course}: ответ с источником из этого курса", "Ответ по материалам" in rep and course in sp.locator(".mn-msg.assistant .mn-src").last.inner_text().upper(), rep[:200])
    rep = ask(sp, "Какой рецепт у борща с пампушками?"); check("вопрос вне материалов: честно «в материалах академии этого нет»", "В материалах академии этого нет" in rep, rep)
    check("ответ: список и **жирный** отрисованы безопасно", sp.locator(".mn-msg.assistant ul li").count() >= 1 and sp.locator(".mn-msg.assistant b").count() >= 1)
    check("лимит: «Осталось сообщений сегодня: 26 из 30»", "26 из 30" in sp.inner_text("#mnLimit"), sp.inner_text("#mnLimit"))
    sp.reload(); sp.wait_for_selector(".mn-msg.user")
    check("после перезагрузки диалог восстановлен (4 вопроса + 4 ответа), без повторного приветствия", sp.locator(".mn-msg.user").count() == 4 and sp.locator(".mn-msg.assistant:not(.mn-welcome)").count() == 4 and "Я твой ИИ-помощник" not in sp.inner_text("#mnLog"))
    # ошибки и повтор без дубля
    get("/test/ai?mode=error"); ask(sp, "Что такое FVG?", expect_reply=False); sp.wait_for_selector("#mnErr:not([hidden])")
    check("ошибка API: понятное сообщение и «Повторить»", "временно недоступен" in sp.inner_text("#mnErrText") and sp.is_visible("#mnRetry"))
    get("/test/ai?mode=ok"); n = sp.locator(".mn-msg.assistant:not(.mn-welcome)").count(); sp.click("#mnRetry"); sp.wait_for_function(f"document.querySelectorAll('.mn-msg.assistant:not(.mn-welcome)').length>{n}")
    sp.reload(); sp.wait_for_selector(".mn-msg.user")
    check("«Повторить» отправил то же сообщение без дубля", [t for t in sp.eval_on_selector_all(".mn-msg.user", "a=>a.map(x=>x.innerText)") if "FVG" in t] == ["Что такое FVG?"])
    sp.screenshot(path="/tmp/mentor_desktop.png", full_page=True)
    # новый диалог и очистка
    sp.click("#mnNew"); sp.wait_for_function("document.querySelectorAll('.mn-msg.user').length===0")
    check("«Новый диалог»: только приветствие", sp.locator(".mn-msg").count() == 1 and sp.locator(".mn-welcome").count() == 1)
    ask(sp, "Что такое OTE?"); sp.click("#mnClear"); check("очистка — с подтверждением", sp.is_visible("#mnClearBox"))
    sp.click("#mnClearYes"); sp.wait_for_function("document.querySelectorAll('.mn-msg.user').length===0"); sp.reload(); sp.wait_for_selector("#mnLog .mn-msg")
    check("история очищена и не возвращается после перезагрузки", sp.locator(".mn-msg.user").count() == 0)
    # лимит
    admin("PUT", "/mentor/settings", {"per_user_daily": 6, "monthly_budget_usd": 50, "price_input_per_mtok": 0.1, "price_output_per_mtok": 0.5})
    sp.reload(); sp.wait_for_selector("#mnLog .mn-msg"); ask(sp, "Ещё вопрос про BOS", expect_reply=False); sp.wait_for_selector("#mnErr:not([hidden])")
    check("дневной лимит: понятное сообщение", "Лимит сообщений на сегодня исчерпан" in sp.inner_text("#mnErrText"), sp.inner_text("#mnErrText"))
    admin("PUT", "/mentor/settings", {"per_user_daily": 30, "monthly_budget_usd": 50, "price_input_per_mtok": 0.1, "price_output_per_mtok": 0.5})
    ap.goto(B + "/admin/#/mentor"); ap.reload(); ap.wait_for_selector("#mUsage")   # тот же адрес — нужна перезагрузка, иначе старые данные
    usage = ap.inner_text("#mUsage").replace("\n", " | "); check("админка: расход — запросы, ошибки, токены, сумма", re.search(r"Месяц[^|]*\t6\t1\t", usage) is not None, usage)
    state = sctx.storage_state()
    for lang, wel, bad in (("en", "I'm your Hidden Dinox Academy AI mentor", re.compile(r"[А-Яа-яЁёІіЇїЄє]")), ("ua", "Я твій ШІ-помічник Hidden Dinox Academy", re.compile(r"\b(AI Mentor|New chat|Clear history|Send)\b|[ЫыЭэЪъЁё]"))):
        ctx, p = new_ctx(b, lang=lang, state=state); p.goto(B + "/academy/mentor.html"); p.wait_for_selector("#mnLog .mn-msg")
        t = p.evaluate("document.title+'\\n'+document.body.innerText"); check(f"{lang.upper()}: приветствие и интерфейс без смешения языков", wel in t and not bad.search(t), bad.findall(t)[:5]); ctx.close()
    mctx, mp = new_ctx(b, w=375, state=state); mp.goto(B + "/academy/mentor.html"); mp.wait_for_selector("#mnLog .mn-msg"); ask(mp, "Что такое BOS?")
    check("телефон 375px: без горизонтальной прокрутки", mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), mp.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    mp.screenshot(path="/tmp/mentor_mobile.png", full_page=True); mctx.close()
    # бюджет: панель в админке, снижение лимита через форму, понятная ошибка у ученика, предупреждение
    ap.goto(B + "/admin/#/mentor"); ap.reload(); ap.wait_for_selector("#mBudget")
    check("панель бюджета: лимит $100, функции (наставник, скриншоты, Daily Tests), цены моделей", "$100.00" in ap.inner_text("#mBudget") and ap.locator("#mFeatures tr[data-feature]").count() == 3 and ap.locator("#mPrices tr[data-model]").count() == 2)
    for name, v in (("monthly_total_usd", "0.0002"), ("reserve_usd", "0"), ("f_mentor", "0.0002"), ("f_vision", "0"), ("f_daily", "0")): ap.fill(f"#mBudgetForm input[name={name}]", v)
    ap.click("#mSave"); ap.wait_for_function("document.getElementById('toast').textContent.includes('сохранены')", timeout=8000)
    sp.reload(); sp.wait_for_selector("#mnLog .mn-msg"); ask(sp, "Вопрос при исчерпанном бюджете", expect_reply=False); sp.wait_for_selector("#mnErr:not([hidden])")
    check("бюджет исчерпан: ученик видит понятное сообщение", "исчерпан общий лимит" in sp.inner_text("#mnErrText"), sp.inner_text("#mnErrText"))
    ap.reload(); ap.wait_for_selector("#mBudget"); check("админка: предупреждение «бюджет исчерпан»", ap.get_attribute("#mBudgetWarn", "data-level") == "100")
    admin("PUT", "/ai-budget/settings", {"monthly_total_usd": 100, "reserve_usd": 5, "features": {"mentor": 40, "vision": 45, "daily": 10}, "per_user_monthly_usd": 1.5, "per_user_daily_images": 5})
    # «Что помнит наставник»
    sp.reload(); sp.wait_for_selector("#mnMemory"); sp.click("#mnMemory"); sp.wait_for_selector("#mnUseProfile", timeout=10000)
    check("панель «Что помнит наставник»: профиль, сводка, заметки", "Что помнит наставник" in sp.inner_text("#mnMemPanel") and "Краткое содержание этого диалога" in sp.inner_text("#mnMemPanel") and sp.get_attribute("#mnMemory", "aria-expanded") == "true")
    with sp.expect_response(lambda r: "/api/mentor/memory/profile" in r.url): sp.uncheck("#mnUseProfile")
    sp.reload(); sp.wait_for_selector("#mnMemory"); sp.click("#mnMemory"); sp.wait_for_selector("#mnUseProfile")
    check("отключение профиля сохраняется после перезагрузки", not sp.is_checked("#mnUseProfile"))
    sp.click("#mnForget"); check("«Забыть» — с подтверждением", sp.is_visible("#mnForgetBox"))
    with sp.expect_response(lambda r: "/api/mentor/memory/forget" in r.url) as fr: sp.click("#mnForgetYes")
    check("«Забыть» выполнено", fr.value.status == 200)
    get("/test/ai?mode=nokey"); sp.reload(); sp.wait_for_selector("#mnErr:not([hidden])")
    check("нет ключа: «ИИ-помощник ещё не подключён»", "ещё не подключён" in sp.inner_text("#mnErrText"))
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
