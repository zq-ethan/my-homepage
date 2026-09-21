/**
 * 本地验证脚本（仅开发时用，不参与部署）
 *   node tools/verify.mjs
 * 结果会写到 tools/_report.txt
 *
 * 为什么值得单独测 SSE 转换：
 *   DeepSeek 的一个事件可能被网络切成两块传过来（断在 JSON 中间），
 *   拼接逻辑一旦写错，症状是"回答偶尔少几个字"或"莫名截断"，
 *   线上很难复现。这里用伪造的分块流把它测掉。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const lines = [];
const log = (s = "") => lines.push(s);
let failed = 0;

function check(name, ok, extra = "") {
  log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "   " + extra : ""}`);
  if (!ok) failed++;
}

const load = (rel) => import(pathToFileURL(join(root, rel)).href);

/* ---------- 1. 人设常量 ---------- */
log("== 1. functions/_persona.js ==");

let PERSONA;
try {
  ({ PERSONA } = await load("functions/_persona.js"));
  check("模块可导入", true, `人设长度 ${PERSONA.length} 字符`);
} catch (err) {
  check("模块可导入", false, String(err));
}

if (typeof PERSONA === "string") {
  check(
    "HTML 注释没混进人设",
    !PERSONA.includes("<!--") &&
      !PERSONA.includes("-->") &&
      !PERSONA.includes("sync-persona")
  );
  check(
    "人设正文完整",
    PERSONA.includes("帅到你了") && PERSONA.includes("zqethan20260906@outlook.com")
  );
  check("多余空行已折叠", !PERSONA.includes("\n\n\n"));
  check("以人设标题开头", PERSONA.startsWith("# 赵泉恩"));
}

/* ---------- 2. 两个函数模块 ---------- */
log("");
log("== 2. Cloudflare Functions 模块 ==");

let chat, health;
try {
  chat = await load("functions/api/chat.js");
  check("chat.js 可导入", true);
  check("导出了 onRequestPost", typeof chat.onRequestPost === "function");
  check("导出了 makeSseTransformer", typeof chat.makeSseTransformer === "function");
} catch (err) {
  check("chat.js 可导入", false, String(err));
}

try {
  health = await load("functions/api/health.js");
  check("health.js 可导入", true);
  check("导出了 onRequestGet", typeof health.onRequestGet === "function");
} catch (err) {
  check("health.js 可导入", false, String(err));
}

let messages;
try {
  messages = await load("functions/api/messages.js");
  check("messages.js 可导入", true);
  check("导出了 onRequestGet", typeof messages.onRequestGet === "function");
  check("导出了 onRequestPost", typeof messages.onRequestPost === "function");
  check("导出了 onRequestDelete", typeof messages.onRequestDelete === "function");
} catch (err) {
  check("messages.js 可导入", false, String(err));
}

/* ---------- 3. SSE 转换 ---------- */
log("");
log("== 3. SSE 格式转换 ==");

if (chat?.makeSseTransformer) {
  const enc = new TextEncoder();

  async function runThrough(parts) {
    const input = new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    return new Response(input.pipeThrough(chat.makeSseTransformer())).text();
  }

  // 第 2 块故意断在一个 JSON 中间
  const out1 = await runThrough([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n',
    'data: {"choices":[{"delta":{"con',
    'tent":"好"}}]}\ndata: [DONE]\n\n',
  ]);

  check("提取出第一段文字", out1.includes('data: {"content":"你"}'));
  check("跨块断开的内容能拼回", out1.includes('data: {"content":"好"}'));
  check("结尾标记只发一次", (out1.match(/\[DONE\]/g) || []).length === 1);
  check(
    "整体格式符合前端预期",
    out1.trim() ===
      'data: {"content":"你"}\n\ndata: {"content":"好"}\n\ndata: [DONE]'
  );

  // 上游没发 [DONE] 就断流
  const out2 = await runThrough(['data: {"choices":[{"delta":{"content":"A"}}]}\n']);
  check("上游漏发 [DONE] 时自动补上", out2.includes("data: [DONE]"));

  // 无关的行、空行、坏 JSON 应被安静丢掉
  const out3 = await runThrough([
    ": keep-alive\n\n",
    'data: {"choices":[{"delta":{"content":"X"}}]}\n',
    "data: 这不是JSON\n",
    "data: [DONE]\n\n",
  ]);
  check("忽略心跳行与坏 JSON", out3.includes('data: {"content":"X"}') && !out3.includes("不是JSON"));
}

/* ---------- 4. 两个 handler 的行为 ---------- */
log("");
log("== 4. 请求处理 ==");

