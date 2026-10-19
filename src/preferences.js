/* eslint-env mozilla */
/**
 * 设置面板逻辑（运行在 Zotero 首选项窗口的独立沙箱里）
 *
 * 设计决策：整块 UI 用 JS 构建，不依赖 XHTML 片段里的复杂标记。
 * 原因是 XUL 片段 + `html:` 命名空间 + CDATA 样式这一套很容易在
 * "片段何时插入 DOM""命名空间怎么解析"上出问题，而且出问题时
 * 界面只会留一片空白，极难排查。
 * 现在 preferences.xhtml 里只有一个 <vbox id="bilingual-prefs-root">，
 * 其余全部由这里创建；并且带诊断探针 + 兜底错误显示。
 *
 * ⚠️ 本文件不依赖插件的 Zotero.Bilingual（那是另一个沙箱），只保证有
 *    Zotero / document / PathUtils / IOUtils / Services。
 */

(function () {
  // 与 src/00-core.js 的 BILINGUAL_PREFS_PREFIX 保持一致
  const PREFIX = "extensions.zotero.bilingualReader";
  const P = (key) => `${PREFIX}.${key}`;
  const ROOT_ID = "bilingual-prefs-root";

  /** 诊断探针：写到 %TEMP%，用来判断脚本有没有跑、DOM 有没有起来 */
  function probe(line) {
    try {
      const file = PathUtils.join(PathUtils.tempDir, "bilingual-prefs-probe.log");
      IOUtils.writeUTF8(file, `[${new Date().toISOString()}] ${line}\n`, { append: true })
        .catch(() => {});
    }
    catch (e) {}
  }

  probe(`prefs script loaded; readyState=${document.readyState}`);

  try {
    window.addEventListener("error", (ev) => {
      probe(`window error: ${ev?.message} @${ev?.filename}:${ev?.lineno}`);
    });
  }
  catch (e) {}

  /* ------------------------------ pref ------------------------------ */

  // 必须传 global=true，否则键会多一层 extensions.zotero.，prefs.js 默认值全废
  function get(key, fallback) {
    try {
      const v = Zotero.Prefs.get(P(key), true);
      return typeof v === "undefined" || v === null ? fallback : v;
    }
    catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      Zotero.Prefs.set(P(key), value, true);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  /* ---------------------------- DOM 工具 ---------------------------- */

  const H = "http://www.w3.org/1999/xhtml";

  function h(tag, props = {}, children = []) {
    const node = document.createElementNS(H, tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "style") node.setAttribute("style", v);
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      }
      else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    }
    for (const c of [].concat(children)) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  const CSS = `
.bl-wrap { font-size: 13px; max-width: 780px; }
.bl-group {
  margin: 0 0 16px 0; padding: 14px 16px;
  background: var(--material-background, #fff);
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.12));
  border-radius: 8px;
}
.bl-group h2 { margin: 0 0 6px 0; font-size: 13.5px; font-weight: 600; }
.bl-hint { color: var(--fill-secondary, #666); font-size: 12px; line-height: 1.65; margin: 0 0 10px 0; }
.bl-row { display: grid; grid-template-columns: 130px 1fr; gap: 8px 10px; align-items: center; margin-bottom: 8px; }
.bl-row > label { color: var(--fill-primary, #222); }
.bl-row input[type=text], .bl-row input[type=password], .bl-row input[type=number], .bl-row select {
  width: 100%; box-sizing: border-box; padding: 4px 7px;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.25)); border-radius: 5px;
  background: var(--material-background, #fff); color: inherit; font: inherit;
}
.bl-btn {
  font: inherit; padding: 4px 12px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.25));
  background: var(--material-button, #f5f5f5); color: inherit;
}
.bl-btn:hover { background: var(--color-accent, #407bd2); color: #fff; border-color: transparent; }
.bl-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.bl-status { font-size: 12px; color: var(--fill-secondary, #555); line-height: 1.65; }
.bl-err {
  padding: 12px 14px; margin: 12px; font-size: 13px; line-height: 1.7;
  color: #b3261e; border: 1px solid #b3261e; border-radius: 8px;
}
`;

  /* ---------------------------- 构建 UI ---------------------------- */

  function buildUI(root) {
    const wrap = h("div", { class: "bl-wrap" });
    wrap.appendChild(h("style", { text: CSS }));

    const engineSelect = h("select", { id: "bl-engine" }, [
      h("option", { value: "tencent", text: "腾讯交互翻译（国内直连 · 免密钥 · 推荐）" }),
      h("option", { value: "youdao", text: "有道翻译（国内直连 · 免密钥 · 短文本快）" }),
      h("option", { value: "mymemory", text: "MyMemory（免密钥 · 匿名每天约 1000 词）" }),
      h("option", { value: "google", text: "Google 翻译（国内需代理 · 较慢）" }),
      h("option", { value: "deepseek", text: "DeepSeek（需 API Key，质量最好）" }),
      h("option", { value: "openai", text: "OpenAI 兼容端点（需 API Key）" }),
    ]);

    const engineStatus = h("div", { class: "bl-status", id: "bl-engine-status" });
    const testStatus = h("span", { class: "bl-status", id: "bl-test-status" });

    const engineGroup = h("div", { class: "bl-group" }, [
      h("h2", { text: "翻译引擎" }),
      h("p", {
        class: "bl-hint",
        text: "这些免费引擎都**不用注册、不用密钥、不用翻墙**："
          + "腾讯交互翻译（默认，国内直连，支持整篇批量）最快；"
          + "有道适合划词短句；MyMemory 是国外的兜底。"
          + "想更高质量的学术翻译（术语更准、长句更通顺），可切换到 DeepSeek 或任意 "
          + "OpenAI 兼容端点，填自己的 API Key（本地 Ollama 填 http://127.0.0.1:11434/v1 也行）。",
      }),
      h("div", { class: "bl-row" }, [h("label", { text: "引擎" }), engineSelect]),
      engineStatus,
      h("div", { class: "bl-actions" }, [
        h("button", { class: "bl-btn", id: "bl-test", text: "测试当前引擎" }),
        testStatus,
      ]),
    ]);

    // DeepSeek
    const dsKey = h("input", { type: "password", id: "bl-deepseek-key", placeholder: "sk-..." });
    const dsUrl = h("input", { type: "text", id: "bl-deepseek-url" });
    const dsModel = h("input", { type: "text", id: "bl-deepseek-model" });
    const dsBox = h("div", { class: "bl-group", id: "bl-deepseek", hidden: "hidden" }, [
      h("h2", { text: "DeepSeek 设置" }),
      h("p", { class: "bl-hint", text: "在 platform.deepseek.com 申请 API Key。密钥只保存在本机 Zotero 配置里。" }),
      h("div", { class: "bl-row" }, [h("label", { text: "API Key" }), dsKey]),
      h("div", { class: "bl-row" }, [h("label", { text: "接口地址" }), dsUrl]),
      h("div", { class: "bl-row" }, [h("label", { text: "模型" }), dsModel]),
    ]);

    // OpenAI 兼容
    const oaKey = h("input", { type: "password", id: "bl-openai-key", placeholder: "sk-..." });
    const oaUrl = h("input", { type: "text", id: "bl-openai-url" });
    const oaModel = h("input", { type: "text", id: "bl-openai-model" });
    const oaConc = h("input", { type: "number", id: "bl-concurrency", min: "1", max: "4", step: "1" });
    const oaBox = h("div", { class: "bl-group", id: "bl-openai", hidden: "hidden" }, [
      h("h2", { text: "OpenAI 兼容端点设置" }),
      h("p", {
        class: "bl-hint",
        text: "任何兼容 /v1/chat/completions 的服务都可以：OpenAI、通义千问、Kimi、智谱，"
          + "或本地 Ollama / vLLM / LM Studio。接口地址填到域名或 /v1 之前为止。",
      }),
      h("div", { class: "bl-row" }, [h("label", { text: "API Key" }), oaKey]),
      h("div", { class: "bl-row" }, [h("label", { text: "接口地址" }), oaUrl]),
      h("div", { class: "bl-row" }, [h("label", { text: "模型" }), oaModel]),
      h("div", { class: "bl-row" }, [h("label", { text: "并发数" }), oaConc]),
    ]);

    // 阅读与对照
    const showSource = h("input", { type: "checkbox", id: "bl-show-source" });
    const paneWidth = h("input", { type: "number", id: "bl-pane-width", min: "20", max: "80", step: "1" });
    const exportMode = h("select", { id: "bl-export-mode" }, [
      h("option", { value: "both", text: "两个版本：中文版 + 中英对照版（推荐）" }),
      h("option", { value: "zh", text: "只要中文版" }),
      h("option", { value: "bilingual", text: "只要中英对照版" }),
    ]);
    const readGroup = h("div", { class: "bl-group" }, [
      h("h2", { text: "阅读与对照" }),
      h("div", { class: "bl-row" }, [
        h("label", { text: "显示原文" }),
        h("span", {}, [showSource, h("span", { class: "bl-hint", text: " 在译文下方用小字显示对应英文段落" })]),
      ]),
      h("div", { class: "bl-row" }, [h("label", { text: "右侧栏宽度" }), paneWidth]),
      h("p", { class: "bl-hint", text: "宽度也可以在阅读器里直接拖动面板左边缘调整。单位是百分比。" }),
      h("div", { class: "bl-row" }, [h("label", { text: "导出文档" }), exportMode]),
      h("p", {
        class: "bl-hint",
        text: "「导出文档」会按这里的设置生成 PDF 挂到条目下面。"
          + "中英对照版按段落对照：英文原文灰色缩进，下面紧跟中文译文，方便核对着看。",
      }),
    ]);

    // 用法
    const usageGroup = h("div", { class: "bl-group" }, [
      h("h2", { text: "用法" }),
      h("p", {
        class: "bl-hint",
        text: "1. 整篇翻译 + 左右对照：打开一篇 PDF，点阅读器右上角的「中译」悬浮按钮，"
          + "或者按 Ctrl+Alt+T。右侧会弹出中文译文栏。",
      }),
      h("p", {
        class: "bl-hint",
        text: "2. 只译一段：在 PDF 里划选一句或一段，浮出的工具条上点「译」，就地给出中文。",
      }),
      h("p", {
        class: "bl-hint",
        text: "3. 也可以走菜单栏「工具 → 双语对照阅读」，或在文献列表里右键一篇论文。",
      }),
      h("p", {
        class: "bl-hint",
        text: "4. 想关掉对照：再按一次 Ctrl+Alt+T，或点面板右上角 ✕。",
      }),
    ]);

    // 缓存与排错
    const cacheStatus = h("span", { class: "bl-status", id: "bl-cache-status" });
    const debugBox = h("input", { type: "checkbox", id: "bl-debug" });
    const cacheGroup = h("div", { class: "bl-group" }, [
      h("h2", { text: "缓存与排错" }),
      h("p", { class: "bl-hint", text: "译文按段落缓存，重复打开同一篇论文不会重复请求接口。" }),
      h("div", { class: "bl-actions" }, [
        h("button", { class: "bl-btn", id: "bl-clear-cache", text: "清除译文缓存" }),
        cacheStatus,
      ]),
      h("div", { class: "bl-row", style: "margin-top:10px;" }, [
        h("label", { text: "调试日志" }),
        h("span", {}, [debugBox, h("span", { class: "bl-hint", text: " 打开后可在「帮助 → 调试输出」看到本插件日志" })]),
      ]),
    ]);

    wrap.append(engineGroup, dsBox, oaBox, readGroup, usageGroup, cacheGroup);
    root.appendChild(wrap);

    /* ------------------------------ 绑定 ------------------------------ */

    const textFields = [
      [dsKey, "deepseekApiKey", ""],
      [dsUrl, "deepseekBaseURL", "https://api.deepseek.com"],
      [dsModel, "deepseekModel", "deepseek-chat"],
      [oaKey, "openaiApiKey", ""],
      [oaUrl, "openaiBaseURL", "https://api.openai.com"],
      [oaModel, "openaiModel", "gpt-4o-mini"],
      [paneWidth, "paneWidth", 46],
      [oaConc, "llmConcurrency", 2],
    ];
    for (const [input, pref, fallback] of textFields) {
      const v = get(pref, fallback);
      input.value = String(v === undefined || v === null ? fallback : v);
      const save = () => {
        let val = input.value;
        if (input.type === "number") {
          val = Number(val);
          if (!Number.isFinite(val)) val = fallback;
        }
        set(pref, val);
      };
      input.addEventListener("change", save);
      input.addEventListener("input", save);
    }

    for (const [input, pref, fallback] of [[showSource, "showSource", true], [debugBox, "debug", false]]) {
      input.checked = !!get(pref, fallback);
      input.addEventListener("command", () => set(pref, !!input.checked));
      input.addEventListener("change", () => set(pref, !!input.checked));
    }

    // 导出模式（两个版本 / 只要中文 / 只要中英对照）
    exportMode.value = String(get("extExportMode", "both"));
    for (const ev of ["command", "change"]) {
      exportMode.addEventListener(ev, () => set("extExportMode", exportMode.value));
    }

    function syncEngineBoxes() {
      const cur = get("engine", "tencent");
      engineSelect.value = cur === "free" ? "tencent" : cur;
      dsBox.hidden = cur !== "deepseek";
      oaBox.hidden = cur !== "openai";
      if (cur === "deepseek") {
        engineStatus.textContent = `当前：DeepSeek · ${get("deepseekModel", "deepseek-chat")}`
          + (String(get("deepseekApiKey", "")).trim() ? "" : " —— 尚未填写 API Key，翻译会报错");
      }
      else if (cur === "openai") {
        engineStatus.textContent = `当前：OpenAI 兼容端点 · ${get("openaiModel", "gpt-4o-mini")}`
          + (String(get("openaiApiKey", "")).trim() ? "" : " —— 尚未填写 API Key，翻译会报错");
      }
      else {
        const labels = {
          tencent: "腾讯交互翻译（国内直连，支持整篇批量）",
          youdao: "有道翻译（短文本最快，长文会限流）",
          mymemory: "MyMemory（匿名额度约每天 1000 词）",
          google: "Google 翻译（国内裸连很慢，建议挂代理）",
        };
        const id = cur === "free" ? "tencent" : cur;
        engineStatus.textContent = `当前：${labels[id] || id}`
          + (get("freeEngineFallback", true) ? " · 失败会自动切到下一个免费引擎" : "");
      }
    }

    engineSelect.addEventListener("command", () => {
      set("engine", engineSelect.value);
      syncEngineBoxes();
    });
    engineSelect.addEventListener("change", () => {
      set("engine", engineSelect.value);
      syncEngineBoxes();
    });
    wrap.querySelector("#bl-test").addEventListener("click", onTest);
    wrap.querySelector("#bl-clear-cache").addEventListener("click", onClearCache);

    async function onClearCache() {
      try {
        const dir = PathUtils.join(Zotero.DataDirectory.dir, "bilingual-reader");
        const file = PathUtils.join(dir, "translation-cache.json");
        if (await IOUtils.exists(file)) await IOUtils.remove(file);
        // 只删文件不够：主脚本内存里还留着一份，2 秒防抖后会原样写回
        try {
          await Zotero.Bilingual?.cache?.clear?.();
        }
        catch (e) {}
        cacheStatus.textContent = "已清除译文缓存。";
      }
      catch (e) {
        cacheStatus.textContent = `清除失败：${e}`;
      }
    }

    async function onTest() {
      testStatus.textContent = "正在测试…";
      try {
        const engine = get("engine", "tencent");
        if (engine !== "deepseek" && engine !== "openai") {
          // 免费引擎：直接借主脚本的引擎实现跑一句，避免这里再抄一遍端点
          const T = Zotero.Bilingual?.translate;
          if (!T?.freeEngineById) {
            testStatus.textContent = "❌ 主脚本未就绪，重启 Zotero 再试。";
            return;
          }
          const eng = T.freeEngineById(engine === "free" ? "tencent" : engine);
          const t0 = Date.now();
          const out = await T._engineTranslateChunk(
            eng,
            ["The alignment problem is essentially contestable."],
            null,
          );
          testStatus.textContent = `✅ ${eng.short} 可用（${Date.now() - t0} ms）：${out[0] || "(空)"}`;
          return;
        }
        const base = String(get(engine === "deepseek" ? "deepseekBaseURL" : "openaiBaseURL", ""))
          .replace(/\/+$/, "").replace(/\/v1$/i, "");
        const key = String(get(engine === "deepseek" ? "deepseekApiKey" : "openaiApiKey", "")).trim();
        const model = get(engine === "deepseek" ? "deepseekModel" : "openaiModel", "");
        if (!key) {
          testStatus.textContent = "❌ 还没填写 API Key。";
          return;
        }
        const xhr = await Zotero.HTTP.request("POST", `${base}/v1/chat/completions`, {
          responseType: "json",
          timeout: 60000,
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: "你是翻译。只输出译文，不要解释。" },
              { role: "user", content: "把这句译成中文：The alignment problem is essentially contestable." },
            ],
          }),
        });
        const data = xhr.response || JSON.parse(xhr.responseText);
        testStatus.textContent = `✅ ${model} 可用：${String(data?.choices?.[0]?.message?.content || "").slice(0, 120)}`;
      }
      catch (e) {
        const detail = e?.xmlhttp?.responseText
          ? String(e.xmlhttp.responseText).slice(0, 200)
          : (e?.message || e);
        testStatus.textContent = `❌ 测试失败：${detail}`;
      }
    }

    syncEngineBoxes();
    probe("UI 构建完成");
  }

  /* ---------------------------- 启动 ---------------------------- */

  function renderFallback(reason) {
    try {
      const host = document.getElementById(ROOT_ID)
        || document.querySelector(".pane-container")
        || document.documentElement;
      const box = document.createElementNS(H, "div");
      box.setAttribute("class", "bl-err");
      box.textContent = `双语论文助手：设置面板没能正常渲染（${reason}）。`
        + "请把 %TEMP%\\bilingual-prefs-probe.log 发给开发者。";
      host.appendChild(box);
      probe(`渲染兜底提示：${reason}`);
    }
    catch (e) {
      probe(`renderFallback 失败：${e}`);
    }
  }

  function boot() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      // 片段没被插入 DOM（例如 parseXULToFragment 解析失败时，
      // Zotero 只会静默吞掉异常，面板就一片空白）。
      // 兜底：直接把界面插进 Zotero 给这个面板准备的容器里。
      probe("未找到 #bilingual-prefs-root，改用容器兜底");
      const host = document.querySelector(".pane-container")
        || document.querySelector("prefpane");
      if (!host) {
        probe("连 .pane-container 也找不到，只能显示提示");
        renderFallback("未找到面板容器");
        return;
      }
      const div = document.createElementNS(H, "div");
      div.id = ROOT_ID;
      div.setAttribute("class", "main-section");
      host.appendChild(div);
      probe("已把界面插进 .pane-container（片段兜底成功）");
      try {
        renderFallbackNote(host);
        buildUI(div);
      }
      catch (e) {
        probe(`兜底构建异常：${e && e.stack ? e.stack : e}`);
        renderFallback(`构建界面异常 ${e}`);
      }
      return;
    }
    root.replaceChildren();
    try {
      buildUI(root);
    }
    catch (e) {
      probe(`buildUI 抛异常：${e && e.stack ? e.stack : e}`);
      renderFallback(`构建界面异常 ${e}`);
    }
  }

  /** 走了片段兜底时给个提示，方便定位（不阻断使用） */
  function renderFallbackNote(host) {
    try {
      const note = document.createElementNS(H, "div");
      note.setAttribute("style",
        "margin:10px 12px;padding:8px 10px;font-size:12px;border-radius:6px;"
        + "background:rgba(255,196,0,.15);border:1px solid rgba(255,196,0,.5);");
      note.textContent = "提示：插件面板片段未能正常注入，已启用兜底渲染（功能不受影响，"
        + "但请把 %TEMP%\\bilingual-prefs-probe.log 发给开发者）。";
      host.insertBefore(note, host.firstChild);
    }
    catch (e) {}
  }

  function whenReady() {
    if (document.getElementById(ROOT_ID)) {
      probe("容器已存在，立即构建");
      boot();
      return;
    }
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      probe(`whenReady 触发：${how}`);
      boot();
    };
    const obs = new MutationObserver(() => {
      if (document.getElementById(ROOT_ID)) {
        obs.disconnect();
        finish("MutationObserver");
      }
    });
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }
    catch (e) {
      probe(`MutationObserver 失败：${e}`);
    }
    setTimeout(() => {
      try {
        obs.disconnect();
      }
      catch (e) {}
      if (document.getElementById(ROOT_ID)) finish("3 秒后找到容器");
      else {
        probe("3 秒超时仍未找到容器");
        renderFallback("容器未出现");
      }
    }, 3000);
  }

  whenReady();
})();
