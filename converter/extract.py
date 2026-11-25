"""Convert a PDF into an interactive document: sections, tables, links, page images."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pymupdf

BULLETS = {"•", "·", "●", "–", "-"}


class Line:
    def __init__(self, x0, y0, x1, y1, text, size, bold, color="#000000"):
        self.x0 = x0
        self.y0 = y0
        self.x1 = x1
        self.y1 = y1
        self.text = text
        self.size = size
        self.bold = bold
        self.color = color

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2


class Block:
    def __init__(self, kind, x0, y0, x1, y1, lines=None, xref=None):
        self.kind = kind
        self.x0 = x0
        self.y0 = y0
        self.x1 = x1
        self.y1 = y1
        self.lines = lines or []
        self.xref = xref

    @property
    def width(self):
        return self.x1 - self.x0

    @property
    def height(self):
        return self.y1 - self.y0


def convert_pdf(pdf_path: Path, out_dir: Path) -> dict:
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "pages").mkdir(parents=True)
    (out_dir / "images").mkdir(parents=True)

    doc = pymupdf.open(pdf_path)
    page_count = doc.page_count
    zoom = 1.2 if page_count > 20 else 2.5
    quality = 74 if page_count > 20 else 92

    pages = []
    title = ""
    subtitle = ""
    meta = []
    labels = []
    logo = None
    footers = []
    nav = {}

    for index, page in enumerate(doc):
        model = _read_page(page)
        image_name = f"pages/{index + 1}.jpg"
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        pix.save(out_dir / image_name, jpg_quality=quality)

        figures, page_logo = _save_figures(doc, model["images"], out_dir, index, page.rect)
        if page_logo and not logo:
            logo = page_logo
        page_title, page_subtitle, page_subtitle_lines = _title_and_subtitle(
            model["blocks"], page.rect.height
        )
        if not title and page_title:
            title, subtitle = page_title, page_subtitle
        page_meta, page_labels, footer = _chrome(model, page.rect.height)
        for item in page_meta:
            if item not in meta:
                meta.append(item)
        for item in page_labels:
            if item not in labels:
                labels.append(item)
        if footer:
            footers.append(footer)

        lead, sections = _flow(
            model["blocks"],
            page.rect.width,
            page.rect.height,
            title,
            subtitle,
            index + 1,
        )
        _assign_icons(sections, _collect_icons(doc, page, model["images"], out_dir, index), model["blocks"])
        if not nav.get("navBrand"):
            nav.update({key: value for key, value in _save_nav(page, out_dir).items() if value})
        pages.append(
            {
                "number": index + 1,
                "width": round(page.rect.width, 2),
                "height": round(page.rect.height, 2),
                "image": image_name,
                "links": model["links"],
                "figures": figures,
                "lead": lead,
                "subtitle": page_subtitle_lines if "\n" in page_subtitle_lines else "",
                "sections": sections,
                "layout": _layout(page, model, figures, logo, index + 1),
                "erasers": [],
            }
        )

    fonts = _save_fonts(doc, out_dir)
    doc.close()
    text_chars = _count_text(pages)
    text_available = text_chars > 80
    notice = ""
    if not text_available:
        notice = (
            "Текст в этом PDF не извлекается: буквы переведены в кривые. "
            "Доступен просмотр листов и те ссылки, которые были в файле."
        )

    document = {
        "id": out_dir.name,
        "sourceName": pdf_path.name,
        "title": title or pdf_path.stem,
        "subtitle": subtitle,
        "meta": meta,
        "labels": labels,
        "logo": logo,
        "contacts": _contacts(footers),
        "textAvailable": text_available,
        "notice": notice,
        "pageCount": page_count,
        "pages": pages,
    }
    for key in ("navBrand", "navWidth", "navBar", "navQr"):
        if nav.get(key):
            document[key] = nav[key]
    if fonts:
        document["fonts"] = fonts
    (out_dir / "document.json").write_text(
        json.dumps(document, ensure_ascii=False),
        encoding="utf-8",
    )
    return document


def _read_page(page) -> dict:
    raw = page.get_text("dict")
    blocks = []
    for block in raw["blocks"]:
        if block["type"] == 1:
            x0, y0, x1, y1 = block["bbox"]
            blocks.append(Block("image", x0, y0, x1, y1))
            continue
        if _vertical(block):
            spans = [span for line in block["lines"] for span in line["spans"]]
            text = _clean("".join(span["text"] for span in spans))
            if text:
                x0, y0, x1, y1 = block["bbox"]
                size = max((span["size"] for span in spans), default=12)
                bold = any("Bold" in span["font"] or "bold" in span["font"] for span in spans)
                color = _hex_color(spans[0]["color"]) if spans else "#000000"
                blocks.append(Block("vertical", x0, y0, x1, y1, [Line(x0, y0, x1, y1, text, size, bold, color)]))
            continue
        lines = []
        for line in block["lines"]:
            text = _clean("".join(span["text"] for span in line["spans"]))
            if not text:
                continue
            x0, y0, x1, y1 = line["bbox"]
            size = max(span["size"] for span in line["spans"])
            bold = any("Bold" in span["font"] or "bold" in span["font"] for span in line["spans"])
            color = _hex_color(line["spans"][0]["color"])
            lines.append(Line(x0, y0, x1, y1, text, size, bold, color))
        if not lines:
            continue
        x0, y0, x1, y1 = block["bbox"]
        blocks.append(Block("text", x0, y0, x1, y1, lines))

    images = []
    for info in page.get_image_info(xrefs=True):
        box = info.get("bbox") or (0, 0, 0, 0)
        images.append(
            {
                "xref": info.get("xref"),
                "bbox": [box[0], box[1], box[2], box[3]],
                "width": info.get("width") or 0,
                "height": info.get("height") or 0,
            }
        )

    links = []
    for link in page.get_links():
        uri = link.get("uri") or ""
        href = _safe_href(uri)
        if not href:
            continue
        rect = link["from"]
        links.append(
            {
                "x": rect.x0,
                "y": rect.y0,
                "w": rect.x1 - rect.x0,
                "h": rect.y1 - rect.y0,
                "href": href,
            }
        )
    return {"blocks": blocks, "images": images, "links": links}


def _save_figures(doc, images, out_dir: Path, page_index: int, page_rect):
    figures = []
    logo = None
    seen = set()
    order = 0
    for info in images:
        xref = info["xref"]
        if not xref or xref in seen:
            continue
        seen.add(xref)
        x0, y0, x1, y1 = info["bbox"]
        x0, y0 = max(x0, page_rect.x0), max(y0, page_rect.y0)
        x1, y1 = min(x1, page_rect.x1), min(y1, page_rect.y1)
        width = x1 - x0
        height = y1 - y0
        if width < 8 or height < 8:
            continue
        is_logo = y0 < 80 and 40 < width < 180 and height < 55
        is_icon = max(width, height) < 36 and not is_logo
        if is_icon:
            continue
        order += 1
        if is_logo and logo is None:
            saved = _save_xref(doc, xref, out_dir / "images" / "logo.png")
            if saved is None:
                continue
            logo = saved.relative_to(out_dir).as_posix()
            continue
        saved = _save_xref(doc, xref, out_dir / "images" / f"p{page_index + 1}-{order}.png")
        if saved is None:
            continue
        name = saved.relative_to(out_dir).as_posix()
        figure = {
            "src": name,
            "x": round(x0, 1),
            "y": round(y0, 1),
            "w": round(width, 1),
            "h": round(height, 1),
        }
        href = _qr_href(out_dir / name, width, height)
        if href:
            figure["role"] = "qr"
            figure["href"] = href
        elif x0 < 40 and width < 55:
            continue
        figures.append(figure)
    figures.sort(key=lambda item: (item["y"], item["x"]))
    return figures, logo


def _save_nav(page, out_dir: Path) -> dict:
    bar = None
    foot = None
    for drawing in page.get_drawings():
        rect = drawing["rect"]
        fill = drawing.get("fill")
        if not fill or rect.x0 > 30 or not 24 <= rect.width <= 90:
            continue
        if fill[0] > 0.25 or fill[1] < 0.4 or fill[2] < 0.55:
            continue
        if rect.y0 < 40 and rect.height > 120:
            bar = (rect, fill)
        elif rect.y0 > page.rect.height - 120 and rect.height < 100:
            foot = rect
    brand = None
    if bar:
        rect, fill = bar
        clone = pymupdf.open()
        clone.insert_pdf(page.parent, from_page=page.number, to_page=page.number)
        target = clone[0]
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            box = pymupdf.Rect(block["bbox"])
            if box.x1 <= rect.x1 + 6 and box.y0 >= rect.y0 - 2 and box.y1 <= rect.y1 + 4:
                box.x0 -= 1
                box.y0 -= 1
                box.x1 += 1
                box.y1 += 1
                target.add_redact_annot(box, fill=fill)
        target.apply_redactions()
        pix = target.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=rect, alpha=False)
        brand = "images/nav-brand.png"
        pix.save(out_dir / brand)
        clone.close()
    return {
        "navBrand": brand,
        "navWidth": round(bar[0].width, 2) if bar else None,
        "navBar": round(bar[0].height, 2) if bar else None,
        "navQr": round(foot.height, 2) if foot else None,
    }


def _collect_icons(doc, page, images, out_dir: Path, page_index: int):
    icons = []
    seen = set()
    order = 0
    for info in images:
        xref = info.get("xref")
        if not xref or xref in seen:
            continue
        x0, y0, x1, y1 = info["bbox"]
        width, height = x1 - x0, y1 - y0
        if min(width, height) < 8 or max(width, height) >= 36:
            continue
        seen.add(xref)
        order += 1
        saved = _save_xref(doc, xref, out_dir / "images" / f"p{page_index + 1}-icon-{order}.png")
        if saved is None:
            continue
        icons.append({"src": saved.relative_to(out_dir).as_posix(), "x": x0, "y": y0})
    for drawing in page.get_drawings():
        rect = drawing["rect"]
        fill = drawing.get("fill")
        if not fill or min(fill) > 0.85:
            continue
        if not (12 <= rect.width <= 28 and 12 <= rect.height <= 28):
            continue
        if any(abs(icon["x"] - rect.x0) < 8 and abs(icon["y"] - rect.y0) < 8 for icon in icons):
            continue
        order += 1
        name = f"images/p{page_index + 1}-icon-{order}.png"
        pix = page.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=rect, alpha=False)
        pix.save(out_dir / name)
        icons.append({"src": name, "x": rect.x0, "y": rect.y0})
    return icons


def _assign_icons(sections, icons, blocks):
    headings = [block for block in blocks if block.kind == "text" and _is_heading(block)]
    used = set()
    for section in sections:
        heads = [block for block in headings if join_lines(block.lines) == section["title"]]
        if not heads:
            continue
        head = heads[0]
        headings.remove(head)
        best = None
        best_d = 10**9
        for icon in icons:
            if icon["src"] in used:
                continue
            if abs(icon["y"] - head.y0) > 26 or icon["x"] > head.x0 + 8:
                continue
            if head.x0 - icon["x"] > 48:
                continue
            distance = abs(icon["y"] - head.y0) + (head.x0 - icon["x"]) * 0.15
            if distance < best_d:
                best_d = distance
                best = icon
        if best:
            section["icon"] = best["src"]
            used.add(best["src"])


def _layout(page, model, figures, logo, page_number):
    pix = page.get_pixmap(alpha=False)
    scale_x = pix.width / page.rect.width
    scale_y = pix.height / page.rect.height

    def sample(x, y):
        px = min(max(int(x * scale_x), 0), pix.width - 1)
        py = min(max(int(y * scale_y), 0), pix.height - 1)
        red, green, blue = pix.pixel(px, py)[:3]
        return f"#{red:02x}{green:02x}{blue:02x}"

    def background(x0, y0, x1, y1, ink):
        points = (
            (x0 - 2, (y0 + y1) / 2),
            ((x0 + x1) / 2, y0 - 2),
            (x1 + 2, (y0 + y1) / 2),
            ((x0 + x1) / 2, y1 + 2),
        )
        colors = [
            sample(x, y)
            for x, y in points
            if 0 <= x <= page.rect.width and 0 <= y <= page.rect.height
        ]
        if not colors:
            return "#ffffff"
        best = max(set(colors), key=colors.count)
        if best.lower() == str(ink).lower():
            return "#ffffff"
        return best

    items = []
    index = 0

    def add(item):
        nonlocal index
        index += 1
        item["id"] = f"p{page_number}-b{index}"
        items.append(item)

    for info in model["images"]:
        x0, y0, x1, y1 = info["bbox"]
        width = x1 - x0
        height = y1 - y0
        if width < 8 or height < 8 or max(width, height) < 36:
            continue
        src = _match_src(figures, x0, y0)
        if src is None and logo and y0 < 90 and 40 < width < 180 and height < 60:
            src = logo
        if not src:
            continue
        box = _box(x0, y0, width, height)
        add(
            {
                "type": "image",
                "src": src,
                "originalSrc": src,
                **box,
                "origin": dict(box),
                "bg": background(x0, y0, x1, y1, "#000000"),
            }
        )

    for block in model["blocks"]:
        if block.kind not in ("text", "vertical"):
            continue
        text = _layout_text(block.lines)
        if not text.strip():
            continue
        line = max(block.lines, key=lambda item: len(item.text))
        box = _box(block.x0, block.y0, block.width, block.height)
        add(
            {
                "type": "text",
                "text": text,
                "original": text,
                "size": round(line.size or 10, 2),
                "bold": bool(line.bold),
                "color": line.color or "#000000",
                "vertical": block.kind == "vertical",
                **box,
                "origin": dict(box),
                "bg": background(block.x0, block.y0, block.x1, block.y1, line.color or "#000000"),
            }
        )
    items.sort(key=lambda item: (0 if item["type"] == "image" else 1, item["y"], item["x"]))
    return items


def _layout_text(lines):
    rows = []
    for line in sorted(lines, key=lambda item: (item.y0, item.x0)):
        if rows and abs(line.y0 - rows[-1][0].y0) <= 2.2:
            rows[-1].append(line)
        else:
            rows.append([line])
    parts = []
    for row in rows:
        text = " ".join(item.text.strip() for item in row if item.text.strip())
        if text:
            parts.append(text)
    return "\n".join(parts)


def _qr_href(path: Path, width: float, height: float) -> str:
    side = max(width, height)
    if side < 36 or side > 96 or abs(width - height) / side > 0.18:
        return ""
    try:
        pix = pymupdf.Pixmap(str(path))
        text, _kind = pymupdf.mupdf.fz_decode_barcode_from_pixmap2(pix.this, 0)
    except Exception:
        return ""
    text = str(text or "").strip()
    if not text or text.lower() == "unknown" or "://" not in text and not text.startswith("www."):
        return ""
    return text


def _match_src(figures, x, y):
    for figure in figures:
        if abs(figure["x"] - x) < 4 and abs(figure["y"] - y) < 4:
            return figure["src"]
    return None


def _box(x, y, width, height):
    return {
        "x": round(float(x), 1),
        "y": round(float(y), 1),
        "w": round(max(float(width), 4), 1),
        "h": round(max(float(height), 4), 1),
    }


def _hex_color(value):
    return f"#{int(value or 0) & 0xFFFFFF:06x}"


def _save_xref(doc, xref, dest: Path):
    """Write an embedded image. A soft mask is applied, so a logo is not left on black."""
    try:
        extracted = doc.extract_image(xref)
    except Exception:
        return None
    smask = extracted.get("smask") or 0
    if not smask:
        ext = extracted.get("ext") or "png"
        if ext == "jpeg":
            ext = "jpg"
        dest = dest.with_suffix("." + ext)
        dest.write_bytes(extracted["image"])
        return dest
    base = pymupdf.Pixmap(doc, xref)
    if base.alpha:
        base = pymupdf.Pixmap(base, 0)
    if base.n > 3:
        base = pymupdf.Pixmap(pymupdf.csRGB, base)
    mask = pymupdf.Pixmap(doc, smask)
    pix = pymupdf.Pixmap(base, mask)
    dest = dest.with_suffix(".png")
    pix.save(dest)
    return dest


def _save_fonts(doc, out_dir: Path) -> list:
    chosen = {}
    for page in doc:
        for item in page.get_fonts(full=True):
            xref, ext, kind, base = item[0], item[1], item[2], item[3]
            if ext not in {"ttf", "otf"} or not base:
                continue
            family, weight = _font_face(base)
            if not family or family.lower().startswith("arial"):
                continue
            score = 2 if kind == "Type0" else 1
            key = (family, weight)
            previous = chosen.get(key)
            if previous is None or score > previous[0]:
                chosen[key] = (score, xref)
    if not chosen:
        return []
    (out_dir / "fonts").mkdir(exist_ok=True)
    fonts = []
    for (family, weight), (_score, xref) in sorted(chosen.items()):
        try:
            _name, ext, _subtype, buf = doc.extract_font(xref)
        except Exception:
            continue
        if not buf:
            continue
        src = f"fonts/{family}-{weight}.{ext or 'ttf'}"
        (out_dir / src).write_bytes(buf)
        fonts.append({"family": family, "weight": weight, "src": src})
    return fonts


def _font_face(base: str):
    name = base.split("+")[-1]
    weight = 400
    if name.endswith("-Bold"):
        name = name[: -len("-Bold")]
        weight = 700
    elif name.endswith("-Regular"):
        name = name[: -len("-Regular")]
    return name, weight


def _title_and_subtitle(blocks, page_height):
    lines = [
        line
        for block in blocks
        if block.kind == "text"
        for line in block.lines
        if line.y0 < page_height * 0.32
    ]
    titles = [line for line in lines if line.bold and line.size >= 16]
    if not titles:
        return "", "", ""
    title_line = max(titles, key=lambda line: (line.size, -line.y0))
    subtitle_lines = [
        line
        for line in lines
        if line is not title_line
        and line.y0 >= title_line.y0
        and line.y0 < title_line.y0 + 70
        and line.size >= 12
        and not line.text.startswith("ТУ")
    ]
    subtitle_lines.sort(key=lambda line: (line.y0, line.x0))
    display = "\n".join(line.text.strip() for line in subtitle_lines if line.text.strip())
    return title_line.text, join_lines(subtitle_lines), display


def _chrome(model, page_height):
    meta = []
    labels = []
    footer_lines = []
    for block in model["blocks"]:
        if block.kind == "vertical":
            labels.append(block.lines[0].text)
            continue
        if block.kind != "text":
            continue
        text = join_lines(block.lines)
        if block.y0 < 70 and block.lines[0].size <= 11 and not _is_title_line(block):
            if text and text not in meta:
                meta.append(text)
        if text.startswith("ТУ ") and text not in meta:
            meta.append(text)
        if block.y0 > page_height - 58 and block.x1 < 360:
            footer_lines.extend(block.lines)
    footer = join_lines(footer_lines) if footer_lines else ""
    return meta, labels, footer


def _is_title_line(block):
    return any(line.bold and line.size >= 16 for line in block.lines)


def _flow(blocks, page_width, page_height, title, subtitle, page_number):
    body = []
    for block in _prepare_blocks(blocks):
        if block.kind != "text":
            continue
        if block.y0 > page_height - 58 and block.x1 < page_width * 0.62:
            continue
        if _is_title_block(block, title):
            continue
        text = join_lines(block.lines)
        if subtitle and text == subtitle:
            continue
        if text.startswith("ТУ ") or (block.y0 < 70 and block.lines[0].size <= 11):
            continue
        body.append(block)

    split = _column_split(body, page_width)
    columns = [[], []]
    for block in body:
        index = 0 if split is None or block.x0 < split else 1
        columns[index].append(block)

    lead = []
    sections = []
    order = 0
    for column_index, column in enumerate(columns):
        side = "left" if column_index == 0 else "right"
        if not column:
            continue
        regions, consumed = _tables(column)
        items = []
        for region in regions:
            items.append({"kind": "table", "y": region["y0"], "x": region["x0"], "table": region["table"]})
        for block in column:
            if id(block) in consumed:
                continue
            text = join_lines(block.lines)
            if _is_heading(block):
                items.append({"kind": "heading", "y": block.y0, "x": block.x0, "text": text})
                continue
            listed = _list_items(block.lines)
            if listed:
                items.append({"kind": "list", "y": block.y0, "x": block.x0, "items": listed})
                continue
            items.append({"kind": _paragraph_kind(text), "y": block.y0, "x": block.x0, "text": text})
        items.sort(key=lambda item: (item["y"], item["x"]))

        current = None
        for item in items:
            if item["kind"] == "heading":
                current = {
                    "title": item["text"],
                    "y": item["y"],
                    "x": item["x"],
                    "column": side,
                    "blocks": [],
                }
                sections.append(current)
                continue
            for payload in _expand(_payload(item)):
                if current is None:
                    lead.append(payload)
                else:
                    _append_block(current["blocks"], payload)

    cleaned = []
    for section in _order_sections(sections):
        order += 1
        cleaned.append(
            {
                "id": f"p{page_number}-s{order}",
                "title": section["title"],
                "column": section.get("column") or "left",
                "x": round(section["x"], 1),
                "y": round(section["y"], 1),
                "blocks": section["blocks"],
            }
        )
    return lead, cleaned


def _order_sections(sections):
    rows = []
    for section in sorted(sections, key=lambda item: item["y"]):
        if not rows or section["y"] - rows[-1][0]["y"] > 64:
            rows.append([section])
        else:
            rows[-1].append(section)
    ordered = []
    for row in rows:
        row.sort(key=lambda item: item["x"])
        ordered.extend(row)
    return ordered


def _append_block(blocks, payload):
    text = (payload.get("text") or "").lstrip()
    previous = blocks[-1] if blocks else None
    if (
        payload.get("type") == "paragraph"
        and previous
        and previous.get("type") == "list"
        and previous.get("items")
        and text
        and (text[0].islower() or text[0] in "«\"(")
    ):
        previous["items"][-1] = (previous["items"][-1].rstrip() + " " + text).strip()
        return
    blocks.append(payload)


def _expand(payload):
    if payload["type"] != "note":
        return [payload]
    parts = [part.strip() for part in re.split(r"\s+(?=\*{1,2}\S)", payload["text"]) if part.strip()]
    if len(parts) < 2:
        return [payload]
    return [{"type": "note", "text": part} for part in parts]


def _is_title_block(block, title):
    if not title:
        return False
    return any(line.text == title for line in block.lines)


def _prepare_blocks(blocks):
    prepared = []
    for block in _split_heading(blocks):
        prepared.extend(_split_list(block))
    return prepared


def _split_heading(blocks):
    result = []
    for block in blocks:
        lines = sorted(block.lines, key=lambda line: (line.y0, line.x0))
        if block.kind != "text" or len(lines) < 2 or not _is_heading_line(lines[0]):
            result.append(block)
            continue
        rest = lines[1:]
        if any(_is_heading_line(line) for line in rest):
            result.append(block)
            continue
        result.append(_block_from_lines([lines[0]]))
        result.append(_block_from_lines(rest))
    return result


def _split_list(block):
    if block.kind != "text":
        return [block]
    ordered = sorted(block.lines, key=lambda line: (line.y0, line.x0))
    first = next((index for index, line in enumerate(ordered) if _bullet_body(line) is not None), None)
    if first in (None, 0):
        return [block]
    return [_block_from_lines(ordered[:first]), _block_from_lines(ordered[first:])]


def _block_from_lines(lines):
    return Block(
        "text",
        min(line.x0 for line in lines),
        min(line.y0 for line in lines),
        max(line.x1 for line in lines),
        max(line.y1 for line in lines),
        lines,
    )


def _is_heading_line(line):
    text = line.text.strip()
    if not line.bold or line.size < 9.6 or line.size > 15.2:
        return False
    if len(text) < 2 or len(text) > 52 or text.endswith(".") or text.startswith("ТУ"):
        return False
    if text[:1] in "•·●–-":
        return False
    letters = [char for char in text if char.isalpha()]
    return len(letters) >= 3 and all(char.isupper() for char in letters)


def _is_heading(block):
    return len(block.lines) == 1 and _is_heading_line(block.lines[0])


def _bullet_body(line):
    text = line.text.strip()
    if not text:
        return None
    if text[0] in "•·●":
        return text[1:].strip()
    if text in {"–", "-"} and (line.x1 - line.x0) < 18:
        return ""
    return None


def _paragraph_kind(text):
    if "НЕ ДОПУСКАЕТСЯ" in text:
        return "warning"
    if text.startswith("*"):
        return "note"
    return "paragraph"


def _list_items(lines):
    ordered = sorted(lines, key=lambda item: (item.y0, item.x0))
    if not any(_bullet_body(line) is not None for line in ordered):
        return None
    items = []
    current = []
    for line in ordered:
        body = _bullet_body(line)
        if body is None:
            current.append(line)
            continue
        if current:
            items.append(join_lines(current))
        current = []
        if body:
            current.append(Line(line.x0, line.y0, line.x1, line.y1, body, line.size, line.bold, line.color))
    if current:
        items.append(join_lines(current))
    items = [item for item in items if item]
    return items or None


def _payload(item):
    if item["kind"] == "table":
        return {"type": "table", "headers": item["table"]["headers"], "rows": item["table"]["rows"]}
    if item["kind"] == "list":
        return {"type": "list", "items": item["items"]}
    return {"type": item["kind"], "text": item["text"]}


def _tables(column):
    small = [block for block in column if _is_table_candidate(block)]
    small.sort(key=lambda block: (block.y0, block.x0))
    regions = []
    for block in small:
        if regions and block.y0 - regions[-1]["y1"] <= 28:
            regions[-1]["blocks"].append(block)
            regions[-1]["y1"] = max(regions[-1]["y1"], block.y1)
            regions[-1]["y0"] = min(regions[-1]["y0"], block.y0)
            regions[-1]["x0"] = min(regions[-1]["x0"], block.x0)
        else:
            regions.append(
                {
                    "blocks": [block],
                    "y0": block.y0,
                    "y1": block.y1,
                    "x0": block.x0,
                }
            )

    consumed = set()
    built = []
    for region in regions:
        lines = [line for block in region["blocks"] for line in block.lines]
        if _column_count(lines) < 2 and not any(_column_count(block.lines) >= 2 for block in region["blocks"]):
            continue
        table = _build_table(region["blocks"])
        if not table:
            continue
        region["table"] = table
        built.append(region)
        for block in region["blocks"]:
            consumed.add(id(block))
    return built, consumed


def _is_table_candidate(block):
    if not block.lines:
        return False
    if max(line.size for line in block.lines) > 8.3:
        return False
    text = join_lines(block.lines)
    if text.startswith("*"):
        return False
    return True


def _build_table(blocks):
    groups = _y_groups(blocks)
    header = None
    data_groups = []
    for group in groups:
        lines = group["lines"]
        if header is None and lines and all(line.bold for line in lines):
            header = group
        else:
            data_groups.append(group)
    if header is None:
        return None
    columns = _header_columns(header["lines"])
    if len(columns) < 2:
        return None
    rows = []
    for group in data_groups:
        for record in _records(_baselines(group["lines"]), columns):
            cells = [join_lines(cell) for cell in record]
            if any(cells):
                rows.append(cells)
    if not rows:
        return None
    headers = [column["header"] for column in columns]
    width = len(headers)
    rows = [(row + [""] * width)[:width] for row in rows]
    return {"headers": headers, "rows": rows}


def _y_groups(blocks):
    ordered = sorted(blocks, key=lambda block: (block.y0, block.x0))
    groups = []
    for block in ordered:
        if not groups or block.y0 > groups[-1]["y1"] + 1.4:
            groups.append({"y0": block.y0, "y1": block.y1, "lines": list(block.lines)})
        else:
            groups[-1]["y1"] = max(groups[-1]["y1"], block.y1)
            groups[-1]["y0"] = min(groups[-1]["y0"], block.y0)
            groups[-1]["lines"].extend(block.lines)
    return groups


def _header_columns(lines):
    columns = []
    for line in sorted(lines, key=lambda item: item.x0):
        if columns and line.x0 <= columns[-1]["x1"] + 3:
            columns[-1]["x0"] = min(columns[-1]["x0"], line.x0)
            columns[-1]["x1"] = max(columns[-1]["x1"], line.x1)
            columns[-1]["lines"].append(line)
        else:
            columns.append({"x0": line.x0, "x1": line.x1, "lines": [line]})
    for column in columns:
        column["header"] = join_lines(column["lines"])
    return columns


def _baselines(lines, tolerance=2.8):
    rows = []
    for line in sorted(lines, key=lambda item: (item.y0, item.x0)):
        if not rows or line.y0 - rows[-1]["y0"] > tolerance:
            rows.append({"y0": line.y0, "lines": [line]})
        else:
            rows[-1]["lines"].append(line)
    return rows


def _records(baselines, columns):
    records = []
    current = [[] for _ in columns]
    last_col0 = None
    orphans = []

    def flush(copy_orphans):
        nonlocal current, orphans
        if any(current):
            records.append(current)
        fresh = [[] for _ in columns]
        if copy_orphans:
            for line in orphans:
                index = _column_index(line, columns)
                if not fresh[index]:
                    fresh[index].append(line)
        current = fresh
        orphans = []

    for row in baselines:
        placed = [(_column_index(line, columns), line) for line in row["lines"]]
        has_col0 = any(index == 0 for index, _ in placed)
        has_other = any(index > 0 for index, _ in placed)
        gap = None if last_col0 is None else row["y0"] - last_col0
        if has_col0 and has_other and gap is not None and gap > 11 and any(current):
            flush(True)
        for index, line in placed:
            current[index].append(line)
        if has_col0:
            last_col0 = row["y0"]
        else:
            orphans.extend(line for _, line in placed)
    if any(current):
        records.append(current)
    return records


def _column_index(line, columns):
    best = None
    best_overlap = 0
    for index, column in enumerate(columns):
        overlap = min(line.x1, column["x1"]) - max(line.x0, column["x0"])
        if overlap > best_overlap:
            best_overlap = overlap
            best = index
    if best is not None and best_overlap > 0:
        return best
    centers = [((column["x0"] + column["x1"]) / 2, index) for index, column in enumerate(columns)]
    return min(centers, key=lambda item: abs(item[0] - line.cx))[1]


def _column_count(lines):
    merged = []
    for line in sorted(lines, key=lambda item: item.x0):
        if merged and line.x0 <= merged[-1] + 6:
            merged[-1] = max(merged[-1], line.x1)
        else:
            merged.append(line.x1)
    return len(merged)


def _column_split(blocks, page_width):
    starts = sorted({round(block.x0) for block in blocks if block.y0 > 60})
    best_gap = 0
    split = None
    for left, right in zip(starts, starts[1:]):
        gap = right - left
        mid = (left + right) / 2
        if gap > best_gap and page_width * 0.28 < mid < page_width * 0.72:
            best_gap = gap
            split = mid
    if best_gap < 36:
        return None
    return split


def _contacts(footers):
    text = next((item for item in footers if item), "")
    phone_match = re.search(r"(?:\+7|8)\s*\(?\d{3}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}", text)
    email_match = re.search(r"[\w.+\-]+@[\w.\-]+\.\w+", text)
    site_match = re.search(r"(?:https?://|www\.)[^\s@]+\.[a-z]{2,}", text, re.I)
    phone = phone_match.group(0) if phone_match else ""
    email = email_match.group(0) if email_match else ""
    site = site_match.group(0).rstrip(".,)") if site_match else ""
    disclaimer = text
    for piece in (phone, email, site, "www."):
        if piece:
            disclaimer = disclaimer.replace(piece, " ")
    disclaimer = re.sub(r"\s+", " ", disclaimer).strip(" .")
    site_label = re.sub(r"^https?://", "", site).strip("/")
    return {
        "phone": phone,
        "phoneHref": _tel(phone) if phone else "",
        "email": email,
        "site": site_label,
        "siteHref": _site_href(site) if site else "",
        "disclaimer": disclaimer,
    }


def _tel(phone):
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    if digits:
        return "tel:+" + digits
    return ""


def _site_href(site):
    if site.startswith("http://") or site.startswith("https://"):
        return site
    return "https://" + site


def _count_text(pages):
    count = 0
    for page in pages:
        for block in page["lead"]:
            count += len(block.get("text") or "")
            count += sum(len(item) for item in block.get("items") or [])
        for section in page["sections"]:
            count += len(section["title"])
            for block in section["blocks"]:
                count += len(block.get("text") or "")
                count += sum(len(item) for item in block.get("items") or [])
                for row in block.get("rows") or []:
                    count += sum(len(cell) for cell in row)
    return count


def _vertical(block):
    for line in block.get("lines") or []:
        direction = line.get("dir") or (1, 0)
        if abs(direction[1]) > 0.5 and abs(direction[0]) < 0.5:
            return True
    return False


def _clean(text):
    text = text.replace("\u00ad", "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def join_lines(lines):
    parts = []
    for line in sorted(lines, key=lambda item: (item.y0, item.x0)):
        text = line.text.strip()
        if not text:
            continue
        stem = parts[-1][:-1] if parts and parts[-1].endswith("-") else ""
        if stem and re.search(r"[0-9A-Za-zА-Яа-яЁё]$", stem):
            # «стекло-» на конце строки — перенос. «декоративно-» и «санитарно-» — дефис слова.
            if re.search(r"(?:но|ски)$", stem, re.IGNORECASE):
                parts[-1] = stem + "-" + text
            else:
                parts[-1] = stem + text
        else:
            parts.append(text)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _safe_href(url):
    value = (url or "").strip()
    lower = value.lower()
    if lower.startswith(("http://", "https://", "mailto:", "tel:")):
        return value
    return ""


def document_id(filename: str) -> str:
    stem = Path(filename).stem
    safe = re.sub(r"[^\w.\-]+", "-", stem, flags=re.UNICODE).strip("-._")
    return (safe or "document")[:80]


if __name__ == "__main__":
    import sys

    source = Path(sys.argv[1])
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("output") / document_id(source.name)
    result = convert_pdf(source, target)
    print(result["title"])
    print(result["subtitle"])
    print("meta", result["meta"])
    print("labels", result["labels"])
    print("contacts", result["contacts"])
    print("logo", result["logo"])
    for page in result["pages"]:
        print(f"\nPAGE {page['number']} figures={len(page['figures'])} lead={len(page['lead'])}")
        for block in page["lead"]:
            print("  LEAD", block["type"], (block.get("text") or "")[:120])
        for section in page["sections"]:
            print(" *", section["title"])
            for block in section["blocks"]:
                if block["type"] == "table":
                    print("    TABLE", block["headers"])
                    for row in block["rows"]:
                        print("     -", row)
                elif block["type"] == "list":
                    for item in block["items"]:
                        print("    •", item[:140])
                else:
                    print("   ", block["type"], block["text"][:160])