const mkReq = (body) =>
  new Request("https://example.com/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

if (chat?.onRequestPost) {
  const r1 = await chat.onRequestPost({ request: mkReq({ messages: [] }), env: {} });
  const d1 = await r1.json();
  check("未配 key 时返回 500", r1.status === 500, JSON.stringify(d1));

  const r2 = await chat.onRequestPost({
    request: mkReq({ messages: [] }),
    env: { DEEPSEEK_API_KEY: "sk-fake-for-test" },
  });
  check("messages 为空时返回 400", r2.status === 400);

  const r3 = await chat.onRequestPost({
    request: mkReq({ messages: [{ role: "hacker", content: "x" }] }),
    env: { DEEPSEEK_API_KEY: "sk-fake-for-test" },
  });
  check("非法 role 被拦下（返回 400）", r3.status === 400);
}

if (health?.onRequestGet) {
  const h1 = await (await health.onRequestGet({ env: {} })).json();
  check("没配 key → hasKey=false", h1.ok === true && h1.hasKey === false, JSON.stringify(h1));

  const h2 = await (
    await health.onRequestGet({
      env: { DEEPSEEK_API_KEY: "sk-x", DEEPSEEK_MODEL: "deepseek-chat" },
    })
  ).json();
  check("配了 key → hasKey=true", h2.hasKey === true && h2.model === "deepseek-chat", JSON.stringify(h2));
}

/* ---------- 4b. 留言接口 ---------- */
log("");
log("== 4b. 留言接口（/api/messages） ==");

if (messages) {
  /* --- 文本清洗 --- */
  check("昵称留空 → 匿名", messages.sanitizeName("   ") === "匿名");
  check("昵称超长被截断", messages.sanitizeName("a".repeat(50)).length === 20);
  check("昵称里的多余空白被压掉", messages.sanitizeName("  a   b  ") === "a b");
  check("正文去首尾空白", messages.sanitizeContent("  hi  ") === "hi");
  check("正文超长被截断", messages.sanitizeContent("x".repeat(600)).length === 500);
  check("正文不是字符串 → 空串", messages.sanitizeContent(null) === "");
  check("纯空白正文 → 空串（发不出去）", messages.sanitizeContent("   ") === "");

  /* --- IP 哈希：要能认人，但认不出是谁 --- */
  const h1 = await messages.hashIp("1.2.3.4");
  const h2 = await messages.hashIp("1.2.3.4");
  const h3 = await messages.hashIp("1.2.3.5");
  check("同一 IP 哈希稳定且是 64 位十六进制", h1 === h2 && /^[0-9a-f]{64}$/.test(h1));
  check("不同 IP 哈希不同", h1 !== h3);
  check("哈希里不含 IP 明文", !h1.includes("1.2.3.4"));

  /* --- 管理口令：没配就等于关闭，绝不能默认放行 --- */
  const withToken = (t) =>
    new Request("https://example.com/api/messages", {
      headers: t ? { "X-Admin-Token": t } : {},
    });
  check(
    "没配 ADMIN_TOKEN 时，带任何口令都拒绝",
    messages.isAdmin(withToken("anything"), {}) === false
  );
  check(
    "口令正确时通过",
    messages.isAdmin(withToken("s3cret"), { ADMIN_TOKEN: "s3cret" }) === true
  );
  check(
    "口令错误时拒绝",
    messages.isAdmin(withToken("wrong"), { ADMIN_TOKEN: "s3cret" }) === false
  );
  check(
    "不带口令头时拒绝",
    messages.isAdmin(withToken(""), { ADMIN_TOKEN: "s3cret" }) === false
  );

  /* --- 没绑定 D1：要给出可读的报错，而不是抛异常 --- */
  const noDb = await messages.onRequestGet({
    request: new Request("https://example.com/api/messages"),
    env: {},
  });
  const noDbData = await noDb.json();
  check(
    "未绑定 D1 → 500 + db_not_bound",
    noDb.status === 500 && noDbData.error === "db_not_bound",
    JSON.stringify(noDbData)
  );

  /* --- 用一个假 D1 走一遍发留言的主流程 --- */
  const fakeDb = {
    exec: async () => ({}),
    prepare: () => ({
      bind() {
        return this;
      },
      all: async () => ({ results: [] }),
      first: async () => ({ n: 0 }),
      run: async () => ({ meta: { last_row_id: 42, changes: 1 } }),
    }),
  };

  const post = (body, extraEnv = {}) =>
    messages.onRequestPost({
      request: new Request("https://example.com/api/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: JSON.stringify(body),
      }),
      env: { DB: fakeDb, ...extraEnv },
    });

  const p1 = await post({ content: "" });
  check("空内容 → 400", p1.status === 400, JSON.stringify(await p1.json()));

  const p2 = await post({ content: "  hello  " });
  const d2 = await p2.json();
  check("正常留言 → 201", p2.status === 201 && d2.ok === true, JSON.stringify(d2));
  check("公开留言 visible=true", d2.visible === true);
  check("昵称没填自动变匿名", d2.message.name === "匿名");
  check("正文首尾空白已去掉", d2.message.content === "hello");
  check("返回体带 id 和时间", d2.message.id === 42 && typeof d2.message.createdAt === "string");

  const p3 = await post({ content: "悄悄说一句", isPrivate: true });
  const d3 = await p3.json();
  check(
    "悄悄话 visible=false（前端不会插进公开列表）",
    d3.visible === false && d3.message.isPrivate === true,
    JSON.stringify(d3)
  );

  const p4 = await messages.onRequestPost({
    request: new Request("https://example.com/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "这不是 JSON",
    }),
    env: { DB: fakeDb },
  });
  check("请求体不是 JSON → 400", p4.status === 400);

  /* --- 删除必须带口令 --- */
  const del1 = await messages.onRequestDelete({
    request: new Request("https://example.com/api/messages?id=1", { method: "DELETE" }),
    env: { DB: fakeDb },
  });
  check("没配口令时删除 → 401", del1.status === 401);

  const del2 = await messages.onRequestDelete({
    request: new Request("https://example.com/api/messages?id=abc", {
      method: "DELETE",
      headers: { "X-Admin-Token": "s3cret" },
    }),
    env: { DB: fakeDb, ADMIN_TOKEN: "s3cret" },
  });
  check("id 不合法 → 400", del2.status === 400);

  const del3 = await messages.onRequestDelete({
    request: new Request("https://example.com/api/messages?id=7", {
      method: "DELETE",
      headers: { "X-Admin-Token": "s3cret" },
    }),
    env: { DB: fakeDb, ADMIN_TOKEN: "s3cret" },
  });
  const d3r = await del3.json();
  check("带正确口令删除 → 200", del3.status === 200 && d3r.ok === true, JSON.stringify(d3r));
}

