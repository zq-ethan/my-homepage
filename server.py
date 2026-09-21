"""
赵泉恩个人主页 · 本地 LLM 代理
- 作用：把前端请求转发到 DeepSeek，API key 留在本机不进前端
- 运行：python server.py  →  http://localhost:5000
"""

import os
import hmac
import json
import math
import time
import hashlib
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
import httpx
from fastapi.middleware.cors import CORSMiddleware

# ---------- 路径 ----------
BASE_DIR = Path(__file__).parent
# 前端静态文件都放在 public/，这个目录同时也是 Cloudflare Pages 的部署输出目录。
# 根目录刻意不放前端文件：Pages 会把输出目录整个传到公网，
# 前端若留在根目录，persona.md / server.py / .env 会被一起传上去。
PUBLIC_DIR = BASE_DIR / "public"

# ---------- 配置 ----------
load_dotenv()  # 读取 .env 文件
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
PORT = int(os.getenv("PORT", "5000"))

# ---------- 对话上下文与花费上限 ----------
# 和 functions/api/chat.js 的 MAX_TURNS / MAX_CHARS / MAX_TOKENS 必须一致，
# 否则线上线下表现不同。
# 20 条 ≈ 10 轮问答：访客一般问 3~8 个问题就走，10 轮足够覆盖；
# 更长除了让模型更"记得住"，边际收益递减，而输入 token 成本会线性上涨。
MAX_CHAT_TURNS = 20      # 最多带多少条消息
MAX_CHAT_CHARS = 800     # 单条消息最大长度（前端输入框只给 500，留点余量）
MAX_CHAT_TOKENS = 1000   # 单次回答的输出上限，把"一次请求最多花多少钱"钉死

# ---------- 聊天接口防刷（和 chat.js 保持一致） ----------
# 这个接口每次调用都在烧 DeepSeek 余额。之前完全没有防护，谁都能循环刷。
CHAT_MIN_INTERVAL_SECONDS = 3   # 同一个人两次提问的最小间隔
CHAT_DAILY_PER_IP = 60          # 同一个人 24 小时内最多问几次
CHAT_DAILY_GLOBAL = 300         # 全站每日总次数上限（最后一道保险）

# 允许调用 /api/chat 的来源（完整的 scheme + host，不带结尾斜杠）。
# 浏览器发起同源 POST 一定会带 Origin 头，正常访客不受影响；
# 命令行脚本默认不带 → 被挡掉。换域名时用环境变量 ALLOWED_ORIGINS 覆盖即可，不用改代码。
DEFAULT_ALLOWED_ORIGINS = {
    "https://zqe.ccwu.cc",
    "https://my-homepage-2hg.pages.dev",
}
_configured_origins = {
    s.strip().rstrip("/").lower()
    for s in (os.getenv("ALLOWED_ORIGINS") or "").split(",")
    if s.strip()
}
ALLOWED_ORIGINS = _configured_origins or DEFAULT_ALLOWED_ORIGINS

# ---------- 留言板配置 ----------
# 线上这些变量在 Cloudflare 后台配（ADMIN_TOKEN 类型选 Secret）。
# 本地开着方便调试：ADMIN_TOKEN 不填 = 管理接口关闭（不能变成谁都能删留言）。
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
TURNSTILE_SITE_KEY = os.getenv("TURNSTILE_SITE_KEY", "")
TURNSTILE_SECRET_KEY = os.getenv("TURNSTILE_SECRET_KEY", "")
MSG_DB_PATH = BASE_DIR / "messages.db"

# ---------- 人设：从 persona.md 读取（改人设只动这个文件） ----------
PERSONA_PATH = BASE_DIR / "persona.md"

def load_persona() -> str:
    """从 persona.md 读取人设，如果文件不存在返回兜底值"""
    if PERSONA_PATH.exists():
        return PERSONA_PATH.read_text(encoding="utf-8").strip()
    # 兜底（ persona.md 还没创建时用）
    return """你是赵泉恩的数字分身，代表他回答访客的提问。用第一人称我说话。

【关于他】
- 名字：赵泉恩，2028 届计算机科学与技术
- 最近在做：学开发（vibecoding），做图库管理 App
- 方向：AI 全栈（Python + Vue3）
- 兴趣：摄影、游戏、美食
- 记忆点：帅到你了
- 目标：练开发，出作品，技能变现

【说话习惯】
- 随性聊天，不端着，想哪说哪
- 口癖：偶尔中二，偶尔很欠，爱说搞笑吧，怎么可能
- 被问不知道的：自嘲一下，不硬编
- 冷幽默为主，别刻意搞笑

【硬规则】
- 只依据上面的信息回答，没提到的事直说我还没研究过
- 联系方式/隐私：这个还没公开
- 升学/考研/保研：这个还没定，先把手上的东西做出来
- 控制在 120 字以内，不要 Markdown 标题和列表"""

