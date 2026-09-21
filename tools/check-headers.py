"""检查线上响应头有没有真的生效 —— `_headers` 的"最后一公里"验证。

为什么必须单独有这么一个脚本：
  `_headers` 只有 Cloudflare Pages 会解析，本地 server.py 根本不读它。
  所以 tools/verify.mjs 只能检查"文件写得对不对"，检查不到"线上到底生效没有"。
  改完 _headers 跑一下这个脚本，才算真验证过。

用法（项目根目录）：
    .venv\\Scripts\\python.exe -B tools\\check-headers.py

两个域名都会测。注意 my-homepage-2hg.pages.dev 必须带浏览器 User-Agent，
否则会被 Cloudflare 挡成 403 / error code: 1010。

⚠️ 为什么 /admin 和 /admin.html 两个路径都测：
  Pages 会把 /admin.html 用 308 规范化成 /admin，_headers 的精确路径规则
  匹配的是规范化后的路径 —— 所以写 `/admin.html` 那种精确规则永远不命中，
  必须用 splat（`/admin*`）。两个路径都测，这种回归才会立刻暴露。
"""
import json
import sys
import urllib.error
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

HOSTS = ["zqe.ccwu.cc", "my-homepage-2hg.pages.dev"]

# (路径, 必须存在的头, 头值里必须包含的片段)
CASES = [
    ("/", ["x-content-type-options", "referrer-policy", "permissions-policy"], {}),
    (
        "/admin",
        ["x-frame-options", "x-robots-tag", "cache-control"],
        {"x-frame-options": "deny", "x-robots-tag": "noindex", "cache-control": "no-store"},
    ),
    ("/admin.html", ["x-frame-options"], {"x-frame-options": "deny"}),
]

failed = 0
checked = 0


def ok(name, cond, extra=""):
    global failed, checked
    checked += 1
    if not cond:
        failed += 1
    print("  %s %s%s" % ("OK  " if cond else "FAIL", name, ("   " + extra) if extra else ""))


def fetch(url):
    """返回 (状态码, 小写头字典, 正文文本)。状态码 None 表示连不上。"""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Cache-Control": "no-cache", "Pragma": "no-cache"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read().decode(
                "utf-8", "replace"
            )
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, ""
    except Exception as e:  # noqa: BLE001
        return None, {}, str(e)


for host in HOSTS:
    print("== %s ==" % host)

    for path, want, must_contain in CASES:
        code, h, _ = fetch("https://%s%s" % (host, path))
        if code is None:
            ok("%s 能连上" % path, False, h.get("__err__", ""))
            continue
        ok("%s 返回 200（实际 %s）" % (path, code), code == 200)
        for name in want:
            got = h.get(name, "")
            if name in must_contain:
                ok(
                    "%s 的 %s 含 %r" % (path, name, must_contain[name]),
                    must_contain[name].lower() in got.lower(),
                    "got=%r" % got,
                )
            else:
                ok("%s 有 %s" % (path, name), bool(got), "got=%r" % got)

    code, _, body = fetch("https://%s/api/health" % host)
    alive = False
    if code == 200:
        try:
            alive = json.loads(body).get("ok") is True
        except Exception:  # noqa: BLE001
            alive = False
    ok("/api/health 仍是 ok:true（没被响应头改动搞坏）", alive, "code=%s" % code)
    print()

print("%d 项检查，%s" % (checked, "全部通过" if failed == 0 else "%d 项失败" % failed))
sys.exit(1 if failed else 0)
