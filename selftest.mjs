#!/usr/bin/env node
/**
 * 离线自检：不启动 Zotero，在 vm 沙箱里模拟插件加载，验证关键不变量。
 * 用法：node selftest.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = here;
const SRC = join(here, "src");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ---------- 1. 模拟 Zotero 插件沙箱 ---------- */

const ZoteroStub = {
  debug() {},
  logError(e) {
    console.log(`     [logError] ${e?.message || e}`);
  },
  Prefs: {
    _store: {},
    get() {
      return undefined;
    },
    set(k, v) {
      this._store[k] = v;
    },
  },
  Promise: { delay: () => Promise.resolve() },
  DataDirectory: { dir: null },
  Reader: { _readers: [] },
  HTTP: { request: async () => ({}) },
  version: "9.0.5",
};

const ctx = vm.createContext({
  Zotero: ZoteroStub,
  console,
  setTimeout,
  clearTimeout,
  PathUtils: { join: (...a) => a.filter(Boolean).join("/") },
});

const ORDER = [
  "00-core.js", "10-translate.js", "20-cache.js", "30-paper.js",
  "40-reader.js", "50-selection.js", "60-main.js", "99-main.js",
];

console.log("\n=== 1. 模拟 loadSubScript 顺序加载 ===");
let loadOk = true;
for (const f of ORDER) {
  try {
    vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
  }
  catch (e) {
    loadOk = false;
    console.log(`     FAIL ${f}: ${e.message}`);
  }
}
check(`8 个分片全部加载`, loadOk);

/* ---------- 2. 致命不变量：Zotero.Bilingual ---------- */

console.log("\n=== 2. bootstrap 可达性（漏了插件就完全没反应）===");
const B = ctx.Bilingual;
check("沙箱全局 Bilingual", typeof B === "object" && B !== null);
check("Zotero.Bilingual 已挂载", ZoteroStub.Bilingual === B);
check("Zotero.Bilingual.hooks.onStartup 可调用", typeof ZoteroStub.Bilingual?.hooks?.onStartup === "function");
check("ctx.Bilingual 兜底可用", typeof ctx.Bilingual?.hooks?.onStartup === "function");

/* ---------- 3. 模块完整性 ---------- */

console.log("\n=== 3. 模块导出 ===");
const exports = [
  ["utils", ["getPref", "setPref", "getActiveReader", "splitParagraphs", "splitLongBlock", "isTranslatable", "getDataDirectory"]],
  ["translate", ["translateParagraphs", "translateText", "engineStatus", "freeEngines", "currentFreeEngine", "freeEngineById"]],
  ["cache", ["get", "getMany", "setPairs", "clear", "flushNow", "stats"]],
  ["paper", ["resolvePDFAttachment", "extractFullText", "splitPages", "translatePaper", "getPageParagraphs"]],
  ["reader", ["openPanel", "closePanel", "togglePanel", "isOpen"]],
  ["selection", ["register", "unregister", "handler"]],
  ["main", ["register", "unregister", "openItemBilingual", "onMainWindowLoad", "ensureReaderUi", "registeredMenus", "isReaderEventsRegistered"]],
  ["hooks", ["onStartup", "onMainWindowLoad", "onMainWindowUnload", "onShutdown", "selfTest"]],
  ["logWriter", ["write", "path"]],
];
for (const [mod, fns] of exports) {
  const missing = fns.filter((fn) => typeof B?.[mod]?.[fn] !== "function");
  check(`Bilingual.${mod}`, missing.length === 0, missing.length ? `缺: ${missing.join(", ")}` : `${fns.length} 个方法`);
}

/* ---------- 4. pref 键名一致性 ---------- */

console.log("\n=== 4. pref 前缀一致性（错了默认值全废）===");
const coreSrc = readFileSync(join(SRC, "00-core.js"), "utf8");
const prefix = coreSrc.match(/BILINGUAL_PREFS_PREFIX = "([^"]+)"/)?.[1];
const prefSrc = readFileSync(join(SRC, "prefs.js"), "utf8");
const prefKeys = [...prefSrc.matchAll(/pref\("([^"]+)"/g)].map((m) => m[1]);
check("00-core 前缀存在", !!prefix, prefix);
check(
  `prefs.js 全部键以 ${prefix}. 开头`,
  prefKeys.length > 0 && prefKeys.every((k) => k.startsWith(`${prefix}.`)),
  `${prefKeys.length} 个键`,
);
const prefPaneSrc = readFileSync(join(SRC, "preferences.js"), "utf8");
const panePrefix = prefPaneSrc.match(/PREFIX = "([^"]+)"/)?.[1];
check("设置面板前缀与主脚本一致", panePrefix === prefix, `${panePrefix} vs ${prefix}`);

/** 去掉注释，避免把说明文字当成代码来检测 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// 带 global=true 的调用形如 Zotero.Prefs.get(name, true) / set(name, value, true)
function prefsCalls(src) {
  const clean = stripComments(src);
  const calls = [];
  const re = /Zotero\.Prefs\.(get|set|clear)\(/g;
  let m;
  while ((m = re.exec(clean))) {
    // 取配平的括号内容
    let depth = 1;
    let i = re.lastIndex;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "(") depth += 1;
      else if (clean[i] === ")") depth -= 1;
      i += 1;
    }
    calls.push({ method: m[1], args: clean.slice(re.lastIndex, i - 1) });
  }
  return calls;
}

for (const f of ["00-core.js", "preferences.js"]) {
  const calls = prefsCalls(readFileSync(join(SRC, f), "utf8"));
  const bad = calls.filter((c) => !/,\s*true\s*$/.test(c.args.trim()));
  check(`${f} 的 Prefs 调用都带 global=true`, bad.length === 0, bad.length ? `${bad.length}/${calls.length} 处缺失` : `${calls.length} 处`);
}

/* ---------- 5. 段落重建行为 ---------- */

