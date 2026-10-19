/* eslint-env mozilla */
/**
 * 翻译引擎：免费 Google 端点（默认，无需密钥）+ 可选 LLM（DeepSeek / OpenAI / 自定义兼容端点）
 */

Bilingual.translate = (() => {
  const { utils } = Bilingual;

  /** 每次批量翻译的统计（降级次数、失败条目数），供界面提示用 */
  const stats = { failedSegments: 0, degradedChunks: 0 };
  const resetStats = () => {
    stats.failedSegments = 0;
    stats.degradedChunks = 0;
  };

  /* ----------------------------- 免费引擎 ----------------------------- */

  /**
   * 免费引擎注册表（全部**免密钥、免注册**）。
   *
   * 实测数据（本机国内家宽，2026-10，单段约 100 字符）：
   *   腾讯交互翻译 0.2~0.5s，支持一次 30 段批量，连发 12 次 0 失败  → 默认
   *   有道翻译     0.1s，但限流极严：隔 1.2 秒连发 10 次挂 8 次，且 >800 字符返回空
   *   MyMemory     1.0~1.4s，匿名额度约每天 1000 词
   *   Google       clients5 端点在国内需要代理，实测首次 32s+
   *
   * 接口约定：`translate(texts, signal) -> Promise<string[]>`，返回等长数组。
   * batch=true 的引擎原生支持数组；batch=false 的引擎用 ⟨n⟩ 标记拼成一次请求。
   */
  const FREE_ENGINES = {
    tencent: {
      id: "tencent",
      label: "腾讯交互翻译（国内直连 · 免密钥 · 推荐）",
      short: "腾讯",
      batch: true,
      maxItems: 30, // 实测 30 条 OK；60 条直接返回空数组
      maxChars: 3000, // 单条 6000 字符也能翻，留一半余量
      async translate(texts, signal) {
        const payload = {
          header: {
            fn: "auto_translation",
            client_key: "browser-chrome-110.0.0",
            client_type: "web",
            session_id: "bilingual-reader",
            user_id: "bilingual-reader",
          },
          type: "plain",
          model_category: "normal",
          source: { lang: "en", text_list: texts },
          target: { lang: "zh" },
        };
        const xhr = await request("POST", "https://transmart.qq.com/api/imt", {
          responseType: "text",
          timeout: 60000,
          // ⚠️ 只发 Content-Type：Referer / Origin / User-Agent 都是 Gecko 的
          // "禁用请求头"，XHR 的 setRequestHeader 会静默忽略，写上去只是误导。
          // 实测这两个端点不带 Referer/Origin 也照样返回。
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          successCodes: [200],
        }, signal);
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        }
        catch (e) {
          throw new Error(`腾讯翻译返回了非 JSON 内容：${String(xhr.responseText).slice(0, 120)}`);
        }
        const arr = data?.auto_translation;
        if (!Array.isArray(arr)) {
          const msg = data?.header?.message || JSON.stringify(data).slice(0, 160);
          throw new Error(`腾讯翻译返回异常：${msg}`);
        }
        return arr.map((s) => (typeof s === "string" ? s : String(s ?? "")));
      },
    },

    youdao: {
      id: "youdao",
      label: "有道翻译（国内直连 · 免密钥 · 短文本快）",
      short: "有道",
      batch: false,
      maxItems: 0,
      maxChars: 500, // 实测 >800 字符直接返回空
      async translateOne(text, signal) {
        const url = "https://aidemo.youdao.com/trans?"
          + `q=${encodeURIComponent(text)}&from=en&to=zh-CHS`;
        const xhr = await request("GET", url, {
          responseType: "text",
          timeout: 30000,
          // 同上：只发非禁用头
          headers: { Accept: "application/json,text/plain,*/*" },
          successCodes: [200],
        }, signal);
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        }
        catch (e) {
          throw new Error(`有道翻译返回了非 JSON 内容：${String(xhr.responseText).slice(0, 120)}`);
        }
        const arr = data?.translation;
        const first = Array.isArray(arr) ? arr[0] : arr;
        // ⚠️ 有道超长/被限流时返回空字符串而不是报错，这里必须当成失败
        if (typeof first !== "string" || !first.trim()) {
          throw new Error("有道翻译返回空译文（多半是文字太长或触发限流，稍后再试）");
        }
        return first;
      },
    },

    mymemory: {
      id: "mymemory",
      label: "MyMemory（免密钥 · 匿名每天约 1000 词）",
      short: "MyMemory",
      batch: false,
      maxItems: 0,
      maxChars: 500,
      async translateOne(text, signal) {
        const url = "https://api.mymemory.translated.net/get?"
          + `q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
        const xhr = await request("GET", url, {
          responseType: "text",
          timeout: 30000,
          headers: { Accept: "application/json" },
          successCodes: [200],
        }, signal);
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        }
        catch (e) {
          throw new Error(`MyMemory 返回了非 JSON 内容：${String(xhr.responseText).slice(0, 120)}`);
        }
        const t = data?.responseData?.translatedText;
        if (typeof t !== "string" || !t.trim()) {
          const msg = data?.responseDetails || "空译文";
          throw new Error(`MyMemory 翻译失败：${String(msg).slice(0, 120)}`);
        }
        return t;
      },
    },

    google: {
      id: "google",
      label: "Google 翻译（clients5 端点 · 国内需代理 · 较慢）",
      short: "Google",
      batch: false,
      maxItems: 0,
      maxChars: 1200,
      async translateOne(text, signal) {
        const url = "https://clients5.google.com/translate_a/t?"
          + `client=dict-chrome-ex&sl=en&tl=zh-CN&q=${encodeURIComponent(text)}`;
        const xhr = await request("GET", url, {
          responseType: "text",
          timeout: 30000,
          headers: { Accept: "application/json,text/plain,*/*" },
          successCodes: [200],
        }, signal);
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        }
        catch (e) {
          throw new Error(`免费翻译端点返回了非 JSON 内容：${String(xhr.responseText).slice(0, 120)}`);
        }
        return flattenFreeResponse(data);
      },
    },
  };

  /** 免费引擎的尝试顺序（找不到指定引擎 / 失败降级时用） */
  const FREE_CHAIN = ["tencent", "youdao", "mymemory", "google"];

  /**
   * 当前免费引擎 id。
   * ⚠️ 老版本 pref 里的 "free" 指的就是 Google 端点；那个在国内不挂代理
   * 首次要 30 秒以上，所以统一迁移到腾讯（国内直连、支持批量）。
   */
  function currentFreeEngine() {
    const raw = String(utils.getPref("engine", "tencent") || "tencent");
    if (raw === "free") return "tencent";
    return FREE_ENGINES[raw] ? raw : "tencent";
  }

  function engineById(id) {
    return FREE_ENGINES[id] || FREE_ENGINES.tencent;
  }

  const FREE_MAX_CHARS = FREE_ENGINES.tencent.maxChars;

  function flattenFreeResponse(data) {
    if (typeof data === "string") return data;
    if (Array.isArray(data)) {
      // [["句子1","句子2"]] 或 ["句子1","句子2"]
      const flat = data.length && Array.isArray(data[0]) ? data[0] : data;
      return flat
        .map((x) => (typeof x === "string" ? x : Array.isArray(x) ? x[0] : ""))
        .filter((x) => typeof x === "string")
        .join("");
    }
    return "";
  }

  /**
   * 用某个引擎翻一批文本（块内可能多段）。
   * - 原生批量引擎：直接发数组
   * - 单条引擎：用 ⟨n⟩ 标记拼成一次请求，再按标记切回
   * 标记不可信时退回逐段（慢但不会错位）。
   */
  async function engineTranslateChunk(engine, sources, signal) {
    if (engine.batch) {
      const out = await engine.translate(sources, signal);
      if (Array.isArray(out) && out.length === sources.length
        && out.every((s) => typeof s === "string" && s.trim())) {
        return out;
      }
      throw new Error(`${engine.short} 返回条数不匹配（期望 ${sources.length}，得到 ${out?.length ?? 0}）`);
    }

    const payload = markSegments(sources);
    const translated = await engine.translateOne(payload, signal);
    const filled = splitByMarkers(String(translated), sources.length);
    if (filled) return filled;

    utils.log(`${engine.short}：编号标记不可信，改为逐段请求（${sources.length} 段）`);
    const out = [];
    for (const seg of sources) {
      if (signal?.aborted) throw makeAbortError();
      out.push(await engine.translateOne(seg, signal));
    }
    return out;
  }

  /** 带重试的一批（块）翻译；全失败时按 FREE_CHAIN 降级到别的免费引擎 */
  async function translateChunk(engine, sources, signal, tried = null) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw makeAbortError();
      try {
        return { texts: await engineTranslateChunk(engine, sources, signal), engine };
      }
      catch (e) {
        if (signal?.aborted) throw makeAbortError();
        lastErr = e;
        await Zotero.Promise.delay(400 * (attempt + 1) * (attempt + 1));
      }
    }

    // 降级：换下一个免费引擎再试（同一批内容，最多每个引擎试一次）
    const triedIds = tried || new Set([engine.id]);
    triedIds.add(engine.id);
    const next = FREE_CHAIN.find((id) => !triedIds.has(id));
    if (next && utils.getPref("freeEngineFallback", true)) {
      const alt = engineById(next);
      utils.log(`${engine.short} 连续失败，降级到 ${alt.short}：${lastErr?.message || lastErr}`);
      stats.degradedChunks += 1;
      try {
        return await translateChunk(alt, sources, signal, triedIds);
      }
      catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("翻译请求失败");
  }

  /**
   * 统一的可中断请求封装。
   * ⚠️ Zotero.HTTP.request **不支持** AbortSignal（http.js 里没有这个选项），
   * 所以必须用 requestObserver 拿到 xhr，在 abort 时手动 xhr.abort()，
   * 否则「停止」按钮要等当前请求超时（30s / 120s）才生效。
   */
  function request(method, url, options, signal) {
    return Zotero.HTTP.request(method, url, {
      ...options,
      requestObserver: (xhr) => {
        try {
          options.requestObserver?.(xhr);
        }
        catch (e) {}
        if (!signal) return;
        if (signal.aborted) {
          try {
            xhr.abort();
          }
          catch (e) {}
          return;
        }
        signal.addEventListener("abort", () => {
          try {
            xhr.abort();
          }
          catch (e) {}
        }, { once: true });
      },
    });
  }

  /**
   * 分段标记：把每段包成 "⟨n⟩ 原文"，翻译后按编号回填。
   * 实测（clients5.google.com）⟨1⟩ 这类标记在返回里**原样保留**，
   * 比"按换行数对齐"可靠得多 —— 后者在引擎合并/拆分句子时会静默错位。
   */
  const MARK_OPEN = "⟨";
  const MARK_CLOSE = "⟩";
  function markSegments(segs) {
    return segs.map((s, i) => `${MARK_OPEN}${i + 1}${MARK_CLOSE} ${s}`).join("\n");
  }

  /**
   * 按编号把译文切回数组。返回 null 表示标记不可信，调用方应退回逐段请求。
   */
  function splitByMarkers(text, expected) {
    const re = new RegExp(`${MARK_OPEN}\\s*(\\d+)\\s*${MARK_CLOSE}`, "g");
    const marks = [];
    let m;
    while ((m = re.exec(text))) {
      marks.push({ num: Number(m[1]), start: m.index, end: re.lastIndex });
    }
    if (marks.length !== expected) return null;
    if (marks[0].start > 0 && text.slice(0, marks[0].start).trim()) return null;
    const out = new Array(expected).fill("");
    for (let i = 0; i < marks.length; i++) {
      const idx = marks[i].num - 1;
      if (idx < 0 || idx >= expected) return null;
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      out[idx] = text.slice(marks[i].end, end).trim();
    }
    return out.every((s) => s.length > 0) ? out : null;
  }

  /**
   * 把段落列表打包装进若干请求块，块内用换行分隔。
   *
   * @param {string[]} paragraphs
   * @param {number} maxChars 单请求字符上限
   * @param {boolean} keepSource 超长单元是"保留原文"（LLM 用）还是"按句切分后翻译"（免费引擎用）
   * @returns {{chunks: Array, oversized: number}}
   */
  function packParagraphs(paragraphs, maxChars = FREE_MAX_CHARS, keepSource = false, maxItems = 0) {
    // 兼容两种输入：纯字符串数组，或 { text, paraIndex } 单元数组
    const units = (Array.isArray(paragraphs) ? paragraphs : []).map((p) =>
      typeof p === "string"
        ? { text: p, paraIndex: undefined }
        : { text: p.text ?? p.src ?? "", paraIndex: p.paraIndex });
    return packUnits(units, maxChars, keepSource, maxItems);
  }

  /**
   * 按单元打包。每个块带上 paraIndices —— 调用方据此知道"这批译文该填到哪一行"。
   * paraIndex 为 undefined 时退化为按顺序对应（兼容旧调用）。
   */
  function packUnits(inputUnits, maxChars = FREE_MAX_CHARS, keepSource = false, maxItems = 0) {
    const chunks = [];
    let buf = [];
    let len = 0;
    let oversized = 0;
    // ⚠️ offset 用"已入块单元数"计数；同时每个块记录 paraIndices，
    // 因为超长段落会被切成多块，光靠 offset 无法映射回原段落行。
    let count = 0;

    const flush = () => {
      if (!buf.length) return;
      chunks.push({
        segs: buf.map((u) => u.text),
        paraIndices: buf.map((u) => u.paraIndex),
        offset: count,
      });
      count += buf.length;
      buf = [];
      len = 0;
    };

    for (const unit of inputUnits) {
      const text = unit.text;
      if (text.length > maxChars) {
        flush();
        oversized += 1;
        if (keepSource) {
          chunks.push({ segs: [text], paraIndices: [unit.paraIndex], offset: count });
          count += 1;
        }
        else {
          for (const piece of utils.splitLongBlock(text, maxChars)) {
            buf.push({ text: piece, paraIndex: unit.paraIndex });
            len += piece.length + 1;
            if (len >= maxChars || (maxItems && buf.length >= maxItems)) flush();
          }
        }
        continue;
      }
      // 批量接口有条数上限（腾讯实测 30 条 OK、60 条返回空），到量就切块
      if (maxItems && buf.length >= maxItems) flush();
      if (len + text.length + 1 > maxChars && buf.length) flush();
      buf.push(unit);
      len += text.length + 1;
    }
    flush();
    return { chunks, oversized };
  }

  /* --------------------------- 免费引擎批次循环 --------------------------- */

  /**
   * 免费引擎批量翻译段落。返回与输入等长的译文数组。
   *
   * 走哪个引擎由 pref `engine` 决定（默认腾讯，国内直连）；
   * 某个块连续失败会按 FREE_CHAIN 降级到下一个免费引擎，尽量别让整篇失败。
   */
  async function translateFree(paragraphs, { signal, onProgress, onChunkDone } = {}) {
    const engine = engineById(currentFreeEngine());
    utils.log(`免费引擎：${engine.short}（块上限 ${engine.maxChars} 字符`
      + `${engine.batch ? ` / ${engine.maxItems} 段` : ""}）`);
    const { chunks } = packParagraphs(paragraphs, engine.maxChars, false, engine.maxItems);
    const out = new Array(paragraphs.length).fill("");
    let done = 0;

    for (const chunk of chunks) {
      if (signal?.aborted) throw makeAbortError();
      const sources = chunk.segs.map((s) => s.trim());
      const { texts: filled } = await translateChunk(engine, sources, signal);
      for (let i = 0; i < sources.length; i++) {
        out[chunk.offset + i] = filled[i] || "";
      }
      // 立刻把这一块的结果交给上层，界面可以边翻边显示
      try {
        onChunkDone?.(chunk.offset, sources, filled, chunk.paraIndices);
      }
      catch (e) {
        utils.log(`onChunkDone 回调出错：${e}`);
      }
      done += 1;
      onProgress?.(done, chunks.length);
    }
    return out;
  }

  /* ------------------------------- LLM ------------------------------- */

  const LLM_SYSTEM_PROMPT = [
    "你是一名学术论文翻译专家，专门把英文学术论文翻译成地道、准确的简体中文。",
    "要求：",
    "1. 忠实原文，不增删内容，不做总结，不加解释。",
    "2. 保持学术语体，术语使用国内学界通行译法；人名、机构名、专有名词首次出现时可在括号内保留原文。",
    "3. 保留原文的段落结构：输入是一个 JSON 字符串数组，输出必须是等长的 JSON 字符串数组，一一对应。",
    "4. 公式、变量名、LaTeX 片段、DOI、URL、引用编号（如 [12]、(Smith 2020)）保持原样。",
    "5. 只输出 JSON 数组本身，不要输出 Markdown 代码块标记，不要输出任何多余文字。",
  ].join("\n");

  const LLM_MAX_CHARS = 3500;

  function llmConfig() {
    const engine = utils.getPref("engine", "tencent");
    const baseURL = String(
      engine === "deepseek"
        ? utils.getPref("deepseekBaseURL", "https://api.deepseek.com")
        : utils.getPref("openaiBaseURL", "https://api.openai.com"),
    ).replace(/\/+$/, "");
    const model = String(
      engine === "deepseek"
        ? utils.getPref("deepseekModel", "deepseek-chat")
        : utils.getPref("openaiModel", "gpt-4o-mini"),
    );
    const apiKey = String(
      engine === "deepseek"
        ? utils.getPref("deepseekApiKey", "")
        : utils.getPref("openaiApiKey", ""),
    ).trim();
    return { engine, baseURL, model, apiKey };
  }

  function extractJSONArray(content) {
    let s = String(content || "").trim();
    // 去掉 ```json ... ``` 包裹
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("模型没有返回 JSON 数组");
    }
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) throw new Error("模型返回的不是数组");
    return arr.map((x) => (typeof x === "string" ? x : String(x ?? "")));
  }

  async function llmTranslateParagraphs(paragraphs, { signal, onProgress, onChunkDone } = {}) {
    const cfg = llmConfig();
    if (!cfg.apiKey) {
      throw new Error(
        `没有填写 ${cfg.engine === "deepseek" ? "DeepSeek" : "OpenAI 兼容"} API Key。`
        + "请在「设置 → 双语论文助手」里填写，或把翻译引擎切换为「免费 Google 翻译」。",
      );
    }
    const { chunks } = packParagraphs(paragraphs, LLM_MAX_CHARS, true);
    const out = new Array(paragraphs.length).fill("");
    // 用户常按各家文档把地址填成 https://api.openai.com/v1，这里统一去掉尾部 /v1，
    // 避免拼成 /v1/v1/chat/completions 而 404
    const url = `${cfg.baseURL.replace(/\/v1$/i, "")}/v1/chat/completions`;
    const concurrency = Math.max(1, Math.min(4, Number(utils.getPref("llmConcurrency", 2)) || 2));
    let done = 0;

    const runChunk = async (chunk) => {
      const body = {
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: LLM_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(chunk.segs) },
        ],
      };
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw makeAbortError();
        try {
          const xhr = await request("POST", url, {
            responseType: "json",
            timeout: 120000,
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            successCodes: [200],
          }, signal);
          const data = xhr.response || JSON.parse(xhr.responseText);
          const content = data?.choices?.[0]?.message?.content;
          const arr = extractJSONArray(content);
          if (arr.length !== chunk.segs.length) {
            // 模型把多段合并/拆分了 —— 按序回填会整批错位，不能采信
            throw new Error(
              `条目数不匹配：期望 ${chunk.segs.length}，得到 ${arr.length}`,
            );
          }
          return arr;
        }
        catch (e) {
          if (signal?.aborted) throw makeAbortError();
          lastErr = e;
          const status = e?.status || e?.xmlhttp?.status;
          // 4xx（除 429）不重试
          if (status && status >= 400 && status < 500 && status !== 429) break;
          await Zotero.Promise.delay(800 * (attempt + 1));
        }
      }
      throw lastErr || new Error("LLM 翻译请求失败");
    };

    /** 逐条单独翻译：块级失败时的降级路径 */
    const runSingle = async (text) => {
      const body = {
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: LLM_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify([text]) },
        ],
      };
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw makeAbortError();
        try {
          const xhr = await request("POST", url, {
            responseType: "json",
            timeout: 120000,
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            successCodes: [200],
          }, signal);
          const data = xhr.response || JSON.parse(xhr.responseText);
          const arr = extractJSONArray(data?.choices?.[0]?.message?.content);
          if (arr.length !== 1) throw new Error("单条翻译返回数量异常");
          return arr[0];
        }
        catch (e) {
          if (signal?.aborted) throw makeAbortError();
          lastErr = e;
          if (attempt === 1) break;
          await Zotero.Promise.delay(600);
        }
      }
      throw lastErr || new Error("单条翻译失败");
    };

    let failedSegments = 0;
    const queue = chunks.slice();
    const workers = new Array(Math.min(concurrency, queue.length)).fill(0).map(async () => {
      while (queue.length) {
        const chunk = queue.shift();
        let arr;
        try {
          arr = await runChunk(chunk);
        }
        catch (e) {
          // 降级：这一块逐条重试。个别条目仍失败就留空，
          // **绝不因为一个块失败就让整篇翻译前功尽弃**（这个坑踩过）
          utils.log(`LLM 块级翻译失败（${e?.message || e}），改为逐条重试`);
          stats.degradedChunks += 1;
          arr = [];
          for (const seg of chunk.segs) {
            if (signal?.aborted) throw makeAbortError();
            try {
              arr.push(await runSingle(seg));
            }
            catch (e2) {
              utils.log(`单条翻译仍失败：${e2?.message || e2}`);
              arr.push("");
            }
          }
          failedSegments += arr.filter((x) => !x).length;
        }
        for (let i = 0; i < chunk.segs.length; i++) {
          out[chunk.offset + i] = arr[i] || "";
        }
        try {
          onChunkDone?.(chunk.offset, chunk.segs.slice(), arr.slice(), chunk.paraIndices);
        }
        catch (e) {
          utils.log(`onChunkDone 回调出错：${e}`);
        }
        done += 1;
        onProgress?.(done, chunks.length);
      }
    });
    await Promise.all(workers);
    stats.failedSegments = failedSegments;
    return out;
  }

  /* ----------------------------- 对外接口 ----------------------------- */

  /** 当前用的是不是 LLM（DeepSeek / OpenAI 兼容） */
  function isLLMEngine() {
    const raw = String(utils.getPref("engine", "tencent") || "tencent");
    return raw === "deepseek" || raw === "openai";
  }

  /**
   * 批量翻译：输入英文字符串数组，输出等长中文数组。
   * @param {string[]} paragraphs
   * @param {{signal?: AbortSignal, onProgress?: (done:number,total:number)=>void}} opts
   */
  async function translateParagraphs(paragraphs, opts = {}) {
    if (!paragraphs.length) return [];
    resetStats();
    if (isLLMEngine()) return llmTranslateParagraphs(paragraphs, opts);
    return translateFree(paragraphs, opts);
  }

  /** 翻译单段文本（划词浮窗用） */
  async function translateText(text, opts = {}) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    if (isLLMEngine()) {
      const out = await llmTranslateParagraphs([trimmed], opts);
      return out[0] || "";
    }
    const out = await translateFree([trimmed], opts);
    return out[0] || "";
  }

  /** 当前引擎是否可用（用于 UI 提示） */
  function engineStatus() {
    const raw = String(utils.getPref("engine", "tencent") || "tencent");
    if (raw === "deepseek" || raw === "openai") {
      const cfg = llmConfig();
      const name = raw === "deepseek" ? "DeepSeek" : "OpenAI 兼容";
      if (!cfg.apiKey) {
        return { ok: false, label: `${name}（未填写 API Key）`, engine: raw };
      }
      return { ok: true, label: `${name} · ${cfg.model}`, engine: raw };
    }
    const eng = engineById(currentFreeEngine());
    return { ok: true, label: eng.label, engine: eng.id, free: true };
  }

  return {
    translateParagraphs,
    translateText,
    engineStatus,
    flattenFreeResponse,
    packParagraphs,
    extractJSONArray,
    splitByMarkers,
    markSegments,
    getStats: () => ({ ...stats }),
    /** 免费引擎清单（设置面板用来渲染下拉框） */
    freeEngines: () => FREE_CHAIN.map((id) => ({
      id, label: FREE_ENGINES[id].label,
    })),
    currentFreeEngine,
    freeEngineById: engineById,
    /** 内部用：给自检/测试暴露一次"某引擎翻一批"的入口 */
    _engineTranslateChunk: engineTranslateChunk,
  };
})();