SYSTEM_PROMPT = load_persona()

app = FastAPI(title="homepage-llm-proxy")

# 允许本地前端跨域调用
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 本地开发用，公开部署时收紧
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- 路由 ----------
@app.get("/api/health")
def health():
    """前端用来探活和检查 key 是否配置"""
    return {
        "ok": True,
        "model": DEEPSEEK_MODEL,
        "hasKey": bool(DEEPSEEK_API_KEY),
    }


@app.post("/api/chat")
async def chat(req: Request):
    """
    请求体：{ messages: [{ role, content }, ...] }
    返回：SSE 流，每行 data: {content:"..."} 或 data: [DONE]

    和 functions/api/chat.js 是同一套逻辑的两份实现，限制值必须一致。
    """
    # 第 0 关：来源白名单。最便宜，放最前面。
    if not is_allowed_origin(req):
        return JSONResponse(
            {"error": "forbidden_origin", "message": "这个来源不被允许调用"},
            status_code=403,
        )

    if not DEEPSEEK_API_KEY:
        return JSONResponse(
            {"error": "server_missing_key", "message": "服务器未配置 DEEPSEEK_API_KEY，请填 .env"},
            status_code=500,
        )

    try:
        body = await req.json()
    except Exception:
        return JSONResponse(
            {"error": "bad_request", "message": "请求体不是合法 JSON"}, status_code=400
        )

    raw = body.get("messages")

    # 只挑 role / content 两个字段，丢掉任何多余的东西。
    # role 只放行 user / assistant —— 否则访客可以塞一条 role="system" 的内容，
    # 在人设前面插话，等于把人设覆盖掉（线上 chat.js 一直有这个过滤，这里补齐）。
    cleaned = [
        {"role": m["role"], "content": m["content"][:MAX_CHAT_CHARS]}
        for m in (raw if isinstance(raw, list) else [])
        if isinstance(m, dict)
        and m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
    ]
    messages = cleaned[-MAX_CHAT_TURNS:]

    if not messages:
        return JSONResponse(
            {"error": "bad_request", "message": "messages 为空"}, status_code=400
        )

    # 第 1 关：限流。
    # 放在参数校验之后：无效请求本来就不会去调 DeepSeek（不花钱），不该扣额度，
    # 否则访客手滑发一条空消息就要白等 3 秒。要保护的只有下面那次上游调用。
    limit_conn = message_db()
    try:
        allowed, limit_code, limit_msg = check_chat_limit(
            limit_conn, hash_ip_chat(client_ip(req))
        )
    finally:
        limit_conn.close()

    if not allowed:
        return JSONResponse(
            {"error": limit_code, "message": limit_msg}, status_code=429
        )

    # 人设永远排在第一条，前端传不进来也覆盖不掉
    full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    async def stream_to_client():
        async with httpx.AsyncClient(timeout=60.0) as client:
            try:
                async with client.stream(
                    "POST",
                    f"{DEEPSEEK_BASE_URL}/v1/chat/completions",
                    json={
                        "model": DEEPSEEK_MODEL,
                        "messages": full_messages,
                        "stream": True,
                        "temperature": 1,
                        # 输出上限：不设的话单次成本不可控
                        "max_tokens": MAX_CHAT_TOKENS,
                    },
                    headers={
                        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                        "Content-Type": "application/json",
                    },
                ) as resp:
                    if resp.status_code != 200:
                        err_text = await resp.aread()
                        yield f"data: {json.dumps({'error': 'upstream_' + str(resp.status_code), 'message': err_text.decode(errors='replace')})}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            yield "data: [DONE]\n\n"
                            return
                        try:
                            obj = json.loads(payload)
                            delta = obj.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content")
                            if content:
                                yield f"data: {json.dumps({'content': content})}\n\n"
                        except Exception:
                            continue
            except httpx.RequestError as e:
                yield f"data: {json.dumps({'error': 'network', 'message': str(e)})}\n\n"
                yield "data: [DONE]\n\n"

    return StreamingResponse(stream_to_client(), media_type="text/event-stream")


