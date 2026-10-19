#!/usr/bin/env node
/**
 * 一键发布到 GitHub：填地址 → 构建 → 提交 → 建仓库 → 推送 → 发 Release。
 *
 * 前提：已装 GitHub CLI 且 `gh auth login` 过（只要登录一次）。
 *
 * 用法：
 *   node tools/publish-github.mjs                      # 仓库名默认 zotero-bilingual-reader
 *   node tools/publish-github.mjs --repo my-zotero     # 自定仓库名
 *   node tools/publish-github.mjs --private            # 私有仓库
 *   node tools/publish-github.mjs --dry                # 只打印将要做的事
 *
 * 干的事：
 *   1. 从 gh 读出你的 GitHub 用户名
 *   2. 把 manifest.json 里的 update_url / homepage_url 从占位地址换成真地址
 *   3. 重新构建 xpi
 *   4. 配好 git 身份（没配过的话用「用户名 + GitHub noreply 邮箱」）
 *   5. 提交、建仓库、推 main
 *   6. 发 Release，把 xpi 挂上去（Zotero 的自动更新靠它）
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GH_CANDIDATES = [
  "gh",
  "C:\\Program Files\\GitHub CLI\\gh.exe",
  join(process.env.LOCALAPPDATA || "", "Programs/GitHub CLI/gh.exe"),
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const REPO_NAME = opt("--repo", "zotero-bilingual-reader");
const PRIVATE = flag("--private");
const DRY = flag("--dry");

/* ----------------------------- 基础设施 ----------------------------- */

function findGh() {
  for (const p of GH_CANDIDATES) {
    try {
      execFileSync(p, ["--version"], { stdio: "ignore" });
      return p;
    }
    catch (e) {}
  }
  throw new Error("找不到 GitHub CLI（gh）。装一个：winget install GitHub.cli");
}

const GH = findGh();

function gh(args, opts = {}) {
  return execFileSync(GH, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...opts,
  })?.trim();
}

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  })?.trim();
}

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

function ok(msg) {
  console.log(`    ✅ ${msg}`);
}

function warn(msg) {
  console.log(`    ⚠️  ${msg}`);
}

/* ------------------------------- 1. 身份 ------------------------------- */

step(1, "检查 GitHub 登录状态");
let login;
try {
  login = gh(["api", "user", "--jq", ".login"]);
}
catch (e) {
  console.error("❌ 还没登录 GitHub。先运行：\n   gh auth login --web\n");
  process.exit(1);
}
const userId = gh(["api", "user", "--jq", ".id"]);
ok(`已登录：${login}（id ${userId}）`);

const ownerRepo = `${login}/${REPO_NAME}`;
const repoUrl = `https://github.com/${ownerRepo}`;
console.log(`    仓库地址将是：${repoUrl}${PRIVATE ? "（私有）" : ""}`);

/* --------------------------- 2. 填真实地址 --------------------------- */

