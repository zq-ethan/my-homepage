"""生成主页用的头像 / OG 封面 / favicon / iOS 图标。

换照片只需改 SRC 和 FACE_CX / FACE_CY（人脸中心在原图上的像素坐标）。
原图按 4160x3120 标定，换图后坐标要重新估。

用法：
    C:\\Users\\lenovo\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe tools\\make-profile-assets.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
TOOLS = ROOT / "tools"

SRC = r"C:\Users\lenovo\Pictures\IMG_20260904_185512.jpg"
FACE_CX = 2860
FACE_CY = 798

BRAND_BG = (31, 36, 48)


def grade(img, b, c, s, sharp=True):
    img = ImageEnhance.Brightness(img).enhance(b)
    img = ImageEnhance.Contrast(img).enhance(c)
    img = ImageEnhance.Color(img).enhance(s)
    if sharp:
        img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=105, threshold=3))
    return img


def load_font(size, bold=False):
    cands = (
        [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc"]
        if bold
        else [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]
    )
    for p in cands:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def make_avatar(im):
    """正方形头像，人脸大致居中，顶部贴齐（原图上方没有余量）。"""
    size = 1900
    box = (FACE_CX - size // 2, 0, FACE_CX + size // 2, size)
    img = grade(im.crop(box).resize((400, 400), Image.LANCZOS), 1.45, 1.14, 1.06)
    out = PUBLIC / "avatar.jpg"
    img.save(out, quality=90, optimize=True)
    return out


def make_og_cover(im):
    """1200x630 分享封面：右侧人像（柔光暗角），左侧姓名与方向。"""
    size = 2300
    box = (FACE_CX - size // 2 + 40, 0, FACE_CX + size // 2 + 40, size)
    photo = grade(im.crop(box).resize((630, 630), Image.LANCZOS), 1.55, 1.18, 1.06)

    fx, fy = (FACE_CX - box[0]) / size * 630, (FACE_CY - box[1]) / size * 630
    glow = Image.new("L", (630, 630), 0)
    ImageDraw.Draw(glow).ellipse(
        [fx - 300, fy - 380, fx + 300, fy + 380], fill=255
    )
    glow = glow.filter(ImageFilter.GaussianBlur(130))
    photo = Image.composite(photo, ImageEnhance.Brightness(photo).enhance(0.42), glow)

    canvas = Image.new("RGB", (1200, 630), (18, 21, 27))
    fade = Image.new("L", (630, 630), 255)
    for x in range(200):
        fade.paste(int(255 * (x / 200) ** 1.5), (x, 0, x + 1, 630))
    canvas.paste(photo, (570, 0), fade)

    draw = ImageDraw.Draw(canvas)
    draw.text((92, 228), "赵泉恩", font=load_font(60, True), fill=(246, 248, 252))
    draw.rectangle([92, 322, 132, 326], fill=(126, 136, 155))
    draw.text((92, 360), "计算机科学与技术 · AI 全栈", font=load_font(26), fill=(160, 169, 184))
    draw.text((92, 542), "zqe.ccwu.cc", font=load_font(22), fill=(104, 114, 132))

    out = PUBLIC / "og-cover.jpg"
    canvas.save(out, quality=88, optimize=True)
    return out


def make_favicon():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<rect width="64" height="64" rx="14" fill="#1F2430"/>'
        '<path d="M20 21 H44 L20 43 H44" fill="none" stroke="#FFFFFF" '
        'stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'
        "</svg>\n"
    )
    out = PUBLIC / "favicon.svg"
    out.write_text(svg, encoding="utf-8")
    return out


def make_touch_icon():
    img = Image.new("RGB", (180, 180), BRAND_BG)
    draw = ImageDraw.Draw(img)
    draw.line([(56, 59), (124, 59), (56, 121), (124, 121)],
              fill=(255, 255, 255), width=17, joint="curve")
    out = PUBLIC / "apple-touch-icon.png"
    img.save(out, optimize=True)
    return out


def main():
    im = Image.open(SRC)
    report = [f"source {SRC} {im.size}"]
    for path in (make_avatar(im), make_og_cover(im), make_favicon(), make_touch_icon()):
        report.append(f"{path.name}  {round(path.stat().st_size / 1024, 1)} KB")
    (TOOLS / "_report_assets.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))


if __name__ == "__main__":
    main()
