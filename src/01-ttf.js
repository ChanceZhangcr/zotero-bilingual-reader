/**
 * Zotero 沙箱版的字体子集化器 + PDF 写出支持
 *
 * 与 tools/ttf-subset.js 的差别：
 *   - 不依赖 Buffer（沙箱里用 Uint8Array + DataView）
 *   - 不依赖 node:zlib（用 CompressionStream 做 FlateEncode）
 *   - 通过全局的 Bilingual 命名空间暴露（loadSubScript 顺序加载）
 *
 * 逻辑与 tools/ 里的版本一致，那边用 fontTools/FreeType/PyMuPDF 验证过。
 *
 * ⚠️ 整体包在 IIFE 里：合并后所有文件共享同一作用域，
 *    顶层再声明一次 `Bilingual` 会直接构建失败（build.mjs 会拦）。
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
  if (NS.tools.ttf) return; // 已加载过

  /* 字节工具：与 00-core.js 里的那份等价（那边也可能先建好，这里复用） */
  const B = NS.tools.bytes || {
    view(u8) {
      return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    },
    alloc(n) {
      return new Uint8Array(n);
    },
    concat(chunks) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    },
    fromLatin1(str) {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    },
    toLatin1(u8) {
      let s = "";
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return s;
    },
    encode(str) {
      if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(str);
      }
      const utf8 = unescape(encodeURIComponent(str));
      const out = new Uint8Array(utf8.length);
      for (let i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
      return out;
    },
  };
  NS.tools.bytes = B;

/* ------------------------------ TTF 解析 ------------------------------ */

function tagName(num) {
  return String.fromCharCode(
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  );
}

/**
 * 解析 sfnt 字体。支持两种容器：
 *   - 单体 TTF / OTF（表目录在文件开头）
 *   - TTC（'ttcf' 字体集合，如 macOS 的 PingFang.ttc、Windows 的 msyh.ttc / simsun.ttc）
 *
 * TTC 的解法很简单：它只是在文件开头多了一层"目录的目录"，
 * 真正的表数据偏移本来就是**文件绝对偏移**，所以只要把表目录的起始位置
 * 从 0 换成第 N 个字体的偏移即可（这个坑以前误判成"TTC 需要额外解析"）。
 *
 * @param {Uint8Array} buf
 * @param {number} [fontIndex] TTC 里取第几个字体（默认 0）
 */
