/**
 * Zotero 沙箱版 PDF 生成器（中文译文导出用）
 *
 * 与 tools/pdf-writer.js 逻辑一致，差异：
 *   - 用 Uint8Array（不用 Buffer）
 *   - 压缩用 CompressionStream('deflate')，而 PDF 的 FlateDecode 要的正是
 *     zlib 格式（带 2 字节头）—— 与 Node 的 zlib.deflateSync 行为一致。
 *     ⚠️ 不要用 'deflate-raw'，那会让所有阅读器报 "incorrect header check"。
 *
 * 已踩过的坑（都写在这里防止再犯）：
 *   1. codesFor 不能对入参做 String()：码点数组 [20154,24037] 会被转成
 *      "20154,24037"，再逐字符取码点就变成数字的字形，整篇中文变数字。
 *   2. 页眉会画出文档标题，标题字符必须收进字体子集，否则标题整体缺字形。
 *   3. 分页标记（"第 N 页"）不要当标题放大；真标题（Keywords 等）才放大。
 * ⚠️ 整体包在 IIFE 里：合并后所有文件共享同一作用域，顶层重复声明会构建失败。
 */
(function () {
  const NS = (() => {
    if (typeof __bilingualNS !== "undefined" && __bilingualNS) return __bilingualNS;
    let ns = {};
    try {
      (typeof globalThis !== "undefined" ? globalThis : this).__bilingualNS = ns;
    }
    catch (e) {}
    return ns;
  })();
  NS.tools = NS.tools || {};
  if (NS.tools.pdf) return; // 已加载过

  const B = NS.tools.bytes;

const A4 = { width: 595.28, height: 841.89 };

function pdfString(str) {
  return `(${String(str).replace(/[\\()]/g, (m) => "\\" + m)})`;
}

function hexString(bytes) {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s + ">";
}

function buildToUnicode(gidToCp) {
  const entries = [...gidToCp.entries()].sort((a, b) => a[0] - b[0]);
  const lines = [];
  lines.push("/CIDInit /ProcSet findresource begin");
  lines.push("12 dict begin");
  lines.push("begincmap");
  lines.push("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def");
  lines.push("/CMapName /Adobe-Identity-UCS def");
  lines.push("/CMapType 2 def");
  lines.push("1 begincodespacerange");
  lines.push("<0000> <FFFF>");
  lines.push("endcodespacerange");
  const CHUNK = 100;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = entries.slice(i, i + CHUNK);
    lines.push(`${part.length} beginbfchar`);
    for (const [gid, cp] of part) {
      const src = gid.toString(16).padStart(4, "0");
      let dst;
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        dst = hi.toString(16).padStart(4, "0") + lo.toString(16).padStart(4, "0");
      }
      else {
        dst = cp.toString(16).padStart(4, "0");
      }
      lines.push(`<${src}> <${dst.toUpperCase()}>`);
    }
    lines.push("endbfchar");
  }
  lines.push("endcmap");
  lines.push("CMapName currentdict /CMap defineresource pop");
  lines.push("end");
  lines.push("end");
  return B.fromLatin1(lines.join("\n"));
}

/**
 * 文本/码点数组 → Identity-H 的 2 字节字形码。
 * ⚠️ 绝不要对入参做 String()（见文件头注释第 1 条）
 */
