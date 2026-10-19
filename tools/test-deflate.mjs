/**
 * 验证自研 DEFLATE（03-deflate.js）：
 *  - 用 Node 的 zlib.inflateSync 反向解压，必须还原成原始字节
 *  - 用真实 PDF 字体/内容流跑一遍，确认压缩率合理
 *  - 用自研压缩生成 PDF，交给 pypdf/PyMuPDF 验证
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync, deflateSync } from "node:zlib";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const TMP = process.env.TEMP;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ---------- 沙箱环境（故意不放 CompressionStream，模拟 Zotero） ---------- */

const sandbox = {
  console, setTimeout, clearTimeout,
  TextEncoder, TextDecoder, Uint8Array, DataView, Int32Array, Map, Set,
  Math, Date, String, Number, Array, Object, JSON, Error, Promise,
};
const ctx = vm.createContext(sandbox);
for (const f of ["01-ttf.js", "03-deflate.js", "02-pdf.js"]) {
  vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
}
const NS = sandbox.__bilingualNS;
check("命名空间与三个模块", !!NS?.tools?.ttf && !!NS?.tools?.deflate && !!NS?.tools?.pdf);
check("沙箱里确实没有 CompressionStream（模拟真实环境）", typeof sandbox.CompressionStream === "undefined");

const deflateZlib = NS.tools.deflate.deflateZlib;

/* ---------------------- 1. 正确性：逐字节比对 ---------------------- */

console.log("\n=== 1. DEFLATE 正确性（Node zlib 反向解压）===");

const cases = [
  {
    name: "空输入",
    data: new Uint8Array(0),
  },
  {
    name: "单个字节",
    data: new Uint8Array([0x41]),
  },
  {
    name: "短文本",
    data: new TextEncoder().encode("Hello, PDF!"),
  },
  {
    name: "重复串（利于 LZ77）",
    data: new TextEncoder().encode("ABABABABABABABAB".repeat(50)),
  },
  {
    name: "中文 UTF-8",
    data: new TextEncoder().encode("人工智能的可解释性与公共理性。".repeat(20)),
  },
  {
    name: "全字节值 0-255",
    data: new Uint8Array(Array.from({ length: 1024 }, (_, i) => i & 0xff)),
  },
  {
    name: "随机字节（不可压缩）",
    data: new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) & 0xff)),
  },
];

for (const c of cases) {
  let ok = false;
  let detail = "";
  try {
    const out = deflateZlib(c.data);
    if (out === null) {
      // 压缩无收益：调用方会改用不压缩存储，这算通过
      ok = true;
      detail = "压缩无收益→返回 null（走不压缩存储）";
    }
    else {
      const back = inflateSync(Buffer.from(out));
      ok = Buffer.compare(back, Buffer.from(c.data)) === 0;
      const ratio = c.data.length ? (out.length / c.data.length) : 0;
      detail = `${c.data.length} → ${out.length} B (${(ratio * 100).toFixed(0)}%)`;
      if (!ok) detail += "  ⚠️ 解压结果不一致";
    }
  }
  catch (e) {
    detail = `抛异常 ${e.message}`;
  }
  check(`${c.name}`, ok, detail);
}

/* ---------------------- 2. 压缩率对比 ---------------------- */

console.log("\n=== 2. 压缩率（与 Node zlib 对比）===");
{
  const font = new Uint8Array(readFileSync("C:/Windows/Fonts/simfang.ttf"));
  // 只取子集，模拟真实场景
  const subsetSnippet = font.subarray(0, 200000);
  const mine = deflateZlib(subsetSnippet);
  const ref = deflateSync(Buffer.from(subsetSnippet), { level: 6 });
  check(
    "字体片段可压缩且解压正确",
    mine && Buffer.compare(inflateSync(Buffer.from(mine)), Buffer.from(subsetSnippet)) === 0,
    mine ? `自研 ${(mine.length / 1024).toFixed(1)} KB vs zlib ${(ref.length / 1024).toFixed(1)} KB` : "null",
  );

  const text = new TextEncoder().encode(
    "人工智能系统越来越多地部署在医疗保健和刑事司法等高风险领域。本文论证，可解释性的要求建立在一种站不住脚的公共理性图景之上。".repeat(30),
  );
  const mine2 = deflateZlib(text);
  const ref2 = deflateSync(Buffer.from(text));
  check(
    "中文文本可压缩且解压正确",
    mine2 && Buffer.compare(inflateSync(Buffer.from(mine2)), Buffer.from(text)) === 0,
    mine2 ? `自研 ${(mine2.length / 1024).toFixed(1)} KB vs zlib ${(ref2.length / 1024).toFixed(1)} KB` : "null",
  );

  const t0 = Date.now();
  deflateZlib(new Uint8Array(font.subarray(0, 300000)));
  const dt = Date.now() - t0;
  check("压缩速度可接受（300 KB < 3 秒）", dt < 3000, `${dt} ms`);
}

/* ---------------------- 3. 生成 PDF 并验证 ---------------------- */

console.log("\n=== 3. 用自研 DEFLATE 生成 PDF ===");
{
  const fontBytes = new Uint8Array(readFileSync("C:/Windows/Fonts/simfang.ttf"));
  const font = NS.tools.ttf.parseTTF(fontBytes);
  const SECTIONS = [
    {
      title: "第 1 页",
      paragraphs: [
        "人工智能系统越来越多地部署在医疗保健和刑事司法等高风险领域。",
        "English mixed: the alignment problem is essentially contestable. 数字 0123456789。",
        "标点：中文逗号，句号。分号；冒号：顿号、问号？引号「」『』括号（）【】破折号——省略号……",
      ],
    },
  ];
  const DOC_TITLE = "The Testimony Gap: Machines and Reasons（中文译文）";

  const cps = new Set();
  for (const ch of DOC_TITLE) cps.add(ch.codePointAt(0));
  for (const ch of "第 页 / 共 0123456789") cps.add(ch.codePointAt(0));
  for (const s of SECTIONS) {
    for (const ch of s.title) cps.add(ch.codePointAt(0));
    for (const p of s.paragraphs) for (const ch of p) cps.add(ch.codePointAt(0));
  }
  const subset = NS.tools.ttf.subsetFont(font, [...cps]);

  const pdf = await NS.tools.pdf.buildPDF({
    sections: SECTIONS,
    subset,
    deflate: NS.tools.pdf.deflateZlib, // ← 走自研 DEFLATE（沙箱里没有 CompressionStream）
    title: DOC_TITLE,
  });

  const out = join(TMP, "own-deflate-test.pdf");
  writeFileSync(out, Buffer.from(pdf));
  check("PDF 头尾正确", Buffer.from(pdf.slice(0, 8)).toString("latin1") === "%PDF-1.7"
    && Buffer.from(pdf.slice(-7)).toString("latin1").trim() === "%%EOF");
  check("PDF 体积合理（< 500 KB）", pdf.length < 500 * 1024, `${(pdf.length / 1024).toFixed(1)} KB`);
  check("无缺字", !pdf.missingChars, pdf.missingChars || "");
  console.log(`  PDF -> ${out}`);
  console.log(`OWN_DEFLATE_PDF=${out}`);
}

console.log(`\n${failures === 0 ? "✅ 自研 DEFLATE 全部通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
