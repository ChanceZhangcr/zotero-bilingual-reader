"""v1.4.2 验收：范围声明（Zotero 9 + Windows）、作者信息、下载链路。"""
import io
import json
import ssl
import urllib.error
import urllib.request
import zipfile

OWNER = "ChanceZhangcr"
REPO = "zotero-bilingual-reader"
VER = "1.4.2"
BASE = f"https://github.com/{OWNER}/{REPO}"
RAW = f"https://cdn.jsdelivr.net/gh/{OWNER}/{REPO}@main"
CTX = ssl.create_default_context()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

fails = 0


def get(url, timeout=60):
    r = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(r, timeout=timeout, context=CTX) as resp:
        return resp.status, resp.headers.get("Content-Type", ""), resp.read()


def check(label, ok, detail=""):
    global fails
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}{('  ' + detail) if detail else ''}")
    if not ok:
        fails += 1


print("=== 1. update.json ===")
try:
    _, _, body = get(f"{RAW}/update.json")
    up = json.loads(body)
    e = up["addons"]["bilingual-reader@local.plugin"]["updates"][0]
    check("版本 = " + VER, e["version"] == VER, e["version"])
    check("链接指向 v" + VER, f"/v{VER}/" in e["update_link"], e["update_link"])
    apps = e.get("applications", {}).get("zotero", {})
    check("最低版本 9.0", apps.get("strict_min_version") == "9.0", str(apps))
except Exception as ex:
    check("update.json", False, str(ex)[:80])

print("\n=== 2. Release 里的 xpi（新版本）===")
url = f"{BASE}/releases/download/v{VER}/bilingual-reader_{VER}.xpi"
try:
    _, ctype, blob = get(url)
    check("可下载", len(blob) > 50000, f"{len(blob)} B {ctype}")
    mf = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read("manifest.json"))
    check("version = " + VER, mf["version"] == VER, mf["version"])
    z = mf["applications"]["zotero"]
    check("strict_min_version = 9.0（不再声称支持 7/8）", z["strict_min_version"] == "9.0", z["strict_min_version"])
    check("author 写了两个人", "ChanceZhangcr" in mf["author"] and "DeepSeek" in mf["author"], mf["author"])
    check("description 写明 Zotero 9 / Windows", "Zotero 9" in mf["description"], mf["description"][:60])
    check("update_url 用 jsDelivr", "cdn.jsdelivr.net" in z["update_url"])
except Exception as ex:
    check("Release xpi", False, f"{type(ex).__name__}: {ex}")

print("\n=== 3. jsDelivr 镜像 xpi ===")
try:
    _, ctype, blob = get(f"{RAW}/releases/bilingual-reader_{VER}.xpi")
    mf = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read("manifest.json"))
    check("镜像可下载且版本正确", mf["version"] == VER, f"{len(blob)} B, v{mf['version']}")
except Exception as ex:
    check("镜像 xpi", False, f"{type(ex).__name__}: {ex}（jsDelivr 缓存可能要等 1-2 分钟）")

print("\n=== 4. README 内容 ===")
try:
    _, _, body = get(f"{RAW}/README.md")
    md = body.decode("utf-8")
    check("有『两个人一起做』的说明", "两个人一起做" in md)
    check("点名 ChanceZhangcr", "ChanceZhangcr" in md)
    check("点名 DeepSeek", "DeepSeek" in md)
    check("badge 只写 Windows", "platform-Windows" in md and "macOS" not in md.split("## 效果")[0])
    check("badge 只写 Zotero 9", "Zotero-9-" in md)
    check("没有 macOS 快捷键说法", "Cmd+Option" not in md)
    check("日志路径只给 Windows", "diagnostic.log" in md and "~/Zotero" not in md)
    check("有『已知限制』", "已知限制" in md)
except Exception as ex:
    check("README", False, str(ex)[:80])

print("\n=== 5. AUTHORS.md ===")
try:
    _, _, body = get(f"{RAW}/AUTHORS.md")
    a = body.decode("utf-8")
    check("AUTHORS.md 存在且点名双方", "ChanceZhangcr" in a and "DeepSeek" in a, f"{len(a)} B")
except urllib.error.HTTPError as ex:
    check("AUTHORS.md", False, f"HTTP {ex.code}（jsDelivr 缓存未跟上？）")
except Exception as ex:
    check("AUTHORS.md", False, str(ex)[:80])

print(f"\n{'✅ 全部通过' if fails == 0 else f'❌ {fails} 项有问题'}")
