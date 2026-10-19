/**
 * TTC（字体集合）解析测试。
 *
 * 为什么要管 TTC：macOS 的中文字体几乎全是 .ttc（PingFang.ttc / Songti.ttc），
 * 只支持单体 TTF 的话，Mac 朋友装了这个插件导 PDF 会直接失败。
 * 这里用 Windows 上的 msyh.ttc / simsun.ttc 做真实样本。
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import vm from "node:vm";

const SRC = "src";
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const sandbox = { console, Uint8Array, DataView, Array, Object, Math, String, Number, Error, Map, Set };
const ctx = vm.createContext(sandbox);
for (const f of ["01-ttf.js", "02-pdf.js", "03-deflate.js"]) {
  vm.runInContext(readFileSync(`${SRC}/${f}`, "utf8"), ctx, { filename: f });
}
const NS = sandbox.__bilingualNS;

const read = (p) => new Uint8Array(readFileSync(p));

console.log("=== 单体 TTF 仍然正常 ===");
const ttf = NS.tools.ttf.parseTTF(read("C:/Windows/Fonts/simfang.ttf"));
check("simfang.ttf 解析出字形", ttf.numGlyphs > 10000, `${ttf.numGlyphs} 字形`);
const gidTtf = ttf.charToGlyph.get("中".codePointAt(0));
check("simfang 有「中」", gidTtf > 0, `gid=${gidTtf}`);

console.log("\n=== TTC 字体集合 ===");
for (const [path, name] of [["C:/Windows/Fonts/msyh.ttc", "msyh.ttc"], ["C:/Windows/Fonts/simsun.ttc", "simsun.ttc"]]) {
  if (!existsSync(path.replace(/\//g, "\\"))) {
    check(`${name} 存在`, false, "本机没有这个文件，跳过");
    continue;
  }
  const buf = read(path);
  const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  check(`${name} 是 ttcf 容器`, sig === "ttcf", sig);

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numFonts = dv.getUint32(8);
  console.log(`     集合里有 ${numFonts} 个字体`);

  let ok = 0;
  const gids = [];
  for (let i = 0; i < Math.min(numFonts, 4); i++) {
    try {
      const font = NS.tools.ttf.parseTTF(buf, i);
      const gid = font.charToGlyph.get("中".codePointAt(0)) || 0;
      gids.push(`#${i}:${font.numGlyphs}字形/中=${gid}`);
      if (font.numGlyphs > 1000 && gid > 0) ok += 1;
    }
    catch (e) {
      gids.push(`#${i}:ERR ${e.message}`);
    }
  }
  check(`${name} 前 4 个字体都能解析且有「中」`, ok >= Math.min(numFonts, 4), gids.join(" | "));

  // 真正做一次子集化，确保后续 PDF 流程能走通
  try {
    const font = NS.tools.ttf.parseTTF(buf, 0);
    const subset = NS.tools.ttf.subsetFont(font, [..."中文测试ABC123"]);
    check(`${name} 子集化可用`, subset.fontBuffer.length > 3000,
      `${(subset.fontBuffer.length / 1024).toFixed(1)} KB`);
    const gid = subset.gidOf("中".codePointAt(0));
    check(`${name} 子集里「中」映射到有效字形`, gid > 0, `gid=${gid}`);
  }
  catch (e) {
    check(`${name} 子集化`, false, e.message);
  }
}

console.log("\n=== 越界的 fontIndex 不应崩 ===");
try {
  const font = NS.tools.ttf.parseTTF(read("C:/Windows/Fonts/msyh.ttc"), 999);
  check("index 超范围时退回最后一个", font.numGlyphs > 1000, `${font.numGlyphs} 字形`);
}
catch (e) {
  check("index 超范围", false, e.message);
}

console.log("\n=== 非字体文件应当报错 ===");
try {
  NS.tools.ttf.parseTTF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  check("非字体文件报错", false, "居然没报错");
}
catch (e) {
  check("非字体文件报错", /不是 TrueType 字体/.test(e.message), e.message);
}

console.log("\n=== 用 TTC 字体真的生成一份 PDF ===");
{
  const { writeFileSync } = await import("node:fs");
  const { deflateSync } = await import("node:zlib");
  const { join } = await import("node:path");
  try {
    const buf = read("C:/Windows/Fonts/msyh.ttc");
    const font = NS.tools.ttf.parseTTF(buf, 0);
    const paras = ["用微软雅黑（TTC 字体集合）生成的中文译文。", "Mixed English with 中文混排 123。"];
    const cps = new Set();
    for (const p of paras) for (const ch of p) cps.add(ch.codePointAt(0));
    // ⚠️ 文档标题也要收进子集：PDF 里它会画在页眉，漏了就是"缺字"
    for (const ch of "TTC 测试") cps.add(ch.codePointAt(0));
    for (const ch of "第 页 / 共 0123456789TCTest") cps.add(ch.codePointAt(0));
    const subset = NS.tools.ttf.subsetFont(font, [...cps]);
    const bytes = await NS.tools.pdf.buildPDF({
      sections: [{ title: "第 1 页", paragraphs: paras }],
      subset,
      deflate: async (u8) => new Uint8Array(deflateSync(Buffer.from(u8))),
      title: "TTC 测试",
    });
    check("PDF 生成成功", bytes.length > 3000, `${(bytes.length / 1024).toFixed(1)} KB`);
    check("没有缺字", !bytes.missingChars, bytes.missingChars || "");
    const out = join(process.env.TEMP || "/tmp", "bilingual-ttc-test.pdf");
    writeFileSync(out, Buffer.from(bytes));
    console.log(`TTC_PDF=${out}`);
  }
  catch (e) {
    check("用 TTC 生成 PDF", false, e?.message || e);
  }
}

console.log(`\n${failures === 0 ? "✅ TTC 测试全部通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
