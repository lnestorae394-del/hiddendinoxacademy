"""Сборка банка вопросов Daily Tests из тестов трёх курсов (оригинальные файлы только читаются).
python3 scripts/build-daily-bank.py → content/daily-bank/daily_bank.json + content/daily-bank/REPORT.md"""
import json, re, hashlib, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = [("hr", "content/hidden-reaction-course.json"), ("smc", "content/binary/smart_money_concepts_binary.json"), ("rm", "content/binary/risk_management_binary.json")]
CYR = re.compile(r"[А-Яа-яЁёІіЇїЄєҐґ]"); RU_ONLY = re.compile(r"[ЫыЭэЪъЁё]")
# Вопрос показывается ВНЕ урока: отсылки к странице/картинке/примеру урока делают его непонятным
CONTEXT = re.compile(r"(в этом уроке|в данном уроке|в уроке выше|выше на|на графике|на рисунке|на картинке|на скриншоте|в примере|из примера|в таблице выше|см\. выше|рассмотренн\w+ выше|this lesson|above)", re.I)
PAGE_REF = re.compile(r"^\s*(стр|с)\.?\s*[\d\s,–\-]+\.?\s*$", re.I)   # «Стр. 3.» — ссылка на страницу книги, а не объяснение
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^\w\s%.,/+-]", "", s.lower())).strip()

def tr_of(lesson, path, lang):
    return ((lesson.get("tr") or {}).get(lang) or {}).get(path)

bank, dropped, seen_q, seen_qa = [], [], {}, {}
stats = {}
for course, rel in SOURCES:
    d = json.load(open(os.path.join(ROOT, rel), encoding="utf-8")); slug = d["course"]["slug"]
    st = stats.setdefault(course, {"source": 0, "kept": 0, "dropped": {}})
    for mi, m in enumerate(d["modules"]):
        for li, l in enumerate(m["lessons"]):
            kind = "exam" if re.search(r"экзамен|exam", l["title"], re.I) else ("test" if re.search(r"^Тест|^Test|тест модуля", l["title"], re.I) else "lesson")
            for bi, b in enumerate(l["blocks"]):
                if b.get("type") != "quiz": continue
                for qi, q in enumerate(b["questions"]):
                    st["source"] += 1
                    base = f"blocks/{bi}/questions/{qi}"
                    src = {"course": course, "course_slug": slug, "module_index": mi, "module_title": m["title"], "lesson_index": li,
                           "lesson_title": l["title"], "lesson_kind": kind, "block_id": b["id"], "block_index": bi, "question_index": qi}
                    def drop(reason, extra=""):
                        st["dropped"][reason] = st["dropped"].get(reason, 0) + 1
                        dropped.append({**src, "q": q.get("q", "")[:160], "reason": reason, "detail": extra})
                    opts = q.get("options") or []; text = (q.get("q") or "").strip(); expl = (q.get("explanation") or "").strip()
                    # 1) структура
                    if not text: drop("пустой текст вопроса"); continue
                    if not (2 <= len(opts) <= 8): drop("число вариантов не 2–8"); continue
                    if len({norm(o) for o in opts}) != len(opts) or any(not str(o).strip() for o in opts): drop("пустые или повторяющиеся варианты"); continue
                    if not isinstance(q.get("correct"), int) or not (0 <= q["correct"] < len(opts)): drop("правильный ответ вне вариантов"); continue
                    issues, source_ref = [], None
                    if PAGE_REF.match(expl): issues.append("нужно объяснение (в источнике только ссылка на страницу книги)"); source_ref = expl
                    elif len(expl) < 5: issues.append("нужно объяснение (в источнике его нет)")
                    # 2) самостоятельность вне урока
                    if CONTEXT.search(text): drop("ссылается на содержимое урока (непонятен вне урока)", CONTEXT.search(text).group(0)); continue
                    # 3) дубли (первое вхождение — урок/тест модуля; копии в экзаменах удаляются)
                    k1 = norm(text); k2 = k1 + "||" + norm(opts[q["correct"]])
                    if k1 in seen_q: drop("дубль вопроса", seen_q[k1]); continue
                    # 4) переводы
                    i18n, miss = {}, []
                    for lang in ("en", "ua"):
                        tq, te = tr_of(l, base + "/q", lang), tr_of(l, base + "/explanation", lang)
                        to = [tr_of(l, f"{base}/options/{j}", lang) for j in range(len(opts))]
                        if not tq or not te or any(not o for o in to): miss.append(lang); continue
                        joined = " ".join([tq, te] + to)
                        if lang == "en" and CYR.search(joined): miss.append("en (кириллица)"); continue
                        if lang == "ua" and RU_ONLY.search(joined): miss.append("ua (русские буквы)"); continue
                        i18n[lang] = {"q": tq, "options": to, "explanation": te,
                                      "lesson_title": tr_of(l, "title", lang) or l["title"], "module_title": ((m.get("tr") or {}).get(lang) or {}).get("title") or m["title"]}
                    if miss: issues.append("нужен перевод: " + ", ".join(miss))
                    # ID — из полного адреса вопроса (ID блоков в курсах не уникальны: в HR все тестовые блоки называются «quiz»)
                    qid = "q_" + hashlib.sha1(f"{slug}|{mi}|{li}|{bi}|{qi}".encode()).hexdigest()[:12]
                    seen_q[k1] = qid; seen_qa[k2] = qid
                    status = "needs_review" if issues else "approved"   # «на проверке» не попадает в наборы, пока администратор не исправит и не одобрит
                    bank.append({"id": qid, **src, "q": text, "options": opts, "correct": q["correct"], "explanation": "" if source_ref else expl,
                                 "source_ref": source_ref, "kind": q.get("kind") or "choice", "i18n": i18n, "status": status, "issues": issues})
                    st["kept"] += 1; st[status] = st.get(status, 0) + 1

