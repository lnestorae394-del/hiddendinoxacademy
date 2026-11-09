#!/usr/bin/env python3
"""Сборка переводов книги THE HIDDEN REACTION SYSTEM v1.0 (EN, UA) из оригинального PDF.
1) из оригинала удаляются ТОЛЬКО текстовые объекты (BT…ET) — иллюстрации, маскот, фон, неон и рамки остаются;
2) перевод набирается на тех же местах: базовая линия из матрицы символов оригинала, тот же цвет (белый/зелёный/красный),
   кегль откалиброван по ширине (DejaVu Sans Bold ≈ 1,058× шире Montserrat Bold → ×0,945);
3) русские надписи внутри двух иллюстраций (стр. 8 и 36) перерисовываются в изображении;
4) строки шире исходной области переносятся; блок, не помещающийся до следующего, мягко уменьшается (не ниже 72%).
Запуск (из каталога tools/book_translation): python3 build_book.py en|ua [макс_страница]
Результат: output/books/THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_EN.pdf / _UA.pdf"""
import os, json, re, sys, io, glob, importlib.util
import pikepdf
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "private", "books", "the-hidden-reaction-system-v1.0-ru.pdf")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
pdfmetrics.registerFont(TTFont("DVB", FONT))
K = 0.945
COL = {None: (1, 1, 1), "g": (0.4549, 0.8, 0.0), "r": (0.7843, 0.1294, 0.098)}
CYR = re.compile(r"[А-Яа-яЁёІіЇїЄєҐґ]")

def load_tr():
    T = {}
    for f in sorted(glob.glob("tr/p*.py")):
        spec = importlib.util.spec_from_file_location(f, f); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); T.update(m.T)
    return T

def runs(line):
    """«текст {g}зелёный{/g} текст» → [(текст, цвет)]"""
    out = []; cur = None
    for part in re.split(r"(\{/?[gr]\})", line):
        if not part: continue
        m = re.fullmatch(r"\{(/?)([gr])\}", part)
        if m: cur = None if m.group(1) else m.group(2); continue
        out.append((part, cur))
    return out

def width(rs, size): return sum(pdfmetrics.stringWidth(t, "DVB", size) for t, _ in rs)

def wrap(rs, size, maxw):
    """перенос по словам с сохранением цвета"""
    words = []
    for t, c in rs:
        for i, w in enumerate(re.split(r"(\s+)", t)):
            if w: words.append((w, c))
    lines, cur = [], []
    for w, c in words:
        trial = cur + [(w, c)]
        if cur and not w.isspace() and width(trial, size) > maxw:
            while cur and cur[-1][0].isspace(): cur.pop()
            lines.append(cur); cur = [] if w.isspace() else [(w, c)]
        else:
            if not (not cur and w.isspace()): cur = trial
    if cur: lines.append(cur)
    return lines

def layout(b, text, scale):
    size = b["size"] * K * scale
    maxw = min(max(b.get("avail", 0), max(b["x1"] - b["x0"], 40) * 1.12), 810 - 40 - b["x0"])   # никогда за правое поле
    out = []
    for src_line in text.split("\n"):
        rs = runs(src_line)
        out.extend(wrap(rs, size, maxw) if width(rs, size) > maxw else [rs])
    return size, out

