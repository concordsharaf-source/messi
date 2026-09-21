#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ينشئ أيقونات «واتساب الوليد» كاملة الحواف — بلا أي هامش أو حواف بيضاء.

المدخل : icons/icon.png  (الأصل 1024×1024 بهامش أبيض) + icons/icon1.png (شعار المؤسسة)
المخرجات في icons/:
  icon.png (1024) · icon-192.png · icon-512.png
  maskable-192.png · maskable-512.png     ← منطقة أمان 80% لأنظمة أندرويد
  apple-touch-icon.png (180) · favicon-32.png · favicon-16.png
  org-logo-512.png                        ← شعار المؤسسة كامل الحواف (بديل اختياري)

الفكرة:
  • التمييز بين «الخلفية الخضراء» و«الرمز الأبيض» باختبار اللون الأخضر
    (g أعلى بوضوح من r و b) ⇒ حواف الرمز الناعمة تُلتقط بدقّة.
  • البياض المتصل بحدود الصورة (الهامش + زوايا المربّع المستدير) يُعبّأ بلون
    أقرب بكسل أخضر في نفس السطر ⇒ الحواف خضراء بالكامل مع حفظ التدرّج.
  • نسخة maskable: تُمسح الخلفية من الرمز ثم يُلصق الرمز مُصغَّراً 80% في
    المنتصف ⇒ يبقى داخل دائرة الأمان فلا يُقتطع على أي واجهة.

التشغيل: python3 tools/make_icons.py
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"

CONTENT_MIN = 235     # عتبة تحديد إطار المحتوى في الأصل
INSET = 9             # قصّ داخل الحدّ لاستبعاد حافّة التلاشي الفاتحة في الأصل
EDGE_RINGS = 2        # عدد صفوف البكسل التي تُمدّ للخارج لمنع أي بياض على الحدود


def greenish(p):
    """هل اللون من عائلة الخلفية الخضراء؟"""
    return p[1] > p[0] + 25 and p[1] > p[2] + 10


def proper_bg(p):
    """أخضر خلفية أصلي: أخضر وقناته الأفتح ≤ 130 (يستبعد حواف التلاشي نحو الأبيض)."""
    return greenish(p) and min(p) <= 130


def content_bbox(img, thresh=CONTENT_MIN):
    px = img.load()
    w, h = img.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if min(px[x, y]) < thresh:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    return (minx, miny, maxx + 1, maxy + 1)


def background_mask(art):
    """المناطق غير الخضراء المتصلة بحدود الصورة (الهامش الأبيض وزوايا المربّع)."""
    w, h = art.size
    p = art.load()
    out = bytearray(w * h)
    q = deque()

    def push(x, y):
        if not out[y * w + x] and not proper_bg(p[x, y]):
            out[y * w + x] = 1
            q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not out[ny * w + nx] and not proper_bg(p[nx, ny]):
                out[ny * w + nx] = 1
                q.append((nx, ny))
    return out


def fill_white_areas(art, mask):
    """يعبّئ البكسلات المُعلَّمة بلون أقرب بكسل أخضر في نفس السطر (يحفظ التدرّج)."""
    w, h = art.size
    p = art.load()
    out = art.copy()
    o = out.load()
    for y in range(h):
        xs = [x for x in range(w) if not mask[y * w + x]]
        if not xs:
            continue
        for x in range(w):
            if not mask[y * w + x]:
                continue
            left = max([i for i in xs if i < x], default=None)
            right = min([i for i in xs if i > x], default=None)
            if left is None and right is None:
                continue
            if left is None:
                o[x, y] = p[right, y]
            elif right is None:
                o[x, y] = p[left, y]
            else:
                o[x, y] = p[left, y] if (x - left) <= (right - x) else p[right, y]
    return out


def glyph_alpha(art, bgmask):
    """شفافية الرمز الأبيض الداخلي (البكسلات غير الخضراء غير المتصلة بالحدود)."""
    w, h = art.size
    p = art.load()
    a = Image.new("L", (w, h), 0)
    o = a.load()
    for y in range(h):
        greens = [x for x in range(w) if greenish(p[x, y])]
        if not greens:
            continue
        base = sum(sum(p[x, y]) / 3 for x in greens) / len(greens)   # سطوع الخلفية في السطر
        span = max(1.0, 255.0 - base)
        for x in range(w):
            if bgmask[y * w + x]:
                continue
            v = (sum(p[x, y]) / 3 - base) / span
            o[x, y] = 0 if v <= 0 else (255 if v >= 1 else int(v * 255))
    return a