log("");
log("== 5. 前后端接口是否对得上 ==");

const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
check("前端请求 /api/health", appJs.includes("`${API_BASE}/api/health`"));
check("前端请求 /api/chat", appJs.includes("`${API_BASE}/api/chat`"));
check("非 localhost 时走同域（API_BASE 为空串）", /location\.hostname === "localhost" \? "http:\/\/localhost:5000" : ""/.test(appJs));
check("前端认 { content } 字段", appJs.includes("obj.content"));
check("前端认 [DONE] 标记", appJs.includes("[DONE]"));

/* ---------- 5b. 留言板：前后端字段名要对得上 ---------- */
log("");
log("== 5b. 留言板前后端对齐 ==");

const msgJs = readFileSync(join(root, "public", "messages.js"), "utf8");
check("留言前端请求 /api/messages", msgJs.includes('"/api/messages"'));
check("留言前端用 textContent 渲染（防 XSS）", !/\binnerHTML\s*=/.test(msgJs));
check("留言前端字段 isPrivate 对得上后端", msgJs.includes("isPrivate"));
check("留言前端字段 turnstileToken 对得上后端", msgJs.includes("turnstileToken"));
check("留言前端读取 turnstileSiteKey", msgJs.includes("turnstileSiteKey"));
check("留言前端不覆盖全局 API_BASE（IIFE 包裹）", msgJs.trimStart().startsWith("/*") && msgJs.includes("(function () {"));

const adminHtml = readFileSync(join(root, "public", "admin.html"), "utf8");
check("管理页走 ?all=1 拿全部留言", adminHtml.includes("all=1"));
check("管理页带 X-Admin-Token 头", adminHtml.includes("X-Admin-Token"));
check("管理页渲染不用 innerHTML", !/\binnerHTML\s*=/.test(adminHtml));
check("管理页声明了 noindex", adminHtml.includes("noindex"));
check("管理页删除走 DELETE 方法", adminHtml.includes('method: "DELETE"'));

const indexHtml = readFileSync(join(root, "public", "index.html"), "utf8");
check("首页已引入 messages.js", indexHtml.includes('src="messages.js"'));
check(
  "首页留言区容器齐全",
  ["msgForm", "msgList", "msgContent", "msgPrivate", "msgTurnstile"].every((id) =>
    indexHtml.includes(`id="${id}"`)
  )
);

