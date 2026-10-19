/**
 * 最小 TrueType 字体子集化器
 *
 * 目的：把系统里的中文字体（simfang.ttf 等 9–11 MB）裁成"只包含译文实际用到的字"，
 * 体积降到几十 KB，这样才能塞进 PDF。
 *
 * 只处理 TrueType（glyf/loca 轮廓）。CFF/OTF 不支持。
 * 输出是一个合法的 TTF：head/hhea/maxp/hmtx/cmap/glyf/loca/name/OS:2/post。
 */

/** 常用表标签 */
const TAGS = {
  head: 0x68656164,
  hhea: 0x68686561,
  maxp: 0x6d617870,
  hmtx: 0x686d7478,
  cmap: 0x636d6170,
  glyf: 0x676c7966,
  loca: 0x6c6f6361,
  name: 0x6e616d65,
  OS2: 0x4f532f32,
  post: 0x706f7374,
};

function tagName(num) {
  return String.fromCharCode(
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  );
}

/**
 * @param {Buffer|Uint8Array} buf TTF 原始字节
 */
export function parseTTF(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const sfntVersion = dv.getUint32(0);
  if (sfntVersion !== 0x00010000 && sfntVersion !== 0x74727565) {
    throw new Error(`不是 TrueType 字体（sfntVersion=0x${sfntVersion.toString(16)}）`);
  }
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
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

  // head
  const head = need("head").slice();
  const headDv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const unitsPerEm = headDv.getUint16(18);
  const indexToLocFormat = headDv.getInt16(50);

  // maxp
  const maxp = need("maxp").slice();
  const maxpDv = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength);
  const numGlyphs = maxpDv.getUint16(4);

  // hhea
  const hhea = need("hhea").slice();
  const hheaDv = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
  const numberOfHMetrics = hheaDv.getUint16(34);

  // loca
  const locaBytes = need("loca");
  const locaDv = new DataView(locaBytes.buffer, locaBytes.byteOffset, locaBytes.byteLength);
  const loca = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = indexToLocFormat === 0 ? locaDv.getUint16(i * 2) * 2 : locaDv.getUint32(i * 4);
  }

  const glyfBytes = need("glyf");

  // hmtx
  const hmtxBytes = need("hmtx");
  const hmtxDv = new DataView(hmtxBytes.buffer, hmtxBytes.byteOffset, hmtxBytes.byteLength);
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

  // cmap：优先取 format 12（UCS-4），否则 format 4（BMP）
  const cmapBytes = need("cmap");
  const cmapDv = new DataView(cmapBytes.buffer, cmapBytes.byteOffset, cmapBytes.byteLength);
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
    if (format === 4 && (platformID === 3 && encodingID === 1)) fmt4 = subOff;
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
    if (end <= start) return null; // 空字形
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
    raw: u8,
    head,
    hhea,
    maxp,
    name: tables.name ? need("name") : null,
    os2: tables["OS/2"] ? need("OS/2").slice() : null,
    post: tables.post ? need("post").slice() : null,
  };
}

/* ------------------------------ 子集化 ------------------------------ */

function checksum(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sum = 0;
  const n = Math.floor(buf.length / 4);
  for (let i = 0; i < n; i++) sum = (sum + dv.getUint32(i * 4)) >>> 0;
  const rem = buf.length % 4;
  if (rem) {
    let v = 0;
    for (let i = 0; i < rem; i++) v = (v << 8) | buf[n * 4 + i];
    v = (v << (8 * (4 - rem))) >>> 0;
    sum = (sum + v) >>> 0;
  }
  return sum >>> 0;
}

function writeTag(str) {
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) b[i] = str.charCodeAt(i) & 0xff;
  return b;
}

/**
 * 生成只含指定字符的子集字体。
 * @param {object} font parseTTF 的返回值
 * @param {number[]|string[]|string} codePoints
 *   需要包含的 Unicode 码位。**请传数字码点**。
 *   为了方便调用，这里也接受"字符数组"和"字符串"，内部统一转成码点
 *   （曾经的 bug：传字符数组时 charToGlyph.get("第") 查不到，所有字形被静默丢弃，
 *     只剩 .notdef —— 字体非空、不报错，结果整篇中文都不显示）。
 * @returns {{fontBuffer: Buffer, gidOf: (cp:number)=>number, unitsPerEm:number, advanceOf:(gid:number)=>number}}
 */
