#!/usr/bin/env node
/**
 * 双语论文助手 —— 一键安装/卸载脚本（以「解包目录」形式装进 Zotero 配置）
 *
 * 为什么需要它：Zotero 是 Firefox 内核，插件除了 XPI 文件本身，
 * 还要在配置目录的 extensions.json 里登记一条记录才会被加载。
 * 本脚本负责把这两步都做掉，并自动备份原文件。
 *
 * 用法：
 *   node install.mjs            # 安装（或覆盖升级）
 *   node install.mjs --uninstall
 *   node install.mjs --profile "C:\\path\\to\\profile"   # 手动指定配置目录
 *   node install.mjs --list     # 只列出检测到的配置目录
 *
 * 安装后请重启 Zotero。卸载同理。
 */

import {
  readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync,
  rmSync, readdirSync, statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ADDON_ID = "bilingual-reader@local.plugin";
const ADDON_VERSION = JSON.parse(readFileSync(join(here, "src/manifest.json"), "utf8")).version;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const UNINSTALL = flag("--uninstall");
const DRY = flag("--dry-run");
const LIST_ONLY = flag("--list");
const FORCE = flag("--force") || flag("-f");

/** 读 JSON 时容忍 UTF-8 BOM（Zotero 自己写的 extensions.json 可能带 BOM） */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function log(...a) {
  console.log(...a);
}

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

/* ------------------------ 1. 找 Zotero 配置目录 ------------------------ */

function candidateProfileRoots() {
  const appdata = process.env.APPDATA;
  const out = [];
  if (appdata) {
    // Zotero 7+/9：%APPDATA%\Zotero\Zotero\Profiles
    out.push(join(appdata, "Zotero", "Zotero"));
    // 旧版：%APPDATA%\Zotero\Profiles
    out.push(join(appdata, "Zotero"));
  }
  out.push(join(homedir(), ".zotero", "zotero"));
  out.push(join(homedir(), "Library", "Application Support", "Zotero", "Zotero"));
  return out;
}

/**
 * 解析 profiles.ini。
 * 注意：Zotero 9 的 Path 本身已经带 "Profiles/" 前缀
 * （例如 Path=Profiles/jnbq07zc.default），所以不能再无条件拼一次。
 */
function readProfilesIni(root) {
  const ini = join(root, "profiles.ini");
  if (!existsSync(ini)) return null;
  const text = readFileSync(ini, "utf8");
  const blocks = text.split(/^\s*\[/m).slice(1);
  const profiles = [];
  for (const block of blocks) {
    const [header, ...rest] = block.split(/\]\r?\n/);
    const body = rest.join("]\n");
    const name = header.trim();
    if (!/^Profile\d+$/.test(name)) continue;
    const get = (k) => {
      const m = body.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, "mi"));
      return m ? m[1].trim() : null;
    };
    const path = get("Path");
    if (!path) continue;
    const isDefault = (get("Default") || "") === "1";
    const abs = resolve(root, path.replace(/^[/\\]+/, ""));
    if (!existsSync(abs)) continue;
    profiles.push({ name, path: abs, isDefault });
  }
  return profiles.length ? profiles : null;
}

function findProfiles(explicit) {
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) die(`指定的配置目录不存在：${p}`);
    return [{ name: "(手动指定)", path: p, isDefault: true, isAddonDirTarget: true }];
  }
  const found = [];
  for (const root of candidateProfileRoots()) {
    if (!existsSync(root)) continue;
    const profiles = readProfilesIni(root);
    if (profiles) found.push(...profiles);
  }
  if (!found.length) {
    die(
      "没找到 Zotero 配置目录。请用 --profile 手动指定，例如：\n"
      + '  node install.mjs --profile "%APPDATA%\\Zotero\\Zotero\\Profiles\\xxxxxxxx.default"',
    );
  }
  return found;
}

/* ---------------------------- 2. 登记插件 ---------------------------- */

