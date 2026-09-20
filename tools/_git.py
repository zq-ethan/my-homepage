"""提交并推送（临时脚本，用完即删）。报告写入 tools/_report_git.txt"""

import os
import pathlib
import subprocess

BASE = pathlib.Path(__file__).resolve().parent.parent
env = dict(os.environ)
env["GIT_TERMINAL_PROMPT"] = "0"

msg = """chore: 补 _routes.json，静态资源不再触发函数调用

- public/_routes.json 限定只有 /api/* 会调用 Pages Functions。
  不加这个文件的话，Pages 默认让所有请求都走函数（官方文档明确说明），
  每次打开页面都会多消耗几次静态请求的免费配额。
- 顺带把 functions/_persona.js 这类内部模块挡在函数路由之外。
- tools/verify.mjs 增加对 _routes.json 的校验。
"""

msg_path = BASE / "tools" / "_report_msg.txt"
msg_path.write_text(msg, encoding="utf-8")

lines = []


def run(args, **kw):
    p = subprocess.run(["git"] + args, cwd=str(BASE), env=env, capture_output=True, **kw)
    return p


lines.append("=== git add -A ===")
p = run(["add", "-A"])
lines.append(f"returncode = {p.returncode}")

p = run(["status", "--short"])
lines.append("")
lines.append("=== 暂存区 ===")
lines.append(p.stdout.decode("utf-8", "replace").strip() or "(空)")

lines.append("")
lines.append("=== commit ===")
p = run(["commit", "-F", "tools/_report_msg.txt"])
lines.append(f"returncode = {p.returncode}")
lines.append(p.stdout.decode("utf-8", "replace").strip())
lines.append(p.stderr.decode("utf-8", "replace").strip())

lines.append("")
lines.append("=== push ===")
p = run(["push", "origin", "main"], timeout=180)
lines.append(f"returncode = {p.returncode}")
lines.append(p.stdout.decode("utf-8", "replace").strip())
lines.append(p.stderr.decode("utf-8", "replace").strip())

lines.append("")
lines.append("=== 远程 main 现在指向 ===")
p = run(["ls-remote", "origin", "refs/heads/main"], timeout=60)
lines.append(p.stdout.decode("utf-8", "replace").strip() or "(查询失败)")

lines.append("")
lines.append("=== 本地最新提交 ===")
p = run(["--no-pager", "log", "-1", "--pretty=oneline"])
lines.append(p.stdout.decode("utf-8", "replace").strip())

msg_path.unlink(missing_ok=True)

(BASE / "tools" / "_report_git.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
