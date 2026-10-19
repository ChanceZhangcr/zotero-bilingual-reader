/* eslint-env mozilla */
/**
 * 主窗口集成：右键菜单、阅读器悬浮按钮、快捷键、阅读器事件注册
 */

Bilingual.main = (() => {
  const { utils, reader } = Bilingual;

  const FLOATING_BTN_ID = "bilingual-floating-button";
  const FLOATING_ACTION = "bilingual-float";
  const registeredWindows = new WeakSet();
  let readerEventsRegistered = false;
  const menuRegisteredIds = [];
  /** 每个阅读器 document 上的自愈观察器 */
  const selfHealObservers = new WeakSet();
  /** 悬浮按钮挂载失败已经记过日志的 document（避免 1.5 秒一次的看护循环刷屏） */
  const floatingErrorsLogged = new WeakSet();
  /** 阅读器看护循环 */
  let readerWatchdogTimer = null;
  let readerWatchdogStarted = false;

  /* --------------------------- 悬浮按钮 --------------------------- */

  /**
   * 只有一个入口：阅读器右上角的悬浮按钮。
   *
   * 历史：曾经在 Zotero 阅读器工具栏里塞过一个「中译」按钮，但工具栏是 React
   * 组件 + 会 replaceChildren，按钮不但经常被清掉，还和 Translate for Zotero
   * 的红「译」挤在一起，用户反馈"两个按钮重了，删掉工具栏那个"。
   * 现在工具栏按钮整套代码都删了，只剩悬浮按钮（它挂在 body 上，谁也清不掉）。
   */

  /**
   * 悬浮按钮样式：固定在阅读器右上角。
   * 用 position:fixed + 高 z-index，不受 Zotero 布局变化影响；
   * 用 --fill-* / --material-* 变量跟随主题（浅色/深色都对）。
   */
  const FLOATING_CSS = `
#${FLOATING_BTN_ID} {
  position: fixed;
  top: 48px;
  inset-inline-end: 14px;
  z-index: 9999;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  border: 1px solid rgba(0, 0, 0, .12);
  background: var(--material-background, #ffffff);
  color: var(--fill-primary, #1a1a1a);
  font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: .02em;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .18);
  pointer-events: auto;
  transition: background .15s ease, color .15s ease, transform .1s ease;
}
#${FLOATING_BTN_ID}:hover {
  background: var(--color-accent, #407bd2);
  color: #fff;
  border-color: transparent;
  transform: translateY(-1px);
}
#${FLOATING_BTN_ID}:active { transform: translateY(0); }
#${FLOATING_BTN_ID}.active {
  background: var(--color-accent, #407bd2);
  color: #fff;
  border-color: transparent;
}
#${FLOATING_BTN_ID}.dragging {
  cursor: grabbing;
  opacity: .85;
  transform: scale(1.04);
  transition: none;
}
#${FLOATING_BTN_ID}.busy {
  background: var(--color-accent, #407bd2);
  color: #fff;
  border-color: transparent;
  cursor: progress;
}
`;

  /** 按钮/菜单触发的统一动作 */
  async function handleToggleAction(hintReader) {
    const t0 = Date.now();
    setFloatingBusy(true);
    try {
      // hintReader 可能已经过期（阅读器被关掉/重建），要验证它还在列表里
      let target = null;
      if (hintReader && hintReader._iframeWindow) {
        const readers = Zotero.Reader?._readers || [];
        if (readers.includes(hintReader)) target = hintReader;
      }
      if (!target) target = utils.getActiveReader();
      if (!target) {
        utils.log("中译：找不到活动阅读器");
        Zotero.getMainWindow()?.alert?.("请先打开一篇 PDF。");
        return;
      }
      utils.log(`中译被点击（reader=${target.tabID || "?"}）`);
      const opened = await reader.togglePanel(target);
      utils.log(`togglePanel 返回 opened=${opened}（${Date.now() - t0} ms）`);
    }
    catch (e) {
      utils.log(`中译出错：${e?.stack || e}`);
      Zotero.getMainWindow()?.alert?.(`双语论文助手：${e?.message || e}`);
    }
    finally {
      setFloatingBusy(false);
    }
  }

  /** 悬浮按钮的忙碌反馈：点了立刻有反应，不用等面板起来 */
  function setFloatingBusy(busy) {
    try {
      const readers = Zotero.Reader?._readers || [];
      for (const r of readers) {
        const btn = r?._iframeWindow?.document?.getElementById(FLOATING_BTN_ID);
        if (!btn) continue;
        if (busy) {
          btn.classList.add("busy");
          btn.textContent = "…";
        }
        else {
          btn.classList.remove("busy");
          btn.textContent = "中译";
        }
      }
    }
    catch (e) {}
  }

  /**
   * 悬浮按钮：直接挂在阅读器 document 上，**完全不碰 Zotero 的工具栏**。
   *
   * 为什么不用工具栏按钮：工具栏是 React 组件，每次重渲染都 replaceChildren，
   * 插进去的节点会被丢掉（表现是"看得见但点不到"）；而且和 Translate for Zotero
   * 的红「译」挤在一起，两个按钮容易看混。悬浮按钮挂在自己的容器里，
   * 内联 onclick + 键盘可达，谁也清不掉。
   */
  function ensureFloatingButton(readerInstance) {
    let doc = null;
    try {
      doc = readerInstance?._iframeWindow?.document;
      if (!doc || !doc.body) return false;
      if (!utils.getPref("floatingButton", true)) return false;
      if (doc.getElementById(FLOATING_BTN_ID)) return true;

      const styleId = "bilingual-floating-style";
      if (!doc.getElementById(styleId)) {
        const style = doc.createElement("style");
        style.id = styleId;
        style.textContent = FLOATING_CSS;
        (doc.head || doc.documentElement).appendChild(style);
      }

      const btn = doc.createElement("div");
      btn.id = FLOATING_BTN_ID;
      btn.setAttribute("data-bilingual-action", FLOATING_ACTION);
      btn.textContent = "中译";
      btn.title = "双语对照阅读：翻译整篇并在右侧对照\n单击打开 · 拖动换位置 · 双击复位 · 右键设置";
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");

      // 应用已保存的位置（距右侧 / 距顶部，窗口缩放也不会跑偏）
      const saved = getSavedPos();
      if (saved) {
        btn.style.insetInlineEnd = `${saved.x}px`;
        btn.style.top = `${saved.y}px`;
      }

      // 拖动优先于点击：刚拖过就不触发打开面板
      let dragged = false;
      setupDrag(btn, readerInstance?._iframeWindow, () => {
        dragged = true;
        setTimeout(() => {
          dragged = false;
        }, 80);
      });

      btn.onclick = (ev) => {
        try {
          ev.preventDefault();
          ev.stopPropagation();
        }
        catch (e) {}
        if (dragged) return false;
        utils.log("悬浮按钮被点击");
        handleToggleAction(readerInstance);
        return false;
      };

      // 右键就地打开设置（不用先翻译，也不依赖任何 Zotero 菜单）
      btn.oncontextmenu = (ev) => {
        try {
          ev.preventDefault();
          ev.stopPropagation();
        }
        catch (e) {}
        utils.log("悬浮按钮：打开设置");
        openSettings(readerInstance?._iframeWindow);
        return false;
      };

      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          handleToggleAction(readerInstance);
        }
      });

      doc.body.appendChild(btn);
      utils.log("悬浮按钮已挂载");
      Bilingual.logWriter?.writeSync("悬浮按钮已挂载");
      return true;
    }
    catch (e) {
      utils.log(`ensureFloatingButton 失败：${e}`);
      // 只写一次诊断日志（看护循环每 1.5 秒调一次，不能刷屏）
      if (doc && !floatingErrorsLogged.has(doc)) {
        floatingErrorsLogged.add(doc);
        Bilingual.logWriter?.writeSync(`悬浮按钮挂载失败：${e?.stack || e}`);
      }
      return false;
    }
  }

  /**
   * 拖动支持：指针事件 + 4px 阈值（小于它算点击）。
   * 位置用「距右侧 / 距顶部」表示，改窗口大小也不会跑偏。
   */
  function setupDrag(btn, win, onDragged) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originRight = 0;
    let originTop = 0;

    const onDown = (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      moved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = btn.getBoundingClientRect();
      originRight = ((win && win.innerWidth) || 0) - rect.right;
      originTop = rect.top;
      try {
        btn.setPointerCapture?.(ev.pointerId);
      }
      catch (e) {}
    };

    const onMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        btn.classList.add("dragging");
      }
      const right = Math.max(4, originRight - dx);
      const top = Math.max(4, originTop + dy);
      btn.style.insetInlineEnd = `${right}px`;
      btn.style.top = `${top}px`;
      try {
        ev.preventDefault();
      }
      catch (e) {}
    };

    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      btn.classList.remove("dragging");
      try {
        btn.releasePointerCapture?.(ev.pointerId);
      }
      catch (e) {}
      if (moved) {
        const rect = btn.getBoundingClientRect();
        const right = ((win && win.innerWidth) || 0) - rect.right;
        savePos(right, rect.top);
        utils.log(`悬浮按钮位置已保存 right=${Math.round(right)} top=${Math.round(rect.top)}`);
        Bilingual.logWriter?.writeSync(
          `悬浮按钮位置已保存 right=${Math.round(right)} top=${Math.round(rect.top)}`,
        );
        onDragged?.();
      }
    };

    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointermove", onMove);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);

    // 双击复位到默认位置
    btn.addEventListener("dblclick", (ev) => {
      try {
        ev.preventDefault();
        ev.stopPropagation();
      }
      catch (e) {}
      btn.style.insetInlineEnd = `${DEFAULT_POS.right}px`;
      btn.style.top = `${DEFAULT_POS.top}px`;
      savePos(DEFAULT_POS.right, DEFAULT_POS.top);
      utils.log("悬浮按钮位置已复位");
    });
  }

  /**
   * 自愈：阅读器内部重渲染时（切页 / 改窗口大小）body 的子树会被大改，
   * 用 MutationObserver 盯着，悬浮按钮没了就补回来。
   * 靠"事件触发时补一次"总会漏掉某次重渲染，观察器是唯一可靠的办法。
   */
  function startSelfHeal(readerInstance) {
    try {
      const doc = readerInstance?._iframeWindow?.document;
      if (!doc || selfHealObservers.has(doc)) return;
      selfHealObservers.add(doc);
      let scheduled = false;
      const recheck = () => {
        if (scheduled) return;
        scheduled = true;
        // 用 setTimeout 而不是同步补，避免和 React 的渲染循环打架
        setTimeout(() => {
          scheduled = false;
          try {
            ensureFloatingButton(readerInstance);
          }
          catch (e) {}
        }, 120);
      };
      const obs = new MutationObserver(recheck);
      obs.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      utils.log("悬浮按钮自愈观察器已启动");
    }
    catch (e) {
      utils.log(`startSelfHeal 失败：${e}`);
    }
  }

  /**
   * 保底：确保悬浮按钮在位、自愈观察器已挂。
   * 面板从任何入口打开、阅读器刚就绪、看护循环每一轮都会调它（幂等）。
   */
  function ensureReaderUi(readerInstance) {
    try {
      const doc = readerInstance?._iframeWindow?.document;
      if (!doc) return false;
      startSelfHeal(readerInstance);
      return ensureFloatingButton(readerInstance);
    }
    catch (e) {
      utils.log(`ensureReaderUi 失败：${e}`);
      return false;
    }
  }

  /**
   * 阅读器 `renderToolbar` 事件：**不再往工具栏里塞按钮**，
   * 只借这个事件做两件事：给独立阅读器窗口挂快捷键、确保悬浮按钮在位。
   */
  function readerReadyHandler(event) {
    const readerInstance = event?.reader;
    try {
      attachReaderHotkey(event);
      ensureReaderUi(readerInstance);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  /**
   * 启动阅读器看护循环。
   *
   * 为什么需要它：`renderToolbar` 事件在阅读器打开时**不一定触发**，
   * 而且阅读器可能在插件加载前就开着了。这里每 1.5 秒扫一遍已打开的阅读器，
   * 悬浮按钮不在就补上。循环很轻（只是查几个 DOM id），对性能无影响。
   */
  function startReaderWatchdog() {
    if (readerWatchdogStarted) return;
    readerWatchdogStarted = true;
    const tick = () => {
      try {
        const readers = Zotero.Reader?._readers || [];
        for (const r of readers) {
          try {
            const doc = r?._iframeWindow?.document;
            if (!doc) continue;
            // ⚠️ 悬浮按钮必须**每个周期都确保**，不能塞进某个 if 分支里。
            // 之前的写法是 `if (工具栏按钮存在) { ...; continue; }`，
            // 结果 ensureFloatingButton 永远轮不到执行 → 悬浮按钮从不出现。
            ensureFloatingButton(r);
            startSelfHeal(r);
            // 面板若被 Zotero 的重渲染清掉，补回去（只对"本来就开着"的面板生效：
            // closePanel 会把 state 删掉，所以不会把用户关掉的面板又打开）
            try {
              Bilingual.reader?.ensurePanelMounted?.(r);
            }
            catch (e) {}
          }
          catch (e) {}
        }
      }
      catch (e) {}
    };
    tick();
    readerWatchdogTimer = setInterval(tick, 1500);
    utils.log("阅读器看护循环已启动");
  }

  function stopReaderWatchdog() {
    if (readerWatchdogTimer) {
      clearInterval(readerWatchdogTimer);
      readerWatchdogTimer = null;
    }
    readerWatchdogStarted = false;
  }

  /* -------------------- 浮动按钮：拖动与位置记忆 -------------------- */

  const POS_KEY = "floatingPos";
  const DEFAULT_POS = { right: 14, top: 48 };
  const SETTINGS_PANEL_ID = "bilingual-settings-panel";

  function savePos(x, y) {
    try {
      utils.setPref(POS_KEY, `${Math.round(x)},${Math.round(y)}`);
    }
    catch (e) {}
  }

  /**
   * 读取保存的位置（"right,top"）。
   *
   * ⚠️ 这个函数以前**只有调用、没有定义**：`ensureFloatingButton` 里
   * `const saved = getSavedPos()` 直接抛 ReferenceError，被外层 try/catch
   * 吞掉 → 悬浮按钮永远走不到 appendChild 那一行 → "悬浮按钮一直没看见"。
   * 而 utils.log 只写 Zotero.debug（控制台），诊断日志里一点痕迹都没有。
   * 现在：定义补上，异常也写进诊断日志，并且对坏值做钳制（防止越界看不见）。
   */
  function getSavedPos() {
    try {
      const raw = utils.getPref(POS_KEY, "");
      if (!raw) return null;
      const parts = String(raw).split(",");
      if (parts.length < 2) return null;
      const x = Math.round(Number(parts[0]));
      const y = Math.round(Number(parts[1]));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      // 钳制到可视范围内：否则将来窗口变小 / 分辨率变化时按钮会跑到屏幕外
      const host = Zotero.getMainWindow();
      const maxRight = Math.max(4, (host?.innerWidth || 900) - 60);
      const maxTop = Math.max(4, (host?.innerHeight || 700) - 60);
      return {
        x: Math.min(Math.max(4, x), maxRight),
        y: Math.min(Math.max(4, y), maxTop),
      };
    }
    catch (e) {
      return null;
    }
  }

  /**
   * 打开插件设置面板。
   *
   * ⚠️ 不用 cloneInto 往主窗口传回调 —— 悬浮按钮的 onclick 跑在阅读器 iframe 的
   * 窗口里，跨窗口传函数在沙箱权限下会 "Permission denied to pass object to
   * privileged code"（这个坑刚踩过）。所以面板直接挂在当前窗口上。
   */
  function openSettings(win) {
    try {
      const host = win || Zotero.getMainWindow();
      if (!host?.document) return;
      const doc = host.document;
      if (doc.getElementById(SETTINGS_PANEL_ID)) return;

      if (!doc.getElementById(`${SETTINGS_PANEL_ID}-style`)) {
        const style = doc.createElement("style");
        style.id = `${SETTINGS_PANEL_ID}-style`;
        style.textContent = SETTINGS_CSS;
        (doc.head || doc.documentElement).appendChild(style);
      }

      const wrap = doc.createElement("div");
      wrap.id = SETTINGS_PANEL_ID;

      // 引擎名统一走 translate.engineStatus()，别在这里再抄一份判断
      const engineLabel = Bilingual.translate?.engineStatus?.().label
        || utils.getPref("engine", "tencent");
      const exportModeLabel = {
        both: "中文版 + 中英对照版",
        zh: "只要中文版",
        bilingual: "只要中英对照版",
      }[utils.getPref("extExportMode", "both")] || "中文版 + 中英对照版";
      const rows = [
        ["翻译引擎", engineLabel],
        ["导出文档", exportModeLabel],
        ["显示原文", utils.getPref("showSource", true) ? "开（中英对照）" : "关（仅译文）"],
        ["右侧栏宽度", `${utils.getPref("paneWidth", 46)}%`],
        ["悬浮按钮", utils.getPref("floatingButton", true) ? "开（可拖动，双击复位）" : "关"],
      ];

      wrap.innerHTML = [
        "<h2>双语论文助手</h2>",
        "<p class=\"hint\">当前设置（只读概览）：</p>",
        `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${String(v)}</td></tr>`).join("")}</table>`,
        "<p class=\"hint\">修改请点下面的按钮，或走 <b>编辑 → 设置 → 双语论文助手</b>。</p>",
        "<div class=\"actions\">",
        "<button data-act=\"prefs\">打开完整设置</button>",
        "<button data-act=\"reset\">按钮位置复位</button>",
        "<button data-act=\"close\">关闭</button>",
        "</div>",
        "<p class=\"hint mono\" data-role=\"status\"></p>",
      ].join("");

      const status = wrap.querySelector('[data-role="status"]');
      wrap.querySelector('[data-act="close"]').addEventListener("click", () => wrap.remove());
      wrap.querySelector('[data-act="reset"]').addEventListener("click", () => {
        savePos(DEFAULT_POS.right, DEFAULT_POS.top);
        try {
          const btn = reader._iframeWindow?.document?.getElementById(FLOATING_BTN_ID);
          if (btn) {
            btn.style.insetInlineEnd = `${DEFAULT_POS.right}px`;
            btn.style.top = `${DEFAULT_POS.top}px`;
          }
        }
        catch (e) {}
        if (status) status.textContent = "悬浮按钮位置已复位。";
      });
      wrap.querySelector('[data-act="prefs"]').addEventListener("click", () => {
        try {
          Zotero.Utilities.Internal.openPreferences("bilingual-reader-prefs");
          wrap.remove();
        }
        catch (e) {
          if (status) {
            status.textContent = `打开官方设置失败：${e?.message || e}（请手动：编辑 → 设置）`;
          }
        }
      });

      doc.body.appendChild(wrap);
    }
    catch (e) {
      utils.log(`打开设置面板失败：${e}`);
    }
  }

  const SETTINGS_CSS = `
#${SETTINGS_PANEL_ID} {
  position: fixed; top: 70px; right: 18px; z-index: 100000;
  width: 380px; padding: 16px 18px;
  border-radius: 12px;
  background: var(--material-background, #ffffff);
  color: var(--fill-primary, #1a1a1a);
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.15));
  box-shadow: 0 8px 32px rgba(0,0,0,.28);
  font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 13px; line-height: 1.7;
}
#${SETTINGS_PANEL_ID} h2 { margin: 0 0 8px; font-size: 15px; }
#${SETTINGS_PANEL_ID} .hint { color: var(--fill-secondary, #666); font-size: 12px; margin: 6px 0; }
#${SETTINGS_PANEL_ID} .mono { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
#${SETTINGS_PANEL_ID} table { width: 100%; border-collapse: collapse; margin: 8px 0; }
#${SETTINGS_PANEL_ID} th {
  text-align: left; font-weight: 400; color: var(--fill-secondary, #666);
  padding: 3px 8px 3px 0; white-space: nowrap; width: 96px;
}}
#${SETTINGS_PANEL_ID} td { padding: 3px 0; }
#${SETTINGS_PANEL_ID} .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
#${SETTINGS_PANEL_ID} button {
  font: inherit; padding: 5px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--color-panedivider, rgba(0,0,0,.25));
  background: var(--material-button, #f5f5f5); color: inherit;
}
#${SETTINGS_PANEL_ID} button:hover {
  background: var(--color-accent, #407bd2); color: #fff; border-color: transparent;
}
`;

  /* ----------------------------- 右键菜单 ----------------------------- */

  function registerMenus() {
    try {
      if (!Zotero.MenuManager?.registerMenu) {
        utils.log("MenuManager 不可用，跳过菜单注册");
        return;
      }
      const ITEM_LABEL = "双语对照阅读（翻译成中文）";

      // 1) 文献列表右键菜单
      const itemMenuId = Zotero.MenuManager.registerMenu({
        menuID: "bilingual-read-item",
        pluginID: Bilingual.id,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            // ⚠️ MenuData 没有 label 字段（只认 l10nID），直接写 label 会被静默丢弃，
            // 结果是一个空白可点的菜单项。所以在 onShowing 里通过 context.menuElem 设置。
            onShowing: (event, context) => {
              try {
                context.menuElem?.setAttribute("label", ITEM_LABEL);
              }
              catch (e) {}
              const items = context?.items || [];
              const item = items[0];
              const ok = !!(item && Bilingual.paper.resolvePDFAttachment(item));
              context.setEnabled(ok);
              context.setVisible(true);
            },
            onCommand: async (event, context) => {
              const item = (context?.items || [])[0];
              await openItemBilingual(item);
            },
          },
        ],
      });
      menuRegisteredIds.push(itemMenuId);
      utils.log(`右键菜单已注册：${itemMenuId}`);

      // 1b) 文献列表右键 → 导出中文文档（PDF）
      const exportMenuId = Zotero.MenuManager.registerMenu({
        menuID: "bilingual-export-item",
        pluginID: Bilingual.id,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            onShowing: (event, context) => {
              try {
                context.menuElem?.setAttribute("label", "导出中文译文文档（PDF）");
              }
              catch (e) {}
              const item = (context?.items || [])[0];
              context.setEnabled(!!(item && Bilingual.paper.resolvePDFAttachment(item)));
              context.setVisible(true);
            },
            onCommand: async (event, context) => {
              const item = (context?.items || [])[0];
              await exportItemTranslation(item);
            },
          },
        ],
      });
      menuRegisteredIds.push(exportMenuId);

      // 2) 工具菜单 —— 不依赖任何工具栏空间，永远可见，是最可靠的入口
      const toolsMenuId = Zotero.MenuManager.registerMenu({
        menuID: "bilingual-tools",
        pluginID: Bilingual.id,
        target: "main/menubar/tools",
        menus: [
          {
            menuType: "menuitem",
            onShowing: (event, context) => {
              try {
                context.menuElem?.setAttribute(
                  "label",
                  "双语对照阅读（翻译当前 PDF，Ctrl+Alt+T）",
                );
              }
              catch (e) {}
              context.setVisible(true);
              // 有打开的阅读器才可用
              context.setEnabled(!!utils.getActiveReader());
            },
            onCommand: async () => {
              await toggleCurrent();
            },
          },
        ],
      });
      menuRegisteredIds.push(toolsMenuId);
      utils.log(`工具菜单已注册：${toolsMenuId}`);

      // 2b) 工具菜单 → 导出当前阅读器的中文文档
      //     不依赖工具栏空间，也不用先打开面板，是最稳的一条路径
      const toolsExportId = Zotero.MenuManager.registerMenu({
        menuID: "bilingual-tools-export",
        pluginID: Bilingual.id,
        target: "main/menubar/tools",
        menus: [
          {
            menuType: "menuitem",
            onShowing: (event, context) => {
              try {
                context.menuElem?.setAttribute(
                  "label",
                  "把当前论文的中文译文导出为 PDF（挂到条目下）",
                );
              }
              catch (e) {}
              context.setVisible(true);
              context.setEnabled(!!utils.getActiveReader());
            },
            onCommand: async () => {
              const r = utils.getActiveReader();
              if (!r) {
                Zotero.getMainWindow()?.alert?.("请先打开一篇 PDF。");
                return;
              }
              let item = null;
              try {
                item = Zotero.Items.get(reader.normalizeItemId(r.itemID));
              }
              catch (e) {}
              await exportItemTranslation(item);
            },
          },
        ],
      });
      menuRegisteredIds.push(toolsExportId);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  /* ---------------------------- 核心动作 ---------------------------- */

  /** 打开某条文献的 PDF，并立即生成双语对照 */
  async function openItemBilingual(item) {
    if (!item) return;
    const attachment = Bilingual.paper.resolvePDFAttachment(item);
    if (!attachment) {
      Zotero.getMainWindow()?.alert?.("这个条目没有 PDF 附件，无法翻译。");
      return;
    }
    try {
      await Zotero.Reader.open(attachment.id);
      // 等阅读器实例出现
      let readerInstance = null;
      for (let i = 0; i < 40 && !readerInstance; i++) {
        await Zotero.Promise.delay(150);
        readerInstance = utils.getActiveReader();
      }
      if (!readerInstance) throw new Error("阅读器打开超时");
      ensureReaderUi(readerInstance);
      await reader.openPanel(readerInstance, { autoRun: true });
    }
    catch (e) {
      Zotero.logError(e);
      Zotero.getMainWindow()?.alert?.(`双语论文助手：${e?.message || e}`);
    }
  }

  /**
   * 导出某条目的中文译文文档：优先复用译文缓存（不必重新翻译），
   * 只对缺译文的段落请求接口。
   */
  async function exportItemTranslation(item) {
    if (!item) return;
    const win = Zotero.getMainWindow();
    try {
      const attachment = Bilingual.paper.resolvePDFAttachment(item);
      if (!attachment) throw new Error("这个条目没有 PDF 附件");
      // item 可能本身就是 PDF 附件（从阅读器/文献列表右键进来），标题要取父条目的
      const nameSource = Bilingual.exporter.resolveParentItem?.(item) || item;
      const title = `${Bilingual.exporter.displayTitle?.(nameSource) || "论文"}（中文译文）`;

      const progress = new Zotero.ProgressWindow({ closeOnClick: false });
      progress.changeHeadline("正在生成中文译文文档…");
      progress.addDescription(`${title}\n基于已缓存的译文，必要时会补翻缺失段落`);
      progress.show();

      try {
        const result = await Bilingual.paper.translatePaper(item, {
          onStage: (stage) => {
            try {
              if (stage === "extract") progress.addDescription("正在提取 PDF 全文…");
              if (stage === "translate") progress.addDescription("正在补翻缺失段落（其余走缓存）…");
            }
            catch (e) {}
          },
          onProgress: ({ done, total }) => {
            // 只在每 20 段报一次，避免刷屏
            if (total && done > 0 && done % 20 === 0) {
              utils.log(`导出进度 ${done}/${total}`);
              Bilingual.logWriter?.write(`导出进度 ${done}/${total}`);
            }
          },
        });
        const out = await Bilingual.exporter.exportVersions(item, result.pages, {
          format: "pdf",
          log: (m) => utils.log(m),
        });
        progress.close();
        if (!out.results.length) {
          throw new Error(out.errors[0]?.message || "导出失败");
        }
        const done = new Zotero.ProgressWindow({ closeOnClick: true });
        done.changeHeadline(
          out.results.length > 1 ? "已生成 2 个版本" : "已生成中文译文文档",
        );
        const modeNames = out.results
          .map((r) => Bilingual.exporter.MODES?.[r.mode]?.label || r.mode)
          .join(" + ");
        const kb = out.results.map((r) => (r.bytes / 1024).toFixed(0)).join(" + ");
        done.addDescription(
          `${title}\n${modeNames}，${kb} KB，`
          + (out.parentItem ? "已挂到该条目下" : "已作为独立附件加入（这份 PDF 没有父条目）")
          + (out.errors.length ? `\n⚠️ ${out.errors.length} 个版本失败：${out.errors[0].message}` : ""),
        );
        done.startCloseTimer(5000);
        try {
          await Zotero.getActiveZoteroPane?.()?.selectItem?.(out.results[0].item.id);
        }
        catch (e) {}
      }
      catch (e) {
        try {
          progress.close();
        }
        catch (e2) {}
        throw e;
      }
    }
    catch (e) {
      Zotero.logError(e);
      win?.alert?.(`导出中文译文失败：${e?.message || e}`);
    }
  }

  /** 对当前阅读器切换双语面板 */
  async function toggleCurrent() {
    const r = utils.getActiveReader();
    if (!r) {
      Zotero.getMainWindow()?.alert?.("请先打开一篇 PDF，再执行「双语对照阅读」。");
      return;
    }
    // 顺手补一下悬浮按钮（可能被阅读器重渲染清掉）
    ensureReaderUi(r);
    try {
      await reader.togglePanel(r);
    }
    catch (e) {
      Zotero.logError(e);
      Zotero.getMainWindow()?.alert?.(`双语论文助手：${e?.message || e}`);
    }
  }

  /* ----------------------------- 快捷键 ----------------------------- */

  const HOTKEY_TEXT = "Ctrl+Alt+T"; // macOS: Cmd+Option+T

  function isEditableTarget(target) {
    try {
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (target?.isContentEditable) return true;
    }
    catch (e) {}
    return false;
  }

  function onKeyDown(event) {
    try {
      const mac = Zotero.isMac;
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (!mod || !event.altKey || event.shiftKey) return;
      if (event.key?.toLowerCase() !== "t") return;
      // 焦点在输入框里时不拦截
      if (isEditableTarget(event.target)) return;
      const r = utils.getActiveReader();
      if (!r) return;
      event.preventDefault();
      event.stopPropagation();
      reader.togglePanel(r).catch((e) => Zotero.logError(e));
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  /**
   * 阅读器可能开在独立窗口里（Zotero 9 没有 ShortcutManager），
   * 所以往每个阅读器窗口的 document 上也挂一份快捷键监听。
   */
  function attachReaderHotkey(event) {
    try {
      const doc = event?.doc;
      if (!doc || doc.__bilingualHotkeyAttached) return;
      doc.__bilingualHotkeyAttached = true;
      doc.addEventListener("keydown", onKeyDown, true);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  function onMainWindowLoad(win) {
    if (!win || registeredWindows.has(win)) return;
    registeredWindows.add(win);
    try {
      win.addEventListener("keydown", onKeyDown, true);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  function onMainWindowUnload(win) {
    try {
      win?.removeEventListener("keydown", onKeyDown, true);
    }
    catch (e) {}
  }

  function register() {
    // 划词浮窗
    Bilingual.selection.register();

    // 阅读器就绪事件：挂独立阅读器窗口的快捷键 + 确保悬浮按钮在位。
    // （以前这里还负责往工具栏塞按钮，现在工具栏按钮已删掉，只留悬浮按钮）
    if (!readerEventsRegistered) {
      try {
        Zotero.Reader.registerEventListener("renderToolbar", readerReadyHandler, Bilingual.id);
        readerEventsRegistered = true;
      }
      catch (e) {
        Zotero.logError(e);
      }
    }

    // 阅读器右键菜单（视图区域）
    try {
      Zotero.Reader.registerEventListener("createViewContextMenu", (event) => {
        const { reader: readerInstance, params, append } = event;
        if (!append) return;
        append({
          label: "双语对照阅读（翻译成中文）",
          onCommand: () => {
            reader.togglePanel(readerInstance || params?.reader || utils.getActiveReader())
              .catch((e) => Zotero.logError(e));
          },
        });
      }, Bilingual.id);
    }
    catch (e) {
      Zotero.logError(e);
    }

    registerMenus();

    // 阅读器看护循环（renderToolbar 不保证触发、阅读器可能早就开着，这个兜底）
    startReaderWatchdog();
  }

  function unregister() {
    Bilingual.selection.unregister();
    try {
      for (const r of (Zotero.Reader?._readers || [])) {
        try {
          r?._iframeWindow?.document?.removeEventListener("keydown", onKeyDown, true);
        }
        catch (e) {}
      }
    }
    catch (e) {}
    // 注意：**不要**调用 Zotero.Reader.unregisterEventListener()。
    // Zotero 9.0.5 的实现把 filter 条件写反了（reader.js:2559-2561），
    // 调用它会删掉"除这个 handler 以外"的所有监听器 —— 连带废掉其它插件的阅读器 UI。
    stopReaderWatchdog();
    // 清理交给 Zotero 自己按 pluginID 做（reader.js:2473-2477）。
    readerEventsRegistered = false;
    try {
      for (const id of menuRegisteredIds) {
        if (id) Zotero.MenuManager.unregisterMenu(id);
      }
      menuRegisteredIds.length = 0;
    }
    catch (e) {}
  }

  return {
    register,
    unregister,
    onMainWindowLoad,
    onMainWindowUnload,
    openItemBilingual,
    exportItemTranslation,
    toggleCurrent,
    readerReadyHandler,
    ensureReaderUi,
    ensureFloatingButton,
    openSettings,
    startReaderWatchdog,
    stopReaderWatchdog,
    handleToggleAction,
    attachReaderHotkey,
    HOTKEY_TEXT,
    registeredMenus: () => menuRegisteredIds.slice(),
    isReaderEventsRegistered: () => readerEventsRegistered,
  };
})();
