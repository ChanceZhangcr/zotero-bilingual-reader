"""探活：GitHub 相关的几个域名在这台机器上到底哪些能通。"""
import socket
import ssl
import urllib.error
import urllib.request

CTX = ssl.create_default_context()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

HOSTS = [
    "github.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "api.github.com",
    "cdn.jsdelivr.net",
    "fastly.jsdelivr.net",
    "gcore.jsdelivr.net",
    "testingcf.jsdelivr.net",
    "chancezhangcr.github.io",
    "gitee.com",
]

print("=== DNS ===")
resolved = {}
for h in HOSTS:
    try:
        ip = socket.gethostbyname(h)
        resolved[h] = ip
        print(f"  [OK  ] {h:32s} -> {ip}")
    except Exception as e:
        print(f"  [FAIL] {h:32s} {type(e).__name__}: {e}")

print("\n=== HTTPS 实际抓取（update.json / 图片 / xpi 用的地址）===")
URLS = [
    ("github.com 仓库页", "https://github.com/ChanceZhangcr/zotero-bilingual-reader"),
    ("raw.githubusercontent", "https://raw.githubusercontent.com/ChanceZhangcr/zotero-bilingual-reader/main/update.json"),
    ("github.com/raw 跳转", "https://github.com/ChanceZhangcr/zotero-bilingual-reader/raw/main/update.json"),
    ("jsdelivr gh", "https://cdn.jsdelivr.net/gh/ChanceZhangcr/zotero-bilingual-reader@main/update.json"),
    ("jsdelivr fastly", "https://fastly.jsdelivr.net/gh/ChanceZhangcr/zotero-bilingual-reader@main/update.json"),
    ("jsdelivr gcore", "https://gcore.jsdelivr.net/gh/ChanceZhangcr/zotero-bilingual-reader@main/update.json"),
    ("github.io pages", "https://chancezhangcr.github.io/zotero-bilingual-reader/update.json"),
    ("Release 附件直链", "https://github.com/ChanceZhangcr/zotero-bilingual-reader/releases/download/v1.4.1/bilingual-reader_1.4.1.xpi"),
]

for label, url in URLS:
    try:
        r = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(r, timeout=30, context=CTX) as resp:
            body = resp.read(400)
            print(f"  [OK  ] {label:22s} {resp.status}  {resp.headers.get('Content-Type','').split(';')[0]}  {len(body)}B+")
            print(f"         前 80 字节: {body[:80]!r}")
    except urllib.error.HTTPError as e:
        print(f"  [HTTP] {label:22s} {e.code} {e.reason}")
    except Exception as e:
        print(f"  [FAIL] {label:22s} {type(e).__name__}: {e}")
