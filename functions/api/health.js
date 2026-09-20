/**
 * GET /api/health —— 探活接口
 *
 * 前端 app.js 的 initCloud() 会先调这个：
 *   - hasKey 为 true  → 走真模型
 *   - hasKey 为 false → 降级用离线知识库
 *
 * 返回的字段名（ok / model / hasKey）必须和 server.py 保持一致，
 * 否则前端判断会错。
 */

export async function onRequestGet({ env }) {
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const hasKey = Boolean(env.DEEPSEEK_API_KEY);

  return new Response(JSON.stringify({ ok: true, model, hasKey }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 探活结果不能缓存，否则配上 key 后前端还以为没配
      "Cache-Control": "no-store",
    },
  });
}
