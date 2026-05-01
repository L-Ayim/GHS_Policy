import base64
import json
import os
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

import runpod
from docling.document_converter import DocumentConverter


def _write_input_file(job_input):
    filename = job_input.get("filename") or "document.pdf"
    suffix = Path(filename).suffix or ".pdf"

    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    path = Path(handle.name)

    try:
        if job_input.get("file_base64"):
            handle.write(base64.b64decode(job_input["file_base64"]))
        elif job_input.get("file_url"):
            request = Request(job_input["file_url"], headers=job_input.get("headers") or {})
            with urlopen(request, timeout=120) as response:
                handle.write(response.read())
        else:
            raise ValueError("Expected either file_base64 or file_url.")
    finally:
        handle.close()

    return path


def _safe_text(value, limit=1200):
    if not value:
        return ""
    value = str(value).replace("\x00", " ").strip()
    return value[:limit]


def handler(job):
    job_input = job.get("input") or {}
    source_path = job_input.get("source_path")
    document_title = job_input.get("document_title")
    input_path = _write_input_file(job_input)

    try:
        converter = DocumentConverter()
        result = converter.convert(str(input_path))
        document = result.document
        markdown = document.export_to_markdown()
        payload = document.export_to_dict()
        pages = payload.get("pages") or []

        return {
            "source_path": source_path,
            "document_title": document_title,
            "engine": "docling",
            "markdown": markdown,
            "document": payload,
            "page_count": len(pages) if isinstance(pages, list) else None,
            "preview": _safe_text(markdown)
        }
    finally:
        try:
            input_path.unlink(missing_ok=True)
        except Exception:
            pass


runpod.serverless.start({"handler": handler})
