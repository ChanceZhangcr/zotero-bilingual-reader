/**
 * 生成 README 用的示例 PDF（走插件真实的导出代码，不是画出来的假图）。
 * 输出到 docs/，随后用 PyMuPDF 渲染成 PNG。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SRC = join(ROOT, "src");
const DOCS = join(ROOT, "docs");
mkdirSync(DOCS, { recursive: true });

/* ------------------------------ 沙箱 ------------------------------ */

const prefs = { extExportMode: "both" };
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder, Uint8Array, DataView, Map, Set, WeakMap, WeakSet,
  Array, Object, JSON, Math, Date, String, Number, Boolean, RegExp, Error,
  Promise, Intl, isNaN, parseInt, parseFloat,
  PathUtils: { join: (...a) => a.filter(Boolean).join("/") },
  IOUtils: {
    read: async (p) => new Uint8Array(readFileSync(String(p).replace(/\//g, "\\"))),
    writeUTF8: async () => {},
    write: async (p, b) => writeFileSync(String(p).replace(/\//g, "\\"), Buffer.from(b)),
    makeDirectory: async () => {},
    exists: async () => false,
  },
  Zotero: {
    debug() {}, logError(e) { console.log("  [logError]", e?.message || e); },
    version: "9.0.5",
    Prefs: { get: (k) => prefs[k], set: (k, v) => { prefs[k] = v; } },
    Promise: { delay: (ms) => new Promise((r) => setTimeout(r, ms)) },
    DataDirectory: { dir: process.env.TEMP?.replace(/\\/g, "/") },
    Reader: { _readers: [], registerEventListener() {} },
    Items: { get: () => null },
    HTTP: { request: async () => ({ responseText: "{}" }) },
    getMainWindow: () => null,
    getActiveZoteroPane: () => null,
    PDFWorker: {}, Fulltext: {},
    Attachments: { importFromFile: async (o) => ({ id: 1, ...o }) },
    MenuManager: { registerMenu: () => "x", unregisterMenu() {} },
  },
  Services: { wm: { getMostRecentWindow: () => null } },
  ChromeUtils: { import: () => {} },
  Localization: {},
  MutationObserver: class { observe() {} disconnect() {} },
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of [
  "01-ttf.js", "02-pdf.js", "03-deflate.js", "00-core.js", "10-translate.js",
  "20-cache.js", "30-paper.js", "40-reader.js", "50-selection.js",
  "60-main.js", "70-export.js", "99-main.js",
]) {
  vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
}
const NS = ctx.Bilingual;

/* --------------------------- 示例论文内容 --------------------------- */

const PAGES = [
  {
    page: 1,
    paragraphs: [
      {
        src: "Machines do not testify. They record, retrieve, and recombine what humans "
          + "have already said, and in doing so they quietly change what it means to be "
          + "a witness in a court of law.",
        dst: "机器不作证。它们记录、检索并重新组合人类已经说过的话，"
          + "而在这个过程中，它们悄悄改变了在法庭上作为证人意味着什么。",
      },
      {
        src: "This paper argues that the testimony gap is not a technical deficit but a "
          + "conceptual one: our evidentiary rules presuppose a speaker who can be "
          + "cross-examined, and no amount of explainability tooling supplies that.",
        dst: "本文认为，证词鸿沟不是技术缺陷，而是概念缺陷："
          + "我们的证据规则预设了一个可以被交叉询问的陈述者，而再多的可解释性工具也无法提供这一点。",
      },
      {
        src: "We conclude with a proposal for evidentiary reform in automated courts, "
          + "drawing on the hearsay doctrine and on recent work in machine learning.",
        dst: "我们最后提出一项针对自动化法庭的证据改革建议，"
          + "其依据来自传闻证据规则以及机器学习领域近期的研究。",
      },
    ],
  },
];

const DOC_TITLE = "The Testimony Gap: Machines and Reasons（中文译文）";
const DOC_TITLE_BI = "The Testimony Gap: Machines and Reasons（中英对照）";

/* ------------------------------ 生成 ------------------------------ */

async function build(pages, docTitle, bilingual, outFile) {
  const fontBytes = new Uint8Array(readFileSync("C:/Windows/Fonts/simfang.ttf"));
  const font = NS.tools.ttf.parseTTF(fontBytes);
  const sections = NS.exporter.collectSections(pages, { docTitle, bilingual });

  const cps = new Set();
  const paraText = (p) => (p && typeof p === "object" ? String(p.text ?? "") : String(p ?? ""));
  for (const ch of docTitle) cps.add(ch.codePointAt(0));
  for (const ch of "第 页 / 共 0123456789") cps.add(ch.codePointAt(0));
  for (const s of sections) {
    for (const ch of s.title) cps.add(ch.codePointAt(0));
    for (const p of s.paragraphs) for (const ch of paraText(p)) cps.add(ch.codePointAt(0));
  }
  const subset = NS.tools.ttf.subsetFont(font, [...cps]);
  const bytes = await NS.tools.pdf.buildPDF({
    sections,
    subset,
    deflate: async (u8) => new Uint8Array(deflateSync(Buffer.from(u8))),
    title: docTitle,
  });
  writeFileSync(outFile, Buffer.from(bytes));
  console.log(`  ${outFile}  ${(bytes.length / 1024).toFixed(1)} KB`
    + `${bytes.missingChars ? `  缺字: ${bytes.missingChars}` : ""}`);
}

await build(PAGES, DOC_TITLE, false, join(DOCS, "export-zh.pdf"));
await build(PAGES, DOC_TITLE_BI, true, join(DOCS, "export-bilingual.pdf"));
console.log("✅ 示例 PDF 已生成");