function parseTTF(buf, fontIndex = 0) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = NS.tools.bytes.view(u8);

  let dirOffset = 0;
  const sfntVersion = dv.getUint32(0);
  if (sfntVersion === 0x74746366) {
    // 'ttcf' —— 字体集合
    const numFonts = dv.getUint32(8);
    if (!numFonts) throw new Error("TTC 字体集合里没有字体");
    const idx = Math.min(Math.max(0, fontIndex | 0), numFonts - 1);
    dirOffset = dv.getUint32(12 + idx * 4);
    const inner = dv.getUint32(dirOffset);
    if (inner !== 0x00010000 && inner !== 0x74727565) {
      throw new Error(`TTC 第 ${idx} 个字体不是 TrueType（sfntVersion=0x${inner.toString(16)}）`);
    }
  }
  else if (sfntVersion !== 0x00010000 && sfntVersion !== 0x74727565) {
    throw new Error(`不是 TrueType 字体（sfntVersion=0x${sfntVersion.toString(16)}）`);
  }

  const numTables = dv.getUint16(dirOffset + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = dirOffset + 12 + i * 16;
    const tag = dv.getUint32(rec);
    const offset = dv.getUint32(rec + 8);
    const length = dv.getUint32(rec + 12);
    tables[tagName(tag)] = { offset, length };
  }

  function need(name) {
    const t = tables[name];
    if (!t) throw new Error(`字体缺少必需的 ${name} 表`);
    return u8.subarray(t.offset, t.offset + t.length);
  }

  const head = need("head").slice();
  const headDv = NS.tools.bytes.view(head);
  const unitsPerEm = headDv.getUint16(18);
  const indexToLocFormat = headDv.getInt16(50);

  const maxp = need("maxp").slice();
  const numGlyphs = NS.tools.bytes.view(maxp).getUint16(4);

  const hhea = need("hhea").slice();
  const numberOfHMetrics = NS.tools.bytes.view(hhea).getUint16(34);

  const locaBytes = need("loca");
  const locaDv = NS.tools.bytes.view(locaBytes);
  const loca = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = indexToLocFormat === 0 ? locaDv.getUint16(i * 2) * 2 : locaDv.getUint32(i * 4);
  }

  const glyfBytes = need("glyf");

  const hmtxBytes = need("hmtx");
  const hmtxDv = NS.tools.bytes.view(hmtxBytes);
  const advance = new Array(numGlyphs);
  const lsb = new Array(numGlyphs);
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) {
      advance[i] = hmtxDv.getUint16(i * 4);
      lsb[i] = hmtxDv.getInt16(i * 4 + 2);
    }
    else {
      advance[i] = advance[numberOfHMetrics - 1];
      lsb[i] = hmtxDv.getInt16(numberOfHMetrics * 4 + (i - numberOfHMetrics) * 2);
    }
  }

  const cmapBytes = need("cmap");
  const cmapDv = NS.tools.bytes.view(cmapBytes);
  const numSub = cmapDv.getUint16(2);
  let fmt12 = null;
  let fmt4 = null;
  for (let i = 0; i < numSub; i++) {
    const rec = 4 + i * 8;
    const platformID = cmapDv.getUint16(rec);
    const encodingID = cmapDv.getUint16(rec + 2);
    const subOff = cmapDv.getUint32(rec + 4);
    const format = cmapDv.getUint16(subOff);
    if (format === 12 && (platformID === 3 || platformID === 0)) fmt12 = subOff;
    if (format === 4 && platformID === 3 && encodingID === 1) fmt4 = subOff;
    if (!fmt4 && format === 4) fmt4 = subOff;
  }

  const charToGlyph = new Map();
  if (fmt12 != null) {
    const nGroups = cmapDv.getUint32(fmt12 + 12);
    for (let g = 0; g < nGroups; g++) {
      const p = fmt12 + 16 + g * 12;
      const startChar = cmapDv.getUint32(p);
      const endChar = cmapDv.getUint32(p + 4);
      const startGlyph = cmapDv.getUint32(p + 8);
      for (let c = startChar; c <= endChar; c++) {
        charToGlyph.set(c, startGlyph + (c - startChar));
      }
    }
  }
  if (!charToGlyph.size && fmt4 != null) {
    const segCount = cmapDv.getUint16(fmt4 + 6) / 2;
    const endBase = fmt4 + 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = cmapDv.getUint16(endBase + s * 2);
      const start = cmapDv.getUint16(startBase + s * 2);
      const delta = cmapDv.getInt16(deltaBase + s * 2);
      const ro = cmapDv.getUint16(rangeBase + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let gid;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const idx = rangeBase + s * 2 + ro + (c - start) * 2;
          if (idx + 2 > cmapBytes.length) continue;
          gid = cmapDv.getUint16(idx);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid) charToGlyph.set(c, gid);
      }
    }
  }

  function glyphData(gid) {
    if (gid < 0 || gid >= numGlyphs) return null;
    const start = loca[gid];
    const end = loca[gid + 1];
    if (end <= start) return null;
    return glyfBytes.subarray(start, end);
  }

  return {
    unitsPerEm,
    numGlyphs,
    advance,
    lsb,
    charToGlyph,
    glyphData,
    tables,
    head,
    hhea,
    maxp,
    name: tables.name ? need("name") : null,
    os2: tables["OS/2"] ? need("OS/2").slice() : null,
  };
}

