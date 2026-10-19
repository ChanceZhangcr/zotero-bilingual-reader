"""发布后验收：仓库页、README 图片、update.json、Release 里的 xpi，以及 xpi 里的 update_url。

⚠️ raw.githubusercontent.com 在国内 DNS 解析失败，所以仓库文件走 jsDelivr 验。
"""
import io
import json
import re
import ssl
import urllib.error
import urllib.request
import zipfile

OWNER = "ChanceZhangcr"
REPO = "zotero-bilingual-reader"
VER = "1.4.1"
BASE = f"https://github.com/{OWNER}/{REPO}"
# jsDelivr 的 gh 通道：读同一个仓库的同一个文件，国内可直连
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
    return ok


print("=== 1. 页面可访问 ===")
for label, url in [("仓库首页", BASE), ("Release 页", f"{BASE}/releases/tag/v{VER}")]:
    try:
        status, ctype, body = get(url)
        check(label, status == 200, f"{status} {len(body)} B")
    except Exception as e:
        check(label, False, str(e)[:70])

print("\n=== 2. 仓库文件（走 jsDelivr）===")
for label, path in [
    ("README.md", "README.md"),
    ("update.json", "update.json"),
    ("CHANGELOG.md", "CHANGELOG.md"),
    ("LICENSE", "LICENSE"),
    ("效果图 reader-layout.png", "docs/reader-layout.png"),
    ("效果图 export-bilingual.png", "docs/export-bilingual.png"),
    ("效果图 export-zh.png", "docs/export-zh.png"),
]:
    try:
        status, ctype, body = get(f"{RAW}/{path}")
        check(label, status == 200 and len(body) > 300, f"{len(body)} B")
    except urllib.error.HTTPError as e:
        check(label, False, f"HTTP {e.code}（jsDelivr 缓存没跟上？等 1-2 分钟再试）")
    except Exception as e:
        check(label, False, str(e)[:70])

print("\n=== 3. update.json 内容 ===")
try:
    _, _, body = get(f"{RAW}/update.json")
    up = json.loads(body)
    entry = up["addons"]["bilingual-reader@local.plugin"]["updates"][0]
    print(f"  version     = {entry['version']}")
    print(f"  update_link = {entry['update_link']}")
    check("版本号正确", entry["version"] == VER)
    check("下载链接指向本版本", f"/v{VER}/" in entry["update_link"])
except Exception as e:
    check("update.json 可解析", False, str(e)[:80])

print("\n=== 4. Release 里的 xpi ===")
xpi_url = f"{BASE}/releases/download/v{VER}/bilingual-reader_{VER}.xpi"
try:
    status, ctype, blob = get(xpi_url)
    check("xpi 可下载", status == 200 and len(blob) > 50000, f"{len(blob)} B, {ctype}")
    check("是合法 zip", blob[:4] == b"PK\x03\x04", repr(blob[:4]))
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = zf.namelist()
    check("包含 manifest.json", "manifest.json" in names, ", ".join(names[:3]))
    mf = json.loads(zf.read("manifest.json"))
    check("版本号是 " + VER, mf["version"] == VER, mf["version"])
    upd = mf["applications"]["zotero"]["update_url"]
    print(f"  update_url  = {upd}")
    check("update_url 不是被墙的 raw.githubusercontent.com", "raw.githubusercontent.com" not in upd)
    check("update_url 指向 jsDelivr", "cdn.jsdelivr.net" in upd)
    check("manifest 里三个必填字段齐全",
          all(k in mf["applications"]["zotero"] for k in ("id", "update_url", "strict_max_version")))
    check("bootstrap.js 在包里", "bootstrap.js" in names)
    check("主脚本在包里", "chrome/content/scripts/bilingual.js" in names)
except Exception as e:
    check("xpi 检查", False, f"{type(e).__name__}: {e}")

print("\n=== 5. README 里引用的图片都在仓库里 ===")
try:
    _, _, body = get(f"{RAW}/README.md")
    readme = body.decode("utf-8")
    refs = sorted(set(re.findall(r'(?:src="|!\[[^\]]*\]\()(docs/[^")]+)', readme)))
    for rel in refs:
        try:
            status, _, b = get(f"{RAW}/{rel}")
            check(f"  {rel}", status == 200 and len(b) > 1000, f"{len(b)} B")
        except Exception as e:
            check(f"  {rel}", False, str(e)[:60])
    check("README 至少引用了 3 张图", len(refs) >= 3, f"{len(refs)} 张")
except Exception as e:
    check("README 图片检查", False, str(e)[:80])

print(f"\n{'✅ 发布验收全部通过' if fails == 0 else f'❌ {fails} 项有问题'}")
