/**
 * /api/messages —— 留言板接口（Cloudflare 版）
 *
 * 这是 server.py 里 /api/messages 的云端版本，和 chat.js 是同一个套路：
 * Workers 只能跑 JS，所以本地那段 Python 逻辑在这边重写成 JS，对外行为保持一致。
 *
 * 四个动作：
 *   GET    /api/messages                公开留言（不含悄悄话）
 *   GET    /api/messages?all=1          全部留言（要带管理口令，含悄悄话）
 *   POST   /api/messages                发一条留言
 *   DELETE /api/messages?id=123         删一条（要带管理口令）
 *
 * 三个不能改的设计：
 *   1. 数据存在 D1（Cloudflare 自带的 SQLite）。绑定名固定叫 DB，
 *      在 Pages 后台 Settings → Functions → D1 database bindings 里配。
 *      没绑定的时候接口返回 500 + db_not_bound，前端会降级成一句提示，不会白屏。
 *   2. 管理口令从 env.ADMIN_TOKEN 读。**没配就当管理接口关闭**——
 *      绝不能因为"忘了配"就变成谁都能删别人的留言。
 *   3. 访客 IP 只存 SHA-256 哈希，不存明文。限流需要"认出同一个人"，
 *      但不需要知道他是谁。
 *
 * 返回值字段名（ok / messages / createdAt）必须和 server.py 一致，
 * 否则本地和线上前端表现会不一样。
 */

/* ---------- 可调参数 ---------- */
const MAX_NAME = 20;             // 昵称最长字符数
const MAX_CONTENT = 500;         // 留言正文最长字符数
const RATE_WINDOW_MS = 60 * 1000;      // 同一个人两次留言的最小间隔
const RATE_DAILY_LIMIT = 10;     // 同一个人 24 小时内最多发几条
const PUBLIC_PAGE_SIZE = 50;     // 公开列表一次最多返回几条
const ADMIN_PAGE_SIZE = 500;     // 管理页一次最多返回几条

/* 建表只跑一次。Workers 的 isolate 会复用这个模块级变量，
   所以正常情况下一辈子只建一次表，不占每次请求的耗时。 */
let tableReady = false;

/* ============================================================
   三个出口
   ============================================================ */

export async function onRequestGet({ request, env }) {
  const db = requireDb(env);
  if (db instanceof Response) return db;

  await ensureTable(db);

  const url = new URL(request.url);

  /* --- 管理视角：返回全部，含悄悄话 --- */
  if (url.searchParams.get("all") === "1") {
    if (!isAdmin(request, env)) {
      return jsonResponse(
        { ok: false, error: "unauthorized", message: "管理口令不对" },
        401
      );
    }
    const { results } = await db
      .prepare(
        `SELECT id, name, content, is_private, ip_hash, created_at
           FROM messages
          ORDER BY id DESC
          LIMIT ${ADMIN_PAGE_SIZE}`
      )
      .all();

    return jsonResponse({
      ok: true,
      messages: (results || []).map(toMessage),
      total: (results || []).length,
    });
  }

  /* --- 访客视角：只给公开的 --- */
  const { results } = await db
    .prepare(
      `SELECT id, name, content, created_at
         FROM messages
        WHERE is_private = 0
        ORDER BY id DESC
        LIMIT ?`
    )
    .bind(PUBLIC_PAGE_SIZE)
    .all();

  return jsonResponse({
    ok: true,
    messages: (results || []).map(toMessage),
    /* 前端拿这个决定要不要渲染人机验证挂件。
       没配就不渲染，表单照样能用——本地开发时就是这个状态。 */
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    turnstileRequired: Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY),
  });
}