export function subsetFont(font, codePoints) {
  // 统一归一化成数字码点
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
  if (!wanted.length) {
    throw new Error("subsetFont: 没有任何有效码点");
  }

  // 新字形顺序：0 = .notdef，1..n = 用到的字形（按码位升序）
  const newOrder = [0];
  const cpToGid = new Map();
  const usedOldGids = new Set([0]);
  const sorted = wanted.slice().sort((a, b) => a - b);
  for (const cp of sorted) {
    const old = font.charToGlyph.get(cp);
    if (!old) continue; // 字体里没有这个字，跳过（上层会报缺字）
    if (!usedOldGids.has(old)) {
      usedOldGids.add(old);
      newOrder.push(old);
    }
    cpToGid.set(cp, newOrder.indexOf(old));
  }

  // 如果除了 .notdef 一个字形都没拿到，说明输入有问题，直接报错而不是产出空字体
  if (newOrder.length <= 1) {
    throw new Error(
      `subsetFont: 字体里找不到任何指定字符的字形（共 ${wanted.length} 个码点）`,
    );
  }

  const newNumGlyphs = newOrder.length;

  /* --- glyf / loca --- */
  const glyphChunks = [];
  let cursor = 0;
  const locaOffsets = [0];
  for (const oldGid of newOrder) {
    const data = font.glyphData(oldGid);
    if (!data || !data.length) {
      locaOffsets.push(cursor);
      continue;
    }
    // 字形数据要求 4 字节对齐
    const pad = (4 - (data.length % 4)) % 4;
    const chunk = Buffer.alloc(data.length + pad);
    Buffer.from(data).copy(chunk, 0);
    glyphChunks.push(chunk);
    cursor += chunk.length;
    locaOffsets.push(cursor);
  }
  const glyf = Buffer.concat(glyphChunks);
  const locaArr = locaOffsets;
  const loca = Buffer.alloc((newNumGlyphs + 1) * 4);
  for (let i = 0; i <= newNumGlyphs; i++) loca.writeUInt32BE(locaArr[i] || 0, i * 4);

  /* --- hmtx --- */
  const hmtx = Buffer.alloc(newNumGlyphs * 4);
  for (let i = 0; i < newNumGlyphs; i++) {
    const oldGid = newOrder[i];
    hmtx.writeUInt16BE(font.advance[oldGid] || 0, i * 4);
    hmtx.writeInt16BE(font.lsb[oldGid] || 0, i * 4 + 2);
  }

  /* --- cmap：format 4（BMP）+ format 12 可选 --- */
  const cmap = buildCmap([...cpToGid.entries()]);

  /* --- head --- */
  const head = Buffer.from(font.head);
  head.writeUInt32BE(0, 8); // checkSumAdjustment 先置 0
  const locaLong = Buffer.alloc(2);
  locaLong.writeInt16BE(1, 0); // indexToLocFormat = 1（长格式）
  locaLong.copy(head, 50);

  /* --- hhea --- */
  const hhea = Buffer.from(font.hhea);
  hhea.writeUInt16BE(newNumGlyphs, 34); // numberOfHMetrics

  /* --- maxp --- */
  const maxp = Buffer.from(font.maxp);
  maxp.writeUInt16BE(newNumGlyphs, 4);

  /* --- name：保留原样（体积很小）--- */
  const name = font.name ? Buffer.from(font.name) : minimalName();

  /* --- OS/2：保留；若缺失就造一个 --- */
  const os2 = font.os2 ? Buffer.from(font.os2) : minimalOS2(font.unitsPerEm);

  /* --- post：版本 3.0（无字形名）最小表 --- */
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);
  post.writeUInt32BE(font.unitsPerEm >= 1000 ? 1000 : 1000, 12); // italicAngle 之后是 underlinePosition
  post.writeInt16BE(-100, 16);
  post.writeInt16BE(50, 18);
  post.writeUInt32BE(0, 20); // isFixedPitch
  post.writeUInt32BE(0, 24);
  post.writeUInt32BE(0, 28);

  const outTables = {
    "OS/2": os2,
    cmap,
    glyf,
    head,
    hhea,
    hmtx,
    loca,
    maxp,
    name,
    post,
  };

  const fontBuffer = assembleTTF(outTables, font.unitsPerEm);

  return {
    fontBuffer,
    gidOf: (cp) => {
      const g = cpToGid.get(cp);
      return typeof g === "number" ? g : 0;
    },
    unitsPerEm: font.unitsPerEm,
    advanceOf: (gid) => {
      const oldGid = newOrder[gid];
      return font.advance[oldGid] || 0;
    },
  };
}