/* ------------------------------ 子集化 ------------------------------ */

function checksum(u8) {
  const dv = NS.tools.bytes.view(u8);
  let sum = 0;
  const n = Math.floor(u8.length / 4);
  for (let i = 0; i < n; i++) sum = (sum + dv.getUint32(i * 4)) >>> 0;
  const rem = u8.length % 4;
  if (rem) {
    let v = 0;
    for (let i = 0; i < rem; i++) v = (v << 8) | u8[n * 4 + i];
    v = (v << (8 * (4 - rem))) >>> 0;
    sum = (sum + v) >>> 0;
  }
  return sum >>> 0;
}

function writeTag(str) {
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = str.charCodeAt(i) & 0xff;
  return b;
}

function subsetFont(font, codePoints) {
  // 统一归一化成数字码点（曾经的 bug：传字符数组时 charToGlyph.get("第") 查不到，
  // 所有字形被静默丢弃，只剩 .notdef）
  let wanted;
  if (typeof codePoints === "string") {
    wanted = [...codePoints].map((c) => c.codePointAt(0));
  }
  else if (Array.isArray(codePoints)) {
    wanted = codePoints.map((c) => (typeof c === "string" ? c.codePointAt(0) : Number(c)));
  }
  else {
    throw new Error("subsetFont: codePoints 必须是数组或字符串");
  }
  wanted = [...new Set(wanted)].filter((c) => Number.isInteger(c) && c >= 0 && c <= 0x10ffff);
  if (!wanted.length) throw new Error("subsetFont: 没有任何有效码点");

  const newOrder = [0];
  const cpToGid = new Map();
  const usedOldGids = new Set([0]);
  const sorted = wanted.slice().sort((a, b) => a - b);
  for (const cp of sorted) {
    const old = font.charToGlyph.get(cp);
    if (!old) continue;
    if (!usedOldGids.has(old)) {
      usedOldGids.add(old);
      newOrder.push(old);
    }
    cpToGid.set(cp, newOrder.indexOf(old));
  }
  if (newOrder.length <= 1) {
    throw new Error(`subsetFont: 字体里找不到任何指定字符的字形（共 ${wanted.length} 个码点）`);
  }

  /* glyf / loca */
  const glyphChunks = [];
  let cursor = 0;
  const locaOffsets = [0];
  for (const oldGid of newOrder) {
    const data = font.glyphData(oldGid);
    if (!data || !data.length) {
      locaOffsets.push(cursor);
      continue;
    }
    const pad = (4 - (data.length % 4)) % 4;
    const chunk = new Uint8Array(data.length + pad);
    chunk.set(data, 0);
    glyphChunks.push(chunk);
    cursor += chunk.length;
    locaOffsets.push(cursor);
  }
  const glyf = NS.tools.bytes.concat(glyphChunks);
  const newNumGlyphs = newOrder.length;
  const loca = new Uint8Array((newNumGlyphs + 1) * 4);
  {
    const dv = NS.tools.bytes.view(loca);
    for (let i = 0; i <= newNumGlyphs; i++) dv.setUint32(i * 4, locaOffsets[i] || 0);
  }

  /* hmtx */
  const hmtx = new Uint8Array(newNumGlyphs * 4);
  {
    const dv = NS.tools.bytes.view(hmtx);
    for (let i = 0; i < newNumGlyphs; i++) {
      const oldGid = newOrder[i];
      dv.setUint16(i * 4, font.advance[oldGid] || 0);
      dv.setInt16(i * 4 + 2, font.lsb[oldGid] || 0);
    }
  }

  const cmap = buildCmap([...cpToGid.entries()]);

  const head = font.head.slice();
  NS.tools.bytes.view(head).setUint32(8, 0);
  NS.tools.bytes.view(head).setInt16(50, 1); // indexToLocFormat = long

  const hhea = font.hhea.slice();
  NS.tools.bytes.view(hhea).setUint16(34, newNumGlyphs);

  const maxp = font.maxp.slice();
  NS.tools.bytes.view(maxp).setUint16(4, newNumGlyphs);

  const name = font.name ? font.name.slice() : minimalName();
  const os2 = font.os2 ? font.os2.slice() : minimalOS2(font.unitsPerEm);

  const post = new Uint8Array(32);
  {
    const dv = NS.tools.bytes.view(post);
    dv.setUint32(0, 0x00030000);
    dv.setUint32(12, 1000);
    dv.setInt16(16, -100);
    dv.setInt16(18, 50);
  }

  const fontBuffer = assembleTTF({
    "OS/2": os2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post,
  });

  return {
    fontBuffer,
    unitsPerEm: font.unitsPerEm,
    gidOf: (cp) => {
      const g = cpToGid.get(cp);
      return typeof g === "number" ? g : 0;
    },
    advanceOf: (gid) => font.advance[newOrder[gid]] || 0,
  };
}

