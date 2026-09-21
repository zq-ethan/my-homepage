/* ============================================================
   赵泉恩 · 个人主页 / 留言板前端
   - 数据来自 /api/messages（本地 server.py，线上 Cloudflare Function）
   - 两条硬规则：
     1) 所有渲染走 textContent，绝不用 innerHTML。留言是陌生人写的，
        一旦用 innerHTML，别人塞一句 <img src=x onerror=...> 就能偷走访客的东西。
     2) 整个文件包在 IIFE 里。app.js 也是普通脚本，两个都在全局作用域，
        重名的 const（比如 API_BASE）会直接让后加载的脚本整个不执行。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 地址：和 app.js 保持同一套判断 ---------- */
  const API =
    (location.hostname === "localhost" ? "http://localhost:5000" : "") +
    "/api/messages";

  const MAX_CONTENT = 500; // 和 server.py / messages.js 后端的 MAX_CONTENT 对齐

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);

  const form = $("msgForm");
  const nameInput = $("msgName");
  const contentInput = $("msgContent");
  const privateBox = $("msgPrivate");
  const counter = $("msgCounter");
  const hint = $("msgHint");
  const listBox = $("msgList");
  const sendBtn = $("msgSend");
  const turnstileBox = $("msgTurnstile");

  /* ---------- 运行时状态 ---------- */
  let sending = false;            // 正在提交，防连点
  let turnstileWidget = null;     // 挂件渲染后拿到的 id，reset 时要它
  let turnstileRequired = false;  // 后端配了验证才需要
  let turnstileLoaded = false;    // 挂件只渲染一次
  let hintTimer = null;

  /* ============================================================
     渲染
     ============================================================ */

  function formatTime(iso) {
    const t = new Date(iso).getTime();
    if (!t) return "";
    const diff = Date.now() - t;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + " 天前";
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function makeItem(msg) {
    const item = document.createElement("div");
    item.className = "msg-item";

    const head = document.createElement("div");
    head.className = "msg-item-head";

    const who = document.createElement("span");
    who.className = "msg-item-name";
    who.textContent = msg.name || "匿名";

    const when = document.createElement("span");
    when.className = "msg-item-time";
    when.textContent = formatTime(msg.createdAt);

    head.append(who, when);

    const body = document.createElement("div");
    body.className = "msg-item-body";
    body.textContent = msg.content;

    item.append(head, body);
    return item;
  }

  function renderList(messages) {
    listBox.textContent = ""; // 清空。用 textContent 而不是把标记当字符串塞进去

    if (!messages.length) {
      listBox.appendChild(makeEmpty("还没有人留言，你可以是第一个。"));
      return;
    }
    for (const m of messages) listBox.appendChild(makeItem(m));
  }

  function makeEmpty(text) {
    const el = document.createElement("div");
    el.className = "msg-empty";
    el.textContent = text;
    return el;
  }

  function showHint(text, kind) {
    hint.textContent = text;
    hint.className = "msg-hint msg-hint-" + (kind || "info");
    clearTimeout(hintTimer);
    // 成功提示自动消失；报错就留着，免得他没看清就没了
    if (kind === "ok") {
      hintTimer = setTimeout(() => {
        hint.textContent = "";
        hint.className = "msg-hint";
      }, 4000);
    }
  }

  function updateCounter() {
    counter.textContent = contentInput.value.length + " / " + MAX_CONTENT;
    counter.classList.toggle("is-full", contentInput.value.length >= MAX_CONTENT);
  }

  /* ============================================================
     人机验证（Turnstile）
     - 后端返回 sitekey 才渲染。没配就完全不加载这个脚本，
       页面不引入任何第三方 JS，这本身也是一种干净。
     - 公钥（sitekey）暴露在前端是设计如此；密钥（secret）只在服务端。
     ============================================================ */

  function loadTurnstileScript() {
    return new Promise((resolve, reject) => {
      if (window.turnstile) return resolve();
      const s = document.createElement("script");
      s.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("脚本没加载出来"));
      document.head.appendChild(s);
    });
  }

  function setupTurnstile(data) {
    turnstileRequired = Boolean(data.turnstileRequired);
    const siteKey = data.turnstileSiteKey || "";
    if (!siteKey || turnstileLoaded) return;

    turnstileLoaded = true;
    turnstileBox.hidden = false;

    loadTurnstileScript()
      .then(() => {
        turnstileWidget = window.turnstile.render(turnstileBox, {
          sitekey: siteKey,
          theme: "light",
        });
      })
      .catch((err) => {
        showHint("人机验证没加载出来（" + err.message + "），刷新页面试试", "error");
      });
  }

  /** 取当前挂件里的一次性凭证。没渲染挂件时返回空串。 */
  function readTurnstileToken() {
    if (!turnstileRequired || !window.turnstile || turnstileWidget === null) return "";
    return window.turnstile.getResponse(turnstileWidget) || "";
  }

  /** Turnstile 的凭证验证一次就作废，必须 reset 才能拿到新的给下次用 */
  function resetTurnstile() {
    if (turnstileWidget !== null && window.turnstile) {
      try {
        window.turnstile.reset(turnstileWidget);
      } catch (err) {
        /* 挂件可能已经被销毁，忽略 */
      }
    }
  }

  /* ============================================================
     拉列表
     ============================================================ */

  async function load() {
    try {
      const resp = await fetch(API, { headers: { Accept: "application/json" } });
      const data = await resp.json();

      if (!data.ok) throw new Error(data.message || data.error || "接口返回异常");

      renderList(data.messages || []);
      setupTurnstile(data);
    } catch (err) {
      // 后端没配 D1、或者根本没部署留言接口时，页面不能白屏
      listBox.textContent = "";
      listBox.appendChild(makeEmpty("留言区暂时连不上，稍后刷新试试。"));
      showHint("留言加载失败：" + (err.message || err), "error");
    }
  }

  /* ============================================================
     提交
     ============================================================ */

  async function submit() {
    if (sending) return;

    const content = contentInput.value.trim();
    if (!content) {
      showHint("先写点什么再发", "error");
      contentInput.focus();
      return;
    }

    const token = readTurnstileToken();
    if (turnstileRequired && !token) {
      showHint("先完成上面的人机验证", "error");
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "发送中…";

    try {
      const resp = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value,
          content: content,
          isPrivate: privateBox.checked,
          turnstileToken: token,
        }),
      });
      const data = await resp.json();

      if (!data.ok) {
        showHint(data.message || "发送失败，稍后再试", "error");
        resetTurnstile();
        return;
      }

      // 成功：清空正文（昵称和悄悄话开关留着，连发两条不用重填）
      contentInput.value = "";
      updateCounter();
      resetTurnstile();

      if (data.visible) {
        showHint("发出去了，就在下面。", "ok");
        await load(); // 重新拉一次，顺序和别人的留言混在一起才是真实顺序
      } else {
        showHint("悄悄话已送到，只有他能看到。", "ok");
      }
    } catch (err) {
      showHint("网络错误：" + (err.message || err), "error");
      resetTurnstile();
    } finally {
      sending = false;
      sendBtn.disabled = false;
      sendBtn.textContent = "发送";
    }
  }

  /* ============================================================
     事件
     ============================================================ */

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  contentInput.addEventListener("input", updateCounter);

  // Ctrl / Cmd + Enter 快捷发送，跟聊天框的习惯一致
  contentInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });

  /* ---------- 启动 ---------- */
  turnstileBox.hidden = true; // 拿到 sitekey 才显示
  updateCounter();
  load();
})();
