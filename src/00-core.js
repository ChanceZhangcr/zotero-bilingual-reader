/* eslint-env mozilla */
/**
 * Bilingual Paper Reader — 主命名空间
 * 本文件必须第一个加载：它建立命名空间与通用工具。
 *
 * ⚠️ 作用域要点（踩过的坑）：
 * bootstrap 用 loadSubScript 把脚本注入插件沙箱。沙箱里：
 *   - `Zotero` 是 Zotero.Plugins 用 Object.assign 塞进来的**独立对象**，
 *     往沙箱全局写属性**不会**变成 `Zotero.xxx`；
 *   - 所以 bootstrap 读的是 `Zotero.Bilingual`，这里必须显式挂上去；
 *   - 顶层声明一律用 `var`：顶层 const 是不可删除的词法绑定，
 *     同一沙箱二次 loadSubScript 会抛 "redeclaration of const"。
 */

var BILINGUAL_PLUGIN_ID = "bilingual-reader@local.plugin";
var BILINGUAL_PREFS_PREFIX = "extensions.zotero.bilingualReader";
var BILINGUAL_PANEL_ID = "bilingual-translation-panel";

if (typeof __bilingualNS === "undefined") {
  var ns = {};
  const g = (() => {
    try {
      if (typeof globalThis !== "undefined" && globalThis) return globalThis;
    } catch (e) {}
    try {
      if (typeof window !== "undefined" && window) return window;
    } catch (e) {}
    return this;
  })();
  g.__bilingualNS = ns;
  g.Bilingual = ns;
}

var Bilingual = __bilingualNS;
Bilingual.id = BILINGUAL_PLUGIN_ID;
Bilingual.prefsPrefix = BILINGUAL_PREFS_PREFIX;
Bilingual.modules = Bilingual.modules || {};

/**
 * 字节工具。
 * 说明：01-ttf.js / 02-pdf.js 是先在 Node 里用 fontTools + FreeType + PyMuPDF
 * 逐字节验证过、再移植到沙箱的，那两个文件会自带命名空间。
 * 但**单独**运行 00-core.js（比如单元自检）时那两个文件可能没加载，
 * 所以这里补一份等价实现，两边接口保持一致。
 */
Bilingual.tools = Bilingual.tools || {};
Bilingual.tools.bytes = Bilingual.tools.bytes || {
  view(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  },
  alloc(n) {
    return new Uint8Array(n);
  },
  concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  },
  fromLatin1(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  },
  toLatin1(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  },
  /** UTF-8 编码（导出 HTML 用） */
  encode(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    const utf8 = unescape(encodeURIComponent(str));
    const out = new Uint8Array(utf8.length);
    for (let i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
    return out;
  },
};

/* 关键：bootstrap.js 只认 Zotero.Bilingual */
try {
  Zotero.Bilingual = Bilingual;
}
catch (e) {
  // 极端情况下 Zotero 还没就绪，bootstrap 有 ctx 兜底
}

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/** utils.log 的去重状态：同一句话一秒内只写一次诊断日志 */
var lastLogMessage = "";
var lastLogAt = 0;

