/* eslint-env mozilla */
/**
 * 阅读器内的「左右对照」译文面板
 *
 * 布局原理（基于 Zotero 9 阅读器真实结构，见 resource/reader/reader.html + reader.css）：
 *   阅读器页面 body
 *     ├─ #reader-ui            工具栏 / 侧栏
 *     └─ #split-view           position:absolute; display:flex   ← 真正显示 PDF 的容器
 *          ├─ .primary-view     ← 英文原文 PDF
 *          └─ (本插件) #bilingual-translation-panel  ← 中文译文
 *
 * #split-view 是 flex 容器，所以往里面追加一个固定宽度的兄弟节点即可实现左右分栏，
 * 并给 .primary-view 加 flex:1 让它占满剩余宽度。我们不动 Zotero 自己的
 * --split-view-size / enable-vertical-split-view 那套变量，避免与原生双视图打架。
 */

Bilingual.reader = (() => {
  const { utils, paper, translate, cache } = Bilingual;
  const PANEL_ID = "bilingual-translation-panel";
  const STYLE_ID = "bilingual-reader-style";
  const PANE_WIDTH_KEY = "paneWidth";

  /** 每个 reader 的运行态：WeakMap 以免泄漏 */
  const states = new WeakMap();
  /** 正在打开中的 reader → 那个 Promise（用于"连点不要反向关掉"） */
  const pendingOpens = new WeakMap();

  /**
   * 把各种可能的"条目 id 表示"归一化成单个数字 id。
   *
   * ⚠️ 关键：Zotero 内部的 `reader.itemID` 是**数组** `[id]`
   * （ReaderInstance 是 Proxy，转发到内层 reader）。直接把它丢给
   * `Zotero.Items.get()` 会返回 undefined —— 于是"找不到条目"，
   * 而 run() 早期 return 又不会重置按钮，界面就停在「停止」状态、
   * 一句提示都没有。这个坑踩过。
   */
  function normalizeItemId(value) {
    try {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (Array.isArray(value) && typeof value[0] === "number") return value[0];
      if (value && typeof value === "object") {
        if (typeof value.id === "number") return value.id;
        if (typeof value.itemID === "number") return value.itemID;
        if (Array.isArray(value.itemID) && typeof value.itemID[0] === "number") {
          return value.itemID[0];
        }
      }
    }
    catch (e) {}
    return null;
  }

  /* ------------------------------- 文案 ------------------------------- */

  const L = {
    panelTitle: "中文译文",
    translate: "翻译全文",
    retranslate: "重新翻译",
    bilingualOn: "双语",
    bilingualOff: "仅译文",
    close: "关闭",
    copyAll: "复制全文",
    exportDoc: "导出文档",
    exporting: "导出中…",
    exportDone: "已导出",
    stageExtract: "正在提取 PDF 全文…",
    stageTranslate: "正在翻译",
    stageRender: "正在生成对照视图…",
    done: "翻译完成",
    fromCache: "（命中缓存",
    failed: "翻译失败",
    aborted: "已停止",
    stop: "停止",
    noPDF: "这个条目没有 PDF 附件",
    scanning: "扫描件或文字层为空，无法翻译",
    empty: "译文为空",
    cachedHint: "来自缓存",
    engineLabel: "引擎",
  };

  /* ------------------------------ 样式 ------------------------------- */

  const CSS = `
/* ==== 分栏 ==== */
/* 阅读器 DOM（resource/reader/reader.html，静态结构）：
 *   #reader-ui                 ← 工具栏 / 侧栏
 *   #split-view[display:flex]  ← 真正显示 PDF 的容器
 *     ├─ .primary-view         ← PDF
 *     └─ .secondary-view       ← Zotero 原生双视图用的容器
 *
 * 译文面板作为 #split-view 的**直接子节点**插在 .primary-view 之后。
 * 不放进 .secondary-view，因为：原生分栏会在同一容器里再渲染一份 PDF 抢位置，
 * 而且分栏关闭或 reader.reload() 时 Zotero 会 secondaryViewContainer.replaceChildren()
 * 把面板一起删掉。
 *
 * ⚠️ 不要给 #split-view 加 display 覆盖！它本来就是 flex（reader.css 里写着
 * #split-view 带 position:absolute 和 display:flex），再覆盖一次只会干扰 Zotero
 * 自己的布局（例如 .primary-view 的宽度控制）。
 */
#split-view > #${PANEL_ID} {
  flex: 0 0 auto;
  width: var(--bilingual-pane-width, 46%);
  min-width: 260px;
  max-width: 78%;
}
/* 面板打开期间隐藏原生副视图，避免出现三栏 */
body.bilingual-split-on > #split-view > .secondary-view {
  display: none !important;
}

/* ==== 面板 ==== */
#${PANEL_ID} {
  flex: 0 0 auto;
  width: var(--bilingual-pane-width, 46%);
  min-width: 0;
  max-width: none;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--material-background, #fff);
  color: var(--fill-primary, #1a1a1a);
  border-inline-start: 1px solid var(--color-panedivider, rgba(0,0,0,.15));
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 15px;
  line-height: 1.75;
  overflow: hidden;
  z-index: 5;
}
.bilingual-resizer {
  position: absolute;
  inset-inline-start: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  background: transparent;
  z-index: 6;
}
.bilingual-resizer:hover { background: var(--color-accent, #407bd2); opacity: .45; }

.bilingual-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-panedivider, rgba(0,0,0,.15));
  background: var(--material-toolbar, rgba(0,0,0,.03));
  font-size: 12.5px;
}
.bilingual-title { font-weight: 600; margin-inline-end: auto; white-space: nowrap; }
.bilingual-status {
  color: var(--fill-secondary, #666);
  font-size: 11.5px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bilingual-header button {
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 5px;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.2));
  background: var(--material-button, transparent);
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.bilingual-header button:hover { background: var(--color-accent, #407bd2); color: #fff; border-color: transparent; }
.bilingual-header button:disabled { opacity: .45; cursor: default; }
.bilingual-header button:disabled:hover { background: var(--material-button, transparent); color: inherit; }

.bilingual-help {
  position: relative;
  flex: 0 0 auto;
}
.bilingual-help > summary {
  list-style: none;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.2));
  font-size: 12px;
}
.bilingual-help > summary::-webkit-details-marker { display: none; }
.bilingual-help[open] > summary { background: var(--color-accent, #407bd2); color: #fff; border-color: transparent; }
.bilingual-help-body {
  position: absolute;
  inset-inline-end: 0;
  top: calc(100% + 6px);
  width: 340px;
  max-width: 80vw;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.2));
  background: var(--material-background, #fff);
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font-size: 12.5px;
  line-height: 1.7;
  z-index: 20;
  white-space: normal;
}
.bilingual-help-body ol { margin: 6px 0 0 0; padding-inline-start: 18px; }
.bilingual-help-body li { margin-bottom: 4px; }
.bilingual-help-body b { font-weight: 600; }
.bilingual-help-body .tip {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--color-panedivider, rgba(0,0,0,.15));
  color: var(--fill-secondary, #666);
  font-size: 11.5px;
}

.bilingual-progress {
  flex: 0 0 auto;
  height: 2px;
  background: var(--color-panedivider, rgba(0,0,0,.1));
  overflow: hidden;
  display: none;
}
.bilingual-progress.active { display: block; }
.bilingual-progress > i {
  display: block;
  height: 100%;
  width: 0%;
  background: var(--color-accent, #407bd2);
  transition: width .25s ease;
}

.bilingual-body {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 16px 40vh 16px;
}
.bilingual-page {
  margin-bottom: 22px;
  scroll-margin-top: 8px;
}
.bilingual-page-label {
  position: sticky;
  top: -14px;
  margin: 0 -16px 10px -16px;
  padding: 3px 16px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--fill-secondary, #777);
  background: var(--material-background, #fff);
  border-bottom: 1px dashed var(--color-panedivider, rgba(0,0,0,.12));
  z-index: 2;
}
.bilingual-para {
  margin: 0 0 14px 0;
  padding-inline-start: 10px;
  border-inline-start: 2px solid transparent;
}
.bilingual-para.done { border-inline-start-color: color-mix(in srgb, var(--color-accent, #407bd2) 45%, transparent); }
.bilingual-para .cn { white-space: pre-wrap; word-break: break-word; }
.bilingual-para .en {
  margin-top: 5px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--fill-secondary, #6b6b6b);
  font-family: Georgia, "Times New Roman", serif;
  white-space: pre-wrap;
  word-break: break-word;
}
/*
 * 原文的显示/隐藏。
 * ⚠️ 这里用 display:none + !important 同时覆盖两个方向，绝不依赖外部样式表
 * 的默认值 —— 否则一旦某个规则把 .en 设成隐藏，用户点「双语」也救不回来
 * （原文本该显示却只看到中文，就是这个原因）。
 */
body.bilingual-show-source .bilingual-para .en { display: block !important; }
body:not(.bilingual-show-source) .bilingual-para .en { display: none !important; }
.bilingual-para.error .cn { color: var(--fill-secondary, #a33); font-style: italic; }
.bilingual-placeholder { color: var(--fill-secondary, #888); font-size: 13px; padding: 6px 0; }
.bilingual-empty { color: var(--fill-secondary, #888); text-align: center; padding: 40px 10px; font-size: 13.5px; }
.bilingual-notice {
  flex: 0 0 auto;
  margin: 0;
  padding: 7px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #8a5a00;
  background: rgba(255, 196, 0, .14);
  border-bottom: 1px solid rgba(255, 196, 0, .45);
}
.bilingual-footer {
  margin-top: 18px;
  padding-top: 10px;
  border-top: 1px dashed var(--color-panedivider, rgba(0,0,0,.15));
  font-size: 11.5px;
  color: var(--fill-secondary, #888);
}
`;

  /* ---------------------------- DOM 工具 ----------------------------- */

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function removePanel(doc) {
    doc.getElementById(PANEL_ID)?.remove();
    doc.body?.classList.remove("bilingual-split-on", "bilingual-show-source");
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  /* ------------------------------ 面板 ------------------------------- */

  function buildPanel(reader, doc, onClose) {
    const state = { reader, doc, abort: null, pages: [], running: false, item: null };
    const pane = el(doc, "div");
    pane.id = PANEL_ID;
    pane.style.setProperty("--bilingual-pane-width", `${utils.getPref(PANE_WIDTH_KEY, 46)}%`);

    // 拖拽改宽度
    const resizer = el(doc, "div", "bilingual-resizer");
    resizer.title = "拖动调整宽度";
    pane.appendChild(resizer);

    // 头部
    const header = el(doc, "div", "bilingual-header");
    const title = el(doc, "span", "bilingual-title", L.panelTitle);
    const status = el(doc, "span", "bilingual-status", "");
    const btnBilingual = el(doc, "button", null, L.bilingualOn);
    btnBilingual.title = "切换：中英对照 / 仅中文";
    const btnRun = el(doc, "button", null, L.translate);
    const btnCopy = el(doc, "button", null, L.copyAll);
    const btnExport = el(doc, "button", null, L.exportDoc);
    btnExport.title = "把中文译文生成独立文档，挂到该条目下面（PDF 可标注、可搜索）";
    btnExport.disabled = true;

    // 使用说明（点开的小浮层）
    const help = doc.createElement("details");
    help.className = "bilingual-help";
    const helpSummary = doc.createElement("summary");
    helpSummary.textContent = "?";
    helpSummary.title = "使用说明";
    const helpBody = el(doc, "div", "bilingual-help-body");
    helpBody.innerHTML = [
      "<b>怎么用</b>",
      "<ol>",
      "<li><b>整篇翻译</b>：点阅读器右上角的「中译」悬浮按钮，或按 <b>Ctrl+Alt+T</b>。</li>",
      "<li><b>只译一段</b>：在 PDF 里划选文字，浮出的工具条上点「译」，就地显示中文。</li>",
      "<li><b>调宽度</b>：拖动译文栏左边缘的分隔线。</li>",
      "<li><b>导出文档</b>：生成 PDF 挂到条目下面。默认两个版本 ——「中文译文」和「中英对照」"
        + "（英文原文灰色缩进、下面紧跟中文），要哪个可以在设置里改。</li>",
      "<li><b>关掉对照</b>：再按一次快捷键，或点 ✕。</li>",
      "</ol>",
      "<div class='tip'>",
      "引擎默认是免费 Google 翻译，无需密钥。想换 DeepSeek / OpenAI 兼容端点（学术翻译质量更好），",
      "去 <b>编辑 → 设置 → 双语论文助手</b> 填写 API Key。",
      "<br />译文按段落缓存，重复打开不会重复请求。",
      "</div>",
    ].join("");
    help.append(helpSummary, helpBody);

    const btnClose = el(doc, "button", null, "✕");
    btnClose.title = L.close;
    header.append(title, status, btnBilingual, btnCopy, btnExport, help, btnRun, btnClose);

    const progress = el(doc, "div", "bilingual-progress");
    const bar = doc.createElement("i");
    progress.appendChild(bar);

    const body = el(doc, "div", "bilingual-body");

    pane.append(header, progress, body);

    // 事件
    btnClose.addEventListener("click", () => onClose());
    btnCopy.addEventListener("click", async () => {
      const text = state.pages
        .map((p) => p.paragraphs.map((x) => x.dst || "").join("\n"))
        .join("\n\n");
      if (!text.trim()) return;
      await Zotero.Utilities.Internal.copyTextToClipboard(text);
      status.textContent = "已复制";
      setTimeout(() => (status.textContent = state.statusText || ""), 1500);
    });
    /** 原文是否显示，完全由 body 上的类决定（单一事实来源） */
    function setShowSource(show) {
      try {
        doc.body.classList.toggle("bilingual-show-source", !!show);
        btnBilingual.textContent = show ? L.bilingualOn : L.bilingualOff;
        btnBilingual.setAttribute(
          "title",
          show ? "当前：中英对照（点击只显示中文）" : "当前：仅中文（点击显示英文原文）",
        );
      }
      catch (e) {}
    }

    btnBilingual.addEventListener("click", () => {
      const show = !doc.body.classList.contains("bilingual-show-source");
      setShowSource(show);
      utils.setPref("showSource", show);
    });
    btnRun.addEventListener("click", () => {
      if (state.running) {
        state.abort?.abort();
        return;
      }
      run().catch((e) => {
        utils.log(`整篇翻译失败：${e}`);
        showError(doc, body, e);
      });
    });

    // 拖拽
    let dragging = false;
    resizer.addEventListener("mousedown", (ev) => {
      dragging = true;
      ev.preventDefault();
      const startX = ev.clientX;
      const startW = pane.getBoundingClientRect().width;
      const total = doc.getElementById("split-view")?.getBoundingClientRect().width || doc.body.clientWidth;
      const move = (e) => {
        if (!dragging) return;
        const delta = startX - e.clientX;
        const w = Math.max(240, Math.min(total - 240, startW + delta));
        const pct = (w / total) * 100;
        pane.style.setProperty("--bilingual-pane-width", `${pct}%`);
      };
      const up = () => {
        dragging = false;
        doc.removeEventListener("mousemove", move);
        doc.removeEventListener("mouseup", up);
        const total2 = doc.getElementById("split-view")?.getBoundingClientRect().width || doc.body.clientWidth;
        const pct = (pane.getBoundingClientRect().width / total2) * 100;
        utils.setPref(PANE_WIDTH_KEY, Math.round(pct));
      };
      doc.addEventListener("mousemove", move);
      doc.addEventListener("mouseup", up);
    });

    function setStatus(text) {
      state.statusText = text || "";
      status.textContent = text || "";
    }

    function setProgress(done, total) {
      if (!total) {
        progress.classList.remove("active");
        return;
      }
      progress.classList.add("active");
      bar.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
      if (done >= total) {
        setTimeout(() => progress.classList.remove("active"), 800);
      }
    }

    /* --------------------------- 渲染译文 --------------------------- */

    /**
     * 铺骨架：把整篇的结构和空位一次性建好，每段中文先放 "…"。
     * 之后翻译结果逐块填进来（只改文本节点），不重建 DOM —— 这样
     *   (a) 用户立刻能看到全文轮廓和"正在翻译"的位置，
     *   (b) 不会因为反复 replaceChildren 导致滚动跳动。
     */
    function buildSkeleton(pages) {
      state.pages = pages;
      state.paraEls = new Map();
      body.replaceChildren();
      if (!pages.length) {
        body.appendChild(el(doc, "div", "bilingual-empty", L.empty));
        return;
      }
      let idx = 0;
      for (const page of pages) {
        const pageEl = el(doc, "div", "bilingual-page");
        pageEl.dataset.page = String(page.page);
        pageEl.appendChild(el(doc, "div", "bilingual-page-label", `第 ${page.page} 页`));
        for (const para of page.paragraphs) {
          const p = el(doc, "div", "bilingual-para" + (para.dst ? " done" : ""));
          p.dataset.idx = String(idx);
          const cn = el(doc, "div", "cn", para.dst || "…");
          p.appendChild(cn);
          // 原文**总是**建出来，显示与否交给 body 上的类控制。
          // 若在这里按 pref 条件创建，一旦 pref 读错（或以后被改），
          // 点「双语」也不会有英文可显示。
          p.appendChild(el(doc, "div", "en", para.src));
          pageEl.appendChild(p);
          state.paraEls.set(idx, { row: p, cn, para });
          idx += 1;
        }
        body.appendChild(pageEl);
      }
      let footer = body.querySelector(".bilingual-footer");
      if (!footer) {
        footer = el(doc, "div", "bilingual-footer");
        body.appendChild(footer);
      }
      state.footerEl = footer;
      state.totalParas = idx;
      updateFooter();
      body.scrollTop = 0;
    }

    function updateFooter(meta = {}) {
      if (!state.footerEl) return;
      const engine = translate.engineStatus();
      state.footerEl.textContent = [
        state.totalParas ? `共 ${state.totalParas} 段` : "",
        meta.fromCache ? `${meta.fromCache} 段命中缓存` : "",
        `引擎：${engine.label}`,
      ].filter(Boolean).join(" · ");
    }

    /**
     * 把一块译文填进对应段落行。
     * 优先用 paraIndices（每个翻译单元自带目标行号）—— 超长段落被句切成
     * 多个单元时，它们会折叠回同一行拼接显示。
     * 没有 paraIndices 时退回按 indices / offset 顺序对应。
     */
    function fillTranslations(offset, translations, indices, paraIndices) {
      const map = state.paraEls;
      if (!map || !translations) return 0;
      let filled = 0;
      // 行号 → 该行已拼接的译文片段（一块里同一行可能出现多次）
      const byRow = new Map();
      for (let i = 0; i < translations.length; i++) {
        let paragraphIndex;
        if (paraIndices && typeof paraIndices[i] === "number") {
          paragraphIndex = paraIndices[i];
        }
        else if (indices) {
          paragraphIndex = indices[i];
        }
        else {
          paragraphIndex = offset + i;
        }
        const text = translations[i];
        if (!text) continue;
        if (!byRow.has(paragraphIndex)) byRow.set(paragraphIndex, []);
        byRow.get(paragraphIndex).push(text);
      }
      for (const [paragraphIndex, parts] of byRow) {
        const entry = map.get(paragraphIndex);
        if (!entry) continue;
        // 同一行的多个片段用空格拼接（中文之间加空格不好看，但比丢掉好；
        // 实际上同一行的片段本来就来自同一段的相邻句子）
        const text = parts.join("");
        entry.para.dst = (entry.para.dst ? entry.para.dst + " " : "") + text;
        entry.cn.textContent = entry.para.dst;
        entry.row.classList.add("done");
        filled += 1;
      }
      return filled;
    }

    /** 完整渲染（缓存整体命中或翻译结束后调用） */
    function renderPages(pages, meta = {}) {
      buildSkeleton(pages);
      const map = state.paraEls;
      if (map) {
        for (const { row, cn, para } of map.values()) {
          if (para.dst) {
            cn.textContent = para.dst;
            row.classList.add("done");
          }
        }
      }
      updateFooter(meta);
    }

    function showError(doc2, bodyEl, err) {
      bodyEl.replaceChildren();
      const box = el(doc2, "div", "bilingual-empty");
      box.textContent = `${L.failed}：${err?.message || err}`;
      bodyEl.appendChild(box);
    }

    /**
     * 中途失败时的提示条：插在面板顶部（不动已渲染的译文），
     * 告诉用户"翻到哪了、还剩多少"，并提示再点一次可以续翻（缓存会跳过已完成的）。
     */
    function showPartialNotice(doc2, bodyEl, err, filled, total) {
      try {
        state.pane?.querySelector(".bilingual-notice")?.remove();
        const box = el(doc2, "div", "bilingual-notice");
        box.textContent = `⚠️ 翻译中断：${err?.message || err}`
          + `　已保留 ${filled}/${total} 段译文。点「重新翻译」可继续（已翻好的会走缓存，不会重复请求）。`;
        state.pane?.insertBefore(box, bodyEl);
      }
      catch (e) {
        utils.log(`提示条渲染失败：${e}`);
      }
    }

    /* --------------------------- 执行翻译 --------------------------- */

    function resolveItem() {
      const candidates = [];
      try {
        candidates.push(reader?.itemID);
      }
      catch (e) {}
      try {
        candidates.push(reader?._item?.id);
      }
      catch (e) {}
      try {
        candidates.push(reader?._itemID);
      }
      catch (e) {}
      for (const c of candidates) {
        const id = normalizeItemId(c);
        if (id === null) continue;
        try {
          const item = Zotero.Items.get(id);
          if (item) return item;
        }
        catch (e) {}
      }
      return null;
    }

    async function run() {
      if (state.running) return;
      try {
        // ⚠️ 解析条目的过程必须也在 try 里：否则抛错会变成未处理的 Promise
        // 拒绝，界面既没提示、按钮还停在「停止」状态
        const item = resolveItem();
        if (!item) {
          showError(doc, body, new Error("找不到当前阅读的条目（reader.itemID 解析失败）"));
          btnRun.textContent = L.translate;
          return;
        }
        const attachment = paper.resolvePDFAttachment(item);
        if (!attachment) {
          showError(doc, body, new Error(L.noPDF));
          btnRun.textContent = L.translate;
          return;
        }

        state.running = true;
        btnRun.textContent = L.stop;
        state.abort = new AbortController();
        setStatus(L.stageExtract);
        body.replaceChildren(el(doc, "div", "bilingual-placeholder", L.stageExtract));
        setProgress(0, 1);

        let structureBuilt = false;
        let firstFill = true;

        const result = await paper.translatePaper(item, {
          signal: state.abort.signal,
          onStage: (stage) => {
            if (stage === "extract") setStatus(L.stageExtract);
            if (stage === "translate") setStatus(`${L.stageTranslate}…`);
          },
          // 抽出结构 → 立刻铺骨架，用户马上看到全文轮廓
          onStructure: ({ pages, total }) => {
            buildSkeleton(pages);
            structureBuilt = true;
            setStatus(`共 ${total} 段，${L.stageTranslate}…`);
          },
          onProgress: ({ done, total, cached }) => {
            setProgress(done, total);
            setStatus(
              `${L.stageTranslate} ${done}/${total}`
              + (cached ? `（缓存 ${cached}）` : ""),
            );
          },
          // 每翻完一块 → 增量填进去
          onPartial: ({ offset, translations, indices, paraIndices }) => {
            if (!structureBuilt) return;
            const n = fillTranslations(offset, translations, indices, paraIndices);
            if (n && firstFill) {
              firstFill = false;
              // 首次拿到译文时把视图滚到有内容的地方
              const firstIdx = paraIndices?.find((x) => typeof x === "number")
                ?? (indices ? indices[0] : offset);
              state.paraEls?.get(firstIdx)?.row.scrollIntoView({ block: "nearest" });
            }
          },
        });
        if (!structureBuilt) buildSkeleton(result.pages);
        // 收尾：把最终结果整体对齐一次（防止个别段漏填）
        renderPages(result.pages, {
          paragraphs: result.translated,
          fromCache: result.fromCache,
        });
        state.pane?.querySelector(".bilingual-notice")?.remove();
        const st = translate.getStats?.() || {};
        const failed = st.failedSegments || 0;
        const degraded = st.degradedChunks || 0;
        if (failed > 0) {
          setStatus(`${L.done} · ${result.translated} 段，其中 ${failed} 段失败（可再点一次续翻）`);
        }
        else if (degraded > 0) {
          setStatus(`${L.done} · ${result.translated} 段（${degraded} 块走了逐条降级）`);
        }
        else {
          setStatus(`${L.done} · ${result.translated} 段`);
        }
        btnRun.textContent = L.retranslate;
        // 有译文了，允许导出独立文档
        btnExport.disabled = !(state.pages && state.pages.length);
      }
      catch (e) {
        // 注意 state.abort 可能已经是 null（比如在 run() 早期就出错）
        const aborted = e?.name === "AbortError" || state.abort?.signal?.aborted;
        // ⚠️ 关键：**不要**在这里 replaceChildren 清空面板。
        // 边翻边填的模式下，出错时已经翻好的段落必须留住
        // （"快翻完变成一片空白"就是这么来的）。
        const filled = state.paraEls
          ? [...state.paraEls.values()].filter((x) => x.para.dst).length
          : 0;
        if (aborted) {
          setStatus(`已停止 · 保留 ${filled}/${state.totalParas || 0} 段`);
        }
        else {
          utils.log(`翻译失败：${e}`);
          setStatus(`翻译中断：${e?.message || e}（已保留 ${filled} 段）`);
          showPartialNotice(doc, body, e, filled, state.totalParas || 0);
        }
        btnRun.textContent = L.retranslate;
      }
      finally {
        state.running = false;
        state.abort = null;
        setProgress(1, 1);
      }
    }

    btnExport.addEventListener("click", async () => {
      if (btnExport.disabled) return;
      const item = resolveItem();
      if (!item) {
        alertBox("找不到当前条目");
        return;
      }
      if (!state.pages || !state.pages.length) {
        alertBox("还没有译文可以导出");
        return;
      }
      btnExport.disabled = true;
      const oldText = btnExport.textContent;
      btnExport.textContent = L.exporting;
      try {
        // 按设置导出：默认两个版本（中文版 + 中英对照版）
        const out = await Bilingual.exporter.exportVersions(item, state.pages, {
          format: "pdf",
          log: (m) => utils.log(m),
        });
        if (!out.results.length) {
          throw new Error(out.errors[0]?.message || "导出失败");
        }
        btnExport.textContent = L.exportDone;
        const kb = out.results.map((r) => (r.bytes / 1024).toFixed(0)).join(" + ");
        const names = out.results
          .map((r) => Bilingual.exporter.MODES?.[r.mode]?.label || r.mode)
          .join("、");
        const where = out.parentItem ? "到该条目下" : "（独立附件，见「未分类」）";
        setStatus(`已导出 ${names}（${kb} KB）${where}`);
        if (out.errors.length) {
          setStatus(`部分失败：${out.errors.map((e) => e.message).join("；")}`);
        }
        // 选中新附件，方便用户立刻看到
        try {
          await Zotero.getActiveZoteroPane?.()?.selectItem?.(out.results[0].item.id);
        }
        catch (e) {}
        setTimeout(() => {
          btnExport.textContent = oldText;
          btnExport.disabled = false;
        }, 2500);
      }
      catch (e) {
        utils.log(`导出失败：${e?.stack || e}`);
        // 把真实原因显示出来，而不是笼统的"导出失败"
        alertBox(`导出失败：${e?.message || e}`);
        try {
          Zotero.Bilingual?.logWriter?.writeSync(`导出失败：${e?.stack || e}`);
        }
        catch (e2) {}
        btnExport.textContent = oldText;
        btnExport.disabled = false;
      }
    });

    /** 面板内的即时提示 */
    function alertBox(text) {
      setStatus(text);
      utils.log(text);
    }

    // 初始状态：未翻译
    body.appendChild(el(doc, "div", "bilingual-empty", "点击右上角「翻译全文」开始生成中文译文。"));

    // 同步"是否显示原文"：以 pref 为初始值，之后完全由 setShowSource 管理
    setShowSource(utils.getPref("showSource", true) !== false);

    state.pane = pane;
    state.run = run;
    state.renderPages = renderPages;
    state.setStatus = setStatus;
    return state;
  }

  /* --------------------------- 侧栏滚动同步 --------------------------- */

  function setupScrollSync(reader, state) {
    const win = reader?._iframeWindow;
    const doc = win?.document;
    const splitView = doc?.getElementById("split-view");
    if (!splitView) return;

    const primary = splitView.querySelector(".primary-view");
    const pdfWin = primary?.querySelector("iframe")?.contentWindow;
    const body = state.pane.querySelector(".bilingual-body");
    if (!body) return;

    let syncing = false;
    let lastPage = 0;

    const recompute = () => {
      if (syncing) return;
      try {
        const pdfDoc = pdfWin?.document;
        if (!pdfDoc) return;
        const viewer = pdfDoc.getElementById("viewerContainer") || pdfDoc.documentElement;
        const pages = pdfDoc.querySelectorAll(".page");
        if (!pages.length) return;
        const top = viewer.scrollTop;
        let current = 1;
        for (const pageEl of pages) {
          const num = Number(pageEl.dataset.pageNumber || 0);
          if (pageEl.offsetTop - 80 <= top) current = num || current;
          else break;
        }
        if (current === lastPage) return;
        lastPage = current;
        const target = state.pane.querySelector(`.bilingual-page[data-page="${current}"]`);
        if (!target) return;
        syncing = true;
        // offsetTop 的 offsetParent 是面板（position:relative），要减去 header 高度
        const headerH = state.pane.querySelector(".bilingual-header")?.offsetHeight || 0;
        const labelH = target.querySelector(".bilingual-page-label")?.offsetHeight || 0;
        body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - headerH - labelH);
        setTimeout(() => (syncing = false), 120);
      }
      catch (e) {
        // 跨窗口访问偶发失败，忽略
      }
    };

    try {
      const pdfViewer = pdfWin?.document?.getElementById("viewerContainer");
      pdfViewer?.addEventListener("scroll", recompute, { passive: true });
      state.scrollCleanup = () => {
        try {
          pdfViewer?.removeEventListener("scroll", recompute);
        }
        catch (e) {}
      };
    }
    catch (e) {
      // 忽略
    }
  }

  /* --------------------------- 面板挂载 / 卸载 --------------------------- */

  /**
   * 把面板挂成 #split-view 的直接子节点（紧跟 .primary-view 之后）。
   * 不用原生 .secondary-view：那会被 Zotero 的 replaceChildren() 清掉。
   */
  function mountPanel(reader, doc, pane) {
    const splitView = doc.getElementById("split-view");
    if (!splitView) throw new Error("阅读器结构不兼容（找不到 #split-view）");
    const primary = splitView.querySelector(":scope > .primary-view");
    splitView.insertBefore(pane, primary ? primary.nextSibling : null);
    return { mode: "flex", splitView };
  }

  /** 卸载面板 */
  function unmountPanel(reader, doc, state) {
    if (doc) removePanel(doc);
  }

  /**
   * 把"已经存在但被从 DOM 里挪走"的面板重新挂回去。
   *
   * 为什么需要：Zotero 的阅读器在窗口尺寸变化 / 切页 / 内部重渲染时会把
   * `#split-view` 的子树整体换掉，我们插进去的 pane 就没了 —— 表现为
   * "刚打开的面板自己消失，要再点几下才出来"。这里保留 state（译文都还在），
   * 只把节点补回去，不重新翻译。
   */
  function ensurePanelMounted(reader) {
    const state = states.get(reader);
    if (!state?.pane) return false;
    let doc = null;
    try {
      doc = reader?._iframeWindow?.document;
    }
    catch (e) {
      return false;
    }
    if (!doc) return false;
    if (doc.getElementById(PANEL_ID)) return true;
    try {
      ensureStyle(doc);
      doc.body.classList.add("bilingual-split-on");
      const mounted = mountPanel(reader, doc, state.pane);
      state.mode = mounted.mode;
      reflowPDFView(reader, state);
      return true;
    }
    catch (e) {
      utils.log(`重新挂载面板失败：${e}`);
      return false;
    }
  }

  /**
   * 让 PDF 重新排版到新宽度。
   * 把面板插进 #split-view 后，PDF 所在 iframe 变窄，但 PDF.js 不会自己重算
   * 缩放 —— 不触发重排的话，正文右侧会被裁掉（实测过）。
   */
  function reflowPDFView(reader, state) {
    try {
      const doc = reader?._iframeWindow?.document;
      const pdfWin = doc
        ?.querySelector("#split-view .primary-view iframe")
        ?.contentWindow;
      if (!pdfWin) return;
      try {
        pdfWin.dispatchEvent(new pdfWin.Event("resize"));
      }
      catch (e) {}
      try {
        const app = pdfWin.PDFViewerApplication;
        if (app?.pdfViewer?.resize) app.pdfViewer.resize();
        else if (app?.eventBus) app.eventBus.dispatch("resize", { source: window });
      }
      catch (e) {}
      utils.log("已触发 PDF 重排");
    }
    catch (e) {}
  }

  /* ------------------------------ 对外 ------------------------------- */

  /** 打开（或重建）译文面板并开始整篇翻译 */
  async function openPanel(reader, { autoRun = true } = {}) {
    if (!reader) throw new Error("没有打开的阅读器");
    const ok = await utils.waitForReaderReady(reader);
    if (!ok) throw new Error("阅读器还没就绪，请稍后再试");
    const win = reader._iframeWindow;
    const doc = win.document;
    if (!doc) throw new Error("无法访问阅读器页面");

    ensureStyle(doc);
    let state = states.get(reader);
    if (state && !doc.getElementById(PANEL_ID)) {
      // 面板被外部清掉了（Zotero 重排过阅读器 DOM），先把原节点挂回去：
      // 译文都还在 state 里，重挂比重新翻译划算得多
      if (ensurePanelMounted(reader)) {
        utils.log("面板曾被 Zotero 清掉，已就地挂回");
        Bilingual.logWriter?.writeSync("面板曾被 Zotero 清掉，已就地挂回");
      }
      else {
        try {
          state.scrollCleanup?.();
        }
        catch (e) {}
        states.delete(reader);
        state = null;
      }
    }
    if (!state) {
      doc.body.classList.add("bilingual-split-on");
      // 注意：不要在这里按 pref 加 bilingual-show-source。
      // buildPanel 末尾的 setShowSource() 是唯一的设置入口，
      // 两处都写容易出现"pref 与类不一致"的怪状态。
      const onClose = () => closePanel(reader);
      state = buildPanel(reader, doc, onClose);
      const mounted = mountPanel(reader, doc, state.pane);
      state.mode = mounted.mode;
      utils.log(`译文面板已挂载（mode=${mounted.mode}）`);
      // 顺手确保悬浮按钮在位（面板从任何入口打开都补一次）
      try {
        Bilingual.main.ensureReaderUi?.(reader);
      }
      catch (e) {}
      // 面板占位后 PDF 视口变窄，必须触发重排，否则正文右侧被裁掉
      reflowPDFView(reader, state);
      setTimeout(() => reflowPDFView(reader, state), 400);
      // 等一帧后再设滚动同步，确保 PDF iframe 已挂载
      setTimeout(() => setupScrollSync(reader, state), 300);
      states.set(reader, state);
    }
    else {
      doc.body.classList.add("bilingual-split-on");
    }

    if (autoRun && !state.running && !state.pages.length) {
      // 不要漏 catch：run() 内部的错误如果逃逸成未处理的 Promise 拒绝，
      // 界面就会既没提示又停在「停止」状态（这个坑踩过）
      state.run().catch((e) => {
        utils.log(`run() 未捕获异常：${e}`);
        try {
          state.setStatus?.(L.failed);
          const bodyEl = state.pane?.querySelector(".bilingual-body");
          if (bodyEl) showError(doc, bodyEl, e);
        }
        catch (e2) {}
      });
    }
    return state;
  }

  /** 关闭面板 */
  function closePanel(reader) {
    const state = states.get(reader);
    const doc = reader?._iframeWindow?.document;
    try {
      state?.abort?.abort();
    }
    catch (e) {}
    try {
      state?.scrollCleanup?.();
    }
    catch (e) {}
    unmountPanel(reader, doc, state);
    if (reader) states.delete(reader);
  }

  /**
   * 切换：打开则关、关则开。
   *
   * ⚠️ 必须做"单飞"（single-flight）。以前每次点击都独立跑一遍
   * `打开 → 判断 → 关闭`，而 `openPanel` 里第一个 await 之后面板才真正挂进 DOM。
   * 用户连点两下（或第一次以为没生效又点了一下）时，第二次点击看到的还是
   * "面板不存在"，于是又开一次；等两次都落地又是各自的状态 —— 表现为
   * "要点好几下才能弹出来""双击才行""点一下开了又没了"。
   * 现在：打开过程中再点 = 等这一次打开完成，不再反向关闭。
   */
  async function togglePanel(reader) {
    if (!reader) throw new Error("没有打开的阅读器");
    const pending = pendingOpens.get(reader);
    if (pending) {
      utils.log("面板正在打开中，忽略这次重复点击");
      try {
        await pending;
      }
      catch (e) {}
      return isOpen(reader);
    }
    const doc = reader?._iframeWindow?.document;
    if (doc?.getElementById(PANEL_ID)) {
      closePanel(reader);
      return false;
    }
    const p = openPanel(reader, { autoRun: true });
    pendingOpens.set(reader, p);
    try {
      await p;
      return true;
    }
    finally {
      pendingOpens.delete(reader);
    }
  }

  function isOpen(reader) {
    return !!reader?._iframeWindow?.document?.getElementById(PANEL_ID);
  }

  return {
    openPanel,
    closePanel,
    togglePanel,
    isOpen,
    ensurePanelMounted,
    normalizeItemId,
    L,
    PANEL_ID,
    states,
  };
})();
