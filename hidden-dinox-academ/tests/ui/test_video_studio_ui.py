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
BRAND = os.path.join(ROOT, "public", "academy", "assets", "brand"); HAS_LOGO = os.path.isdir(BRAND) and any(f.endswith(".png") for f in os.listdir(BRAND)); N_LOGO = len([f for f in os.listdir(BRAND) if f.endswith(".png") and not f.startswith("._")]) if HAS_LOGO else 0
RES = []; BAD = []; PAGE_ERR = []; EXPECT_FAIL = [False]; LASTPG = [None]
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
        except Exception as e:
            extra = ""
            try: extra = " || экран: " + LASTPG[0].inner_text("#vs-view")[:220].replace("\n", " | ") + " || уведомления: " + " ; ".join(LASTPG[0].locator(".vs-toast").all_inner_texts())[:200]
            except Exception: pass
            RES.append((name, False, str(e)[:300])); print("FAIL", name, "->", str(e)[:900] + extra)
            try: LASTPG[0].screenshot(path=SHOTS + "/fail_%02d.png" % len(RES))
            except Exception: pass
        return f
    return deco
def user_ctx(b, uid=None, w=1500, h=950):
    c = b.new_context(viewport={"width": w, "height": h})
    if uid: c.add_init_script("localStorage.setItem('vs_user','%s')" % uid)
    return c
def txt(pg, sel="#vs-view"): return pg.inner_text(sel)
def save(pg): pg.click("#ed-save"); eventually(lambda: "Сохранено" in txt(pg, "#ed-state"), 8, "индикатор «Сохранено»")
def go(pg, nav):
    if pg.locator('[data-nav="%s"]' % nav).count(): pg.click('[data-nav="%s"]' % nav)
    else: pg.evaluate("location.hash='#/%s'" % nav)
    eventually(lambda: pg.evaluate("location.hash").startswith("#/" + nav), 5, "переход " + nav)
