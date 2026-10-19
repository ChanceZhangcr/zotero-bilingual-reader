/* eslint-env mozilla */
/**
 * Bilingual Paper Reader — 插件引导脚本
 *
 * 生命周期钩子与 Zotero 官方示例（make-it-red / Zotero 7+ 插件文档）一致：
 * https://www.zotero.org/support/dev/zotero_7_for_developers
 *
 * 注意：本文件运行在 Zotero 插件沙箱的全局作用域里，
 * 所有顶层函数/变量都是该沙箱的全局，不要改名（Zotero 按名字调用）。
 */

var chromeHandle;
var bilingualRootURI;

/**
 * 启动探针：写到 %TEMP%，**不依赖 Zotero 的任何 API**。
 * 目的：区分"bootstrap 根本没被调用"和"调用了但 startup 抛异常"。
 * 排查完可删掉这一段。
 */
var BILINGUAL_PROBE = "bilingual-probe.log";
function probe(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    const file = PathUtils.join(PathUtils.tempDir, BILINGUAL_PROBE);
    // 异步追加写；不 await，出错也不影响主流程
    IOUtils.writeUTF8(file, msg, { append: true }).catch(() => {});
  }
  catch (e) {
    // PathUtils/IOUtils 都不可用时，退回到 Zotero 调试输出
    try {
      Zotero.debug(`[Bilingual] probe: ${line}`);
    }
    catch (_) {}
  }
}

function install(data, reason) {
  probe(`install() reason=${reason}`);
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  probe(`startup() 进入 id=${id} version=${version} reason=${reason}`);
  try {
    await startupInner({ id, version, resourceURI, rootURI }, reason);
    probe("startup() 正常结束");
  }
  catch (e) {
    // 关键：把异常写进探针，否则 Zotero 只会静默吞掉
    probe(`startup() 抛异常: ${e && e.stack ? e.stack : e}`);
    try {
      Zotero.logError(e);
    }
    catch (_) {}
  }
}

async function startupInner({ id, version, resourceURI, rootURI }, reason) {
  // Zotero 主服务就绪后再初始化。
  // 加超时兜底：万一某个 Promise 一直不 resolve，也不能把启动流程卡死。
  probe("等待 initializationPromise…");
  await Promise.race([
    Zotero.initializationPromise.catch((e) => {
      probe(`initializationPromise 失败: ${e}`);
    }),
    Zotero.Promise.delay(15000),
  ]).catch((e) => probe(`race 失败: ${e}`));
  probe("initializationPromise 阶段结束");

  // rootURI 参数在 Zotero 7+ 才有
  if (!rootURI) {
    rootURI = resourceURI.spec;
  }
  bilingualRootURI = rootURI;

  // 注册 chrome:// 资源，供 CSS / XHTML / 图标引用
  probe("注册 chrome 资源…");
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "bilingual", rootURI + "chrome/content/"],
  ]);

  // 把打包后的主脚本加载进本插件的沙箱全局
  probe("加载主脚本…");
  const ctx = {
    rootURI,
    pluginID: id,
    pluginVersion: version,
  };
  ctx._globalThis = ctx;
  Services.scriptloader.loadSubScript(
    `${rootURI}chrome/content/scripts/bilingual.js`,
    ctx,
  );
  probe(`主脚本已加载; ctx.Bilingual=${typeof ctx.Bilingual}; Zotero.Bilingual=${typeof Zotero.Bilingual}`);

  // 主脚本会把命名空间挂到 Zotero.Bilingual；ctx.X 是同一对象的兜底引用
  const api = Zotero.Bilingual || ctx.Bilingual;
  if (!api?.hooks?.onStartup) {
    probe("❌ 找不到 hooks.onStartup —— 主脚本没有正确初始化");
    Zotero.logError(new Error("[Bilingual] 主脚本未能加载（找不到 hooks.onStartup）"));
    return;
  }
  probe("调用 hooks.onStartup…");
  await api.hooks.onStartup({ id, version, rootURI, ctx });
}

async function onMainWindowLoad({ window }, reason) {
  try {
    await Zotero.Bilingual?.hooks.onMainWindowLoad(window);
  }
  catch (e) {
    Zotero.logError(e);
  }
}

async function onMainWindowUnload({ window }, reason) {
  try {
    Zotero.Bilingual?.hooks.onMainWindowUnload(window);
  }
  catch (e) {
    Zotero.logError(e);
  }
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  // 程序退出时不做事，避免拖慢关闭
  if (reason === APP_SHUTDOWN) {
    return;
  }
  if (!rootURI) {
    rootURI = resourceURI?.spec || bilingualRootURI;
  }

  try {
    if (typeof Zotero === "undefined") {
      Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
        Components.interfaces.nsISupports,
      ).wrappedJSObject;
    }
    // Zotero 会 await bootstrap 方法返回的 Promise，所以这里 await
    // 能让译文缓存真正落盘（否则最后 2 秒的防抖写入会丢）
    await Zotero.Bilingual?.hooks.onShutdown();
  }
  catch (e) {
    // 关闭阶段的异常只记录，不抛出
    try {
      Zotero.logError(e);
    }
    catch (_) {}
  }

  try {
    Cc["@mozilla.org/intl/stringbundle;1"]
      .getService(Components.interfaces.nsIStringBundleService)
      .flushBundles();
  }
  catch (_) {}

  try {
    if (rootURI) {
      Cu.unload(`${rootURI}chrome/content/scripts/bilingual.js`);
    }
  }
  catch (_) {}

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