function buildCmap(pairs) {
  const bmp = pairs.filter(([cp]) => cp <= 0xffff).sort((a, b) => a[0] - b[0]);
  const segments = [];
  for (const [cp, gid] of bmp) {
    const delta = (gid - cp) & 0xffff;
    const last = segments[segments.length - 1];
    if (last && cp === last.end + 1 && delta === last.delta) last.end = cp;
    else segments.push({ start: cp, end: cp, delta });
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segments.length;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * Math.pow(2, entrySelector);
  const rangeShift = segCount * 2 - searchRange;

  const sub4Len = 16 + segCount * 8;
  const sub4 = new Uint8Array(sub4Len);
  const d4 = NS.tools.bytes.view(sub4);
  d4.setUint16(0, 4);
  d4.setUint16(2, sub4Len);
  d4.setUint16(6, segCount * 2);
  d4.setUint16(8, searchRange);
  d4.setUint16(10, entrySelector);
  d4.setUint16(12, rangeShift);
  let p = 14;
  for (const s of segments) {
    d4.setUint16(p, s.end);
    p += 2;
  }
  d4.setUint16(p, 0);
  p += 2;
  for (const s of segments) {
    d4.setUint16(p, s.start);
    p += 2;
  }
  for (const s of segments) {
    d4.setUint16(p, s.delta & 0xffff);
    p += 2;
  }
  for (let i = 0; i < segCount; i++) {
    d4.setUint16(p, 0);
    p += 2;
  }

  const beyond = pairs.filter(([cp]) => cp > 0xffff);
  let sub12 = new Uint8Array(0);
  let has12 = false;
  if (beyond.length) {
    has12 = true;
    const groups = [];
    for (const [cp, gid] of beyond.sort((a, b) => a[0] - b[0])) {
      const last = groups[groups.length - 1];
      if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
      else groups.push({ start: cp, end: cp, gid });
    }
    sub12 = new Uint8Array(16 + groups.length * 12);
    const d12 = NS.tools.bytes.view(sub12);
    d12.setUint16(0, 12);
    d12.setUint32(4, 16 + groups.length * 12);
    d12.setUint32(12, groups.length);
    let q = 16;
    for (const g of groups) {
      d12.setUint32(q, g.start);
      d12.setUint32(q + 4, g.end);
      d12.setUint32(q + 8, g.gid);
      q += 12;
    }
  }

  const subtables = [{ platformID: 3, encodingID: 1, data: sub4 }];
  if (has12) subtables.push({ platformID: 3, encodingID: 10, data: sub12 });
  subtables.push({ platformID: 0, encodingID: has12 ? 4 : 3, data: has12 ? sub12 : sub4 });

  const headerLen = 4 + subtables.length * 8;
  const total = headerLen + subtables.reduce((n, s) => n + s.data.length, 0);
  const buf = new Uint8Array(total);
  const dv = NS.tools.bytes.view(buf);
  dv.setUint16(2, subtables.length);
  let off = headerLen;
  subtables.forEach((s, i) => {
    const r = 4 + i * 8;
    dv.setUint16(r, s.platformID);
    dv.setUint16(r + 2, s.encodingID);
    dv.setUint32(r + 4, off);
    buf.set(s.data, off);
    off += s.data.length;
  });
  return buf;
}

function minimalName() {
  const records = [[1, "BilingualSubset"], [2, "Regular"], [4, "BilingualSubset"], [6, "BilingualSubset"]];
  const strings = [];
  const recs = [];
  let strOff = 0;
  for (const [id, str] of records) {
    const bytes = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      bytes[i * 2] = str.charCodeAt(i) & 0xff;
      bytes[i * 2 + 1] = (str.charCodeAt(i) >> 8) & 0xff;
    }
    recs.push({ id, len: bytes.length, off: strOff });
    strings.push(bytes);
    strOff += bytes.length;
  }
  const headerLen = 6 + recs.length * 12;
  const buf = new Uint8Array(headerLen + strOff);
  const dv = NS.tools.bytes.view(buf);
  dv.setUint16(2, recs.length);
  dv.setUint16(4, headerLen);
  recs.forEach((r, i) => {
    const p = 6 + i * 12;
    dv.setUint16(p, 3);
    dv.setUint16(p + 2, 1);
    dv.setUint16(p + 4, 0x0804);
    dv.setUint16(p + 6, r.id);
    dv.setUint16(p + 8, r.len);
    dv.setUint16(p + 10, r.off);
  });
  let off = headerLen;
  for (const s of strings) {
    buf.set(s, off);
    off += s.length;
  }
  return buf;
}

