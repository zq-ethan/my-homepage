/* ============================================================
   赵泉恩 · 个人主页 / 数字分身 v3
   1) 主链路：本地后端 server.py 转发到 DeepSeek（流式，真模型，key 不进前端）
   2) 兜底：本地知识库（后端未起 / key 未配 / 调用失败时降级，界面明确标注）
   ============================================================ */

/* ---------- 本地后端地址 ---------- */
// 同域名部署时用相对路径，本地开发走 localhost
const API_BASE = location.hostname === "localhost" ? "http://localhost:5000" : "";

/* ============================================================
   本地知识库（离线兜底）
   ============================================================ */
const KB = [
  {
    keywords: ["你好", "您好", "hi", "hello", "哈喽", "在吗", "嗨"],
    answer: "在。\n我是赵泉恩的数字分身。想问点什么？「最近在干嘛」「有什么作品」「喜欢什么」都可以。",
  },
  {
    keywords: ["你是谁", "介绍一下", "自我介绍", "是谁", "叫什么", "名字", "哪个学校", "专业", "几年级", "大几"],
    answer: "赵泉恩，河北师范大学计算机科学与技术专业，2028 届。\n一句话介绍：话少话多无厘头。\n现在主要在学开发，顺手做一个图库管理 App。",
  },
  {
    keywords: ["最近", "在干嘛", "干嘛呢", "近况", "忙什么", "现在做", "做什么", "进展"],
    answer: "最近两件事：\n1. 学开发，走 vibecoding 路线，边写边跟 AI 对喷。\n2. 做一个图库管理 App —— 摄影攒的图实在没地方放了。\n剩下的时间分给课程、游戏和找吃的。",
  },
  {
    keywords: ["作品", "项目", "做过什么", "demo", "成果", "github", "上线"],
    answer: "目前主打一个：图库管理 App。\n起因是照片太多，找图靠翻、删图靠心情，干脆自己写一个。\n技术偏 AI 全栈：Python 后端 + Vue3 前端。做完会放到这个页面上。",
  },
  {
    keywords: ["喜欢", "兴趣", "爱好", "业余", "平时玩", "放松", "消遣", "美食", "吃货", "探店", "好吃的"],
    answer:
      "摄影、游戏、美食。\n摄影是唯一能产出实物的爱好，所以才有了那个图库 App；吃这块还在到处探索，属于看到就想试试的类型。",
  },
  {
    keywords: ["技术栈", "会什么", "技术", "语言", "框架", "python", "vue", "前端", "后端", "ai"],
    answer: "基础是 C/C++ 和 Python，数据结构也过了一遍。\n现在往 AI 全栈走：后端 Python，前端 Vue3，中间接 AI 能力。\n选 Python 不选 Node，是因为路线更统一。",
  },
  {
    keywords: ["规划", "计划", "目标", "未来", "打算", "毕业", "实习", "工作", "钱", "money"],
    answer:
      "短期：把开发能力练起来，做出作品，尝试接单变现。\n长期：做成能独立交付产品的 AI 全栈工程师。\n更远的事还没定，先把手上的东西做出来再说。",
  },
  {
    keywords: ["帅", "特点", "记忆点", "印象", "特别", "无厘头"],
    answer: "帅到你了。\n这句是自我介绍里他唯一逐字审过的一句。\n至于「话少话多无厘头」——意思是你永远猜不到他下一句有多长。",
  },
  {
    keywords: ["联系", "微信", "邮箱", "怎么找", "合作", "接单", "找你"],
    answer:
      "邮箱：zqethan20260906@outlook.com\n聊合作、接单或者单纯提问，都发这里就行。",
  },
  {
    keywords: ["拍照", "摄影", "照片", "相机", "图库", "美食", "吃", "餐厅"],
    answer:
      "摄影算是他唯一能产出实物的爱好。\n拍多了就成了负担——找图靠翻，删图靠心情。所以那个图库管理 App 是被自己的照片逼出来的。\n至于吃，是三大爱好里最轻松的一个，具体口味你得问他本人。",
  },
];

const FALLBACKS = [
  "这个他还没教过我，我不敢瞎编。\n可以试试问：最近在干嘛 / 有什么作品 / 喜欢什么 / 技术栈是什么。",
  "嗯……这个超出我现在的知识范围了。\n换个问法？比如「介绍一下你自己」「最近在做啥」。",
];