function codesFor(input, subset) {
  const cps = Array.isArray(input)
    ? input
    : [...String(input)].map((c) => c.codePointAt(0));
  const out = [];
  for (const cp of cps) {
    const gid = subset.gidOf(cp);
    out.push((gid >> 8) & 0xff, gid & 0xff);
  }
  return out;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * @param {object} opts
 * @param {Array<{title:string, paragraphs:Array<string|{text:string, style?:string}>}>} opts.sections
 *   段落可以是字符串，也可以是 `{text, style}`。style:
 *     ""   正文（黑色）
 *     "en" 英文原文（灰色 + 缩进，双语版用来和译文区分）
 * @param {object} opts.subset NS.tools.ttf.subsetFont() 的返回值
 * @param {(u8:Uint8Array)=>Promise<Uint8Array>} opts.deflate 压缩函数（zlib 格式）
 * @param {string} [opts.title]
 * @returns {Promise<Uint8Array>}
 */
async function buildPDF(opts) {
  const {
    sections,
    subset,
    deflate,
    title = "中文译文",
    fontSize = 10.5,
    lineHeight = 16,
  } = opts;

  /** 统一成 {text, style}：老调用方传纯字符串也要能用 */
  const normPara = (p) => (p && typeof p === "object"
    ? { text: p.text ?? "", style: p.style || "" }
    : { text: p, style: "" });

  const page = A4;
  const marginX = 56;
  const marginTop = 64;
  const marginBottom = 64;
  const maxWidth = page.width - marginX * 2;
  /** 英文原文行的左侧缩进（和中文译文在视觉上分开） */
  const indentEn = 12;
  const unitsPerEm = subset.unitsPerEm || 1000;

  /* --- 收集所有会画出来的字符 --- */
  const usedCps = new Set();
  const missingCps = new Set();
  const addText = (t) => {
    for (const ch of String(t)) {
      const cp = ch.codePointAt(0);
      if (cp === 10 || cp === 13) continue;
      usedCps.add(cp);
    }
  };
  addText(title);
  addText("第 页 / 共");
  addText("0123456789");
  for (const sec of sections) {
    addText(sec.title || "");
    for (const p of sec.paragraphs) addText(normPara(p).text);
  }

  const gidToCp = new Map();
  for (const cp of usedCps) {
    const gid = subset.gidOf(cp);
    if (gid > 0) {
      if (!gidToCp.has(gid)) gidToCp.set(gid, cp);
    }
    else if (cp !== 0x20 && cp !== 0x09 && cp !== 0xa0) {
      missingCps.add(cp);
    }
  }
  const missingList = [...missingCps].map((c) => String.fromCodePoint(c)).join("");

  /* --- 排版 --- */
  const isHeadingLine = (t) => /^(keywords?|abstract|摘要|关键词|参考文献|references)\b/i.test(t.trim());
  const bodyLines = [];
  for (const sec of sections) {
    if (sec.title) bodyLines.push({ type: "pagemark", text: sec.title, style: "" });
    for (const p of sec.paragraphs) {
      const { text, style } = normPara(p);
      for (const l of String(text).split("\n")) {
        bodyLines.push({ type: isHeadingLine(l) ? "h" : "p", text: l, style });
      }
      bodyLines.push({ type: "p", text: "", style });
    }
  }

  /**
   * 避头尾（中文排版基本规则）：
   *   NO_LINE_START 里的字符不能出现在行首（句号、逗号、右括号…）
   *   NO_LINE_END  里的字符不能出现在行尾（左括号、左引号…）
   */
  const NO_LINE_START = new Set(
    "，。、；：？！）〕］｝〉》」』】”’·…％‰℃,.;:?!)]}\"'".split(""),
  );
  const NO_LINE_END = new Set("（〔［｛〈《「『【“‘([{".split(""));

  /**
   * 按宽度折行，返回若干个「码点数组」。
   *
   * ⚠️ 拉丁文本必须在**空格处**断行。以前是按字符宽度硬切，
   * 导出的中英对照 PDF 里会出现 "sai / d"、"exp / lainability" 这种
   * 把单词劈成两半的样子。
   * ⚠️ 中文还要避头尾：不能让「，」出现在行首（以前确实会出现）。
   */
  function wrapLine(text, size, maxW) {
    const cwOf = (cp) => (cp < 0x2e80 ? size * 0.52 : size);
    const lines = [];
    let cur = [];
    let w = 0;
    let lastSpace = -1;

    const flush = () => {
      if (!cur.length) return;
      lines.push(cur);
      cur = [];
      w = 0;
      lastSpace = -1;
    };

    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      const cw = cwOf(cp);
      if (w + cw > maxW && cur.length) {
        if (cp < 0x2e80 && lastSpace > 0) {
          // 拉丁字符放不下时，退到最近的空格断行（不切断单词）
          const tail = cur.slice(lastSpace + 1);
          lines.push(cur.slice(0, lastSpace));
          cur = tail;
          w = tail.reduce((n, c) => n + cwOf(c), 0);
          lastSpace = -1;
          for (let k = 0; k < cur.length; k++) if (cur[k] === 0x20) lastSpace = k;
          if (w + cw > maxW) flush(); // 单个超长单词：只能按字符断
        }
        else {
          // 中文：推一压一，保证不违反避头尾
          const head = cur.slice();
          const tail = [];
          if (NO_LINE_START.has(ch) && head.length > 1) tail.unshift(head.pop());
          while (head.length > 1
            && NO_LINE_END.has(String.fromCodePoint(head[head.length - 1]))) {
            tail.unshift(head.pop());
          }
          lines.push(head);
          cur = tail;
          w = tail.reduce((n, c) => n + cwOf(c), 0);
          lastSpace = -1;
        }
      }
      if (cp === 0x20) lastSpace = cur.length;
      cur.push(cp);
      w += cw;
    }
    flush();
    // 空行也要占一行高度
    if (!lines.length) lines.push([]);
    return lines;
  }

  const flat = [];
  for (const item of bodyLines) {
    if (item.type === "pagemark") {
      // ⚠️ item.text 可能已经是码点数组，不能套 String()（见文件头注释第 1 条）
      const cps = Array.isArray(item.text)
        ? item.text
        : [...String(item.text)].map((c) => c.codePointAt(0));
      flat.push({ size: fontSize + 1, cps, style: "" });
      continue;
    }
    const isEn = item.style === "en";
    const size = item.type === "h"
      ? fontSize + 2
      : (isEn ? fontSize - 0.5 : fontSize);
    // 英文行有缩进，可用宽度要相应减少，否则会顶出右边距
    const width = isEn ? maxWidth - indentEn : maxWidth;
    for (const cps of wrapLine(item.text, size, width)) {
      flat.push({ size, cps, style: item.style });
    }
  }

  const perPage = Math.max(
    1,
    Math.floor((page.height - marginTop - marginBottom - 24) / lineHeight),
  );
  const totalPages = Math.max(1, Math.ceil(flat.length / perPage));

  /* --- 每页内容流 --- */
  const contentStreams = [];
  for (let p = 0; p < totalPages; p++) {
    const slice = flat.slice(p * perPage, (p + 1) * perPage);
    const parts = [];
    parts.push("q 0.92 g");
    parts.push(
      `BT /F1 9 Tf 1 0 0 1 ${marginX} ${(page.height - marginTop + 26).toFixed(2)} Tm `
      + `${hexString(codesFor(title, subset))} Tj ET`,
    );
    const pageLabel = `第 ${p + 1} 页 / 共 ${totalPages} 页`;
    parts.push(
      `BT /F1 9 Tf 1 0 0 1 ${(page.width - marginX - 90).toFixed(2)} `
      + `${(page.height - marginTop + 26).toFixed(2)} Tm `
      + `${hexString(codesFor(pageLabel, subset))} Tj ET`,
    );
    parts.push("Q");
    parts.push("q 0.85 G 0.5 w");
    parts.push(
      `${marginX} ${(page.height - marginTop + 18).toFixed(2)} m `
      + `${(page.width - marginX).toFixed(2)} ${(page.height - marginTop + 18).toFixed(2)} l S`,
    );
    parts.push("Q");

    let y = page.height - marginTop;
    for (const line of slice) {
      if (line.cps.length) {
        const isEn = line.style === "en";
        // 英文原文用灰色 + 缩进，扫一眼就能分清哪段是原文哪段是译文
        parts.push(isEn ? "BT 0.45 g" : "BT 0 g");
        const x = isEn ? marginX + indentEn : marginX;
        parts.push(`/F1 ${line.size} Tf 1 0 0 1 ${x} ${y.toFixed(2)} Tm`);
        parts.push(`${hexString(codesFor(line.cps, subset))} Tj`);
        parts.push("ET");
      }
      y -= lineHeight;
    }
    contentStreams.push(B.fromLatin1(parts.join("\n")));
  }

  /* --- 压缩（deflate 可能返回 null：压缩无收益时改为不压缩存储） --- */
  const fontBytes = subset.fontBuffer;
  const compressedFont = await deflate(fontBytes);
  const compressedContents = [];
  for (const c of contentStreams) compressedContents.push(await deflate(c));
  const toUnicodeRaw = buildToUnicode(gidToCp);
  const compressedToUnicode = await deflate(toUnicodeRaw);

  /**
   * 统一的流字典：压缩成功就带 /Filter /FlateDecode，否则原样存。
   * PDF 允许无 Filter 的流，所以这条降级路径是合法的。
   */
  const mkStream = (raw, compressed, extra = "") => (compressed
    ? {
      dict: `<< /Length ${compressed.length}${extra} /Filter /FlateDecode >>`,
      stream: compressed,
    }
    : {
      dict: `<< /Length ${raw.length}${extra} >>`,
      stream: raw,
    });

  /* --- 对象 --- */
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const widths = [];
  {
    const gids = [...gidToCp.keys()].sort((a, b) => a - b);
    let runStart = null;
    let run = [];
    const flushRun = () => {
      if (runStart == null) return;
      widths.push(`${runStart} [${run.join(" ")}]`);
      runStart = null;
      run = [];
    };
    for (const gid of gids) {
      const adv = subset.advanceOf ? subset.advanceOf(gid) : unitsPerEm;
      const scaled = Math.round((adv / unitsPerEm) * 1000);
      if (runStart == null || gid !== runStart + run.length) {
        flushRun();
        runStart = gid;
      }
      run.push(scaled);
    }
    flushRun();
  }

  const catalogNum = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesNum = add(`<< /Type /Pages /Kids [] /Count ${totalPages} >>`);
  const fontFileNum = add(mkStream(
    fontBytes,
    compressedFont,
    ` /Length1 ${fontBytes.length}`,
  ));
  const fontDescNum = add(
    `<< /Type /FontDescriptor /FontName /BilingualSubset /Flags 4 `
    + `/FontBBox [-200 -300 ${Math.round(unitsPerEm * 1.1)} ${Math.round(unitsPerEm * 1.15)}] `
    + `/ItalicAngle 0 /Ascent ${Math.round(unitsPerEm * 0.88)} `
    + `/Descent ${-Math.round(unitsPerEm * 0.12)} `
    + `/CapHeight ${Math.round(unitsPerEm * 0.7)} /StemV 80 /FontFile2 ${fontFileNum} 0 R >>`,
  );
  const cidFontNum = add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BilingualSubset `
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> `
    + `/FontDescriptor ${fontDescNum} 0 R /DW 1000 `
    + `/W [${widths.join(" ")}] /CIDToGIDMap /Identity >>`,
  );
  const toUniNum = add(mkStream(toUnicodeRaw, compressedToUnicode));
  const type0Num = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /BilingualSubset `
    + `/Encoding /Identity-H /DescendantFonts [${cidFontNum} 0 R] `
    + `/ToUnicode ${toUniNum} 0 R >>`,
  );
  const contentNums = [];
  for (let i = 0; i < contentStreams.length; i++) {
    contentNums.push(add(mkStream(contentStreams[i], compressedContents[i])));
  }
  const pageNums = [];
  for (let i = 0; i < totalPages; i++) {
    pageNums.push(add(
      `<< /Type /Page /Parent ${pagesNum} 0 R `
      + `/MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] `
      + `/Resources << /Font << /F1 ${type0Num} 0 R >> >> `
      + `/Contents ${contentNums[i]} 0 R >>`,
    ));
  }
  objects[pagesNum - 1] =
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${totalPages} >>`;
  const infoNum = add(
    `<< /Title ${pdfString(title)} /Producer ${pdfString("Bilingual Paper Reader")} `
    + `/CreationDate ${pdfString(pdfDate(new Date()))} >>`,
  );

  /* --- 序列化 --- */
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (buf) => {
    const b = typeof buf === "string" ? B.fromLatin1(buf) : buf;
    chunks.push(b);
    pos += b.length;
  };

  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  objects.forEach((obj, i) => {
    offsets[i] = pos;
    const num = i + 1;
    if (typeof obj === "string") {
      push(`${num} 0 obj\n${obj}\nendobj\n`);
    }
    else {
      push(`${num} 0 obj\n${obj.dict}\nstream\n`);
      push(obj.stream);
      push("\nendstream\nendobj\n");
    }
  });
  const xrefPos = pos;
  push(`xref\n0 ${objects.length + 1}\n`);
  push("0000000000 65535 f \n");
  for (let i = 0; i < objects.length; i++) {
    push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R >>\n`
    + `startxref\n${xrefPos}\n%%EOF\n`,
  );

  const result = B.concat(chunks);
  result.missingChars = missingList;
  return result;
}

/**
 * 用压缩把数据流包成 zlib 格式（PDF FlateDecode 要的就是这个）。
 *
 * ⚠️ **不能依赖 CompressionStream** —— Zotero 插件沙箱里没有它
 * （plugins.js 的 wantGlobalProperties 白名单里只有 TextEncoder/TextDecoder）。
 * 之前整个 PDF 导出就卡在这一步，报"导出环境缺少 CompressionStream"。
 *
 * 有 CompressionStream 时优先用（更快），否则退回自研的纯 JS DEFLATE（03-deflate.js）。
 * 两者都没有时返回 null，调用方会改用"不压缩"存储（PDF 允许无 Filter 的流）。
 */
async function deflateZlib(u8) {
  if (typeof CompressionStream === "function") {
    try {
      const cs = new CompressionStream("deflate");
      const writer = cs.writable.getWriter();
      writer.write(u8);
      writer.close();
      const buf = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(buf);
    }
    catch (e) {
      // 落到纯 JS 实现
    }
  }
  const fn = NS.tools.deflate?.deflateZlib;
  if (typeof fn === "function") {
    const out = fn(u8);
    if (out) return out;
  }
  return null;
}

NS.tools.pdf = { buildPDF, deflateZlib, codesFor, buildToUnicode };
})();
