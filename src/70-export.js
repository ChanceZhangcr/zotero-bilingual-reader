/* eslint-env mozilla */
/**
 * 导出：把中文译文生成独立文档，作为子附件挂到原条目下面。
 *
 * 产物两种：
 *   - PDF（自绘：CIDFontType2 + Identity-H + 内嵌字体子集），可标注、可搜索
 *   - HTML（始终可用，走 Zotero 的网页快照附件，排版可控）
 *
 * 字体：从系统字体目录取一份含中文的 TTF，**只子集化用到的字形**
 * （10 MB 的 simfang.ttf → 约 60 KB），避免产出巨大的 PDF。
 */

Bilingual.exporter = (() => {
  const { utils } = Bilingual;
  const B = Bilingual.tools.bytes;

  /**
   * 候选中文字体。TTF 优先（体积小、已验证），TTC 字体集合作为兜底
   * （macOS 基本只有 PingFang.ttc / Songti.ttc 这类集合）。
   */
  const FONT_CANDIDATES = [
    "C:\\Windows\\Fonts\\simfang.ttf", // 仿宋
    "C:\\Windows\\Fonts\\simhei.ttf", // 黑体
    "C:\\Windows\\Fonts\\Deng.ttf", // 等线
    "C:\\Windows\\Fonts\\simkai.ttf", // 楷体
    "C:\\Windows\\Fonts\\STSONG.TTF", // 华文宋体
    "C:\\Windows\\Fonts\\msyh.ttc", // 微软雅黑（TTC）
    "C:\\Windows\\Fonts\\simsun.ttc", // 宋体（TTC）
    "/System/Library/Fonts/PingFang.ttc", // macOS
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
  ];

  let fontCache = null;

  /**
   * 读取二进制文件（系统字体等）。
   *
   * ⚠️ 用 IOUtils.read，**不要**用 Zotero.HTTP.request 读 file:// ——
   * 阅读器/插件上下文里有协议拦截器，file:// 请求会被拦掉或不返回
   * （表现就是"导出失败"但没有具体原因）。
   * IOUtils 是 Zotero 沙箱直接提供的（见 plugins.js 的 Object.assign(scope, {IOUtils})）。
   */
  async function readBinaryFile(path) {
    const bytes = await IOUtils.read(path);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /** 文件是否存在（IOUtils.exists 在某些版本不存在，做兼容） */
  async function fileExists(path) {
    try {
      if (typeof IOUtils.exists === "function") return await IOUtils.exists(path);
    }
    catch (e) {}
    try {
      await IOUtils.read(path);
      return true;
    }
    catch (e) {
      return false;
    }
  }

  /**
   * 只读文件头 4 字节做 sfnt 签名检查。
   * 接受 0x00010000 / 'true'（单体 TTF）与 'ttcf'（字体集合 TTC）。
   * 启动时探测字体用它，避免把 10 MB 字体整个读进内存。
   */
  async function probeFont(path) {
    let bytes;
    try {
      bytes = await IOUtils.read(path, { maxBytes: 4 });
    }
    catch (e) {
      // 老版本 IOUtils.read 没有 maxBytes 选项，退化整读
      bytes = await IOUtils.read(path);
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 4) throw new Error("读取字节数不足");
    const sig = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
    if (sig !== 0x00010000 && sig !== 0x74727565 && sig !== 0x74746366) {
      throw new Error(`不是 TrueType 字体（签名 0x${sig.toString(16)}）`);
    }
    return true;
  }

  /** 列出可用的中文字体（导出诊断用） */
  async function listAvailableFonts() {
    const found = [];
    for (const p of FONT_CANDIDATES) {
      if (!/\.(ttf|ttc)$/i.test(p)) continue;
      try {
        if (await probeFont(p)) found.push(p);
      }
      catch (e) {}
    }
    return found;
  }

  /** 载入并解析一份中文字体（结果缓存） */
  async function loadFont(log) {
    if (fontCache) return fontCache;
    const tried = [];
    for (const path of FONT_CANDIDATES) {
      if (!/\.(ttf|ttc)$/i.test(path)) continue;
      try {
        if (!(await fileExists(path))) {
          tried.push(`${path}: 文件不存在`);
          continue;
        }
        const bytes = await readBinaryFile(path);
        // TTC 是字体集合，parseTTF 会取第 0 个（一般是 Regular 字重）
        const font = Bilingual.tools.ttf.parseTTF(bytes);
        fontCache = { path, font, bytes };
        log?.(`已载入中文字体 ${path}（${(bytes.length / 1048576).toFixed(1)} MB`
          + `${/\.ttc$/i.test(path) ? "，字体集合取第 0 个" : ""}）`);
        return fontCache;
      }
      catch (e) {
        tried.push(`${path}: ${e?.message || e}`);
      }
    }
    throw new Error(
      "找不到可用的中文字体（TTF 或 TTC 都行，例如 C:\\Windows\\Fonts\\simfang.ttf）。"
      + (tried.length ? `\n尝试记录：${tried.join("; ")}` : ""),
    );
  }

  /**
   * 从译文缓存/结果里收集段落，按页分组。
   *
   * @param {Array} pages 译文分页结构（每段含 src 原文 / dst 译文）
   * @param {{docTitle?: string, bilingual?: boolean}} [meta]
   *   bilingual = true 时每段输出「英文原文 + 中文译文」两行，
   *   英文行带 style:"en"（PDF 里会渲染成灰色缩进，便于区分）
   */
  function collectSections(pages, meta = {}) {
    const { bilingual = false } = meta;
    const sections = [];
    for (const page of pages) {
      const paras = [];
      for (const para of page.paragraphs) {
        const zh = (para.dst || "").trim();
        const en = (para.src || "").trim();
        if (bilingual) {
          if (en) paras.push({ text: en, style: "en" });
          if (zh) paras.push({ text: zh, style: "zh" });
        }
        else if (zh) {
          paras.push(zh);
        }
      }
      if (paras.length) sections.push({ title: `第 ${page.page} 页`, paragraphs: paras });
    }
    if (meta.docTitle) {
      sections.unshift({ title: "标题", paragraphs: [meta.docTitle] });
    }
    return sections;
  }

  /* --------------------------- 父条目 / 条目名 --------------------------- */

  /**
   * 找出"可以挂子附件"的常规条目。
   *
   * ⚠️ 踩过的坑：从阅读器里导出时，`reader.itemID` 指向的是 **PDF 附件**，
   * 不是文献条目。把附件直接当 parentItemID 传给 Zotero 会被拒绝：
   *   Parent item 1/LTNT58ZP must be a regular item
   * （Zotero 不允许"附件下面再挂附件"。）所以这里要往上一级找它的父条目。
   *
   * @returns {object|null} 常规条目；独立附件（没有父条目）返回 null
   */
  function resolveParentItem(item) {
    try {
      if (!item) return null;
      if (typeof item.isRegularItem === "function" && item.isRegularItem()) return item;
      if (typeof item.isAttachment === "function" && item.isAttachment()) {
        const parent = item.parentItem
          || (item.parentID ? Zotero.Items.get(item.parentID) : null);
        if (parent && typeof parent.isRegularItem === "function" && parent.isRegularItem()) {
          return parent;
        }
      }
    }
    catch (e) {}
    return null;
  }

  /** 条目的可读名称（附件退回文件名），用于标题与日志 */
  function displayTitle(item) {
    try {
      const t = item?.getField?.("title");
      if (t) return t;
    }
    catch (e) {}
    try {
      const f = item?.getField?.("filename");
      if (f) return String(f).replace(/\.[a-z0-9]+$/i, "");
    }
    catch (e) {}
    return "论文";
  }

  /* --------------------------- 字体缺字降级 --------------------------- */

  /**
   * 中文字体（simfang/simhei/Deng…）缺的字：©、− (U+2212)、带变音符号的拉丁字母。
   * 不处理的话 PDF 里那几个位置就是空白 —— 日志里会看到
   * "字体缺少这些字符（会显示为空白）：©ä−"。
   */
  const CHAR_FALLBACKS = {
    0x00a9: "(C)",
    0x00ae: "(R)",
    0x2122: "(TM)",
    0x00b0: "°",
    0x00a0: " ",
    0x2009: " ",
    0x200b: "",
    0x2010: "-",
    0x2011: "-",
    0x2012: "-",
    0x2013: "-",
    0x2014: "-",
    0x2212: "-",
    0x00d7: "x",
    0x00f7: "/",
    0x2264: "<=",
    0x2265: ">=",
    0x2248: "~",
    0x2192: "->",
    0x2190: "<-",
    0x2026: "...",
    0x2022: "·",
  };

  /**
   * 造一个"把字体里没有的字符换成能显示的等价写法"的函数。
   * 顺序：替换表 → 去掉变音符号（ä→a、é→e）→ 实在没有就不画。
   */
  function makeTextFixer(font) {
    const has = (cp) => {
      try {
        if (!font?.charToGlyph) return true;
        return font.charToGlyph.has(cp) === true;
      }
      catch (e) {
        return true;
      }
    };
    const fix = (text) => {
      const s = String(text ?? "");
      let out = "";
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (has(cp)) {
          out += ch;
          continue;
        }
        const mapped = CHAR_FALLBACKS[cp];
        if (typeof mapped === "string") {
          out += mapped;
          fix.replaced += 1;
          continue;
        }
        let folded = "";
        try {
          folded = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        }
        catch (e) {
          folded = "";
        }
        if (folded && folded !== ch && [...folded].every((c) => has(c.codePointAt(0)))) {
          out += folded;
          fix.replaced += 1;
          continue;
        }
        // 真的没有对应字形：丢掉，别在 PDF 里留一个空白方块
        fix.dropped += 1;
      }
      return out;
    };
    fix.replaced = 0;
    fix.dropped = 0;
    return fix;
  }

  /* ------------------------------- PDF ------------------------------- */

  async function buildPdfBytes({ pages, docTitle, log, bilingual = false }) {
    const sections0 = collectSections(pages, { docTitle, bilingual });
    // 段落有两种形态：纯字符串（中文版）/ {text, style}（对照版的英文行）
    const paraText = (p) => (p && typeof p === "object" ? String(p.text ?? "") : String(p ?? ""));
    const totalChars = sections0.reduce(
      (n, s) => n + s.paragraphs.reduce((m, p) => m + paraText(p).length, 0),
      0,
    );
    if (!totalChars) throw new Error("还没有中文译文可以导出，请先翻译");
    log?.(`准备导出 ${sections0.length} 页、约 ${totalChars} 字`
      + (bilingual ? "（中英对照版）" : "（中文版）"));

    const { path, font } = await loadFont(log);

    // 先按字体能力修一遍文本，再收集字符集 —— 否则缺字的地方会是空白
    const fixText = makeTextFixer(font);
    // ⚠️ 不能直接 fixText(p)：p 在对照版里是对象，String({}) 会变成 "[object Object]"
    const fixPara = (p) => (p && typeof p === "object"
      ? { text: fixText(p.text), style: p.style }
      : fixText(p));
    const sections = sections0.map((s) => ({
      title: fixText(s.title),
      paragraphs: s.paragraphs.map(fixPara),
    }));
    if (fixText.replaced || fixText.dropped) {
      log?.(`字体缺字处理：替换 ${fixText.replaced} 处`
        + (fixText.dropped ? `，丢弃 ${fixText.dropped} 处（无等价写法）` : ""));
    }

    // 收集所有要画的字符（含页眉标题与页码）
    const cps = new Set();
    const add = (t) => {
      for (const ch of String(t)) cps.add(ch.codePointAt(0));
    };
    add(docTitle || "中文译文");
    add("第 页 / 共 0123456789");
    for (const s of sections) {
      add(s.title);
      // ⚠️ 这里同样要取 .text：直接把段落对象丢给 addText 会只收集到
      // "[object Object]" 的字符，子集里没有正文汉字 → 整篇变成空白（踩过）
      for (const p of s.paragraphs) add(paraText(p));
    }

    const t0 = Date.now();
    const subset = Bilingual.tools.ttf.subsetFont(font, [...cps]);
    log?.(`字体子集化：${cps.size} 个字符 → ${(subset.fontBuffer.length / 1024).toFixed(1)} KB`
      + `（${Date.now() - t0} ms，源自 ${path}）`);

    const pdfBytes = await Bilingual.tools.pdf.buildPDF({
      sections,
      subset,
      deflate: Bilingual.tools.pdf.deflateZlib,
      title: docTitle || "中文译文",
    });
    if (pdfBytes.missingChars) {
      log?.(`⚠️ 字体仍缺这些字符（会显示为空白）：${pdfBytes.missingChars}`);
    }
    return { bytes: pdfBytes, sections, fontPath: path };
  }

  /* ------------------------------- HTML ------------------------------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildHtml({ pages, docTitle, sourceItem, bilingual = false }) {
    const sections = collectSections(pages, { docTitle, bilingual });
    const title = docTitle || "中文译文";
    const meta = [];
    try {
      if (sourceItem) {
        const creators = sourceItem.getCreators?.() || [];
        if (creators.length) {
          meta.push(creators.map((c) => c.name || `${c.firstName} ${c.lastName}`).join(", "));
        }
        const pub = sourceItem.getField?.("publicationTitle");
        const date = sourceItem.getField?.("date");
        if (pub) meta.push(pub);
        if (date) meta.push(date);
        const doi = sourceItem.getField?.("DOI");
        if (doi) meta.push(`DOI: ${doi}`);
      }
    }
    catch (e) {}

    const paraHtml = (p) => {
      const text = p && typeof p === "object" ? p.text : p;
      const style = p && typeof p === "object" ? p.style : "";
      if (style === "en") return `<p class="en">${escapeHtml(text)}</p>`;
      return `<p>${escapeHtml(text)}</p>`;
    };
    const body = sections.map((s) => `
    <section>
      <h2>${escapeHtml(s.title)}</h2>
      ${s.paragraphs.map(paraHtml).join("\n      ")}
    </section>`).join("\n");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 40px 24px 80px; max-width: 46em;
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    font-size: 16px; line-height: 1.85; color: #1a1a1a; background: #fff;
  }
  header { border-bottom: 2px solid #407bd2; padding-bottom: 14px; margin-bottom: 28px; }
  h1 { font-size: 1.4em; margin: 0 0 6px; line-height: 1.5; }
  .meta { color: #666; font-size: 0.85em; }
  h2 { font-size: 1em; color: #407bd2; margin: 34px 0 12px;
       border-left: 3px solid #407bd2; padding-left: 10px; }
  p { margin: 0 0 14px; text-align: justify; }
  p.en { color: #666; font-size: 0.92em; margin: 0 0 6px; padding-left: 12px;
         border-left: 2px solid #e3e3e3; }
  footer { margin-top: 48px; padding-top: 12px; border-top: 1px solid #ddd;
           color: #888; font-size: 0.8em; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1e; color: #e6e6e6; }
    .meta, footer { color: #9a9a9a; }
    h2 { color: #7aa9e8; border-left-color: #7aa9e8; }
    header { border-bottom-color: #7aa9e8; }
    footer { border-top-color: #3a3a3c; }
  }
  @media print { body { max-width: none; padding: 0; } }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${meta.length ? escapeHtml(meta.join(" · ")) : ""}</div>
    <div class="meta">中文译文由「双语论文助手」生成 · ${new Date().toLocaleString("zh-CN")}</div>
  </header>
${body}
  <footer>本文件为机器翻译结果，仅供阅读参考；引用请以原文为准。</footer>
</body>
</html>`;
  }

  /* ---------------------------- 生成附件 ---------------------------- */

  /** 把字节写成临时文件 */
  async function writeTemp(bytes, filename) {
    const dir = await utils.getDataDirectory();
    if (!dir) throw new Error("无法访问插件数据目录");
    const exportDir = PathUtils.join(dir, "exports");
    await IOUtils.makeDirectory(exportDir, { ignoreExisting: true });
    const path = PathUtils.join(exportDir, filename);
    await IOUtils.write(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return path;
  }

  /** 生成安全的文件名 */
  function safeName(base, ext) {
    const cleaned = String(base || "译文")
      .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `${cleaned || "译文"}.${ext}`;
  }

  /**
   * 导出前的环境自检：缺什么就直说缺什么，
   * 而不是最后抛一句笼统的"导出失败"（这个坑踩过）。
   */
  function preflight() {
    const missing = [];
    if (typeof IOUtils === "undefined" || typeof IOUtils.read !== "function") {
      missing.push("IOUtils（无法读字体/写文件）");
    }
    if (typeof PathUtils === "undefined") missing.push("PathUtils");
    if (typeof Zotero.Attachments?.importFromFile !== "function") {
      missing.push("Zotero.Attachments.importFromFile（无法建附件）");
    }
    if (typeof Bilingual.tools?.ttf?.subsetFont !== "function") {
      missing.push("字体子集化模块");
    }
    if (typeof Bilingual.tools?.pdf?.buildPDF !== "function") {
      missing.push("PDF 生成模块");
    }
    // 压缩：优先 CompressionStream，没有就用自研纯 JS DEFLATE。
    // ⚠️ Zotero 沙箱里**没有** CompressionStream，所以这条不能当成硬性缺失。
    const hasNativeCompress = typeof CompressionStream === "function";
    const hasOwnCompress = typeof Bilingual.tools?.deflate?.deflateZlib === "function";
    if (!hasNativeCompress && !hasOwnCompress) {
      missing.push("压缩能力（CompressionStream 与内置 DEFLATE 都不可用）");
    }
    if (missing.length) {
      throw new Error(`导出环境缺少：${missing.join("、")}`);
    }
  }

  /** 两种导出模式的中文名与标题后缀 */
  const MODES = {
    zh: { label: "中文版", suffix: "（中文译文）" },
    bilingual: { label: "中英对照版", suffix: "（中英对照）" },
  };

  /**
   * 导出**一个版本**并挂为子附件。
   * @param {object} item 文献条目**或它的 PDF 附件**（阅读器里拿到的是附件）
   * @param {Array} pages 译文分页结构
   * @param {{format?: 'pdf'|'html', title?: string, log?: Function,
   *          mode?: 'zh'|'bilingual'}} opts
   *   mode = "zh"        只有中文译文
   *   mode = "bilingual" 英文原文 + 中文译文（原文灰色缩进）
   * @returns {Promise<{item: object, format: string, bytes: number,
   *          parentItem: object|null, mode: string}>}
   */
  async function exportTranslation(item, pages, opts = {}) {
    const { format = "html", title, log, mode = "zh" } = opts;
    preflight();
    if (!item) throw new Error("缺少条目（请从文献列表或阅读器里操作）");
    if (typeof item.id !== "number") throw new Error("条目 id 无效，无法挂附件");
    const modeInfo = MODES[mode] || MODES.zh;

    // 阅读器给的是 PDF 附件，必须换成它的父条目，否则 Zotero 拒绝建子附件
    const parent = resolveParentItem(item);
    const nameSource = parent || item;
    const docTitle = title || `${displayTitle(nameSource)}${modeInfo.suffix}`;

    // 逐阶段记录，出错时能定位到具体环节
    const stage = async (name, fn) => {
      log?.(`导出阶段：${name}`);
      try {
        return await fn();
      }
      catch (e) {
        throw new Error(`${name} 失败：${e?.message || e}`);
      }
    };

    /** 建附件：有父条目就挂上去；独立附件就只能作为独立附件放进同一个文库 */
    const makeImportOptions = (path, suffix, contentType, extra = {}) => {
      const o = {
        file: path,
        title: `${docTitle}${suffix}`,
        contentType,
        ...extra,
      };
      if (parent) {
        o.parentItemID = parent.id;
      }
      else if (typeof item.libraryID === "number") {
        // 独立附件：至少放进同一个文库（用户库/群组库）
        o.libraryID = item.libraryID;
      }
      return o;
    };

    if (format === "pdf") {
      const { bytes } = await stage("生成 PDF", () => buildPdfBytes({
        pages,
        docTitle,
        log,
        bilingual: mode === "bilingual",
      }));
      const path = await stage("写入临时文件", () => writeTemp(bytes, safeName(docTitle, "pdf")));
      if (!parent) {
        log?.("⚠️ 这份 PDF 是独立附件（没有父条目），译文只能作为独立附件放进同一个文库");
      }
      const attachment = await stage("创建附件", () => Zotero.Attachments.importFromFile(
        makeImportOptions(path, "（PDF）", "application/pdf"),
      ));
      log?.(`已生成${modeInfo.label} PDF 附件：${(bytes.length / 1024).toFixed(0)} KB`
        + (parent ? `，挂在《${displayTitle(parent)}》下` : "（独立附件）"));
      return {
        item: attachment, format: "pdf", bytes: bytes.length, parentItem: parent, mode,
      };
    }

    const html = buildHtml({
      pages,
      docTitle,
      sourceItem: nameSource,
      bilingual: mode === "bilingual",
    });
    const path = await stage(
      "写入临时文件",
      () => writeTemp(B.encode ? B.encode(html) : html, safeName(docTitle, "html")),
    );
    if (!parent) {
      log?.("⚠️ 这份 PDF 是独立附件（没有父条目），译文只能作为独立附件放进同一个文库");
    }
    const attachment = await stage("创建附件", () => Zotero.Attachments.importFromFile(
      makeImportOptions(path, "（HTML）", "text/html", { charset: "utf-8" }),
    ));
    log?.(`已生成${modeInfo.label} HTML 附件：${(html.length / 1024).toFixed(0)} KB`
      + (parent ? `，挂在《${displayTitle(parent)}》下` : "（独立附件）"));
    return {
      item: attachment, format: "html", bytes: html.length, parentItem: parent, mode,
    };
  }

  /**
   * 按设置导出（可能是两个版本：中文版 + 中英对照版）。
   *
   * 一个版本失败不影响另一个：结果里分别记 ok / error，
   * 界面上能说清"哪个成功了、哪个为什么失败"。
   *
   * @param {object} item 条目或其 PDF 附件
   * @param {Array} pages 译文分页
   * @param {{format?: string, log?: Function, mode?: 'both'|'zh'|'bilingual'}} opts
   * @returns {Promise<{results: Array, errors: Array, parentItem: object|null}>}
   */
  async function exportVersions(item, pages, opts = {}) {
    const { format = "pdf", log } = opts;
    const wanted = opts.mode || utils.getPref("extExportMode", "both");
    const modes = wanted === "zh"
      ? ["zh"]
      : (wanted === "bilingual" ? ["bilingual"] : ["zh", "bilingual"]);
    log?.(`导出模式：${wanted}（本次生成 ${modes.length} 个版本）`);

    const results = [];
    const errors = [];
    let parentItem = null;
    for (const mode of modes) {
      try {
        const res = await exportTranslation(item, pages, { format, log, mode });
        results.push(res);
        parentItem = res.parentItem;
      }
      catch (e) {
        errors.push({ mode, message: e?.message || String(e) });
        log?.(`❌ ${MODES[mode]?.label || mode} 导出失败：${e?.message || e}`);
      }
    }
    return { results, errors, parentItem };
  }

  return {
    exportTranslation,
    exportVersions,
    MODES,
    resolveParentItem,
    displayTitle,
    makeTextFixer,
    buildPdfBytes,
    buildHtml,
    collectSections,
    loadFont,
    preflight,
    listAvailableFonts,
    probeFont,
    FONT_CANDIDATES,
  };
})();
