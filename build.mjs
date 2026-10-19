#!/usr/bin/env node
/**
 * 构建脚本：把 src/ 打包成可安装的 .xpi
 *
 *   1. 按固定顺序把 src/*.js 拼成一个 chrome/content/scripts/bilingual.js
 *      （Zotero 插件沙箱里每个文件共享全局作用域，所以合并时要防止顶层重复声明）
 *   2. 用 new Function() 对每个源文件做语法校验（不执行）
 *   3. 生成 build/<name>_<version>.xpi
 *
 * 用法：node build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = here;
const SRC = join(here, "src");
const BUILD = join(here, "build");
const STAGE = join(BUILD, "stage");

/** 加载顺序很重要：
 *  工具层（TTF 子集化 / PDF 写出，自建命名空间）→ 核心 → 引擎 → 缓存 → 论文
 *  → 阅读器 → 划词 → 导出 → 主窗口 → 入口 */
const JS_ORDER = [
  "01-ttf.js",
  "02-pdf.js",
  "03-deflate.js",
  "00-core.js",
  "10-translate.js",
  "20-cache.js",
  "30-paper.js",
  "40-reader.js",
  "50-selection.js",
  "60-main.js",
  "70-export.js",
  "99-main.js",
];

const COPY = [
  ["manifest.json", "manifest.json"],
  ["bootstrap.js", "bootstrap.js"],
  ["prefs.js", "prefs.js"],
  ["preferences.xhtml", "chrome/content/preferences.xhtml"],
  ["preferences.js", "chrome/content/preferences.js"],
  ["icons/icon48.svg", "chrome/content/icons/icon48.svg"],
  ["icons/icon96.svg", "chrome/content/icons/icon96.svg"],
];

function log(...a) {
  console.log(...a);
}

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

/* ------------------------------ 1. 校验 ------------------------------ */

const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
const version = manifest.version;
const addonId = manifest.applications?.zotero?.id || "plugin";
const safeName = addonId.split("@")[0].replace(/[^\w.-]/g, "_");
const xpiName = `${safeName}_${version}.xpi`;

log(`\n=== 构建 ${manifest.name} v${version} ===`);

// 发布前提醒：update_url / homepage_url 还是占位地址的话，老用户收不到更新
{
  const placeholder = /github\.com\/local\/|YOUR_NAME|githubusercontent\.com\/local\//;
  const fields = [
    ["applications.zotero.update_url", manifest.applications?.zotero?.update_url],
    ["homepage_url", manifest.homepage_url],
  ];
  for (const [label, value] of fields) {
    if (value && placeholder.test(String(value))) {
      log(`⚠️  ${label} 还是占位地址：${value}`);
      log("    真要发布的话先改成你自己的 GitHub 仓库（见 发布到GitHub.md）");
    }
  }
}
log(`插件 ID: ${addonId}`);
log(`兼容: Zotero ${manifest.applications.zotero.strict_min_version} ~ ${manifest.applications.zotero.strict_max_version}\n`);

/* --------------------------- 2. 语法校验 --------------------------- */

function checkSyntax(code, label) {
  try {
    // 构造函数只解析不执行；顶层 return 会报错，所以包一层函数体
    // eslint-disable-next-line no-new-func
    new Function(code);
    return true;
  }
  catch (e) {
    fail(`${label} 语法错误：${e.message}`);
  }
}

const allFiles = [...JS_ORDER, "preferences.js", "bootstrap.js"];

// 检查顶层重复声明（合并后同作用域会互相覆盖 / 报错）
const topLevelDecl = new Map();
const DECL_RE = /^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm;

for (const f of JS_ORDER) {
  const p = join(SRC, f);
  if (!existsSync(p)) fail(`缺少源文件：${f}`);
  const code = readFileSync(p, "utf8");
  checkSyntax(code, f);
  for (const m of code.matchAll(DECL_RE)) {
    const name = m[1];
    if (topLevelDecl.has(name)) {
      fail(`顶层重复声明 "${name}"：${topLevelDecl.get(name)} 与 ${f} 冲突（合并后同处一个作用域）`);
    }
    topLevelDecl.set(name, f);
  }
}
log(`✅ 语法校验通过：${allFiles.length} 个 js 文件`);

/* ------------------- 2b. 设置面板片段的硬性约束 ------------------- */