step(2, "把占位地址换成真实地址");
{
  const mfPath = join(ROOT, "src", "manifest.json");
  const mf = JSON.parse(readFileSync(mfPath, "utf8"));
  mf.homepage_url = repoUrl;
  // ⚠️ update.json 这个地址踩过两个坑，别再改回去：
  //   1. raw.githubusercontent.com —— 国内 **DNS 解析失败**，自动更新静默失效
  //   2. cdn.jsdelivr.net/...@main —— 能通，但对分支地址有 **12 小时缓存**，
  //      新版本要等半天才被看到，而且官方的 purge 接口对分支地址实测刷不掉
  // 现在用「最新 Release 的附件」地址：永远指向最新一版，没有任何缓存。
  mf.applications.zotero.update_url = `${repoUrl}/releases/latest/download/update.json`;
  writeFileSync(mfPath, `${JSON.stringify(mf, null, 2)}\n`, "utf8");
  ok(`homepage_url → ${repoUrl}`);
  ok(`update_url   → ${mf.applications.zotero.update_url}`);

  const version = mf.version;
  const upPath = join(ROOT, "update.json");
  const up = JSON.parse(readFileSync(upPath, "utf8"));
  const entry = up.addons["bilingual-reader@local.plugin"].updates[0];
  entry.version = version;
  entry.update_link = `https://github.com/${ownerRepo}/releases/download/v${version}`
    + `/bilingual-reader_${version}.xpi`;
  // ⚠️ 版本范围也要跟着 manifest 走：这块如果忘了同步，
  // update.json 里会一直留着模板里的 7.0，Zotero 就会以为新版本还兼容 7/8。
  entry.applications = entry.applications || {};
  entry.applications.zotero = {
    ...(entry.applications.zotero || {}),
    strict_min_version: mf.applications.zotero.strict_min_version,
    strict_max_version: mf.applications.zotero.strict_max_version,
  };
  writeFileSync(upPath, `${JSON.stringify(up, null, 2)}\n`, "utf8");
  ok(`update.json 指向 v${version}`
    + `（Zotero ${entry.applications.zotero.strict_min_version} ~ ${entry.applications.zotero.strict_max_version}）`);
}

/* ------------------------------ 3. 构建 ------------------------------ */

step(3, "构建 xpi");
const version = JSON.parse(readFileSync(join(ROOT, "src", "manifest.json"), "utf8")).version;
const xpiRel = `build/bilingual-reader_${version}.xpi`;
const xpiAbs = join(ROOT, "build", `bilingual-reader_${version}.xpi`);
{
  const r = spawnSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout || "", r.stderr || "");
    throw new Error("构建失败");
  }
  if (!existsSync(xpiAbs)) throw new Error(`构建后找不到 ${xpiRel}`);
  ok(`${xpiRel}（${(readFileSync(xpiAbs).length / 1024).toFixed(1)} KB）`);

  // 仓库里再放一份副本：GitHub Release 的下载要经过 objects.githubusercontent.com，
  // 国内偶尔会被掐断（实测 4 次里挂 1 次）。jsDelivr 能直接读仓库文件，
  // 于是给朋友一条国内可用的备用下载地址。
  const mirrorDir = join(ROOT, "releases");
  if (!existsSync(mirrorDir)) mkdirSync(mirrorDir, { recursive: true });
  const mirrorAbs = join(mirrorDir, `bilingual-reader_${version}.xpi`);
  writeFileSync(mirrorAbs, readFileSync(xpiAbs));
  ok(`镜像副本 → releases/bilingual-reader_${version}.xpi`);
}

/* ---------------------------- 4. git 身份 ---------------------------- */

step(4, "配置 git 身份并提交");
{
  let name = "";
  let email = "";
  try {
    name = git(["config", "user.name"]);
  }
  catch (e) {}
  try {
    email = git(["config", "user.email"]);
  }
  catch (e) {}
  if (!name || !email) {
    git(["config", "user.name", login]);
    git(["config", "user.email", `${userId}+${login}@users.noreply.github.com`]);
    ok(`用 GitHub 身份：${login} <${userId}+${login}@users.noreply.github.com>`);
  }
  else {
    ok(`沿用已有身份：${name} <${email}>`);
  }

  git(["add", "-A"]);
  let dirty = "";
  try {
    dirty = git(["status", "--porcelain"]);
  }
  catch (e) {}
  if (dirty) {
    git(["commit", "-m", `双语论文助手 v${version}：一键把英文论文翻成中文，左右对照 + 导出中英对照 PDF`]);
    ok("已提交");
  }
  else {
    ok("没有新改动需要提交");
  }
}

/* ------------------------- 5. 建仓库 / 推送 ------------------------- */

step(5, `建仓库并推送 → ${ownerRepo}`);
// ⚠️ 分支必须是 main：update.json 的 raw 地址写的是 /main/，
// 而 git init 默认可能给你 master（那样 Zotero 拉更新会 404）。
try {
  git(["branch", "-M", "main"]);
  ok("分支已命名为 main");
}
catch (e) {
  warn(`改分支名失败：${e?.message || e}`);
}

