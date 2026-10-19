/**
 * 端到端验证 PDF 生成：真实中文字体 → 子集化 → 生成 PDF → 写盘。
 * 之后交给 Python 用 pypdf 读文字、PyMuPDF 渲染成图检查。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { parseTTF, subsetFont } from "./ttf-subset.js";
import { buildPDF } from "./pdf-writer.js";

const here = dirname(fileURLToPath(import.meta.url));
const TMP = process.env.TEMP;

// 用一篇真论文的译文当素材（之前测过的那篇的段落）
const SECTIONS = [
  {
    title: "第 1 页",
    paragraphs: [
      "人工智能系统越来越多地部署在医疗保健和刑事司法等高风险领域。本文论证，可解释性的要求建立在一种站不住脚的公共理性图景之上。",
      "人们常把可解释性当作机器学习模型不透明性的补救措施，但这种提议预设了一个不成立的前提：公众能够且应当就算法的内部机制达成一致理解。",
      "我们主张，公共理性的规范性要求并不指向机械意义上的透明，而指向可问责的制度安排。因此，把可解释性当作万能药是一种范畴错误。",
    ],
  },
  {
    title: "第 2 页",
    paragraphs: [
      "来自人类心智局限性的论证（the argument from the limitations of the human mind）表明，要求普通人理解深度神经网络的决策过程是不合理的。",
      "考虑一个具体例子：如果一位医生无法解释某个诊断模型为何给出特定建议，我们是否应当因此拒绝使用该系统？答案取决于我们要求的是「理解」还是「问责」。",
      "English mixed in: the alignment problem is essentially contestable. 数字 0123456789 与中英混排也要能正常显示。",
      "标点测试：中文逗号，句号。分号；冒号：顿号、问号？感叹号！引号「」『』括号（）【】破折号——省略号……",
    ],
  },
];

/* ------------------------- 字体子集化 ------------------------- */

const FONT = "C:/Windows/Fonts/simfang.ttf";
const rawFont = readFileSync(FONT);
const font = parseTTF(rawFont);
console.log(`字体: ${FONT} | ${font.numGlyphs} 字形 | unitsPerEm=${font.unitsPerEm}`);

const DOC_TITLE = "The Testimony Gap: Machines and Reasons（中文译文）";

const allCps = new Set();
for (const sec of SECTIONS) {
  for (const p of [sec.title, ...sec.paragraphs]) {
    for (const ch of p) allCps.add(ch.codePointAt(0));
  }
}
// ⚠️ 页眉会画出文档标题和页码，这些字符也必须进子集，
// 否则标题上的大写字母会整体缺字形（这个 bug 踩过）。
for (const ch of DOC_TITLE) allCps.add(ch.codePointAt(0));
for (const ch of "第 页/共0123456789中文译文") allCps.add(ch.codePointAt(0));

const subset = subsetFont(font, [...allCps]);
console.log(`子集: ${subset.fontBuffer.length} bytes (${(subset.fontBuffer.length / 1024).toFixed(1)} KB)`);

// 立刻自检：子集对象刚建好时映射是否正确
{
  const probes = [..."第页共人工智能系统"];
  const got = probes.map((c) => subset.gidOf(c.codePointAt(0)));
  console.log(`  建好时 gidOf: ${probes.map((c, i) => c + "=" + got[i]).join(" ")}`);
  const zeros = got.filter((g) => g === 0).length;
  if (zeros) console.log(`  ⚠️ 其中 ${zeros} 个映射为 0`);
}

const missing = [...allCps].filter((cp) => subset.gidOf(cp) === 0 && cp !== 32);
console.log(`字体缺失字符: ${missing.length ? missing.map((c) => String.fromCodePoint(c)).join("") : "无"}`);

/* --------------------------- 生成 PDF --------------------------- */

// PDF 的 FlateDecode 要求 zlib 格式（带 2 字节头），**不是** raw deflate。
// 用 deflateRawSync 会让所有阅读器报 "incorrect header check"。
const deflate = async (u8) => new Uint8Array(deflateSync(Buffer.from(u8)));

globalThis.__PDF_DEBUG__ = true;

const pdf = await buildPDF({
  sections: SECTIONS,
  subset,
  deflate,
  title: DOC_TITLE,
});

const out = join(TMP, "bilingual-test.pdf");
writeFileSync(out, pdf);
console.log(`\nPDF 已生成: ${out}`);
console.log(`  大小: ${(pdf.length / 1024).toFixed(1)} KB`);
console.log(`  头: ${pdf.subarray(0, 8).toString("latin1")}`);
console.log(`  尾: ${pdf.subarray(-7).toString("latin1").trim()}`);
console.log(`PDF_PATH=${out}`);
