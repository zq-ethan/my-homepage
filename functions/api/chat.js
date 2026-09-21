/**
 * POST /api/chat —— 转发到 DeepSeek，流式返回
 *
 * 这是 server.py 的云端版本。Cloudflare Workers 只能跑 JavaScript，
 * 所以那段 Python 转发逻辑被重写成 JS，对外行为保持一致：
 *   请求体：{ messages: [{ role, content }, ...] }
 *   响应  ：SSE 流，每条 data: {"content":"增量文字"}，结尾 data: [DONE]
 *
 * 两个不能改的设计：
 *   1. API key 只从 env.DEEPSEEK_API_KEY 读（在 Cloudflare 后台配置、加密存储）。
 *      绝不写进代码，也绝不发给浏览器 —— 这是当初做代理层的唯一目的。
 *   2. 用 TransformStream 边收边发。如果改成"收完一整段再返回"，
 *      页面上那个逐字打字的流式效果就没了。
 */

import { PERSONA } from "../_persona.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const MAX_TURNS = 20;   // 最多带 20 条消息（≈10 轮问答），和前端 app.js 的 MAX_HISTORY 对齐
const MAX_CHARS = 2000; // 单条消息最大长度，防有人塞超长内容烧 token

export async function onRequestPost({ request, env }) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: "server_missing_key", message: "服务器未配置 DEEPSEEK_API_KEY" },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "bad_request", message: "请求体不是合法 JSON" }, 400);
  }

  // 只挑 role / content 两个字段，丢掉任何多余的东西
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m) =>
        m &&
        typeof m.content === "string" &&
        (m.role === "user" || m.role === "assistant")
    )
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (history.length === 0) {
    return jsonResponse({ error: "bad_request", message: "messages 为空" }, 400);
  }

  const baseUrl = env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
  const model = env.DEEPSEEK_MODEL || DEFAULT_MODEL;

  // 人设永远排在第一条，前端传不进来也覆盖不掉
  const messages = [{ role: "system", content: PERSONA }, ...history];

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, stream: true, temperature: 1 }),
    });
  } catch (err) {
    return sseResponse([
      { error: "network", message: String((err && err.message) || err) },
    ]);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return sseResponse([
      { error: "upstream_" + upstream.status, message: detail.slice(0, 300) },
    ]);
  }

  // 边收、边转、边发
  const stream = upstream.body.pipeThrough(makeSseTransformer());

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform 很关键：不加的话中间层可能缓冲整个响应，流式就退化成一次性吐全文
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

/**
 * 把 DeepSeek 的 SSE 转成前端 app.js 期待的格式。
 *   DeepSeek 原始：data: {"choices":[{"delta":{"content":"你"}}]}
 *   前端期待    ：data: {"content":"你"}
 *
 * 之所以导出它，是为了能用 tools/test-sse.mjs 在本地单独测这段转换。
 * Pages 只认 onRequest* 开头的导出，多导一个不会变成路由。
 */
export function makeSseTransformer() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";      // 跨 chunk 的半行残留（一个事件可能被切成两块）
  let sentDone = false; // 避免重复发 [DONE]

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          if (!sentDone) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            sentDone = true;
          }
          continue;
        }

        let piece;
        try {
          piece = JSON.parse(payload).choices?.[0]?.delta?.content;
        } catch (err) {
          continue; // 半个 JSON 或非预期格式，丢掉这一条
        }

        if (piece) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ content: piece })}\n\n`)
          );
        }
      }
    },

    flush(controller) {
      // 万一上游没发 [DONE] 就断了，这里补一个，保证前端不会永远转圈
      if (!sentDone) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

/** 普通 JSON 响应（出错时用） */
function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** 把几条错误事件包成一次性 SSE，格式和正常流一致，前端不用特殊处理 */
function sseResponse(events) {
  const text =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
    "data: [DONE]\n\n";

  return new Response(text, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