function minimalOS2(unitsPerEm) {
  const b = new Uint8Array(96);
  const dv = NS.tools.bytes.view(b);
  dv.setUint16(0, 4);
  dv.setInt16(2, Math.round(unitsPerEm * 0.65));
  dv.setUint16(4, 400);
  dv.setUint16(6, 5);
  dv.setInt16(68, Math.round(unitsPerEm * 0.8));
  dv.setInt16(70, -Math.round(unitsPerEm * 0.2));
  dv.setUint16(74, unitsPerEm);
  dv.setUint16(76, Math.round(unitsPerEm * 0.2));
  return b;
}

function assembleTTF(tablesIn) {
  const order = ["head", "hhea", "maxp", "OS/2", "hmtx", "cmap", "glyf", "loca", "name", "post"];
  const entries = order.filter((n) => tablesIn[n]).map((n) => ({ tag: n, data: tablesIn[n] }));
  const numTables = entries.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * Math.pow(2, entrySelector);
  const rangeShift = numTables * 16 - searchRange;

  const headerLen = 12 + numTables * 16;
  let cursor = headerLen;
  const placed = [];
  for (const e of entries) {
    const pad = (4 - (e.data.length % 4)) % 4;
    placed.push({ tag: e.tag, data: e.data, offset: cursor, length: e.data.length });
    cursor += e.data.length + pad;
  }

  const out = new Uint8Array(cursor);
  const dv = NS.tools.bytes.view(out);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, numTables);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, rangeShift);

  let headOffset = null;
  placed.forEach((pl, i) => {
    const rec = 12 + i * 16;
    out.set(writeTag(pl.tag), rec);
    dv.setUint32(rec + 4, checksum(pl.data));
    dv.setUint32(rec + 8, pl.offset);
    dv.setUint32(rec + 12, pl.length);
    out.set(pl.data, pl.offset);
    if (pl.tag === "head") headOffset = pl.offset;
  });

  if (headOffset != null) {
    dv.setUint32(headOffset + 8, 0);
    const total = checksum(out);
    dv.setUint32(headOffset + 8, (0xb1b0afba - total) >>> 0);
  }
  return out;
}

NS.tools.ttf = { parseTTF, subsetFont };
})();
