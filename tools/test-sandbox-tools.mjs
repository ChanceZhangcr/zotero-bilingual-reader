/**
 * 验证"沙箱版"工具层（src/01-ttf.js + src/02-pdf.js）与 Node 参考实现等价。
 * 用 Node 的 zlib 提供 deflate，用 Node 的 Response/CompressionStream 模拟沙箱能力。
 * 输出 PDF 后交由 Python 的 pypdf/PyMuPDF 验证。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const TMP = process.env.TEMP;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ---------- 沙箱环境（尽量贴近 Zotero：无 Buffer、无 require） ---------- */

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  DataView,
  Map,
  Set,
  Math,
  Date,
  String,
  Number,
  Array,
  Object,
  JSON,
  Error,
  Promise,
  Response,
  CompressionStream,
};
const ctx = vm.createContext(sandbox);

// 只加载两个工具文件（它们是自建命名空间的）
for (const f of ["01-ttf.js", "02-pdf.js"]) {
  try {
    vm.runInContext(readFileSync(join(SRC, f), "utf8"), ctx, { filename: f });
    console.log(`  载入 ${f} ✅`);
  }
  catch (e) {
    check(`载入 ${f}`, false, e.message);
    process.exit(1);
  }
}

const NS = sandbox.__bilingualNS;
check("命名空间已建立", !!NS?.tools);
check("暴露 ttf.subsetFont", typeof NS?.tools?.ttf?.subsetFont === "function");
check("暴露 pdf.buildPDF", typeof NS?.tools?.pdf?.buildPDF === "function");
check("暴露 pdf.deflateZlib", typeof NS?.tools?.pdf?.deflateZlib === "function");

/* ---------- 字体子集化（沙箱实现） ---------- */

const fontBytes = new Uint8Array(readFileSync("C:/Windows/Fonts/simfang.ttf"));
const font = NS.tools.ttf.parseTTF(fontBytes);
check("沙箱 parseTTF 可用", font.numGlyphs > 10000, `${font.numGlyphs} 字形`);

const SECTIONS = [
  {
    title: "第 1 页",
    paragraphs: [
      "人工智能系统越来越多地部署在医疗保健和刑事司法等高风险领域。本文论证，可解释性的要求建立在一种站不住脚的公共理性图景之上。",
      "English mixed: the alignment problem is essentially contestable. 数字 0123456789 与中英混排。",
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
check(
  "沙箱 subsetFont 产物体积合理",
  subset.fontBuffer.length > 5000 && subset.fontBuffer.length < 200000,
  `${(subset.fontBuffer.length / 1024).toFixed(1)} KB（${cps.size} 字符）`,
);
const probes = [..."人工智能第页共"];
const gids = probes.map((c) => subset.gidOf(c.codePointAt(0)));
check("中文都能映射到字形", gids.every((g) => g > 0), probes.map((c, i) => `${c}=${gids[i]}`).join(" "));

/* ---------- PDF 生成（沙箱实现 + Node 压缩） ---------- */

const pdfBytes = await NS.tools.pdf.buildPDF({
  sections: SECTIONS,
  subset,
  deflate: async (u8) => new Uint8Array(deflateSync(Buffer.from(u8))),
  title: DOC_TITLE,
});

const out = join(TMP, "sandbox-test.pdf");
writeFileSync(out, Buffer.from(pdfBytes));
check("PDF 头部正确", Buffer.from(pdfBytes.slice(0, 8)).toString("latin1") === "%PDF-1.7");
check("PDF 尾部正确", Buffer.from(pdfBytes.slice(-7)).toString("latin1").trim() === "%%EOF");
check("缺字报告为空", !pdfBytes.missingChars, pdfBytes.missingChars || "");
console.log(`  PDF: ${(pdfBytes.length / 1024).toFixed(1)} KB -> ${out}`);
console.log(`SANDBOX_PDF=${out}`);

console.log(`\n${failures === 0 ? "✅ 沙箱版工具层自检通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
