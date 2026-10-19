"""发布后验收：仓库页、README 图片、update.json、Release 里的 xpi 是否都能正常访问。"""
import json
import ssl
import urllib.error
import urllib.request

OWNER = "ChanceZhangcr"
REPO = "zotero-bilingual-reader"
VER = "1.4.1"
BASE = f"https://github.com/{OWNER}/{REPO}"
RAW = f"https://raw.githubusercontent.com/{OWNER}/{REPO}/main"

CTX = ssl.create_default_context()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def head(url, timeout=25):
    r = urllib.request.Request(url, headers={"User-Agent": UA}, method="GET")
    with urllib.request.urlopen(r, timeout=timeout, context=CTX) as resp:
        data = resp.read()
        return resp.status, resp.headers.get("Content-Type", ""), len(data), data


def check(label, ok, detail=""):
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}{('  ' + detail) if detail else ''}")
    return ok


fails = 0

for label, url in [
    ("仓库首页", BASE),
    ("Release 页", f"{BASE}/releases/tag/v{VER}"),
    ("README 原文件", f"{RAW}/README.md"),
    ("update.json", f"{RAW}/update.json"),
    ("效果图 reader-layout.png", f"{RAW}/docs/reader-layout.png"),
    ("效果图 export-bilingual.png", f"{RAW}/docs/export-bilingual.png"),
    ("效果图 export-zh.png", f"{RAW}/docs/export-zh.png"),
    ("CHANGELOG", f"{RAW}/CHANGELOG.md"),
    ("LICENSE", f"{RAW}/LICENSE"),
]:
    try:
        status, ctype, size, _ = head(url)
        if not check(label, status == 200, f"{status} {ctype.split(';')[0]} {size} B"):
            fails += 1
    except Exception as e:
        check(label, False, f"{type(e).__name__}: {e}")
        fails += 1

print("\n--- update.json 内容 ---")
try:
    _, _, _, data = head(f"{RAW}/update.json")
    up = json.loads(data)
    entry = up["addons"]["bilingual-reader@local.plugin"]["updates"][0]
    print(f"  version     = {entry['version']}")
    print(f"  update_link = {entry['update_link']}")
    ok = entry["version"] == VER and f"/v{VER}/" in entry["update_link"]
    if not check("update.json 版本与链接正确", ok):
        fails += 1

    print("\n--- 顺着 update_link 下载 xpi ---")
    status, ctype, size, blob = head(entry["update_link"], timeout=60)
    check("xpi 可下载", status == 200 and size > 50000, f"{status} {size} B")
    print(f"  Content-Type: {ctype}")
    print(f"  头 4 字节   : {blob[:4]!r}（zip 应为 b'PK\\x03\\x04'）")
    if blob[:4] != b"PK\x03\x04":
        print("  ⚠️ 不是 zip！")
        fails += 1
except Exception as e:
    print(f"  {type(e).__name__}: {e}")
    fails += 1

print("\n--- README 里的图片路径 ---")
try:
    _, _, _, data = head(f"{RAW}/README.md")
    readme = data.decode("utf-8")
    import re
    imgs = re.findall(r'(?:src="|!\[[^\]]*\]\()([^")]+\.(?:png|jpg|gif))', readme)
    for rel in sorted(set(imgs)):
        url = rel if rel.startswith("http") else f"{RAW}/{rel.lstrip('./')}"
        try:
            status, _, size, _ = head(url)
            check(f"  {rel}", status == 200 and size > 1000, f"{size} B")
            if status != 200:
                fails += 1
        except Exception as e:
            check(f"  {rel}", False, str(e)[:60])
            fails += 1
except Exception as e:
    print(f"  {type(e).__name__}: {e}")
    fails += 1

print(f"\n{'✅ 全部可访问' if fails == 0 else f'❌ {fails} 项有问题'}")
