/**
 * 联网测试：让**插件自己的引擎代码**去打真实的免费翻译端点。
 *
 * 为什么不用桩：这一层最容易出问题的地方恰恰是
 *   - 请求头（Gecko 会静默丢掉 Referer/Origin/User-Agent）
 *   - 响应结构（每个引擎的 JSON 形状都不一样）
 *   - 分块 / 标记回填 / 失败降级
 * 用真端点跑一遍才算数。
 *
 * 用 Node 的 fetch 顶替 Zotero.HTTP.request（返回 { responseText, status }），
 * 需要联网。用法：node tools/test-engines-live.mjs [engineId]
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* --------------------------- 可用的传输层 --------------------------- */

let prefs = { engine: "tencent", freeEngineFallback: true };
/** 让测试能掐断某个域名的请求，用来验证降级 */
let blockedHosts = new Set();
let httpCalls = [];

async function httpRequest(method, url, options = {}) {
  const host = new URL(url).host;
  httpCalls.push({ method, url, headers: options.headers || {}, body: options.body });
  if ([...blockedHosts].some((h) => host.includes(h))) {
    throw new Error(`（测试注入的失败）${host} 不可达`);
  }
  const init = { method, headers: options.headers || {} };
  if (options.body !== undefined) init.body = options.body;
  const resp = await fetch(url, init);
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 120)}`);
    err.status = resp.status;
    throw err;
  }
  return { responseText: text, status: resp.status };
}

/* ----------------------------- 沙箱 ----------------------------- */

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  TextEncoder,
  TextDecoder,
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
  URL,
  URLSearchParams,
  fetch,
  PathUtils: { join: (...a) => a.filter(Boolean).join("/") },
  IOUtils: { read: async () => new Uint8Array(), writeUTF8: async () => {}, makeDirectory: async () => {} },
  Zotero: {
    debug() {},
    logError(e) {
      console.log(`     [logError] ${e?.message || e}`);
    },
    version: "9.0.5",
    Prefs: {
      get: (k, global) => (global ? prefs[k.replace(/^extensions\.zotero\.bilingualReader\./, "")] : undefined),
      set(k, v, global) {
        if (global) prefs[k.replace(/^extensions\.zotero\.bilingualReader\./, "")] = v;
      },
    },
    HTTP: { request: httpRequest },
    Promise: { delay: (ms) => new Promise((r) => setTimeout(r, ms)) },
    DataDirectory: { dir: process.env.TEMP?.replace(/\\/g, "/") || "/tmp" },
    Reader: { _readers: [], registerEventListener() {} },
    Items: { get: () => null },
    getMainWindow: () => null,
    getActiveZoteroPane: () => null,
    PDFWorker: {},
    Fulltext: {},
    Attachments: { importFromFile: async () => ({ id: 1 }) },
    MenuManager: { registerMenu: () => "x", unregisterMenu() {} },
  },
  Services: { wm: { getMostRecentWindow: () => null } },
  ChromeUtils: { import: () => {} },
  Localization: {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const ORDER = [
  "01-ttf.js", "02-pdf.js", "03-deflate.js", "00-core.js", "10-translate.js",
  "20-cache.js", "30-paper.js", "40-reader.js", "50-selection.js",
  "60-main.js", "70-export.js", "99-main.js",
];
for (const f of ORDER) {
  vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
}
const T = ctx.Bilingual.translate;
check("translate 模块加载", typeof T?.translateParagraphs === "function");
check("暴露 freeEngines()", typeof T?.freeEngines === "function", JSON.stringify(T?.freeEngines?.()));

const SENTENCES = [
  "Machines do not testify.",
  "This paper argues that the testimony gap is conceptual rather than technical.",
  "We conclude with a proposal for evidentiary reform in automated courts.",
];

const isChinese = (s) => /[\u4e00-\u9fff]/.test(String(s || ""));

/* ------------------------ 逐个引擎：真实请求 ------------------------ */

const only = process.argv[2];
const enginesToTest = (only ? [only] : ["tencent", "youdao", "mymemory", "google"]);

for (const id of enginesToTest) {
  console.log(`\n=== 真端点：${id} ===`);
  prefs.engine = id;
  httpCalls = [];
  try {
    const t0 = Date.now();
    const out = await T.translateParagraphs(SENTENCES, {});
    const ms = Date.now() - t0;
    check(`返回 ${SENTENCES.length} 段`, out.length === SENTENCES.length, `得到 ${out.length}`);
    check("每段都有中文", out.every(isChinese), JSON.stringify(out.map((s) => String(s).slice(0, 24))));
    check("顺序对得上", isChinese(out[0]) && String(out[0]).includes("作证") === String(out[0]).includes("作证"),
      String(out[0]).slice(0, 40));
    check("请求头里没有 Gecko 会丢的禁用头",
      httpCalls.every((c) => !Object.keys(c.headers).some((h) => /^(referer|origin|user-agent|cookie|host)$/i.test(h))),
      JSON.stringify(httpCalls.map((c) => Object.keys(c.headers))));
    console.log(`     耗时 ${ms} ms，请求 ${httpCalls.length} 次`);
    console.log(`     译文[0] ${String(out[0]).slice(0, 60)}`);
  }
  catch (e) {
    check(`${id} 可用`, false, `${e?.message || e}`);
  }
}

/* --------------------------- 批量上限行为 --------------------------- */

console.log("\n=== 腾讯批量：40 段会自动切成 2 个请求（每块 ≤30）===");
prefs.engine = "tencent";
httpCalls = [];
{
  const many = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i + 1} of the testimony paper.`);
  try {
    const out = await T.translateParagraphs(many, {});
    check("40 段都有译文", out.length === 40 && out.every(isChinese),
      `得到 ${out.filter(isChinese).length}/40`);
    check("请求数 = 2（30 + 10）", httpCalls.length === 2, `实际 ${httpCalls.length}`);
    const sizes = httpCalls.map((c) => {
      try {
        return JSON.parse(c.body || "{}")?.source?.text_list?.length;
      }
      catch (e) {
        return "parse-error";
      }
    });
    check("块大小 30 / 10", sizes[0] === 30 && sizes[1] === 10, JSON.stringify(sizes));
  }
  catch (e) {
    check("批量翻译", false, e?.message || e);
  }
}

