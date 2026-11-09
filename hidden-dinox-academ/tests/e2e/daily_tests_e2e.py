"""Этап 2: Daily Tests — админ загружает банк и готовит наборы, открывает карточку; ученик проходит задания, история, языки.
Запуск: python3 tests/e2e/daily_tests_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8803"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors, leaks = [], [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def new_ctx(b, w=1280, lang=None, state=None):
    ctx = b.new_context(viewport={"width": w, "height": 900}, **({"storage_state": state} if state else {}))
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e)))
    def watch(r):
        if "/api/daily/today" in r.url or "/api/daily/task" in r.url:
            try:
                if re.search(r'"(correct|correct_index|explanation)"', r.text()): leaks.append(r.url)
            except Exception: pass
    p.on("response", watch); return ctx, p
def register(p, email):
    p.goto(B + "/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
def give_access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id={trader}&secret={sec}")
    p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id={trader}&amount=60&currency=USD&secret={sec}")

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); register(ap, "owner@test.com"); get("/test/role?uid=owner_test_com&role=admin")
    ap.goto(B + "/admin/#/daily"); ap.wait_for_selector("#dImport", timeout=10000)
    check("админка: раздел Daily Tests; пустой банк — подсказка", ap.is_visible("#dEmpty"))
    ap.click("#dImport"); ap.locator("#modalBody button", has_text="Загрузить").click(); ap.wait_for_function("document.getElementById('toast').textContent.includes('Добавлено')", timeout=10000)
    check("банк загружен кнопкой: 320 вопросов", "Добавлено: 320" in ap.inner_text("#toast"), ap.inner_text("#toast"))
    ap.wait_for_selector("#dStock"); stock = ap.inner_text("#dStock")
    check("запас: HR 35 одобрено / 61 на проверке, SMC 168, RM 56; «хватит на» в днях", "35\t61" in stock and "168" in stock and "56" in stock and "дн." in stock, stock)
    ap.click("#dRun"); ap.wait_for_function("document.getElementById('toast').textContent.includes('Сегодня')", timeout=10000); ap.wait_for_selector("#dStock")
    check("«Подготовить наборы сейчас»: созданы на сегодня и завтра", "created" in ap.inner_text("#toast"), ap.inner_text("#toast"))
    ap.click("#dRun"); ap.wait_for_function("document.getElementById('toast').textContent.includes('exists')", timeout=10000)
    check("повторный запуск не создаёт дублей (exists)", "Сегодня: exists, завтра: exists" in ap.inner_text("#toast"), ap.inner_text("#toast"))
    ap.wait_for_selector("[data-qedit]"); ap.select_option("#dfS", "needs_review"); ap.wait_for_function("document.querySelector('#dBank').textContent.includes('Найдено: 61')", timeout=8000)
    check("банк: фильтр «на проверке» — 61 вопрос с причиной", "нужно объяснение" in ap.inner_text("#dBank"))
    # ученик до открытия карточки
    sctx, sp = new_ctx(b); register(sp, "stu@test.com"); give_access(sp, "88800021")
    sp.goto(B + "/academy/daily-tests.html"); sp.wait_for_selector("#dtErr", timeout=10000)
    check("пока карточка «Скоро»: страница сообщает, что раздел недоступен", "недоступен" in sp.inner_text("#dtErr"))
    # администратор открывает карточку
    ap.goto(B + "/admin/#/features"); ap.wait_for_selector("select[data-fst=daily_tests]")
    check("«Открыть» доступен для Daily Tests (модуль реализован)", not ap.locator("select[data-fst=daily_tests] option[value=ACTIVE]").is_disabled())
    ap.select_option("select[data-fst=daily_tests]", "ACTIVE"); ap.wait_for_selector("#toast.show")
    sp.goto(B + "/academy/academy.html"); sp.wait_for_selector("#secsList a[data-feature=daily_tests]", timeout=10000)
    sp.click("#secsList a[data-feature=daily_tests]"); sp.wait_for_selector(".dt-task", timeout=10000)
    tasks = sp.eval_on_selector_all(".dt-task .dt-c", "a=>a.map(x=>x.textContent)")
    check("карточка ведёт на Daily Tests: 5 заданий (2 HR, 2 SMC, 1 RM)", sorted(tasks) == sorted(["HR", "HR", "SMC", "SMC", "RM"]), tasks)
    sp.wait_for_function("/^\\d\\d:\\d\\d:\\d\\d$/.test(document.getElementById('dtLeft').textContent)")
    t1 = sp.inner_text("#dtLeft"); sp.wait_for_timeout(1300); t2 = sp.inner_text("#dtLeft")
    h = int(t1.split(":")[0]); check(f"таймер до 00:00 по Берлину идёт ({t1} → {t2}) и меньше 24 ч", t1 != t2 and h < 24, (t1, t2))
    # ответы: определяем правильный вариант через админку (архив набора)
    date = re.search(r"#task/([\d-]+)/", sp.get_attribute(".dt-task a", "href")).group(1)
    import urllib.request as U
    req = U.Request(B + "/admin/api/daily/sets/" + date, headers={"Authorization": "Bearer testtoken-owner_test_com"}); detail = json.loads(U.urlopen(req).read())
    ids = sp.eval_on_selector_all(".dt-task", "a=>a.map(x=>x.dataset.task)")
    corr = {q["id"]: q["correct"] for q in detail["questions"]}
    sp.click(f".dt-task[data-task='{ids[0]}'] a"); sp.wait_for_selector("#dtAnswer")
    sp.click("#dtAnswer"); check("без выбора варианта ответ не отправляется", sp.is_visible("#dtChoose"))
    wrong = (corr[ids[0]] + 1) % sp.locator("[data-opt]").count()
    sp.click(f"[data-opt='{wrong}']"); sp.click("#dtAnswer"); sp.wait_for_selector("#dtResult")
    check("неверный ответ: «Неверно», правильный вариант подсвечен, объяснение", "Неверно" in sp.inner_text("#dtResult") and sp.locator(".dt-opt.right").count() == 1 and sp.locator(".dt-opt.wrong").count() == 1 and len(sp.inner_text("#dtWhy")) > 3)
    sp.click("a[href='#today']"); sp.wait_for_selector(".dt-task")
    sp.click(f".dt-task[data-task='{ids[1]}'] a"); sp.wait_for_selector("#dtAnswer"); sp.click(f"[data-opt='{corr[ids[1]]}']"); sp.click("#dtAnswer"); sp.wait_for_selector("#dtResult")
    check("верный ответ: «Верно!»", "Верно!" in sp.inner_text("#dtResult"))
    sp.goto(B + "/academy/daily-tests.html#task/" + date + "/" + ids[2]); sp.wait_for_selector("#dtAnswer")   # открыто, но не отвечено → «В процессе»
    sp.goto(B + "/academy/daily-tests.html#today"); sp.reload(); sp.wait_for_selector(".dt-task")
    st = {i: sp.inner_text(f".dt-task[data-task='{i}'] .dt-st") for i in ids[:3]}
    check("после перезагрузки статусы сохранены: Неверно / Верно / В процессе", st == {ids[0]: "Неверно", ids[1]: "Верно", ids[2]: "В процессе"}, st)
    check("прогресс «Пройдено 2 из 5»", "Пройдено 2 из 5" in sp.inner_text("#dtProgress"))
    sp.click("[data-tab=done]"); sp.wait_for_selector("#dtDone")
    check("«Пройденные»: два задания с результатом", sp.locator("#dtDone .dt-task").count() == 2 and "Время" in sp.inner_text("#dtDone"))
    sp.locator("#dtDone a", has_text="Разбор").first.click(); sp.wait_for_selector("#dtResult"); check("разбор из истории открывается", sp.is_visible("#dtWhy"))
    sp.goto(B + "/academy/daily-tests.html#task/" + date + "/" + ids[0]); sp.wait_for_function("document.getElementById('dtResult') && document.getElementById('dtResult').textContent.includes('Неверно')", timeout=10000)
    check("повторное открытие пройденного — только разбор (ответ не меняется)", "Неверно" in sp.inner_text("#dtResult") and sp.locator("#dtAnswer").count() == 0)
    check("правильные ответы не приходят в браузер до ответа", not leaks, leaks[:3])
    state = sctx.storage_state()
    ectx, ep = new_ctx(b, lang="en", state=state); ep.goto(B + "/academy/daily-tests.html"); ep.wait_for_selector(".dt-task")
    check("EN: интерфейс и вопросы на английском", "New tests in" in ep.inner_text("main") and "Completed 2 of 5" in ep.inner_text("#dtProgress") and not re.search("[А-Яа-я]", ep.inner_text(".dt-list")), ep.inner_text("main")[:200])
    ectx.close()
    mctx, mp = new_ctx(b, w=375, state=state); mp.goto(B + "/academy/daily-tests.html"); mp.wait_for_selector(".dt-task")
    check("телефон 375px: без горизонтальной прокрутки", mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), mp.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    mp.screenshot(path="/tmp/daily_mobile.png", full_page=True); sp.goto(B + "/academy/daily-tests.html"); sp.wait_for_selector(".dt-task"); sp.screenshot(path="/tmp/daily_desktop.png", full_page=True)
    ap.goto(B + "/admin/#/daily"); ap.wait_for_selector("#dStock"); ap.screenshot(path="/tmp/daily_admin.png", full_page=True)
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
