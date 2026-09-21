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
 *
 * 钱的问题（2026-09-21 补）：
 *   这个接口每次调用都在烧 API key 的余额，之前**完全没有防护**，
 *   谁都能 curl 循环刷。现在三层拦住，代价从"无上限"变成"每天最多几块钱"：
 *     第一层 Origin 白名单  —— 浏览器正常调用会带 Origin 头，命令行脚本默认不带。
 *                              挡不住铁了心伪造头的人，但能挡掉随手一想就来刷的。
 *     第二层 IP 限流        —— 同一个人 3 秒 1 次、一天 60 次。计数存在 D1 里。
 *     第三层 全站日上限     —— 一天总共 300 次，最后一道保险，防分布式刷。
 *   另外把 max_tokens 也钉死，让"单次请求最多花多少钱"变成常量而不是未知数。
 */

import { PERSONA } from "../_persona.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

/* ---------- 上下文与花费上限 ---------- */
const MAX_TURNS = 20;   // 最多带 20 条消息（≈10 轮问答），和前端 app.js 的 MAX_HISTORY 对齐
/* 单条消息最大长度。前端输入框只给 500 字，这里留 800 的余量足够了。
   之前是 2000 —— 20 条 × 2000 字 ≈ 上万 token 的输入，一次请求就能烧掉几分钱。 */
const MAX_CHARS = 800;
/* 单次回答的输出上限。不加的话模型可能洋洋洒洒几千字，
   而输出 token 比输入贵 4 倍，这才是"单次请求成本"里最容易失控的那部分。 */
const MAX_TOKENS = 1000;

/* ---------- 限流参数 ---------- */
const CHAT_MIN_INTERVAL_MS = 3000;  // 同一个人两次提问的最小间隔
const CHAT_DAILY_PER_IP = 60;       // 同一个人 24 小时内最多问几次
const CHAT_DAILY_GLOBAL = 300;      // 全站每日总次数上限（最后一道保险）

/* 全站计数在库里的"虚拟 bucket"名，和真实 IP 哈希不会撞（哈希是 64 位十六进制） */
const GLOBAL_BUCKET = "__global__";

/* 默认放行的来源（完整的 scheme + host，不带结尾斜杠）。
   浏览器同源 POST 一定会带 Origin 头，所以正常访客不受影响。
   换域名时：优先用环境变量 ALLOWED_ORIGINS 覆盖（逗号分隔），就不用改代码。 */
const DEFAULT_ALLOWED_ORIGINS = [
  "https://zqe.ccwu.cc",
  "https://my-homepage-2hg.pages.dev",
];

export async function onRequestPost({ request, env }) {
  /* --- 第 0 关：来源白名单。最便宜，放最前面，先挡掉脚本 --- */
  if (!isAllowedOrigin(request, env)) {
    return jsonResponse(
      { error: "forbidden_origin", message: "这个来源不被允许调用" },
      403
    );
  }

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

  /* --- 第 1 关：限流。
     放在参数校验之后：无效请求本来就不会去调 DeepSeek（不花钱），
     不该扣额度 —— 否则访客手滑发一条空消息就要白等 3 秒。
     真正要保护的只有下面那次上游调用，把它前面卡住就够了。 --- */
  const ipHash = await hashIp(clientIp(request));
  const limit = await checkChatLimit(env, ipHash);
  if (!limit.ok) {
    return jsonResponse({ error: limit.error, message: limit.message }, 429);
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
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 1,
        // 输出上限：不设的话单次成本不可控
        max_tokens: MAX_TOKENS,
      }),
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

/* ============================================================
   防护：来源白名单 + 限流
   —— 都在本文件里自己实现，不从 messages.js 里 import 同名的 clientIp / hashIp。
      原因：两处用的盐不同、表也不同。共用会让两套哈希变得可以互相关联，
      而"聊天"和"留言"本来没必要知道对方是谁。
   ============================================================ */

/** 环境变量 ALLOWED_ORIGINS（逗号分隔）优先；没配就用默认的两个域名。 */
function allowedOrigins(env) {
  const raw = env && env.ALLOWED_ORIGINS;
  const list = raw ? String(raw).split(",") : DEFAULT_ALLOWED_ORIGINS;

  const set = new Set();
  for (const item of list) {
    const s = String(item).trim().replace(/\/+$/, "");
    if (s) set.add(s.toLowerCase());
  }
  return set;
}

/** 本地开发放行：localhost / 127.0.0.1，端口随意 */
function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch (err) {
    return false;
  }
}

/**
 * 来源是否可信。
 * 浏览器发起同源 POST 一定会带 Origin；命令行脚本默认不带。
 * Origin 缺失时退回看 Referer —— 少数浏览器 / 隐私插件会省掉前者。
 * 两者都没有：拒绝。
 */
export function isAllowedOrigin(request, env) {
  const allow = allowedOrigins(env);

  const origin = (request.headers.get("Origin") || "").trim();
  if (origin) {
    return (
      allow.has(origin.replace(/\/+$/, "").toLowerCase()) || isLocalOrigin(origin)
    );
  }

  const referer = (request.headers.get("Referer") || "").trim();
  if (referer) {
    try {
      const o = new URL(referer).origin;
      return allow.has(o.toLowerCase()) || isLocalOrigin(o);
    } catch (err) {
      return false;
    }
  }

  return false;
}