ids = [q["id"] for q in bank]
if len(ids) != len(set(ids)): sys.exit("ОШИБКА: повторяющиеся ID вопросов — банк не записан")
out = {"version": 1, "built_from": [r for _, r in SOURCES], "counts": {c: s["kept"] for c, s in stats.items()}, "questions": bank}
json.dump(out, open(os.path.join(ROOT, "content/daily-bank/daily_bank.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
names = {"hr": "Hidden Reaction System", "smc": "Smart Money Concepts", "rm": "Risk Management"}
rep = ["# Банк вопросов Daily Tests — отчёт сборки", "", "Исходные файлы курсов не изменялись (только чтение).", "",
       "| Курс | В тестах курса | В банке | из них одобрено | на проверке | Исключено |", "|---|---|---|---|---|---|"]
for c, s in stats.items(): rep.append(f"| {names[c]} | {s['source']} | {s['kept']} | {s.get('approved', 0)} | {s.get('needs_review', 0)} | {s['source'] - s['kept']} |")
tot_s = sum(s["source"] for s in stats.values()); tot_k = sum(s["kept"] for s in stats.values())
rep += [f"| **Итого** | **{tot_s}** | **{tot_k}** | **{sum(s.get('approved', 0) for s in stats.values())}** | **{sum(s.get('needs_review', 0) for s in stats.values())}** | **{tot_s - tot_k}** |", "",
        "«На проверке» — вопрос в банке, но не попадает в ежедневные наборы, пока администратор не добавит объяснение/перевод и не одобрит его (админка → Daily Tests → Банк).", "",
        "## На проверке — что нужно сделать", ""]
need = {}
for x in bank:
    for i in x["issues"]: need[i.split(":")[0]] = need.get(i.split(":")[0], 0) + 1
for r, n in sorted(need.items(), key=lambda t: -t[1]): rep.append(f"- {r}: {n}")
rep += ["", "## Причины исключения", ""]
reasons = {}
for x in dropped: reasons[x["reason"]] = reasons.get(x["reason"], 0) + 1
for r, n in sorted(reasons.items(), key=lambda t: -t[1]): rep.append(f"- {r}: {n}")
rep += ["", "## Исключённые вопросы", "", "| Курс | Урок | Вопрос | Причина |", "|---|---|---|---|"]
for x in dropped: rep.append(f"| {x['course'].upper()} | {x['lesson_title'][:50]} | {x['q'][:90].replace('|', '/')} | {x['reason']}{(' — ' + str(x['detail'])[:40]) if x['detail'] else ''} |")
open(os.path.join(ROOT, "content/daily-bank/REPORT.md"), "w", encoding="utf-8").write("\n".join(rep) + "\n")
print(json.dumps({c: {"source": s["source"], "kept": s["kept"], "approved": s.get("approved", 0), "needs_review": s.get("needs_review", 0), "dropped": s["dropped"]} for c, s in stats.items()}, ensure_ascii=False, indent=1))
print("итого в банке:", tot_k, "из", tot_s)
