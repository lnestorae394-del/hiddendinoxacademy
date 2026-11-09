# Синтетические учебные графики HIDDEN DINOX ACADEMY.
# Свечи строятся из фаз, описанных в книге (импульс → замедление → откат → накопление → реакция).
# Это НЕ рыночные данные: каждый график в уроке подписан как учебная схема.
import random

class Builder:
    def __init__(self, start=100.0, seed=7):
        self.c = []; self.p = start; self.r = random.Random(seed)
    def _candle(self, drift, body_noise, wick):
        o = self.p
        cl = o + drift + self.r.uniform(-body_noise, body_noise)
        h = max(o, cl) + abs(self.r.uniform(0.15, 1.0)) * wick
        l = min(o, cl) - abs(self.r.uniform(0.15, 1.0)) * wick
        self.c.append([round(o, 2), round(h, 2), round(l, 2), round(cl, 2)]); self.p = cl
        return len(self.c) - 1
    def impulse(self, n, d, s=1.0):      # сильные свечи, маленькие тени
        return [self._candle(d * s * self.r.uniform(0.85, 1.15), abs(d) * 0.1, abs(d) * 0.15) for _ in range(n)]
    def slowdown(self, n, d):            # тела уменьшаются, тени растут
        out = []
        for i in range(n):
            k = 1 - (i + 1) / (n + 1.2)
            out.append(self._candle(d * k * 0.55, abs(d) * 0.12, abs(d) * 0.75))
        return out
    def pullback(self, n, d):            # против прежнего движения
        return [self._candle(-d * self.r.uniform(0.45, 0.7), abs(d) * 0.12, abs(d) * 0.35) for _ in range(n)]
    def accumulation(self, n, d, spikes=()):  # узкий диапазон, шум, ложные выбросы
        out = []; base = self.p
        for i in range(n):
            drift = (base - self.p) * 0.6 + self.r.uniform(-1, 1) * abs(d) * 0.25
            idx = self._candle(drift, abs(d) * 0.08, abs(d) * 0.35)
            if i in spikes:
                o, h, l, c = self.c[idx]
                if spikes[i] == "up": self.c[idx][1] = round(h + abs(d) * 1.6, 2)
                else: self.c[idx][2] = round(l - abs(d) * 1.6, 2)
            out.append(idx)
        return out
    def chaos(self, n, d):
        return [self._candle(self.r.choice([-1, 1]) * abs(d) * self.r.uniform(0.6, 1.6), abs(d) * 0.3, abs(d) * 0.9) for _ in range(n)]
    def lo(self, idx): return min(self.c[i][2] for i in idx)
    def hi(self, idx): return max(self.c[i][1] for i in idx)

def zone(a, b, text, tone="neutral"): return {"type": "zone", "from": a, "to": b, "text": text, "tone": tone}
def marker(i, text, pos="above", tone="accent"): return {"type": "marker", "at": i, "text": text, "pos": pos, "tone": tone}
def hline(p, text, dashed=True): return {"type": "hline", "price": round(p, 2), "text": text, "dashed": dashed}
def chart(b, anns, title, caption=""):
    return {"candles": b.c, "annotations": anns, "title": title, "caption": caption}

CAP = "Схема иллюстрирует понятие из книги и построена на синтетических данных."

def cycle_reversal_up(seed=11, labels=True, entry=False):
    b = Builder(120, seed); d = -2.2
    imp = b.impulse(6, d); sl = b.slowdown(3, d); pb = b.pullback(2, d); acc = b.accumulation(4, d); re = b.impulse(5, -d)
    anns = [zone(sl[0], sl[-1], "1. Замедление"), zone(pb[0], pb[-1], "2. Откат"), zone(acc[0], acc[-1], "3. Накопление объёма"), zone(re[0], re[-1], "4. Реакция", "good")]
    if entry:
        anns += [marker(re[0], "Подготовка завершена", "below", "good"), marker(re[3], "Поздний вход", "above", "bad")]
    return b, anns, (imp, sl, pb, acc, re)

