/**
 * 把 persona.md 同步成 functions/_persona.js
 *
 * 为什么需要这一步：
 *   Cloudflare Workers 运行时没有文件系统，读不到 persona.md，
 *   所以人设必须以 JS 常量的形式打包进函数里。
 *
 * 什么时候要跑：
 *   只要改了 persona.md（本地开发用），想让线上也生效，就跑一次：
 *     node tools/sync-persona.mjs
 *   然后 commit + push，Cloudflare 会自动重新部署。
 *
 * 反过来，functions/_persona.js 是生成物，不要手改。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

const mdPath = join(projectRoot, "persona.md");
const outPath = join(projectRoot, "functions", "_persona.js");

const raw = readFileSync(mdPath, "utf8")
  // 剥掉 HTML 注释：那是写给人看的笔记，不该混进 system prompt
  .replace(/<!--[\s\S]*?-->/g, "")
  // 注释留下的连续空行收一收
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// JSON.stringify 产出的就是合法的 JS 字符串字面量。
// U+2028 / U+2029 在老引擎里会被当成换行，顺手转义掉更保险。
const literal = JSON.stringify(raw)
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

const out = `/**
 * 人设常量 —— 由 tools/sync-persona.mjs 从 persona.md 自动生成，请勿手改。
 * 要改人设：编辑 persona.md，然后跑 node tools/sync-persona.mjs
 * 生成时间：${new Date().toISOString()}
 */

export const PERSONA = ${literal};
`;

writeFileSync(outPath, out, "utf8");

console.log(`已同步：persona.md -> functions/_persona.js（${raw.length} 字符）`);