def clean_background(full, alpha, pad=3):
    """يمسح الرمز من الصورة: يوسّع قناع الرمز قليلاً ثم يملأ الفراغ بسلاسة."""
    w, h = full.size
    m = alpha.point(lambda v: 255 if v > 40 else 0)
    m = m.filter(ImageFilter.MaxFilter(2 * pad + 1))
    p = full.load()
    mm = m.load()
    out = full.copy()
    o = out.load()
    for y in range(h):
        xs = [x for x in range(w) if mm[x, y] == 0]
        if not xs:
            continue
        for x in range(w):
            if mm[x, y] == 0:
                continue
            left = max([i for i in xs if i < x], default=None)
            right = min([i for i in xs if i > x], default=None)
            if left is None and right is None:
                continue
            if left is None:
                o[x, y] = p[right, y]
            elif right is None:
                o[x, y] = p[left, y]
            else:
                o[x, y] = p[left, y] if (x - left) <= (right - x) else p[right, y]
    # تنعيم داخل المنطقة الممسوحة فقط
    soft = out.filter(ImageFilter.GaussianBlur(pad * 1.6))
    out = Image.composite(soft, out, m)
    return out


def maskable(full, alpha, scale=0.80):
    """خلفية كاملة بتدرّجها الأصلي + الرمز مُصغَّراً في المنتصف."""
    w, h = full.size
    bg = clean_background(full, alpha)
    layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    layer.putalpha(alpha)
    gw, gh = int(w * scale), int(h * scale)
    layer = layer.resize((gw, gh), Image.LANCZOS)
    out = bg.convert("RGBA")
    out.alpha_composite(layer, ((w - gw) // 2, (h - gh) // 2))
    return out.convert("RGB")


def harden_edges(img):
    """لا يترك أي بكسل شاحب على الحدود: يجرّ ألوان الداخل إلى الخارج بالتدريج."""
    w, h = img.size
    p = img.load()

    def inward(x, y, dx, dy):
        # المرحلة 1: أخضر صريح (قناته الأفتح ≤ 130) خلال 16 بكسل
        for k in range(1, 17):
            nx, ny = x + dx * k, y + dy * k
            if 0 <= nx < w and 0 <= ny < h and proper_bg(p[nx, ny]):
                return p[nx, ny]
        # المرحلة 2: أقرب لون أخضر مرئي ولو كان فاتحاً
        for k in range(1, 17):
            nx, ny = x + dx * k, y + dy * k
            if 0 <= nx < w and 0 <= ny < h and greenish(p[nx, ny]):
                return p[nx, ny]
        return None

    for x in range(w):
        for y, dy in ((0, 1), (h - 1, -1)):
            c = inward(x, y, 0, dy)
            if c:
                p[x, y] = c
    for y in range(h):
        for x, dx in ((0, 1), (w - 1, -1)):
            c = inward(x, y, dx, 0)
            if c:
                p[x, y] = c
    return img


def save(img, name, size):
    img = harden_edges(img.convert("RGB").resize((size, size), Image.LANCZOS))
    img.save(ICONS / name, "PNG", optimize=True)
    print(f"  ✔ icons/{name:22s} {size}×{size}")


def white_border_count(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    p = im.load()
    edge = [p[x, y] for x in range(w) for y in (0, h - 1)] + [p[x, y] for y in range(h) for x in (0, w - 1)]
    return sum(1 for c in edge if not greenish(c))


def main():
    src = Image.open(ICONS / "icon.png").convert("RGB")
    x0, y0, x1, y1 = content_bbox(src)
    art = src.crop((x0 + INSET, y0 + INSET, x1 - INSET, y1 - INSET))
    print(f"• المحتوى الأصلي بعد القصّ: {art.size}")
    bgmask = background_mask(art)
    print(f"• بكسلات الهامش/الزوايا المُعبّأة: {sum(bgmask)}")
    full = fill_white_areas(art, bgmask)
    alpha = glyph_alpha(art, bgmask)
    px = alpha.load()
    print(f"• بكسلات الرمز الأبيض: {sum(1 for v in alpha.getdata() if v > 128)}")
    mk = maskable(full, alpha)

    print("• الأيقونات:")
    save(full, "icon.png", 1024)
    save(full, "icon-192.png", 192)
    save(full, "icon-512.png", 512)
    save(mk, "maskable-192.png", 192)
    save(mk, "maskable-512.png", 512)
    save(full, "apple-touch-icon.png", 180)
    save(full, "favicon-32.png", 32)
    save(full, "favicon-16.png", 16)

    org = Image.open(ICONS / "icon1.png").convert("RGB")
    save(org.crop(content_bbox(org)), "org-logo-512.png", 512)

    print("• بكسل غير أخضر على الحدود (يجب أن يكون 0):")
    for n in ("icon.png", "icon-192.png", "icon-512.png", "maskable-192.png",
              "maskable-512.png", "apple-touch-icon.png", "favicon-32.png"):
        print(f"  {n:22s} {white_border_count(ICONS / n)}")


if __name__ == "__main__":
    main()
