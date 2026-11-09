"""Перевод надписей внутри двух иллюстраций книги (табличка в руках маскота):
стр. 8  «НЕ СОВЕРШАЙ ОШИБОК»         → EN «DON'T MAKE MISTAKES»,    UA «НЕ РОБИ ПОМИЛОК»
стр. 36 «СОБЛЮДАЙ RISK MANAGEMENT»   → EN «FOLLOW RISK MANAGEMENT», UA «ДОТРИМУЙСЯ RISK MANAGEMENT»
Буквы со свечением убираются (OpenCV inpaint по фактуре таблички), перевод рисуется узким жирным шрифтом
с неоновым свечением, по ширине и наклону исходной надписи. Иллюстрация остаётся оригинальной."""
import os, zlib, numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import pikepdf
from pikepdf import PdfImage
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"
SIGNS = {
  8:  {"obj": (98, 0),  "box": (40, 150, 290, 330), "en": ["DON'T MAKE", "MISTAKES"],          "ua": ["НЕ РОБИ", "ПОМИЛОК"]},
  36: {"obj": (226, 0), "box": (200, 445, 470, 640), "en": ["FOLLOW", "RISK", "MANAGEMENT"],   "ua": ["ДОТРИМУЙСЯ", "RISK", "MANAGEMENT"]},
}
def redo(img, spec, lines):
    a = np.array(img.convert("RGB")); x0, y0, x1, y1 = spec["box"]
    roi = a[y0:y1, x0:x1].astype(int)
    r, g, b = roi[..., 0], roi[..., 1], roi[..., 2]
    core = ((g > 110) & (g - np.maximum(r, b) > 45)).astype(np.uint8)          # яркие буквы
    glow = ((g > 45) & (g - np.maximum(r, b) > 18)).astype(np.uint8)            # ореол
    ys, xs = np.nonzero(core)
    tb = (xs.min(), ys.min(), xs.max(), ys.max())                               # рамка исходной надписи
    rect = cv2.minAreaRect(np.column_stack([xs, ys]).astype(np.float32)); ang = rect[2]
    if ang > 45: ang -= 90
    if ang < -45: ang += 90
    col = tuple(int(v) for v in np.median(roi[core > 0], axis=0))              # цвет букв
    mask = np.zeros(a.shape[:2], np.uint8); m = cv2.dilate(np.maximum(core, glow) * 255, np.ones((5, 5), np.uint8), iterations=2)
    mask[y0:y1, x0:x1] = m
    clean = cv2.inpaint(a, mask, 9, cv2.INPAINT_TELEA)
    # новая надпись: кегль по высоте исходной, строки сжимаются по горизонтали до её ширины (как узкий плакатный шрифт)
    W, H = tb[2] - tb[0], tb[3] - tb[1]; n = len(lines)
    size = int(H / (n * 1.06)); f = ImageFont.truetype(FONT, size)
    lay = Image.new("L", (W * 2, H * 2), 0); lh = H / n; top = H / 2
    for i, t in enumerate(lines):
        bb = f.getbbox(t); lw, lhh = bb[2] - bb[0], bb[3] - bb[1]
        li = Image.new("L", (lw + 4, lhh + 4), 0); ImageDraw.Draw(li).text((2 - bb[0], 2 - bb[1]), t, font=f, fill=255)
        tw = min(lw, int(W * 0.98)); li = li.resize((tw + 4, int((lhh + 4) * 0.92)), Image.LANCZOS)
        lay.paste(li, (int((W * 2 - li.width) / 2), int(top + i * lh + (lh - li.height) / 2)))
    lay = lay.rotate(-ang if abs(ang) > 0.8 else 0, resample=Image.BICUBIC, center=(W, H))
    out = Image.fromarray(clean); cx, cy = x0 + (tb[0] + tb[2]) / 2, y0 + (tb[1] + tb[3]) / 2
    ox, oy = int(cx - W), int(cy - H)
    full = Image.new("L", out.size, 0); full.paste(lay, (ox, oy))
    for rad, k in ((12, 0.6), (5, 0.85)):                                       # неоновое свечение
        gl = full.filter(ImageFilter.GaussianBlur(rad)).point(lambda v: int(v * k))
        out = Image.composite(Image.new("RGB", out.size, (60, 200, 10)), out, gl)
    out = Image.composite(Image.new("RGB", out.size, col), out, full.filter(ImageFilter.GaussianBlur(0.5)))
    return out, {"angle": round(ang, 1), "size": size, "orig_text_box": tb}

def replace(pdf, lang):
    done = 0
    for pn, spec in SIGNS.items():
        obj = pdf.get_object(spec["obj"])
        img = PdfImage(obj).as_pil_image()
        new, info = redo(img, spec, spec[lang])
        raw = new.convert("RGB").tobytes()
        obj.write(zlib.compress(raw, 9), filter=pikepdf.Name.FlateDecode)
        obj.ColorSpace = pikepdf.Name.DeviceRGB; obj.BitsPerComponent = 8; obj.Width = new.width; obj.Height = new.height
        for k in ("/DecodeParms", "/Decode"):
            if k in obj: del obj[k]
        done += 1
    return done

if __name__ == "__main__":
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "private", "books", "the-hidden-reaction-system-v1.0-ru.pdf"); pdf = pikepdf.open(src); tiles = []
    for pn, spec in SIGNS.items():
        img = PdfImage(pdf.get_object(spec["obj"])).as_pil_image().convert("RGB")
        for lang in ("en", "ua"):
            new, info = redo(img, spec, spec[lang]); print(pn, lang, info)
            x0, y0, x1, y1 = spec["box"]; tiles.append(new.crop((x0 - 30, y0 - 30, x1 + 30, y1 + 30)).resize((300, int(300 * (y1 - y0 + 60) / (x1 - x0 + 60)))))
        x0, y0, x1, y1 = spec["box"]; tiles.append(img.crop((x0 - 30, y0 - 30, x1 + 30, y1 + 30)).resize((300, int(300 * (y1 - y0 + 60) / (x1 - x0 + 60)))))
    Hh = max(t.height for t in tiles); s = Image.new("RGB", (len(tiles) * 310, Hh), (60, 60, 60))
    for i, t in enumerate(tiles): s.paste(t, (i * 310, 0))
    s.save("signs_check.png")
