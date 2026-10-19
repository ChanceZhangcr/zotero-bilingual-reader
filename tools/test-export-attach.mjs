/**
 * 导出挂附件的行为测试（离线，用真字体、真 PDF 生成）。
 *
 * 复现并锁定的 bug：
 *   从阅读器导出时 `reader.itemID` 是 **PDF 附件**，代码把附件当成 parentItemID，
 *   Zotero 拒绝：`Parent item 1/LTNT58ZP must be a regular item`，
 *   用户看到的就是"导出失败：创建附件 失败：…"。
 *
 * 这里用桩把 `Zotero.Attachments.importFromFile` 的入参录下来，验证三种情况：
 *   1. 常规条目          → parentItemID = 该条目
 *   2. 有父条目的 PDF 附件 → parentItemID = **父条目**（不是附件自己）
 *   3. 独立 PDF 附件      → 不带 parentItemID，落到同一个 libraryID
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const TMP = (process.env.TEMP || "C:/Windows/Temp").replace(/\\/g, "/");
const DATA_DIR = join(TMP, "bilingual-export-test");
mkdirSync(DATA_DIR, { recursive: true });

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ------------------------------ 条目桩 ------------------------------ */

const regular = {
  id: 1,
  libraryID: 1,
  isRegularItem: () => true,
  isAttachment: () => false,
  getField: (f) => (f === "title" ? "The Testimony Gap" : ""),
};
const pdfAttachment = {
  id: 2,
  libraryID: 1,
  parentID: 1,
  parentItem: regular,
  isRegularItem: () => false,
  isAttachment: () => true,
  isPDFAttachment: () => true,
  getField: (f) => (f === "title" ? "Full Text PDF" : ""),
};
const standalonePdf = {
  id: 3,
  libraryID: 1,
  parentID: null,
  parentItem: null,
  isRegularItem: () => false,
  isAttachment: () => true,
  isPDFAttachment: () => true,
  getField: (f) => (f === "filename" ? "orphan-paper.pdf" : ""),
};
const itemsById = new Map([[1, regular], [2, pdfAttachment], [3, standalonePdf]]);

const imported = [];
const zotero = {
  debug() {},
  logError(e) {
    console.log(`   [logError] ${e?.message || e}`);
  },
  version: "9.0.5",
  isWin: true,
  isMac: false,
  Prefs: { get: () => undefined, set() {} },
  Promise: { delay: () => Promise.resolve() },
  DataDirectory: { dir: DATA_DIR },
  Reader: { _readers: [], registerEventListener() {}, unregisterEventListener() {} },
  HTTP: { request: async () => ({}) },
  Items: { get: (id) => itemsById.get(id) || null },
  Attachments: {
    importFromFile: async (opts) => {
      imported.push(opts);
      return { id: 900 + imported.length, libraryID: opts.libraryID ?? 1 };
    },
  },
  ProgressWindow: class {
    changeHeadline() {}
    addDescription() {}
    show() {}
    close() {}
    startCloseTimer() {}
  },
  MenuManager: { registerMenu: () => "menu-id", unregisterMenu() {} },
  getMainWindow: () => null,
  getActiveZoteroPane: () => null,
  PDFWorker: {},
  Fulltext: {},
};

