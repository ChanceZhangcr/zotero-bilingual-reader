/**
 * 一次性检查：确认打出来的 xpi 里工具栏按钮的代码真的没了、悬浮按钮的代码在。
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const file = process.argv[2] || "build/bilingual-reader_1.3.3.xpi";
const b = readFileSync(file);

let e = b.length - 22;
while (e > 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
const count = b.readUInt16LE(e + 10);
let off = b.readUInt32LE(e + 16);

const MUST_HAVE = [
  "function getSavedPos",
  "function ensureReaderUi",
  "function ensureFloatingButton",
  "function ensurePanelMounted",
];
const MUST_NOT_HAVE = [
  "createToolbarButton",
  "injectToolbarButton",
  "TOOLBAR_BTN_ID",
  "ensureToolbarDelegation",
  "bilingual-toolbar-button",
];

for (let k = 0; k < count; k++) {
  const nameLen = b.readUInt16LE(off + 28);
  const name = b.toString("utf8", off + 46, off + 46 + nameLen);
  const csize = b.readUInt32LE(off + 20);
  const lho = b.readUInt32LE(off + 42);
  const lnameLen = b.readUInt16LE(lho + 26);
  const lextraLen = b.readUInt16LE(lho + 28);
  const data = b.slice(lho + 30 + lnameLen + lextraLen, lho + 30 + lnameLen + lextraLen + csize);

  if (name.endsWith("bilingual.js")) {
    const text = inflateRawSync(data).toString("utf8");
    console.log(`--- ${name} (${text.length} 字符)`);
    for (const p of MUST_HAVE) console.log(`  ${text.includes(p) ? "✅ 有" : "❌ 缺"}  ${p}`);
    for (const p of MUST_NOT_HAVE) console.log(`  ${text.includes(p) ? "❌ 还在" : "✅ 已删"}  ${p}`);
  }
  else if (name.endsWith("manifest.json")) {
    const text = inflateRawSync(data).toString("utf8");
    const version = JSON.parse(text).version;
    console.log(`--- ${name}：version = ${version}`);
  }
  off += 46 + nameLen + b.readUInt16LE(off + 30) + b.readUInt16LE(off + 32);
}
