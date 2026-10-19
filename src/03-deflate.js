/**
 * 纯 JS 的 DEFLATE（zlib 格式）压缩器
 *
 * 为什么需要它：PDF 的 FlateDecode 要的是 zlib 流，而 **Zotero 插件沙箱里没有
 * CompressionStream**（plugins.js 的 wantGlobalProperties 白名单里只有
 * TextEncoder/TextDecoder，没有流式压缩 API）。没有它，PDF 导出直接卡在第一步。
 *
 * 实现：固定 Huffman 码（BTYPE=01）+ LZ77 匹配，输出 zlib 包装
 * （0x78 0x9C 头 + Adler-32 校验）。
 * 不做动态 Huffman 和最优解析——压缩率略低，但对 PDF 里这点数据完全够用，
 * 而且代码短、可读、可验证。
 *
 * 输出正确性用 Node 的 zlib.inflateSync 逐字节验证过。
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
  if (NS.tools.deflate) return;

  /* ------------------------- 固定 Huffman 码表 ------------------------- */

  // 长度码 257..285：对应基础长度与额外位数
  const LENGTH_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
  ];
  const LENGTH_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
  ];
  const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
  ];

  /** 固定 Huffman：字面/长度码 */
  function litCode(sym) {
    if (sym <= 143) return { code: 0x30 + sym, bits: 8 };
    if (sym <= 255) return { code: 0x190 + (sym - 144), bits: 9 };
    if (sym <= 279) return { code: sym - 256, bits: 7 };
    return { code: 0xc0 + (sym - 280), bits: 8 };
  }

  /** 固定 Huffman：距离码（5 位，值就是码字） */
  function distCode(sym) {
    return { code: sym, bits: 5 };
  }

  /* ---------------------------- 位写入器 ---------------------------- */

  class BitWriter {
    constructor() {
      this.bytes = [];
      this.bitBuf = 0;
      this.bitCount = 0;
    }

    /** DEFLATE 的位序是 LSB-first */
    writeBits(value, count) {
      for (let i = 0; i < count; i++) {
        this.bitBuf |= ((value >>> i) & 1) << this.bitCount;
        this.bitCount += 1;
        if (this.bitCount === 8) {
          this.bytes.push(this.bitBuf & 0xff);
          this.bitBuf = 0;
          this.bitCount = 0;
        }
      }
    }

    /** Huffman 码字本身是 MSB-first 写的，这里要反转 */
    writeCode(code, bits) {
      let rev = 0;
      for (let i = 0; i < bits; i++) {
        rev |= ((code >>> i) & 1) << (bits - 1 - i);
      }
      this.writeBits(rev, bits);
    }

    finish() {
      if (this.bitCount > 0) {
        this.bytes.push(this.bitBuf & 0xff);
        this.bitBuf = 0;
        this.bitCount = 0;
      }
      return this.bytes;
    }
  }

  /* ------------------------------ LZ77 ------------------------------ */

  const WINDOW = 32768;
  const MIN_MATCH = 3;
  const MAX_MATCH = 258;
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const MAX_CHAIN = 24; // 匹配搜索深度：越大压得越好、越慢

  function hash3(data, i) {
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
    return h;
  }

  /**
   * 压缩成 zlib 流（0x78 0x9C + deflate + Adler-32）。
   * @param {Uint8Array} input
   * @returns {Uint8Array}
   */
  function deflateZlib(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const n = data.length;

    // Adler-32（zlib 的校验）
    let a = 1;
    let b = 0;
    for (let i = 0; i < n; i++) {
      a = (a + data[i]) % 65521;
      b = (b + a) % 65521;
    }
    const adler = ((b << 16) | a) >>> 0;

    const out = new Uint8Array(2 + n + Math.ceil(n / 8) + 16 + 4);
    let outPos = 0;
    out[outPos++] = 0x78; // CMF: deflate, 32K window
    out[outPos++] = 0x9c; // FLG: 默认压缩级别，校验位正确

    const bw = new BitWriter();

    // 单个 final 块 + 固定 Huffman
    bw.writeBits(1, 1); // BFINAL
    bw.writeBits(1, 2); // BTYPE = 01（固定 Huffman）

    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(n).fill(-1);

    let pos = 0;
    while (pos < n) {
      let bestLen = 0;
      let bestDist = 0;

      if (pos + MIN_MATCH <= n) {
        const h = hash3(data, pos);
        let candidate = head[h];
        let chain = 0;
        const limit = Math.max(0, pos - WINDOW);
        while (candidate >= limit && candidate >= 0 && chain < MAX_CHAIN) {
          // 先比最长可能长度的最后一个字节，快速排除
          let len = 0;
          const maxLen = Math.min(MAX_MATCH, n - pos);
          if (data[candidate + bestLen] === data[pos + bestLen]) {
            while (len < maxLen && data[candidate + len] === data[pos + len]) len += 1;
          }
          if (len > bestLen) {
            bestLen = len;
            bestDist = pos - candidate;
            if (len >= MAX_MATCH) break;
          }
          candidate = prev[candidate];
          chain += 1;
        }
      }

      if (bestLen >= MIN_MATCH) {
        // 发射 length/distance
        let li = 0;
        while (li < LENGTH_BASE.length - 1 && LENGTH_BASE[li + 1] <= bestLen) li += 1;
        const lc = litCode(257 + li);
        bw.writeCode(lc.code, lc.bits);
        if (LENGTH_EXTRA[li]) bw.writeBits(bestLen - LENGTH_BASE[li], LENGTH_EXTRA[li]);

        let di = 0;
        while (di < DIST_BASE.length - 1 && DIST_BASE[di + 1] <= bestDist) di += 1;
        const dc = distCode(di);
        bw.writeCode(dc.code, dc.bits);
        if (DIST_EXTRA[di]) bw.writeBits(bestDist - DIST_BASE[di], DIST_EXTRA[di]);

        // 把这一段都登记进哈希链
        const end = pos + bestLen;
        for (let i = pos; i < end && i + MIN_MATCH <= n; i++) {
          const hh = hash3(data, i);
          prev[i] = head[hh];
          head[hh] = i;
        }
        pos = end;
      }
      else {
        const lc = litCode(data[pos]);
        bw.writeCode(lc.code, lc.bits);
        if (pos + MIN_MATCH <= n) {
          const hh = hash3(data, pos);
          prev[pos] = head[hh];
          head[hh] = pos;
        }
        pos += 1;
      }
    }

    // 结束码 256
    const endCode = litCode(256);
    bw.writeCode(endCode.code, endCode.bits);
    const body = bw.finish();

    // 实际 zlib 流 = 2 字节头 + deflate 体 + 4 字节 Adler-32
    const total = 2 + body.length + 4;
    // 压缩没有收益（小输入或高熵数据）时返回 null，让调用方改用"不压缩"存储。
    // 注意阈值要按真实总长比较，不能用未加包装的长度。
    if (total >= n) return null;

    const result = new Uint8Array(total);
    result[0] = 0x78;
    result[1] = 0x9c;
    result.set(body, 2);
    const rp = 2 + body.length;
    result[rp] = (adler >>> 24) & 0xff;
    result[rp + 1] = (adler >>> 16) & 0xff;
    result[rp + 2] = (adler >>> 8) & 0xff;
    result[rp + 3] = adler & 0xff;
    return result;
  }

  NS.tools.deflate = { deflateZlib };
})();
