"""轮询 jsDelivr，确认 purge 之后 update.json 是否真的刷新了。"""
import json
import ssl
import time
import urllib.request

CTX = ssl.create_default_context()
UA = "Mozilla/5.0"
URL = "https://cdn.jsdelivr.net/gh/ChanceZhangcr/zotero-bilingual-reader@main/update.json"

for i in range(8):
    try:
        r = urllib.request.Request(URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(r, timeout=45, context=CTX) as resp:
            e = json.loads(resp.read())["addons"]["bilingual-reader@local.plugin"]["updates"][0]
            version = e["version"]
            print(f"  第 {i + 1} 次（累计等 {i * 15}s）: {version}")
            if version == "1.4.2":
                print("  ✅ jsDelivr 缓存已刷新")
                break
    except Exception as ex:
        print("  ", type(ex).__name__, ex)
    time.sleep(15)
else:
    print("  ⚠️ 等了 105 秒还是旧的 —— purge 对这种分支地址不生效")
