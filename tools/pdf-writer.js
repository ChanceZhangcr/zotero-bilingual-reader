/**
 * 极简 PDF 生成器（专为"中文译文导出"设计）
 *
 * 支持：CIDFontType2 + Identity-H 编码 + 嵌入子集字体 + ToUnicode CMap。
 *  - 用 Identity-H，字符码 == 字形 id，无需编码表
 *  - 带 ToUnicode，PDF 里的中文可被复制/搜索（不是图片）
 *  - 数据流用 zlib deflate（Node 用 node:zlib；Zotero 里用 CompressionStream）
 *
 * 不支持的：图片、表格、复杂排版 —— 只做"分页纯文本流"。
 */

const A4 = { width: 595.28, height: 841.89 };

/* --------------------------- 字符串/编码工具 --------------------------- */

function latin1(str) {
  const out = Buffer.alloc(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** PDF 字面字符串转义 */
function pdfString(str) {
  return `(${String(str).replace(/[\\()]/g, (m) => "\\" + m)})`;
}

/** 把 UTF-16BE 十六进制串写进 PDF（Identity-H 用） */
function hexString(bytes) {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s + ">";
}

/* ------------------------------ ToUnicode ------------------------------ */

/**
 * 生成 ToUnicode CMap：gid -> Unicode，保证复制/搜索能用。
 * @param {Map<number, number>} gidToCp
 */
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
      // 目标用 UTF-16BE
      let dst = "";
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
  return latin1(lines.join("\n"));
}

/* ------------------------------- 排版 ------------------------------- */

/**
 * 简易排版：按可用宽度折行（中文按 1 个字宽、西文按 0.5 个字宽估算）。
 * @returns {Array<Array<{cp:number,gid:number}>>} 每页若干行
 */
function layout(text, { fontSize, lineHeight, maxWidth, pageHeight, marginTop, marginBottom }) {
  const usable = maxWidth;
  const lines = [];
  for (const rawLine of String(text).split("\n")) {
    const chars = [...rawLine];
    if (!chars.length) {
      lines.push([]);
      continue;
    }
    let cur = [];
    let width = 0;
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      const w = cp < 0x2e80 ? fontSize * 0.52 : fontSize;
      if (width + w > usable && cur.length) {
        lines.push(cur);
        cur = [];
        width = 0;
      }
      cur.push(cp);
      width += w;
    }
    if (cur.length) lines.push(cur);
  }

  const perPage = Math.max(1, Math.floor((pageHeight - marginTop - marginBottom) / lineHeight));
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) {
    pages.push(lines.slice(i, i + perPage));
  }
  return pages.length ? pages : [[]];
}

/* ------------------------------ PDF 组装 ------------------------------ */

/**
 * @param {object} opts
 * @param {Array<{title:string, paragraphs:string[]}>} opts.sections 正文内容
 * @param {object} opts.subset subsetFont() 的返回值（含 gidOf / fontBuffer / advanceOf）
 * @param {(buf:Uint8Array)=>Promise<Uint8Array>} opts.deflate 压缩函数
 * @param {string} [opts.title] 文档标题（元数据）
 * @param {number} [opts.fontSize]
 * @param {number} [opts.lineHeight]
 */
