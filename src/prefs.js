/*
 * 双语论文助手 —— 默认设置
 * Zotero 安装/启用插件时会加载本文件，把下面的值写进 pref 的**默认分支**。
 *
 * ⚠️ 键名必须与 src/00-core.js 的 BILINGUAL_PREFS_PREFIX 一致，
 * 且读取时必须带 global=true（否则 Zotero.Prefs 会自动再拼一层
 * "extensions.zotero." 前缀，这些默认值就全废了）。
 *
 * ⚠️ 本文件被 loadSubScript 注入到 Zotero 的 system realm，
 * 顶层 const/let 会落到所有插件共享的词法作用域 —— 只写 pref(...) 调用，别加别的。
 */

// 翻译引擎：tencent（腾讯交互翻译，国内直连，默认）/ youdao / mymemory / google
// / deepseek / openai。老版本存的 "free" 会在代码里自动当成 tencent ——
// Google 的 clients5 端点在国内裸连实测首次要 30 秒以上。
pref("extensions.zotero.bilingualReader.engine", "tencent");
// 免费引擎连续失败时自动降级到下一个：腾讯 → 有道 → MyMemory → Google
pref("extensions.zotero.bilingualReader.freeEngineFallback", true);
pref("extensions.zotero.bilingualReader.deepseekApiKey", "");
pref("extensions.zotero.bilingualReader.deepseekBaseURL", "https://api.deepseek.com");
pref("extensions.zotero.bilingualReader.deepseekModel", "deepseek-chat");
pref("extensions.zotero.bilingualReader.openaiApiKey", "");
pref("extensions.zotero.bilingualReader.openaiBaseURL", "https://api.openai.com");
pref("extensions.zotero.bilingualReader.openaiModel", "gpt-4o-mini");
pref("extensions.zotero.bilingualReader.llmConcurrency", 2);
pref("extensions.zotero.bilingualReader.showSource", true);
pref("extensions.zotero.bilingualReader.paneWidth", 46);
// 阅读器右上角的悬浮「中译」按钮 —— 唯一的按钮入口（工具栏按钮已删掉）
pref("extensions.zotero.bilingualReader.floatingButton", true);
// 导出文档时生成哪些版本：both = 中文版 + 中英对照版（各一个 PDF），zh / bilingual = 只要一个
pref("extensions.zotero.bilingualReader.extExportMode", "both");
pref("extensions.zotero.bilingualReader.debug", false);
