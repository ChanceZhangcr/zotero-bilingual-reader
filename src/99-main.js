/* eslint-env mozilla */
/**
 * 插件入口：生命周期钩子（由 bootstrap.js 调用）
 */

Bilingual.hooks = (() => {
  const { utils } = Bilingual;
  let started = false;
  let prefPaneID = null;

  /** 注册设置面板 */
  async function registerPrefPane(rootURI) {
    try {
      if (!Zotero.PreferencePanes?.register) return;
      prefPaneID = await Zotero.PreferencePanes.register({
        pluginID: Bilingual.id,
        src: `${rootURI}chrome/content/preferences.xhtml`,
        id: "bilingual-reader-prefs",
        label: "双语论文助手",
        scripts: [`${rootURI}chrome/content/preferences.js`],
      });
      utils.log(`设置面板已注册：${prefPaneID}`);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  /** 自检：把关键 API 的可用性写进调试日志，方便排错 */
  async function selfTest() {
    const has = (obj, name) => {
      try {
        return typeof obj?.[name] === "function" ? "✅" : "❌";
      }
      catch (e) {
        return "⚠️";
      }
    };
    let dataDir = "(不可用)";
    let diagPath = null;
    try {
      dataDir = (await utils.getDataDirectory()) || "(不可用)";
    }
    catch (e) {}
    try {
      diagPath = await Bilingual.logWriter?.path();
    }
    catch (e) {}
    const menuIds = Bilingual.main.registeredMenus?.() || [];
    const readerEventsInfo = Bilingual.main.isReaderEventsRegistered?.()
      ? "renderToolbar ✅"
      : "renderToolbar ❌";
    const lines = [
      `版本: ${Zotero.version || "?"}`,
      `iOS? 平台: ${Zotero.isMac ? "mac" : (Zotero.isWin ? "windows" : "linux")}`,
      `Zotero.Bilingual 已挂载 ${Zotero.Bilingual === Bilingual ? "✅" : "❌（bootstrap 取不到！）"}`,
      `Zotero.Reader.registerEventListener ${has(Zotero.Reader, "registerEventListener")}`,
      `Zotero.Reader._readers ${Array.isArray(Zotero.Reader?._readers) ? "✅" : "❌"}`,
      `Zotero.PDFWorker.getFullText ${has(Zotero.PDFWorker, "getFullText")}`,
      `Zotero.Fulltext.getItemCacheFile ${has(Zotero.Fulltext, "getItemCacheFile")}`,
      `Zotero.PreferencePanes.register ${has(Zotero.PreferencePanes, "register")}`,
      `Zotero.MenuManager.registerMenu ${has(Zotero.MenuManager, "registerMenu")}`,
      `Zotero.HTTP.request ${has(Zotero.HTTP, "request")}`,
      `Zotero.Attachments.importFromFile ${has(Zotero.Attachments, "importFromFile")}`,
      `CompressionStream ${typeof CompressionStream === "function" ? "✅" : "（无，改用内置 DEFLATE）"}`,
      `内置 DEFLATE ${typeof Bilingual.tools?.deflate?.deflateZlib === "function" ? "✅" : "❌（PDF 导出会失败）"}`,
      `TextEncoder ${typeof TextEncoder === "function" ? "✅" : "❌"}`,
      `PDF 导出模块 ${has(Bilingual.exporter, "exportTranslation")}`,
      `字体子集化模块 ${has(Bilingual.tools?.ttf, "subsetFont")}`,
      `已注册菜单: ${menuIds.join(", ") || "(无)"}`,
      `阅读器事件已注册: ${readerEventsInfo}`,
      `pref 生效(engine=${utils.getPref("engine", "tencent")})`,
      `数据目录 ${dataDir}`,
      `诊断日志 ${diagPath || "(写不进去)"}`,
      `翻译引擎: ${Bilingual.translate.engineStatus().label}`,
    ];
    utils.log(`自检报告\n  ${lines.join("\n  ")}`);
    for (const l of lines) Bilingual.logWriter?.writeSync(`自检 ${l}`);
    return lines;
  }

  async function onStartup({ id, version, rootURI }) {
    if (started) return;
    started = true;
    utils.log(`启动中 v${version} rootURI=${rootURI}`);
    Bilingual.logWriter?.writeSync(`onStartup 进入 v${version}`);

    try {
      // 带超时：某个 Promise 不 resolve 时也不能卡死启动
      await Promise.race([
        Promise.resolve(Zotero.uiReadyPromise).catch(() => {}),
        Zotero.Promise.delay(10000),
      ]);
      Bilingual.logWriter?.writeSync("uiReadyPromise 阶段结束");
    }
    catch (e) {
      // 某些版本没有 uiReadyPromise，忽略
      Bilingual.logWriter?.writeSync(`uiReadyPromise 异常（忽略）: ${e}`);
    }

    Bilingual.logWriter?.writeSync("准备注册菜单/事件…");
    Bilingual.main.register();
    Bilingual.logWriter?.writeSync("菜单/事件注册完成");
    await registerPrefPane(rootURI);
    Bilingual.logWriter?.writeSync("设置面板注册完成");

    // 已经打开的主窗口补挂快捷键
    try {
      for (const win of Zotero.getMainWindows()) {
        Bilingual.main.onMainWindowLoad(win);
      }
    }
    catch (e) {
      Zotero.logError(e);
    }

    selfTest().catch((e) => Zotero.logError(e));
    utils.log("已就绪。");
    Bilingual.logWriter?.writeSync("onStartup 全部完成");

    // 导出能力的详细自检（异步，不阻塞启动）
    checkExportReadiness().catch((e) => Zotero.logError(e));
  }

  /**
   * 检查导出能力并把结论写进诊断日志：
   * 缺哪个模块、字体能不能读到，一目了然——不用再靠"导出失败"三个字猜。
   */
  async function checkExportReadiness() {
    const lines = [];
    try {
      Bilingual.exporter.preflight();
      lines.push("导出环境: ✅ 依赖齐全");
    }
    catch (e) {
      lines.push(`导出环境: ❌ ${e.message}`);
    }
    try {
      const fonts = await Bilingual.exporter.listAvailableFonts();
      lines.push(fonts.length
        ? `可用中文字体: ${fonts.join(", ")}`
        : "可用中文字体: ❌ 一个都读不到（导出 PDF 会失败）");
    }
    catch (e) {
      lines.push(`字体探测失败: ${e?.message || e}`);
    }
    for (const l of lines) {
      utils.log(l);
      Bilingual.logWriter?.writeSync(l);
    }
    return lines;
  }

  function onMainWindowLoad(win) {
    Bilingual.main.onMainWindowLoad(win);
  }

  function onMainWindowUnload(win) {
    Bilingual.main.onMainWindowUnload(win);
  }

  async function onShutdown() {
    utils.log("正在卸载…");
    try {
      Bilingual.main.unregister();
    }
    catch (e) {
      Zotero.logError(e);
    }
    // 关闭所有已打开的译文面板
    try {
      for (const r of (Zotero.Reader?._readers || [])) {
        try {
          Bilingual.reader.closePanel(r);
        }
        catch (e) {}
      }
    }
    catch (e) {}
    // Zotero 会 await bootstrap 的 shutdown 返回值，这里必须 await 才能真落盘
    try {
      await Bilingual.cache.flushNow();
    }
    catch (e) {}
    try {
      for (const win of Zotero.getMainWindows()) {
        Bilingual.main.onMainWindowUnload(win);
      }
    }
    catch (e) {}
    started = false;
  }

  return { onStartup, onMainWindowLoad, onMainWindowUnload, onShutdown, selfTest };
})();