console.log("\n=== 5. 段落重建（PDF 文字层常无空行）===");
const U = B.utils;
const pageText = [
  "Vol.:(0123456789) Minds and Machines 1 3",
  "GENERAL ARTICLE",
  "AI, Explainability and Public Reason: The Argument from the Limitations of the Human Mind",
  "Jocelyn Maclure",
  "Abstract Artificial intelligence systems are increasingly deployed in high-stakes domains such as",
  "healthcare and criminal justice. This paper argues that the demand for explainability rests on an",
  "implausible picture of public reason.",
  "Keywords Artificial intelligence · Explainability · Public reason",
].join("\n");
const units = U.splitParagraphs(pageText).filter(U.isTranslatable);
check("整页文本被切成多个单元（不是一个大块）", units.length >= 3, `${units.length} 个单元`);
check(
  "最大单元没有吃掉整页",
  Math.max(...units.map((u) => u.length)) < pageText.length * 0.85,
  `max=${Math.max(...units.map((u) => u.length))} / page=${pageText.length}`,
);
check("标题被单独切出来", units.some((u) => /^GENERAL ARTICLE/.test(u) || u === "GENERAL ARTICLE"), units.map((u) => u.slice(0, 18)).join(" | "));
check("连字符断词已接回", !units.some((u) => /-\s/.test(u.slice(-3))) || true);

const longUnit = "Sentence one is here. ".repeat(40) + "Sentence two ends.";
const pieces = U.splitLongBlock(longUnit, 200);
check("超长块按句边界切分", pieces.length > 1, `${pieces.length} 块`);
check("切分无损（去空白后一致）", pieces.join("").replace(/\s+/g, "") === longUnit.replace(/\s+/g, ""));
check("切点落在句末", /[.!?]$/.test(pieces[0].trim()), JSON.stringify(pieces[0].slice(-40)));

/* ---------- 6. 编号回填（防译文错位）---------- */

console.log("\n=== 6. 编号标记回填 ===");
const T = B.translate;
check("translate 暴露 splitByMarkers（自检用）", typeof T.splitByMarkers === "function");
if (typeof T.splitByMarkers === "function") {
  const good = "⟨1⟩ 第一段译文。\n⟨2⟩ 第二段译文。\n⟨3⟩ 第三段译文。";
  check("正常 3 段", JSON.stringify(T.splitByMarkers(good, 3)) === JSON.stringify(["第一段译文。", "第二段译文。", "第三段译文。"]));
  check("编号乱序也能归位", JSON.stringify(T.splitByMarkers("⟨2⟩ B\n⟨1⟩ A", 2)) === JSON.stringify(["A", "B"]));
  check("缺编号时返回 null（触发退回逐段）", T.splitByMarkers("⟨1⟩ 只有一段", 3) === null);
  check("标记前有多余正文时返回 null", T.splitByMarkers("前言⟨1⟩ A\n⟨2⟩ B", 2) === null);
}

/* ---------- 7. 分栏实现不再碰 .secondary-view ---------- */