# ============================================================
# 留言板（本地版）
#
# 线上对应 functions/api/messages.js —— 同一套逻辑的两份实现，行为必须一致：
#   GET    /api/messages           → { ok, messages:[...], turnstileSiteKey }
#   GET    /api/messages?all=1     → 要管理口令，返回含悄悄话的全部
#   POST   /api/messages           → { ok, message, visible }
#   DELETE /api/messages?id=N      → 要管理口令
#
# 本地用 Python 内置的 sqlite3，线上用 Cloudflare D1（也是 SQLite），
# SQL 基本可以直接照搬，这是当初选 D1 而不是 KV 的原因之一。
# ============================================================

MAX_NAME = 20           # 昵称最长字符数
MAX_CONTENT = 500       # 正文最长字符数
RATE_WINDOW_SECONDS = 20   # 同一个人两次留言的最小间隔（20 秒）
RATE_DAILY_LIMIT = 10   # 24 小时内最多发几条
PUBLIC_PAGE_SIZE = 10   # 公开列表每页几条（前端带 ?page=N 翻页）
ADMIN_PAGE_SIZE = 500   # 管理页一次返回几条（不分页，一次给全）

# 建表语句：和 functions/api/messages.js 里的 ensureTable 保持一致
CREATE_MESSAGES_SQL = """
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  ip_hash    TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_public ON messages(is_private, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ip     ON messages(ip_hash, created_at);
"""

# 建表只做一次。SQLite 的 CREATE TABLE IF NOT EXISTS 本身幂等，但每次请求都跑一遍没必要。
_message_table_ready = False

# 聊天限流的计数表。和 messages 放同一个库里 —— 本地就一个 sqlite 文件，没必要拆。
# 字段含义：bucket = 谁（IP 哈希，或 __global__ 这个虚拟桶），
#          day = 哪一天（UTC），count = 当天次数，last_at = 最后一次的毫秒时间戳。
CREATE_CHAT_LIMITS_SQL = """
CREATE TABLE IF NOT EXISTS chat_limits (
  bucket  TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, day)
);
"""
CHAT_GLOBAL_BUCKET = "__global__"
_chat_table_ready = False


def message_db() -> sqlite3.Connection:
    """每次请求新开一个连接。

    原因：FastAPI 的同步路由跑在线程池里，而 sqlite3 连接默认不能跨线程复用
    （会报 "SQLite objects created in a thread can only be used in that same thread"）。
    本地开发这点开销可以忽略，换来的是不用操心连接池和线程问题。
    """
    conn = sqlite3.connect(MSG_DB_PATH)
    conn.row_factory = sqlite3.Row  # 让查询结果能按列名取值：row["name"]
    return conn


def ensure_message_table(conn: sqlite3.Connection) -> None:
    """懒建表 —— 你不需要手动跑任何 SQL，第一次访问留言接口时自动建好。"""
    global _message_table_ready
    if _message_table_ready:
        return
    conn.executescript(CREATE_MESSAGES_SQL)
    conn.commit()
    _message_table_ready = True


def now_iso() -> str:
    """和 JS 的 new Date().toISOString() 同格式：2026-09-21T09:43:46.123Z

    为什么非要跟 JS 对齐：前端是 new Date(createdAt) 来解析的，
    两边格式不一致就会出现"刚发的留言显示 8 小时前"这种时区错乱。
    """
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def hash_ip(ip: str) -> str:
    """IP → 哈希。限流只需要"认出同一个人"，不需要知道他是谁，所以不存明文。"""
    return hashlib.sha256(("zqe-msg-salt::" + ip).encode("utf-8")).hexdigest()


def client_ip(request: Request) -> str:
    """访客真实 IP。线上 Cloudflare 会填 CF-Connecting-IP；本地取 TCP 对端地址。"""
    return (
        request.headers.get("cf-connecting-ip")
        or (request.client.host if request.client else "")
        or "unknown"
    )


def hash_ip_chat(ip: str) -> str:
    """聊天限流用的 IP 哈希。

    盐和留言板那份刻意不同：聊天记录和留言记录本来没必要能互相关联起来。
    """
    return hashlib.sha256(("zqe-chat-salt::" + ip).encode("utf-8")).hexdigest()


