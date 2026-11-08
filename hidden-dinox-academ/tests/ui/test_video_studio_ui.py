"""Проверка страницы Video Studio в настоящем браузере (Chromium). Серверная логика — настоящая, база/хранилище/вход — тестовые заглушки."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
def skip(reason): print("ПРОПУЩЕНО (тест НЕ выполнялся и не считается пройденным): " + reason); sys.exit(3)
try: from playwright.sync_api import sync_playwright
except ImportError: skip("не установлен Python-пакет playwright (pip install playwright && playwright install chromium)")
if not shutil.which(FFMPEG): skip("не найден ffmpeg (нужен для подготовки тестовых видеофайлов)")
try:
    with sync_playwright() as _p: _b = _p.chromium.launch(); _b.close()
except Exception as _e: skip("Chromium для Playwright не запускается: " + str(_e)[:140])
SHOTS = os.environ.get("UI_SHOTS") or tempfile.mkdtemp(prefix="vs_ui_shots_"); os.makedirs(SHOTS, exist_ok=True)
MEDIA = tempfile.mkdtemp(prefix="vs_ui_media_")
def ff(*a): subprocess.run([FFMPEG, "-y", "-v", "error"] + list(a), check=True)
ff("-f", "lavfi", "-i", "testsrc2=size=540x580:rate=25:duration=40", "-f", "lavfi", "-i", "sine=frequency=330:duration=40", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", os.path.join(MEDIA, "window.mp4"))
ff("-ss", "3", "-i", os.path.join(MEDIA, "window.mp4"), "-frames:v", "1", "-vf", "scale=270:-2", os.path.join(MEDIA, "thumb.jpg"))
ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", os.path.join(MEDIA, "up_small.mp4"))
_d = open(os.path.join(MEDIA, "up_small.mp4"), "rb").read(); open(os.path.join(MEDIA, "up_big.mp4"), "wb").write(_d + b"\0" * (20 * 1024 * 1024 - len(_d)))   # 20 МБ: загрузка пойдёт двумя кусками
srv = subprocess.Popen(["node", os.path.join(ROOT, "tests/ui/ui-server.js")], stdout=subprocess.PIPE, text=True, cwd=ROOT, env=dict(os.environ, UI_MEDIA_DIR=MEDIA))
PORT = json.loads(srv.stdout.readline())["port"]; BASE = "http://127.0.0.1:%d" % PORT; PAGE = BASE + "/academy/admin/video-studio.html"
RES = []
def dbq(c): return json.load(urllib.request.urlopen(BASE + "/__db?c=" + c))
def tgq(): return json.load(urllib.request.urlopen(BASE + "/__tg"))
def doc(c, i): return next((d for d in dbq(c) if d["id"] == i), None)
def eventually(fn, timeout=8.0, msg=""):
    end = time.time() + timeout; last = None
    while time.time() < end:
        try:
            last = fn()
            if last: return last
        except Exception as e: last = e
        time.sleep(0.15)
    raise AssertionError("не дождались: %s (%s)" % (msg, last))
def step(name):
    def deco(f):
        try: f(); RES.append((name, True, "")); print("OK  ", name)
        except Exception as e: RES.append((name, False, str(e)[:300])); print("FAIL", name, "->", str(e)[:300])
        return f
    return deco
def user_ctx(b, uid=None, w=1500, h=950):
    c = b.new_context(viewport={"width": w, "height": h})
    if uid: c.add_init_script("localStorage.setItem('vs_user','%s')" % uid)
    return c
def tab(pg, name): pg.click('[data-tab="%s"]' % name)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"]); logs = []
        ctx = user_ctx(b); pg = ctx.new_page(); pg.goto(PAGE)
        @step("без входа данных нет: предлагается войти через админ-панель (отдельной авторизации страница не делает)")
        def _(): eventually(lambda: "Открыть админ-панель" in pg.inner_text("#app"), msg="приглашение"); assert "live-demo" not in pg.inner_text("#app"); assert pg.get_attribute("#app a.vs-btn", "href") == "/admin/"
        ctx.close()
        for uid, label in (("anna", "студент"), ("mia", "ментор")):
            ctx = user_ctx(b, uid); pg = ctx.new_page(); pg.goto(PAGE)
            @step("%s не получает доступ: сервер отказывает, данных нет" % label)
            def _(): eventually(lambda: "только администраторам" in pg.inner_text("#app"), msg="отказ"); assert "live-demo" not in pg.inner_text("#app")
            ctx.close()
        ctx = user_ctx(b, "boss"); pg = ctx.new_page(); pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None); pg.goto(PAGE)
        @step("администратор видит четыре раздела, проект и найденные клипы")
        def _():
            eventually(lambda: "live-demo.mp4" in pg.inner_text("#vsL"), msg="проект"); assert [x.inner_text() for x in pg.query_selector_all(".vs-tabs button")] == ["Проекты", "Очередь", "История", "Настройки"]
            assert "GROQ_API_KEY" in pg.inner_text("#vsview") and "не всё настроено" in pg.inner_text("#vsview").lower(), "баннер о ненастроенных ключах"; pg.click('[data-act="open-project"]'); eventually(lambda: len(pg.query_selector_all('[data-act="open-clip"]')) == 2, msg="два клипа"); t = pg.inner_text("#vsL"); assert "Дисциплина важнее входа" in t and "Найден" in t and "Доставлено в Telegram" in t
        @step("открытие клипа: видео 9:16, шапка, логотип, хук с первой секунды; шкала обрезки")
        def _():
            pg.click('[data-act="open-clip"][data-id="c1"]'); pg.wait_for_selector("#vsstage"); eventually(lambda: pg.evaluate("document.querySelector('#vsvid').readyState>=2"), 12, "видео загрузилось")
            assert "HIDDEN DINOX" in pg.inner_text("#vsstage"); assert pg.inner_text("#vshook") == "Дисциплина важнее входа"; assert pg.evaluate("getComputedStyle(document.querySelector('#vshook')).opacity") == "1"
            assert pg.query_selector("#vsstage .vs-logo"), "логотип в оформлении"
            if os.path.exists(os.path.join(ROOT, "public", "academy", "assets", "brand", "hd-logo.png")): eventually(lambda: pg.evaluate("(()=>{const i=document.querySelector('#vsstage .vs-logo');return i&&i.complete&&i.naturalWidth>0})()"), 5, "логотип проекта загружен")
            box = pg.evaluate("(()=>{const r=document.querySelector('#vsstage').getBoundingClientRect();return r.height/r.width})()"); assert abs(box - 1920 / 1080) < 0.02, box
            assert pg.query_selector("#tlbar") and float(pg.input_value("#tl-s")) > 60; pg.screenshot(path=SHOTS + "/01_clip_opened.png")
        @step("воспроизведение: время идёт, субтитры появляются и подсвечивают слово; перемотка; призыв в конце")
        def _():
            pg.click("#vsplay"); eventually(lambda: pg.evaluate("document.querySelector('#vsvid').currentTime>0.8"), 6, "время идёт"); eventually(lambda: pg.query_selector("#vssub .on") is not None, 5, "слово подсвечено"); pg.click("#vsplay")
            pg.evaluate("(()=>{const s=document.querySelector('#vsseek');s.value=985;s.dispatchEvent(new Event('input',{bubbles:true}))})()"); eventually(lambda: pg.evaluate("getComputedStyle(document.querySelector('#vscta')).opacity") == "1", 5, "призыв"); assert "ХОЧЕШЬ С НАМИ" in pg.inner_text("#vscta"); pg.screenshot(path=SHOTS + "/02_end_cta.png")
        @step("автосохранение: хук, слово, ★, граница блока ¶ и «не разрывать» сохраняются на сервере")
        def _():
            pg.fill("#f-hook", "Мой новый хук"); eventually(lambda: pg.inner_text("#vshook") == "Мой новый хук", 3, "предпросмотр"); e = eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("rev") == 1 and doc("videoStudioEdits", "c1"), 6, "хук сохранён"); assert e["hook"]["text"] == "Мой новый хук"
            pg.locator('.vs-w input[data-f="text"]').nth(1).fill("Дисциплина,"); e = eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("rev") == 2 and doc("videoStudioEdits", "c1"), 6, "слово"); assert e["words"][1]["text"] == "Дисциплина," and e["words"][1]["orig"]["text"] == "дисциплина"
            pg.locator('[data-act="emph"]').nth(0).click(); e = eventually(lambda: len((doc("videoStudioEdits", "c1") or {}).get("emphasis", [])) == 1 and doc("videoStudioEdits", "c1"), 6, "★")
            pg.locator('[data-act="brk"]').nth(0).click(); e = eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("breaks") and doc("videoStudioEdits", "c1"), 6, "¶"); assert len(e["breaks"]) == 1
            pg.locator('[data-act="join"]').nth(1).click(); e = eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("joins") and doc("videoStudioEdits", "c1"), 6, "join"); assert len(e["joins"]) == 1
        @step("ошибочное время отклоняется сервером; удаление, возврат и добавление слова")
        def _():
            rev = doc("videoStudioEdits", "c1")["rev"]; row = pg.locator(".vs-w").nth(3); row.locator('[data-f="start"]').fill("1.0"); row.locator('[data-f="start"]').dispatch_event("change"); eventually(lambda: pg.query_selector(".vs-toast") is not None, 5, "сообщение об ошибке"); assert doc("videoStudioEdits", "c1")["rev"] == rev
            pg.locator('[data-act="del"]').nth(2).click(); eventually(lambda: doc("videoStudioEdits", "c1")["words"][2].get("deleted") is True, 6, "удалено"); pg.locator('[data-act="restore"]').first.click(); eventually(lambda: not doc("videoStudioEdits", "c1")["words"][2].get("deleted"), 6, "возвращено")
            pg.once("dialog", lambda d: d.accept("сегодня")); pg.locator('[data-act="add"]').nth(4).click(); e = eventually(lambda: any(w.get("added") for w in doc("videoStudioEdits", "c1")["words"]) and doc("videoStudioEdits", "c1"), 6, "добавлено"); n = next(w for w in e["words"] if w.get("added")); assert n["synced"] is False
        @step("кадр: масштаб и сдвиг сохраняются и применяются в предпросмотре")
        def _():
            pg.evaluate("(()=>{const s=document.querySelector('#fr-z');s.value=1.5;s.dispatchEvent(new Event('input',{bubbles:true}))})()"); e = eventually(lambda: (doc("videoStudioEdits", "c1").get("framing") or {}).get("zoom") == 1.5 and doc("videoStudioEdits", "c1"), 6, "zoom"); assert "scale(1.5)" in pg.get_attribute("#vsvid", "style")
        @step("обрезка: границы из шкалы применяются, слова берутся из расшифровки, правки слов сохраняются")
        def _():
            before = doc("videoStudioClips", "c1"); pg.fill("#tl-s", str(round(before["start"] - 1.5, 1))); pg.dispatch_event("#tl-s", "input"); assert "изменения не применены" in pg.inner_text("#tlinfo")
            pg.click('[data-act="range-apply"]'); c = eventually(lambda: doc("videoStudioClips", "c1")["start"] < before["start"] - 1.0 and doc("videoStudioClips", "c1"), 8, "начало сдвинуто"); e = doc("videoStudioEdits", "c1"); assert len(e["words"]) > 14 and any(w["text"] == "Дисциплина," for w in e["words"]), "правка слова сохранена"
            pg.screenshot(path=SHOTS + "/03_editor.png", full_page=True)
        @step("подсказка хуков ИИ: без ключа Claude сервер честно отвечает понятной ошибкой")
        def _(): pg.click('[data-act="hooks"]'); eventually(lambda: any("ключ Claude" in t.inner_text() for t in pg.query_selector_all(".vs-toast")), 6, "сообщение")
        @step("«ПЕРЕСОБРАТЬ ВИДЕО»: создаётся задание со снимком правок; в очереди видно, можно отменить и повторить")
        def _():
            pg.click('[data-act="render"]'); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render"], 8, "задание"); assert len(j) == 1 and j[0]["payload"]["hook"]["text"] == "Мой новый хук" and j[0]["payload"]["framing"]["zoom"] == 1.5 and j[0]["payload"]["template"]["logo"]["enabled"] is True
            tab(pg, "queue"); eventually(lambda: "Сборка видео" in pg.inner_text("#vsview") and "в очереди" in pg.inner_text("#vsview"), 8, "очередь"); pg.screenshot(path=SHOTS + "/04_queue.png")
            pg.click('[data-act="cancel-job"]'); eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render" and x["status"] == "cancelled"], 8, "отменено"); eventually(lambda: pg.query_selector('[data-act="retry-job"]'), 8, "кнопка повтора"); pg.click('[data-act="retry-job"]'); eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render" and x["status"] == "queued"], 8, "снова в очереди")
        @step("история: готовый ролик со статусом Telegram; скачивание; повторная отправка создаёт задание Telegram")
        def _():
            tab(pg, "history"); eventually(lambda: "Готовый ролик" in pg.inner_text("#vsview"), 8, "карточка"); t = pg.inner_text("#vsview"); assert "Доставлено в Telegram" in t and "#555" in t; pg.screenshot(path=SHOTS + "/05_history.png")
            pg.click('[data-act="h-tg"]'); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "telegram"], 8, "задание отправки"); assert j[0]["payload"]["hash"] == "abc123abc123" and j[0]["payload"]["force"] is True
        @step("настройки Telegram: проверка подключения, тестовое сообщение, сохранение; токен не показывается")
        def _():
            tab(pg, "settings"); eventually(lambda: pg.query_selector("#tg-chat"), 8, "форма"); assert "TESTTOKEN" not in pg.inner_text("#vsview"); assert pg.input_value("#tg-chat") == "777000111"
            pg.click('[data-act="tg-check"]'); eventually(lambda: "@hd_test_bot" in pg.inner_text("#tg-res") and "можно отправлять" in pg.inner_text("#tg-res"), 8, "проверка"); assert "t.me/hd_test_bot" in pg.inner_html("#tg-res")
            pg.click('[data-act="tg-test"]'); eventually(lambda: "доставлено" in pg.inner_text("#tg-res"), 8, "тест"); assert any("тестовое сообщение" in m["text"] for m in tgq()["messages"])
            pg.fill("#tg-chat", "abc"); pg.click('[data-act="tg-save"]'); eventually(lambda: "chat_id" in pg.inner_text("#tg-res") or "Chat ID" in pg.inner_text("#tg-res"), 6, "отказ некорректного Chat ID"); pg.fill("#tg-chat", "777000111"); pg.uncheck("#tg-auto"); pg.click('[data-act="tg-save"]'); eventually(lambda: doc("videoStudioSettings", "telegram") and doc("videoStudioSettings", "telegram")["auto_send"] is False, 6, "сохранено"); pg.screenshot(path=SHOTS + "/06_settings.png", full_page=True)
        @step("настройки оформления, клипов, лимитов и словаря сохраняются; диагностика показывает FFmpeg")
        def _():
            pg.fill("#tp-subtitles-size", "76"); pg.fill("#tp-hook-size", "64"); pg.click('[data-act="tpl-save"]'); eventually(lambda: (doc("videoStudioSettings", "template") or {}).get("subtitles", {}).get("size") == 76, 6, "оформление")
            pg.fill("#tp-subtitles-size", "5"); pg.click('[data-act="tpl-save"]'); eventually(lambda: any("subtitles" in t.inner_text() for t in pg.query_selector_all(".vs-toast")), 6, "ошибка диапазона")
            pg.fill("#cl-min", "18"); pg.fill("#cl-max", "28"); pg.click('[data-act="cl-save"]'); eventually(lambda: (doc("videoStudioSettings", "clips") or {}).get("max_s") == 28, 6, "клипы")
            pg.fill("#lm-m", "7"); pg.click('[data-act="lm-save"]'); eventually(lambda: (doc("videoStudioSettings", "limits") or {}).get("monthly_usd") == 7, 6, "лимиты")
            pg.fill("#voc", "Hidden Dinox | 1 | хидден динокс\nLiquidity Grab | 2 | ликвидити греб"); pg.click('[data-act="voc-save"]'); eventually(lambda: [x["term"] for x in (doc("videoStudioSettings", "vocabulary") or {}).get("terms", [])] == ["Hidden Dinox", "Liquidity Grab"], 6, "словарь")
            assert "FFmpeg" in pg.inner_text("#vsview") and "Субтитры (libass)" in pg.inner_text("#vsview")
            pg.once("dialog", lambda d: d.accept()); pg.click('[data-act="tpl-reset"]'); eventually(lambda: doc("videoStudioSettings", "template") is None, 6, "сброс оформления")
        @step("загрузка файла двумя кусками, защита от повторной отправки того же файла")
        def _():
            tab(pg, "projects"); pg.set_input_files("#vsfile", os.path.join(MEDIA, "up_big.mp4")); pj = eventually(lambda: [x for x in dbq("videoStudioProjects") if x["id"] != "p_demo" and x["status"] == "validating"], 15, "проект перешёл в «проверка»"); assert pj[0]["size_bytes"] == 20 * 1024 * 1024
            assert [x for x in dbq("videoStudioJobs") if x["type"] == "probe" and x["project_id"] == pj[0]["id"]]; pg.screenshot(path=SHOTS + "/07_uploaded.png")
            pg.set_input_files("#vsfile", os.path.join(MEDIA, "up_big.mp4")); eventually(lambda: any("уже загружен" in t.inner_text() for t in pg.query_selector_all(".vs-toast")), 8, "повтор отклонён"); assert len([x for x in dbq("videoStudioProjects") if x["id"] != "p_demo"]) == 1
        @step("в консоли браузера нет ошибок страницы")
        def _(): bad = [l for l in logs if "favicon" not in l and "Failed to load resource" not in l and "ERR_" not in l]; assert not bad, bad[:3]
        ctx.close(); b.close()
finally:
    srv.terminate(); shutil.rmtree(MEDIA, ignore_errors=True)
ok = sum(1 for r in RES if r[1]); print("\nИТОГ: %d из %d шагов" % (ok, len(RES))); sys.exit(0 if ok == len(RES) else 1)
