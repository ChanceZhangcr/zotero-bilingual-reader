# 更新日志

版本号按「第几位改了会让人重新认识这个插件」来走，不严格套语义化版本。

## 1.4.3

- **修**：自动更新的地址换成「最新 Release 的附件」
  （`https://github.com/…/releases/latest/download/update.json`）。
  之前的两个地址都有坑：`raw.githubusercontent.com` 国内 DNS 解析失败；
  `cdn.jsdelivr.net/...@main` 能通但有 **12 小时缓存**，新版本要等半天才被看到，
  而且 jsDelivr 官方的 purge 接口对分支地址实测刷不掉
- **改**：`build.mjs` 在这两种地址出现时直接警告/报错，防止再踩
- **改**：发布脚本顺带把 `update.json` 作为 Release 附件上传（上面那个地址就指向它）

## 1.4.2

- **改**：明确适用范围 —— **只支持 Zotero 9 + Windows**。`strict_min_version` 从 7.0 提到 9.0，
  Zotero 7/8 会直接提示不兼容（之前写的 7/8 支持其实没验证过）
- **改**：文档、安装说明、插件内帮助文案里的 macOS / Linux 说法全部去掉
- **新增**：`AUTHORS.md`，写明这个插件由 **ChanceZhangcr（需求/测试）与 DeepSeek（实现）共同完成**

## 1.4.1

- **修**：PDF 导出时英文按**单词**边界折行，不再出现 `explain / ability` 这种把词劈成两半
- **修**：中文避头尾 —— 不再让「，」「。」跑到行首
- **新增**：TTC 字体集合支持（macOS 的苹方/宋体全是 .ttc，之前 Mac 上导不出 PDF）
- **新增**：字体候选扩到 macOS 的 Songti / Hiragino、Linux 的 Noto / 文泉驿

## 1.4.0

- **新增**：4 个免密钥翻译引擎 —— 腾讯交互翻译（默认，国内直连）、有道、MyMemory、Google
- **新增**：免费引擎失败自动降级（腾讯 → 有道 → MyMemory → Google）
- **改**：默认引擎从 Google 换成腾讯（Google 端点国内裸连首次要 30 秒以上）
- **改**：老配置里的 `free`（即 Google）自动映射到腾讯
- **改**：引擎请求头只留 `Content-Type` / `Accept`（Gecko 会静默丢弃 Referer / Origin / User-Agent）
- **改**：所有免费引擎共用同一个缓存签名，换引擎不会让已有译文缓存失效

## 1.3.5

- **新增**：导出默认生成**两个** PDF ——「中文译文」和「中英对照」
- **新增**：中英对照版英文原文灰色小一号字、左侧缩进，逐段紧跟中文
- **新增**：设置里可选「两个版本 / 只要中文版 / 只要中英对照版」

## 1.3.4

- **修**：导出失败 `Parent item … must be a regular item` —— 从阅读器导出时拿到的是 **PDF 附件**，必须换成它的父条目才能挂子附件
- **新增**：字体缺字降级（© → (C)、ä → a、− → -），不再在 PDF 里留空白
- **新增**：`tools/test-export-attach.mjs` 离线回归测试（这个 bug 在修复前会让测试变红）

## 1.3.3

- **删**：阅读器工具栏里的「中译」按钮（和 Translate for Zotero 的红「译」挤在一起，容易点错）
- 现在只剩下右上角的悬浮按钮、`Ctrl+Alt+T`、菜单三个入口

## 1.3.2

- **修**：`getSavedPos` 只有调用没有定义 → `ReferenceError` 被 try/catch 吞掉 → **悬浮按钮从来挂不到页面上**（"悬浮按钮一直没看见"的真因）
- **改**：`utils.log` 同时写进诊断日志（以前只进控制台，静默失败完全没痕迹）
- **新增**：`tools/check-refs.mjs` 静态检查"调用了但没定义"的函数，已接进构建
- **修**：面板被 Zotero 重渲染清掉后能就地挂回，不用重翻

## 1.3.0 – 1.0.0

一路把骨架搭起来：分栏面板、按段缓存、字号/宽度控制、PDF 导出（自研 CIDFontType2 字体子集 + 纯 JS DEFLATE，因为 Zotero 沙箱里没有 `CompressionStream`）、划词翻译、右键菜单、快捷键、设置面板。