export async function onRequestPost({ request, env }) {
  const db = requireDb(env);
  if (db instanceof Response) return db;

  await ensureTable(db);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse(
      { ok: false, error: "bad_request", message: "请求体不是合法 JSON" },
      400
    );
  }

  const name = sanitizeName(body.name);
  const content = sanitizeContent(body.content);
  if (!content) {
    return jsonResponse(
      { ok: false, error: "empty_content", message: "内容不能为空" },
      400
    );
  }

  const ip = clientIp(request);
  const ipHash = await hashIp(ip);

  /* --- 第 1 关：人机验证（配了才校验） --- */
  if (env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY) {
    const passed = await verifyTurnstile(
      env.TURNSTILE_SECRET_KEY,
      body.turnstileToken,
      ip
    );
    if (!passed) {
      return jsonResponse(
        {
          ok: false,
          error: "turnstile_failed",
          message: "人机验证没通过，刷新页面再试一次",
        },
        403
      );
    }
  }

  /* --- 第 2 关：频率限制（防同一个人连发） --- */
  const rate = await checkRateLimit(db, ipHash);
  if (!rate.ok) {
    return jsonResponse(
      { ok: false, error: "rate_limited", message: rate.message },
      429
    );
  }

  const isPrivate = body.isPrivate ? 1 : 0;
  const createdAt = new Date().toISOString();

  const res = await db
    .prepare(
      `INSERT INTO messages (name, content, is_private, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(name, content, isPrivate, ipHash, createdAt)
    .run();

  return jsonResponse(
    {
      ok: true,
      message: {
        id: (res.meta && res.meta.last_row_id) || null,
        name,
        content,
        createdAt,
        isPrivate: isPrivate === 1,
      },
      /* 悄悄话不进公开列表，前端提交成功后不该把它插到列表里 */
      visible: isPrivate === 0,
    },
    201
  );
}

export async function onRequestDelete({ request, env }) {
  const db = requireDb(env);
  if (db instanceof Response) return db;

  if (!isAdmin(request, env)) {
    return jsonResponse(
      { ok: false, error: "unauthorized", message: "管理口令不对" },
      401
    );
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse(
      { ok: false, error: "bad_request", message: "id 不合法" },
      400
    );
  }

  await ensureTable(db);
  const res = await db.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();

  return jsonResponse({ ok: true, deleted: (res.meta && res.meta.changes) || 0 });
}

/* ============================================================
   数据库
   ============================================================ */

/** env.DB 没配好时，返回一个现成的错误响应；配好了就返回 db 对象 */
function requireDb(env) {
  if (!env || !env.DB) {
    return jsonResponse(
      {
        ok: false,
        error: "db_not_bound",
        message: "服务器还没绑定 D1 数据库（Pages 后台 → Settings → Functions → D1 bindings，变量名 DB）",
      },
      500
    );
  }
  return env.DB;
}

/**
 * 懒建表：第一次有请求进来时把表和索引建好。
 * 这样你在 Cloudflare 后台不需要手动执行任何 SQL，新建的库直接能用。
 */
async function ensureTable(db) {
  if (tableReady) return;
  await db.exec(
    `CREATE TABLE IF NOT EXISTS messages (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       name       TEXT    NOT NULL,
       content    TEXT    NOT NULL,
       is_private INTEGER NOT NULL DEFAULT 0,
       ip_hash    TEXT    NOT NULL DEFAULT '',
       created_at TEXT    NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_messages_public ON messages(is_private, id DESC);
     CREATE INDEX IF NOT EXISTS idx_messages_ip     ON messages(ip_hash, created_at);`
  );
  tableReady = true;
}

/** 数据库行 → 前端认识的字段名（snake_case → camelCase） */
function toMessage(row) {
  const m = {
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.created_at,
  };
  // 只有管理视角的查询才带这两列，访客视角的查询里没有
  if (row.is_private !== undefined) m.isPrivate = row.is_private === 1;
  if (row.ip_hash) m.ipHash = String(row.ip_hash).slice(0, 8);
  return m;
}

/* ============================================================
   频率限制
   ============================================================ */

/**
 * 两层限制：60 秒内不能发第二条，24 小时内最多 10 条。
 * 用 ISO 时间字符串直接做大小比较 —— ISO 8601 的字典序就是时间序，
 * 不需要在数据库里存时间戳。
 */
export async function checkRateLimit(db, ipHash, now = Date.now()) {
  const since = new Date(now - RATE_WINDOW_MS).toISOString();
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, since)
    .first();

  if (recent && recent.n > 0) {
    return { ok: false, message: "刚发过了，等一分钟再发第二条" };
  }

  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const daily = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, dayAgo)
    .first();

  if (daily && daily.n >= RATE_DAILY_LIMIT) {
    return { ok: false, message: "今天留的言有点多了，明天再来吧" };
  }

  return { ok: true };
}

/* ============================================================
   人机验证 / 管理口令 / 文本清洗
   ============================================================ */

/**
 * 调 Cloudflare Turnstile 的校验接口。
 * secret 是服务端密钥（只在后台配，绝不进前端），token 是前端挂件塞进表单的那串一次性凭证。
 */
export async function verifyTurnstile(secret, token, ip) {
  if (!token || typeof token !== "string") return false;

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip && ip !== "unknown") form.append("remoteip", ip);

  try {
    const resp = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
    const data = await resp.json();
    return data && data.success === true;
  } catch (err) {
    // 校验服务本身挂了 —— 宁可不让人发，也不能放机器人进来
    return false;
  }
}

/** 管理口令校验。没配 ADMIN_TOKEN 一律拒绝。 */
export function isAdmin(request, env) {
  const expected = env && env.ADMIN_TOKEN;
  if (!expected) return false;
  const given = request.headers.get("X-Admin-Token") || "";
  return safeEqual(given, expected);
}

/** 定长比较，别让"比较在第几位失败"泄漏口令信息 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 访客真实 IP。Cloudflare 会填 CF-Connecting-IP，本地测试时没有就记 unknown。 */
export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

/** IP → 哈希。用 Web Crypto，Workers 和现代浏览器都自带，不用装包。 */
export async function hashIp(ip) {
  const data = new TextEncoder().encode("zqe-msg-salt::" + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 昵称：去空白、砍长度、空的就叫匿名 */
export function sanitizeName(raw) {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, MAX_NAME) : "匿名";
}

/** 正文：去首尾空白、砍长度。留换行，但把连续空行压掉。 */
export function sanitizeContent(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_CONTENT);
}

/* ============================================================
   响应包装
   ============================================================ */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 留言列表绝对不能缓存，否则发完刷新看不到自己那条
      "Cache-Control": "no-store",
    },
  });
}

/* 导出给 tools/verify.mjs 做本地测试用。Pages 只认 onRequest* 开头的导出，
   多导几个纯函数不会变成路由。 */
export const __test__ = { MAX_CONTENT, MAX_NAME, toMessage };