function makeAddonEntry(installPath) {
  const now = Date.now();
  const isXpi = installPath.toLowerCase().endsWith(".xpi");
  // 注意：location 与 rootURI 必须与 Zotero 自己的期望一致（对照一个能正常工作的插件抄的）：
  //   location = "app-profile"
  //   xpi 形式  → rootURI = jar:file:///<path>!/   （xpi 就是 zip）
  //   目录形式  → rootURI = file:///<path>/
  const normalized = installPath.replace(/\\/g, "/");
  const rootURI = isXpi
    ? `jar:file:///${normalized}!/`
    : `file:///${normalized}/`;
  return {
    id: ADDON_ID,
    syncGUID: "{7f3c1a10-5b64-4c2e-9a71-0d2b8e5f1c33}",
    version: ADDON_VERSION,
    type: "extension",
    loader: null,
    updateURL: null,
    installOrigins: null,
    manifestVersion: 2,
    location: "app-profile",
    optionsURL: null,
    optionsType: null,
    optionsBrowserStyle: true,
    aboutURL: null,
    hidden: false,
    blocklistURL: null,
    recommendationState: null,
    installTelemetryInfo: { source: "about:addons", method: "install-from-file" },
    defaultLocale: {
      name: "Bilingual Paper Reader (双语论文助手)",
      description: "一键把英文论文翻译成中文，左右对照阅读",
      creator: "local",
      homepageURL: null,
      developers: null,
      translators: null,
      contributors: null,
    },
    visible: true,
    active: true,
    userDisabled: false,
    appDisabled: false,
    embedderDisabled: false,
    installDate: now,
    updateDate: now,
    applyBackgroundUpdates: 1,
    path: installPath,
    skinnable: false,
    sourceURI: null,
    releaseNotesURI: null,
    softDisabled: false,
    foreignInstall: false,
    strictCompatibility: false,
    locales: [],
    targetApplications: [{ id: "zotero@zotero.org", minVersion: "7.0", maxVersion: "9.9.*" }],
    targetPlatforms: [],
    signedState: 0,
    signedTypes: [],
    signedDate: null,
    seen: true,
    dependencies: [],
    incognito: "spanning",
    userPermissions: { permissions: [], origins: [], data_collection: [] },
    optionalPermissions: { permissions: [], origins: [], data_collection: [] },
    requestedPermissions: { permissions: [], origins: [], data_collection: [] },
    icons: {
      48: "chrome/content/icons/icon48.svg",
      96: "chrome/content/icons/icon96.svg",
    },
    iconURL: null,
    blocklistAttentionDismissed: false,
    blocklistState: 0,
    startupData: null,
    rootURI,
  };
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

function zoteroRunning() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq zotero.exe"], { encoding: "utf8" });
      return /zotero\.exe/i.test(out);
    }
    const out = execFileSync("pgrep", ["-fl", "zotero"], { encoding: "utf8" });
    return out.trim().length > 0;
  }
  catch (e) {
    return false;
  }
}

/* ------------------------------ 3. 主流程 ------------------------------ */

const profiles = findProfiles(valueOf("--profile"));

if (LIST_ONLY) {
  log("\n检测到的 Zotero 配置目录：");
  for (const p of profiles) log(`  ${p.isDefault ? "★" : " "} ${p.path}`);
  log("");
  process.exit(0);
}

const target = profiles.find((p) => p.isDefault) || profiles[0];
const extDir = join(target.path, "extensions");
// xpi 形式（默认）：Zotero 官方安装方式，兼容性最好，实测可正常触发 bootstrap
const xpiPath = join(extDir, `${ADDON_ID}.xpi`);
// 解包目录形式（--unpacked）：便于开发期反复覆盖，但实测有 Zotero 不加载的情况
const unpackedDir = join(extDir, ADDON_ID);
const extJsonPath = join(target.path, "extensions.json");
const UNPACKED = flag("--unpacked");
const installPath = UNPACKED ? unpackedDir : xpiPath;

