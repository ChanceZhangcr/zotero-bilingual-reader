"""看一眼导出的两个 PDF：文字顺序、颜色、分页。"""
import sys
import pymupdf

D = r"C:\Users\22124\AppData\Local\Temp\bilingual-export-test\bilingual-reader\exports"

for name in ["The Testimony Gap（中文译文）.pdf", "The Testimony Gap（中英对照）.pdf"]:
    path = f"{D}\\{name}"
    doc = pymupdf.open(path)
    print(f"\n===== {name} =====")
    print(f"页数: {doc.page_count}")
    for pno, page in enumerate(doc, 1):
        d = page.get_text("dict")
        for block in d["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    color = span["color"]
                    rgb = ((color >> 16) & 255, (color >> 8) & 255, color & 255)
                    text = span["text"]
                    if not text.strip():
                        continue
                    print(f"  p{pno} 颜色={rgb} 字号={span['size']:.1f} x={span['bbox'][0]:.0f} | {text[:70]}")
    doc.close()