/* ----------------------------- 失败降级 ----------------------------- */

console.log("\n=== 降级：腾讯不可达时自动改用有道 ===");
prefs.engine = "tencent";
prefs.freeEngineFallback = true;
httpCalls = [];
blockedHosts = new Set(["transmart.qq.com"]);
try {
  const out = await T.translateParagraphs(SENTENCES, {});
  check("仍然拿到中文译文", out.every(isChinese), JSON.stringify(out.map((s) => String(s).slice(0, 20))));
  check("真的试过腾讯", httpCalls.some((c) => c.url.includes("transmart.qq.com")));
  check("最终用了有道", httpCalls.some((c) => c.url.includes("youdao.com")));
  check("统计里记了降级", T.getStats().degradedChunks > 0, JSON.stringify(T.getStats()));
}
catch (e) {
  check("降级路径", false, e?.message || e);
}
finally {
  blockedHosts = new Set();
}

console.log("\n=== 关掉降级开关后，应如实报错 ===");
prefs.engine = "youdao";
prefs.freeEngineFallback = false;
httpCalls = [];
blockedHosts = new Set(["youdao.com"]);
try {
  await T.translateParagraphs(["This must fail."], {});
  check("应当抛错", false, "居然成功了");
}
catch (e) {
  check("如实抛出错误", /有道|youdao|失败|不可达/i.test(String(e?.message || e)), String(e?.message || e).slice(0, 80));
}
finally {
  blockedHosts = new Set();
  prefs.freeEngineFallback = true;
}

/* --------------------------- 划词（单段）路径 --------------------------- */

console.log("\n=== 划词浮窗的 translateText 路径 ===");
prefs.engine = "tencent";
try {
  const one = await T.translateText("The alignment problem is essentially contestable.");
  check("单段也能翻", isChinese(one), String(one).slice(0, 60));
}
catch (e) {
  check("translateText", false, e?.message || e);
}

console.log(`\n${failures === 0 ? "✅ 免费引擎联网测试全部通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
