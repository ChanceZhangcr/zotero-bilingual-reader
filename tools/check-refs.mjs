#!/usr/bin/env node
/**
 * 静态检查：找出"调用了但从未定义"的标识符。
 *
 * 为什么需要：
 *   `ensureFloatingButton` 里写了 `const saved = getSavedPos();`，而 getSavedPos
 *   根本没有定义 → 运行时抛 ReferenceError → 被外层 try/catch 吞掉 →
 *   悬浮按钮永远挂不上，而日志里一个字都没有。语法检查、自检、四个测试套件
 *   全都没发现，因为它躺在一条平时不执行的路径上（只有真去挂按钮时才跑）。
 *
 * 做法（够用就好，不追求完整语义）：
 *   1. 自己写个极简 tokenizer（字符串/模板/注释/正则/标识符/数字/标点）；
 *   2. 收集"声明过"的名字：function 名与形参、const/let/var 绑定、
 *      catch(e)、class 名、箭头函数形参；
 *   3. 扫描"调用位置"（`name(` 且前面不是 `.` / `?.`）；
 *   4. 报出既没声明、也不在内置白名单里的名字。
 *
 * 用法：node tools/check-refs.mjs [文件]   （退出码 1 = 有不认识的标识符）
 */

import fs from "node:fs";
import path from "node:path";

const target = process.argv[2]
  || path.resolve(import.meta.dirname, "..", "build", "stage", "chrome", "content", "scripts", "bilingual.js");

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "try", "catch", "finally", "throw", "var", "let",
  "const", "function", "class", "new", "delete", "typeof", "instanceof", "in",
  "of", "void", "yield", "await", "async", "this", "super", "null", "undefined",
  "true", "false", "export", "import", "extends", "static", "get", "set",
]);

/**
 * "沙箱里确实没有、但代码用 typeof / try-catch 兜住"的全局。
 * 这些不算错误，只单独提示，方便人工确认兜底还在。
 */
const GUARDED_GLOBALS = new Set([
  "AbortController", "AbortSignal", "DOMException", "CompressionStream",
  "Response", "DecompressionStream", "ReadableStream",
]);
const GLOBALS = new Set([
  // 标准 JS
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math",
  "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "unescape", "escape", "structuredClone", "Intl",
  "ArrayBuffer", "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array",
  "Int16Array", "Int32Array", "Float32Array", "Float64Array", "DataView",
  "TextEncoder", "TextDecoder",
  // Gecko / 插件沙箱
  "Zotero", "Services", "ChromeUtils", "IOUtils", "PathUtils", "Localization",
  "XMLSerializer", "DOMParser", "XMLHttpRequest", "File", "FileReader", "Blob",
  "URL", "URLSearchParams", "fetch", "atob", "btoa", "crypto", "CSS",
  "Worker", "ChromeWorker", "MutationObserver", "Event", "CustomEvent",
  "Element", "HTMLElement", "Node", "NodeFilter", "DocumentFragment",
  "getComputedStyle", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "requestIdleCallback", "cancelIdleCallback",
  "requestAnimationFrame", "cancelAnimationFrame", "alert", "confirm",
  "prompt", "isSecureContext",
  // 浏览器对象（沙箱里有一部分）
  "navigator", "window", "document", "console", "location", "history",
  "performance", "screen", "parent", "top", "self", "globalThis",
]);

/* ------------------------------- tokenizer ------------------------------- */

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const prevSignificant = () => (out.length ? out[out.length - 1] : null);
  let start = 0;
  /** 每个 token 都带上起始偏移，方便报错时定位到源码行 */
  const push = (type, value) => out.push({ type, value, pos: start });

  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);

  /** 上一个有效 token 决定 `/` 是除号还是正则开头 */
  const regexAllowed = () => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.type === "punct") return p.value !== ")" && p.value !== "]";
    if (p.type === "id") return KEYWORDS.has(p.value) && p.value !== "this";
    return false;
  };

  while (i < n) {
    start = i;
    const c = src[i];

    // 空白
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }

    // 注释
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // 字符串
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      push("str");
      continue;
    }

    // 模板字符串（${...} 里也有代码，但本文件里全是 CSS，整体跳过）
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === "}") {
          depth--;
          i++;
          continue;
        }
        if (depth === 0 && src[i] === "`") {
          i++;
          break;
        }
        i++;
      }
      push("str");
      continue;
    }

    // 正则字面量
    if (c === "/" && regexAllowed()) {
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") {
          while (i < n && src[i] !== "]") {
            if (src[i] === "\\") i++;
            i++;
          }
        }
        if (src[i] === "/") {
          i++;
          closed = true;
          break;
        }
        if (src[i] === "\n") break;
        i++;
      }
      if (closed) {
        while (i < n && /[gimsuyvd]/.test(src[i])) i++;
      }
      push("regex");
      continue;
    }

    // 标识符
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      push("id", src.slice(i, j));
      i = j;
      continue;
    }

    // 数字
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX._oObBeE]/.test(src[j])) j++;
      push("num");
      i = j;
      continue;
    }

    // 多字符标点
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === "===" || three === "!==" || three === "...") {
      push("punct", three);
      i += 3;
      continue;
    }
    if (two === "=>" || two === "?." || two === "==" || two === "!="
      || two === "<=" || two === ">=" || two === "&&" || two === "||"
      || two === "??" || two === "++" || two === "--" || two === "+="
      || two === "-=" || two === "*=" || two === "/=" || two === "**") {
      push("punct", two);
      i += 2;
      continue;
    }
    push("punct", c);
    i++;
  }
  return out;
}

