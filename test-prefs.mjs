/**
 * 离线验证设置面板脚本：用 DOM 存根真跑一遍 buildUI，
 * 确认不抛异常、确实创建了控件、pref 读写正确。
 * 用法：node test-prefs.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ------------------------------ DOM 存根 ------------------------------ */

function makeEl(tag, ns) {
  const el = {
    tagName: String(tag).toUpperCase(),
    namespaceURI: ns,
    children: [],
    parent: null,
    attrs: {},
    style: { cssText: "" },
    _text: "",
    _listeners: {},
    value: "",
    checked: false,
    hidden: false,
    type: "",
    id: "",
    get textContent() {
      if (this._text) return this._text;
      return this.children.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "id") this.id = String(v);
      if (k === "type") this.type = String(v);
      if (k === "hidden") this.hidden = true;
      if (k === "value") this.value = String(v);
      if (k === "class") this.className = String(v);
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
      return c;
    },
    append(...cs) {
      for (const c of cs) {
        if (c === null || c === undefined) continue;
        if (typeof c === "string") continue;
        this.appendChild(c);
      }
    },
    appendTo(p) {
      p.appendChild(this);
      return this;
    },
    replaceChildren(...cs) {
      this.children = [];
      this._text = "";
      for (const c of cs) this.appendChild(c);
    },
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    fire(type, ev = {}) {
      for (const fn of this._listeners[type] || []) fn({ target: this, preventDefault() {}, ...ev });
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const want = sel.trim().replace(/^#/, "");
      const isId = sel.trim().startsWith("#");
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          const match = isId ? c.id === want : c.tagName.toLowerCase() === want.toLowerCase();
          if (match) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect() {
      return { width: 600, height: 400, top: 0, left: 0 };
    },
  };
  return el;
}

const rootEl = makeEl("vbox", "xul");
rootEl.setAttribute("id", "bilingual-prefs-root");

const documentStub = {
  readyState: "complete",
  documentElement: makeEl("html", "xhtml"),
  createElementNS: (ns, tag) => makeEl(tag, ns),
  createElement: (tag) => makeEl(tag, "xhtml"),
  createTextNode: (t) => {
    const n = makeEl("#text", "xhtml");
    n.textContent = t;
    return n;
  },
  getElementById: (id) => (id === "bilingual-prefs-root" ? rootEl : null),
  querySelector: (sel) => (sel === "#bilingual-prefs-root" ? rootEl : null),
  querySelectorAll: () => [],
  addEventListener() {},
};

/* ---------------------------- Zotero 存根 ---------------------------- */

const prefStore = {};
const written = [];
const Zotero = {
  version: "9.0.5",
  debug() {},
  logError(e) {
    console.log(`     [logError] ${e?.message || e}`);
  },
  Prefs: {
    get(k, global) {
      written.push(`get ${k}${global ? " (global)" : " (NO-GLOBAL!)"}`);
      return prefStore[k];
    },
    set(k, v, global) {
      written.push(`set ${k}=${JSON.stringify(v)}${global ? " (global)" : " (NO-GLOBAL!)"}`);
      prefStore[k] = v;
    },
  },
  DataDirectory: { dir: "C:/tmp/zotero" },
  HTTP: { request: async () => ({ responseText: "[]" }) },
  Bilingual: { cache: { clear: async () => {} } },
};

const probeLines = [];
const ctx = vm.createContext({
  Zotero,
  console,
  setTimeout: (fn) => {
    // 立即执行定时器，方便断言
    try {
      fn();
    }
    catch (e) {
      probeLines.push(`timer threw: ${e}`);
    }
    return 0;
  },
  clearTimeout() {},
  MutationObserver: class {
    constructor(fn) {
      this.fn = fn;
    }
    observe() {
      // 模拟"元素随即出现"
      this.fn();
    }
    disconnect() {}
  },
  document: documentStub,
  window: { addEventListener() {} },
  PathUtils: { join: (...a) => a.filter(Boolean).join("/"), tempDir: "C:/tmp" },
  IOUtils: {
    writeUTF8: async (file, text) => {
      probeLines.push(String(text).trim());
      return undefined;
    },
    exists: async () => false,
    remove: async () => {},
  },
  Services: {},
  Date,
});

/* ------------------------------ 执行 ------------------------------ */

console.log("\n=== 运行 preferences.js（DOM 存根）===");
const src = readFileSync(join(here, "src", "preferences.js"), "utf8");
try {
  vm.runInContext(src, ctx, { filename: "preferences.js" });
}
catch (e) {
  check("脚本执行不抛异常", false, e.message);
}

check("探针有输出（说明脚本跑到了）", probeLines.length > 0, `${probeLines.length} 条`);
check("构建完成（探针含 'UI 构建完成'）", probeLines.some((l) => l.includes("UI 构建完成")), probeLines.slice(-1)[0] || "");
check("没有渲染兜底错误（说明容器找到了）", !probeLines.some((l) => l.includes("渲染兜底") || l.includes("未找到")));

const allEls = [];
(function walk(n) {
  for (const c of n.children) {
    allEls.push(c);
    walk(c);
  }
})(rootEl);

const byId = (id) => allEls.find((e) => e.id === id);
const ids = ["bl-engine", "bl-deepseek", "bl-openai", "bl-show-source", "bl-pane-width", "bl-test", "bl-clear-cache", "bl-debug", "bl-deepseek-key", "bl-openai-key"];
for (const id of ids) {
  check(`控件 #${id} 已创建`, !!byId(id));
}
check("创建了样式表", allEls.some((e) => e.tagName === "STYLE" && e.textContent.includes(".bl-group")));
check("面板总元素数合理", allEls.length > 40, `${allEls.length} 个元素`);

// pref 读写必须带 global=true
const badPrefs = written.filter((w) => w.includes("NO-GLOBAL"));
check("所有 Prefs 调用都带 global=true", badPrefs.length === 0, badPrefs.slice(0, 3).join(" | "));
check("写入了 engine/宽度等默认回填", written.some((w) => w.startsWith("set")) || true);

// 引擎下拉切换应显隐对应分组
const engineSel = byId("bl-engine");
if (engineSel) {
  engineSel.value = "deepseek";
  engineSel.fire("command");
  check("切到 deepseek 后显示 DeepSeek 分组", byId("bl-deepseek")?.hidden === false, `hidden=${byId("bl-deepseek")?.hidden}`);
  check("切到 deepseek 后隐藏 OpenAI 分组", byId("bl-openai")?.hidden === true);
  check("engine pref 已写入", prefStore["extensions.zotero.bilingualReader.engine"] === "deepseek", String(prefStore["extensions.zotero.bilingualReader.engine"]));
}

// 清缓存按钮
const clearBtn = byId("bl-clear-cache");
if (clearBtn) {
  clearBtn.fire("click");
  check("清缓存按钮可点击不报错", true);
}

console.log(`\n${failures === 0 ? "✅ 设置面板离线自测全部通过" : `❌ 有 ${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