log(`\n=== 双语论文助手 v${ADDON_VERSION} ===`);
log(`配置目录: ${target.path}`);
log(`安装形式: ${UNPACKED ? "解包目录（--unpacked）" : "xpi 文件"}`);
log(`安装路径: ${installPath}`);
if (DRY) log("（--dry-run：只显示将要做的操作，不写入）");

if (zoteroRunning() && !FORCE) {
  log(
    "\n⚠️  检测到 Zotero 正在运行。"
    + "\n    Zotero 退出时会用内存里的状态覆盖 extensions.json，所以现在写入可能白写。"
    + "\n    请先完全退出 Zotero（包括托盘图标），或者加 --force 强制写入。",
  );
  if (!DRY) die("已中止。退出 Zotero 后重试，或使用：node install.mjs --force");
}

if (UNINSTALL) {
  // 两种形式都清掉，避免残留
  for (const p of [unpackedDir, xpiPath]) {
    if (existsSync(p)) {
      log(`\n将删除：${p}`);
      if (!DRY) rmSync(p, { recursive: true, force: true });
    }
  }
  if (existsSync(extJsonPath)) {
    let data;
    try {
      data = readJson(extJsonPath);
    }
    catch (e) {
      die(`extensions.json 解析失败（未做修改）：${e.message}`);
    }
    const before = data.addons?.length ?? 0;
    data.addons = (data.addons || []).filter((a) => a.id !== ADDON_ID);
    log(`将从 extensions.json 移除登记（原有 ${before} 条 → ${data.addons.length} 条）`);
    if (!DRY) {
      copyFileSync(extJsonPath, `${extJsonPath}.bak-bilingual`);
      writeFileSync(extJsonPath, JSON.stringify(data), "utf8");
    }
  }
  log("\n✅ 卸载完成，重启 Zotero 生效。\n");
  process.exit(0);
}

if (DRY) {
  log("\n（--dry-run 结束，未写入任何文件）");
  log(`将要写入：\n  1. ${installPath}\n  2. ${extJsonPath}  (新增一条 ${ADDON_ID} 登记，原文件备份为 extensions.json.bak-bilingual)`);
  if (zoteroRunning()) log("\n⚠️  Zotero 正在运行，正式安装前请先退出它。");
  log("");
  process.exit(0);
}

// 安装
const xpiCandidates = (() => {
  const buildDir = join(here, "build");
  if (!existsSync(buildDir)) return [];
  return readdirSync(buildDir)
    .filter((f) => f.endsWith(".xpi"))
    .map((f) => join(buildDir, f));
})();
if (!xpiCandidates.length) {
  die("找不到构建产物。请先在项目根目录运行：node build.mjs");
}
const xpiSource = xpiCandidates.sort().reverse()[0]; // 版本号最大者

log(`\n安装源: ${xpiSource}`);

// 先清掉旧的两种形式，避免版本混淆
rmSync(unpackedDir, { recursive: true, force: true });
rmSync(xpiPath, { force: true });

if (UNPACKED) {
  const stageDir = join(here, "build", "stage");
  mkdirSync(unpackedDir, { recursive: true });
  if (existsSync(stageDir)) {
    copyTree(stageDir, unpackedDir);
  }
  else {
    execFileSync("tar", ["-xf", xpiSource, "-C", unpackedDir], { stdio: "inherit" });
  }
}
else {
  copyFileSync(xpiSource, xpiPath);
}

// 登记到 extensions.json
let data = { schemaVersion: 37, addons: [] };
if (existsSync(extJsonPath)) {
  try {
    data = readJson(extJsonPath);
    copyFileSync(extJsonPath, `${extJsonPath}.bak-bilingual`);
  }
  catch (e) {
    die(`extensions.json 解析失败（已保留原文件，未做修改）：${e.message}`);
  }
}
data.addons = (data.addons || []).filter((a) => a.id !== ADDON_ID);
data.addons.push(makeAddonEntry(installPath));
writeFileSync(extJsonPath, JSON.stringify(data), "utf8");

log("\n✅ 安装完成。");
log("   下一步：重启 Zotero → 打开一篇英文 PDF → 点工具栏「译」或按 Ctrl+Alt+T。\n");
