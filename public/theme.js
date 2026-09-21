/* ============================================================
   主题切换：浅色 / 深色 / 跟随系统
   ------------------------------------------------------------
   ⚠️ 这个文件必须放在 <head> 里、**样式表之前**同步执行。
   原因：它要在浏览器第一次绘制前就把 data-theme 写到 <html> 上。
   如果放到 body 末尾（或加 defer），页面会先按浅色画一帧、再翻成深色，
   表现成打开瞬间"白光一闪"。

   三个入口：
     - <html data-theme="dark|light">   CSS 用它选配色（见 styles.css）
     - <html data-theme-mode="auto|dark|light">   用户选的是哪个档位
     - #themeToggle 按钮                自己找，找到就自动绑，页面里不用写 JS
   ============================================================ */
(function () {
  "use strict";

  var KEY = "zqe_theme";                       // localStorage 里存哪个键
  var MODES = ["auto", "dark", "light"];       // 点击时按这个顺序循环
  var LABEL = { auto: "跟随系统", dark: "深色", light: "浅色" };
  var ICON = { auto: "🌗", dark: "🌙", light: "☀️" };
  var BG_COLOR = { dark: "#0d0a14", light: "#f6f7f9" };  // 手机地址栏颜色，与 --bg 一致

  var media = window.matchMedia("(prefers-color-scheme: dark)");

  /* 读出用户上次选的档位。localStorage 在无痕模式 / 禁用 Cookie 时会抛异常，
     所以全都包在 try 里，读不到就退回跟随系统。 */
  function readMode() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === "dark" || v === "light" || v === "auto") return v;
    } catch (e) { /* 读不到就用默认值 */ }
    return "auto";
  }

  var mode = readMode();

  /* auto 是个中间态：它自己不定颜色，颜色由系统偏好决定。
     这一步把"用户选了什么"翻译成"此刻到底该用哪套配色"。 */
  function resolve(m) {
    if (m === "auto") return media.matches ? "dark" : "light";
    return m;
  }

  /* 把按钮上的图标和文案刷成当前档位。
     首屏调用时按钮还没解析出来（脚本在 head 里跑），所以每个元素都要判空。 */
  function paint() {
    var icon = document.getElementById("themeIcon");
    var label = document.getElementById("themeLabel");
    var btn = document.getElementById("themeToggle");
    if (icon) icon.textContent = ICON[mode] || ICON.auto;
    if (label) label.textContent = LABEL[mode] || LABEL.auto;
    if (btn) {
      btn.setAttribute("aria-label", "主题：" + (LABEL[mode] || LABEL.auto) + "，点击切换");
      btn.setAttribute("title", "主题：" + (LABEL[mode] || LABEL.auto) + "，点击切换");
    }
  }

  function apply(next, persist) {
    mode = next;
    var actual = resolve(next);
    var root = document.documentElement;

    /* 两个属性分工不同：data-theme 是"现在什么颜色"，给 CSS 用；
       data-theme-mode 是"用户选的档位"，给按钮显示用。 */
    root.setAttribute("data-theme", actual);
    root.setAttribute("data-theme-mode", next);

    if (persist) {
      try { localStorage.setItem(KEY, next); } catch (e) { /* 存不了就只管本次会话 */ }
    }

    // 让安卓 Chrome / iOS Safari 的地址栏跟着一起变色
    var meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", BG_COLOR[actual] || BG_COLOR.light);

    paint();
  }

  function cycle(m) {
    return MODES[(MODES.indexOf(m) + 1) % MODES.length];
  }

  /* ---------- 1) 立刻应用，赶在第一次绘制之前 ---------- */
  apply(mode, false);

  /* ---------- 2) 跟随系统：系统在浅/深之间切换时同步过来 ---------- */
  function onSystemChange() {
    // 用户在按钮上手动选了浅色或深色，就不要再被系统覆盖
    if (mode === "auto") apply("auto", false);
  }

  if (media.addEventListener) media.addEventListener("change", onSystemChange);
  else if (media.addListener) media.addListener(onSystemChange); // 老 Safari 的写法

  /* ---------- 3) 别的标签页改了主题，这个标签页也跟着变 ---------- */
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    var v = e.newValue;
    if (v === "dark" || v === "light" || v === "auto") apply(v, false);
  });

  /* ---------- 4) 绑按钮 ---------- */
  function bind() {
    var btn = document.getElementById("themeToggle");
    if (btn) {
      btn.addEventListener("click", function () {
        apply(cycle(mode), true);
      });
    }
    paint(); // 此刻按钮已在 DOM 里，把图标文案补上
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
