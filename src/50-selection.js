/* eslint-env mozilla */
/**
 * 划词即译浮窗
 *
 * 挂在 Zotero 官方阅读器事件 renderTextSelectionPopup 上（见 Zotero 9
 * chrome/content/zotero/xpcom/reader.js 的 JSDoc）：
 *   Zotero.Reader.registerEventListener('renderTextSelectionPopup', (event) => {
 *     let { reader, doc, params, append } = event;
 *     append(container);   // container 会出现在 PDF 选中文字后的浮动工具条里
 *   }, PLUGIN_ID);
 *
 * params.annotation 是即将创建的注释对象，其中 .text 就是选中的原文。
 */

Bilingual.selection = (() => {
  const { utils, translate } = Bilingual;
  const EVENT_TYPE = "renderTextSelectionPopup";
  const BOX_CLASS = "bilingual-selection-box";
  const CSS = `
.${BOX_CLASS} {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-inline-start: 4px;
}
.${BOX_CLASS} .bsb-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.2));
  background: var(--material-button, rgba(255,255,255,.9));
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.${BOX_CLASS} .bsb-btn:hover {
  background: var(--color-accent, #407bd2);
  color: #fff;
  border-color: transparent;
}
.${BOX_CLASS} .bsb-btn[disabled] { opacity: .5; cursor: default; }
.${BOX_CLASS} .bsb-result {
  max-width: 380px;
  max-height: 190px;
  overflow: auto;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--material-background, #fff);
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.18));
  box-shadow: 0 2px 10px rgba(0,0,0,.14);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fill-primary, #1a1a1a);
}
.${BOX_CLASS} .bsb-result.error { color: #b3261e; }
`;

  function ensureStyle(doc) {
    const id = "bilingual-selection-style";
    if (doc.getElementById(id)) return;
    const style = doc.createElement("style");
    style.id = id;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /** 立即翻译选中文字 */
  async function translateSelection(reader, doc, text, { silent = false } = {}) {
    const source = String(text || "").trim();
    if (!source) return "";
    return translate.translateText(source);
  }

  /** 尽力从事件里取选中文字；取不到就从阅读器窗口的选区兜底 */
  function extractSelectedText(event) {
    const { reader, params } = event;
    // 官方路径：params.annotation.text
    // annotation 字面量是 {type, color, sortIndex, pageLabel, position, text}
    // 注意：页码字段叫 pageLabel（字符串，可能是空串），没有 pageNumber
    const ann = params?.annotation;
    let text = ann?.text;
    if (text && text.trim()) {
      return { text, pageLabel: ann?.pageLabel || "" };
    }

    // 兜底 1：params 上的其它可能字段
    for (const key of ["text", "selectedText", "selectionText"]) {
      if (typeof params?.[key] === "string" && params[key].trim()) {
        return { text: params[key], pageLabel: "" };
      }
    }

    // 兜底 2：直接读阅读器里 PDF 页面的选区
    try {
      const win = reader?._iframeWindow;
      const sel = win?.getSelection?.();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        return { text: sel.toString(), pageLabel: String(detectPageNumber(win) || "") };
      }
    }
    catch (e) {}

    return { text: "", pageLabel: "" };
  }

  /** 从 PDF 视图里推断当前页号（用于日志/展示，取不到返回 0） */
  function detectPageNumber(win) {
    try {
      const doc = win.document;
      const primary = doc.querySelector("#split-view .primary-view iframe");
      const pdfWin = primary?.contentWindow;
      const viewer = pdfWin?.document?.getElementById("viewerContainer");
      if (!viewer) return 0;
      const top = viewer.scrollTop;
      let current = 0;
      for (const pageEl of pdfWin.document.querySelectorAll(".page")) {
        const num = Number(pageEl.dataset.pageNumber || 0);
        if (pageEl.offsetTop - 80 <= top) current = num || current;
        else break;
      }
      return current;
    }
    catch (e) {
      return 0;
    }
  }

  /**
   * 事件处理器（Zotero 传进来 { reader, doc, params, append }）
   */
  function handler(event) {
    let { doc, append } = event;
    if (!doc || !append) return;
    const { text } = extractSelectedText(event);
    if (!text || !text.trim()) return;

    ensureStyle(doc);

    const box = doc.createElement("div");
    box.className = BOX_CLASS;

    const btn = doc.createElement("button");
    btn.className = "bsb-btn";
    btn.textContent = "译";
    btn.title = "翻译选中的文字（Bilingual Paper Reader）";
    box.appendChild(btn);

    let resultEl = null;

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;

      if (resultEl) {
        resultEl.remove();
        resultEl = null;
        return;
      }
      btn.disabled = true;
      btn.textContent = "翻译中…";
      try {
        const out = await translateSelection(event.reader, doc, text);
        resultEl = doc.createElement("div");
        resultEl.className = "bsb-result";
        resultEl.textContent = out || "（译文为空）";
        box.appendChild(resultEl);
      }
      catch (e) {
        utils.log(`划词翻译失败：${e}`);
        resultEl = doc.createElement("div");
        resultEl.className = "bsb-result error";
        resultEl.textContent = `翻译失败：${e?.message || e}`;
        box.appendChild(resultEl);
      }
      finally {
        btn.disabled = false;
        btn.textContent = "译";
      }
    });

    append(box);
  }

  /** 注册 / 注销 */
  let registered = false;
  function register() {
    if (registered) return;
    try {
      Zotero.Reader.registerEventListener(EVENT_TYPE, handler, Bilingual.id);
      registered = true;
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  function unregister() {
    if (!registered) return;
    // 注意：**不要**调用 Zotero.Reader.unregisterEventListener()。
    // Zotero 9.0.5 的实现是 this._registeredListeners.filter((x) => x.type === type && x.handler === handler)
    // —— 条件写反了，调用它等于把"除这一个 handler 之外"的所有监听器全删掉，
    // 会连带废掉其它插件的阅读器 UI。
    // 插件停用时 Zotero 会自己调 _unregisterEventListenerByPluginID(id) 清理（reader.js:2473-2477）。
    registered = false;
  }

  return { register, unregister, handler, translateSelection, extractSelectedText };
})();
