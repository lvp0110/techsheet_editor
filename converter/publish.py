"""Build a PDF that keeps the source page and draws edited blocks on top."""

from __future__ import annotations

from pathlib import Path

import pymupdf

FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def build_pdf(document: dict, doc_dir: Path, dest: Path) -> None:
    doc_dir = Path(doc_dir)
    dest = Path(dest)
    pdf = pymupdf.open()
    for page in document.get("pages") or []:
        width = float(page.get("width") or 595)
        height = float(page.get("height") or 842)
        sheet = pdf.new_page(width=width, height=height)
        image = _safe_path(doc_dir, page.get("image"))
        if image is not None:
            sheet.insert_image(sheet.rect, filename=str(image))
        if page.get("layout") or page.get("erasers"):
            sheet.insert_font(fontname="doc", fontfile=FONT)
            if Path(FONT_BOLD).is_file():
                sheet.insert_font(fontname="doc-bold", fontfile=FONT_BOLD)
        for eraser in page.get("erasers") or []:
            _fill(sheet, eraser, eraser.get("color") or "#ffffff")
        covered = set()
        for region in page.get("regions") or []:
            if region.get("kind") != "section" or not _region_moved(region):
                continue
            _fill(sheet, region.get("origin") or region, "#ffffff")
            if image is not None:
                _stamp_region(sheet, image, region, width, height)
            covered.update(region.get("blockIds") or [])
        for block in page.get("layout") or []:
            if block.get("id") in covered:
                if _text_changed(block):
                    _fill(sheet, block, block.get("bg") or "#ffffff")
                    _write_text(sheet, block)
                continue
            if _dirty(block):
                _fill(sheet, block.get("origin") or block, block.get("bg") or "#ffffff")
            if block.get("type") == "image":
                path = _safe_path(doc_dir, block.get("src"))
                if path is not None:
                    sheet.insert_image(_rect(block), filename=str(path))
            elif _dirty(block):
                _write_text(sheet, block)
        for link in page.get("links") or []:
            rect = pymupdf.Rect(link["x"], link["y"], link["x"] + link["w"], link["y"] + link["h"])
            if link.get("href"):
                sheet.insert_link({"kind": pymupdf.LINK_URI, "from": rect, "uri": link["href"]})
    if pdf.page_count == 0:
        pdf.new_page()
    pdf.save(dest)
    pdf.close()


def _region_moved(region: dict) -> bool:
    origin = region.get("origin") or {}
    return any(abs(float(region.get(key) or 0) - float(origin.get(key) or 0)) > 0.6 for key in ("x", "y", "w", "h"))


def _text_changed(block: dict) -> bool:
    return block.get("type") == "text" and (block.get("text") or "") != (block.get("original") or "")


def _stamp_region(sheet, image: Path, region: dict, width: float, height: float) -> None:
    origin = region.get("origin") or region
    pix = pymupdf.Pixmap(str(image))
    scale_x = pix.width / width
    scale_y = pix.height / height
    clip = pymupdf.IRect(
        max(0, int(float(origin["x"]) * scale_x)),
        max(0, int(float(origin["y"]) * scale_y)),
        min(pix.width, int((float(origin["x"]) + float(origin["w"])) * scale_x)),
        min(pix.height, int((float(origin["y"]) + float(origin["h"])) * scale_y)),
    )
    if clip.width < 1 or clip.height < 1:
        return
    sheet.insert_image(_rect(region), pixmap=pymupdf.Pixmap(pix, clip))


def _dirty(block: dict) -> bool:
    if block.get("added") or not block.get("origin"):
        return True
    origin = block["origin"]
    moved = any(abs(float(block.get(key) or 0) - float(origin.get(key) or 0)) > 0.6 for key in ("x", "y", "w", "h"))
    if moved:
        return True
    if block.get("type") == "text":
        return (block.get("text") or "") != (block.get("original") or "")
    if block.get("type") == "image":
        return block.get("src") != block.get("originalSrc")
    return False


def _write_text(sheet, block: dict) -> None:
    text = str(block.get("text") or "")
    if not text.strip():
        return
    size = float(block.get("size") or 10)
    color = _rgb(block.get("color") or "#000000")
    font = "doc-bold" if block.get("bold") else "doc"
    if block.get("vertical"):
        sheet.insert_text(
            pymupdf.Point(float(block["x"]) + float(block["w"]) * 0.8, float(block["y"]) + float(block["h"])),
            text.replace("\n", " "),
            fontname=font,
            fontsize=size,
            color=color,
            rotate=90,
        )
        return
    sheet.insert_textbox(_rect(block), text, fontname=font, fontsize=size, color=color, align=0)


def _fill(sheet, box, color) -> None:
    pad = 0.8
    rect = pymupdf.Rect(
        float(box["x"]) - pad,
        float(box["y"]) - pad,
        float(box["x"]) + float(box["w"]) + pad,
        float(box["y"]) + float(box["h"]) + pad,
    )
    sheet.draw_rect(rect, color=None, fill=_rgb(color), width=0)


def _rect(box) -> pymupdf.Rect:
    return pymupdf.Rect(
        float(box["x"]),
        float(box["y"]),
        float(box["x"]) + float(box["w"]),
        float(box["y"]) + float(box["h"]),
    )


def _rgb(value) -> tuple:
    text = str(value or "#ffffff").lstrip("#")
    if len(text) != 6:
        return (1, 1, 1)
    return tuple(int(text[index:index + 2], 16) / 255 for index in (0, 2, 4))


def _safe_path(doc_dir: Path, src) -> Path | None:
    if not src:
        return None
    relative = str(src).split("?", 1)[0].lstrip("/")
    if ".." in relative.split("/"):
        return None
    path = (doc_dir / relative).resolve()
    root = doc_dir.resolve()
    if not str(path).startswith(str(root)) or not path.is_file():
        return None
    return path
