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
    for path in [
        "/",
        "/index.html",
        "/styles.css",
        "/app.js",
        "/messages.js",
        "/admin.html",
        "/api/health",
        "/api/messages",
    ]:
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
        "/messages.db",
        "/functions/api/chat.js",
        "/functions/api/health.js",
        "/functions/api/messages.js",
        "/tools/verify.mjs",
    ]:
        code = client.get(path).status_code
        out.append(f"  {'OK ' if code == 404 else 'BAD'} {path:28} -> {code}")

    # ---------- 留言接口：走一遍真实流程 ----------
    # 测试用临时数据库，别往本机 messages.db 里塞测试数据
    import shutil
    import sqlite3
    import tempfile

    tmpdir = Path(tempfile.mkdtemp())
    server.MSG_DB_PATH = tmpdir / "test_messages.db"
    server.ADMIN_TOKEN = "test-token-123"
    server._message_table_ready = False

    ADMIN = {"X-Admin-Token": "test-token-123"}
    API = "/api/messages"

    def row(label, ok, extra=""):
        out.append(f"  {'OK ' if ok else 'BAD'} {label}{('   ' + str(extra)) if extra else ''}")

    # 绕过"同一 IP 20 秒内只能发一条"，把已有记录的时间往前挪
    def bypass_rate_limit():
        conn = sqlite3.connect(server.MSG_DB_PATH)
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00.000Z'")
        conn.commit()
        conn.close()

    out.append("")
    out.append("-- 留言接口流程 --")

    r = client.get(API)
    row("初始列表为空", r.status_code == 200 and r.json()["messages"] == [], r.json())

    r = client.post(API, json={"content": "   "})
    row("空内容发不出去", r.status_code == 400, r.json())

    r = client.post(API, json={"name": "小明", "content": "你好啊"})
    d = r.json()
    row("公开发言成功", r.status_code == 201 and d["visible"] is True, d)

    r = client.post(API, json={"content": "再发一条"})
    row("20 秒内连发被限流", r.status_code == 429, r.json())

    bypass_rate_limit()

    r = client.post(API, json={"content": "只给你看的悄悄话", "isPrivate": True})
    d = r.json()
    row("悄悄话返回 visible=False", r.status_code == 201 and d["visible"] is False, d)

    r = client.get(API)
    names = [m["name"] for m in r.json()["messages"]]
    contents = [m["content"] for m in r.json()["messages"]]
    row("公开列表只有公开留言", len(contents) == 1 and contents[0] == "你好啊", contents)
    row("公开列表没有悄悄话", "只给你看的悄悄话" not in contents, contents)

    r = client.get(API, params={"all": "1"})
    row("无口令看不到全部", r.status_code == 401, r.status_code)

    r = client.get(API, params={"all": "1"}, headers=ADMIN)
    all_msgs = r.json()["messages"]
    row("带口令能看到悄悄话", r.status_code == 200 and len(all_msgs) == 2, len(all_msgs))
    row("悄悄话带 isPrivate 标记", any(m.get("isPrivate") for m in all_msgs))
    row("管理视角带 IP 哈希前 8 位", all(m.get("ipHash") for m in all_msgs), all_msgs[0].get("ipHash"))

    target = all_msgs[0]["id"]
    r = client.delete(API, params={"id": target})
    row("无口令删不掉", r.status_code == 401, r.status_code)

    r = client.delete(API, params={"id": target}, headers=ADMIN)
    row("带口令能删", r.status_code == 200 and r.json()["deleted"] == 1, r.json())

    r = client.get(API, params={"all": "1"}, headers=ADMIN)
    row("删完确实少一条", len(r.json()["messages"]) == 1, len(r.json()["messages"]))

    # ---------- 聊天接口的防护 ----------
    # 这个接口每次调用都在烧 DeepSeek 余额，之前完全没有限制。
    # 这里用假 key + 打不通的地址，保证测试不会真的去调 DeepSeek 花钱。
    out.append("")
    out.append("-- 聊天接口防护 --")

    CHAT = "/api/chat"
    GOOD = {"Origin": "https://zqe.ccwu.cc"}
    BODY = {"messages": [{"role": "user", "content": "你好"}]}

    server.DEEPSEEK_API_KEY = "test-key-not-real"
    server.DEEPSEEK_BASE_URL = "http://127.0.0.1:1"   # 必然连不上
    server._chat_table_ready = False

    def chat_post(headers=None):
        return client.post(CHAT, json=BODY, headers=headers or {})

    r = chat_post({"Origin": "https://someone-else.example.com"})
    row("别的来源被拦 403", r.status_code == 403 and r.json().get("error") == "forbidden_origin", r.json())

    r = chat_post()   # 不带任何来源头，等价于 curl
    row("不带来源头被拦 403（等价 curl）", r.status_code == 403, r.status_code)

    r = chat_post({"Referer": "https://zqe.ccwu.cc/index.html"})
    row("只有 Referer 时放行（走到上游）", r.status_code == 200, r.status_code)

    r = chat_post(GOOD)
    row("紧接着再问被限流 429", r.status_code == 429 and r.json().get("error") == "chat_too_fast", r.json())

    def set_limit(bucket, count):
        conn = sqlite3.connect(server.MSG_DB_PATH)
        conn.execute(
            "INSERT INTO chat_limits (bucket, day, count, last_at) VALUES (?, ?, ?, 0) "
            "ON CONFLICT(bucket, day) DO UPDATE SET count = excluded.count",
            (bucket, server.chat_day(), count),
        )
        conn.commit()
        conn.close()

    set_limit(server.hash_ip_chat("testclient"), server.CHAT_DAILY_PER_IP)
    r = chat_post(GOOD)
    row("个人日上限触发 429", r.status_code == 429 and r.json().get("error") == "chat_daily_limit", r.json())

    set_limit(server.CHAT_GLOBAL_BUCKET, server.CHAT_DAILY_GLOBAL)
    r = chat_post(GOOD)
    row("全站日上限触发 429", r.status_code == 429 and r.json().get("error") == "chat_global_limit", r.json())

    r = chat_post({"Origin": "https://someone-else.example.com"})
    row("坏来源优先于限流被拦（顺序正确）", r.status_code == 403, r.status_code)

    shutil.rmtree(tmpdir, ignore_errors=True)
    out.append(f"  （临时库已清理：{tmpdir}）")

except Exception:
    out.append("脚本异常：")
    out.append(traceback.format_exc())

out.append("")
out.append(f"（python: {sys.executable}）")

REPORT.write_text("\n".join(out) + "\n", encoding="utf-8")
