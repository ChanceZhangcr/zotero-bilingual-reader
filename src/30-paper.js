/* eslint-env mozilla */
/**
 * 论文全文抽取 + 一键整篇翻译流水线
 *
 * 文本来源优先级：
 *   1. Zotero.PDFWorker.getFullText(itemID, null) —— 直接对 PDF 抽取，返回 { text, extractedPages, totalPages }
 *      页面之间用 \f 分隔（见 pdfWorker/worker.js 里 text.push('\f')）。
 *   2. 已索引的全文缓存文件 .zotero-ft-cache —— 与上面同一套 \f 约定，作为兜底。
 */

Bilingual.paper = (() => {
  const { utils, cache, translate } = Bilingual;

  const PAGE_SEP = "\f";

  /** 从任意 item（文献条目 / PDF 附件）解析出可用的 PDF 附件 */
  function resolvePDFAttachment(item) {
    if (!item) return null;
    try {
      if (item.isAttachment?.() && item.isPDFAttachment?.()) return item;
      if (item.isRegularItem?.()) {
        const ids = item.getAttachments?.() || [];
        for (const id of ids) {
          const att = Zotero.Items.get(id);
          if (att && att.isPDFAttachment?.()) return att;
        }
        // 也接受 EPUB
        for (const id of ids) {
          const att = Zotero.Items.get(id);
          if (att && att.attachmentContentType === "application/epub+zip") return att;
        }
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
    return null;
  }

  /** 读取全文缓存文件（兜底） */
  async function readCacheFile(attachment) {
    try {
      const cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
      const path = cacheFile?.path;
      if (!path || !(await IOUtils.exists(path))) return null;
      const text = await IOUtils.readUTF8(path);
      if (!text || !text.trim()) return null;
      return { text, source: "cache-file" };
    }
    catch (e) {
      return null;
    }
  }

  /** 给任意 Promise 加超时，避免"卡住没反应也没提示" */
  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒没有响应`)),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * 抽取 PDF 全文，返回 { text, pageCount, source }
   */
  async function extractFullText(attachment, { onStage } = {}) {
    if (!attachment) throw new Error("没有找到可翻译的 PDF 附件");

    // 1) PDFWorker 直接抽取（加超时：worker 万一卡住不能把界面吊死）
    try {
      onStage?.("extract-worker");
      const res = await withTimeout(
        Zotero.PDFWorker.getFullText(attachment.id, null),
        60000,
        "PDF 文字抽取",
      );
      if (res?.text && res.text.trim()) {
        return {
          text: res.text,
          pageCount: res.totalPages || res.extractedPages || 0,
          source: "pdfworker",
          extractedPages: res.extractedPages,
        };
      }
    }
    catch (e) {
      utils.log(`PDFWorker 抽取失败或超时，改用全文缓存：${e}`);
    }

    // 2) 已索引缓存
    onStage?.("extract-cache");
    const cached = await readCacheFile(attachment);
    if (cached) {
      return { text: cached.text, pageCount: cached.text.split(PAGE_SEP).length, source: "cache-file" };
    }

    // 3) 触发一次索引再读缓存
    try {
      if (Zotero.Fulltext.canIndex(attachment)) {
        onStage?.("index");
        await withTimeout(
          Zotero.Fulltext.indexItems([attachment.id], { ignoreErrors: true }),
          120000,
          "建立全文索引",
        );
        const again = await readCacheFile(attachment);
        if (again) {
          return { text: again.text, pageCount: again.text.split(PAGE_SEP).length, source: "indexed" };
        }
      }
    }
    catch (e) {
      Zotero.logError(e);
    }

    throw new Error(
      "无法从这份 PDF 中提取文字。它可能是扫描件（需要先做 OCR），"
      + "或者文件还没下载到本地。",
    );
  }

  /**
   * 按页切分并结构化：
   * [{ page: 1, paragraphs: [{src, dst}] }]
   * 返回的 pages 里段落已经过滤过（页码等无意义片段被丢弃）。
   */
  function splitPages(text) {
    const rawPages = String(text || "").split(PAGE_SEP);
    const pages = [];
    for (let i = 0; i < rawPages.length; i++) {
      const paragraphs = utils
        .splitParagraphs(rawPages[i])
        .filter((p) => utils.isTranslatable(p));
      if (!paragraphs.length) continue;
      pages.push({ page: i + 1, paragraphs });
    }
    return pages;
  }

  /** 按页组装 { pages: [{page, paragraphs:[{src,dst}]}] } */
  function assemblePages(segs) {
    const outPages = [];
    const map = new Map();
    for (const s of segs) {
      if (!map.has(s.page)) {
        map.set(s.page, []);
        outPages.push({ page: s.page, paragraphs: map.get(s.page) });
      }
      map.get(s.page).push({ src: s.src, dst: s.dst || "" });
    }
    return outPages;
  }

  /**
   * 一键整篇翻译
   * @param {Object} item 文献条目或 PDF 附件
   * @param {{
   *   signal?: AbortSignal,
   *   onStage?: Function,
   *   onProgress?: Function,
   *   onStructure?: Function,   // 抽完文字立即回调，给界面铺骨架用
   *   onPartial?: Function,     // 每翻完一块回调，界面增量填充
   * }} opts
   */
  async function translatePaper(item, opts = {}) {
    const { signal, onProgress, onStage, onStructure, onPartial } = opts;
    const attachment = resolvePDFAttachment(item);
    if (!attachment) throw new Error("这个条目没有 PDF 附件");

    onStage?.("extract");
    const { text, pageCount, source } = await extractFullText(attachment);

    const pages = splitPages(text);
    if (!pages.length) {
      throw new Error("提取到的文字为空，无法翻译。");
    }

    const segs = [];
    for (const p of pages) {
      for (const para of p.paragraphs) segs.push({ page: p.page, src: para });
    }

    // 抽出结构后立刻通知界面铺骨架（此时还没有译文）
    try {
      onStructure?.({ pages: assemblePages(segs), total: segs.length, source });
    }
    catch (e) {
      utils.log(`onStructure 回调出错：${e}`);
    }
    // 查缓存
    const cachedList = await cache.getMany(segs.map((s) => s.src));
    let fromCache = 0;
    let emitted = 0;
    const pending = [];
    for (let i = 0; i < segs.length; i++) {
      if (typeof cachedList[i] === "string" && cachedList[i]) {
        segs[i].dst = cachedList[i];
        fromCache += 1;
      }
      else {
        pending.push(i);
      }
    }

    onStage?.("translate");
    onProgress?.({ done: fromCache, total: segs.length, cached: fromCache });

    // 缓存命中的段先推给界面，让用户立刻看到内容
    if (fromCache > 0) {
      try {
        const cachedIdx = [];
        for (let i = 0; i < segs.length; i++) {
          if (typeof segs[i].dst === "string" && segs[i].dst) cachedIdx.push(i);
        }
        if (cachedIdx.length) {
          onPartial?.({
            offset: cachedIdx[0],
            sources: cachedIdx.map((i) => segs[i].src),
            translations: cachedIdx.map((i) => segs[i].dst),
            indices: cachedIdx,
            segs,
            total: segs.length,
            done: cachedIdx.length,
          });
          emitted = cachedIdx.length;
        }
      }
      catch (e) {
        utils.log(`缓存预显示出错：${e}`);
      }
    }

    if (pending.length) {
      // 待翻译的段落 → 翻译单元。超长段会被引擎层按句切成多个单元，
      // 所以每个单元都带上"它属于哪一行"（paraIndex），译文再折叠回该行。
      const units = pending.map((i) => ({ text: segs[i].src, paraIndex: i }));
      const results = await translate.translateParagraphs(units, {
        signal,
        onProgress: (done, total) => {
          onProgress?.({
            done: fromCache + Math.round((done / Math.max(1, total)) * pending.length),
            total: segs.length,
            cached: fromCache,
          });
        },
        // 每翻完一块就把结果交给上层 —— 界面可以边翻边显示，
        // 不用等 100 多段全部翻完（实测整篇要 1 分钟左右）
        onChunkDone: (offset, sources, translations, paraIndices) => {
          try {
            onPartial?.({
              offset,
              sources,
              translations,
              paraIndices,
              segs,
              total: segs.length,
              done: fromCache + emitted,
            });
          }
          catch (e) {
            utils.log(`onPartial 回调出错：${e}`);
          }
          emitted += sources.length;
        },
      });
      const pairs = [];
      for (let k = 0; k < pending.length; k++) {
        const idx = pending[k];
        segs[idx].dst = results[k] || "";
        if (results[k]) pairs.push([segs[idx].src, results[k]]);
      }
      await cache.setPairs(pairs);
    }

    // 组装回分页结构
    const outPages = assemblePages(segs);

    await cache.flushNow();

    return {
      pages: outPages,
      pageCount: pageCount || outPages.length,
      source,
      translated: segs.length,
      fromCache,
      attachment,
    };
  }

  /** 只取某一页的段落（未翻译），供"只翻译当前页"使用 */
  async function getPageParagraphs(item, pageNumber) {
    const attachment = resolvePDFAttachment(item);
    if (!attachment) throw new Error("这个条目没有 PDF 附件");
    const { text } = await extractFullText(attachment);
    const rawPages = String(text).split(PAGE_SEP);
    const raw = rawPages[pageNumber - 1] || "";
    return utils.splitParagraphs(raw).filter((p) => utils.isTranslatable(p));
  }

  return {
    resolvePDFAttachment,
    extractFullText,
    splitPages,
    translatePaper,
    getPageParagraphs,
    PAGE_SEP,
  };
})();