/* ------------------------------- 分析 ------------------------------- */

const srcText = fs.readFileSync(target, "utf8");
const tokens = tokenize(srcText);
const declared = new Set(KEYWORDS);
/** name -> 第一次被当成"声明"的位置（排查误判用） */
const whyDeclared = new Map();
const mark = (name, pos, site) => {
  declared.add(name);
  if (!whyDeclared.has(name)) whyDeclared.set(name, { pos: pos ?? 0, site: site || "?" });
};

const isPunct = (t, v) => t && t.type === "punct" && t.value === v;
const isId = (t) => t && t.type === "id";

/** 从 start（指向 "("）找到配对的 ")" */
function matchParen(start) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "punct") continue;
    if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把一段 token 区间里的所有标识符都当声明（形参/解构都这么处理） */
function declareRange(from, to) {
  for (let i = from; i <= to && i < tokens.length; i++) {
    if (isId(tokens[i]) && !KEYWORDS.has(tokens[i].value)) mark(tokens[i].value, tokens[i].pos, "形参区间");
  }
}

/**
 * 对象字面量 / class 里的简写方法 `name(a, b) { ... }` 也算声明。
 * 判据：`name(` 配对 `)` 之后紧跟 `{` —— 合法的调用后面不可能直接跟块。
 * （if/for/while/switch/catch/function 都是关键字，前面已经排除）
 */
function collectShorthandMethods() {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isId(t) || KEYWORDS.has(t.value)) continue;
    if (!isPunct(tokens[i + 1], "(")) continue;
    const end = matchParen(i + 1);
    if (end < 0 || !isPunct(tokens[end + 1], "{")) continue;
    mark(t.value, t.pos, "简写方法");
  }
}

collectShorthandMethods();

for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i];
  if (!isId(t)) continue;

  // function name(params)
  if (t.value === "function") {
    let j = i + 1;
    if (isId(tokens[j])) {
      mark(tokens[j].value, tokens[j].pos, "函数名");
      j++;
    }
    if (isPunct(tokens[j], "(")) {
      const end = matchParen(j);
      if (end > 0) declareRange(j + 1, end - 1);
    }
    continue;
  }

  // class Name
  if (t.value === "class" && isId(tokens[i + 1])) {
    mark(tokens[i + 1].value, tokens[i + 1].pos, "类名");
    continue;
  }

  // catch (e)
  if (t.value === "catch" && isPunct(tokens[i + 1], "(")) {
    const end = matchParen(i + 1);
    if (end > 0) declareRange(i + 2, end - 1);
    continue;
  }

  // const/let/var 绑定
  if (t.value === "const" || t.value === "let" || t.value === "var") {
    let depth = 0;
    // 语句结尾的兜底：插件代码基本都写分号，但万一有 ASI 的写法，
    // 没有这道闸门会一路扫到下一个分号（甚至扫到文件末尾），
    // 把整段代码里的标识符全当成"声明过"——那就几乎查不出任何问题了。
    const STMT_STOP = new Set([
      "const", "let", "var", "function", "class", "return", "if", "for",
      "while", "do", "try", "catch", "switch", "throw", "else", "export",
      "import", "break", "continue",
    ]);
    let steps = 0;
    for (let j = i + 1; j < tokens.length && steps < 500; j++, steps++) {
      const u = tokens[j];
      if (u.type === "punct") {
        if (u.value === "{" || u.value === "[" || u.value === "(") depth++;
        else if (u.value === "}" || u.value === "]" || u.value === ")") {
          depth--;
          if (depth < 0) break; // 越过了声明所在的那层括号 → 收尾
        }
        else if (depth === 0 && u.value === ";") break;
        else if (depth === 0 && u.value === "=") {
          // 跳过初始化表达式，直到同一层的 "," 或 ";" 或新语句开头
          let d2 = 0;
          let steps2 = 0;
          for (j++; j < tokens.length && steps2 < 500; j++, steps2++) {
            const v = tokens[j];
            if (v.type === "id" && d2 === 0 && STMT_STOP.has(v.value)) {
              j--;
              break;
            }
            if (v.type !== "punct") continue;
            if (v.value === "(" || v.value === "[" || v.value === "{") d2++;
            else if (v.value === ")" || v.value === "]" || v.value === "}") {
              d2--;
              if (d2 < 0) {
                j--;
                break;
              }
            }
            else if (d2 === 0 && (v.value === "," || v.value === ";")) break;
          }
          if (j < tokens.length && isPunct(tokens[j], ",")) continue;
          break;
        }
      }
      else if (u.type === "id" && depth === 0 && STMT_STOP.has(u.value)) {
        break;
      }
      // 解构的东西（`const { doc, append } = event`）在花括号里，depth > 0，
      // 所以这里**不能**用 depth === 0 过滤：走到这一步的一定还在绑定模式里
      // （初始化表达式已经被下面的逻辑整段跳过了）。
      if (isId(u) && !KEYWORDS.has(u.value)) mark(u.value, u.pos, "const绑定");
    }
    continue;
  }
}