export async function buildPDF(opts) {
  const {
    sections,
    subset,
    deflate,
    title = "中文译文",
    fontSize = 10.5,
    lineHeight = 16,
  } = opts;

  // 校验传入的 subset 是否具备预期的映射能力（不同模块实例会静默拿到错的 gidOf）
  if (typeof globalThis.__PDF_DEBUG__ !== "undefined") {
    console.warn(
      "    [buildPDF] subset.gidOf(人)=", subset.gidOf(20154),
      " subset.gidOf(第)=", subset.gidOf(31532),
      " bufferLen=", subset.fontBuffer?.length,
    );
  }

  const page = A4;
  const marginX = 56;
  const marginTop = 64;
  const marginBottom = 64;
  const maxWidth = page.width - marginX * 2;

  const unitsPerEm = subset.unitsPerEm || 1000;

  /* --- 收集字形：必须把所有会画出来的文字都收进来 --- */
  const gidToCp = new Map();
  const usedCps = new Set();
  const missingCps = new Set();
  const addText = (t) => {
    for (const ch of String(t)) {
      const cp = ch.codePointAt(0);
      if (cp === 10 || cp === 13) continue;
      usedCps.add(cp);
    }
  };

  addText(title); // ⚠️ 标题也会画在页眉上，必须收进来（漏了会导致标题缺字）
  addText("第 页 / 共");
  addText("0123456789");
  for (const sec of sections) {
    addText(sec.title || "");
    for (const p of sec.paragraphs) addText(p);
  }

  // 建立 gid→码点映射，同时记录字体里缺失的字符
  for (const cp of usedCps) {
    const gid = subset.gidOf(cp);
    if (gid > 0) {
      if (!gidToCp.has(gid)) gidToCp.set(gid, cp);
    }
    else if (cp !== 0x20 && cp !== 0x09 && cp !== 0xa0) {
      // 空格类字符映射到 .notdef 是正常的（用 advance 占位），其它就是真缺字
      missingCps.add(cp);
    }
  }
  if (missingCps.size) {
    console.warn(
      `  ⚠️ 字体缺少 ${missingCps.size} 个字符，将显示为空白：`,
      [...missingCps].map((c) => String.fromCodePoint(c)).join(""),
    );
  }

  /* --- 排版 --- */
  // sections[].title 是"页标记"（第 N 页），不放大；段落里以"关键词/Keywords/摘要"
  // 之类开头的短行才当小标题处理。
  const isHeadingLine = (t) => /^(keywords?|abstract|摘要|关键词|参考文献|references)\b/i.test(t.trim());
  const bodyLines = [];
  for (const sec of sections) {
    if (sec.title) bodyLines.push({ type: "pagemark", text: sec.title });
    for (const p of sec.paragraphs) {
      for (const l of String(p).split("\n")) {
        bodyLines.push({ type: isHeadingLine(l) ? "h" : "p", text: l });
      }
      bodyLines.push({ type: "p", text: "" });
    }
  }

  // 展开成"行数组（含字符码）"
  const flat = [];
  for (const item of bodyLines) {
    if (item.type === "pagemark") {
      // ⚠️ 这里的 item.text 可能已经是码点数组，**不能**再套 String() ——
      // 数组会被转成 "31532,32,49"，然后再逐字符取码点，
      // 结果每个汉字都变成数字字符（gid 7 = '3'），整篇中文全废。这个 bug 踩过。
      const cps = Array.isArray(item.text)
        ? item.text
        : [...String(item.text)].map((c) => c.codePointAt(0));
      flat.push({ size: fontSize + 1, cps, gap: 6 });
      continue;
    }
    const size = item.type === "h" ? fontSize + 2 : fontSize;
    const wrapWidth = maxWidth;
    const chars = [...String(item.text)];
    let cur = [];
    let w = 0;
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      const cw = cp < 0x2e80 ? size * 0.52 : size;
      if (w + cw > wrapWidth && cur.length) {
        flat.push({ size, cps: cur });
        cur = [];
        w = 0;
      }
      cur.push(cp);
      w += cw;
    }
    flat.push({ size, cps: cur });
  }

  const perPage = Math.max(
    1,
    Math.floor((page.height - marginTop - marginBottom - 24) / lineHeight),
  );
  const totalPages = Math.max(1, Math.ceil(flat.length / perPage));

  /* --- 生成每页内容流 --- */
  const contentStreams = [];
  for (let p = 0; p < totalPages; p++) {
    const slice = flat.slice(p * perPage, (p + 1) * perPage);
    const parts = [];
    // 页眉
    parts.push("q 0.92 g");
    parts.push(
      `BT /F1 9 Tf 1 0 0 1 ${marginX} ${(page.height - marginTop + 26).toFixed(2)} Tm `
      + `${hexString(codesFor(title, subset))} Tj ET`,
    );
    const pageLabel = `第 ${p + 1} 页 / 共 ${totalPages} 页`;
    parts.push(
      `BT /F1 9 Tf 1 0 0 1 ${(page.width - marginX - 90).toFixed(2)} ${(page.height - marginTop + 26).toFixed(2)} Tm `
      + `${hexString(codesFor(pageLabel, subset))} Tj ET`,
    );
    parts.push("Q");
    parts.push("q 0.85 G 0.5 w");
    parts.push(
      `${marginX} ${(page.height - marginTop + 18).toFixed(2)} m `
      + `${(page.width - marginX).toFixed(2)} ${(page.height - marginTop + 18).toFixed(2)} l S`,
    );
    parts.push("Q");

    // 正文
    let y = page.height - marginTop;
    let lineNo = 0;
    for (const line of slice) {
      if (line.cps.length) {
        const codes = codesFor(line.cps, subset);
        if (globalThis.__PDF_DEBUG__ && lineNo < 3) {
          const chars = line.cps.map((c) => String.fromCodePoint(c)).join("");
          const direct = line.cps.slice(0, 4).map((c) => `${c}->${subset.gidOf(c)}`).join(" ");
          console.warn(
            `    [render p${p}#${lineNo}] chars=${JSON.stringify(chars.slice(0, 10))}`
            + ` | cps 类型=${Object.prototype.toString.call(line.cps)}`
            + ` | cps[0] 类型=${typeof line.cps[0]} 值=${line.cps[0]}`
            + ` | 直接查gidOf: ${direct}`
            + ` | codesFor 结果: [${codes.slice(0, 8).join(",")}]`
            + ` | codes.length=${codes.length}`,
          );
        }
        lineNo += 1;
        parts.push("BT 0 g");
        parts.push(`/F1 ${line.size} Tf 1 0 0 1 ${marginX} ${y.toFixed(2)} Tm`);
        parts.push(`${hexString(codes)} Tj`);
        parts.push("ET");
      }
      y -= lineHeight;
    }
    contentStreams.push(latin1(parts.join("\n")));
  }

  /* --- 压缩 --- */
  const fontBytes = new Uint8Array(subset.fontBuffer);
  const compressedFont = await deflate(fontBytes);
  const compressedContents = [];
  for (const c of contentStreams) compressedContents.push(await deflate(new Uint8Array(c)));
  const toUnicode = buildToUnicode(gidToCp);
  const compressedToUnicode = await deflate(new Uint8Array(toUnicode));

  /* --- 组装对象 --- */
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based 对象号
  };

  // 宽度数组：CIDFont 的 W
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

  const fontFileObjNum = objects.length + 3; // 预留：见下方顺序
  // 顺序：1 Catalog, 2 Pages, 3 FontFile2, 4 FontDescriptor, 5 CIDFont, 6 Type0Font,
  //       7 ToUnicode, 8.. 内容流, 最后 Page 对象
  const nContent = compressedContents.length;

  const catalogNum = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesNum = add(`<< /Type /Pages /Kids [] /Count ${totalPages} >>`);
  const fontFileNum = add({
    dict: `<< /Length ${compressedFont.length} /Length1 ${fontBytes.length} /Filter /FlateDecode >>`,
    stream: compressedFont,
  });
  const fontDescNum = add(
    `<< /Type /FontDescriptor /FontName /BilingualSubset /Flags 4 `
    + `/FontBBox [-200 -300 ${Math.round(unitsPerEm * 1.1)} ${Math.round(unitsPerEm * 1.15)}] `
    + `/ItalicAngle 0 /Ascent ${Math.round(unitsPerEm * 0.88)} /Descent ${-Math.round(unitsPerEm * 0.12)} `
    + `/CapHeight ${Math.round(unitsPerEm * 0.7)} /StemV 80 /FontFile2 ${fontFileNum} 0 R >>`,
  );
  const cidFontNum = add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BilingualSubset `
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> `
    + `/FontDescriptor ${fontDescNum} 0 R /DW 1000 `
    + `/W [${widths.join(" ")}] /CIDToGIDMap /Identity >>`,
  );
  const toUniNum = add({
    dict: `<< /Length ${compressedToUnicode.length} /Filter /FlateDecode >>`,
    stream: compressedToUnicode,
  });
  const type0Num = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /BilingualSubset `
    + `/Encoding /Identity-H /DescendantFonts [${cidFontNum} 0 R] /ToUnicode ${toUniNum} 0 R >>`,
  );

  const contentNums = [];
  for (const c of compressedContents) {
    contentNums.push(add({
      dict: `<< /Length ${c.length} /Filter /FlateDecode >>`,
      stream: c,
    }));
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

  // 回填 Pages 的 Kids 与 Info
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
    const b = typeof buf === "string" ? latin1(buf) : Buffer.from(buf);
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

  return Buffer.concat(chunks);
}

/**
 * 把文本/码点数组转成 Identity-H 的 2 字节字形码。
 *
 * ⚠️ 不要对入参做 String() —— 如果传进来的是码点数组 [20154,24037]，
 * String() 会把它变成 "20154,24037"，再逐字符取码点就得到
 * '2','0','1','5','4',',' … 的字形，整篇中文会变成一串数字字符。
 * 这个 bug 排查了很久，别再犯。
 */
function codesFor(input, subset) {
  const cps = Array.isArray(input)
    ? input
    : [...String(input)].map((c) => c.codePointAt(0));
  const out = [];
  const dbg = [];
  for (const cp of cps) {
    const gid = subset.gidOf(cp);
    if (dbg.length < 8) dbg.push(`${String.fromCodePoint(cp)}=${gid}`);
    out.push((gid >> 8) & 0xff, gid & 0xff);
  }
  if (typeof globalThis.__PDF_DEBUG__ !== "undefined") {
    console.warn(
      "    [codesFor]",
      "n=", cps.length,
      "| 码点=", cps.slice(0, 4).join(","),
      "| 映射=", dbg.join(" "),
      "| 字节=", out.slice(0, 8).join(","),
    );
  }
  return out;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
