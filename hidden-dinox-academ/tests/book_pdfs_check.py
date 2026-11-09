"""Проверка переведённых книг (output/books): python3 tests/book_pdfs_check.py
Страницы, формат, иллюстрации, язык, вёрстка, перерисованные таблички, метаданные, единые термины."""
import os, re, sys, io
import pikepdf, pdfplumber, numpy as np
from pikepdf import PdfImage
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "book_translation"))
from qa_book import check as layout_check
ORIG = os.path.join(ROOT, "private", "books", "the-hidden-reaction-system-v1.0-ru.pdf")
BOOKS = {"en": os.path.join(ROOT, "output", "books", "THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_EN.pdf"),
         "ua": os.path.join(ROOT, "output", "books", "THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_UA.pdf")}
TERMS = {"en": ["Slowdown", "Pullback", "Volume accumulation", "Reaction", "confirmation", "RISK MANAGEMENT", "market structure", "impulse"],
         "ua": ["Сповільнення", "Відкат", "Накопичення обсягу", "Реакція", "підтвердження", "РИЗИК-МЕНЕДЖМЕНТ", "структур", "імпульс"]}
results = []
def check(name, cond, info=""): results.append(bool(cond)); print(("✔ " if cond else "✘ ") + name + ("" if cond else f" — {str(info)[:200]}"))
def images(pdf):
    out = []
    def walk(res):
        if res is None or "/XObject" not in res: return
        for k, x in res.XObject.items():
            if x.get("/Subtype") == "/Image": out.append(x)
            elif x.get("/Subtype") == "/Form": walk(x.get("/Resources"))
    for p in pdf.pages: walk(p.Resources)
    return out
orig = pikepdf.open(ORIG); o_imgs = len(images(orig)); o_size = [tuple(float(v) for v in p.MediaBox) for p in orig.pages]
for lang, path in BOOKS.items():
    L = lang.upper()
    check(f"{L}: файл существует и открывается", os.path.exists(path))
    pdf = pikepdf.open(path)
    check(f"{L}: 49 страниц", len(pdf.pages) == 49, len(pdf.pages))
    check(f"{L}: формат каждой страницы как в оригинале", [tuple(float(v) for v in p.MediaBox) for p in pdf.pages] == o_size)
    check(f"{L}: все иллюстрации оригинала на месте ({o_imgs})", len(images(pdf)) == o_imgs, len(images(pdf)))
    meta = pdf.open_metadata() if False else pdf.docinfo
    check(f"{L}: метаданные с языком", str(meta.get("/Language", "")) in ("en", "uk") and "HIDDEN REACTION" in str(meta.get("/Title", "")), dict(meta))
    r = layout_check(path, lang)
    check(f"{L}: нет пустых страниц", not r["empty"], r["empty"])
    check(f"{L}: нет наложений строк", not r["overlaps"], r["overlaps"][:3])
    check(f"{L}: текст не выходит за поля", not r["out_of_page"], r["out_of_page"][:3])
    if lang == "en": check("EN: нет кириллицы (незаменённого русского текста)", not r["cyr_en"], r["cyr_en"][:3])
    else: check("UA: нет русских букв (ы, э, ъ, ё) и типичных русских слов", not r["ru_in_ua"], r["ru_in_ua"][:3])
    with pdfplumber.open(path) as pp: full = "\n".join(p.extract_text() or "" for p in pp.pages)
    check(f"{L}: единые термины присутствуют", all(t in full for t in TERMS[lang]), [t for t in TERMS[lang] if t not in full])
    check(f"{L}: бренды не переведены (Hidden Reaction, MARKET STRUCTURE PROTOCOL, HIDDENDINOX)", all(b in full for b in ("Hidden Reaction", "MARKET STRUCTURE PROTOCOL", "HIDDENDINOX")))
    check(f"{L}: текст на каждой из 48 текстовых страниц", sum(1 for p in pdfplumber.open(path).pages if len((p.extract_text() or "").strip()) > 10) >= 48)
    # таблички стр. 8 и 36 перерисованы (изображение отличается от оригинала в области надписи)
    for pn, (dims, box) in {8: ((615, 921), (40, 150, 290, 330)), 36: ((761, 1014), (200, 445, 470, 640))}.items():
        def find(doc):                                   # изображение таблички — по странице и размеру (номера объектов в файлах разные)
            res = doc.pages[pn - 1].Resources; found = []
            def walk(r):
                if r is None or "/XObject" not in r: return
                for k, x in r.XObject.items():
                    if x.get("/Subtype") == "/Image" and (int(x.Width), int(x.Height)) == dims: found.append(x)
                    elif x.get("/Subtype") == "/Form": walk(x.get("/Resources"))
            walk(res); return found[0]
        a = np.asarray(PdfImage(find(orig)).as_pil_image().convert("RGB"), dtype=int)
        b = np.asarray(PdfImage(find(pdf)).as_pil_image().convert("RGB"), dtype=int)
        x0, y0, x1, y1 = box; diff_in = np.abs(a[y0:y1, x0:x1] - b[y0:y1, x0:x1]).mean(); outside = np.abs(a[:y0 - 40] - b[:y0 - 40]).mean()
        check(f"{L}: табличка стр. {pn} перерисована, остальная иллюстрация не тронута", diff_in > 5 and outside < 1.5, (round(float(diff_in), 1), round(float(outside), 2)))
print(f"итого: {sum(results)} из {len(results)}"); sys.exit(0 if all(results) else 1)