// 箭头函数形参
for (let i = 0; i < tokens.length; i++) {
  if (!isPunct(tokens[i], "=>")) continue;
  const prev = tokens[i - 1];
  if (isId(prev) && !KEYWORDS.has(prev.value)) {
    mark(prev.value, prev.pos, "箭头单参");
    continue;
  }
  if (isPunct(prev, ")")) {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      const u = tokens[j];
      if (u.type !== "punct") continue;
      if (u.value === ")") depth++;
      else if (u.value === "(") {
        depth--;
        if (depth === 0) {
          declareRange(j + 1, i - 2);
          break;
        }
      }
    }
  }
}

/* ------------------------------- 报告 ------------------------------- */

if (process.env.WHY) {
  for (const nm of process.env.WHY.split(",")) {
    console.log(`WHY ${nm}: declared=${declared.has(nm)} global=${GLOBALS.has(nm)} guarded=${GUARDED_GLOBALS.has(nm)}${whyDeclared.has(nm) ? "  ← [" + whyDeclared.get(nm).site + "] " + locate(whyDeclared.get(nm).pos) : ""}`);
  }
}

const problems = [];
const guardedHits = [];
for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i];
  if (!isId(t)) continue;
  if (!isPunct(tokens[i + 1], "(")) continue;
  const prev = tokens[i - 1];
  if (isPunct(prev, ".") || isPunct(prev, "?.")) continue; // 成员调用
  if (prev && isId(prev) && (prev.value === "function" || prev.value === "class")) continue;
  if (KEYWORDS.has(t.value)) continue;
  if (declared.has(t.value) || GLOBALS.has(t.value)) continue;
  if (GUARDED_GLOBALS.has(t.value)) {
    guardedHits.push({ name: t.value, pos: t.pos ?? 0 });
    continue;
  }
  problems.push({ name: t.value, pos: t.pos ?? 0 });
}

const seen = new Set();
const uniq = problems.filter((p) => {
  if (seen.has(p.name)) return false;
  seen.add(p.name);
  return true;
});

/** 偏移 → "第 N 行：源码" */
function locate(pos) {
  let line = 1;
  for (let i = 0; i < pos && i < srcText.length; i++) {
    if (srcText[i] === "\n") line++;
  }
  const lineStart = srcText.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = srcText.indexOf("\n", pos);
  if (lineEnd < 0) lineEnd = srcText.length;
  const text = srcText.slice(lineStart, lineEnd).trim().slice(0, 110);
  return `第 ${line} 行：${text}`;
}

console.log(`检查 ${path.relative(process.cwd(), target)}：${tokens.length} 个 token，`
  + `收集到 ${declared.size} 个已声明名字`);

if (guardedHits.length) {
  const names = [...new Set(guardedHits.map((h) => h.name))];
  console.log(`\nℹ️  ${names.length} 个"沙箱里没有、靠 typeof 兜住"的全局（不计为错误）：`);
  for (const h of guardedHits) {
    console.log(`  - ${h.name}  ← ${locate(h.pos)}`);
  }
}

if (!uniq.length) {
  console.log("\n✅ 没有发现未声明的调用目标");
  process.exit(0);
}

console.log(`\n❌ 发现 ${uniq.length} 个"调用了但没定义"的名字：`);
for (const p of uniq) {
  console.log(`  - ${p.name}  ← ${locate(p.pos)}`);
}
process.exit(1);