def noerr(pg): assert pg.locator(".vs-errbox").count() == 0, "в разделе есть блок ошибки: " + (pg.locator(".vs-errbox").first.inner_text()[:150] if pg.locator(".vs-errbox").count() else "")
def watch(pg):
    pg.on("pageerror", lambda e: PAGE_ERR.append((str(e) + " @ " + str(getattr(e, "stack", "")))[:700]))
    pg.on("response", lambda r: BAD.append((r.status, r.url)) if (r.status >= 500 or r.status == 404) and BASE in r.url and not EXPECT_FAIL[0] and "/hooks" not in r.url and "favicon" not in r.url and not ("assets/brand" in r.url and not HAS_LOGO) else None)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"]); logs = []
        ctx = user_ctx(b); pg = ctx.new_page(); pg.goto(PAGE)
        @step("без входа данных нет: предлагается войти через админ-панель")
        def _(): eventually(lambda: "Открыть админ-панель" in txt(pg, "#app"), msg="приглашение"); assert "live-demo" not in txt(pg, "#app"); assert pg.get_attribute("#app a.vs-btn", "href") == "/admin/"
        ctx.close()
        for uid, label in (("anna", "студент"), ("mia", "ментор")):
            ctx = user_ctx(b, uid); pg = ctx.new_page(); pg.goto(PAGE)
            @step("%s не получает доступ: сервер отказывает, данных нет" % label)
            def _(): eventually(lambda: "Доступ запрещён" in txt(pg, "#app"), msg="отказ"); assert "live-demo" not in txt(pg, "#app")
            ctx.close()
        ctx = user_ctx(b, "boss"); pg = ctx.new_page(); LASTPG[0] = pg; watch(pg); pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None); pg.goto(PAGE)
        @step("оболочка: боковая навигация (10 разделов), верхняя панель, рабочая область на всю ширину, не «виджет в углу»")
        def _():
            eventually(lambda: pg.locator(".vs-kpi").count() >= 6, 10, "Обзор загрузился"); noerr(pg); assert pg.locator("[data-nav]").count() == 10 and pg.inner_text("#vs-title") == "Обзор"
            side = pg.locator(".vs-side").bounding_box(); main = pg.locator(".vs-content").bounding_box(); assert 230 <= side["width"] <= 270 and side["height"] >= 900, side; assert main["width"] > 1150, "рабочая область занимает всю ширину: %s" % main
            assert pg.locator(".vs-topbar").count() == 1 and pg.locator("#vs-pills .vs-pill").count() >= 2; assert "Hidden Dinox Video Studio" in txt(pg, ".vs-side"); pg.screenshot(path=SHOTS + "/01_dashboard.png", full_page=True)
        @step("Обзор: реальные цифры (1 проект, 1 готовый ролик в Telegram), состояние хранилища, последние проекты")
        def _():
            t = txt(pg); assert "live-demo.mp4" in t; k = pg.locator(".vs-kpi").all_inner_texts(); assert k[0].startswith("1\n") or "\n1\n" in "\n" + k[0] + "\n", k[0]; assert "в Telegram: 1" in k[1] and k[1].strip().split("\n")[0] == "1", k[1]
            assert pg.locator(".vs-status-card").count() == 3 and "Хранилище видео" in t and "Обработка видео" in t and "FFmpeg" in t; assert pg.locator("svg.vs-chart").count() == 1
        @step("все пункты навигации открываются без ошибок")
        def _():
            for nav, title in [("projects", "Проекты"), ("uploads", "Центр загрузки"), ("queue", "Очередь обработки"), ("clips", "Готовые клипы"), ("editors", "Монтажёры"), ("media", "Медиатека"), ("history", "История готовых видео"), ("analytics", "Аналитика"), ("settings", "Настройки"), ("dashboard", "Обзор")]:
                go(pg, nav); eventually(lambda: pg.inner_text("#vs-title") == title, 5, title); eventually(lambda: pg.locator(".vs-skel").count() == 0, 10, "загрузка " + nav); noerr(pg); big = pg.evaluate("Array.from(document.querySelectorAll('#vs-view *')).filter(e => !e.closest('.vs-stage-wrap') && e.tagName !== 'svg' && e.getBoundingClientRect().width >= 1000 && e.getBoundingClientRect().height >= 1500).map(e => e.tagName + '.' + e.className)"); assert not big, "элемент-перекрытие в разделе " + nav + ": " + str(big)[:200]
                assert "ничего" != txt(pg).strip().lower() and pg.evaluate("document.querySelector('#vs-view').innerText.length") > 20, nav
        @step("Проекты: поиск, фильтр, сортировка, сетка и список, карточка с превью, кнопки действий")
        def _():
            go(pg, "projects"); eventually(lambda: pg.locator(".vs-pcard").count() == 1, 8, "карточка"); c = txt(pg, ".vs-pcard"); assert "live-demo.mp4" in c and "2 клипов" in c and "1 готово" in c and "1 в Telegram" in c; eventually(lambda: pg.evaluate("document.querySelector('.vs-cover').classList.contains('has')"), 8, "превью загружено")
            pg.fill("#pl-q", "нет-такого"); assert "Ничего не найдено" in txt(pg); pg.fill("#pl-q", "live"); assert pg.locator(".vs-pcard").count() == 1; pg.select_option("#pl-st", "error"); assert "Ничего не найдено" in txt(pg); pg.select_option("#pl-st", ""); pg.select_option("#pl-so", "name")
            pg.click("#pl-l"); eventually(lambda: pg.locator("table.vs-table").count() == 1, 4, "список"); assert pg.locator(".vs-pcard").count() == 0; pg.click("#pl-g"); eventually(lambda: pg.locator(".vs-pcard").count() == 1, 4, "сетка"); assert pg.locator(".vs-pcard [data-dl]").count() == 1 and pg.locator(".vs-pcard [data-an]").count() == 1 and pg.locator(".vs-pcard [data-del]").count() == 1
        @step("проект открывается: состояние в адресе страницы, список клипов, обновление страницы ничего не теряет")
        def _():
            pg.click(".vs-pcard .vs-btn.primary"); eventually(lambda: pg.locator(".vs-clip").count() == 2, 8, "клипы"); assert "#/projects/p_demo" in pg.evaluate("location.href"); assert "сводка проекта" in txt(pg).lower()
            pg.click('.vs-clip[data-open="c1"]'); eventually(lambda: pg.evaluate("location.hash").endswith("/c1"), 4, "адрес клипа"); eventually(lambda: pg.query_selector("#vsstage"), 8, "редактор"); pg.reload(); eventually(lambda: pg.query_selector("#vsstage") is not None, 12, "редактор после обновления страницы"); assert pg.locator(".vs-clip.sel").count() == 1
        @step("редактор: видео 9:16, шапка, логотип, хук с первой секунды, шкала обрезки; воспроизведение, подсветка слов, перемотка, призыв")
        def _():
            eventually(lambda: pg.evaluate("document.querySelector('#vsvid') && document.querySelector('#vsvid').readyState>=2"), 15, "видео загрузилось"); assert "HIDDEN DINOX" in txt(pg, "#vsstage") and txt(pg, "#vshook") == "Дисциплина важнее входа"; assert pg.query_selector("#vsstage .vs-logo"), "логотип в оформлении"
            if HAS_LOGO: eventually(lambda: pg.evaluate("(()=>{const i=document.querySelector('#vsstage .vs-logo');return i&&i.complete&&i.naturalWidth>0})()"), 6, "логотип проекта показан")
            box = pg.evaluate("(()=>{const r=document.querySelector('#vsstage').getBoundingClientRect();return r.height/r.width})()"); assert abs(box - 1920 / 1080) < 0.02, box; assert pg.query_selector("#tlbar") and float(pg.input_value("#tl-s")) > 60
            pg.click("#vsplay"); eventually(lambda: pg.evaluate("document.querySelector('#vsvid').currentTime>0.8"), 6, "время идёт"); eventually(lambda: pg.query_selector("#vssub .on") is not None, 5, "слово подсвечено"); pg.click("#vsplay")
            pg.evaluate("(()=>{const s=document.querySelector('#vsseek');s.value=985;s.dispatchEvent(new Event('input',{bubbles:true}))})()"); eventually(lambda: pg.evaluate("getComputedStyle(document.querySelector('#vscta')).opacity") == "1", 5, "призыв"); assert "ХОЧЕШЬ С НАМИ" in txt(pg, "#vscta"); pg.screenshot(path=SHOTS + "/02_editor.png", full_page=True)
        @step("ручное сохранение: до «Сохранить» на сервере ничего нет, после — хук, слово, ★, граница блока и «не разрывать» сохранены; индикатор показывает состояние")
        def _():
            pg.fill("#f-hook", "Мой новый хук"); eventually(lambda: txt(pg, "#vshook") == "Мой новый хук", 3, "предпросмотр"); assert "Есть несохранённые изменения" in txt(pg, "#ed-state") and doc("videoStudioEdits", "c1")["rev"] == 0, "до «Сохранить» на сервере ничего нет"; save(pg); e = eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("rev") == 1 and doc("videoStudioEdits", "c1"), 6, "хук сохранён"); assert e["hook"]["text"] == "Мой новый хук"
            pg.locator('.vs-w input[data-f="text"]').nth(1).fill("Дисциплина,"); save(pg); e = eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("rev") == 2 and doc("videoStudioEdits", "c1"), 6, "слово"); assert e["words"][1]["text"] == "Дисциплина," and e["words"][1]["orig"]["text"] == "дисциплина"
            pg.locator('[data-act="emph"]').nth(0).click(); pg.locator('[data-act="brk"]').nth(0).click(); pg.locator('[data-act="join"]').nth(1).click(); save(pg); eventually(lambda: len((doc("videoStudioEdits", "c1") or {}).get("emphasis", [])) == 1, 6, "★"); eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("breaks"), 6, "¶"); eventually(lambda: (doc("videoStudioEdits", "c1") or {}).get("joins"), 6, "join")
        @step("ошибочное время отклоняется сервером; удаление, возврат и добавление слова; масштаб кадра")
        def _():
            rev = doc("videoStudioEdits", "c1")["rev"]; row = pg.locator(".vs-w").nth(3); row.locator('[data-f="start"]').fill("1.0"); row.locator('[data-f="start"]').dispatch_event("change"); pg.click("#ed-save"); eventually(lambda: pg.locator(".vs-toast.bad").count() >= 1, 5, "сообщение об ошибке"); assert doc("videoStudioEdits", "c1")["rev"] == rev
            pg.locator('[data-act="del"]').nth(2).click(); save(pg); eventually(lambda: doc("videoStudioEdits", "c1")["words"][2].get("deleted") is True, 6, "удалено"); pg.locator('[data-act="restore"]').first.click(); save(pg); eventually(lambda: not doc("videoStudioEdits", "c1")["words"][2].get("deleted"), 6, "возвращено")
            pg.once("dialog", lambda d: d.accept("сегодня")); pg.locator('[data-act="add"]').nth(4).click(); e = eventually(lambda: any(w.get("added") for w in doc("videoStudioEdits", "c1")["words"]) and doc("videoStudioEdits", "c1"), 6, "добавлено"); assert next(w for w in e["words"] if w.get("added"))["synced"] is False
            pg.evaluate("(()=>{const s=document.querySelector('#fr-z');s.value=1.5;s.dispatchEvent(new Event('input',{bubbles:true}))})()"); save(pg); eventually(lambda: (doc("videoStudioEdits", "c1").get("framing") or {}).get("zoom") == 1.5, 6, "zoom"); assert "scale(1.5)" in pg.get_attribute("#vsvid", "style")
        @step("обрезка начала и конца на шкале; подсказка хуков ИИ без ключа сообщает причину; сборка создаёт задание")
        def _():
            before = doc("videoStudioClips", "c1"); pg.fill("#tl-s", str(round(before["start"] - 1.5, 1))); pg.dispatch_event("#tl-s", "input"); assert "изменения не применены" in txt(pg, "#tlinfo"); pg.click('[data-act="range-apply"]'); eventually(lambda: doc("videoStudioClips", "c1")["start"] < before["start"] - 1.0, 8, "начало сдвинуто"); assert any(w["text"] == "Дисциплина," for w in doc("videoStudioEdits", "c1")["words"]), "правка слова сохранена"
            pg.click('[data-act="hooks"]'); eventually(lambda: any("ключ Claude" in t for t in pg.locator(".vs-toast").all_inner_texts()), 6, "причина без ключа"); pg.click('[data-act="render"]'); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render"], 8, "задание"); assert len(j) == 1 and j[0]["payload"]["hook"]["text"] == "Мой новый хук" and j[0]["payload"]["framing"]["zoom"] == 1.5 and j[0]["payload"]["template"]["logo"]["enabled"] is True
        @step("Очередь: задание видно, вкладки со счётчиками, отмена и повтор работают")
        def _():
            go(pg, "queue"); eventually(lambda: pg.locator(".vs-q-row").count() >= 1, 8, "строка"); assert "Сборка видео" in txt(pg) and "Ожидает свободного исполнителя" in txt(pg); assert pg.locator('[data-qf="wait"] em').inner_text() == "1"; pg.screenshot(path=SHOTS + "/03_queue.png")
            pg.click("[data-qc]"); eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render" and x["status"] == "cancelled"], 8, "отменено"); pg.click('[data-qf="cancel"]'); eventually(lambda: pg.locator("[data-qr]").count() == 1, 8, "кнопка повтора"); pg.click("[data-qr]"); eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render" and x["status"] == "queued"], 8, "снова в очереди")
        @step("Живой монитор: этап, длительность этапа и всего, измеренный прогресс или индикатор активности (без выдуманных процентов), зависание, предупреждения, очередь; состояние восстанавливается после обновления страницы")
        def _():
            urllib.request.urlopen(BASE + "/__seed_running"); go(pg, "queue"); eventually(lambda: pg.locator(".vs-mon-job").count() == 2, 12, "две карточки"); t = txt(pg, "#q-mon"); tl = t.lower()
            assert "обработка сейчас" in tl and "live-demo.mp4" in t and "Этап: распознавание речи" in t and "часть 2 из 6" in t and "35%" in t and "медленное хранилище" in t and "нет обновлений" in t and "Исполнитель: отключён" in t, t[:300]
            texts = pg.locator(".vs-mon-job").all_inner_texts(); un = [x for x in texts if "процент не измеряется" in x]; assert len(un) == 1 and "%" not in un[0] and "подготовка звука" in un[0], "без измерения — только индикатор: " + str(un)[:200]; assert pg.locator(".vs-mon-job .vs-prog.ind").count() == 1 and pg.locator(".vs-mon-job.stale").count() == 1
            assert "180" not in t and "3:00" in t, "завершённый этап показан с реальной длительностью"; assert pg.locator("#q-mon table.vs-table tbody tr").count() >= 1 and "№" in t
            a = pg.locator("[data-el-upd]").first.inner_text(); time.sleep(2.4); assert pg.locator("[data-el-upd]").first.inner_text() != a, "счётчик времени идёт"; pg.evaluate("window.scrollTo(0,0)"); pg.screenshot(path=SHOTS + "/03b_monitor.png")
            pg.reload(); eventually(lambda: pg.locator(".vs-mon-job").count() == 2, 12, "состояние восстановилось после обновления страницы"); urllib.request.urlopen(BASE + "/__seed_running?off=1"); eventually(lambda: pg.locator(".vs-mon-job").count() == 0, 14, "монитор обновился сам")
        @step("История: готовый ролик со статусом Telegram, повторная отправка создаёт задание, удаление файла с подтверждением")
        def _():
            go(pg, "history"); eventually(lambda: pg.locator(".vs-hcard").count() == 1, 8, "карточка"); t = txt(pg); assert "Готовый ролик" in t and "Доставлено в Telegram" in t and "#555" in t; pg.click("[data-h-tg]"); eventually(lambda: pg.locator(".vs-dialog").count() == 1, 6, "диалог отправки"); pg.click(".vs-dialog .vs-btn.primary"); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "tg_send"], 8, "задание отправки"); assert j[0]["payload"]["hash"] == "abc123abc123" and j[0]["payload"]["chat_id"] == "777000111"
        @step("Медиатека: исходники, ролики, логотипы, шаблоны; фильтры и поиск")
        def _():
            go(pg, "media"); eventually(lambda: pg.locator(".vs-mcard").count() >= 2 + N_LOGO, 8, "карточки"); assert pg.locator('[data-k="export"] em').inner_text() == "1" and pg.locator('[data-k="source"] em').inner_text() == "1" and int(pg.locator('[data-k="logo"] em').inner_text()) == N_LOGO
            pg.click('[data-k="export"]'); assert pg.locator(".vs-mcard").count() == 1 and "Готовый ролик" in txt(pg, ".vs-mcard"); pg.click('[data-k=""]'); pg.fill("#m-q", "live"); eventually(lambda: pg.locator(".vs-mcard").count() == 1, 4, "поиск"); pg.fill("#m-q", "")
        @step("Шаблоны: сохранить текущее оформление, изменить, применить сохранённое, удалить")
        def _():
            go(pg, "templates"); eventually(lambda: pg.locator("#tp-subtitles-size").count() == 1, 8, "форма"); pg.fill("#tp-name", "Мой стиль"); pg.click("#tp-save"); eventually(lambda: pg.locator("[data-ap]").count() == 1, 6, "шаблон сохранён"); size0 = pg.input_value("#tp-subtitles-size")
            pg.fill("#tp-subtitles-size", "77"); pg.click("#tp-apply"); eventually(lambda: (doc("videoStudioSettings", "template") or {}).get("subtitles", {}).get("size") == 77, 6, "оформление сохранено"); pg.wait_for_timeout(1200); pg.fill("#tp-subtitles-size", "5"); pg.click("#tp-apply"); eventually(lambda: any("subtitles" in t for t in pg.locator(".vs-toast.bad").all_inner_texts()), 6, "ошибка диапазона")
            pg.click("[data-ap]"); eventually(lambda: (doc("videoStudioSettings", "template") or {}).get("subtitles", {}).get("size") == int(size0), 6, "применён сохранённый шаблон"); pg.click("[data-dp]"); pg.click(".vs-dialog .vs-btn.danger"); eventually(lambda: pg.locator("[data-ap]").count() == 0, 6, "шаблон удалён")
        @step("ПОЛНЫЙ ПУТЬ 1: «Начать нарезку» — название, число клипов (3/5/10/15/20 и своё), автосборка; задание создаётся с этими параметрами")
        def _():
            urllib.request.urlopen(BASE + "/__seed_ready"); go(pg, "projects"); pg.evaluate("location.hash='#/projects/p_ready'"); eventually(lambda: pg.locator("#pd-an").count() == 1, 8, "кнопка"); assert "Начать нарезку" in txt(pg, "#pd-an") and "Нарезка ещё не запускалась" in txt(pg); pg.click("#pd-an")
            eventually(lambda: pg.locator(".vs-dialog #st-title").count() == 1, 8, "форма"); d = txt(pg, ".vs-dialog"); assert "stream-ready.mp4" in d and "Сколько клипов получить" in d and "дубликаты не создаются" in d; assert [c.inner_text() for c in pg.locator(".vs-chip").all()] == ["3", "5", "10", "15", "20"]
            pg.click('.vs-chip[data-n="5"]'); pg.fill("#st-title", "Мой эфир"); pg.click(".vs-dialog .vs-btn.primary"); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "analyze" and x["project_id"] == "p_ready"], 8, "задание нарезки"); pl = j[0]["payload"]; assert pl["target_clips"] == 5 and pl["max_clips"] == 5 and pl["auto_render"] is True, pl; assert doc("videoStudioProjects", "p_ready")["title"] == "Мой эфир"
            pg.evaluate("location.hash='#/projects/p_ready2'"); eventually(lambda: "stream-two" in txt(pg) and pg.locator("#pd-an").count() == 1, 10, "кнопка 2"); pg.click("#pd-an"); eventually(lambda: pg.locator("#st-own").count() == 1, 8, "форма 2"); pg.fill("#st-own", "7"); pg.uncheck("#st-auto"); pg.click(".vs-dialog .vs-btn.primary"); j2 = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "analyze" and x["project_id"] == "p_ready2"], 8, "задание 2"); assert j2[0]["payload"]["target_clips"] == 7 and j2[0]["payload"]["auto_render"] is False, j2[0]["payload"]
        @step("ПОЛНЫЙ ПУТЬ 2: «Монтажёры» — пустое состояние объясняет, что делать; добавление; Telegram не привязан; одноразовый код без хранения в открытом виде")
        def _():
            go(pg, "editors"); eventually(lambda: "Монтажёров пока нет" in txt(pg), 8, "пустое состояние"); assert "Telegram пока выключен" not in txt(pg); pg.click("#e-add2"); pg.fill("#ef-n", "Анна"); pg.fill("#ef-note", "основной монтажёр"); pg.click(".vs-dialog .vs-btn.primary"); eventually(lambda: pg.locator(".vs-ecard").count() == 1, 8, "карточка")
            t = txt(pg, ".vs-ecard"); assert "Анна" in t and "Telegram не привязан" in t and "Клипов: 0" in t; pg.click("[data-link]"); eventually(lambda: pg.locator(".vs-code").count() == 1, 8, "код"); code = txt(pg, ".vs-code").strip(); assert len(code) == 8; assert code not in json.dumps(dbq("videoStudioEditors")), "код не хранится открытым текстом"; pg.click(".vs-dialog .vs-btn.primary")
            pg.screenshot(path=SHOTS + "/10_editors.png")
        @step("ПОЛНЫЙ ПУТЬ 3: «Готовые клипы» — карточки, кнопка «Импорт в Telegram» в правом верхнем углу, статусы, фильтры, пустое состояние фильтра")
        def _():
            go(pg, "clips"); eventually(lambda: pg.locator(".vs-ccard").count() == 2, 8, "две карточки"); b = pg.locator("#c-tg").bounding_box(); vw = pg.viewport_size["width"]; assert b["x"] > vw * 0.6 and b["y"] < 200 and "Импорт в Telegram" in pg.inner_text("#c-tg"), "кнопка справа вверху: %s" % b
            t = txt(pg); assert "Дисциплина важнее входа" in t and "Готовый ролик" in t and "Текст внизу видео" in t and "Монтажёр: не назначен" in t and "Найден" in t and "Видео готово" in t or "Нужна пересборка" in t
            assert pg.locator('[data-watch="c2"]').is_enabled() and pg.locator('[data-dl="c2"]').is_enabled() and not pg.locator('[data-watch="c1"]').is_enabled(), "видео доступно только у собранного клипа"
            pg.fill("#c-q", "нет такого клипа"); eventually(lambda: "Ничего не найдено" in txt(pg), 6, "пустой фильтр"); pg.click("#c-reset"); eventually(lambda: pg.locator(".vs-ccard").count() == 2, 6, "сброс"); pg.click('[data-status="pending"]'); eventually(lambda: "Готовых клипов пока нет" not in txt(pg) and pg.locator(".vs-ccard").count() == 0, 6, "вкладка статуса"); pg.click('[data-status=""]'); eventually(lambda: pg.locator(".vs-ccard").count() == 2, 6, "все")
            pg.screenshot(path=SHOTS + "/11_clips.png")
        @step("ПОЛНЫЙ ПУТЬ 4: массовое выделение и назначение монтажёра нескольким клипам сразу; статус «Ожидает редактирования»; очередь монтажёра")
        def _():
            pg.check("#c-all"); eventually(lambda: pg.inner_text("#c-n") == "2", 4, "выбрано 2"); pg.click("#c-assign"); eventually(lambda: pg.locator("#as-ed").count() == 1, 6, "диалог"); pg.select_option("#as-ed", label="Анна"); pg.click(".vs-dialog .vs-btn.primary")
            eventually(lambda: all((doc("videoStudioClips", c) or {}).get("workflow", {}).get("assignee_id") for c in ("c1", "c2")), 8, "назначено"); eventually(lambda: pg.locator(".vs-ccard").count() == 2 and "Монтажёр: Анна" in txt(pg) and "Ожидает редактирования" in txt(pg), 8, "карточки обновились"); assert doc("videoStudioClips", "c1")["workflow"]["status"] == "pending"
            go(pg, "editors"); eventually(lambda: "Клипов: 2" in txt(pg), 8, "счётчик"); pg.click("[data-q]"); eventually(lambda: pg.locator(".vs-eq tbody tr").count() == 2, 8, "очередь монтажёра"); assert "Дисциплина важнее входа" in txt(pg, ".vs-eq")
        @step("ПОЛНЫЙ ПУТЬ 5: редактор — нижний текст, положение призыва, большое задание, статус; «Сохранить»; данные в карточке, после смены раздела и после перезагрузки")
        def _():
            LONG = "Убрать первые две секунды.\nУвеличить текст внизу. Сделать субтитры крупнее. " * 8 + "Оставить момент с демонстрацией графика. Убрать паузу в конце. Не менять оригинальный звук."
            pg.evaluate("location.hash='#/projects/p_demo/c1'"); eventually(lambda: pg.locator("#f-wf-task").count() == 1 and pg.locator("#vscap").count() == 1, 10, "редактор"); assert "Сохранено" in txt(pg, "#ed-state") and pg.locator("#ed-save").is_disabled()
            pg.fill("#f-cap", "Текст внизу клипа"); eventually(lambda: txt(pg, "#vscap") == "Текст внизу клипа", 3, "нижний текст в предпросмотре"); pg.fill("#f-cty", "1800"); eventually(lambda: pg.evaluate("document.querySelector('#vscta').style.top") == "1800px", 3, "призыв перемещён")
            pg.fill("#f-wf-task", LONG); pg.select_option("#f-wf-status", "needs_changes"); assert "Есть несохранённые изменения" in txt(pg, "#ed-state") and pg.locator("#ed-save").is_enabled(); assert (doc("videoStudioEdits", "c1").get("caption") or {}).get("text") in (None, ""), "до «Сохранить» нижнего текста в базе нет"
            save(pg); e = doc("videoStudioEdits", "c1"); assert e["caption"]["text"] == "Текст внизу клипа" and e["caption"]["enabled"] is True and e["cta"]["y"] == 1800; w = doc("videoStudioClips", "c1")["workflow"]; assert w["status"] == "needs_changes" and w["task"] == LONG.strip() and w["assignee_id"], w
            pg.screenshot(path=SHOTS + "/12_editor_saved.png")
            go(pg, "clips"); eventually(lambda: pg.locator(".vs-ccard").count() == 2, 8, "карточки"); c1 = txt(pg, '[data-card="c1"]'); assert "Текст внизу клипа" in c1 and "Нужны правки" in c1 and "Убрать первые две секунды" in c1, c1
            pg.evaluate("location.hash='#/projects/p_demo/c1'"); eventually(lambda: pg.locator("#f-wf-task").count() == 1, 10, "повторное открытие"); assert pg.input_value("#f-cap") == "Текст внизу клипа" and pg.input_value("#f-wf-task") == LONG.strip() and pg.input_value("#f-wf-status") == "needs_changes" and pg.input_value("#f-cty") == "1800"
            pg.reload(); eventually(lambda: pg.locator("#f-wf-task").count() == 1, 12, "после перезагрузки"); assert pg.input_value("#f-cap") == "Текст внизу клипа" and pg.input_value("#f-wf-task") == LONG.strip() and "Анна" in pg.eval_on_selector("#f-wf-assignee", "e => e.options[e.selectedIndex].text") and "Сохранено" in txt(pg, "#ed-state")
            pg.fill("#f-wf-comment", "Комментарий при выходе"); assert "Есть несохранённые изменения" in txt(pg, "#ed-state"); go(pg, "clips"); eventually(lambda: doc("videoStudioClips", "c1")["workflow"]["comment"] == "Комментарий при выходе", 8, "автосохранение при выходе"); eventually(lambda: any("сохранены автоматически" in t for t in pg.locator(".vs-toast").all_inner_texts()), 6, "сообщение")
            pg.evaluate("location.hash='#/projects/p_demo/c1'"); eventually(lambda: pg.locator('[data-act="hist"]').count() == 1, 10, "редактор"); pg.click('[data-act="hist"]'); eventually(lambda: "Нужны правки" in txt(pg, ".vs-dialog") and "Анна" in txt(pg, ".vs-dialog") or "назначен" in txt(pg, ".vs-dialog"), 8, "история изменений"); pg.click(".vs-dialog .vs-btn.primary")
        @step("ПОЛНЫЙ ПУТЬ 6: пересборка берёт именно последнюю сохранённую версию (нижний текст, положение призыва); состояние видео понятно")
        def _():
            for jb in [x for x in dbq("videoStudioJobs") if x["type"] == "render" and x["status"] in ("queued", "claimed", "running")]: pg.evaluate("id => VS.api('POST', '/jobs/' + id + '/cancel')", jb["id"])   # прежние сборки этого клипа отменяем: пока клип собирается, кнопка недоступна
            pg.reload(); eventually(lambda: pg.locator('[data-act="render"]').count() == 1 and pg.locator('[data-act="render"]').is_enabled(), 15, "кнопка сборки доступна"); assert "Вы изменили клип после последней сборки" in txt(pg, "#vsR") or "Видео ещё не собрано" in txt(pg, "#vsR"), "понятное состояние видео"; pg.click('[data-act="render"]'); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "render" and (x["payload"].get("caption") or {}).get("text") == "Текст внизу клипа"], 8, "задание сборки")
            pl = j[0]["payload"]; assert pl["caption"]["enabled"] is True and pl["cta"]["y"] == 1800 and pl["hook"]["text"] == "Мой новый хук", pl; eventually(lambda: "Видео собирается" in txt(pg, "#vsR") or "Видео ещё не собрано" in txt(pg, "#vsR") or "собрано" in txt(pg, "#vsR"), 6, "состояние видео")
        @step("ПОЛНЫЙ ПУТЬ 7: «Импорт в Telegram» при включённом боте — отправка себе; непривязанный монтажёр недоступен; клип без видео пропускается с объяснением")
        def _():
            go(pg, "clips"); eventually(lambda: pg.locator(".vs-ccard").count() == 2, 8, "карточки"); pg.check('[data-sel="c2"]'); pg.click("#c-tg"); eventually(lambda: pg.locator(".vs-dialog input[name=tg-t]").count() == 3, 8, "диалог"); radios = pg.locator(".vs-dialog input[name=tg-t]").all(); assert radios[0].is_checked() and radios[1].is_disabled(), "монтажёров с Telegram нет"; assert "нет монтажёров с привязанным Telegram" in txt(pg, ".vs-dialog")
            pg.click(".vs-dialog .vs-btn.primary"); j = eventually(lambda: [x for x in dbq("videoStudioJobs") if x["type"] == "tg_send" and x["clip_id"] == "c2" and x["payload"]["target"] == "owner"], 8, "отправка"); assert j[0]["payload"]["chat_id"] == "777000111"
            pg.uncheck('[data-sel="c2"]'); pg.check('[data-sel="c1"]'); pg.click("#c-tg"); eventually(lambda: pg.locator(".vs-dialog input[name=tg-t]").count() == 3, 8, "диалог 2"); pg.click(".vs-dialog .vs-btn.primary"); eventually(lambda: "Видео ещё не собрано" in txt(pg, "#tg-res"), 8, "объяснение"); pg.click(".vs-dialog .vs-btn:not(.primary)")
        @step("ПОЛНЫЙ ПУТЬ 8: Telegram выключен — кнопка объясняет, как включить; ошибок нет; остальные разделы работают; включение возвращает отправку")
        def _():
            urllib.request.urlopen(BASE + "/__tg_toggle?on=0"); nerr = pg.locator(".vs-toast.bad").count(); pg.click("#c-tg"); eventually(lambda: "Telegram пока выключен" in txt(pg, ".vs-dialog"), 8, "сообщение"); d = txt(pg, ".vs-dialog"); assert "VIDEO_STUDIO_TELEGRAM_ENABLED" in d and "остальные функции работают" in d and "отдельного бота" in d, d[:400]; assert pg.locator(".vs-toast.bad").count() == nerr, "ошибок нет"; pg.click(".vs-dialog .vs-btn.primary")
            assert pg.locator(".vs-ccard").count() == 2; pg.evaluate("location.hash='#/settings/telegram'"); eventually(lambda: "Выключен" in txt(pg) and "не бот Academy" in txt(pg), 8, "настройки Telegram"); go(pg, "editors"); eventually(lambda: "Telegram пока выключен" in txt(pg), 8, "баннер монтажёров"); assert pg.locator(".vs-ecard").count() == 1
            urllib.request.urlopen(BASE + "/__tg_toggle?on=1"); go(pg, "clips"); eventually(lambda: pg.locator(".vs-ccard").count() == 2, 8, "карточки")
        @step("Аналитика: показатели и графики из реальных данных, переключение периода")
        def _():
            go(pg, "analytics"); eventually(lambda: pg.locator("svg.vs-chart").count() == 4, 8, "четыре графика"); assert ("нет данных" in txt(pg) or "Среднее время" in txt(pg)) and "время этапов" in txt(pg).lower(); pg.click('[data-d="30"]'); eventually(lambda: pg.locator("svg.vs-chart").count() == 4, 8, "период 30 дней"); noerr(pg)
        @step("Настройки → Общие: название студии сохраняется и сразу видно в интерфейсе")
        def _():
            go(pg, "settings"); eventually(lambda: pg.query_selector("#g-name"), 8, "форма"); assert pg.locator(".vs-subnav a").count() == 8; pg.fill("#g-name", "Dinox Studio"); pg.select_option("#g-den", "compact"); pg.click("#g-save"); eventually(lambda: (doc("videoStudioSettings", "general") or {}).get("studio_name") == "Dinox Studio", 6, "сохранено"); eventually(lambda: "Dinox Studio" in txt(pg, ".vs-side") and pg.get_attribute(".vs-app", "data-density") == "compact", 4, "применено в интерфейсе"); pg.select_option("#g-den", "comfortable"); pg.click("#g-save")
        @step("Настройки → Хранилище: состояние, проверка соединения, тест записи и чтения по шагам, CORS-инструкция")
        def _():
            pg.click('.vs-subnav a[href="#/settings/storage"]'); eventually(lambda: "Соединение с хранилищем проверено" in txt(pg), 10, "статус"); t = txt(pg); assert "Бакет" in t and "Загрузка частями" in t and "Секретные ключи здесь никогда не показываются" in t and "ExposeHeaders" in t and "ETag" in t
            pg.click("#s-check"); eventually(lambda: "Соединение проверено" in txt(pg, "#s-res"), 10, "проверка соединения"); pg.click("#s-test"); eventually(lambda: "Запись и чтение файла" in txt(pg, "#s-res"), 25, "тест записи по шагам"); pg.screenshot(path=SHOTS + "/04_storage.png", full_page=True)
        @step("РЕГРЕССИЯ: сбой хранилища (ошибка «Unknown») НЕ ломает «Настройки»; причина видна, остальные подразделы работают")
        def _():
            urllib.request.urlopen(BASE + "/__fail?on=1"); EXPECT_FAIL[0] = True
            pg.click("#s-check"); eventually(lambda: "Не удалось подключиться" in txt(pg, "#s-res"), 10, "ошибка проверки"); eventually(lambda: "Хранилище недоступно" in txt(pg), 10, "статус обновился"); t = txt(pg); assert "HTTP 400" in t and "R2_ENDPOINT" in t, t[:400]; assert "(Unknown)." not in t, "прежнее неинформативное сообщение"; eventually(lambda: pg.locator("#vs-pills .vs-pill.bad").count() == 1, 8, "красная метка в верхней панели")
            pg.click('.vs-subnav a[href="#/settings/branding"]'); eventually(lambda: pg.query_selector("#lg-src") is not None, 10, "брендинг открылся при сбое хранилища"); assert "Загруженный логотип сейчас недоступен" in txt(pg) and "HTTP 400" in txt(pg); assert pg.query_selector("#bf-save") is not None; noerr(pg)
            for sub, probe in [("general", "#g-name"), ("processing", "#l-save"), ("telegram", "#t-check"), ("security", "#sec-run")]:
                pg.click('.vs-subnav a[href="#/settings/%s"]' % sub); eventually(lambda: pg.query_selector(probe) is not None, 10, sub); noerr(pg)
            pg.click('.vs-subnav a[href="#/settings/diagnostics"]'); eventually(lambda: pg.locator("#d-srv .vs-chk").count() >= 7, 15, "диагностика"); by = {c.inner_text().split("\n")[0]: c.get_attribute("class") for c in pg.locator("#d-srv .vs-chk").all()}; assert "bad" in by["Хранилище видео"] and "ok" in by["Firestore (база данных)"] and "ok" in by["Авторизация и роли"], by
            go(pg, "dashboard"); eventually(lambda: pg.locator(".vs-status-card.bad").count() >= 1, 10, "обзор показывает сбой"); noerr(pg); urllib.request.urlopen(BASE + "/__fail?on=0"); EXPECT_FAIL[0] = False
        @step("Настройки → Диагностика: проверки сервера и интерфейса, итог; восстановление после сбоя")
        def _():
            go(pg, "settings"); pg.click('.vs-subnav a[href="#/settings/storage"]'); eventually(lambda: "Хранилище недоступно" in txt(pg), 6, "ещё кэш"); pg.click("#s-check"); eventually(lambda: "Соединение проверено" in txt(pg, "#s-res"), 10, "восстановилось")
            pg.click('.vs-subnav a[href="#/settings/diagnostics"]'); eventually(lambda: pg.locator("#d-srv .vs-chk").count() >= 7 and pg.locator("#d-fe .vs-chk").count() >= 4, 15, "диагностика"); t = txt(pg); tl = t.lower(); assert "сервер (backend)" in tl and "firestore" in tl and "интерфейс (frontend)" in tl and "ошибки javascript" in tl; pg.screenshot(path=SHOTS + "/05_diagnostics.png", full_page=True)
        @step("Настройки → Обработка, Брендинг, Telegram, Безопасность: сохранение и проверки работают")
        def _():
            pg.click('.vs-subnav a[href="#/settings/processing"]'); eventually(lambda: pg.query_selector("#l-m"), 8, "обработка"); pg.fill("#l-m", "7"); pg.click("#l-save"); eventually(lambda: (doc("videoStudioSettings", "limits") or {}).get("monthly_usd") == 7, 6, "лимиты"); pg.fill("#c-min", "18"); pg.fill("#c-max", "28"); pg.click("#c-save"); eventually(lambda: (doc("videoStudioSettings", "clips") or {}).get("max_s") == 28, 6, "клипы")
            pg.fill("#v-t", "Hidden Dinox | 1 | хидден динокс"); pg.click("#v-save"); eventually(lambda: [x["term"] for x in (doc("videoStudioSettings", "vocabulary") or {}).get("terms", [])] == ["Hidden Dinox"], 6, "словарь"); pg.fill("#tp-quality-crf", "22"); pg.click("#e-save"); eventually(lambda: (doc("videoStudioSettings", "template") or {}).get("quality", {}).get("crf") == 22, 6, "качество экспорта")
            pg.click('.vs-subnav a[href="#/settings/branding"]'); eventually(lambda: pg.query_selector("#bf-save"), 8, "брендинг"); pg.fill("#tp-colors-accent", "#ff0000"); pg.click("#bf-save"); eventually(lambda: (doc("videoStudioSettings", "template") or {}).get("colors", {}).get("accent", "").lower() == "#ff0000", 6, "цвет"); pg.click("#lg-save"); eventually(lambda: pg.locator(".vs-toast.ok").count() >= 1, 4, "логотип выбран")
            pg.click('.vs-subnav a[href="#/settings/telegram"]'); eventually(lambda: pg.query_selector("#t-check"), 8, "telegram"); assert "TESTTOKEN" not in txt(pg) and pg.input_value("#t-chat") == "777000111"; pg.click("#t-check"); eventually(lambda: "@hd_test_bot" in txt(pg, "#t-res") and "можно отправлять" in txt(pg, "#t-res"), 8, "проверка"); pg.click("#t-test"); eventually(lambda: "доставлено" in txt(pg, "#t-res"), 8, "тест"); assert any("тестовое сообщение" in m["text"] for m in tgq()["messages"]); pg.fill("#t-chat", "abc"); pg.click("#t-save"); eventually(lambda: "Chat ID" in txt(pg, "#t-res") or "chat_id" in txt(pg, "#t-res"), 6, "отказ"); pg.fill("#t-chat", "777000111"); pg.click("#t-save")
            pg.click('.vs-subnav a[href="#/settings/security"]'); eventually(lambda: pg.query_selector("#sec-run"), 8, "безопасность"); assert "boss@test.local" in txt(pg) and "admin" in txt(pg); pg.click("#sec-run"); eventually(lambda: txt(pg, "#sec-res").count("✓") == 3, 10, "защита API: три проверки"); assert "✗" not in txt(pg, "#sec-res"); eventually(lambda: pg.locator("#sec-log .vs-ev").count() >= 3, 8, "журнал действий")
        @step("Центр загрузки: несколько файлов, прогресс каждого и общий, сборка из частей на сервере, защита от повтора")
        def _():
            go(pg, "uploads"); big, small = os.path.join(MEDIA, "up_big.mp4"), os.path.join(MEDIA, "up_small.mp4"); pg.set_input_files("#up-file", [big, small]); eventually(lambda: pg.locator(".vs-up-row").count() == 2, 8, "две строки"); pg.screenshot(path=SHOTS + "/06_uploads.png", full_page=True)
            eventually(lambda: len([x for x in dbq("videoStudioProjects") if x["id"] not in ("p_demo", "p_ready", "p_ready2") and x["status"] == "validating"]) == 2, 40, "оба проекта перешли в «проверка»"); eventually(lambda: pg.locator(".vs-up-row .vs-badge.ok").count() == 2, 10, "обе загрузки завершены"); pj = {x["filename"]: x for x in dbq("videoStudioProjects") if x["id"] not in ("p_demo", "p_ready", "p_ready2")}; assert pj["up_big.mp4"]["upload"]["mode"] == "multipart" and pj["up_big.mp4"]["upload"]["total_parts"] == 2 and pj["up_small.mp4"]["upload"]["total_parts"] == 1
            stg = json.load(urllib.request.urlopen(BASE + "/__storage")); assert stg["uploads"] == 0; sizes = sorted(o["size"] for o in stg["objects"] if o["key"].endswith("/source/original.mp4") and not any(k in o["key"] for k in ("p_demo", "p_ready"))); assert sizes == sorted([os.path.getsize(big), os.path.getsize(small)]), sizes
            assert len([x for x in dbq("videoStudioJobs") if x["type"] == "probe"]) == 2; pg.set_input_files("#up-file", [big]); eventually(lambda: "уже загружен" in txt(pg), 15, "повтор отклонён"); assert len([x for x in dbq("videoStudioProjects") if x["id"] not in ("p_demo", "p_ready", "p_ready2")]) == 2
        @step("прерванные загрузки: незавершённая загрузка видна и удаляется с подтверждением")
        def _():
            now = int(time.time() * 1000); urllib.request.urlopen(BASE + "/__seed_upload"); pg.reload(); eventually(lambda: pg.locator('[data-drop-broken]').count() == 1, 10, "прерванная загрузка"); assert "обрыв.mp4" in txt(pg); pg.click("[data-drop-broken]"); pg.click(".vs-dialog .vs-btn.danger"); eventually(lambda: pg.locator('[data-drop-broken]').count() == 0, 8, "удалена"); assert doc("videoStudioProjects", "p_broken")["status"] == "deleted"
        @step("в браузере нет ошибок JavaScript, а запросы не дают 404/500 (кроме ожидаемого сбоя хранилища и подсказки хуков без ключа)")
        def _():
            bad = [l for l in logs if "favicon" not in l and "Failed to load resource" not in l and "ERR_" not in l]; assert not bad, bad[:3]; assert not PAGE_ERR, PAGE_ERR[:3]; assert not BAD, BAD[:5]
        ctx.close()
        ctx = user_ctx(b, "boss", 390, 820); pg = ctx.new_page(); LASTPG[0] = pg; watch(pg); pg.goto(PAGE + "#/projects")
        @step("мобильная версия: боковая панель в выдвижном меню, без горизонтальной прокрутки, разделы открываются")
        def _():
            eventually(lambda: pg.locator(".vs-pcard").count() >= 1, 12, "проекты"); assert pg.is_visible("#vs-burger"); side = pg.locator(".vs-side").bounding_box(); assert side["x"] + side["width"] <= 2, "панель скрыта: %s" % side
            pg.click("#vs-burger"); eventually(lambda: pg.locator(".vs-side").bounding_box()["x"] >= -1, 3, "панель открылась"); pg.screenshot(path=SHOTS + "/07_mobile_menu.png"); pg.click('[data-nav="queue"]'); eventually(lambda: pg.inner_text("#vs-title") == "Очередь обработки", 5, "очередь"); eventually(lambda: pg.locator(".vs-side").bounding_box()["x"] < -100, 3, "меню закрылось")
            for h in ["dashboard", "settings/storage", "uploads", "media"]: pg.goto(PAGE + "#/" + h); eventually(lambda: pg.locator(".vs-skel").count() == 0 and pg.locator("#vs-view > *").count() > 0, 12, h); assert pg.evaluate("document.documentElement.scrollWidth") <= 392, (h, pg.evaluate("document.documentElement.scrollWidth")); noerr(pg)
            pg.screenshot(path=SHOTS + "/08_mobile.png", full_page=True)
        ctx.close(); b.close()
finally:
    srv.terminate(); shutil.rmtree(MEDIA, ignore_errors=True)
ok = sum(1 for r in RES if r[1]); print("\nИТОГ: %d из %d шагов" % (ok, len(RES))); sys.exit(0 if ok == len(RES) else 1)