def cycle_breakdown_down(seed=21):
    b = Builder(80, seed); d = 2.2
    imp = b.impulse(6, d); sl = b.slowdown(3, d); pb = b.pullback(2, d); acc = b.accumulation(4, d); re = b.impulse(5, -d)
    anns = [zone(sl[0], sl[-1], "1. Замедление"), zone(pb[0], pb[-1], "2. Откат"), zone(acc[0], acc[-1], "3. Накопление"), zone(re[0], re[-1], "4. Реакция", "bad")]
    return b, anns

def slowdown_chart():
    b = Builder(80, 3); d = 2.4
    imp = b.impulse(6, d); sl = b.slowdown(5, d)
    return chart(b, [zone(imp[0], imp[-1], "Сильный импульс", "good"), zone(sl[0], sl[-1], "Замедление", "accent"), marker(sl[2], "Тела меньше, тени длиннее")], "Импульс теряет силу", CAP)

def pullback_chart():
    b = Builder(80, 5); d = 2.4
    imp = b.impulse(6, d); sl = b.slowdown(3, d); pb = b.pullback(4, d)
    return chart(b, [zone(imp[0], imp[-1], "Импульс", "good"), zone(sl[0], sl[-1], "Замедление"), zone(pb[0], pb[-1], "Откат", "accent"), marker(pb[2], "Выглядит как разворот", "below", "bad")], "Откат после замедления", CAP)

def accumulation_chart():
    b = Builder(90, 9); d = 2.0
    b.impulse(4, -d); acc = b.accumulation(10, d, spikes={2: "up", 6: "down", 8: "up"})
    top = max(b.c[i][3] for i in acc) + 0.6; bot = min(b.c[i][3] for i in acc) - 0.6
    return chart(b, [zone(acc[0], acc[-1], "Накопление объёма", "accent"), hline(top, "граница диапазона"), hline(bot, "граница диапазона"), marker(acc[2], "Ложная реакция"), marker(acc[6], "Ложная реакция", "below")], "Накопление: шум и ложные движения", CAP)

def reaction_chart():
    b = Builder(90, 13); d = 2.0
    acc = b.accumulation(6, d); re = b.impulse(6, d)
    return chart(b, [zone(acc[0], acc[-1], "Подготовка (накопление)"), zone(re[0], re[-1], "Реакция", "good"), marker(re[2], "Здесь замечает большинство", "above", "bad")], "Реакция — результат подготовки", CAP)

def late_entry_chart():
    b = Builder(80, 17); d = 2.4
    b.impulse(7, d); late = b.slowdown(2, d); pb = b.pullback(4, d)
    return chart(b, [marker(5, "Вход «вдогонку»", "above", "bad"), zone(late[0], pb[-1], "Замедление и откат после входа", "bad")], "Ошибка: вход после импульса", CAP)

def structure_chart():
    b = Builder(100, 23); d = -1.8
    i1 = b.impulse(4, d); s1 = b.slowdown(3, d); p1 = b.pullback(2, d); a1 = b.accumulation(4, d); r1 = b.impulse(4, -d)
    s2 = b.slowdown(3, -d); p2 = b.pullback(2, -d); a2 = b.accumulation(3, -d); r2 = b.impulse(3, -d)
    return chart(b, [zone(s1[0], a1[-1], "Подготовка 1"), zone(r1[0], r1[-1], "Реакция 1", "good"), zone(s2[0], a2[-1], "Подготовка 2"), zone(r2[0], r2[-1], "Реакция 2", "good")], "Структура: цепочка этапов, а не отдельные свечи", CAP)

def chaos_chart():
    b = Builder(90, 29); d = 1.8
    ch = b.chaos(8, d); jump = b.impulse(4, d * 1.4)
    return chart(b, [zone(ch[0], ch[-1], "Хаотичное движение", "bad"), zone(jump[0], jump[-1], "Агрессия без подготовки", "bad")], "Где входить нельзя: нет замедления, отката и накопления", CAP)

def hidden_reversal():
    b, anns, _ = cycle_reversal_up(31)
    return chart(b, anns, "Hidden Reversal — скрытый разворот", "Схема по мотивам авторской иллюстрации (pattern.pdf), синтетические данные.")
def hidden_breakdown():
    b, anns = cycle_breakdown_down(37)
    return chart(b, anns, "Hidden Breakdown — скрытый пробой вниз", "Схема по мотивам авторской иллюстрации (pattern.pdf), синтетические данные.")
