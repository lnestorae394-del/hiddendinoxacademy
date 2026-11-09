"""Смена языка без перезагрузки + прогресс + финальный экран — в браузере, от API до экрана.
Сценарии: новый ученик (0/29), частичный прогресс (1/29), завершённый курс (29/29, финальный экран). Запуск: python3 tests/e2e/lang_progress_e2e.py"""
import os, re, json, subprocess, urllib.request
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
PORT = os.environ.get("PORT", "8792"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
COURSE = json.load(open(os.path.join(ROOT, "content", "hidden-reaction-course.json"), encoding="utf-8"))
LS = [l for m in COURSE["modules"] for l in m["lessons"]]
T = lambda l, lang: (l.get("tr") or {}).get(lang, {}).get("title", l["title"]) if lang != "ru" else l["title"]
results, js_errors = [], []
CYR = re.compile(r"[А-Яа-яЁёІіЇїЄєҐґ]")
get = lambda p: json.loads(urllib.request.urlopen(B + p).read())
def postback(**q): return get("/test/postback?" + "&".join(f"{k}={v}" for k, v in {**q, "secret": "e2e-secret-0123456789abcdef-test"}.items()))
def check(n, c, x=""): results.append(bool(c)); print(("✔ " if c else "✘ ") + n + ("" if c else f" — {str(x)[:400]}"))
def new_page(b, w, lang=None):
    ctx = b.new_context(viewport={"width": w, "height": 900})
    ctx.route(re.compile(r"https://www\.gstatic\.com/firebasejs/.*/(firebase-(app|auth)\.js)"), lambda r: r.fulfill(status=200, content_type="application/javascript", body=FAKE[r.request.url.rsplit("/", 1)[1]]))
    ctx.route(re.compile(r"https://(fonts\.googleapis\.com|fonts\.gstatic\.com|telegram\.org)/.*"), lambda r: r.fulfill(status=200, body=""))
    ctx.add_init_script("window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null};" + (f"if(!localStorage.getItem('hd_lang'))localStorage.setItem('hd_lang','{lang}');" if lang else ""))
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
def register(p, email):
    p.goto(B + "/academy/"); p.wait_for_selector("#loginForm"); p.click("[data-go=register]")
    p.fill("#email", email); p.fill("#password", "password1"); p.fill("#password2", "password1"); p.click("#regBtn"); p.wait_for_url(re.compile(r".*broker\.html"), timeout=10000)
def visible_text(p, sel="body"): return p.evaluate(f"(()=>{{const w=document.createTreeWalker(document.querySelector('{sel}'),NodeFilter.SHOW_TEXT);let s='';while(w.nextNode()){{const n=w.currentNode,e=n.parentElement;if(e&&e.offsetParent!==null&&getComputedStyle(e).visibility!=='hidden')s+=n.textContent+' '}}return s}})()")
srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx, p = new_page(b, 1280); register(p, "owner@test.com"); get("/test/role?uid=owner_test_com&role=super_admin")
    p.goto(B + "/admin/#/import"); p.wait_for_selector("#if"); p.set_input_files("#if", os.path.join(ROOT, "content", "hidden-reaction-course.json"))
    p.wait_for_selector("#ib:not([disabled])"); p.check("#ic"); p.click("#ib"); p.wait_for_selector("#readyall", timeout=20000)
    p.click("#readyall"); p.check("#rac"); p.click("#modalBody .mf .primary"); p.wait_for_selector("#pub"); p.wait_for_timeout(400)
    p.click("#pub"); p.check("#cf"); p.click("#modalBody .mf .primary"); p.wait_for_selector(".pill.ok", timeout=20000); ctx.close()

    ctx, p = new_page(b, 1280, "ru"); register(p, "learner@test.com"); p.wait_for_selector("#idForm")
    p.click("#pocketBtn"); p.wait_for_function("window.__opened.length>0"); click = p.evaluate("window.__opened")[0].split("click_id=")[1]
    postback(type="registration", click_id=click, trader_id="88900001"); p.fill("#traderId", "88900001"); p.click("#idBtn"); p.wait_for_url(re.compile(r".*deposit\.html"))
    postback(type="ftd", click_id=click, trader_id="88900001", amount="60", currency="USD"); p.wait_for_url(re.compile(r".*academy\.html"), timeout=15000)
    p.wait_for_function("document.querySelector('#progList .prog-course') && /\\d+ \\/ \\d+/.test(document.querySelector('#progList .prog-course').innerText)", timeout=10000)   # модули «X / Y» в строке курса (список всех курсов)
    # ---------- 1. Новый ученик ----------
    prog = p.inner_text(".p-progress")
    check("новый: «Пройдено 0 из 29 уроков», модули 0 / 6, следующий шаг — урок 1", "Пройдено 0 из 29 уроков" in prog and "0 / 6" in prog and LS[0]["title"] in prog, prog)
    reqs = []; p.on("request", lambda r: reqs.append(r.url) if "/api/learn/courses" in r.url else None)
    p.evaluate("window.__noReload = 1")
    p.click(".langs [data-lang=en]"); p.wait_for_function("document.querySelector('.p-progress').innerText.includes('lessons completed')", timeout=8000)
    p.wait_for_function(f"document.querySelector('.p-progress').innerText.includes({json.dumps(T(LS[0], 'en'))})", timeout=8000)
    txt = visible_text(p, "main")
    check("EN без перезагрузки: статус, прогресс, курс, следующий шаг — без кириллицы", p.evaluate("window.__noReload") == 1 and not CYR.search(txt) and "0 of 29 lessons completed" in txt, CYR.findall(txt)[:10])
    p.click(".langs [data-lang=ua]"); p.wait_for_function(f"document.querySelector('.p-progress').innerText.includes('із 29') && document.querySelector('.p-progress').innerText.includes({json.dumps(T(LS[0], 'ua'))})", timeout=8000)
    check("UA без перезагрузки: «Пройдено 0 із 29 уроків», следующий шаг по-украински", "Пройдено 0 із 29 уроків" in p.inner_text(".p-progress") and T(LS[0], "ua") in p.inner_text(".p-progress"))
    n_before = len(reqs); p.click(".langs [data-lang=en]"); p.wait_for_timeout(600); p.click(".langs [data-lang=ua]"); p.wait_for_timeout(600)
    check("повторное переключение — из кэша, без новых запросов; страница не перезагружалась", len(reqs) == n_before and p.evaluate("window.__noReload") == 1, reqs)
    # ---------- 2. Частичный прогресс: язык меняется внутри урока, ответы сохраняются ----------
    p.click(".langs [data-lang=ru]"); p.wait_for_timeout(300)
    p.click(".p-progress .prog-link"); p.wait_for_selector(".hdl-quiz")
    q0 = [bl for bl in LS[0]["blocks"] if bl["type"] == "quiz"][0]["questions"]
    for qi, q in enumerate(q0): p.locator(".hdl-q").nth(qi).locator(f"input[value='{q['correct']}']").check()
    p.evaluate("window.__noReload = 2")
    p.click(".lp-langs [data-lang=en]"); p.wait_for_function(f"document.querySelector('#lp h1').textContent === {json.dumps(T(LS[0], 'en'))}", timeout=8000)
    kept = p.evaluate("[...document.querySelectorAll('.hdl-q')].map(f=>{const c=f.querySelector('input:checked');return c?Number(c.value):null})")
    check("урок: смена языка без перезагрузки — тот же урок, ответы сохранены", p.evaluate("window.__noReload") == 2 and kept == [q["correct"] for q in q0], kept)
    check("урок (EN): кнопки и подписи на английском, без кириллицы; в шапке — «Learning»", not CYR.search(visible_text(p, "#lp")) and not CYR.search(p.inner_text(".hd-head")) and p.inner_text("#crumb") == "Learning", CYR.findall(visible_text(p, "#lp"))[:8])
    p.click("[data-quiz-submit]"); p.wait_for_selector(".hdl-quiz-total:not([hidden])")
    p.wait_for_function("document.getElementById('doneWrap').innerText.includes('Lesson completed')", timeout=8000)
    check("успешный тест сразу завершает урок (без кнопки «отметить»)", "Lesson completed" in p.inner_text("#doneWrap"))
    p.click(".lp-langs [data-lang=ua]"); p.wait_for_function("document.querySelector('.hdl-quiz-total') && !document.querySelector('.hdl-quiz-total').hidden && document.querySelector('.hdl-quiz').innerText.includes('Стор.')", timeout=8000)
    check("результат теста и объяснения переведены на UA при смене языка", "Стор. 3" in p.inner_text(".hdl-quiz") and "Урок пройдено" in p.inner_text("#doneWrap"))
    p.goto(B + "/academy/academy.html"); p.wait_for_function("document.querySelector('.p-progress').innerText.includes('із 29')", timeout=10000)
    prog = p.inner_text(".p-progress")
    check("главная (UA): «Пройдено 1 із 29 уроків», модули 0 / 6, следующий — урок 2", "Пройдено 1 із 29 уроків" in prog and "0 / 6" in prog and T(LS[1], "ua") in prog, prog)
    # ---------- 3. Завершение курса ----------
    p.goto(B + "/academy/learn.html#/"); p.wait_for_selector(".lp-card"); p.click(".lp-card"); p.wait_for_selector(".lp-les")
    ids = [h.split("/lesson/")[1] for h in p.eval_on_selector_all(".lp-les", "els=>els.map(e=>e.getAttribute('href'))")]
    answers = [[q["correct"] for bl in l["blocks"] if bl["type"] == "quiz" for q in bl["questions"]] for l in LS]
    p.evaluate("async ([ids, ans]) => { for (let i = 1; i < 28; i++) await call('POST', `/api/learn/lessons/${ids[i]}/quiz`, { answers: ans[i] }); }", [ids, answers])
    p.goto(B + "/academy/learn.html#/lesson/" + ids[28]); p.wait_for_selector(".hdl-quiz")
    for qi, a in enumerate(answers[28]): p.locator(".hdl-q").nth(qi).locator(f"input[value='{a}']").check()
    p.click("[data-quiz-submit]"); p.wait_for_function("location.hash.startsWith('#/done/')", timeout=10000); p.wait_for_selector(".cg")
    cg = p.inner_text(".cg")
    check("последний урок → финальный экран открылся сам (UA)", "ВІТАЄМО!" in cg and "Ти завершив курс «" in cg and "Hidden Reaction" in cg and "Про програму:" in cg and "Повернутися до академії" in cg, cg[:300])
    check("финальный экран: 29 / 29, 6 / 6, средний результат 100%, дата, статус; без выдуманного рейтинга", "29 / 29" in cg and "6 / 6" in cg and "100%" in cg and "КУРС ЗАВЕРШЕНО" in cg and re.search(r"\d{4}", cg) and "краще, ніж" not in cg and "Порівняння з іншими учасниками" in cg, cg)
    p.click(".lp-langs [data-lang=en]"); p.wait_for_function("document.querySelector('.cg h1') && document.querySelector('.cg h1').textContent === 'CONGRATULATIONS!'", timeout=8000)
    cg = p.inner_text(".cg")
    check("финальный экран (EN): текст и кнопка «Return to Academy», без кириллицы", "You have completed “" in cg and "Hidden Reaction" in cg and "About the programme:" in cg and "Return to Academy" in cg and "COURSE COMPLETED" in cg and not CYR.search(cg), CYR.findall(cg)[:5])
    p.click(".lp-langs [data-lang=ru]"); p.wait_for_function("document.querySelector('.cg h1').textContent === 'ПОЗДРАВЛЯЕМ!'", timeout=8000)
    check("финальный экран (RU): переключение без перезагрузки", "Вернуться в академию" in p.inner_text(".cg")); p.click(".lp-langs [data-lang=en]"); p.wait_for_function("document.querySelector('.cg h1').textContent === 'CONGRATULATIONS!'", timeout=8000)
    p.click(".cg-back"); p.wait_for_url(re.compile(r".*academy\.html")); p.wait_for_function("document.querySelector('.p-progress').innerText.includes('29 of 29')", timeout=10000)
    prog = p.inner_text(".p-progress")
    check("после возврата: 29 of 29, 100%, 6 / 6, кнопка «View results»", "29 of 29 lessons completed" in prog and "100%" in prog and "6 / 6" in prog and "View results" in prog, prog)
    p.reload(); p.wait_for_function("document.querySelector('.p-progress').innerText.includes('29 of 29')", timeout=10000)
    check("после перезагрузки — те же результаты и язык", "6 / 6" in p.inner_text(".p-progress"))
    check("язык сохранён в профиле на сервере (для повторного входа)", p.evaluate("call('GET','/api/me').then(r=>r.lang)") == "en")
    p.click(".p-progress .prog-link"); p.wait_for_selector(".cg")
    check("поздравление открывается повторно", p.inner_text(".cg h1") == "CONGRATULATIONS!")
    p.goto(B + "/academy/learn.html#/"); p.wait_for_selector(".lp-card"); p.click(".lp-card"); p.wait_for_selector(".lp-mod")
    check("страница курса: «COURSE COMPLETED» и кнопка «View results»", "COURSE COMPLETED" in p.inner_text("#lp") and "View results" in p.inner_text("#lp"))
    # ---------- Кабинет партнёра: язык без перезагрузки ----------
    p.goto(B + "/academy/partner.html"); p.wait_for_selector(".pt-card")
    p.evaluate("window.__noReload = 3"); p.click(".langs [data-lang=ua]"); p.wait_for_timeout(400)
    t_ua = visible_text(p, "#pt")
    p.click(".langs [data-lang=en]"); p.wait_for_timeout(400); t_en = visible_text(p, "#pt")
    check("кабинет партнёра: UA ↔ EN без перезагрузки, EN без кириллицы", p.evaluate("window.__noReload") == 3 and "баланс" in t_ua.lower() and not CYR.search(t_en), CYR.findall(t_en)[:6])
    ctx.close(); b.close()
finally:
    srv.terminate()
print("ошибки JavaScript на страницах:", "нет" if not js_errors else js_errors[:5]); print(f"итого: {sum(results)} из {len(results)}"); raise SystemExit(0 if all(results) and not js_errors else 1)
