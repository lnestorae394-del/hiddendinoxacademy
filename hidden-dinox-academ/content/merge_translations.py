#!/usr/bin/env python3
"""Вписывает переводы (content/hidden-reaction-course.i18n.json) в JSON курса как поле tr у курса, модулей и уроков:
   tr = { en: {путь: текст}, ua: {путь: текст}, src: {путь: отпечаток русского оригинала} }.
Русский текст не меняется. Отпечаток (sha1, 12 символов) позволяет серверу не показывать перевод устаревшего оригинала.
Запуск: python3 content/merge_translations.py  (вызывается и из build_course.py)."""
import json, hashlib, os
HERE = os.path.dirname(os.path.abspath(__file__))
COURSE = os.path.join(HERE, "hidden-reaction-course.json"); I18N = os.path.join(HERE, "hidden-reaction-course.i18n.json")
h = lambda s: hashlib.sha1(s.encode("utf-8")).hexdigest()[:12]

def get(o, parts):
    for p in parts: o = o[int(p)] if isinstance(o, list) else o[p]
    return o

def main():
    d = json.load(open(COURSE, encoding="utf-8")); t = json.load(open(I18N, encoding="utf-8"))
    def strip(o):
        if isinstance(o, dict): o.pop("tr", None); [strip(v) for v in o.values()]
        elif isinstance(o, list): [strip(v) for v in o]
    strip(d)
    stats = {"strings": 0, "stale": 0}
    for path, en in t["en"].items():
        ua = t["ua"].get(path); parts = path.split("/")
        if parts[0] == "course": owner, rel = d["course"], parts[1:]
        elif parts[0] == "modules" and len(parts) > 3 and parts[2] == "lessons": owner, rel = d["modules"][int(parts[1])]["lessons"][int(parts[3])], parts[4:]
        elif parts[0] == "modules": owner, rel = d["modules"][int(parts[1])], parts[2:]
        else: continue
        try: ru = get(owner, rel)
        except (KeyError, IndexError, ValueError): stats["stale"] += 1; continue
        if not isinstance(ru, str): stats["stale"] += 1; continue
        key = "/".join(rel); tr = owner.setdefault("tr", {"en": {}, "ua": {}, "src": {}})
        tr["en"][key] = en; tr["src"][key] = h(ru)
        if ua: tr["ua"][key] = ua
        stats["strings"] += 1
    json.dump(d, open(COURSE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"переводы вписаны: {stats['strings']} строк (EN и UA); не найдено в курсе: {stats['stale']}")

if __name__ == "__main__": main()
