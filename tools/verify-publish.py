"""发布验收：范围声明、作者、下载链路、自动更新。

只测**最终对外的那几个地址**：
  - 仓库页 / Release 页（github.com）
  - 最新 Release 附件里的 update.json（自动更新地址）
  - 该 update.json 指向的 xpi
  - jsDelivr 上按版本命名的镜像 xpi
刻意不测 cdn.jsdelivr.net/...@main/*：那个有 12 小时缓存，测了只会误导。
"""

import io
import json
import ssl
import urllib.error
import urllib.request
import zipfile

OWNER = "ChanceZhangcr"
REPO = "zotero-bilingual-reader"
BASE = f"https://github.com/{OWNER}/{REPO}"
LATEST_UPDATE = f"{BASE}/releases/latest/download/update.json"
JSDELIVR = f"https://cdn.jsdelivr.net/gh/{OWNER}/{REPO}@main"

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


print("=== 1. 自动更新链路（Zotero 会请求的那个地址）===")
expected = None
try:
    _, _, body = get(LATEST_UPDATE)
    up = json.loads(body)
    e = up["addons"]["bilingual-reader@local.plugin"]["updates"][0]
    expected = e["version"]
    print(f"  update.json 声明版本 = {expected}")
    print(f"  update_link         = {e['update_link']}")
    apps = e.get("applications", {}).get("zotero", {})
    print(f"  zotero 版本要求      = {apps}")
    check("最低版本 9.0（不再声称支持 7/8）", apps.get("strict_min_version") == "9.0")
    check("下载链接指向本版本", f"/v{expected}/" in e["update_link"])
except Exception as ex:
    check("拉 update.json", False, f"{type(ex).__name__}: {ex}")

print("\n=== 2. 最新 xpi（顺着 update_link 下）===")
if expected:
    try:
        url = f"{BASE}/releases/download/v{expected}/bilingual-reader_{expected}.xpi"
        _, ctype, blob = get(url)
        check("可下载", len(blob) > 50000, f"{len(blob)} B {ctype}")
        check("是合法 zip", blob[:4] == b"PK\x03\x04")
        zf = zipfile.ZipFile(io.BytesIO(blob))
        names = zf.namelist()
        mf = json.loads(zf.read("manifest.json"))
        z = mf["applications"]["zotero"]
        check(f"version = {expected}", mf["version"] == expected, mf["version"])
        check("strict_min_version = 9.0", z["strict_min_version"] == "9.0", z["strict_min_version"])
        check("描述写明 Zotero 9 (Windows)", "Zotero 9" in mf["description"], mf["description"][:44] + "…")
        check("author 是两个人", "ChanceZhangcr" in mf["author"] and "DeepSeek" in mf["author"], mf["author"])
        check("update_url 用 releases/latest（无长缓存）",
              "/releases/latest/download/update.json" in z["update_url"], z["update_url"])
        check("没有用被墙的 raw.githubusercontent", "raw.githubusercontent" not in z["update_url"])
        check("三个必填字段齐全", all(k in z for k in ("id", "update_url", "strict_max_version")))
        check("bootstrap.js + 主脚本都在", "bootstrap.js" in names and "chrome/content/scripts/bilingual.js" in names)
    except Exception as ex:
        check("检查 xpi", False, f"{type(ex).__name__}: {ex}")

print("\n=== 3. jsDelivr 镜像（按版本命名，新路径无缓存）===")
if expected:
    try:
        _, ctype, blob = get(f"{JSDELIVR}/releases/bilingual-reader_{expected}.xpi")
        mf = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read("manifest.json"))
        check("镜像可下载且版本一致", mf["version"] == expected, f"{len(blob)} B, v{mf['version']}")
    except urllib.error.HTTPError as ex:
        check("镜像 xpi", False, f"HTTP {ex.code}（新路径一般不会有缓存，稍等再试）")
    except Exception as ex:
        check("镜像 xpi", False, f"{type(ex).__name__}: {ex}")

print("\n=== 4. 页面 ===")
for label, url in [("仓库首页", BASE), ("最新 Release 页", f"{BASE}/releases/latest")]:
    try:
        status, _, body = get(url)
        check(label, status == 200, f"{len(body)} B")
    except Exception as ex:
        check(label, False, str(ex)[:70])

print(f"\n{'✅ 发布验收全部通过' if fails == 0 else f'❌ {fails} 项有问题'}")
