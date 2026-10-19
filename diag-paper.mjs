import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const PY = "C:\\Users\\22124\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";
const PDF = "D:\\storage\\zotero\\storage\\LTNT58ZP\\Sparrow和Flenady - 2025 - The Testimony Gap Machines and Reasons.pdf";
const TMP = process.env.TEMP;

// 1) 用 pypdf 抽出每页文本（模拟 Zotero 的文字层）
const pyCode = `
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
from pypdf import PdfReader
r = PdfReader(r"${PDF}")
pages = []
for p in r.pages:
    try: pages.append(p.extract_text() or "")
    except Exception: pages.append("")
json.dump({"pages": pages}, open(r"${TMP}\\tg_pages.json", "w", encoding="utf-8"), ensure_ascii=False)
print("页数:", len(pages), "总字符:", sum(len(p) for p in pages))
`;
writeFileSync(`${TMP}\\tg_extract.py`, pyCode, "utf8");
console.log(execFileSync(PY, [`${TMP}\\tg_extract.py`], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }));

// 2) 用插件的真实代码重建段落并打包
const Zotero = {
  debug() {}, logError() {},
  Prefs: { get: () => undefined, set() {} },
  Promise: { delay: () => Promise.resolve() },
  DataDirectory: { dir: null }, Reader: { _readers: [] }, version: "9.0.5",
};
const ctx = vm.createContext({ Zotero, console, setTimeout, clearTimeout, PathUtils: { join: (...a) => a.filter(Boolean).join("/") } });
for (const f of ["00-core.js", "10-translate.js", "20-cache.js", "30-paper.js", "40-reader.js", "50-selection.js", "60-main.js", "99-main.js"]) {
  vm.runInContext(readFileSync(`src/${f}`, "utf8"), ctx, { filename: f });
}
const U = ctx.Bilingual.utils;
const T = ctx.Bilingual.translate;

const { pages } = JSON.parse(readFileSync(`${TMP}\\tg_pages.json`, "utf8"));
const segs = [];
for (let i = 0; i < pages.length; i++) {
  for (const u of U.splitParagraphs(pages[i])) {
    if (U.isTranslatable(u)) segs.push({ page: i + 1, src: u });
  }
}
console.log(`\n可翻译段落: ${segs.length}`);

const lens = segs.map((s) => s.src.length).sort((a, b) => a - b);
console.log(`长度 min/中位/max: ${lens[0]} / ${lens[Math.floor(lens.length / 2)]} / ${lens[lens.length - 1]}`);
console.log(`超 1200 字符: ${lens.filter((l) => l > 1200).length}`);

// 3) 用插件的打包逻辑算请求数
const packed = T.packParagraphs(segs.map((s) => s.src), 1200, false);
console.log(`请求块数: ${packed.chunks.length}（多段合并 ${packed.chunks.filter((c) => c.segs.length > 1).length} 个）`);
console.log(`=> 免费引擎需要约 ${packed.chunks.length} 次 HTTP 请求（串行）`);

// 4) 导出前 6 个块，交给 Python 实测耗时
const sample = packed.chunks.slice(0, 6).map((c, i) => ({
  id: i,
  n: c.segs.length,
  text: T.markSegments(c.segs.map((s) => s.trim())),
}));
writeFileSync(`${TMP}\\tg_chunks.json`, JSON.stringify(sample));
console.log(`\n已导出 ${sample.length} 个样本块用于实测`);
