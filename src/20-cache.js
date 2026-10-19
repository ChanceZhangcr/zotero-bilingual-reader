/* eslint-env mozilla */
/**
 * 译文缓存
 * 键 = hash(引擎 + 模型 + 目标语言 + 原文)，值 = 译文。
 * 同一段落（含重复引用、多次打开）不会重复请求。
 */

Bilingual.cache = (() => {
  const { utils } = Bilingual;
  const FILE_NAME = "translation-cache.json";
  const MAX_ENTRIES = 40000;

  let loaded = false;
  let loading = null;
  let data = {};
  let dirty = false;
  let saveTimer = null;
  let filePath = null;

  /**
   * 缓存签名：同一条款 + 同一引擎配置 → 同一个 key。
   *
   * ⚠️ 所有免费引擎（腾讯 / 有道 / MyMemory / Google）共用同一个签名桶。
   * 换免费引擎不该让已有的译文缓存全部作废（那意味着用户要重新翻一遍整篇）。
   * 字符串里的 "google" 是历史遗留的字面量，**故意不改**：
   * 改了会让老用户的现有缓存全部失效。
   */
  function configSignature() {
    const engine = utils.getPref("engine", "tencent");
    if (engine === "deepseek") {
      return `deepseek|${utils.getPref("deepseekModel", "deepseek-chat")}|zh-CN`;
    }
    if (engine === "openai") {
      return `openai|${utils.getPref("openaiModel", "gpt-4o-mini")}|zh-CN`;
    }
    return "free|google|zh-CN";
  }

  function keyFor(text) {
    return utils.hash(`${configSignature()}\u0000${text}`);
  }

  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const dir = await utils.getDataDirectory();
        if (!dir) {
          loaded = true;
          return;
        }
        filePath = PathUtils.join(dir, FILE_NAME);
        if (await IOUtils.exists(filePath)) {
          const raw = await IOUtils.readUTF8(filePath);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            data = parsed;
          }
        }
      }
      catch (e) {
        utils.log(`译文缓存读取失败（将重建）：${e}`);
        data = {};
      }
      loaded = true;
    })();
    return loading;
  }

  async function flush() {
    if (!dirty || !filePath) return;
    dirty = false;
    try {
      const keys = Object.keys(data);
      if (keys.length > MAX_ENTRIES) {
        // 超限时丢弃最早写入的一半（对象键顺序基本反映写入顺序）
        const drop = keys.slice(0, Math.floor(keys.length / 2));
        for (const k of drop) delete data[k];
      }
      await IOUtils.writeUTF8(filePath, JSON.stringify(data));
    }
    catch (e) {
      utils.log(`译文缓存写入失败：${e}`);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush().catch((e) => utils.log(e));
    }, 2000);
  }

  return {
    async get(text) {
      await load();
      if (!text) return undefined;
      return data[keyFor(text)];
    },

    async getMany(texts) {
      await load();
      return texts.map((t) => data[keyFor(t)]);
    },

    async setPairs(pairs) {
      await load();
      let n = 0;
      for (const [src, dst] of pairs) {
        if (!src || typeof dst !== "string" || !dst) continue;
        const k = keyFor(src);
        if (data[k] === dst) continue;
        data[k] = dst;
        n += 1;
      }
      if (n) scheduleSave();
      return n;
    },

    async clear() {
      await load();
      data = {};
      dirty = true;
      await flush();
    },

    async stats() {
      await load();
      return { entries: Object.keys(data).length, filePath };
    },

    async flushNow() {
      await flush();
    },
  };
})();
