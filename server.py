"""
赵泉恩个人主页 · 本地 LLM 代理
- 作用：把前端请求转发到 DeepSeek，API key 留在本机不进前端
- 运行：python server.py  →  http://localhost:5000
"""

import os
import json
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import httpx
from fastapi.middleware.cors import CORSMiddleware

# ---------- 路径 ----------
BASE_DIR = Path(__file__).parent

# ---------- 配置 ----------
load_dotenv()  # 读取 .env 文件
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
PORT = int(os.getenv("PORT", "5000"))

# ---------- 人设：从 persona.md 读取（改人设只动这个文件） ----------
PERSONA_PATH = Path(__file__).parent / "persona.md"

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
    请求体：{ messages: [...], system?: "..." }
    返回：SSE 流，每行 data: {content:"..."} 或 data: [DONE]
    """
    body = await req.json()
    messages = body.get("messages", [])

    if not DEEPSEEK_API_KEY:
        return JSONResponse(
            {"error": "server_missing_key", "message": "服务器未配置 DEEPSEEK_API_KEY，请填 .env"},
            status_code=500,
        )

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


# ---------- 静态文件（前端） ----------
# 把当前目录挂载到根路径，前端 / 时直接返回 index.html
app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    print(f"启动：http://localhost:{PORT}")
    print(f"模型：{DEEPSEEK_MODEL}  Key 已配置：{bool(DEEPSEEK_API_KEY)}")
    if not DEEPSEEK_API_KEY:
        print("⚠️  还没填 DEEPSEEK_API_KEY，请复制 .env.example 为 .env 后填入 key")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
