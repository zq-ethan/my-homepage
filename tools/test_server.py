"""本地回归测试（仅开发时用）：确认 server.py 改动后功能正常、敏感文件仍被拦截。
用法：.venv\\Scripts\\python.exe -B tools\\test_server.py
结果写入 tools/_report_server.txt
"""

import sys
import traceback
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
REPORT = Path(__file__).with_name("_report_server.txt")

out = []

try:
    sys.path.insert(0, str(BASE))

    from fastapi.testclient import TestClient

    import server

    out.append("== server.py 本地回归 ==")
    out.append(f"PUBLIC_DIR = {server.PUBLIC_DIR}")
    out.append(f"PUBLIC_DIR 存在 = {server.PUBLIC_DIR.exists()}")

    client = TestClient(server.app)

    out.append("")
    out.append("-- 前端资源与接口，应 200 --")
    for path in ["/", "/index.html", "/styles.css", "/app.js", "/api/health"]:
        code = client.get(path).status_code
        out.append(f"  {'OK ' if code == 200 else 'BAD'} {path:16} -> {code}")

    out.append("")
    out.append("-- 敏感文件与函数源码，应 404 --")
    for path in [
        "/.env",
        "/.env.example",
        "/persona.md",
        "/server.py",
        "/requirements.txt",
        "/.gitignore",
        "/functions/api/chat.js",
        "/functions/api/health.js",
        "/tools/verify.mjs",
    ]:
        code = client.get(path).status_code
        out.append(f"  {'OK ' if code == 404 else 'BAD'} {path:28} -> {code}")

except Exception:
    out.append("脚本异常：")
    out.append(traceback.format_exc())

out.append("")
out.append(f"（python: {sys.executable}）")

REPORT.write_text("\n".join(out) + "\n", encoding="utf-8")