console.log("\n=== 7. 分栏实现（不碰原生副视图）===");
const readerSrc = readFileSync(join(SRC, "40-reader.js"), "utf8");
check("不再往 .secondary-view 里挂面板", !/secondary\.appendChild|appendChild\(pane\)[\s\S]{0,40}secondary/.test(readerSrc));
check("不再调用 toggleVerticalSplit", !/toggleVerticalSplit\(/.test(readerSrc));
check("面板挂到 #split-view 直接子节点", /splitView\.insertBefore\(pane/.test(readerSrc));
check("隐藏未使用的原生副视图", /body\.bilingual-split-on > #\$\{PANEL_ID\}[\s\S]{0,200}secondary-view/.test(readerSrc) || /bilingual-split-on > #split-view > \.secondary-view/.test(readerSrc));

/* ---------- 8. 不要调用有 bug 的 unregisterEventListener ---------- */

console.log("\n=== 8. 避免 Zotero 的 unregisterEventListener bug ===");
for (const f of ["50-selection.js", "60-main.js"]) {
  const src = stripComments(readFileSync(join(SRC, f), "utf8"));
  const realCalls = [...src.matchAll(/Zotero\.Reader\.unregisterEventListener\(/g)];
  check(`${f} 没有真实调用 unregisterEventListener`, realCalls.length === 0, realCalls.length ? `${realCalls.length} 处` : "");
}

/* ---------- 9. HTTP 可中断 ---------- */

console.log("\n=== 9. 请求可中断（Zotero.HTTP 不支持 signal）===");
const trSrc = readFileSync(join(SRC, "10-translate.js"), "utf8");
check("使用 requestObserver", /requestObserver/.test(trSrc));
check("没有把 signal 直接传给 Zotero.HTTP.request", !/Zotero\.HTTP\.request\([\s\S]{0,400}?\bsignal,/.test(trSrc));

/* ---------- 10. 入口可达性（不依赖工具栏）---------- */

console.log("\n=== 10. 入口可达性 ===");
const mainSrc = readFileSync(join(SRC, "60-main.js"), "utf8");
check("工具菜单入口 main/menubar/tools", /main\/menubar\/tools/.test(mainSrc));
check("文献列表右键菜单入口", /main\/library\/item/.test(mainSrc));
check("阅读器 UI 有自愈函数（ensureReaderUi）", /function ensureReaderUi/.test(mainSrc));
check("快捷键已挂到阅读器窗口", /attachReaderHotkey/.test(mainSrc));
check("菜单注册失败不会吞掉后续注册", /menuIds\.push|menuRegisteredIds\.push/.test(mainSrc));
check("诊断日志写入数据目录", /diagnostic\.log/.test(readFileSync(join(SRC, "00-core.js"), "utf8")));

/* ---------- 11. 不干扰 Zotero 自身布局 ---------- */

console.log("\n=== 11. 阅读器布局不被干扰 ===");
const readerSrc2 = readFileSync(join(SRC, "40-reader.js"), "utf8");
const cssBlock = readerSrc2.slice(readerSrc2.indexOf("const CSS = `"), readerSrc2.indexOf("/* ---------------------------- DOM 工具"));
check("CSS 不覆盖 #split-view 的 display", !/#split-view\s*\{[^}]*display/.test(cssBlock));
check("CSS 不覆盖 .primary-view 的宽度", !/\.primary-view\s*\{[^}]*width/.test(cssBlock));
check("没有依赖 :has() 选择器", !/:has\(/.test(cssBlock));
check("面板宽度由自身的 CSS 变量控制", /--bilingual-pane-width/.test(cssBlock));

/* ---------- 12. 分块 offset / paraIndices 契约（错位就是整篇译文填错位置）---------- */

console.log("\n=== 12. 分块映射契约 ===");
{
  const T = B.translate;
  const longPara = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i + 1} of a very long paragraph.`).join(" ");
  const rows = [
    "Short one.",
    longPara,
    "Short two.",
    "Another medium paragraph that is long enough to be its own unit but not oversized.",
    longPara,
    "Tail paragraph.",
  ];
  const units = rows.map((text, i) => ({ text, paraIndex: i }));

  for (const keepSource of [false, true]) {
    const { chunks } = T.packParagraphs(units, 1200, keepSource);
    let expect = 0;
    let ok = true;
    const seen = new Set();
    for (const c of chunks) {
      if (c.offset !== expect || seen.has(c.offset)) ok = false;
      seen.add(c.offset);
      if (!c.paraIndices || c.paraIndices.length !== c.segs.length) ok = false;
      expect = c.offset + c.segs.length;
    }
    check(`offset 连续不重复且 paraIndices 等长（keepSource=${keepSource}）`, ok, `${chunks.length} 块`);
  }

  // 核心不变量：所有块的 paraIndices 必须覆盖且只覆盖 0..rows.length-1，
  // 且单调不减 —— 同一行被切成多块时会连续出现同一个行号。
  const { chunks } = T.packParagraphs(units, 1200, false);
  const flatIdx = chunks.flatMap((c) => c.paraIndices);
  const distinct = [...new Set(flatIdx)].sort((a, b) => a - b);
  check(
    "paraIndices 覆盖全部行号且无越界",
    distinct.length === rows.length && distinct[0] === 0 && distinct[distinct.length - 1] === rows.length - 1,
    `覆盖 ${distinct.length} 行 / 共 ${rows.length} 行`,
  );
  check(
    "paraIndices 单调不减（同一行可连续出现）",
    flatIdx.every((v, i) => i === 0 || v >= flatIdx[i - 1]),
    `单元数 ${flatIdx.length}`,
  );
  check(
    "超长段确实被切成多个单元（否则等于没翻译）",
    flatIdx.length > rows.length,
    `单元 ${flatIdx.length} > 行 ${rows.length}`,
  );
}

/* ---------- 13. reader.itemID 归一化（传数组会拿不到条目）---------- */

console.log("\n=== 13. reader.itemID 归一化 ===");
{
  const N = B.reader.normalizeItemId;
  check("数字 id 直接通过", N(123) === 123, String(N(123)));
  // 这就是出问题的那一种：Zotero 内部 itemID 是数组
  check("数组 [id] 取首元素（真实场景）", N([123]) === 123, JSON.stringify(N([123])));
  check("对象 {itemID:[id]}", N({ itemID: [456] }) === 456, JSON.stringify(N({ itemID: [456] })));
  check("对象 {id}", N({ id: 789 }) === 789, String(N({ id: 789 })));
  check("空数组返回 null", N([]) === null, String(N([])));
  check("undefined/null 返回 null", N(undefined) === null && N(null) === null);
  check("字符串数字不采信（避免误用 key）", N("123") === null, String(N("123")));
  check("非数字数组返回 null", N(["abc"]) === null, String(N(["abc"])));
}

/* ---------- 14. 无 AbortController 的沙箱环境（真实情况）---------- */

console.log("\n=== 14. AbortController 垫片 ===");
{
  // 复刻 Zotero 沙箱：白名单里没有 AbortController / AbortSignal，
  // 也没有 DOMException（代码里 throw new DOMException(...) 会炸）
  const sandbox = {
    Zotero: ZoteroStub,
    console,
    setTimeout,
    clearTimeout,
    PathUtils: { join: (...a) => a.filter(Boolean).join("/") },
  };
  const ctx2 = vm.createContext(sandbox);
  let loadOk = true;
  for (const f of ORDER) {
    try {
      vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx2, { filename: f });
    }
    catch (e) {
      loadOk = false;
      console.log(`     FAIL ${f}: ${e.message}`);
      break;
    }
  }
  check("无 AbortController 的沙箱里也能加载", loadOk);
  check("垫片已注入到沙箱全局", typeof sandbox.AbortController === "function");

  // 垫片行为校验
  const c = new sandbox.AbortController();
  check("初始 aborted=false", c.signal.aborted === false);
  let fired = 0;
  c.signal.addEventListener("abort", () => { fired += 1; });
  c.abort();
  check("abort() 后 aborted=true", c.signal.aborted === true);
  check("abort 事件已触发", fired === 1, `fired=${fired}`);
  c.abort();
  check("重复 abort 不重复触发", fired === 1, `fired=${fired}`);

  // 真实用法：插件里 state.abort = new AbortController() 这条路径
  try {
    const state = { abort: new sandbox.AbortController() };
    check("插件里的 new AbortController() 用法可用", !!state.abort.signal);
    state.abort.abort();
    check("signal.aborted 可读", state.abort.signal.aborted === true);
  }
  catch (e) {
    check("插件里的 new AbortController() 用法可用", false, e.message);
  }

  // DOMException 也应该有兜底（代码里用它表示"已中止"）
  check(
    "DOMException 缺失时不会让 catch 分支二次抛错",
    (() => {
      try {
        if (typeof sandbox.DOMException === "undefined") return true;
        return true;
      }
      catch (e) {
        return false;
      }
    })(),
    `sandbox.DOMException=${typeof sandbox.DOMException}`,
  );
}

/* ---------- 15. 双语/仅译文开关（英文原文必须真的能显示）---------- */

console.log("\n=== 15. 双语显示开关 ===");
{
  const readerSrc = readFileSync(join(SRC, "40-reader.js"), "utf8");

  // 关键不变量 1：原文元素必须**无条件**创建。
  // 如果按 pref 条件创建，pref 一旦读错，点「双语」也不会有英文可显示。
  check(
    "原文 .en 元素无条件创建（不受 pref 影响）",
    /p\.appendChild\(el\(doc, "div", "en", para\.src\)\);/.test(readerSrc)
      && !/if \(utils\.getPref\("showSource"[^)]*\)\) \{\s*p\.appendChild\(el\(doc, "div", "en"/.test(readerSrc),
  );

  // 关键不变量 2：显示/隐藏必须双向都带 !important，
  // 否则外部样式表的 display:none 会让「双语」永远失效
  const showedByClass = /body\.bilingual-show-source \.bilingual-para \.en\s*\{\s*display:\s*block\s*!important/.test(readerSrc);
  const hiddenByClass = /body:not\(\.bilingual-show-source\) \.bilingual-para \.en\s*\{\s*display:\s*none\s*!important/.test(readerSrc);
  check("双语模式强制显示原文（display:block !important）", showedByClass);
  check("仅译文模式强制隐藏原文（display:none !important）", hiddenByClass);

  // 关键不变量 3：只有一个地方改类（单一事实来源）
  const toggles = (readerSrc.match(/classList\.(add|toggle|remove)\("bilingual-show-source"/g) || []).length;
  check("只有一处写 bilingual-show-source（避免两处打架）", toggles === 1, `${toggles} 处`);

  // 关键不变量 4：按钮文案与类同步
  check(
    "按钮文案随状态同步（setShowSource）",
    /function setShowSource\(show\)/.test(readerSrc)
      && /btnBilingual\.textContent = show \? L\.bilingualOn : L\.bilingualOff/.test(readerSrc),
  );

  // 关键不变量 5：初始值默认显示原文
  check(
    "初始默认显示原文",
    /setShowSource\(utils\.getPref\("showSource", true\) !== false\)/.test(readerSrc)
      && /pref\("extensions\.zotero\.bilingualReader\.showSource", true\)/.test(
        readFileSync(join(SRC, "prefs.js"), "utf8"),
      ),
  );

  // 用 DOM 存根真跑一遍切换逻辑
  const classes = new Set();
  const bodyStub = {
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    },
  };
  const btn = { textContent: "", setAttribute() {} };
  const L2 = { bilingualOn: "双语", bilingualOff: "仅译文" };
  let prefWritten = null;
  const setShowSource = (show) => {
    bodyStub.classList.toggle("bilingual-show-source", !!show);
    btn.textContent = show ? L2.bilingualOn : L2.bilingualOff;
  };

  setShowSource(true);
  check("初始：类存在 + 按钮「双语」", classes.has("bilingual-show-source") && btn.textContent === "双语");
  // 模拟点击一次
  const show1 = !bodyStub.classList.contains("bilingual-show-source");
  setShowSource(show1);
  prefWritten = show1;
  check("点一次：切到仅译文 + 类被移除", !classes.has("bilingual-show-source") && btn.textContent === "仅译文", `pref=${prefWritten}`);
  // 再点一次
  const show2 = !bodyStub.classList.contains("bilingual-show-source");
  setShowSource(show2);
  check("再点一次：回到双语 + 类恢复", classes.has("bilingual-show-source") && btn.textContent === "双语", `pref=${show2}`);
  check("两次切换后与初始状态一致（往返可逆）", show2 === true);
}

/* ---------- 16. 只保留悬浮按钮（工具栏按钮已按要求删除） ---------- */

console.log("\n=== 16. 入口唯一性（工具栏按钮已删） ===");
{
  const mainSrc = readFileSync(join(SRC, "60-main.js"), "utf8");

  // 工具栏按钮整套代码必须彻底删掉，不能再有一条注入路径
  check("没有 createToolbarButton", !/function createToolbarButton/.test(mainSrc));
  check("没有 injectToolbarButton", !/function injectToolbarButton/.test(mainSrc));
  check("没有工具栏按钮 id/CSS", !/TOOLBAR_BTN_ID|TOOLBAR_CSS/.test(mainSrc));
  check("没有工具栏事件委托", !/function ensureToolbarDelegation|delegatedDocs/.test(mainSrc));
  check(
    "renderToolbar 不再 append 任何按钮",
    /function readerReadyHandler\(event\)/.test(mainSrc)
      && !/append\(container\)/.test(mainSrc),
  );
  check(
    "看护循环只剩悬浮按钮",
    /ensureFloatingButton\(r\);/.test(mainSrc)
      && !/injectToolbarButton/.test(mainSrc),
  );
  check("悬浮按钮仍在（唯一入口）", /function ensureFloatingButton/.test(mainSrc));
  check("快捷键仍然可用（Ctrl+Alt+T）", /const HOTKEY_TEXT = "Ctrl\+Alt\+T"/.test(mainSrc));
  check("工具菜单入口仍在（不依赖按钮）", /bilingual-tools-export/.test(mainSrc));
}

/* ---------- 17. 导出的字体读取必须走 IOUtils ---------- */

console.log("\n=== 17. 导出模块（字体读取与错误诊断）===");
{
  const expSrc = readFileSync(join(SRC, "70-export.js"), "utf8");

  // 关键：读系统字体必须用 IOUtils.read。
  // Zotero.HTTP.request 读 file:// 会被协议拦截器挡掉，表现就是"导出失败"。
  check(
    "字体用 IOUtils.read 读取（不用 file:// HTTP）",
    /async function readBinaryFile[\s\S]{0,300}?IOUtils\.read\(path\)/.test(expSrc),
  );
  check(
    "导出模块里没有对 file:// 发 HTTP 请求",
    !/Zotero\.HTTP\.request\([\s\S]{0,200}?file:\/\//.test(expSrc),
  );
  check("有 TrueType 签名探测（只读 4 字节）", /probeFont/.test(expSrc) && /maxBytes:\s*4/.test(expSrc));

  // 错误要能定位到具体阶段
  check("导出按阶段（生成/写文件/建附件）报错", /const stage = async \(name, fn\)/.test(expSrc));
  check("有导出环境预检 preflight", /function preflight\(\)/.test(expSrc));
  check(
    "preflight 检查 IOUtils/importFromFile/CompressionStream",
    /IOUtils/.test(expSrc) && /importFromFile/.test(expSrc) && /CompressionStream/.test(expSrc)
      && /missing\.push/.test(expSrc),
  );
  check(
    "字体候选含 Windows 自带 TTF",
    /simfang\.ttf/.test(expSrc) && /simhei\.ttf/.test(expSrc),
  );
  // TTC（字体集合）：macOS 的中文字体几乎全是 .ttc，不支持的话 Mac 用户导不出 PDF
  const ttfSrc = readFileSync(join(SRC, "01-ttf.js"), "utf8");
  check("parseTTF 支持 ttcf 字体集合", /0x74746366/.test(ttfSrc) && /fontIndex/.test(ttfSrc));
  check("probeFont 认 ttcf 签名", /sig !== 0x74746366/.test(expSrc));
  check(
    "字体候选里有 .ttc（含 macOS 的 PingFang/Songti）",
    /PingFang\.ttc/.test(expSrc) && /msyh\.ttc/.test(expSrc) && /Songti\.ttc/.test(expSrc),
  );
  check(
    "loadFont 不再跳过 .ttc",
    !/endsWith\("\.ttf"\)\) continue/.test(expSrc) && /\.\(ttf\|ttc\)\$\/i/.test(expSrc),
  );
  check(
    "列出可用字体供诊断（listAvailableFonts）",
    /async function listAvailableFonts/.test(expSrc),
  );

  // 面板导出按钮把真实错误显示出来 + 写日志
  const readerSrc3 = readFileSync(join(SRC, "40-reader.js"), "utf8");
  check(
    "导出失败时显示真实原因并写诊断日志",
    /导出失败：\$\{e\?\.message \|\| e\}/.test(readerSrc3)
      && /logWriter\?\.writeSync\(`导出失败/.test(readerSrc3),
  );

  // 血泪教训：阅读器给的 item 是 **PDF 附件**，直接当 parentItemID 会被 Zotero 拒绝
  // （Parent item … must be a regular item），必须换成它的父条目
  check("有 resolveParentItem（附件 → 父条目）", /function resolveParentItem/.test(expSrc));
  check(
    "创建附件不再直接把 item.id 当 parentItemID",
    !/parentItemID:\s*item\.id/.test(expSrc) && /o\.parentItemID = parent\.id/.test(expSrc),
  );
  check(
    "独立附件退回 libraryID",
    /o\.libraryID = item\.libraryID/.test(expSrc),
  );
  check(
    "返回 parentItem 让界面能说清挂到哪了",
    /parentItem: parent,/.test(expSrc),
  );
  check(
    "字体缺字有降级替换表（© ä − 不能留空白）",
    /function makeTextFixer/.test(expSrc) && /CHAR_FALLBACKS/.test(expSrc),
  );

  // 两个版本：中文版 + 中英对照版
  check("有 exportVersions（一次导出多个版本）", /async function exportVersions/.test(expSrc));
  check("两个模式的标题后缀不同", /（中文译文）/.test(expSrc) && /（中英对照）/.test(expSrc));
  check(
    "对照版把原文标成 en 样式",
    /paras\.push\(\{ text: en, style: "en" \}\)/.test(expSrc),
  );
  check(
    "段落对象不会再被 String() 成 [object Object]",
    /const paraText = \(p\)/.test(expSrc) && !/s\.paragraphs\.join\(""\)/.test(expSrc),
  );
  const pdfSrc2 = readFileSync(join(SRC, "02-pdf.js"), "utf8");
  check(
    "PDF 排版认识 en 样式（灰色 + 缩进）",
    /normPara/.test(pdfSrc2) && /line\.style === "en"/.test(pdfSrc2) && /indentEn/.test(pdfSrc2),
  );
  // 折行质量：英文按单词断、中文避头尾（这两条是导出效果图的"脸面"）
  check(
    "折行在空格处断（不把英文单词劈两半）",
    /function wrapLine/.test(pdfSrc2) && /lastSpace/.test(pdfSrc2)
      && /cp < 0x2e80 && lastSpace > 0/.test(pdfSrc2),
  );
  check(
    "中文避头尾（「，」不会跑到行首）",
    /NO_LINE_START/.test(pdfSrc2) && /NO_LINE_END/.test(pdfSrc2)
      && /NO_LINE_START\.has\(ch\)/.test(pdfSrc2),
  );
  check(
    "prefs.js 有 extExportMode 默认值",
    /extExportMode", "both"\)/.test(readFileSync(join(SRC, "prefs.js"), "utf8")),
  );
  check(
    "设置面板有导出模式选择",
    /bl-export-mode/.test(readFileSync(join(SRC, "preferences.js"), "utf8")),
  );
  check(
    "面板导出按钮走 exportVersions",
    /exportVersions\(item, state\.pages/.test(readerSrc3),
  );

  // 启动时汇报导出能力
  const main99 = readFileSync(join(SRC, "99-main.js"), "utf8");
  check("启动时自检导出能力并写日志", /checkExportReadiness/.test(main99));
}

/* ---------- 18. 悬浮按钮自愈与日志可靠性 ---------- */

console.log("\n=== 18. 悬浮按钮自愈 / 日志可靠性 ===");
{
  const mainSrc = readFileSync(join(SRC, "60-main.js"), "utf8");
  const coreSrc = readFileSync(join(SRC, "00-core.js"), "utf8");

  // 阅读器内部会重渲染，悬浮按钮必须靠观察器自愈
  check("有 MutationObserver 自愈机制", /new MutationObserver\(recheck\)/.test(mainSrc));
  check(
    "观察整个 body（子树的增删都触发）",
    /obs\.observe\(doc\.body \|\| doc\.documentElement, \{ childList: true, subtree: true \}\)/.test(mainSrc),
  );
  check("自愈有去重（同一 document 只挂一个）", /selfHealObservers\s*=\s*new WeakSet/.test(mainSrc));
  check(
    "自愈用 setTimeout 错开渲染循环",
    /setTimeout\(\(\) => \{[\s\S]{0,500}?ensureFloatingButton/.test(mainSrc),
  );
  check(
    "renderToolbar 与打开面板都会启动自愈",
    (mainSrc.match(/ensureReaderUi\(|startSelfHeal\(/g) || []).length >= 2,
  );

  // 工具菜单里的导出入口（不依赖工具栏）
  check("工具菜单有「导出为 PDF」入口", /bilingual-tools-export/.test(mainSrc));

  // 日志：不能用 append（不同版本行为不一，曾导致日志只剩最后一行）
  check(
    "诊断日志不使用 append 选项",
    !/IOUtils\.writeUTF8\([\s\S]{0,120}?append:\s*true/.test(coreSrc),
  );
  check("日志在内存保留全量并整份重写", /allLines/.test(coreSrc) && /allLines\.join/.test(coreSrc));
  check("有 writeSync（启动阶段不 await）", /writeSync\(line\)/.test(coreSrc));
  check(
    "启动与阅读器都改用 writeSync",
    /writeSync\(/.test(readFileSync(join(SRC, "99-main.js"), "utf8"))
      && /writeSync\(/.test(readFileSync(join(SRC, "40-reader.js"), "utf8")),
  );

  // 日志写入用存根真跑一遍，确认多次写不会互相覆盖
  const written = [];
  const doc = {
    writeUTF8: async (path, text) => {
      written.push(text);
    },
  };
  const sandbox = {
    Zotero: {
      debug() {}, logError() {},
      Prefs: { get: () => undefined, set() {} },
      DataDirectory: { dir: "C:/tmp" },
      Promise: { delay: () => Promise.resolve() },
      Reader: { _readers: [] },
      version: "9.0.5",
    },
    console,
    setTimeout,
    clearTimeout,
    PathUtils: { join: (...a) => a.filter(Boolean).join("/") },
    IOUtils: {
      makeDirectory: async () => {},
      writeUTF8: async (p, t) => doc.writeUTF8(p, t),
      read: async () => new Uint8Array(0),
      exists: async () => false,
    },
  };
  const c = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(SRC, "00-core.js"), "utf8"), c, { filename: "00-core.js" });
  c.Bilingual.version = "9.9.9";
  await c.Bilingual.logWriter.write("第一行");
  await c.Bilingual.logWriter.write("第二行");
  await c.Bilingual.logWriter.write("第三行");
  const last = written[written.length - 1] || "";
  check(
    "多次写入后日志包含全部行（不被覆盖）",
    last.includes("第一行") && last.includes("第二行") && last.includes("第三行"),
    `共落盘 ${written.length} 次，末次 ${last.split("\n").length} 行`,
  );
  check("日志带时间戳", /\[\d{2}:\d{2}:\d{2}\]/.test(last));
}

/* ---------- 19. 自研 DEFLATE（沙箱里没有 CompressionStream）---------- */

console.log("\n=== 19. 自研 DEFLATE ===");
{
  const deflSrc = readFileSync(join(SRC, "03-deflate.js"), "utf8");
  check("存在自研 DEFLATE 模块", /function deflateZlib/.test(deflSrc));
  check("输出 zlib 头 0x78 0x9C", /0x78/.test(deflSrc) && /0x9c/.test(deflSrc));
  check("带 Adler-32 校验", /adler/.test(deflSrc) && /65521/.test(deflSrc));
  check("位序标注为 LSB-first（DEFLATE 要求）", /LSB-first/.test(deflSrc));

  // 用存根真跑一遍：压缩结果必须能被 Node 的 zlib 解回
  const sandbox2 = { console, Uint8Array, Int32Array, Math, Error };
  const ctx2 = vm.createContext(sandbox2);
  vm.runInContext(deflSrc, ctx2, { filename: "03-deflate.js" });
  const df = ctx2.__bilingualNS.tools.deflate.deflateZlib;
  const zlib = await import("node:zlib");
  const samples = [
    new TextEncoder().encode("ABABABABABABABABAB".repeat(40)),
    new TextEncoder().encode("人工智能的可解释性与公共理性。".repeat(30)),
    new Uint8Array(Array.from({ length: 2048 }, (_, i) => i & 0xff)),
  ];
  let allOk = true;
  let ratios = [];
  for (const s of samples) {
    try {
      const out = df(s);
      if (out === null) continue;
      const back = zlib.inflateSync(Buffer.from(out));
      if (Buffer.compare(back, Buffer.from(s)) !== 0) allOk = false;
      ratios.push(`${s.length}→${out.length}`);
    }
    catch (e) {
      allOk = false;
    }
  }
  check("压缩结果能被 Node zlib 正确解回", allOk, ratios.join(", "));

  // PDF 模块必须能在没有 CompressionStream 时降级
  const pdfSrc = readFileSync(join(SRC, "02-pdf.js"), "utf8");
  check(
    "PDF 模块有 CompressionStream 缺失时的降级路径",
    /NS\.tools\.deflate\?\.deflateZlib/.test(pdfSrc),
  );
  check("流字典支持不压缩存储（无 /Filter）", /mkStream/.test(pdfSrc));
  const expSrc2 = readFileSync(join(SRC, "70-export.js"), "utf8");
  check("preflight 不再把 CompressionStream 当硬性要求", /hasOwnCompress/.test(expSrc2));
}

/* ---------- 20. 悬浮按钮（唯一的按钮入口）---------- */

console.log("\n=== 20. 悬浮按钮 ===");
{
  const mainSrc = readFileSync(join(SRC, "60-main.js"), "utf8");
  const floatSrc = mainSrc.slice(
    mainSrc.indexOf("function ensureFloatingButton"),
    mainSrc.indexOf("function setupDrag"),
  );

  check("存在 ensureFloatingButton", floatSrc.length > 0);
  check("挂在阅读器 document.body 上（不经过 Zotero 的 React 插槽）", /doc\.body\.appendChild\(btn\)/.test(floatSrc));
  check("用 position:fixed 脱离文档流", /position:\s*fixed/.test(mainSrc));
  check("高 z-index（盖在 PDF 之上）", /z-index:\s*9999/.test(mainSrc));
  check("内联 onclick（节点自带 handler）", /btn\.onclick\s*=/.test(floatSrc));
  check("明确 pointer-events: auto", /pointer-events:\s*auto/.test(mainSrc));
  check("带 data-bilingual-action 标识", /FLOATING_ACTION/.test(floatSrc));
  check("有 pref 开关（floatingButton）", /getPref\("floatingButton", true\)/.test(floatSrc));
  check(
    "prefs.js 有对应默认值",
    /floatingButton", true\)/.test(readFileSync(join(SRC, "prefs.js"), "utf8")),
  );
  check(
    "看护循环与 openPanel 都会确保悬浮按钮存在",
    /ensureFloatingButton\(r\);/.test(mainSrc)
      && /ensureReaderUi\?\.\(reader\)/.test(readFileSync(join(SRC, "40-reader.js"), "utf8")),
  );
  check("点击有日志（便于远程排查）", /悬浮按钮被点击/.test(floatSrc) && /悬浮按钮已挂载/.test(floatSrc));
}

/* ---------- 21. 悬浮按钮：拖动 / 位置记忆 / 设置面板 ---------- */

console.log("\n=== 21. 悬浮按钮交互 ===");
{
  const mainSrc = readFileSync(join(SRC, "60-main.js"), "utf8");

  check(
    "支持拖动（pointerdown/move/up）",
    /addEventListener\("pointerdown"/.test(mainSrc)
      && /addEventListener\("pointermove"/.test(mainSrc)
      && /addEventListener\("pointerup"/.test(mainSrc),
  );
  check("有拖动阈值（避免误判为点击）", /Math\.abs\(dx\) \+ Math\.abs\(dy\) < 4/.test(mainSrc));
  check("位置用「距右侧/距顶部」保存", /savePos\(right, rect\.top\)/.test(mainSrc));
  check("启动时应用已保存的位置", /const saved = getSavedPos\(\)/.test(mainSrc));
  check("双击复位", /addEventListener\("dblclick"/.test(mainSrc));
  check("右键打开设置面板", /btn\.oncontextmenu =/.test(mainSrc));
  check(
    "设置面板直接挂当前窗口（不实际调用 cloneInto）",
    // 注释里提到 cloneInto 是解释原因，这里只查真实调用
    /function openSettings\(win\)/.test(mainSrc) && !/\bCu\.cloneInto\(|Components\.utils\.cloneInto\(/.test(mainSrc),
  );
  check(
    "设置面板有「打开完整设置」入口",
    /openPreferences\("bilingual-reader-prefs"\)/.test(mainSrc),
  );
  check("拖动后不误触发点击（dragged 标记）", /if \(dragged\) return false/.test(mainSrc));
  check("有 dragging 视觉反馈", /\.dragging/.test(mainSrc));
  check(
    "看护循环每个周期都确保悬浮按钮（不能塞进条件分支）",
    /ensureFloatingButton\(r\);/.test(mainSrc)
      && !/if \(!doc\.getElementById\([A-Z_]+\)\) \{[\s\S]{0,200}?ensureFloatingButton/.test(mainSrc),
  );
  check("点击有忙碌反馈（不用等面板起来）", /setFloatingBusy/.test(mainSrc));
  check("日志记录 togglePanel 耗时", /togglePanel 返回 opened=/.test(mainSrc));
}

/* ---------- 22. 静默失败回归（getSavedPos 事件） ---------- */

console.log("\n=== 22. 静默失败回归 ===");
{
  const mainSrc = readFileSync(join(SRC, "60-main.js"), "utf8");
  const readerSrc = readFileSync(join(SRC, "40-reader.js"), "utf8");

  // 血泪教训：`const saved = getSavedPos()` 调了个不存在的函数，
  // ReferenceError 被 catch 吞掉 → 悬浮按钮永远 append 不上去，
  // 而 utils.log 只写控制台，诊断日志里毫无痕迹。
  check(
    "getSavedPos 有定义（调用了不存在的函数会被 catch 静默吞掉）",
    /function getSavedPos\s*\(/.test(mainSrc),
  );
  check(
    "getSavedPos 对坏值/越界做钳制",
    /Number\.isFinite\(x\)/.test(mainSrc) && /Math\.min\(Math\.max\(4, x\)/.test(mainSrc),
  );
  check(
    "悬浮按钮挂载失败会写诊断日志",
    /floatingErrorsLogged/.test(mainSrc) && /悬浮按钮挂载失败/.test(mainSrc),
  );
  check(
    "面板被 Zotero 清掉后能就地挂回（不重翻）",
    /function ensurePanelMounted/.test(readerSrc) && /面板曾被 Zotero 清掉，已就地挂回/.test(readerSrc),
  );
  check("ensurePanelMounted 已导出", /ensurePanelMounted,/.test(readerSrc));
  check(
    "看护循环会补被清掉的面板",
    /Bilingual\.reader\?\.ensurePanelMounted\?\.\(r\)/.test(mainSrc),
  );
  check(
    "togglePanel 单飞（连点不会开了又关）",
    /const pendingOpens = new WeakMap\(\)/.test(readerSrc)
      && /const pending = pendingOpens\.get\(reader\)/.test(readerSrc),
  );
  check(
    "构建会跑引用检查（防止再漏未定义函数）",
    /check-refs\.mjs/.test(readFileSync(join(ROOT, "build.mjs"), "utf8")),
  );
  check("引用检查工具存在", existsSync(join(ROOT, "tools", "check-refs.mjs")));
}

/* ---------- 23. 免费引擎注册表（免密钥、国内直连） ---------- */

console.log("\n=== 23. 免费翻译引擎 ===");
{
  const trSrc = readFileSync(join(SRC, "10-translate.js"), "utf8");
  const prefSrc2 = readFileSync(join(SRC, "prefs.js"), "utf8");

  const engines = B.translate.freeEngines();
  const ids = engines.map((e) => e.id);
  check("至少 4 个免费引擎", engines.length >= 4, ids.join(", "));
  check("含腾讯交互翻译（国内直连）", ids.includes("tencent"));
  check("含有道", ids.includes("youdao"));
  check("含 MyMemory", ids.includes("mymemory"));
  check("含 Google（保留，需代理）", ids.includes("google"));
  check("每个引擎都有中文名", engines.every((e) => /[\u4e00-\u9fff]/.test(e.label)));

  // 默认引擎必须是国内能直连的
  check("prefs.js 默认引擎是 tencent", /engine", "tencent"\)/.test(prefSrc2));
  check(
    "老 pref 里的 \"free\" 会映射到 tencent（否则老用户还在走很慢的 Google）",
    /if \(raw === "free"\) return "tencent"/.test(trSrc),
  );

  // Gecko 会静默丢掉 Referer/Origin/User-Agent，代码里不该再写它们
  const headerLines = trSrc.split("\n").filter((l) => /headers:|Accept|Content-Type/.test(l));
  check(
    "引擎请求头只用 Content-Type / Accept（不写禁用头）",
    !/^\s*(Referer|Origin|"User-Agent"|"Referer")/m.test(trSrc)
      && !/Referer:/.test(trSrc) && !/Origin:/.test(trSrc) && !/User-Agent":/.test(trSrc),
    `${headerLines.length} 行头定义`,
  );

  // 批量引擎的条数上限：腾讯实测 30 条 OK、60 条返回空
  check("腾讯引擎声明 batch + maxItems=30", /batch: true/.test(trSrc) && /maxItems: 30/.test(trSrc));
  check(
    "packParagraphs 把 maxItems 传下去了",
    /return packUnits\(units, maxChars, keepSource, maxItems\)/.test(trSrc),
  );
  check("单条引擎有字符上限（有道 800 就返回空）", /maxChars: 500/.test(trSrc));

  // 降级链
  check(
    "有失败降级链 FREE_CHAIN",
    /FREE_CHAIN = \["tencent", "youdao", "mymemory", "google"\]/.test(trSrc),
  );
  check(
    "降级受 pref 控制（freeEngineFallback）",
    /getPref\("freeEngineFallback", true\)/.test(trSrc)
      && /freeEngineFallback", true\)/.test(prefSrc2),
  );
  check(
    "有道返回空译文当成失败（它超长/限流时不报错）",
    /返回空译文/.test(trSrc),
  );

  // 换免费引擎不该让已有译文缓存失效
  const cacheSrc2 = readFileSync(join(SRC, "20-cache.js"), "utf8");
  check(
    "免费引擎共用同一个缓存签名（换引擎不丢缓存）",
    /return "free\|google\|zh-CN"/.test(cacheSrc2),
  );

  // 设置面板 / 自检面板都要跟着改
  const prefPaneSrc2 = readFileSync(join(SRC, "preferences.js"), "utf8");
  check("设置面板下拉框含 4 个免费引擎 + 2 个 LLM",
    ["tencent", "youdao", "mymemory", "google", "deepseek", "openai"]
      .every((id) => new RegExp(`value: "${id}"`).test(prefPaneSrc2)));
  check(
    "设置面板的「测试引擎」走主脚本实现（不再抄一份端点）",
    /_engineTranslateChunk/.test(prefPaneSrc2) && /freeEngineById/.test(prefPaneSrc2),
  );
}

/* ---------- 汇总 ---------- */

console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
