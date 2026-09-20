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

/* ---------- 5. 前端与函数的路由对得上 ---------- */
log("");
log("== 5. 前后端接口是否对得上 ==");

const appJs = readFileSync(join(root, "public", "app.js"), "utf8");
check("前端请求 /api/health", appJs.includes("`${API_BASE}/api/health`"));
check("前端请求 /api/chat", appJs.includes("`${API_BASE}/api/chat`"));
check("非 localhost 时走同域（API_BASE 为空串）", /location\.hostname === "localhost" \? "http:\/\/localhost:5000" : ""/.test(appJs));
check("前端认 { content } 字段", appJs.includes("obj.content"));
check("前端认 [DONE] 标记", appJs.includes("[DONE]"));

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
