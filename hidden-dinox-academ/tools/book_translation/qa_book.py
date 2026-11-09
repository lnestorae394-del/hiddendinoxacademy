"""Проверка переведённых книг: страницы, язык, наложения строк, выход за поля, пустые страницы."""
import sys, re, pdfplumber, collections
RU_WORDS = r"\b(это|что|рынок|движение|движения|если|только|когда|потому|чтобы|цена|сделка|сделки|ещё|всё|который|которые|нет|можно)\b"
def check(path, lang):
    res = {"pages": 0, "cyr_en": [], "ru_in_ua": [], "overlaps": [], "out_of_page": [], "empty": [], "chars": 0}
    with pdfplumber.open(path) as pdf:
        res["pages"] = len(pdf.pages)
        for pn, p in enumerate(pdf.pages, 1):
            text = p.extract_text() or ""; res["chars"] += len(text)
            if len(text.strip()) < 10: res["empty"].append(pn)
            if lang == "en" and re.search(r"[А-Яа-яЁёІіЇїЄєҐґ]", text): res["cyr_en"].append((pn, re.findall(r"[А-Яа-яЁёІіЇїЄєҐґ]+", text)[:3]))
            if lang == "ua":
                bad = re.findall(r"[ЫыЭэЪъЁё]", text) + re.findall(RU_WORDS, text.lower())
                if bad: res["ru_in_ua"].append((pn, bad[:5]))
            cs = [c for c in p.chars if c["text"].strip()]
            for c in cs:
                if c["x0"] < 4 or c["x1"] > p.width - 4 or c["top"] < 2 or c["bottom"] > p.height - 2: res["out_of_page"].append((pn, c["text"])); break
            rows = collections.defaultdict(list)
            for c in cs: rows[round(c["top"])].append(c)
            keys = sorted(rows); boxes = []
            for k in keys:
                r = rows[k]; boxes.append((min(c["x0"] for c in r), min(c["top"] for c in r), max(c["x1"] for c in r), max(c["bottom"] for c in r), k))
            for i in range(len(boxes)):
                for j in range(i + 1, len(boxes)):
                    a, b = boxes[i], boxes[j]
                    if abs(a[4] - b[4]) < 3: continue
                    ix = min(a[2], b[2]) - max(a[0], b[0]); iy = min(a[3], b[3]) - max(a[1], b[1])
                    if ix > 2 and iy > 0.35 * min(a[3] - a[1], b[3] - b[1]): res["overlaps"].append((pn, round(a[1]), round(b[1])))
    return res
if __name__ == "__main__":
    import os
    D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "output", "books")
    for path, lang in ((os.path.join(D, "THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_EN.pdf"), "en"), (os.path.join(D, "THE_HIDDEN_REACTION_SYSTEM_VERSION_1.0_UA.pdf"), "ua")):
        r = check(path, lang)
        print(lang.upper(), "| страниц:", r["pages"], "| символов текста:", r["chars"], "| пустых:", r["empty"], "| наложений строк:", r["overlaps"][:6], "| за полями:", r["out_of_page"][:4],
              "| кириллица в EN:", r["cyr_en"][:3] if lang == "en" else "-", "| русское в UA:", r["ru_in_ua"][:4] if lang == "ua" else "-")
