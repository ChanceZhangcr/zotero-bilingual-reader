"""把 README 用的 PDF 渲染成 PNG，并画一张阅读器分栏示意图。"""
import os

import pymupdf
from PIL import Image, ImageDraw, ImageFont

DOCS = r"C:\Users\22124\Documents\deepseek-harness\default-workspace\zotero-bilingual\docs"
FONT_CN = r"C:\Windows\Fonts\msyh.ttc"
FONT_CN_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def render(pdf_name, png_name, dpi=110):
    path = os.path.join(DOCS, pdf_name)
    doc = pymupdf.open(path)
    page = doc[0]
    pix = page.get_pixmap(dpi=dpi)
    out = os.path.join(DOCS, png_name)
    pix.save(out)
    doc.close()
    print(f"  {png_name}: {pix.width}x{pix.height}, {os.path.getsize(out)//1024} KB")


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def draw_reader_mock():
    """画一张阅读器分栏示意图（明确标注"示意图"，不是截图）。"""
    W, H = 1400, 820
    im = Image.new("RGB", (W, H), "#f4f5f7")
    d = ImageDraw.Draw(im)

    f_title = font(FONT_CN_BOLD, 21)
    f_small = font(FONT_CN, 15)
    f_btn = font(FONT_CN, 14)
    f_cn = font(FONT_CN, 19)
    f_note = font(FONT_CN, 16)

    split_x = 700

    # 窗口外框 + 标题栏
    d.rounded_rectangle([24, 20, W - 24, H - 20], radius=12, fill="#ffffff", outline="#dcdfe4", width=2)
    d.rounded_rectangle([24, 20, W - 24, 82], radius=12, fill="#eceef1")
    d.rectangle([24, 60, W - 24, 82], fill="#eceef1")
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        d.ellipse([46 + i * 26, 42, 62 + i * 26, 58], fill=c)
    d.text((150, 43), "The Testimony Gap: Machines and Reasons — Zotero", font=f_small, fill="#3c4043")

    # 左右两栏底色
    d.rectangle([24, 82, split_x, H - 20], fill="#fafbfc")
    d.rectangle([split_x + 2, 82, W - 24, H - 20], fill="#ffffff")
    d.line([split_x, 82, split_x, H - 20], fill="#dcdfe4", width=2)

    # ---- 左栏：英文原文 ----
    d.text((52, 98), "英文原文（PDF）", font=f_title, fill="#5f6368")
    d.rounded_rectangle([52, 140, split_x - 30, H - 52], radius=4, fill="#ffffff", outline="#e3e6ea")
    en_lines = [
        "Machines do not testify. They record, retrieve,",
        "and recombine what humans have already said,",
        "and in doing so they quietly change what it",
        "means to be a witness in a court of law.",
        "",
        "This paper argues that the testimony gap is not",
        "a technical deficit but a conceptual one: our",
        "evidentiary rules presuppose a speaker who can",
        "be cross-examined, and no amount of",
        "explainability tooling supplies that.",
    ]
    y = 168
    for line in en_lines:
        d.text((76, y), line, font=f_small, fill="#5f6368")
        y += 26

    # ---- 右栏：中文面板 ----
    # 头部条
    d.rectangle([split_x + 2, 82, W - 24, 136], fill="#f8f9fa")
    d.line([split_x + 2, 136, W - 24, 136], fill="#e3e6ea", width=1)
    d.text((split_x + 22, 98), "中文译文", font=f_title, fill="#202124")

    # 右侧按钮（从右往左排）
    x = W - 46
    for label in ["×", "导出文档", "双语", "翻译全文"]:
        tw = d.textlength(label, font=f_btn)
        bw = int(tw) + 22
        x -= bw
        d.rounded_rectangle([x, 96, x + bw - 6, 126], radius=5, outline="#d5d9de", fill="#ffffff")
        d.text((x + 8, 102), label, font=f_btn, fill="#3c4043")
        x -= 8

    # 悬浮按钮（右上角）
    d.rounded_rectangle([W - 152, 148, W - 52, 186], radius=19, fill="#407bd2")
    d.text((W - 131, 155), "中译", font=f_cn, fill="#ffffff")

    zh_blocks = [
        "机器不作证。它们记录、检索并重新组合人类已",
        "经说过的话，而在这个过程中，它们悄悄改变了",
        "在法庭上作为证人意味着什么。",
        "",
        "本文认为，证词鸿沟不是技术缺陷，而是概念缺",
        "陷：我们的证据规则预设了一个可以被交叉询问",
        "的陈述者，而再多的可解释性工具也无法提供这",
        "一点。",
        "",
        "我们最后提出一项针对自动化法庭的证据改革建",
        "议，其依据来自传闻证据规则以及机器学习领域",
        "近期的研究。",
    ]
    y = 206
    for line in zh_blocks:
        if line:
            d.text((split_x + 22, y), line, font=f_cn, fill="#202124")
        y += 32

    d.text((32, H - 44), "示意图（实际界面随 Zotero 主题变化）", font=f_note, fill="#9aa0a6")

    out = os.path.join(DOCS, "reader-layout.png")
    im.save(out)
    print(f"  reader-layout.png: {im.width}x{im.height}, {os.path.getsize(out)//1024} KB")


print("=== 渲染 ===")
render("export-zh.pdf", "export-zh.png")
render("export-bilingual.pdf", "export-bilingual.png")
draw_reader_mock()