def build(lang, last_page=49):
    T = load_tr(); B = json.load(open("blocks.json", encoding="utf-8"))
    pdf = pikepdf.open(SRC); W = float(pdf.pages[0].MediaBox[2]); H = float(pdf.pages[0].MediaBox[3])
    # 1) удалить текст, оставить изображения
    def strip(owner):
        ops = pikepdf.parse_content_stream(owner); out = []; depth = 0
        for operands, op in ops:
            o = str(op)
            if o == "BT": depth += 1; continue
            if o == "ET": depth -= 1; continue
            if depth == 0: out.append((operands, op))
        return pikepdf.unparse_content_stream(out)
    for page in pdf.pages:
        page.Contents = pdf.make_stream(strip(page))
        if "/XObject" in page.Resources:
            for k, x in page.Resources.XObject.items():
                if x.get("/Subtype") == "/Form": x.write(strip(x))
    # 3) надписи внутри иллюстраций
    import signs; signs.replace(pdf, lang)
    buf = io.BytesIO(); pdf.save(buf); base = PdfReader(io.BytesIO(buf.getvalue()))
    # 2) набор перевода
    report = {"blocks": 0, "shrunk": [], "overflow": [], "untranslated": []}
    ov = io.BytesIO(); c = canvas.Canvas(ov, pagesize=(W, H))
    OBS = json.load(open("obstacles.json"))
    for pn in range(1, len(base.pages) + 1):
        pb = sorted([b for b in B if b["page"] == pn], key=lambda b: b["lines"][0]["base"], reverse=True)
        for b in pb:
            top = H - b["lines"][0]["base"] - b["size"]; bot = H - b["lines"][-1]["base"] + b["size"] * 2.5
            right = W - 40
            cand = [o for o in pb if o is not b] ; rects = []
            for o in cand: rects.append((o["x0"], H - o["lines"][0]["base"] - o["size"], o["x1"], H - o["lines"][-1]["base"] + o["size"] * 0.3))
            for o in OBS.get(str(pn), []):
                under = o["x0"] < b["x1"] - 5 and o["x1"] > b["x0"] + 5 and o["top"] < H - b["lines"][-1]["base"] and o["bottom"] > H - b["lines"][0]["base"] - b["size"]
                if not under: rects.append((o["x0"], o["top"], o["x1"], o["bottom"]))
            for (x0, t0, x1, b1) in rects:
                if x0 >= b["x1"] - 2 and t0 < bot and b1 > top: right = min(right, x0 - 14)
            b["avail"] = max(right - b["x0"], 0)
        for b in pb:
            if b["id"] in T: text = T[b["id"]][0 if lang == "en" else 1]
            elif CYR.search(b["src"]): report["untranslated"].append(b["id"]); text = b["src"]
            else: text = b["src"]
            if b["id"] in FIX: text = FIX[b["id"]]
            report["blocks"] += 1
            lh0 = b["lh"]; top_base = b["lines"][0]["base"]
            # нижняя граница: ближайший блок ниже, пересекающийся по горизонтали
            below = [o for o in pb if o is not b and o["lines"][0]["base"] < b["lines"][-1]["base"] - 1 and not (o["x0"] > b["x1"] + 20 or o["x1"] < b["x0"] - 20)]
            limit = max([o["lines"][0]["base"] + o["size"] * 0.95 for o in below], default=28.0)
            limit = min(limit, b["lines"][-1]["base"] - b["size"] * 0.3)      # исходный низ блока всегда допустим
            scale = 1.0
            while True:
                size, lines = layout(b, text, scale); lh = lh0 * scale
                bottom = top_base - (len(lines) - 1) * lh - size * 0.25
                if bottom >= limit or scale <= 0.72: break
                scale -= 0.02
            if scale < 1.0: report["shrunk"].append((pn, b["id"], round(scale, 2)))
            if bottom < limit - 1: report["overflow"].append((pn, b["id"], round(limit - bottom, 1)))
            y = top_base
            for ln in lines:
                x = b["x0"]
                for t, col in ln:
                    c.setFillColorRGB(*COL[col]); c.setFont("DVB", size); c.drawString(x, y, t); x += pdfmetrics.stringWidth(t, "DVB", size)
                y -= lh
        c.showPage()
    c.save(); over = PdfReader(io.BytesIO(ov.getvalue()))
    wr = PdfWriter()
    for i in range(min(last_page, len(base.pages))):
        p = base.pages[i]; p.merge_page(over.pages[i]); wr.add_page(p)
    wr.add_metadata({"/Title": "THE HIDDEN REACTION SYSTEM — Version 1.0 (" + ("English" if lang == "en" else "Українська") + ")", "/Author": "HIDDENDINOX", "/Language": "en" if lang == "en" else "uk"})
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "output", "books", f"THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_{lang.upper()}.pdf")
    with open(out, "wb") as f: wr.write(f)
    return out, report

# Исправления исходного извлечения (в оригинале слово отделено кернингом, а не пробелом)
FIX = {7: "{g}THE HIDDEN REACTION SYSTEM{/g}"}

if __name__ == "__main__":
    lang = sys.argv[1]; last = int(sys.argv[2]) if len(sys.argv) > 2 else 49
    out, rep = build(lang, last)
    print(out, "| блоков:", rep["blocks"], "| уменьшено:", len(rep["shrunk"]), rep["shrunk"][:8], "| не помещается:", rep["overflow"][:8], "| без перевода:", len(rep["untranslated"]))
