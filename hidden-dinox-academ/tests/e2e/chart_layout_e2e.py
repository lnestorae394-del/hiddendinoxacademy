"""Тренировка на графике: вёрстка (375/768/1280), состояния (загрузка, отправка, ошибка, результат), «Пропустить анализ».
Запуск: python3 tests/e2e/chart_layout_e2e.py"""
import os, re, json, subprocess, urllib.request, time
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PORT = os.environ.get("PORT", "8817"); B = f"http://127.0.0.1:{PORT}"
FAKE = {n: open(os.path.join(HERE, "fake-firebase", n)).read() for n in ["firebase-app.js", "firebase-auth.js"]}
results, js_errors = [], []
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
    p = ctx.new_page(); p.on("pageerror", lambda e: js_errors.append(str(e))); return ctx, p
LAYOUT = """(()=>{const W=innerWidth,o={sw:document.documentElement.scrollWidth,W,ctrl:[],groups:[],overlap:0,textOut:0,fieldOut:0};
  document.querySelectorAll('.ct-opt input').forEach(i=>{const b=i.getBoundingClientRect();o.ctrl.push(Math.round(b.width))});
  document.querySelectorAll('.ct-opts').forEach(g=>{const cs=[...g.querySelectorAll('.ct-opt')].map(c=>c.getBoundingClientRect());o.groups.push(cs.map(b=>Math.round(b.width)));
    for(let i=0;i<cs.length;i++)for(let j=i+1;j<cs.length;j++){const a=cs[i],c=cs[j];if(a.left<c.right-1&&c.left<a.right-1&&a.top<c.bottom-1&&c.top<a.bottom-1)o.overlap++}});
  document.querySelectorAll('.ct-opt span').forEach(s=>{if(s.scrollWidth>s.clientWidth+1)o.textOut++; const p=s.parentElement.getBoundingClientRect(),b=s.getBoundingClientRect(); if(b.right>p.right+1||b.bottom>p.bottom+1)o.textOut++});
  document.querySelectorAll('.ct-field input,.ct-field textarea').forEach(i=>{const b=i.getBoundingClientRect(),f=document.getElementById('ctForm').getBoundingClientRect();if(b.right>f.right+1||b.left<f.left-1)o.fieldOut++});
  return o})()"""