const winPath = (p) => String(p).replace(/\//g, "\\");
const sandbox = {
  Zotero: zotero,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  PathUtils: { join: (...a) => a.filter(Boolean).join("/"), tempDir: TMP },
  IOUtils: {
    async read(path, opts) {
      const buf = readFileSync(winPath(path));
      return new Uint8Array(opts?.maxBytes ? buf.subarray(0, opts.maxBytes) : buf);
    },
    async writeUTF8(path, text) {
      writeFileSync(winPath(path), text);
    },
    async write(path, bytes) {
      writeFileSync(winPath(path), Buffer.from(bytes));
    },
    async makeDirectory(p) {
      mkdirSync(winPath(p), { recursive: true });
    },
    async exists(path) {
      return existsSync(winPath(path));
    },
  },
  Services: { wm: { getMostRecentWindow: () => null } },
  ChromeUtils: { import: () => {} },
  Localization: {},
  XMLSerializer: class {},
  DOMParser: class {},
  XMLHttpRequest: class {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  fetch: async () => {
    throw new Error("测试环境不联网");
  },
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Uint8Array,
  DataView,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Array,
  Object,
  JSON,
  Math,
  Date,
  String,
  Number,
  Boolean,
  RegExp,
  Error,
  Promise,
  Intl,
  isNaN,
  parseInt,
  parseFloat,
  globalThis: undefined,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

// 与 build.mjs 的 JS_ORDER 一致（沙箱里没有 CompressionStream，走自研 DEFLATE）
const ORDER = [
  "01-ttf.js", "02-pdf.js", "03-deflate.js", "00-core.js", "10-translate.js",
  "20-cache.js", "30-paper.js", "40-reader.js", "50-selection.js",
  "60-main.js", "70-export.js", "99-main.js",
];

console.log("=== 载入全部脚本（模拟 loadSubScript）===");
let loadOk = true;
for (const f of ORDER) {
  try {
    vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
  }
  catch (e) {
    loadOk = false;
    console.log(`   FAIL ${f}: ${e.message}`);
  }
}
check(`${ORDER.length} 个脚本全部加载`, loadOk);

const B = ctx.Bilingual;
check("Bilingual.exporter 可用", typeof B?.exporter?.exportTranslation === "function");
check("暴露 resolveParentItem", typeof B?.exporter?.resolveParentItem === "function");
check("沙箱里没有 CompressionStream（贴近 Zotero）", typeof sandbox.CompressionStream === "undefined");

/* ---------------------- resolveParentItem 单元测试 ---------------------- */

console.log("\n=== resolveParentItem ===");
check("常规条目 → 自己", B.exporter.resolveParentItem(regular) === regular);
check(
  "PDF 附件 → 父条目（不是附件自己）",
  B.exporter.resolveParentItem(pdfAttachment) === regular,
);
check("独立 PDF 附件 → null", B.exporter.resolveParentItem(standalonePdf) === null);
check("null 输入 → null", B.exporter.resolveParentItem(null) === null);

/* ------------------------- 字体缺字降级表 ------------------------- */

console.log("\n=== 字体缺字降级（©ä− 这类字符不能留空白）===");
{
  const fontBytes = new Uint8Array(readFileSync("C:/Windows/Fonts/simfang.ttf"));
  const font = B.tools.ttf.parseTTF(fontBytes);
  const fix = B.exporter.makeTextFixer(font);
  check("© → (C)", fix("版权 © 2024") === "版权 (C) 2024", fix("版权 © 2024"));
  const fix2 = B.exporter.makeTextFixer(font);
  // 用户日志里报缺的三个字符就是 © ä −，这里逐个验证
  check("ä → a（去变音符号）", fix2("Käse") === "Kase", fix2("Käse"));
  const fix3 = B.exporter.makeTextFixer(font);
  check("− (U+2212) → -", fix3("1 − 2") === "1 - 2", fix3("1 − 2"));
  check("正常中文/英文原样保留", (() => {
    const f4 = B.exporter.makeTextFixer(font);
    return f4("人工智能 alignment 123") === "人工智能 alignment 123";
  })());
}

/* --------------------------- 三种条目形状 --------------------------- */

const LONG_EN = "Machines do not testify. They record, retrieve, and recombine what "
  + "humans have already said, and in doing so they change what it means to be "
  + "a witness in a court of law. This paper argues that the testimony gap is "
  + "not a technical deficit but a conceptual one.";
const LONG_ZH = "机器不作证。它们记录、检索并重新组合人类已经说过的话，"
  + "而在这个过程中，它们改变了在法庭上作为证人意味着什么。"
  + "本文论证，证词鸿沟不是技术缺陷，而是概念缺陷。";

const PAGES = [
  {
    page: 1,
    paragraphs: [
      {
        src: "AI systems are increasingly deployed.",
        dst: "人工智能系统越来越多地部署在医疗保健与刑事司法领域。混合 © 2024 Müller 与 1 − 2。",
      },
      { src: LONG_EN, dst: LONG_ZH },
    ],
  },
  {
    page: 2,
    paragraphs: [
      { src: LONG_EN, dst: LONG_ZH },
      { src: "Second page, second paragraph.", dst: "第二页第二段，用来验证分页。" },
    ],
  },
];

const logs = [];
const log = (m) => logs.push(String(m));

console.log("\n=== 导出：常规条目 ===");
{
  const res = await B.exporter.exportTranslation(regular, PAGES, { format: "pdf", log });
  const opts = imported[imported.length - 1];
  check("带 parentItemID = 1", opts.parentItemID === 1, JSON.stringify({ p: opts.parentItemID }));
  check("标题用条目标题", String(opts.title).startsWith("The Testimony Gap（中文译文）"), opts.title);
  check("返回 parentItem", res.parentItem === regular);
  check("PDF 头是 %PDF", res.bytes > 1000);
}

console.log("\n=== 导出：有父条目的 PDF 附件（用户报的那个 bug）===");
{
  const before = imported.length;
  const res = await B.exporter.exportTranslation(pdfAttachment, PAGES, { format: "pdf", log });
  const opts = imported[imported.length - 1];
  check("确实建了附件", imported.length === before + 1);
  check(
    "parentItemID = 父条目 1（绝不能是附件 2）",
    opts.parentItemID === 1,
    JSON.stringify({ p: opts.parentItemID }),
  );
  check(
    "标题取父条目标题，不是 PDF 文件名",
    String(opts.title).startsWith("The Testimony Gap（中文译文）"),
    opts.title,
  );
  check("返回 parentItem = 常规条目", res.parentItem === regular);
}

console.log("\n=== 导出：独立 PDF 附件（没有父条目）===");
{
  const before = imported.length;
  const res = await B.exporter.exportTranslation(standalonePdf, PAGES, { format: "pdf", log });
  const opts = imported[imported.length - 1];
  check("确实建了附件（不抛错）", imported.length === before + 1);
  check("不带 parentItemID", opts.parentItemID === undefined);
  check("落到同一个 libraryID", opts.libraryID === 1);
  check("标题退回附件文件名", String(opts.title).startsWith("orphan-paper（中文译文）"), opts.title);
  check("返回 parentItem = null", res.parentItem === null);
  check(
    "日志里有『独立附件』提示",
    logs.some((l) => l.includes("独立附件")),
  );
}

/* -------------------- 中英对照版（两个版本一起导出） -------------------- */

console.log("\n=== collectSections：中文版 / 中英对照版 ===");
{
  const zhSections = B.exporter.collectSections(PAGES, { docTitle: "T" });
  const biSections = B.exporter.collectSections(PAGES, { docTitle: "T", bilingual: true });
  const zhParas = zhSections[1].paragraphs;
  const biParas = biSections[1].paragraphs;
  const paraCount = PAGES[0].paragraphs.length;
  check(
    `中文版只有译文（${paraCount} 段纯字符串）`,
    zhParas.length === paraCount && zhParas.every((p) => typeof p === "string"),
    JSON.stringify(zhParas.map((p) => typeof p)),
  );
  check(
    "对照版按段落成对：en 在前、zh 在后",
    biParas.length === paraCount * 2
      && biParas.every((p, i) => p.style === (i % 2 === 0 ? "en" : "zh")),
    JSON.stringify(biParas.map((p) => p.style)),
  );
  check(
    "对照版的 en 行就是原文、zh 行就是译文",
    biParas[0].text === PAGES[0].paragraphs[0].src
      && biParas[1].text === PAGES[0].paragraphs[0].dst,
  );
}

console.log("\n=== exportVersions：一次生成两个版本 ===");
{
  const before = imported.length;
  const out = await B.exporter.exportVersions(pdfAttachment, PAGES, { format: "pdf", log });
  const opts = imported.slice(before);
  check("生成了 2 个附件", out.results.length === 2 && opts.length === 2, `results=${out.results.length}`);
  check("没有失败项", out.errors.length === 0, JSON.stringify(out.errors));
  check(
    "一个叫（中文译文）（PDF）",
    opts.some((o) => String(o.title).includes("（中文译文）（PDF）")),
    opts.map((o) => o.title).join(" | "),
  );
  check(
    "一个叫（中英对照）（PDF）",
    opts.some((o) => String(o.title).includes("（中英对照）（PDF）")),
    opts.map((o) => o.title).join(" | "),
  );
  check("两个都挂在父条目 1 下", opts.every((o) => o.parentItemID === 1));

  const zh = out.results.find((r) => r.mode === "zh");
  const bi = out.results.find((r) => r.mode === "bilingual");
  check("对照版比中文版大（多了英文原文）", bi && zh && bi.bytes > zh.bytes,
    `zh=${zh?.bytes} bi=${bi?.bytes}`);

  // 页数：对照版内容翻倍，页数应该更多
  const pagesOf = (p) => {
    const txt = readFileSync(p, "latin1");
    const m = txt.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/);
    return m ? Number(m[1]) : 0;
  };
  const zhPdf = join(DATA_DIR, "bilingual-reader", "exports", "The Testimony Gap（中文译文）.pdf");
  const biPdf = join(DATA_DIR, "bilingual-reader", "exports", "The Testimony Gap（中英对照）.pdf");
  check("中文版 PDF 存在", existsSync(zhPdf), zhPdf);
  check("对照版 PDF 存在", existsSync(biPdf), biPdf);
  if (existsSync(zhPdf) && existsSync(biPdf)) {
    check("两个 PDF 页数都能读出来", pagesOf(zhPdf) > 0 && pagesOf(biPdf) > 0,
      `zh=${pagesOf(zhPdf)} bi=${pagesOf(biPdf)}`);
    check("对照版页数 ≥ 中文版", pagesOf(biPdf) >= pagesOf(zhPdf),
      `zh=${pagesOf(zhPdf)} bi=${pagesOf(biPdf)}`);
  }
}

console.log("\n=== exportVersions：只要一个版本（pref 控制）===");
{
  const before = imported.length;
  const out = await B.exporter.exportVersions(pdfAttachment, PAGES, {
    format: "pdf", log, mode: "zh",
  });
  check("mode=zh 只生成 1 个", out.results.length === 1 && imported.length === before + 1);
  check("生成的是中文版", out.results[0].mode === "zh");
}

/* ------------------------------ 生成物检查 ------------------------------ */

console.log("\n=== 生成物 ===");
{
  const hits = logs.filter((l) => l.includes("字体缺字处理"));
  check("日志报告了缺字替换", hits.length > 0, hits[hits.length - 1] || "(无)");
  check(
    "不再有『仍缺这些字符』的警告",
    !logs.some((l) => l.includes("仍缺这些字符")),
    logs.filter((l) => l.includes("仍缺")).join(" | "),
  );
  check(
    "日志里有挂在父条目下的记录",
    logs.some((l) => l.includes("挂在《The Testimony Gap》下")),
  );

  // getDataDirectory() = <数据目录>/bilingual-reader，导出落在它的 exports/ 下
  const tmpPdf = join(DATA_DIR, "bilingual-reader", "exports", "The Testimony Gap（中文译文）.pdf");
  check("临时 PDF 已写出", existsSync(tmpPdf));
  if (existsSync(tmpPdf)) {
    const head = readFileSync(tmpPdf).subarray(0, 8).toString("latin1");
    check("文件头 %PDF", head.startsWith("%PDF-"), head);
  }
}

console.log(`\n${failures === 0 ? "✅ 导出挂附件测试全部通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
