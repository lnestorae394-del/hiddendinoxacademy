"""Инвентаризация источников знаний Hidden Dinox (только чтение). Печатает JSON-отчёт.
python3 scripts/knowledge-v2/inventory.py > /tmp/inventory.json"""
import json, os, re, subprocess, collections, hashlib
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = lambda *a: os.path.join(ROOT, *a)
SKIP = {"id", "type", "kind", "tr", "correct", "media_id", "url", "src", "status", "order"}
def texts(v, out):
    if isinstance(v, str):
        t = re.sub(r"<[^>]+>", " ", v).strip()
        if len(t) > 2: out.append(t)
    elif isinstance(v, list): [texts(x, out) for x in v]
    elif isinstance(v, dict): [texts(x, out) for k, x in v.items() if k not in SKIP]
    return out
def course(path):
    d = json.load(open(P(path), encoding="utf-8")); L = [(mi, l) for mi, m in enumerate(d["modules"]) for l in m["lessons"]]
    btypes = collections.Counter(b.get("type") for _, l in L for b in l["blocks"])
    q = sum(len(b["questions"]) for _, l in L for b in l["blocks"] if b.get("type") == "quiz")
    ru = sum(len(t) for _, l in L for t in texts(l["blocks"], []))
    cov = {}
    for lang in ("en", "ua"):
        need = have = 0
        for _, l in L:
            tr = (l.get("tr") or {}).get(lang) or {}
            src = (l.get("tr") or {}).get("src") or {}
            need += len(src) if src else 1; have += len([k for k in (src or tr) if tr.get(k)])
        cov[lang] = round(100 * have / max(1, need), 1)
    titles = collections.Counter(l["title"] for _, l in L)
    return {"file": path, "slug": d["course"].get("slug"), "title": d["course"].get("title"), "modules": len(d["modules"]), "lessons": len(L),
            "quiz_questions": q, "block_types": dict(btypes), "ru_text_chars": ru, "translation_coverage_pct": cov,
            "duplicate_lesson_titles": [t for t, n in titles.items() if n > 1], "lesson_kinds": dict(collections.Counter(("test" if re.search(r"^Тест|экзамен", l["title"], re.I) else "lesson") for _, l in L))}
def pdf(path):
    if not os.path.exists(P(path)): return {"file": path, "exists": False}
    info = subprocess.run(["pdfinfo", P(path)], capture_output=True, text=True).stdout
    pages = int((re.search(r"Pages:\s+(\d+)", info) or [0, 0])[1])
    per = []
    for i in range(1, pages + 1):
        t = subprocess.run(["pdftotext", "-q", "-f", str(i), "-l", str(i), P(path), "-"], capture_output=True, text=True).stdout
        per.append(len(re.sub(r"\s+", " ", t).strip()))
    return {"file": path, "pages": pages, "text_chars": sum(per), "pages_without_text": [i + 1 for i, n in enumerate(per) if n < 40], "pages_with_text": sum(1 for n in per if n >= 40)}
rep = {"courses": [course("content/hidden-reaction-course.json"), course("content/binary/smart_money_concepts_binary.json"), course("content/binary/risk_management_binary.json")]}
i18n = json.load(open(P("content/hidden-reaction-course.i18n.json"), encoding="utf-8"))
rep["hr_i18n_file"] = {"keys": list(i18n.keys()), "note": i18n.get("note"), "source": i18n.get("source"), "en_entries": len(i18n.get("en") or {}), "ua_entries": len(i18n.get("ua") or {})}
bank = json.load(open(P("content/daily-bank/daily_bank.json"), encoding="utf-8"))["questions"]
rep["daily_bank"] = {"total": len(bank), "by_course_status": dict(collections.Counter(f'{q["course"]}:{q["status"]}' for q in bank)),
    "by_kind": dict(collections.Counter(q.get("kind") for q in bank)), "issues": dict(collections.Counter(i.split(":")[0] for q in bank for i in q.get("issues", []))),
    "chart_kind_without_image": sum(1 for q in bank if q.get("kind") == "chart" and not q.get("image_url") and not q.get("media"))}
seed = json.load(open(P("content/knowledge/seed.json"), encoding="utf-8"))
rep["knowledge_seed"] = [{"title": x["title"], "category": x["category"], "language": x["language"], "chars": len(x["content"]), "verified": x.get("verified")} for x in seed["items"]]
rep["books"] = [pdf("private/books/the-hidden-reaction-system-v1.0-ru.pdf"), pdf("output/books/THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_UA.pdf"), pdf("output/books/THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_EN.pdf")]
other = []
for dp, dn, fn in os.walk(ROOT):
    if any(x in dp for x in ("node_modules", ".git", "tests", "/tools")): continue
    for f in fn:
        if f.lower().endswith((".pdf", ".docx", ".md", ".txt")) and "books" not in dp and not f.isupper(): other.append(os.path.relpath(os.path.join(dp, f), ROOT))
rep["other_candidate_files"] = sorted(other)[:40]
print(json.dumps(rep, ensure_ascii=False, indent=1))