function buildCmap(pairs) {
  // ---- format 4 ----
  const bmp = pairs.filter(([cp]) => cp <= 0xffff).sort((a, b) => a[0] - b[0]);
  const segments = [];
  for (const [cp, gid] of bmp) {
    const delta = (gid - cp) & 0xffff;
    const last = segments[segments.length - 1];
    if (last && cp === last.end + 1 && delta === last.delta) {
      last.end = cp;
    }
    else {
      segments.push({ start: cp, end: cp, delta });
    }
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segments.length;
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * Math.pow(2, entrySelector);
  const rangeShift = segCount * 2 - searchRange;

  const sub4Len = 16 + segCount * 8;
  const sub4 = Buffer.alloc(sub4Len);
  sub4.writeUInt16BE(4, 0);
  sub4.writeUInt16BE(sub4Len, 2);
  sub4.writeUInt16BE(0, 4);
  sub4.writeUInt16BE(segCount * 2, 6);
  sub4.writeUInt16BE(searchRange, 8);
  sub4.writeUInt16BE(entrySelector, 10);
  sub4.writeUInt16BE(rangeShift, 12);
  let p = 14;
  for (const s of segments) {
    sub4.writeUInt16BE(s.end, p);
    p += 2;
  }
  sub4.writeUInt16BE(0, p); // reservedPad
  p += 2;
  for (const s of segments) {
    sub4.writeUInt16BE(s.start, p);
    p += 2;
  }
  for (const s of segments) {
    sub4.writeUInt16BE(s.delta & 0xffff, p);
    p += 2;
  }
  for (let i = 0; i < segCount; i++) {
    sub4.writeUInt16BE(0, p); // idRangeOffset
    p += 2;
  }

  // ---- format 12（覆盖 BMP 之外的码位；没有就省略）---
  const beyond = pairs.filter(([cp]) => cp > 0xffff);
  let sub12 = Buffer.alloc(0);
  let has12 = false;
  if (beyond.length) {
    has12 = true;
    const groups = [];
    for (const [cp, gid] of beyond.sort((a, b) => a[0] - b[0])) {
      const last = groups[groups.length - 1];
      if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
      else groups.push({ start: cp, end: cp, gid });
    }
    sub12 = Buffer.alloc(16 + groups.length * 12);
    sub12.writeUInt16BE(12, 0);
    sub12.writeUInt32BE(16 + groups.length * 12, 4);
    sub12.writeUInt32BE(0, 8);
    sub12.writeUInt32BE(groups.length, 12);
    let q = 16;
    for (const g of groups) {
      sub12.writeUInt32BE(g.start, q);
      sub12.writeUInt32BE(g.end, q + 4);
      sub12.writeUInt32BE(g.gid, q + 8);
      q += 12;
    }
  }

  const subtables = [{ platformID: 3, encodingID: 1, data: sub4 }];
  if (has12) subtables.push({ platformID: 3, encodingID: 10, data: sub12 });
  subtables.push({ platformID: 0, encodingID: has12 ? 4 : 3, data: has12 ? sub12 : sub4 });

  const headerLen = 4 + subtables.length * 8;
  const total = headerLen + subtables.reduce((n, s) => n + s.data.length, 0);
  const buf = Buffer.alloc(total);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt16BE(subtables.length, 2);
  let off = headerLen;
  subtables.forEach((s, i) => {
    const r = 4 + i * 8;
    buf.writeUInt16BE(s.platformID, r);
    buf.writeUInt16BE(s.encodingID, r + 2);
    buf.writeUInt32BE(off, r + 4);
    s.data.copy(buf, off);
    off += s.data.length;
  });
  return buf;
}

function minimalName() {
  const records = [
    [1, "BilingualSubset"], // family
    [2, "Regular"], // subfamily
    [4, "BilingualSubset"], // full
    [6, "BilingualSubset"], // postscript
  ];
  const strings = [];
  const recs = [];
  let strOff = 0;
  for (const [id, str] of records) {
    const bytes = Buffer.from(str, "utf16le");
    recs.push({ id, len: bytes.length, off: strOff });
    strings.push(bytes);
    strOff += bytes.length;
  }
  const headerLen = 6 + recs.length * 12;
  const buf = Buffer.alloc(headerLen + strOff);
  buf.writeUInt16BE(0, 0);
  buf.writeUInt16BE(recs.length, 2);
  buf.writeUInt16BE(headerLen, 4);
  recs.forEach((r, i) => {
    const p = 6 + i * 12;
    buf.writeUInt16BE(3, p); // platform = Windows
    buf.writeUInt16BE(1, p + 2); // encoding = Unicode BMP
    buf.writeUInt16BE(0x0804, p + 4); // language = zh-CN
    buf.writeUInt16BE(r.id, p + 6);
    buf.writeUInt16BE(r.len, p + 8);
    buf.writeUInt16BE(r.off, p + 10);
  });
  let off = headerLen;
  for (const s of strings) {
    s.copy(buf, off);
    off += s.len;
  }
  return buf;
}

function minimalOS2(unitsPerEm) {
  const b = Buffer.alloc(96);
  b.writeUInt16BE(4, 0); // version
  b.writeInt16BE(Math.round(unitsPerEm * 0.65), 2); // xAvgCharWidth
  b.writeUInt16BE(400, 4); // usWeightClass
  b.writeUInt16BE(5, 6); // usWidthClass
  b.writeUInt16BE(0, 8); // fsType = installable
  b.writeInt16BE(Math.round(unitsPerEm * 0.8), 68); // sTypoAscender
  b.writeInt16BE(-Math.round(unitsPerEm * 0.2), 70); // sTypoDescender
  b.writeUInt16BE(unitsPerEm, 74); // usWinAscent
  b.writeUInt16BE(Math.round(unitsPerEm * 0.2), 76); // usWinDescent
  return b;
}

function assembleTTF(tablesIn, unitsPerEm) {
  const order = ["head", "hhea", "maxp", "OS/2", "hmtx", "cmap", "glyf", "loca", "name", "post"];
  const entries = order
    .filter((n) => tablesIn[n])
    .map((n) => ({ tag: n, data: tablesIn[n] }));

  const numTables = entries.length;
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * Math.pow(2, entrySelector);
  const rangeShift = numTables * 16 - searchRange;

  // 先算每个表的偏移
  const headerLen = 12 + numTables * 16;
  let cursor = headerLen;
  const placed = [];
  for (const e of entries) {
    const pad = (4 - (e.data.length % 4)) % 4;
    placed.push({ tag: e.tag, data: e.data, offset: cursor, length: e.data.length, pad });
    cursor += e.data.length + pad;
  }

  const out = Buffer.alloc(cursor);
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(rangeShift, 10);

  placed.forEach((p, i) => {
    const rec = 12 + i * 16;
    writeTag(p.tag).copy(out, rec);
    out.writeUInt32BE(checksum(p.data), rec + 4);
    out.writeUInt32BE(p.offset, rec + 8);
    out.writeUInt32BE(p.length, rec + 12);
    Buffer.from(p.data).copy(out, p.offset);
  });

  // head.checkSumAdjustment = 0xB1B0AFBA - checksum(whole font)
  let headOffset = null;
  placed.forEach((p) => {
    if (p.tag === "head") headOffset = p.offset;
  });
  if (headOffset != null) {
    out.writeUInt32BE(0, headOffset + 8);
    const total = checksum(out);
    const adj = (0xb1b0afba - total) >>> 0;
    out.writeUInt32BE(adj, headOffset + 8);
  }
  return out;
}