/** 访客真实 IP。Cloudflare 会填 CF-Connecting-IP，本地测试时没有就记 unknown。 */
export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

/** IP → 哈希。只存哈希不存明文；盐和留言板那份刻意不同（见本节开头）。 */
export async function hashIp(ip) {
  const data = new TextEncoder().encode("zqe-chat-salt::" + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* 计数表建一次就跳过。Workers 的 isolate 会复用这个模块级变量。 */
let chatTableReady = false;

const SELECT_LIMIT_SQL = `SELECT bucket, count, last_at
   FROM chat_limits WHERE day = ? AND bucket IN (?, ?)`;

/* UPSERT：没有这行就插入 count=1，有就把 count 加一。
   DO UPDATE 里的 count 指"已有那行的值"（新值要用 excluded. 前缀）。 */
const UPSERT_LIMIT_SQL = `INSERT INTO chat_limits (bucket, day, count, last_at)
   VALUES (?, ?, 1, ?)
   ON CONFLICT(bucket, day) DO UPDATE SET count = count + 1, last_at = excluded.last_at`;

async function ensureChatTable(db) {
  if (chatTableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS chat_limits (
         bucket  TEXT    NOT NULL,
         day     TEXT    NOT NULL,
         count   INTEGER NOT NULL DEFAULT 0,
         last_at INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (bucket, day)
       )`
    )
    .run();
  chatTableReady = true;
}

/**
 * 限流主入口。返回 { ok: true } 或 { ok: false, error, message }。
 *
 * 计数存在 D1（day 按 UTC 切分）。D1 没绑、或临时出错时退回进程内存计数：
 * 保护会变弱（每个 isolate 各算各的），但绝不能因为"数据库抖了一下"
 * 就把聊天整个弄挂。
 */
export async function checkChatLimit(env, ipHash, nowMs = Date.now()) {
  const db = env && env.DB;
  if (!db) return memoryLimit(ipHash, nowMs);

  const day = new Date(nowMs).toISOString().slice(0, 10);

  try {
    await ensureChatTable(db);

    const { results } = await db
      .prepare(SELECT_LIMIT_SQL)
      .bind(day, GLOBAL_BUCKET, ipHash)
      .all();

    let globalCount = 0;
    let ipCount = 0;
    let ipLastAt = 0;
    for (const row of results || []) {
      if (row.bucket === GLOBAL_BUCKET) {
        globalCount = row.count;
      } else {
        ipCount = row.count;
        ipLastAt = row.last_at;
      }
    }

    if (globalCount >= CHAT_DAILY_GLOBAL) {
      return {
        ok: false,
        error: "chat_global_limit",
        message: "今天来问的人有点多，明天再来吧",
      };
    }
    if (ipCount >= CHAT_DAILY_PER_IP) {
      return {
        ok: false,
        error: "chat_daily_limit",
        message: "今天问得有点多了，明天再来吧",
      };
    }

    const waitMs = CHAT_MIN_INTERVAL_MS - (nowMs - ipLastAt);
    if (ipLastAt > 0 && waitMs > 0) {
      return {
        ok: false,
        error: "chat_too_fast",
        message: `问得太快了，等 ${Math.ceil(waitMs / 1000)} 秒再问`,
      };
    }

    await db.batch([
      db.prepare(UPSERT_LIMIT_SQL).bind(day, GLOBAL_BUCKET, nowMs),
      db.prepare(UPSERT_LIMIT_SQL).bind(day, ipHash, nowMs),
    ]);

    return { ok: true };
  } catch (err) {
    console.error(
      "[chat] 限流查库失败，退回内存计数：" + String((err && err.message) || err)
    );
    return memoryLimit(ipHash, nowMs);
  }
}

/* 内存兜底。每个 isolate 一份，比 D1 那份宽松得多，只能算"聊胜于无"。
   注意它管不了全站日上限 —— 那个必须有个共享的存储才做得到。 */
const memHits = new Map();

function memoryLimit(ipHash, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const key = day + "|" + ipHash;
  const rec = memHits.get(key) || { count: 0, last: 0 };

  if (rec.count >= CHAT_DAILY_PER_IP) {
    return {
      ok: false,
      error: "chat_daily_limit",
      message: "今天问得有点多了，明天再来吧",
    };
  }

  const waitMs = CHAT_MIN_INTERVAL_MS - (nowMs - rec.last);
  if (rec.last > 0 && waitMs > 0) {
    return {
      ok: false,
      error: "chat_too_fast",
      message: `问得太快了，等 ${Math.ceil(waitMs / 1000)} 秒再问`,
    };
  }

  rec.count += 1;
  rec.last = nowMs;
  memHits.set(key, rec);

  // 防内存无限涨：超过 5000 个 key 就清空重来（限流精度短暂下降，无所谓）
  if (memHits.size > 5000) memHits.clear();

  return { ok: true };
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

/* 导出常量给 tools/verify.mjs 做断言用，免得测试里再抄一份数字。
   Pages 只认 onRequest* 开头的导出，多导一个不会变成路由。 */
export const __test__ = {
  MAX_TURNS,
  MAX_CHARS,
  MAX_TOKENS,
  CHAT_MIN_INTERVAL_MS,
  CHAT_DAILY_PER_IP,
  CHAT_DAILY_GLOBAL,
  GLOBAL_BUCKET,
};