const stylesCss = readFileSync(join(root, "public", "styles.css"), "utf8");
check("留言板样式已加", stylesCss.includes(".msg-board") && stylesCss.includes(".msg-item"));
check("留言板有手机端适配", /@media \(max-width: 899px\)[\s\S]*\.msg-board \{ grid-template-columns: 1fr;/.test(stylesCss));

/* server.py 是同一套逻辑的 Python 版，漏了就会线上线下不一致 */
const serverPy = readFileSync(join(root, "server.py"), "utf8");
check("server.py 也有 /api/messages 路由", serverPy.includes('"/api/messages"'));
check(
  "server.py 三种方法齐全",
  serverPy.includes('.get("/api/messages")') &&
    serverPy.includes('.post("/api/messages")') &&
    serverPy.includes('.delete("/api/messages")')
);
check("server.py 没配 ADMIN_TOKEN 时拒绝管理", serverPy.includes("if not ADMIN_TOKEN:"));
check(
  "server.py 前端白名单含新文件",
  serverPy.includes('"messages.js"') && serverPy.includes('"admin.html"')
);

/* ---------- 5c. 回归防护：钉死踩过的坑 ---------- */
log("");
log("== 5c. 回归防护（踩过的坑） ==");

/* 去掉注释再检查 —— 注释里提到某个写法就会让正则误报，这个坑已经踩过两次 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/gm, "$1");

/* 注意：这里要读后端那份 messages.js（functions/ 下），不是前端的 public/messages.js。
   msgJs 是前端那份，两者同名但不是同一个文件。 */
const messagesSrc = stripComments(
  readFileSync(join(root, "functions", "api", "messages.js"), "utf8")
);
const chatSrc = stripComments(
  readFileSync(join(root, "functions", "api", "chat.js"), "utf8")
);
const appSrc = stripComments(appJs);
const serverSrc = stripComments(serverPy);

/* 2026-09-21：线上 /api/messages 返回 Cloudflare `error code: 1101`（Worker 抛异常）。
   根因是拿 db.exec() 去跑多条建表 SQL —— 官方文档写明 exec() 只该用于
   「维护 / 一次性任务」，性能更差也更不安全，多条语句还必须用换行分隔。
   改成 prepare().run() 逐条执行就通了。这条检查防止它被改回去。 */
check("messages.js 不再使用 db.exec()", !/\.exec\s*\(/.test(messagesSrc));
check(
  "messages.js 用 prepare().run() 建表",
  /db\.prepare\(sql\)\.run\(\)/.test(messagesSrc)
);
check(
  "messages.js 校验 DB 绑定类型（防绑成普通变量后 1101）",
  messagesSrc.includes("db_binding_wrong_type")
);
check(
  "messages.js 三个出口都套了异常兜底",
  ["onRequestGet", "onRequestPost", "onRequestDelete"].every((name) =>
    new RegExp(
      `export async function ${name}\\(ctx\\) \\{\\s*return guard\\(`
    ).test(messagesSrc)
  )
);

/* 对话上下文限制：前端 / chat.js / server.py 三处必须一致，否则线上线下表现不同 */
const pick = (src, re) => {
  const m = src.match(re);
  return m ? Number(m[1]) : NaN;
};
const nChat = pick(chatSrc, /MAX_TURNS\s*=\s*(\d+)/);
const nApp = pick(appSrc, /MAX_HISTORY\s*=\s*(\d+)/);
const nPy = pick(serverSrc, /MAX_CHAT_TURNS\s*=\s*(\d+)/);
check(
  `对话上下文三处一致（chat.js=${nChat} / app.js=${nApp} / server.py=${nPy}）`,
  nChat > 0 && nChat === nApp && nApp === nPy
);
check(
  "app.js 上下文数组会裁剪（不只增不减）",
  /history\.splice\(/.test(appSrc)
);

/* server.py 曾经不过滤 role，访客能塞一条 role="system" 插在人设前面把它覆盖掉。
   chat.js 一直有这个过滤，Python 侧补齐了，这里盯住。 */
check(
  "server.py 过滤 role（只放行 user / assistant）",
  serverSrc.includes('("user", "assistant")')
);
check(
  "server.py 不再把 body.messages 原样转发",
  !/messages\s*=\s*body\.get\("messages", \[\]\)/.test(serverSrc)
);

/* ---------- 6. 部署配置 ---------- */
log("");
log("== 6. Cloudflare 部署配置 ==");

try {
  const routes = JSON.parse(
    readFileSync(join(root, "public", "_routes.json"), "utf8")
  );
  check("public/_routes.json 存在且是合法 JSON", true);
  check(
    "只让 /api/* 触发函数（静态资源不消耗配额）",
    Array.isArray(routes.include) && routes.include.includes("/api/*")
  );
} catch (err) {
  check("public/_routes.json 存在且是合法 JSON", false, String(err));
}

/* ---------- 汇总 ---------- */
log("");
log(failed === 0 ? `全部通过（0 项失败）` : `有 ${failed} 项失败`);

writeFileSync(join(here, "_report.txt"), lines.join("\r\n") + "\r\n", "utf8");
process.exitCode = failed === 0 ? 0 : 1;
