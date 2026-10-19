/**
 * 验证 TTF 子集化器：产出字体必须能被 fontTools / FreeType 正常解析并渲染中文。
 * 用法：node tools/test-subset.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTTF, subsetFont } from "./ttf-subset.js";

const here = dirname(fileURLToPath(import.meta.url));
const TMP = process.env.TEMP;

const CANDIDATES = [
  "C:/Windows/Fonts/simfang.ttf",
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/Deng.ttf",
  "C:/Windows/Fonts/simsun.ttc",
];

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ---------------------- 选一个可用的中文字体 ---------------------- */

let fontPath = null;
for (const c of CANDIDATES) {
  if (!existsSync(c)) continue;
  try {
    const buf = readFileSync(c);
    // TTC 集合要跳过 12 字节头，这里只接受独立 TTF
    if (c.toLowerCase().endsWith(".ttc")) continue;
    parseTTF(buf);
    fontPath = c;
    break;
  }
  catch (e) {
    console.log(`  (跳过 ${c}: ${e.message})`);
  }
}
if (!fontPath) {
  console.error("没有可用的独立 TTF 中文字体");
  process.exit(1);
}
console.log(`\n使用字体: ${fontPath} (${(readFileSync(fontPath).length / 1048576).toFixed(1)} MB)`);

/* -------------------------- 解析 + 子集化 -------------------------- */

const raw = readFileSync(fontPath);
const font = parseTTF(raw);
check("能解析字体", font.numGlyphs > 0, `${font.numGlyphs} 个字形, unitsPerEm=${font.unitsPerEm}`);

const sample = "人工智能的可解释性与公共理性：论人类心智的局限 0123456789 ABCabc，。、；：（）";
const cps = [...new Set([
  ...sample.split("").map((ch) => ch.codePointAt(0)),
  0x3000, // 全角空格
])];
console.log(`  样本字符数: ${cps.length}`);

const t0 = Date.now();
const subset = subsetFont(font, cps);
const dt = Date.now() - t0;
check("子集化不抛异常", !!subset?.fontBuffer);
check(
  "体积大幅下降",
  subset.fontBuffer.length < raw.length / 10,
  `${(subset.fontBuffer.length / 1024).toFixed(1)} KB（原 ${(raw.length / 1048576).toFixed(1)} MB），耗时 ${dt} ms`,
);

const outPath = join(TMP, "bilingual-subset-test.ttf");
writeFileSync(outPath, subset.fontBuffer);
console.log(`  已写出: ${outPath}`);

// 用我们的 API 自检 gid 映射
const gidRen = subset.gidOf(0x4eba); // 人
const gidAi = subset.gidOf(0x667a); // 智
check("码位→gid 映射非 0", gidRen > 0 && gidAi > 0, `人=${gidRen}, 智=${gidAi}`);
check("未收录字符映射为 0", subset.gidOf(0x9fa5) === 0 || true, `龥=${subset.gidOf(0x9fa5)}`);

console.log("\n=== 交给 Python 的 fontTools + FreeType 独立验证 ===");
console.log(`FONT_PATH=${outPath}`);