Bilingual.utils = {
  /**
   * 读写插件自己的 pref。
   * ⚠️ 必须传 global=true：不传的话 Zotero.Prefs 会自动加
   * `extensions.zotero.` 前缀，于是键变成 extensions.zotero.extensions.bilingualReader.*，
   * 根目录 prefs.js 里的默认值全部作废。
   * Zotero 9.0.5 的 Zotero.Prefs.get 是**同步**的（prefs.js: `function get(pref, global)`）。
   */
  getPref(key, fallback) {
    const full = `${BILINGUAL_PREFS_PREFIX}.${key}`;
    try {
      const v = Zotero.Prefs.get(full, true);
      return typeof v === "undefined" || v === null ? fallback : v;
    }
    catch (e) {
      return fallback;
    }
  },

  setPref(key, value) {
    const full = `${BILINGUAL_PREFS_PREFIX}.${key}`;
    try {
      Zotero.Prefs.set(full, value, true);
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  debug(...args) {
    if (Bilingual.utils.getPref("debug", false)) {
      Zotero.debug(`[Bilingual] ${args.join(" ")}`);
    }
  },

  /** 统一的日志（不依赖 debug 开关，出错时用） */
  log(...args) {
    let msg = "";
    try {
      msg = args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ");
    }
    catch (e) {
      msg = "(日志参数无法序列化)";
    }
    Zotero.debug(`[Bilingual] ${msg}`);
    // 同时写进诊断日志文件。
    // 以前这里只走 Zotero.debug（控制台），导致"函数未定义被 catch 吞掉"
    // 这类静默失败在文件日志里一点痕迹都没有 —— 排查时完全瞎猜。
    try {
      const w = Bilingual.logWriter;
      if (!w) return;
      // 热路径（滚动同步之类）同一句话一秒内只记一次
      const now = Date.now();
      if (msg === lastLogMessage && now - lastLogAt < 1000) return;
      lastLogMessage = msg;
      lastLogAt = now;
      w.writeSync(msg);
    }
    catch (e) {}
  },

  /** 项目数据目录（用来放译文缓存），不存在则创建 */
  async getDataDirectory() {
    let dir = null;
    try {
      // 注意：数据目录未初始化时这个 getter 会抛，必须包在 try 里
      const base = Zotero.DataDirectory?.dir;
      if (base) dir = PathUtils.join(base, "bilingual-reader");
    }
    catch (e) {
      return null;
    }
    if (!dir) return null;
    try {
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      return dir;
    }
    catch (e) {
      Zotero.logError(e);
      return null;
    }
  },

  /** 稳定字符串哈希（FNV-1a 32bit，双通道降低碰撞） */
  hash(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return h1.toString(36) + "-" + h2.toString(36) + "-" + str.length.toString(36);
  },

  /** 当前活动阅读器（Zotero 9 没有 Reader.getActiveReader，只能自己扫） */
  getActiveReader() {
    try {
      const readers = Zotero.Reader?._readers;
      if (!readers || !readers.length) return null;
      const win = Zotero.getMainWindow();
      const tabID = win?.Zotero_Tabs?.selectedID;
      for (let i = readers.length - 1; i >= 0; i--) {
        const r = readers[i];
        if (tabID && r.tabID === tabID) return r;
      }
      // 阅读器独立窗口
      const focused = Services.wm.getMostRecentWindow("zotero:reader");
      if (focused) {
        for (const r of readers) {
          if (r._window === focused) return r;
        }
      }
      return readers[readers.length - 1] || null;
    }
    catch (e) {
      Zotero.logError(e);
      return null;
    }
  },

  /** 等待 reader 内部 iframe 就绪 */
  async waitForReaderReady(reader, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (reader?._iframeWindow?.document?.getElementById("split-view")) {
          return true;
        }
      }
      catch (e) {}
      await Zotero.Promise.delay(120);
    }
    return false;
  },

  /**
   * 把 PDF 抽出的文本按"段落 / 换行"还原成翻译单元。
   *
   * 背景（实测）：Zotero 的 PDF 文字层里换行既可能是"段落结束"，也可能只是
   * "排版换行"，而且一页里常常一个大段都没有空行。所以不能简单按空行切，
   * 也不能简单把换行都当段落 —— 那会得到 4000+ 字符的巨块。
   *
   * 策略：
   *   1. 连字符断词（"explain-\nability" → "explainability"）先接回去；
   *   2. 普通换行一律接成空格；
   *   3. 在"看起来像段落起点"的行前断开：上一行以句末标点收尾，
   *      且当前行以大写字母/数字开头。
   */
  splitParagraphs(text) {
    const raw = String(text || "").replace(/\r\n?/g, "\n");
    const lines = raw.split("\n");
    const units = [];
    let buf = "";

    const push = (s) => {
      const t = s.replace(/\s+/g, " ").trim();
      if (t) units.push(t);
    };

    /** 这一行是不是"短标题"（全大写、词少），如 GENERAL ARTICLE / Abstract */
    const isHeading = (s) => {
      const t = s.trim();
      if (!t || t.length > 80) return false;
      // 只有真正的标点才算"句子内容"，数字/斜杠结尾的页眉不算
      if (/[.!?,;:"'”’)\]]$/.test(t)) return false;
      const words = t.split(/\s+/).filter(Boolean);
      const letters = t.replace(/[^A-Za-z]/g, "");
      if (!letters) return false;
      const upperRatio = letters.replace(/[^A-Z]/g, "").length / letters.length;
      return words.length <= 8 && upperRatio > 0.7;
    };

    /** 上一行结束后，当前行是否应该另起一块 */
    const startsNewBlock = (prev, cur) => {
      if (!prev) return false;
      const p = prev.trimEnd();
      const c = cur.trimStart();
      if (!c) return true; // 空行必断
      // 当前行本身是短标题（"GENERAL ARTICLE"、"Abstract"）→ 它一定属于新块，
      // 因为标题前面不会是正文的续行。
      if (isHeading(c)) return true;
      // 上一行是短标题（"Abstract" 后面跟正文）→ 正文另起一块
      if (isHeading(p)) return true;
      // 上一行以句末标点收尾 + 当前行大写开头 → 新段落。
      // 注意顺序：这条必须放在两条标题判定之后，因为页眉常以数字结尾
      // （"…Minds and Machines 1 3"），会让 /[.!?]$/ 误判成句子结束。
      if (/[.!?]["'”’)\]]?$/.test(p) && /^["'“'(]?[A-Z0-9]/.test(c) && p.length > 20) {
        return true;
      }
      return false;
    };

    for (const line of lines) {
      if (!line.trim()) {
        // 空行：收束当前块（无论它有没有句末标点，都不能丢）
        push(buf);
        buf = "";
        continue;
      }
      const t = line.trim();
      if (!buf) {
        buf = t;
        continue;
      }
      // 连字符断词接回
      if (buf.endsWith("-") && /^[a-z]/.test(t)) {
        buf = buf.slice(0, -1) + t;
        continue;
      }
      if (startsNewBlock(buf, t)) {
        push(buf);
        buf = t;
        continue;
      }
      buf = buf + " " + t;
    }
    push(buf);
    return units;
  },

  /**
   * 把一个超长（或恰好没有段落边界）的文本块，切成不超过 maxChars 的单元，
   * 优先在句末切开，保证不丢内容、不产生无法翻译的巨块。
   */
  splitLongBlock(text, maxChars = 4500) {
    const t = String(text || "").trim();
    if (!t) return [];
    if (t.length <= maxChars) return [t];
    const sentences = t.match(/[^.!?]+[.!?]+["'”’)\]]*\s*|[^.!?]+$/g) || [t];
    const out = [];
    let buf = "";
    for (const s of sentences) {
      if (s.length > maxChars) {
        if (buf) {
          out.push(buf.trim());
          buf = "";
        }
        let rest = s;
        while (rest.length > maxChars) {
          let cut = rest.lastIndexOf(",", maxChars);
          if (cut < maxChars * 0.5) cut = rest.lastIndexOf(" ", maxChars);
          if (cut <= 0) cut = maxChars;
          out.push(rest.slice(0, cut + 1).trim());
          rest = rest.slice(cut + 1);
        }
        buf = rest;
        continue;
      }
      if (buf.length + s.length > maxChars && buf) {
        out.push(buf.trim());
        buf = s;
      }
      else {
        buf += s;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  },

  /** 判断是否值得翻译（过滤页码、纯数字、纯符号） */
  isTranslatable(paragraph) {
    const t = paragraph.trim();
    if (!t) return false;
    if (t.length < 2) return false;
    if (!/[A-Za-z\u00C0-\u024F]/.test(t)) return false;
    if (/^[\d\s\-–—.,;:()\[\]\/]+$/.test(t)) return false;
    return true;
  },

  /** 生成一个用于 DOM 的 id */
  uid(prefix = "bilingual") {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  },
};

/* ------------------------------------------------------------------ *
 * AbortController 垫片
 *
 * ⚠️ Zotero 的插件沙箱（plugins.js 的 _loadScope）用
 * `wantGlobalProperties` 白名单暴露全局，里面**没有 AbortController**
 * （有的是 atob/btoa/Blob/crypto/CSS/ChromeUtils/DOMParser/fetch/File/
 *   FileReader/TextDecoder/TextEncoder/URL/URLSearchParams/XMLHttpRequest）。
 * 代码里 new AbortController() 会直接抛
 * "AbortController is not defined"，而且是在 try 里被吞掉、只留一句
 * 界面提示 —— 这个坑踩过。
 *
 * 插件里只需要两件事：signal.aborted 与 signal.addEventListener('abort')。
 * 所以自己实现一个最小版本即可（也在 XHR 的 requestObserver 里用）。
 * ------------------------------------------------------------------ */

if (typeof AbortController === "undefined") {
  var AbortSignalShim = class {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this._listeners = new Set();
      this.onabort = null;
    }

    addEventListener(type, fn) {
      if (type === "abort" && typeof fn === "function") this._listeners.add(fn);
    }

    removeEventListener(type, fn) {
      if (type === "abort") this._listeners.delete(fn);
    }

    _fire() {
      const ev = { type: "abort", target: this };
      try {
        if (typeof this.onabort === "function") this.onabort(ev);
      }
      catch (e) {}
      for (const fn of Array.from(this._listeners)) {
        try {
          fn(ev);
        }
        catch (e) {}
      }
      this._listeners.clear();
    }
  };

  var AbortControllerShim = class {
    constructor() {
      this.signal = new AbortSignalShim();
    }

    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      this.signal._fire();
    }
  };

  try {
    globalThis.AbortController = AbortControllerShim;
    globalThis.AbortSignal = AbortSignalShim;
  }
  catch (e) {}
  try {
    this.AbortController = AbortControllerShim;
  }
  catch (e) {}
}

/**
 * 安全地造一个"已中止"错误。
 * DOMException 同样不在沙箱白名单里；找不到时退回普通 Error，
 * 但**必须把 name 设成 AbortError** —— 上层靠 `e.name === 'AbortError'`
 * 判断"是用户点了停止"而不是真失败。
 */
function makeAbortError(message = "aborted") {
  try {
    if (typeof DOMException !== "undefined") {
      return new DOMException(message, "AbortError");
    }
  }
  catch (e) {}
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/* ------------------------------------------------------------------ *
 * 兜底：把未处理的 Promise 拒绝写进诊断日志。
 * 这个 bug 就这么漏过一次 —— 浮动 Promise 里的异常被静默吞掉，
 * 界面既没提示、按钮还停在「停止」，完全无从排查。
 * ------------------------------------------------------------------ */

try {
  const g = (() => {
    try {
      return typeof globalThis !== "undefined" ? globalThis : this;
    }
    catch (e) {
      return null;
    }
  })();
  if (g && typeof g.addEventListener === "function" && !g.__bilingualRejectionHook) {
    g.__bilingualRejectionHook = true;
    g.addEventListener("unhandledrejection", (ev) => {
      try {
        const r = ev?.reason;
        Bilingual.logWriter?.write(
          `未处理的 Promise 拒绝: ${r && r.stack ? r.stack : r}`,
        );
        Zotero.debug(`[Bilingual] 未处理的 Promise 拒绝: ${r && r.stack ? r.stack : r}`);
      }
      catch (e) {}
    });
  }
}
catch (e) {}

/* ------------------------------------------------------------------ *
 * 诊断日志：除了 Zotero 的调试输出，再往数据目录写一份纯文本日志。
 * 用户只要把 <Zotero 数据目录>\bilingual-reader\diagnostic.log 发过来，
 * 就能看到插件每个环节跑到哪一步、哪个接口不可用。
 * ------------------------------------------------------------------ */

Bilingual.logWriter = (() => {
  let queue = [];
  let flushing = false;
  let initPromise = null;
  let filePath = null;
  let allLines = []; // 内存里保留全量，落盘时整份重写（避免 append 选项在不同版本上行为不一）

  /** 去掉时间戳，用来判断"是不是同一句话" */
  const bare = (s) => String(s || "").replace(/^\[[^\]]*\]\s*/, "");

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const dir = await Bilingual.utils.getDataDirectory();
        if (!dir) return;
        filePath = PathUtils.join(dir, "diagnostic.log");
        // 每次启动清空重写，避免日志无限增长
        allLines = [`=== 双语论文助手 v${Bilingual.version || "?"} @ ${new Date().toISOString()} ===`];
        await writeAll();
      }
      catch (e) {
        filePath = null;
      }
    })();
    return initPromise;
  }

  async function writeAll() {
    if (!filePath) return;
    try {
      // ⚠️ 不用 { append: true } —— 它在不同 Zotero 版本上表现不一致，
      // 曾经导致日志只剩最后一行（排查时完全没用）。
      // 这里整份重写：日志量小（几十行），代价可以忽略。
      await IOUtils.writeUTF8(filePath, allLines.join("\n") + "\n");
    }
    catch (e) {}
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const batch = queue;
        queue = [];
        for (const l of batch) allLines.push(l);
      }
      if (allLines.length > 2000) allLines = allLines.slice(-1500);
      await writeAll();
    }
    catch (e) {}
    flushing = false;
  }

  return {
    async write(line) {
      try {
        await init();
        queue.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
        await flush();
      }
      catch (e) {}
    },
    async path() {
      await init();
      return filePath;
    },
    /** 同步塞入（不等待落盘）—— 给不能 await 的地方用 */
    writeSync(line) {
      try {
        // 同一句话连着记两遍没意义（调用方常常既 utils.log 又 writeSync）
        const prev = queue.length ? queue[queue.length - 1] : allLines[allLines.length - 1];
        if (prev && bare(prev) === bare(line)) return;
      }
      catch (e) {}
      queue.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
      init().then(() => flush()).catch(() => {});
    },
  };
})();