def hidden_rejection():
    b = Builder(80, 41); d = 2.0
    up = b.impulse(6, d); lvl = b.hi(up[-1:]) + 0.6
    i = b._candle(0.3, 0.1, 0.3); b.c[i][1] = round(lvl + 4.5, 2)          # длинная верхняя тень за уровень
    rj = b.impulse(5, -d * 1.1)
    return chart(b, [hline(lvl, "уровень"), marker(i, "1. Ложный пробой уровня"), marker(rj[0], "2. Сильное отклонение", "below", "bad"), zone(rj[2], rj[-1], "3. Разворот движения", "bad")], "Hidden Rejection — скрытое отклонение", "Схема по мотивам авторской иллюстрации (pattern.pdf), синтетические данные.")
def hidden_compression():
    b = Builder(90, 43); d = 1.6; idx = []
    for k in range(12):                                                   # колебания с затухающей амплитудой вокруг 90
        amp = 3.4 * (1 - k / 13)
        target = 90 + (amp if k % 2 == 0 else -amp) * 0.8
        o = b.p; cl = target
        h = max(o, cl) + 0.25; l = min(o, cl) - 0.25
        b.c.append([round(o, 2), round(h, 2), round(l, 2), round(cl, 2)]); b.p = cl; idx.append(len(b.c) - 1)
    br = b.impulse(4, d * 1.5)
    first, last = idx[0], idx[-1]
    hi1 = max(b.c[i][1] for i in idx[:3]); lo1 = min(b.c[i][2] for i in idx[:3])
    hi2 = max(b.c[i][1] for i in idx[-3:]); lo2 = min(b.c[i][2] for i in idx[-3:])
    return chart(b, [{"type": "trend", "from": first, "to": last, "p1": round(hi1 + 0.3, 2), "p2": round(hi2 + 0.3, 2)}, {"type": "trend", "from": first, "to": last, "p1": round(lo1 - 0.3, 2), "p2": round(lo2 - 0.3, 2)},
                     zone(first, last, "1. Сжатие диапазона"), marker(br[0], "2. Пробой диапазона", "below", "good"), zone(br[1], br[-1], "3. Импульсное движение", "good")],
                 "Hidden Compression — скрытое сжатие", "Схема по мотивам авторской иллюстрации (pattern.pdf), синтетические данные.")
def hidden_liquidity():
    b = Builder(80, 47); d = 2.0
    b.impulse(5, d); base = b.p; acc = []
    for k in range(8):                                                    # широкий боковой диапазон
        target = base + (2.2 if k % 2 == 0 else -2.2) + b.r.uniform(-0.4, 0.4)
        acc.append(b._candle(target - b.p, 0.1, 0.5))
    top = max(b.c[i][1] for i in acc); bot = min(b.c[i][2] for i in acc)
    sp = b._candle(top - b.p + 0.8, 0.1, 0.2); b.c[sp][1] = round(top + 3.2, 2)
    dn = b.impulse(5, -d * 1.3)
    return chart(b, [hline(top, "верх диапазона"), hline(bot, ""), zone(acc[0], acc[-1], "2. Сбор ликвидности стопов за уровнем"), marker(sp, "1. Ложный пробой"), zone(dn[0], dn[-1], "3. Резкий импульс в противоположную сторону", "bad")],
                 "Hidden Liquidity — скрытая ликвидность", "Схема по мотивам авторской иллюстрации (pattern.pdf), синтетические данные.")
def hidden_trap():
    b = Builder(80, 53); d = 1.8
    up = b.impulse(7, d); lvl = b.hi(up[-1:]) + 0.5
    t = b._candle(0.9, 0.1, 0.3); b.c[t][1] = round(lvl + 3.6, 2)
    back = b._candle(-2.6, 0.1, 0.4); dn = b.impulse(5, -d * 1.2)
    return chart(b, [hline(lvl, "уровень"), marker(t, "1. Ложный пробой"), marker(back, "2. Возврат ниже уровня", "below", "bad"), zone(dn[0], dn[-1], "3. Сильное движение в обратную сторону", "bad")],
                 "Hidden Trap — ложная ловушка", "Схема по мотивам авторской иллюстрации (pattern.pdf), синтетические данные.")