/* 本地匹配：关键词加权 */
function localReply(question) {
  const q = question.toLowerCase().trim();
  if (!q) return "你倒是问啊。";
  let best = null;
  let bestScore = 0;
  for (const item of KB) {
    let score = 0;
    for (const kw of item.keywords) {
      if (q.includes(kw.toLowerCase())) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best ? best.answer : FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

/* ============================================================
   运行时状态
   ============================================================ */
let backendReady = false; // 本地后端是否可用（探活通过 + 已配 key）
let modelName = "";       // 后端实际使用的模型名，仅用于状态徽标显示
let controller = null;    // 当前请求，用于中止
const history = []; // 最近若干轮对话（模型上下文）
const MAX_HISTORY = 20; // 最多带 20 条消息（≈10 轮问答），与后端 MAX_TURNS 对齐
const MAX_INPUT = 500;

/* 把一条消息推进上下文，并裁掉过老的。
   发送时虽然也 slice(-MAX_HISTORY)，但本地这个数组本身只增不减 ——
   一次聊得久了，它会从第一句一直存到现在，纯属白占内存。 */
function pushHistory(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

/* ---------- DOM ---------- */
const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const quickBox = document.getElementById("quickQuestions");
const statusEl = document.getElementById("aiStatus");

function setStatus(kind, text) {
  if (!statusEl) return;
  statusEl.className = "status status-" + kind;
  statusEl.textContent = text;
}

function addMessage(text, who) {
  const el = document.createElement("div");
  el.className = "msg msg-" + who;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "msg msg-notice";
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showTyping() {
  const el = document.createElement("div");
  el.className = "msg msg-bot typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

/* ---------- 初始化：探活本地后端 + 检查 key ---------- */
async function initCloud() {
  try {
    const resp = await fetch(`${API_BASE}/api/health`);
    const data = await resp.json();
    if (!data.hasKey) {
      backendReady = false;
      setStatus("offline", "离线知识库模式（服务器未配 key）");
      return;
    }
    backendReady = true;
    modelName = data.model || "deepseek";
    setStatus("online", "已接入 " + modelName);
  } catch (err) {
    console.warn("[local] 后端探活失败", err);
    backendReady = false;
    // 这是访客能看到的文案，别把 server.py、key 这类实现细节写进去
    setStatus("offline", "离线知识库模式（AI 暂时连不上）");
  }
}

/* ---------- 错误文案 ---------- */
function errorText(err) {
  if (!err) return "调用失败：未知错误";
  // 两处来源的字段名不同：浏览器 fetch 抛异常用 code，后端转发层用 error，都认
  if (err.code === "network" || err.error === "network")
    return "网络错误：" + (err.message || "");
  // 限流：后端的文案是给访客看的（"问得太快了，等 3 秒再问"），直接透传
  if (typeof err.error === "string" && err.error.startsWith("chat_"))
    return err.message || "问得有点快，歇一会儿再问";
  if (err.error === "forbidden_origin")
    return "这个页面没有调用权限，请回到主页再试";
  if (err.error && err.error.startsWith("upstream_"))
    return "DeepSeek 返回错误（" + err.error + "）";
  return "调用失败：" + (err.message || "未知错误");
}

/* ---------- 主流程 ---------- */
async function ask(rawQuestion) {
  const question = (rawQuestion || "").trim().slice(0, MAX_INPUT);
  if (!question || controller) return;

  addMessage(question, "user");
  chatInput.value = "";

  if (!backendReady) {
    const typing = showTyping();
    setTimeout(() => {
      typing.remove();
      addMessage(localReply(question), "bot");
    }, 400);
    return;
  }

  await askLLM(question);
}

async function askLLM(question) {
  controller = new AbortController();
  sendBtn.textContent = "停止";
  sendBtn.classList.add("is-stop");
  chatInput.disabled = true;

  const botEl = addMessage("", "bot");
  pushHistory({ role: "user", content: question });

  let acc = "";
  let failed = null;

  try {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: history.slice(-MAX_HISTORY),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // 后端出错时返回的是 JSON（{ error, message }）。尽量把它的文案读出来，
      // 否则访客只看到一句 "HTTP 429"，不知道其实是"问得太快了"。
      failed = { error: "http_" + resp.status, message: `HTTP ${resp.status}` };
      try {
        const info = await resp.json();
        if (info && info.error) failed = info;
      } catch (err) {
        /* 响应不是 JSON，就保留上面那句兜底 */
      }
    } else if (!resp.body) {
      failed = { message: "响应没有流式 body" };
    } else {
      // 读取 SSE 流
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 按行解析 SSE
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            buffer = "";
            break;
          }
          try {
            const obj = JSON.parse(payload);
            if (obj.error) {
              failed = obj;
              break;
            }
            if (obj.content) {
              acc += obj.content;
              botEl.textContent = acc;
              chatLog.scrollTop = chatLog.scrollHeight;
            }
          } catch (e) {
            // 不完整的 JSON，放回 buffer 等下一块
            buffer = line + "\n" + buffer;
            break;
          }
        }
        if (failed) break;
      }
    }
  } catch (err) {
    failed = { code: "network", message: err.message || String(err) };
  } finally {
    controller = null;
    sendBtn.textContent = "发送";
    sendBtn.classList.remove("is-stop");
    chatInput.disabled = false;
    chatInput.focus();
  }

  if (failed) {
    history.pop();
    console.warn("[llm] 调用失败", failed);
    addNotice("⚠️ " + errorText(failed) + "\n已改用离线知识库回答：");
    botEl.remove();
    addMessage(localReply(question), "bot");
    return;
  }

  if (!acc.trim()) {
    botEl.textContent = "（模型这次没说话，再问一次？）";
    history.pop();
    return;
  }

  pushHistory({ role: "assistant", content: acc });
}

/* ---------- 事件 ---------- */
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (controller) return;
  ask(chatInput.value);
});

/* 生成中点按钮 = 停止 */
sendBtn.addEventListener("click", (e) => {
  if (controller) {
    e.preventDefault();
    controller.abort();
  }
});

quickBox.addEventListener("click", (e) => {
  const btn = e.target.closest(".q-chip");
  if (btn && !controller) ask(btn.textContent);
});

/* ---------- 启动 ---------- */
addMessage(
  "嗨，我是赵泉恩的数字分身。\n他现在在学开发、做一个图库管理 App。\n有什么想问的？下面几个问题可以直接点。",
  "bot"
);
setStatus("loading", "正在连接模型…");
initCloud();