// 血泪教训：Zotero 用 MozXULElement.parseXULToFragment() 解析这个片段，
// 如果文件以 XML 声明（<?xml ...?>）或注释开头，解析会失败，
// 而 Zotero 只是静默吞掉异常 —— 设置面板变成一片空白，极难排查。
{
  const panePath = join(SRC, "preferences.xhtml");
  const pane = readFileSync(panePath, "utf8");
  const head = pane.replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<?xml")) {
    fail("preferences.xhtml 以 XML 声明开头，parseXULToFragment 会解析失败（面板会空白）。删掉这一行。");
  }
  if (head.startsWith("<!--")) {
    fail("preferences.xhtml 以注释开头，parseXULToFragment 可能解析失败。把注释放到根元素之后。");
  }
  if (!pane.includes('id="bilingual-prefs-root"')) {
    fail("preferences.xhtml 里找不到 id=\"bilingual-prefs-root\"（设置面板脚本靠它定位容器）。");
  }
  log("✅ 设置面板片段约束通过（无 XML 声明 / 无前导注释 / 容器 id 存在）");
}

/* --------------------------- 3. 合并主脚本 --------------------------- */

const banner = `/*
 * ${manifest.name} v${version}
 * 本文件由 build.mjs 从 src/*.js 合并生成，请勿直接编辑。
 * 生成时间：${new Date().toISOString()}
 */
`;

const merged = banner + JS_ORDER.map((f) => {
  const code = readFileSync(join(SRC, f), "utf8");
  return `\n/* ======================= ${f} ======================= */\n${code}\n`;
}).join("\n");

checkSyntax(merged, "bilingual.js(merged)");
log(`✅ 合并完成：${(merged.length / 1024).toFixed(1)} KB`);

/* ----------------------------- 4. 组装 xpi ----------------------------- */

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "chrome/content/scripts"), { recursive: true });
mkdirSync(join(STAGE, "chrome/content/icons"), { recursive: true });

writeFileSync(join(STAGE, "chrome/content/scripts/bilingual.js"), merged, "utf8");

for (const [from, to] of COPY) {
  const srcPath = join(SRC, from);
  if (!existsSync(srcPath)) fail(`缺少待打包文件：${from}`);
  mkdirSync(dirname(join(STAGE, to)), { recursive: true });
  cpSync(srcPath, join(STAGE, to));
}

// XPIs 就是 zip。这里用 node:zlib 手写 zip，避免依赖外部压缩工具。
const xpiPath = join(BUILD, xpiName);
if (existsSync(xpiPath)) rmSync(xpiPath);

writeZip(STAGE, xpiPath);
log(`\n✅ 已生成：${xpiPath}`);

/* ------------------- 5. 静态检查：未声明的调用目标 ------------------- */

/**
 * 语法检查抓不到"调用了不存在的函数"（那要运行时才炸，而且往往被 try/catch 吞掉）。
 * getSavedPos 就是这么漏的：悬浮按钮永远挂不上，日志里一个字都没有。
 * 这里在打包后再跑一遍引用检查，有未声明的名字就让构建失败。
 */
try {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "tools", "check-refs.mjs"), join(STAGE, "chrome/content/scripts/bilingual.js")],
    { encoding: "utf8" },
  );
  const flagged = out.split("\n").filter((l) => l.trim().startsWith("- "));
  log(`✅ 引用检查通过（${flagged.length} 处"沙箱缺失但已兜底"的全局）`);
}
catch (e) {
  const text = `${e.stdout || ""}${e.stderr || ""}`;
  console.error(text.trim());
  fail("存在『调用了但没定义』的标识符（见上面 tools/check-refs.mjs 的输出）。");
}

/**
 * 递归打包目录为 zip（deflate 压缩）。
 * ZIP 结构与 Mozilla nsIZipReader 兼容：本地文件头 + 中央目录 + EOCD。
 */
function writeZip(dir, outPath) {
  const entries = [];
  (function walk(d, base = "") {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(d, ent.name), rel);
      else entries.push({ rel, abs: join(d, ent.name) });
    }
  })(dir);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
    return (c ^ -1) >>> 0;
  }

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { rel, abs } of entries) {
    const nameBuf = Buffer.from(rel, "utf8");
    const raw = readFileSync(abs);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 通用标志位：UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0x21, 12); // 修改日期（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cd.writeUInt16LE(20, 4); // 创建版本
    cd.writeUInt16LE(20, 6); // 解压所需版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // 扩展字段
    cd.writeUInt16LE(0, 32); // 注释
    cd.writeUInt16LE(0, 34); // 起始磁盘
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, eocd]));
}

/* ----------------------------- 5. 自检清单 ----------------------------- */

const stageFiles = [];
(function walk(dir, base = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel);
    else stageFiles.push(rel);
  }
})(STAGE);

log("\n打包内容：");
for (const f of stageFiles.sort()) log(`  ${f}`);
log("");
