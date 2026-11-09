"""Аудит 2026-10: прогресс всех курсов на главной, сброс пароля на сайте, изображение страницы блокировки,
письмо сброса пароля, сообщение Storage. Настоящие обработчики сервера на тестовой Firestore.
Запуск: python3 tests/e2e/audit_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8797"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
def check(name, cond, extra=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(extra)[:300]}"))
def req(method, path, uid=None, body=None):
    r = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={**({"Authorization": "Bearer testtoken-" + uid} if uid else {}), **({"Content-Type": "application/json"} if body is not None else {})})
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return {"_http": e.code, **json.loads(e.read() or b"{}")}
def get(path): return req("GET", path)
def new_page(b, w, h=860, lang=None, init=None):
    ctx = b.new_context(viewport={"width": w, "height": h})
    if lang: ctx.add_init_script(f"localStorage.setItem('hd_lang','{lang}');")
    if init: ctx.add_init_script(init)
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};")
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email, pw="password1"):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm")
    p.click("[data-go=register]"); p.fill("#email", email); p.fill("#password", pw); p.fill("#password2", pw); p.click("#regBtn")
    p.wait_for_url(re.compile(r".*broker\.html"), timeout=8000)
def give_access(p, trader):
    p.wait_for_selector("#idForm"); p.click("#pocketBtn"); p.wait_for_timeout(300); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    sec = "e2e-secret-0123456789abcdef-test"
    get(f"/test/postback?type=registration&click_id={click}&trader_id={trader}&secret={sec}")
    p.fill("#traderId", trader); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"), timeout=8000)
    get(f"/test/postback?type=ftd&trader_id={trader}&amount=60&currency=USD&secret={sec}")
def import_publish(owner, data):
    r = req("POST", "/admin/api/import/course", owner, {"confirm": True, "data": data}); cid = r.get("course_id")
    req("POST", f"/admin/api/courses/{cid}/ready-all", owner, {"confirm": True}); req("POST", f"/admin/api/courses/{cid}/publish", owner, {"confirm": True}); return cid
def complete(uid, cid, src, n=None):
    ids = [l["id"] for m in req("GET", f"/api/learn/courses/{cid}", uid)["course"]["modules"] for l in m["lessons"]]
    lessons = [l for m in src["modules"] for l in m["lessons"]]
    for lid, l in list(zip(ids, lessons))[: (n if n is not None else len(ids))]:
        qb = next(b for b in l["blocks"] if b["type"] == "quiz")
        req("POST", f"/api/learn/lessons/{lid}/quiz", uid, {"block_id": qb["id"], "answers": [q["correct"] for q in qb["questions"]]})
    return len(ids)
def prog(p):
    p.wait_for_selector("#progList article", timeout=10000)
    return p.eval_on_selector_all("#progList article", "a=>a.map(x=>({t:x.querySelector('.pc-title').childNodes[0].textContent.trim(),st:x.querySelector('.pc-st').textContent,pct:x.querySelector('.ring').textContent,txt:x.innerText,next:(x.querySelector('.pc-next a')||{}).getAttribute&&x.querySelector('.pc-next a').getAttribute('href')}))")
HR = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
SMC = json.load(open(os.path.join(ROOT, "content", "binary", "smart_money_concepts_binary.json"), encoding="utf-8"))
RM = json.load(open(os.path.join(ROOT, "content", "binary", "risk_management_binary.json"), encoding="utf-8"))

ACC = "localStorage.setItem('fakeFbAccounts',JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('fakeFbAccounts')||'{}'),{'learner@test.com':'password1','fresh@test.com':'password1'})));"
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    # ---------- Курсы: три опубликованных ----------
    ctx, p = new_page(b, 1280); register(p, "owner@test.com"); get("/test/role?uid=owner_test_com&role=super_admin"); ctx.close()
    OW = "owner_test_com"
    cids = [import_publish(OW, d) for d in (HR, SMC, RM)]
    check("три курса импортированы и опубликованы", all(cids) and len(set(cids)) == 3, cids)
    # ---------- Ученик: HR 100%, SMC 100%, RM частично ----------
    ctx, p = new_page(b, 1280); register(p, "learner@test.com"); give_access(p, "77700011"); U = "learner_test_com"
    nh = complete(U, cids[0], HR); ns = complete(U, cids[1], SMC); nr = complete(U, cids[2], RM, 5)
    p.goto(B + "/academy/academy.html"); rows = prog(p)
    titles = [r["t"] for r in rows]
    check("в прогрессе все 3 курса (SMC и Risk Management тоже)", len(rows) == 3 and any("SMART MONEY" in t for t in titles) and any("RISK MANAGEMENT" in t for t in titles) and any("HIDDEN" in t.upper() and "REACTION" in t.upper() for t in titles), titles)
    by = {("smc" if "SMART" in r["t"] else "rm" if "RISK" in r["t"] else "hr"): r for r in rows}
    check(f"Hidden Reaction: 100%, {nh} из {nh}, модули 6/6, «Завершён»", by["hr"]["pct"] == "100%" and f"{nh} из {nh}" in by["hr"]["txt"] and "6 / 6" in by["hr"]["txt"] and by["hr"]["st"] == "Завершён", by["hr"])
    check(f"SMC: 100%, {ns} из {ns}, модули 14/14, ссылка на результаты", by["smc"]["pct"] == "100%" and f"{ns} из {ns}" in by["smc"]["txt"] and "14 / 14" in by["smc"]["txt"] and "#/done/" in (by["smc"]["next"] or ""), by["smc"])
    pr = round(5 * 100 / nr)
    check(f"Risk Management: 5 из {nr} ({pr}%), «В процессе», следующий урок — ссылкой", by["rm"]["pct"] == f"{pr}%" and f"5 из {nr}" in by["rm"]["txt"] and by["rm"]["st"] == "В процессе" and "#/lesson/" in (by["rm"]["next"] or ""), by["rm"])
    check("пустой блок «Обучение ещё не началось» скрыт", p.is_hidden(".p-progress .prog-empty") and p.is_hidden(".p-progress .kv"))
    p.reload(); rows2 = prog(p)
    check("после перезагрузки прогресс тот же (не сбрасывается, не дублируется)", [(r["t"], r["pct"]) for r in rows2] == [(r["t"], r["pct"]) for r in rows] and len(rows2) == 3)
    complete(U, cids[2], RM, 5); p.reload(); r3 = {("rm" if "RISK" in r["t"] else "x"): r for r in prog(p)}["rm"]
    check("повторная сдача тех же уроков не увеличивает счётчик", f"5 из {nr}" in r3["txt"], r3["txt"])
    for lg, done, prg in (("en", "Completed", "In progress"), ("ua", "Завершено", "У процесі")):
        p.click(f".langs button[data-lang={lg}]"); p.wait_for_timeout(400); st = [r["st"] for r in prog(p)]
        check(f"язык {lg.upper()}: статусы переведены", done in st and prg in st, st)
    ctx.close()
    # ---------- Задача A: «Посмотреть результат» — страница итогов именно этого курса ----------
    def course_api(cid, lg): return req("GET", f"/api/learn/courses/{cid}?lang={lg}", U)["course"]
    for lg in ("ru", "en", "ua"):
        ctxc, pc = new_page(b, 1280, lang=lg, init=ACC)
        pc.goto(B + "/academy/index.html"); pc.wait_for_selector("#loginForm"); pc.fill("#email", "learner@test.com"); pc.fill("#password", "password1"); pc.click("#loginBtn")
        pc.wait_for_url(re.compile(r".*academy\.html"), timeout=8000)
        if lg == "ru":   # кнопка «Посмотреть результат» в карточке Smart Money на главной
            rows = prog(pc); smc_row = next(r for r in rows if "SMART" in r["t"])
            check("на главной у Smart Money ссылка результата ведёт на его ID", smc_row["next"] == f"learn.html#/done/{cids[1]}", smc_row["next"])
        texts = {}
        for key, cid, nl, nm in (("smc", cids[1], ns, 14), ("hr", cids[0], nh, 6)):
            api_c = course_api(cid, lg)
            pc.goto(B + f"/academy/learn.html#/done/{cid}"); pc.wait_for_selector("#cgCourse", timeout=10000)
            if key == "hr": pc.reload(); pc.wait_for_selector("#cgCourse", timeout=10000)          # обновление страницы не теряет курс
            t = pc.inner_text("section.cg"); texts[key] = t
            check(f"[{lg.upper()}] итоги {key.upper()}: название этого курса, {nl}/{nl} уроков, {nm}/{nm} модулей", api_c["title"] in pc.inner_text("#cgCourse") and f"{nl} / {nl}" in t and f"{nm} / {nm}" in t, (api_c["title"], t[:200]))
            check(f"[{lg.upper()}] итоги {key.upper()}: описание именно этой программы", pc.is_visible("#cgAbout") and api_c["description"][:60] in pc.inner_text("#cgAbout"), pc.inner_text("#cgAbout")[:120] if pc.is_visible("#cgAbout") else "нет #cgAbout")
        hr_t, smc_t = course_api(cids[0], lg)["title"], course_api(cids[1], lg)["title"]
        check(f"[{lg.upper()}] курсы не подменяют друг друга (в итогах SMC нет Hidden Reaction и «29», в итогах HR нет SMC)",
              hr_t not in texts["smc"] and not re.search(r"\b29\b", texts["smc"]) and smc_t not in texts["hr"], (hr_t, smc_t))
        ctxc.close()
    ctxc, pc = new_page(b, 1280, init=ACC)
    pc.goto(B + "/academy/index.html"); pc.wait_for_selector("#loginForm"); pc.fill("#email", "learner@test.com"); pc.fill("#password", "password1"); pc.click("#loginBtn"); pc.wait_for_url(re.compile(r".*academy\.html"), timeout=8000)
    pc.goto(B + f"/academy/learn.html#/done/{cids[2]}"); pc.wait_for_selector("section.cg h1", timeout=10000)
    t = pc.inner_text("section.cg")
    check(f"незавершённый Risk Management: «в процессе», его название и 5 / {nr}", RM["course"]["title"] in t and f"5 / {nr}" in t and not pc.is_visible("#cgAbout"), t[:200])
    ctxc.close()
    ctx, p = new_page(b, 375, init=ACC); p.goto(B + "/academy/index.html"); p.wait_for_selector("#loginForm"); p.fill("#email", "learner@test.com"); p.fill("#password", "password1"); p.click("#loginBtn")
    p.wait_for_url(re.compile(r".*academy\.html"), timeout=8000); prog(p)
    check("телефон 375px: блок прогресса без горизонтальной прокрутки", p.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), p.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    ctx.close()
    # новый ученик с доступом: все курсы видны, «Не начат», 0%
    ctx, p = new_page(b, 1280); register(p, "fresh@test.com"); give_access(p, "77700022"); p.goto(B + "/academy/academy.html"); rows = prog(p)
    check("новый ученик: 3 курса, у всех 0% и «Не начат»", len(rows) == 3 and all(r["pct"] == "0%" and r["st"] == "Не начат" for r in rows), [(r["pct"], r["st"]) for r in rows])
    # публикация нового курса — появляется автоматически (без правок интерфейса)
    extra = json.loads(json.dumps(RM)); extra["course"]["slug"] = "risk-management-binary-copy"; extra["course"]["title"] = "ТЕСТОВЫЙ НОВЫЙ КУРС"
    import_publish(OW, extra); p.reload(); rows = prog(p)
    check("новый опубликованный курс появился в прогрессе автоматически", len(rows) == 4 and any(r["t"] == "ТЕСТОВЫЙ НОВЫЙ КУРС" for r in rows), [r["t"] for r in rows])
    ctx.close()

    # ---------- Сброс пароля ----------
    get("/test/forgot-off?on=1")                             # почта сервера не настроена → запасной путь Firebase
    ctx, p = new_page(b, 1280); p.goto(B + "/academy/index.html#reset"); p.wait_for_selector("#resetForm")
    check("index.html#reset открывает восстановление пароля", p.is_visible("#resetForm"))
    p.fill("#email", "learner@test.com"); p.click("#resetBtn"); p.wait_for_function("window.__resetSentTo")
    st = p.evaluate("window.__resetSettings")
    check("[запасной путь] письмо Firebase с возвратом на страницу входа этого сайта", st and st.get("url") == B + "/", st)
    p.evaluate("window.__fakeRejectContinue=true;window.__resetSentTo=null"); p.click("#resetBtn"); p.wait_for_function("window.__resetSentTo")
    check("[запасной путь] домен не разрешён в Firebase → письмо всё равно отправлено (без адреса возврата)", p.evaluate("window.__resetSettings") is None)
    get("/test/forgot-off?on=0")
    ctx.close()
    CODES = {"GOOD": {"email": "learner@test.com", "state": "ok"}, "OLD": {"email": "learner@test.com", "state": "expired"}, "VE1": {"email": "learner@test.com", "state": "ok", "mode": "verifyEmail"}}
    seed = "if(!localStorage.getItem('fakeFbCodes'))localStorage.setItem('fakeFbCodes',JSON.stringify(%s));" % json.dumps(CODES)
    seed += "if(!localStorage.getItem('fakeFbAccounts'))localStorage.setItem('fakeFbAccounts',JSON.stringify({'learner@test.com':'password1'}));"
    ctx, p = new_page(b, 1280, init=seed)
    p.goto(B + "/academy/reset-password.html?mode=resetPassword&oobCode=GOOD&apiKey=x&lang=ru"); p.wait_for_selector("#rpForm")
    check("действующая ссылка: форма нового пароля с email", "learner@test.com" in p.inner_text("main"))
    check("код убран из адресной строки (нет в истории и Referer)", "oobCode" not in p.url and p.url.endswith("/academy/reset-password.html"), p.url)
    check("страница не передаёт Referer и закрыта от индексации", p.get_attribute("meta[name=referrer]", "content") == "no-referrer" and p.get_attribute("meta[name=robots]", "content") == "noindex")
    p.fill("#password", "newpass99"); p.fill("#password2", "newpass98"); p.click("#rpBtn")
    check("несовпадение паролей", "не совпадают" in p.inner_text("#e_password2"), p.inner_text("#e_password2"))
    p.fill("#password", "short"); p.fill("#password2", "short"); p.click("#rpBtn")
    check("короткий пароль отклоняется до отправки", "8" in p.inner_text("#e_password"), p.inner_text("#e_password"))
    p.fill("#password", "password123"); p.fill("#password2", "password123"); p.click("#rpBtn"); p.wait_for_selector("#notice.show")
    check("слабый пароль (ответ Firebase): сообщение, форма остаётся", "простой" in p.inner_text("#noticeText") and p.is_visible("#rpForm"), p.inner_text("#noticeText"))
    p.evaluate("window.__fakeNetDown=true"); p.fill("#password", "newpass99"); p.fill("#password2", "newpass99"); p.click("#rpBtn"); p.wait_for_function("document.getElementById('noticeText').textContent.includes('связи')")
    check("нет сети при сохранении: сообщение, форма и код сохранены", p.is_visible("#rpForm"))
    p.evaluate("window.__fakeNetDown=false"); p.click("#rpBtn"); p.wait_for_selector("#toLogin")
    check("пароль изменён: подтверждение и кнопка «Перейти ко входу»", "Пароль изменён" in p.inner_text("main"))
    p.click("#toLogin"); p.wait_for_selector("#loginForm"); p.fill("#email", "learner@test.com"); p.fill("#password", "newpass99"); p.click("#loginBtn")
    p.wait_for_url(re.compile(r".*academy\.html"), timeout=8000); check("вход с новым паролем работает", "academy.html" in p.url)
    p.goto(B + "/academy/reset-password.html?mode=resetPassword&oobCode=GOOD"); p.wait_for_selector("#rpNewLink")
    check("повторное использование ссылки: «недействительна» + «Запросить новую ссылку» (/#reset)", "уже использовали" in p.inner_text("main") and p.get_attribute("#rpNewLink", "href") == "/#reset")
    p.goto(B + "/academy/reset-password.html?mode=resetPassword&oobCode=OLD"); p.wait_for_selector("#rpBadText")
    check("просроченная ссылка", "истёк" in p.inner_text("#rpBadText"), p.inner_text("#rpBadText"))
    p.goto(B + "/academy/reset-password.html"); p.wait_for_selector("#rpBadText")
    check("некорректная ссылка (без кода)", "недействительна" in p.inner_text("#rpBadText"))
    p.goto(B + "/academy/reset-password.html?mode=resetPassword&oobCode=NOPE"); p.wait_for_selector("#rpBadText")
    check("неизвестный код", "недействительна" in p.inner_text("#rpBadText"))
    ctx.close()
    ctx, p = new_page(b, 1280, init=seed + "window.__fakeNetDown=true;")
    p.goto(B + "/academy/reset-password.html?mode=resetPassword&oobCode=VE1"); p.wait_for_selector("#rpRetry")
    check("нет сети при проверке ссылки: «Повторить»", "связи" in p.inner_text("#rpBadText"))
    ctx.close()
    ctx, p = new_page(b, 375, init=seed)
    p.goto(B + "/academy/reset-password.html?mode=verifyEmail&oobCode=VE1&lang=uk"); p.wait_for_selector("#toLogin")
    check("ссылка подтверждения email тоже обрабатывается; язык из письма (uk → UA)", "Email підтверджено" in p.inner_text("main"), p.inner_text("main")[:120])
    check("телефон 375px: страница сброса без горизонтальной прокрутки", p.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    ctx.close()
    for lg, word in (("en", "Create a new password"), ("ua", "Придумай новий пароль")):
        CODES2 = {"G2": {"email": "x@test.com", "state": "ok"}}
        ctx, p = new_page(b, 1280, lang=lg, init="localStorage.setItem('fakeFbCodes',JSON.stringify(%s));" % json.dumps(CODES2))
        p.goto(B + "/academy/reset-password.html?mode=resetPassword&oobCode=G2"); p.wait_for_selector("#rpForm")
        check(f"страница сброса на {lg.upper()}", word in p.inner_text("main")); ctx.close()

    # ---------- Страница блокировки ----------
    ctx, p = new_page(b, 1280, init=ACC); p.goto(B + "/academy/index.html"); p.wait_for_selector("#loginForm"); p.fill("#email", "fresh@test.com"); p.fill("#password", "password1"); p.click("#loginBtn"); p.wait_for_url(re.compile(r".*academy\.html"))
    r = req("POST", "/admin/api/users/fresh_test_com/block", OW, {"blocked": True, "reason": "test", "confirm": True})
    check("блокировка через админку выполнена", r.get("blocked") is True, r)
    try: p.goto(B + "/academy/academy.html")
    except Exception: pass                                   # перенаправление на blocked.html прерывает загрузку academy.html — это ожидаемо
    for _ in range(40):                                      # ждём перенаправления, не завися от прерванной навигации
        if p.url.endswith("/blocked.html"): break
        p.wait_for_timeout(250)
    p.wait_for_selector(".bl-card img")
    info = p.eval_on_selector(".bl-card img", "i=>({src:i.getAttribute('src'),nw:i.naturalWidth,w:i.getBoundingClientRect().width})")
    check("заблокированный ученик попадает на blocked.html с новым изображением", "mascot-crying-blocked.webp" in info["src"] and info["nw"] == 600, info)
    p.screenshot(path="/tmp/blocked_desktop.png")
    ctx.close()
    for w in (375, 1280):
        ctx, p = new_page(b, w); p.goto(B + "/academy/blocked.html"); p.wait_for_selector(".bl-card img")
        p.wait_for_function("document.querySelector('.bl-card img').complete")
        d = p.evaluate("({sw:document.documentElement.scrollWidth,iw:innerWidth,w:document.querySelector('.bl-card img').getBoundingClientRect().width})")
        check(f"blocked.html {w}px: изображение {round(d['w'])}px, без горизонтальной прокрутки", d["sw"] <= d["iw"] + 1 and 120 < d["w"] <= 260, d)
        if w == 375: p.screenshot(path="/tmp/blocked_mobile.png", full_page=True)
        ctx.close()
    from PIL import Image
    im = Image.open(os.path.join(ROOT, "public/academy/assets/mascot/mascot-crying-blocked.webp"))
    a = im.getchannel("A"); hist = a.histogram()
    check("изображение с настоящей прозрачностью (RGBA, углы прозрачны)", im.mode == "RGBA" and a.getpixel((2, 2)) == 0 and a.getpixel((im.width - 3, 2)) == 0 and sum(hist[:10]) > 0.3 * im.width * im.height)

    # ---------- Письмо сброса пароля ----------
    html = open(os.path.join(ROOT, "docs/email/password-reset.html"), encoding="utf-8").read()
    check("письмо: без старого бренда в тексте", not re.search(r"ai-boost|AI BOOST|%APP_NAME%", re.sub(r"<!--.*?-->", "", html, flags=re.S), re.I))
    check("письмо: кнопка и резервная ссылка ведут на %LINK%, есть %EMAIL%", html.count('href="%LINK%"') == 2 and "%EMAIL%" in html)
    demo = html.replace("%LINK%", B + "/academy/reset-password.html?mode=resetPassword&oobCode=DEMO").replace("%EMAIL%", "learner@test.com").replace("https://hidden-dinox-academy-test2.onrender.com", B)
    for w in (600, 375):
        ctx, p = new_page(b, w); p.set_content(demo); p.wait_for_load_state("networkidle")
        d = p.evaluate("({sw:document.documentElement.scrollWidth,iw:innerWidth,logo:document.querySelector('img').naturalWidth,btn:[...document.querySelectorAll('a')].find(a=>a.textContent.includes('Сбросить')).getBoundingClientRect().width})")
        check(f"письмо {w}px: без горизонтальной прокрутки, логотип загружен, кнопка видна", d["sw"] <= d["iw"] + 1 and d["logo"] == 192 and d["btn"] > 150, d)
        p.screenshot(path=f"/tmp/email_{w}.png", full_page=True); ctx.close()

    # ---------- Storage: понятное сообщение ----------
    out = subprocess.run(["node", "-e", "const s=require('./academy/storage.js');const a=s.describeStorageError({code:404},'ai-boost-10540.firebasestorage.app');const c=s.describeStorageError({code:402,message:'billing'},'x');console.log(JSON.stringify([a,c]))"], cwd=ROOT, capture_output=True, text=True)
    a, c = json.loads(out.stdout)
    check("Storage: «бакет не создан» с шагами и требованием Blaze", a["code"] == "BUCKET_NOT_FOUND" and "Get started" in a["hint"] and "Blaze" in a["hint"], a)
    check("Storage: ошибка тарифа распознаётся отдельно", c["code"] == "BILLING_REQUIRED", c)
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript на страницах", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}")
raise SystemExit(0 if all(results) else 1)