def is_allowed_origin(request: Request) -> bool:
    """请求来源是否可信 —— 和 chat.js 的 isAllowedOrigin 同一套规则。

    浏览器发起同源 POST 一定会带 Origin 头，命令行脚本默认不带。
    Origin 缺失时退回看 Referer（少数浏览器 / 隐私插件会省掉前者）；
    两者都没有就拒绝。本地开发放行 localhost / 127.0.0.1，端口随意。
    """
    candidates = []

    origin = (request.headers.get("origin") or "").strip()
    if origin:
        candidates.append(origin)

    referer = (request.headers.get("referer") or "").strip()
    if referer:
        parsed = urlparse(referer)
        if parsed.scheme and parsed.netloc:
            candidates.append(f"{parsed.scheme}://{parsed.netloc}")

    for cand in candidates:
        if cand.rstrip("/").lower() in ALLOWED_ORIGINS:
            return True
        if (urlparse(cand).hostname or "") in ("localhost", "127.0.0.1"):
            return True

    return False


def chat_day() -> str:
    """限流口径里的"今天"。

    按 UTC 切分，和 chat.js 的 new Date().toISOString().slice(0, 10) 对齐 ——
    两边日期口径不一致的话，跨零点前后会出现"线上说超了、本地说没超"。
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def ensure_chat_table(conn: sqlite3.Connection) -> None:
    """懒建表，和留言表一个套路。"""
    global _chat_table_ready
    if _chat_table_ready:
        return
    conn.executescript(CREATE_CHAT_LIMITS_SQL)
    conn.commit()
    _chat_table_ready = True


def check_chat_limit(conn: sqlite3.Connection, ip_hash: str) -> tuple:
    """聊天限流。返回 (是否放行, 错误码, 提示文案)。

    顺序：全站日上限 → 个人日上限 → 最小间隔。三条都过了才计数。

    这里不做内存兜底（chat.js 那边有）：本地只有一个进程，
    sqlite 出问题就是真出问题了，把它报出来比悄悄放行要好。
    """
    ensure_chat_table(conn)

    now_ms = int(time.time() * 1000)
    day = chat_day()

    rows = conn.execute(
        "SELECT bucket, count, last_at FROM chat_limits WHERE day = ? AND bucket IN (?, ?)",
        (day, CHAT_GLOBAL_BUCKET, ip_hash),
    ).fetchall()

    global_count = 0
    ip_count = 0
    ip_last_at = 0
    for r in rows:
        if r["bucket"] == CHAT_GLOBAL_BUCKET:
            global_count = r["count"]
        else:
            ip_count = r["count"]
            ip_last_at = r["last_at"]

    if global_count >= CHAT_DAILY_GLOBAL:
        return False, "chat_global_limit", "今天来问的人有点多，明天再来吧"

    if ip_count >= CHAT_DAILY_PER_IP:
        return False, "chat_daily_limit", "今天问得有点多了，明天再来吧"

    wait_ms = CHAT_MIN_INTERVAL_SECONDS * 1000 - (now_ms - ip_last_at)
    if ip_last_at > 0 and wait_ms > 0:
        return False, "chat_too_fast", f"问得太快了，等 {math.ceil(wait_ms / 1000)} 秒再问"

    # 两条一起写。UPSERT：没有这行就插入 count=1，有就把 count 加一。
    for bucket in (CHAT_GLOBAL_BUCKET, ip_hash):
        conn.execute(
            """INSERT INTO chat_limits (bucket, day, count, last_at)
               VALUES (?, ?, 1, ?)
               ON CONFLICT(bucket, day) DO UPDATE
                 SET count = count + 1, last_at = excluded.last_at""",
            (bucket, day, now_ms),
        )
    conn.commit()

    return True, "", ""


def is_admin(request: Request) -> bool:
    """管理口令校验。没配 ADMIN_TOKEN 一律拒绝 —— 不能因为"忘了配"就变成谁都能删。"""
    if not ADMIN_TOKEN:
        return False
    given = request.headers.get("x-admin-token", "")
    # 定长比较，别让"第几位比对失败"泄漏出口令信息
    return hmac.compare_digest(given, ADMIN_TOKEN)


def sanitize_name(raw) -> str:
    """昵称：压空白、砍长度，空的就叫匿名"""
    if not isinstance(raw, str):
        return "匿名"
    s = " ".join(raw.split())
    return s[:MAX_NAME] if s else "匿名"


def sanitize_content(raw) -> str:
    """正文：去首尾空白、砍长度"""
    if not isinstance(raw, str):
        return ""
    return raw.strip()[:MAX_CONTENT]


def row_to_message(row: sqlite3.Row) -> dict:
    """数据库行 → 前端认识的字段名（snake_case → camelCase）"""
    m = {
        "id": row["id"],
        "name": row["name"],
        "content": row["content"],
        "createdAt": row["created_at"],
    }
    # 这两列只有管理视角的查询才会查出来
    if "is_private" in row.keys():
        m["isPrivate"] = bool(row["is_private"])
    if "ip_hash" in row.keys() and row["ip_hash"]:
        m["ipHash"] = row["ip_hash"][:8]
    return m


def check_rate_limit(conn: sqlite3.Connection, ip_hash: str) -> tuple:
    """两层限制：20 秒内不能发第二条，24 小时内最多 10 条。

    直接用 ISO 时间字符串比大小 —— ISO 8601 的字典序就是时间序，不用存时间戳。
    """
    now = datetime.now(timezone.utc)

    def iso(delta: timedelta) -> str:
        return (
            (now - delta).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )

    recent = conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created_at > ?",
        (ip_hash, iso(timedelta(seconds=RATE_WINDOW_SECONDS))),
    ).fetchone()["n"]
    if recent > 0:
        return False, "刚发过了，等 20 秒再发第二条"

    daily = conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created_at > ?",
        (ip_hash, iso(timedelta(hours=24))),
    ).fetchone()["n"]
    if daily >= RATE_DAILY_LIMIT:
        return False, "今天留的言有点多了，明天再来吧"

    return True, ""


async def verify_turnstile(secret: str, token, ip: str) -> bool:
    """调 Cloudflare Turnstile 校验接口。

    secret 是服务端密钥（只在 .env / Cloudflare 后台配，绝不进前端），
    token 是前端挂件塞进表单的那串一次性凭证。
    """
    if not token or not isinstance(token, str):
        return False
    data = {"secret": secret, "response": token}
    if ip and ip != "unknown":
        data["remoteip"] = ip
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify", data=data
            )
            return bool(resp.json().get("success"))
    except Exception:
        # 校验服务本身挂了 —— 宁可不让人发，也不能放机器人进来
        return False


def parse_page(raw, total_pages: int) -> int:
    """把 URL 上的 ?page= 解析成一个合法页码。

    为什么把越界的页码"夹回来"而不是报错：访客可能收藏了第 5 页的链接，
    等留言被删到只剩 2 页时，点进去应该看到第 2 页，而不是空白页或者 400。

    functions/api/messages.js 里的 parsePage() 是同一套规则，改这里要同步改那边。
    """
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        n = 1
    if n < 1:
        n = 1
    if n > total_pages:
        n = total_pages
    return n


def msg_json(obj: dict, status: int = 200) -> JSONResponse:
    """留言接口统一出口：加 no-store，否则发完刷新看不到自己那条"""
    return JSONResponse(obj, status_code=status, headers={"Cache-Control": "no-store"})


@app.get("/api/messages")
def list_messages(request: Request):
    """访客拿公开列表（带 ?page=N 翻页）；带 ?all=1 且口令正确拿全部（含悄悄话）"""
    conn = message_db()
    try:
        ensure_message_table(conn)

        if request.query_params.get("all") == "1":
            if not is_admin(request):
                return msg_json(
                    {"ok": False, "error": "unauthorized", "message": "管理口令不对"}, 401
                )
            rows = conn.execute(
                """SELECT id, name, content, is_private, ip_hash, created_at
                     FROM messages ORDER BY id DESC LIMIT ?""",
                (ADMIN_PAGE_SIZE,),
            ).fetchall()
            return msg_json({"ok": True, "messages": [row_to_message(r) for r in rows]})

        page_size = PUBLIC_PAGE_SIZE

        # 先数总条数。分页必须知道总数，才能算总页数、也才能把越界的页码夹回来
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM messages WHERE is_private = 0"
        ).fetchone()["n"]
        total_pages = max(1, -(-total // page_size))  # 向上取整，不用引入 math

        page = parse_page(request.query_params.get("page"), total_pages)

        rows = conn.execute(
            """SELECT id, name, content, created_at
                 FROM messages WHERE is_private = 0
                ORDER BY id DESC LIMIT ? OFFSET ?""",
            (page_size, (page - 1) * page_size),
        ).fetchall()
        return msg_json(
            {
                "ok": True,
                "messages": [row_to_message(r) for r in rows],
                # 分页元信息。字段名和 functions/api/messages.js 保持一致
                "page": page,
                "pageSize": page_size,
                "total": total,
                "totalPages": total_pages,
                "hasPrev": page > 1,
                "hasNext": page < total_pages,
                # 前端拿这个决定要不要渲染人机验证挂件；没配就不渲染，表单照样能用
                "turnstileSiteKey": TURNSTILE_SITE_KEY,
                "turnstileRequired": bool(TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY),
            }
        )
    finally:
        conn.close()


@app.post("/api/messages")
async def create_message(request: Request):
    """发一条留言。顺序：人机验证 → 频率限制 → 落库。"""
    try:
        body = await request.json()
    except Exception:
        return msg_json(
            {"ok": False, "error": "bad_request", "message": "请求体不是合法 JSON"}, 400
        )

    name = sanitize_name(body.get("name"))
    content = sanitize_content(body.get("content"))
    if not content:
        return msg_json(
            {"ok": False, "error": "empty_content", "message": "内容不能为空"}, 400
        )

    ip = client_ip(request)
    ip_hash = hash_ip(ip)

    # 第 1 关：人机验证（配了才校验）
    if TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY:
        if not await verify_turnstile(
            TURNSTILE_SECRET_KEY, body.get("turnstileToken"), ip
        ):
            return msg_json(
                {
                    "ok": False,
                    "error": "turnstile_failed",
                    "message": "人机验证没通过，刷新页面再试一次",
                },
                403,
            )

    conn = message_db()
    try:
        ensure_message_table(conn)

        # 第 2 关：频率限制
        passed, reason = check_rate_limit(conn, ip_hash)
        if not passed:
            return msg_json({"ok": False, "error": "rate_limited", "message": reason}, 429)

        is_private = 1 if body.get("isPrivate") else 0
        created_at = now_iso()
        cur = conn.execute(
            """INSERT INTO messages (name, content, is_private, ip_hash, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (name, content, is_private, ip_hash, created_at),
        )
        conn.commit()

        return msg_json(
            {
                "ok": True,
                "message": {
                    "id": cur.lastrowid,
                    "name": name,
                    "content": content,
                    "createdAt": created_at,
                    "isPrivate": bool(is_private),
                },
                # 悄悄话不进公开列表，前端提交成功后不该把它插到列表里
                "visible": is_private == 0,
            },
            201,
        )
    finally:
        conn.close()