srv = subprocess.Popen(["node", os.path.join(HERE, "test-server.js")], stdout=subprocess.PIPE, text=True, env={**os.environ, "PORT": PORT}); srv.stdout.readline()
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch()
    actx, ap = new_ctx(b); ap.goto(B + "/"); ap.wait_for_selector("#loginForm"); ap.click("[data-go=register]")
    ap.fill("#email", "owner@test.com"); ap.fill("#password", "password1"); ap.fill("#password2", "password1"); ap.click("#regBtn"); ap.wait_for_url(re.compile(r".*broker\.html")); actx.close()
    get("/test/role?uid=owner_test_com&role=admin")
    for s in admin("GET", "/chart/scenarios")["scenarios"]:
        if s["id"] != "sim_range_chop_1": admin("POST", f"/chart/scenarios/{s['id']}/status", {"active": False})
    admin("POST", "/features/chart_training/status", {"status": "ACTIVE"})
    sctx, sp = new_ctx(b); sp.goto(B + "/"); sp.wait_for_selector("#loginForm"); sp.click("[data-go=register]")
    sp.fill("#email", "staff@test.com"); sp.fill("#password", "password1"); sp.fill("#password2", "password1"); sp.click("#regBtn"); sp.wait_for_url(re.compile(r".*broker\.html"))
    get("/test/role?uid=staff_test_com&role=team_member"); state = sctx.storage_state(); sctx.close()
    for w in (375, 768, 1280):
        ctx, p = new_ctx(b, w=w, state=state); p.goto(B + "/academy/chart-training.html"); p.wait_for_selector("#ctForm"); p.wait_for_timeout(300)
        o = p.evaluate(LAYOUT)
        check(f"{w}px: переключатели и флажки обычного размера (≤22 px)", o["ctrl"] and max(o["ctrl"]) <= 22, o["ctrl"])
        check(f"{w}px: варианты в группе одинаковой ширины", all(max(g) - min(g) <= 1 for g in o["groups"]), o["groups"])
        check(f"{w}px: карточки не перекрываются, текст внутри, поля в пределах формы", o["overlap"] == 0 and o["textOut"] == 0 and o["fieldOut"] == 0, o)
        check(f"{w}px: без горизонтальной прокрутки", o["sw"] <= o["W"] + 1, o)
        p.screenshot(path=f"/tmp/ct_layout_{w}.png", full_page=True); ctx.close()
    # состояния
    ctx, p = new_ctx(b, state=state)
    p.route(re.compile(r".*/api/chart/next.*"), lambda r: (time.sleep(1.2), r.continue_()))
    p.goto(B + "/academy/chart-training.html"); p.wait_for_selector("#ctLoading"); check("загрузка: «Загрузка…»", "Загрузка" in p.inner_text("#ctLoading"))
    p.wait_for_selector("#ctForm"); p.unroute(re.compile(r".*/api/chart/next.*"))
    p.route(re.compile(r".*/api/chart/answer"), lambda r: r.fulfill(status=500, content_type="application/json", body='{"error":"SERVER_ERROR"}'))
    p.check("input[name=dir][value=no_trade]"); p.click("#ctSubmit"); p.wait_for_selector("#ctFormErr:not([hidden])")
    check("ошибка сервера: сообщение, кнопка снова доступна", len(p.inner_text("#ctFormErr")) > 5 and not p.is_disabled("#ctSubmit") and p.inner_text("#ctSubmit") == "Зафиксировать ответ")
    p.unroute(re.compile(r".*/api/chart/answer")); p.route(re.compile(r".*/api/chart/answer"), lambda r: (time.sleep(1.2), r.continue_()))
    p.click("#ctSubmit"); p.wait_for_function("document.getElementById('ctSubmit') && document.getElementById('ctSubmit').textContent.includes('Отправка')", timeout=3000)
    check("отправка: «Отправка…», кнопки заблокированы", p.is_disabled("#ctSubmit") and p.is_disabled("#ctSkip"))
    p.wait_for_selector("#ctScore"); check("результат: баллы и разбор", "/100" in p.inner_text("#ctScore")); ctx.close()
    # пропуск
    ctx, p = new_ctx(b, state=state); p.goto(B + "/academy/chart-training.html"); p.wait_for_selector("#ctForm")
    p.click("#ctSkip"); check("«Пропустить анализ» → подтверждение, основные кнопки скрыты", p.is_visible("#ctSkipBox") and p.is_hidden("#ctActions") and "не повлияет на оценку" in p.inner_text("#ctSkipBox"))
    p.click("#ctSkipNo"); check("«Отмена» возвращает форму без пропуска", p.is_hidden("#ctSkipBox") and p.is_visible("#ctSubmit"))
    p.click("#ctSkip"); p.click("#ctSkipYes"); p.wait_for_selector("#ctSkipped")
    check("сценарий пропущен: пояснение и переход дальше", "ни правильным, ни неправильным" in p.inner_text("#ctSkipped") and p.is_visible("#ctNext"))
    p.click("[data-tab=history]"); p.wait_for_selector("#ctHist [data-skipped]")
    check("история: «Пропущено» и «Пройти снова»", "Пропущено" in p.inner_text("#ctHist") and p.locator("#ctHist [data-skipped] a").inner_text() == "Пройти снова")
    p.click("#ctHist [data-skipped] a"); p.wait_for_selector("#ctForm"); check("«Пройти снова» открывает форму сценария", p.is_visible("#ctSubmit") and "retry" not in p.url)
    p.check("input[name=dir][value=no_trade]"); p.check("input[name=f][value=no_confirmation]"); p.click("#ctSubmit"); p.wait_for_selector("#ctScore")
    p.click("[data-tab=history]"); p.wait_for_selector("#ctHist")
    check("после повтора в истории: пропуск и ответ с баллами", p.locator("#ctHist [data-skipped]").count() >= 1 and "/100" in p.inner_text("#ctHist")); ctx.close()
    for lang, skipw, conf in (("en", "Skip analysis", "will not affect your score"), ("ua", "Пропустити аналіз", "не вплине на оцінку")):
        ctx, p = new_ctx(b, lang=lang, state=state); p.goto(B + "/academy/chart-training.html#train"); p.wait_for_selector("#ctForm"); p.click("#ctSkip")
        check(f"{lang.upper()}: «{skipw}» и подтверждение переведены", p.inner_text("#ctSkip") == skipw and conf in p.inner_text("#ctSkipBox")); ctx.close()
    b.close()
finally:
    srv.terminate()
check("нет ошибок JavaScript", not js_errors, js_errors[:3])
print(f"\nИтог: {sum(results)}/{len(results)}"); raise SystemExit(0 if all(results) else 1)
