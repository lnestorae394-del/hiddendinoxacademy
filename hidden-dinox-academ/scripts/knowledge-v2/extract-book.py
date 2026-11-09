"""Извлечение текста книги «The Hidden Reaction System» v1.0 по страницам (PDF только читаются).
Нужен pdftotext (poppler-utils) — только для сборки, на Render не требуется.
python3 scripts/knowledge-v2/extract-book.py → content/knowledge/v2/sources/book-{ru,ua,en}.json"""
import json, os, re, subprocess, hashlib
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BOOKS = {"ru": "private/books/the-hidden-reaction-system-v1.0-ru.pdf",
         "ua": "output/books/THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_UA.pdf",
         "en": "output/books/THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_EN.pdf"}
def page_text(path, n):
    return subprocess.run(["pdftotext", "-q", "-f", str(n), "-l", str(n), path, "-"], capture_output=True, text=True, check=True).stdout
def is_heading(line):
    letters = [c for c in line if c.isalpha()]
    return len(letters) >= 4 and sum(c.isupper() for c in letters) / len(letters) > 0.85 and len(line) <= 60
for lang, rel in BOOKS.items():
    path = os.path.join(ROOT, rel)
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", path], capture_output=True, text=True).stdout).group(1))
    out, section = [], None
    for n in range(1, pages + 1):
        lines = [l.strip() for l in page_text(path, n).splitlines() if l.strip()]
        heads, body = [], []
        for l in lines:
            if is_heading(l) and not body: heads.append(l)        # заголовок раздела — в начале страницы
            else: body.append(l)
        if heads: section = " ".join(heads)
        # склейка строк: пункты «— …» и «• …» отдельно, остальное — в абзацы
        paras, cur = [], ""
        for l in body:
            if re.match(r"^[—–•\-]\s", l):
                if cur: paras.append(cur); cur = ""
                paras.append(l)
            else:
                cur = (cur + " " + l).strip()
                if re.search(r"[.!?:…»”]$", l): paras.append(cur); cur = ""
        if cur: paras.append(cur)
        text = "\n".join(paras).strip()
        if len(text) < 20 and not heads: continue
        out.append({"page": n, "section": section, "page_heading": " ".join(heads) or None, "text": text})
    meta = {"source_file": rel, "language": lang, "title": "The Hidden Reaction System v1.0", "pages": pages,
            "sha1": hashlib.sha1(open(path, "rb").read()).hexdigest(), "extracted_pages": len(out)}
    json.dump({"meta": meta, "pages": out}, open(os.path.join(ROOT, f"content/knowledge/v2/sources/book-{lang}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(lang, "страниц:", pages, "записей:", len(out), "символов:", sum(len(p["text"]) for p in out), "разделов:", len({p["section"] for p in out}))