let repoExists = false;
try {
  gh(["repo", "view", ownerRepo, "--json", "name"]);
  repoExists = true;
}
catch (e) {
  repoExists = false;
}

if (DRY) {
  console.log("    （--dry：不实际执行）");
}
else if (!repoExists) {
  gh(["repo", "create", ownerRepo, PRIVATE ? "--private" : "--public",
    "--source", ".", "--remote", "origin", "--push",
    "--description", "Zotero 插件：一键把英文论文翻译成中文，左右对照阅读，可导出中英对照 PDF"]);
  ok("仓库已创建并推送");
}
else {
  warn("仓库已存在，改为推送当前分支");
  const hasRemote = (() => {
    try {
      return git(["remote"]).split("\n").includes("origin");
    }
    catch (e) {
      return false;
    }
  })();
  if (!hasRemote) git(["remote", "add", "origin", `${repoUrl}.git`]);
  git(["branch", "-M", "main"]);
  git(["push", "-u", "origin", "main"]);
  ok("已推送");
}

/* ---------------------------- 6. 发 Release ---------------------------- */

step(6, `发 Release v${version} 并上传 xpi`);const notesPath = join(mkdtempSync(join(tmpdir(), "release-")), "notes.md");
{
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const re = new RegExp(`## ${version.replace(/\./g, "\\.")}[\\s\\S]*?(?=\\n## |$)`);
  const section = (changelog.match(re) || [])[0] || "";
  const notes = [
    `## 双语论文助手 v${version}`,
    "",
    "一键把英文论文翻成中文，左英文右中文对照读，还能导出「中文版 + 中英对照版」PDF。",
    "",
    section.replace(/^## .*\n/, "").trim(),
    "",
    "### 安装",
    "1. 下载下面的 `bilingual-reader_" + version + ".xpi`",
    "2. Zotero → 工具 → 插件 → 齿轮 → Install Add-on From File…",
    "3. 选中 xpi → 重启 Zotero",
    "",
    "免注册、免 API Key、国内可直连（默认腾讯交互翻译）。",
  ].join("\n");
  writeFileSync(notesPath, notes, "utf8");
}

let releaseExists = false;
try {
  gh(["release", "view", `v${version}`, "--repo", ownerRepo]);
  releaseExists = true;
}
catch (e) {
  releaseExists = false;
}

if (DRY) {
  console.log("    （--dry：不实际执行）");
}
else if (!releaseExists) {
  gh(["release", "create", `v${version}`, xpiAbs,
    join(ROOT, "update.json"),
    "--repo", ownerRepo,
    "--title", `v${version}`,
    "--notes-file", notesPath,
    "--latest"]);
  ok(`已发布 v${version}（含 xpi 与 update.json 两个附件）`);
}
else {
  warn(`v${version} 的 Release 已存在，改为覆盖上传`);
  gh(["release", "upload", `v${version}`, xpiAbs, join(ROOT, "update.json"),
    "--repo", ownerRepo, "--clobber"]);
  ok("xpi 与 update.json 已更新");
}

rmSync(dirname(notesPath), { recursive: true, force: true });

/* ------------------------------ 收尾 ------------------------------ */

console.log(`\n🎉 发布完成\n`);
console.log(`   仓库页面：${repoUrl}`);
console.log(`   Release ：${repoUrl}/releases/tag/v${version}`);
console.log(`   xpi 直链：${repoUrl}/releases/download/v${version}/bilingual-reader_${version}.xpi`);
console.log(`   xpi 镜像：https://cdn.jsdelivr.net/gh/${ownerRepo}@main/releases/bilingual-reader_${version}.xpi`);
console.log(`   自动更新：${repoUrl}/releases/latest/download/update.json`);
console.log(`\n   把「仓库页面」这个链接发给朋友就行。\n`);