@app.delete("/api/messages")
def delete_message(request: Request):
    """删一条留言（要管理口令）"""
    if not is_admin(request):
        return msg_json(
            {"ok": False, "error": "unauthorized", "message": "管理口令不对"}, 401
        )

    try:
        msg_id = int(request.query_params.get("id", ""))
    except ValueError:
        msg_id = 0
    if msg_id <= 0:
        return msg_json({"ok": False, "error": "bad_request", "message": "id 不合法"}, 400)

    conn = message_db()
    try:
        ensure_message_table(conn)
        cur = conn.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
        conn.commit()
        return msg_json({"ok": True, "deleted": cur.rowcount})
    finally:
        conn.close()


# ---------- 静态文件（前端） ----------
# 只放行前端真正需要的文件（白名单），且只从 public/ 目录取。
# 不要改回 app.mount("/", StaticFiles(directory=BASE_DIR))：那样会把 .env（含 API key）、
# server.py、persona.md、.git/ 一并暴露给浏览器，任何人都能直接下载。
# 以后新增前端资源（比如把文字头像换成图片），记得把文件名补进 FRONTEND_FILES。
FRONTEND_FILES = {
    "index.html",
    "styles.css",
    "app.js",
    "messages.js",
    "theme.js",
    "admin.html",
    "avatar.jpg",
    "og-cover.jpg",
    "favicon.svg",
    "apple-touch-icon.png",
}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(PUBLIC_DIR / "index.html")


@app.get("/{filename}", include_in_schema=False)
def frontend_asset(filename: str):
    if filename not in FRONTEND_FILES:
        return JSONResponse(
            {"error": "not_found", "message": f"/{filename} 不存在"}, status_code=404
        )
    return FileResponse(PUBLIC_DIR / filename)


if __name__ == "__main__":
    import uvicorn
    print(f"启动：http://localhost:{PORT}")
    print(f"模型：{DEEPSEEK_MODEL}  Key 已配置：{bool(DEEPSEEK_API_KEY)}")
    if not DEEPSEEK_API_KEY:
        print("⚠️  还没填 DEEPSEEK_API_KEY，请复制 .env.example 为 .env 后填入 key")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
