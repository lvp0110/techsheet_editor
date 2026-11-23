"""Local app: upload a PDF and open it as an interactive page."""

from __future__ import annotations

import json
import re
import sys
import tempfile
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract import convert_pdf, document_id
from publish import build_pdf

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = ROOT / "output"
MAX_BYTES = 80 * 1024 * 1024
ID_RE = re.compile(r"^[\w.\-]{1,80}$", re.UNICODE)


def valid_id(value: str) -> bool:
    return bool(value) and ".." not in value and bool(ID_RE.fullmatch(value))


class App(BaseHTTPRequestHandler):
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/":
            return self._file(WEB / "index.html", "text/html; charset=utf-8")
        if path == "/assets/app.css":
            return self._file(WEB / "app.css", "text/css; charset=utf-8")
        if path == "/assets/app.js":
            return self._file(WEB / "app.js", "text/javascript; charset=utf-8")
        if path == "/api/library":
            return self._json(library())
        if path.startswith("/api/docs/"):
            rest = path.removeprefix("/api/docs/")
            if rest.endswith("/export.pdf"):
                return self._export(rest.removesuffix("/export.pdf"))
            return self._document(rest)
        if path.startswith("/media/"):
            return self._media(path.removeprefix("/media/"))
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/docs/"):
            rest = path.removeprefix("/api/docs/")
            if rest.endswith("/save"):
                return self._save(rest.removesuffix("/save"))
            if rest.endswith("/image"):
                return self._upload_image(rest.removesuffix("/image"))
            if rest.endswith("/qr"):
                return self._qr(rest.removesuffix("/qr"))
        if path != "/api/convert":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._json({"error": "Файл пустой или больше 80 МБ."}, 400)
        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        try:
            if "application/json" in content_type:
                name = json.loads(body.decode("utf-8")).get("local", "")
                if "/" in name or "\\" in name or not name.lower().endswith(".pdf"):
                    return self._json({"error": "Нужен PDF из папки проекта."}, 400)
                source = ROOT / name
                if not source.is_file():
                    return self._json({"error": "Файл не найден."}, 404)
                document = run_convert(source)
            else:
                filename, data = parse_upload(body, content_type)
                if not data or not filename.lower().endswith(".pdf"):
                    return self._json({"error": "Нужен файл PDF."}, 400)
                OUT.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(suffix=".pdf", dir=OUT, delete=False) as handle:
                    handle.write(data)
                    temp_path = Path(handle.name)
                try:
                    document = run_convert(temp_path, filename)
                finally:
                    temp_path.unlink(missing_ok=True)
        except Exception as error:
            return self._json({"error": f"Не удалось разобрать PDF: {error}"}, 500)
        self._json({"id": document["id"], "title": document["title"]})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def _save(self, doc_id):
        folder = self._doc_folder(doc_id)
        if folder is None:
            return self._json({"error": "Документ не найден."}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 20 * 1024 * 1024:
            return self._json({"error": "Пустой или слишком большой документ."}, 400)
        try:
            document = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._json({"error": "Некорректный документ."}, 400)
        if not isinstance(document, dict) or not isinstance(document.get("pages"), list):
            return self._json({"error": "Некорректный документ."}, 400)
        document["id"] = doc_id
        (folder / "document.json").write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        meta_path = folder / "meta.json"
        meta = {}
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                meta = {}
        meta["id"] = doc_id
        meta["title"] = document.get("title") or meta.get("title") or doc_id
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        self._json({"ok": True})

    def _upload_image(self, doc_id):
        folder = self._doc_folder(doc_id)
        if folder is None:
            return self._json({"error": "Документ не найден."}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 15 * 1024 * 1024:
            return self._json({"error": "Картинка пустая или больше 15 МБ."}, 400)
        filename, data = parse_upload(self.rfile.read(length), self.headers.get("Content-Type", ""))
        ext = image_extension(filename, data)
        if not ext or not data:
            return self._json({"error": "Нужна картинка PNG, JPEG или WebP."}, 400)
        name = f"images/edit-{uuid.uuid4().hex[:8]}{ext}"
        (folder / name).write_bytes(data)
        self._json({"src": name})

    def _qr(self, doc_id):
        folder = self._doc_folder(doc_id)
        if folder is None:
            return self._json({"error": "Документ не найден."}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 16 * 1024:
            return self._json({"error": "Пустая или слишком длинная ссылка."}, 400)
        try:
            href = str(json.loads(self.rfile.read(length).decode("utf-8")).get("href") or "").strip()
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._json({"error": "Некорректная ссылка."}, 400)
        if not href or len(href) > 1024:
            return self._json({"error": "Нужна ссылка до 1024 символов."}, 400)
        try:
            import pymupdf
            from pymupdf import mupdf
            pix = mupdf.fz_new_barcode_pixmap(mupdf.FZ_BARCODE_QRCODE, href, 10, 2, 1, 0)
            image = pymupdf.Pixmap(pix)
            if image.alpha:
                image = pymupdf.Pixmap(image, 0)
            if image.n < 3:
                image = pymupdf.Pixmap(pymupdf.csRGB, image)
            name = f"images/qr-{uuid.uuid4().hex[:8]}.png"
            image.save(str(folder / name))
        except Exception:
            return self._json({"error": "Не удалось собрать QR-код."}, 500)
        self._json({"src": name})

    def _export(self, doc_id):
        folder = self._doc_folder(doc_id)
        if folder is None:
            return self._json({"error": "Документ не найден."}, 404)
        try:
            document = json.loads((folder / "document.json").read_text(encoding="utf-8"))
            dest = folder / "export.pdf"
            build_pdf(document, folder, dest)
        except Exception as error:
            return self._json({"error": f"Не удалось собрать PDF: {error}"}, 500)
        self._file(dest, "application/pdf")

    def _doc_folder(self, doc_id):
        if not valid_id(doc_id):
            return None
        folder = OUT / doc_id
        if not (folder / "document.json").is_file():
            return None
        return folder

    def _document(self, doc_id):
        if not valid_id(doc_id):
            return self._json({"error": "Неизвестный документ."}, 404)
        path = OUT / doc_id / "document.json"
        if not path.is_file():
            return self._json({"error": "Документ не найден."}, 404)
        self._file(path, "application/json; charset=utf-8")

    def _media(self, relative):
        parts = relative.split("/", 1)
        if len(parts) != 2 or not valid_id(parts[0]):
            self.send_error(404)
            return
        root = (OUT / parts[0]).resolve()
        target = (root / parts[1]).resolve()
        if not str(target).startswith(str(root)) or not target.is_file():
            self.send_error(404)
            return
        kind = "image/jpeg" if target.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
        self._file(target, kind)

    def _file(self, path: Path, content_type: str):
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def library():
    documents = []
    if OUT.exists():
        for meta_path in OUT.glob("*/meta.json"):
            try:
                documents.append(json.loads(meta_path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
    documents.sort(key=lambda item: item.get("created") or "", reverse=True)
    files = []
    for pdf in sorted(ROOT.glob("*.pdf")):
        files.append({"name": pdf.name, "size": pdf.stat().st_size})
    return {"documents": documents, "files": files}


def run_convert(source: Path, filename: str | None = None):
    name = filename or source.name
    doc_id = document_id(name)
    if not valid_id(doc_id):
        doc_id = "document"
    target = OUT / doc_id
    document = convert_pdf(source, target)
    document["id"] = doc_id
    (target / "document.json").write_text(
        json.dumps(document, ensure_ascii=False),
        encoding="utf-8",
    )
    meta = {
        "id": doc_id,
        "title": document["title"],
        "sourceName": name,
        "pageCount": document["pageCount"],
        "textAvailable": document["textAvailable"],
        "created": datetime.now().isoformat(timespec="seconds"),
    }
    (target / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    print(f"converted {name} -> {doc_id} ({document['pageCount']} pages)")
    return document


def image_extension(filename: str, data: bytes) -> str:
    lower = (filename or "").lower()
    if data.startswith(b"\x89PNG"):
        return ".png"
    if data.startswith(b"\xff\xd8"):
        return ".jpg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    if lower.endswith(".png"):
        return ".png"
    if lower.endswith((".jpg", ".jpeg")):
        return ".jpg"
    if lower.endswith(".webp"):
        return ".webp"
    return ""


def parse_upload(body: bytes, content_type: str):
    match = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type)
    if not match:
        return "", b""
    boundary = (match.group(1) or match.group(2)).strip().encode()
    for part in body.split(b"--" + boundary):
        if b"Content-Disposition" not in part:
            continue
        header, _, data = part.partition(b"\r\n\r\n")
        if b'name="file"' not in header:
            continue
        found = re.search(rb'filename="([^"]*)"', header)
        filename = found.group(1).decode("utf-8", "replace") if found else "upload.pdf"
        if data.endswith(b"\r\n"):
            data = data[:-2]
        return filename, data
    return "", b""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = None
    port = 8765
    for candidate in range(8765, 8771):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), App)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit("Порты 8765–8770 заняты.")
    print(f"Интерактив PDF: http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
