"""Сквозная проверка админ-панели и обучения в браузере (Playwright).
Запуск: python3 tests/e2e/admin_e2e.py (поднимает tests/e2e/test-server.js сам).
Firebase Auth заменён тестовым модулем; сервер — настоящие обработчики академии с тестовой Firestore в памяти."""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8796"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def get(path): return json.loads(urllib.request.urlopen(B + path).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(name, cond, extra=""):
    results.append((bool(cond), name)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def new_page(b, w=1280, h=900):
    ctx = b.new_context(viewport={"width": w, "height": h})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.click("[data-go=register]"); p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn")
    p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
uid = lambda email: re.sub(r"[^A-Za-z0-9]", "_", email)
def clear_toast(p): p.evaluate("(()=>{const t=document.getElementById('toast');if(t){t.className='toast';t.textContent=''}})()")
def toast(p):
    p.wait_for_function("(()=>{const t=document.getElementById('toast');return t&&t.classList.contains('show')&&t.textContent})()", timeout=8000)
    t = p.inner_text("#toast"); clear_toast(p); return t
def toast_bad(p):
    p.wait_for_function("(()=>{const t=document.getElementById('toast');return t&&t.classList.contains('show')&&t.textContent})()", timeout=8000)
    bad = "bad" in (p.get_attribute("#toast", "class") or ""); t = p.inner_text("#toast"); clear_toast(p); return bad, t

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ---------- 1. Ученик без прав не попадает в админ-панель ----------
    ctx, p = new_page(b, 375)
    register(p, "plain@test.com")
    p.goto(B + "/admin/"); p.wait_for_selector(".login", timeout=8000)
    check("ученик без роли: вход в админ-панель отклонён сервером", "нет прав администратора" in p.inner_text("#main"), p.inner_text("#main"))
    ctx.close()

    # ---------- 2. Администратор ----------
    ctx, p = new_page(b, 1280)
    register(p, "owner@test.com"); get(f"/test/role?uid={uid('owner@test.com')}&role=super_admin")
    p.goto(B + "/admin/"); p.wait_for_selector(".stats", timeout=8000)
    nav = p.inner_text("#nav")
    check("super_admin: сводка открыта, все разделы в меню", all(x in nav for x in ["Сводка", "Курсы", "Медиа", "Афиши", "Пользователи", "Журнал", "Импорт"]), nav)
    check("сводка показывает реальные счётчики (пользователей ≥ 2)", re.search(r"Пользователей\s*\n?\s*([2-9]|\d\d)", p.inner_text(".stats")) is not None, p.inner_text(".stats")[:200])
    p.screenshot(path="/tmp/adm_dashboard.png")

    # Медиа: загрузка изображения
    p.goto(B + "/admin/#/media"); p.wait_for_selector("#mf")
    p.set_input_files("#mf", "/tmp/e2e-cover.png"); p.select_option("#mc", "cover"); p.click("#mu")
    check("медиа: изображение загружено", "Файл загружен" in toast(p))
    p.wait_for_selector(".media img"); src = p.get_attribute(".media img", "src")
    check("медиа: превью открывается (/media/:id отдаёт PNG)", urllib.request.urlopen(B + src).headers.get("Content-Type") == "image/png", src)
    media_id = src.split("/")[-1]
    # Недопустимый файл
    open("/tmp/e2e-bad.txt", "w").write("<script>alert(1)</script>")
    p.set_input_files("#mf", "/tmp/e2e-bad.txt"); p.click("#mu"); bad, t = toast_bad(p)
    check("медиа: текст/HTML-файл отклонён с понятной ошибкой", bad and "Файл загружен" not in t, t)
    check("медиа: в библиотеке остался только один файл", p.locator(".media").count() == 1)

    # Курс → модуль → урок
    p.goto(B + "/admin/#/courses"); p.wait_for_selector("#nc"); p.click("#nc")
    p.fill("#modalBody [name=title]", "Тестовый курс E2E"); p.fill("#modalBody [name=description]", "Описание **курса**")
    p.fill("#modalBody [name=cover_media_id]", media_id); p.fill("#modalBody [name=disclaimer]", "Учебный материал. Торговля связана с риском.")
    p.click("#modalBody .mf .primary"); p.wait_for_selector("#nm", timeout=8000)
    check("курс создан как черновик", "Черновик" in p.inner_text("#main"))
    p.click("#nm"); p.fill("#modalBody [name=title]", "Модуль 1"); p.click("#modalBody .mf .primary")
    p.wait_for_selector("[data-nl]"); p.click("[data-nl]"); p.fill("#nlt", "Урок про замедление"); p.click("#modalBody .mf .primary")
    p.wait_for_selector("#blocks", timeout=8000)
    check("урок создан, открыт конструктор", "В уроке пока нет блоков" in p.inner_text("#blocks"))
    for t in ["heading", "text", "chart", "image", "quiz"]: p.click(f"[data-add={t}]"); p.wait_for_timeout(80)
    blk = lambda i: f".blk[data-i='{i}']"
    p.fill(blk(0) + " [data-k=text]", "Что такое замедление")
    p.fill(blk(1) + " [data-k=text]", "Замедление — **первый сигнал** потери силы.\n- свечи слабее\n- движение тяжелее")
    check("график: живой SVG-предпросмотр в редакторе", p.locator(blk(2) + " [data-chartpv] svg").count() == 1)
    p.fill(blk(3) + " [data-k=media_id]", media_id); p.fill(blk(3) + " [data-k=alt]", "Тестовое изображение")
    p.fill(blk(4) + " [data-qk=q]", "Замедление — это точка входа?")
    p.fill(blk(4) + " [data-opt='0']", "Да"); p.fill(blk(4) + " [data-opt='1']", "Нет, это предупреждение")
    p.check(blk(4) + " [data-correct='1']"); p.fill(blk(4) + " [data-qk=explanation]", "В книге: замедление — не точка входа, а предупреждение.")
    TXT = "Замедление — **первый сигнал** потери силы.\n- свечи слабее\n- движение тяжелее"
    p.click(f"{blk(1)} [data-up='1']"); p.wait_for_timeout(100)
    check("перестановка: блок «Текст» поднялся, содержимое блоков не перепуталось",
          "Текст" in p.inner_text(blk(0) + " .blk-h") and p.input_value(blk(0) + " textarea[data-k=text]") == TXT and p.input_value(blk(1) + " input[data-k=text]") == "Что такое замедление",
          [p.input_value(blk(0) + " [data-k=text]"), p.input_value(blk(1) + " [data-k=text]")])
    p.click(f"{blk(0)} [data-down='0']"); p.wait_for_timeout(100)
    check("обратная перестановка: заголовок и текст на своих местах, переносы строк сохранены",
          p.input_value(blk(0) + " input[data-k=text]") == "Что такое замедление" and p.input_value(blk(1) + " textarea[data-k=text]") == TXT)
    p.click("[data-add=summary]"); p.wait_for_timeout(100); p.fill(blk(5) + " textarea[data-k=text]", "временный блок")
    p.click(f"{blk(2)} [data-del='2']"); p.wait_for_timeout(100)
    check("удаление блока не сдвигает данные соседних блоков",
          p.input_value(blk(1) + " textarea[data-k=text]") == TXT and p.input_value(blk(2) + " [data-k=media_id]") == media_id and p.input_value(blk(4) + " textarea[data-k=text]") == "временный блок",
          [p.input_value(blk(2) + " [data-k=media_id]")])
    p.click(f"{blk(4)} [data-del='4']"); p.wait_for_timeout(100); p.click("[data-add=chart]"); p.wait_for_timeout(100)
    blocks_now = p.eval_on_selector_all(".blk-h b", "els => els.map(e => e.textContent)")
    check("порядок блоков после правок: заголовок, текст, изображение, тест, график", [re.sub(r"^\d+\. ", "", x) for x in blocks_now] == ["Заголовок", "Текст", "Изображение", "Тест", "График / схема"], blocks_now)
    p.select_option("#ls", "ready"); p.check("#lrq")
    p.click("#save"); check("урок сохранён", "сохранён" in toast(p))
    # Предпросмотр
    p.click("#pv"); p.wait_for_selector("#pvf.phone .hdl")
    pv = p.inner_text("#pvf")
    check("предпросмотр: телефон, текст, график и тест", "первый сигнал" in pv and p.locator("#pvf svg").count() >= 1 and "точка входа" in pv, pv[:200])
    p.screenshot(path="/tmp/adm_preview_phone.png")
    p.click("[data-m=desktop]"); check("предпросмотр: режим компьютера", p.locator("#pvf.desktop").count() == 1)
    check("предпросмотр: форматирование — жирный текст и список из 2 пунктов", p.locator("#pvf strong").count() >= 1 and p.locator("#pvf ul li").count() == 2)
    p.click("#modalBody [data-x]")
    # Публикация
    p.click("text=← К курсу"); p.wait_for_selector("#pub")
    p.click("#pub"); p.click("#modalBody .mf .primary")
    check("публикация без галочки подтверждения не выполняется", "Подтвердите" in toast(p))
    p.check("#cf"); p.click("#modalBody .mf .primary")
    check("курс опубликован (1 урок)", "Опубликовано уроков: 1" in toast(p))
    p.wait_for_selector(".pill.ok"); check("статус курса: опубликован", "Опубликован" in p.inner_text(".status-line"))
    # Афиша
    p.goto(B + "/admin/#/announcements"); p.wait_for_selector("#na"); p.click("#na")
    p.fill("#modalBody [name=title]", "Эфир по Hidden Reaction"); p.fill("#modalBody [name=body]", "Разбор структуры рынка")
    p.fill("#modalBody [name=cta_label]", "Смотреть"); p.fill("#modalBody [name=cta_url]", "https://t.me/hiddendinox")
    p.select_option("#modalBody [name=status]", "published"); p.click("#modalBody .mf .primary"); bad, t = toast_bad(p)
    check("афиша: публикация без подтверждения отклонена сервером", bad, t)
    p.check("#modalBody [name=confirm]"); check("афиша: предпросмотр мобильной карточки", "Эфир по Hidden Reaction" in p.inner_text("#annpv"))
    p.click("#modalBody .mf .primary"); check("афиша опубликована", "сохранена" in toast(p))
    # Импорт курса по книге (черновик)
    p.goto(B + "/admin/#/import"); p.wait_for_selector("#if")
    p.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json")); p.wait_for_selector("#ib:not([disabled])")
    p.click("#ib"); bad, t = toast_bad(p)
    check("импорт без галочки подтверждения не выполняется", bad and "подтверждение" in t, t)
    p.check("#ic"); p.click("#ib"); t = toast(p)
    check("импорт курса по книге: 6 модулей, 29 уроков (≈220 КБ через свой тип JSON)", "модулей 6, уроков 29" in t, t)
    p.wait_for_selector(".mod", timeout=8000)
    check("импортированный курс — черновик, ученики его не видят", "Черновик" in p.inner_text(".status-line"))
    mods = p.eval_on_selector_all(".mod", "els => els.map(e => e.querySelectorAll('.les a').length)")
    check("после импорта в админке уроки внутри модулей: 4, 6, 7, 5, 3, 4", mods == [4, 6, 7, 5, 3, 4], mods)
    imported_url = p.url
    p.goto(B + "/admin/#/import"); p.wait_for_selector("#if")
    p.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json")); p.wait_for_selector("#ib:not([disabled])")
    p.check("#ic"); p.click("#ib"); bad, t2 = toast_bad(p)
    check("повторный импорт: понятное сообщение, дубликат не создан", bad and "уже импортирован" in t2, t2)
    p.wait_for_selector(".mod", timeout=8000)
    check("повторный импорт открывает существующий черновик", p.url == imported_url, [p.url, imported_url])
    p.goto(B + "/admin/#/diagnostics"); p.wait_for_selector("#main .panel table", timeout=8000)
    dg = p.inner_text("#main")
    check("диагностика: формат графиков исправлен, курс с 29 уроками и без пустых модулей", "Формат графиков исправлен" in dg and "уроков всего 29" in dg and "пустой" not in dg, dg[:400])
    # открыть урок с графиком из импортированного курса: свечи в редакторе в исходном формате [o,h,l,c]
    p.goto(imported_url); p.wait_for_selector(".mod")
    p.locator(".mod").nth(1).locator(".les a").first.click(); p.wait_for_selector("#blocks")
    cj = p.input_value(".blk textarea.code") if p.locator(".blk textarea.code").count() else ""
    check("редактор урока из импорта: график в исходном формате и с живым предпросмотром", cj.strip() != "" and '"o"' not in cj and p.locator("[data-chartpv] svg").count() >= 1, cj[:120])
    p.screenshot(path="/tmp/adm_course.png", full_page=False)
    ctx.close()

    # ---------- 3. Ученик с доступом ----------
    ctx, p = new_page(b, 375)
    register(p, "learner@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id="88800001")
    p.fill("#traderId", "88800001"); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id="88800001", amount="60", currency="USD")
    p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    p.wait_for_selector("#learnPanel:not([hidden]) a.course-card", timeout=8000)
    cards = p.inner_text("#learnList")
    check("академия: опубликованный курс виден, импортированный черновик — нет", "Тестовый курс E2E" in cards and "Hidden Reaction System" not in cards, cards)
    p.wait_for_selector("#annPanel:not([hidden])"); check("академия: опубликованная афиша видна", "Эфир по Hidden Reaction" in p.inner_text("#annList"))
    p.click("a.course-card"); p.wait_for_selector(".lp-mod")
    with p.expect_response(re.compile(r".*/api/learn/lessons/[^/]+$")) as resp: p.click(".lp-les")   # клик внутри ожидания — без гонки
    p.wait_for_selector(".hdl-quiz")
    check("урок: правильные ответы не отправляются ученику до попытки", '"correct"' not in json.dumps(resp.value.json()) and "explanation" not in json.dumps(resp.value.json()))
    check("урок у ученика: список и жирный текст сохранились после публикации", p.locator("#body ul li").count() == 2 and p.locator("#body strong").count() >= 1)
    check("урок: текст, график и изображение", "первый сигнал" in p.inner_text("#body") and p.locator("#body svg").count() >= 1 and p.locator("#body img").count() == 1)
    p.click("#done"); p.wait_for_selector("#doneErr:not([hidden])")
    check("урок с обязательным тестом нельзя завершить без теста", "Сначала пройдите тест" in p.inner_text("#doneErr"))
    p.check(".hdl-q input[value='0']"); p.click("[data-quiz-submit]"); p.wait_for_selector(".hdl-quiz-total:not([hidden])")
    check("тест: неверный ответ — объяснение показано после попытки", "попробуйте ещё раз" in p.inner_text(".hdl-quiz-total") and "предупреждение" in p.inner_text(".hdl-quiz"))
    p.check(".hdl-q input[value='1']"); p.click("[data-quiz-submit]"); p.wait_for_timeout(400)
    check("тест пройден", "тест пройден" in p.inner_text(".hdl-quiz-total"))
    p.wait_for_function("document.getElementById('doneWrap') && document.getElementById('doneWrap').innerText.includes('Урок пройден')", timeout=8000)
    check("успешный тест сам завершает урок (кнопка не нужна)", "Урок пройден" in p.inner_text("#doneWrap"))
    p.screenshot(path="/tmp/student_lesson.png", full_page=True)
    p.goto(B + "/academy/academy.html"); p.wait_for_selector("a.course-card")
    check("прогресс ученика сохранён на сервере: 1/1, 100%", "1/1" in p.inner_text("#learnList") and "100%" in p.inner_text("#learnList"), p.inner_text("#learnList"))
    p.goto(B + "/admin/"); p.wait_for_selector(".login")
    check("ученик с доступом всё равно не входит в админ-панель", "нет прав" in p.inner_text("#main"))
    ctx.close()

    # ---------- 4. Ученик без доступа ----------
    ctx, p = new_page(b, 375)
    register(p, "nodep@test.com")
    p.goto(B + "/academy/learn.html"); p.wait_for_timeout(1500)
    check("без депозита страница обучения недоступна (перенаправление)", "learn.html" not in p.url, p.url)
    ctx.close()

    # ---------- 5. Админ-панель на телефоне, пользователи, роли, журнал ----------
    ctx, p = new_page(b, 375)
    register(p, "admin2@test.com"); get(f"/test/role?uid={uid('admin2@test.com')}&role=admin")
    p.evaluate("window.hdSignOutForTest && window.hdSignOutForTest()")
    p.goto(B + "/admin/"); p.wait_for_selector(".stats, .login", timeout=8000)
    if p.locator("#logout").count(): p.click("#menuBtn"); p.wait_for_timeout(350); p.click("#logout"); p.wait_for_selector("#lf")
    p.fill("#le", "admin2@test.com"); p.fill("#lp", "wrong-password"); p.click("#lb"); p.wait_for_selector("#lerr:not([hidden])")
    check("вход в админ-панель: неверный пароль — понятная ошибка", "Неверный email или пароль" in p.inner_text("#lerr"), p.inner_text("#lerr"))
    p.fill("#lp", "password1"); p.click("#lb"); p.wait_for_selector(".stats", timeout=8000)
    check("вход через форму админ-панели (роль admin)", "Пользователи" in p.inner_text("#nav") and "Импорт" in p.inner_text("#nav"))
    p.goto(B + "/admin/#/users"); p.wait_for_selector("#ul table", timeout=8000)
    check("телефон: боковое меню скрыто", p.evaluate("getComputedStyle(document.querySelector('.side')).transform") != "none")
    p.click("#menuBtn"); p.wait_for_timeout(350)
    check("телефон: кнопка меню открывает навигацию", p.evaluate("document.getElementById('app').classList.contains('menu-open')"))
    p.mouse.click(360, 500); p.wait_for_timeout(300)
    check("телефон: нажатие вне меню закрывает его", not p.evaluate("document.getElementById('app').classList.contains('menu-open')"))
    p.fill("#uq", "learner")
    p.wait_for_function("(()=>{const t=document.getElementById('ul').textContent;return t.includes('learner_test_com')&&!t.includes('owner_test_com')})()", timeout=8000)
    ul = p.text_content("#ul")
    check("пользователи: поиск по email находит только нужного, статус доступа", "learner_test_com" in ul and "owner_test_com" not in ul and "Доступ открыт" in ul, ul[:300])
    p.click("#ul a"); p.wait_for_selector("#rs")
    opts = p.eval_on_selector_all("#rs option", "els => els.map(e => e.value)")
    check("admin может назначать только роли ниже своей", "admin" not in opts and "super_admin" not in opts and "moderator" in opts, opts)
    p.select_option("#rs", "mentor"); p.click("#rsave"); check("роль изменена через сервер", "Роль изменена" in toast(p))
    p.wait_for_selector("#br"); p.fill("#br", "тест блокировки"); p.click("#blk"); p.click("#modalBody .mf .danger")
    check("пользователь заблокирован", "заблокирован" in toast(p))
    p.wait_for_selector("#unb"); p.click("#unb"); check("пользователь разблокирован", "разблокирован" in toast(p))
    p.goto(B + "/admin/#/audit"); p.wait_for_selector("#al table")
    log = p.inner_text("#al")
    check("журнал: вход, публикация, роль, блокировка, импорт", all(x in log for x in ["admin.login", "course.publish", "user.role", "user.block", "course.import"]), log[:400])
    p.screenshot(path="/tmp/adm_mobile_audit.png")
    ctx.close()
    b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5])
ok = sum(1 for r in results if r[0]); print(f"итого: {ok} из {len(results)}")
raise SystemExit(0 if ok == len(results) and not js_errors else 1)
