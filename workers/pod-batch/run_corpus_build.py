import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import boto3
import psycopg
from botocore.config import Config
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption


@dataclass
class ClaimedJob:
    job_id: str
    revision_id: str
    document_id: str
    title: str
    source_path: str
    storage_uri: str
    checksum_sha256: str
    mime_type: str


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def connect_db():
    return psycopg.connect(require_env("DATABASE_URL"))


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=require_env("AWS_ENDPOINT_URL_S3"),
        region_name=os.environ.get("AWS_REGION", "auto"),
        aws_access_key_id=require_env("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=require_env("AWS_SECRET_ACCESS_KEY"),
        config=Config(signature_version="s3v4"),
    )


def parse_s3_uri(uri: str) -> tuple[str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path:
        raise ValueError(f"Expected s3:// URI, got {uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def claim_jobs(limit: int) -> list[ClaimedJob]:
    with connect_db() as conn:
        rows = conn.execute(
            """
            with candidates as (
              select j.id
              from ingestion_jobs j
              join document_revisions r on r.id = j.document_revision_id
              where j.status = 'queued'
                and j.job_type = 'docling_extract'
                and r.storage_uri like 's3://%%'
              order by j.priority asc, j.queued_at asc
              limit %s
              for update skip locked
            )
            update ingestion_jobs j
            set status = 'running',
                attempt_count = attempt_count + 1,
                started_at = coalesce(started_at, now()),
                updated_at = now()
            from candidates
            where j.id = candidates.id
            returning j.id
            """,
            (limit,),
        ).fetchall()
        job_ids = [row[0] for row in rows]

        if not job_ids:
            return []

        result = conn.execute(
            """
            select
              j.id,
              r.id,
              d.id,
              d.title,
              r.source_path,
              r.storage_uri,
              r.checksum_sha256,
              r.mime_type
            from ingestion_jobs j
            join document_revisions r on r.id = j.document_revision_id
            join documents d on d.id = r.document_id
            where j.id = any(%s)
            order by j.started_at asc
            """,
            (job_ids,),
        ).fetchall()
        conn.commit()

    return [
        ClaimedJob(
            job_id=str(row[0]),
            revision_id=str(row[1]),
            document_id=str(row[2]),
            title=row[3],
            source_path=row[4],
            storage_uri=row[5],
            checksum_sha256=row[6],
            mime_type=row[7],
        )
        for row in result
    ]


def download_source(client, job: ClaimedJob, work_dir: Path) -> Path:
    bucket, key = parse_s3_uri(job.storage_uri)
    suffix = Path(job.source_path).suffix or ".pdf"
    target = work_dir / f"{job.revision_id}{suffix}"
    client.download_file(bucket, key, str(target))

    actual = sha256_file(target)
    if actual != job.checksum_sha256:
        raise RuntimeError(f"Checksum mismatch for {job.source_path}: expected {job.checksum_sha256}, got {actual}")

    return target


def build_converter() -> DocumentConverter:
    pdf_options = PdfPipelineOptions()
    pdf_options.do_ocr = True
    pdf_options.do_table_structure = True
    pdf_options.generate_page_images = True
    pdf_options.generate_picture_images = True
    pdf_options.images_scale = 2.0

    # Docling auto-selects the best available OCR engine when explicit options
    # are not provided. On the pod we install GPU-friendly EasyOCR/RapidOCR plus
    # Tesseract, then inspect quality reports before forcing one engine globally.
    if getattr(pdf_options, "ocr_options", None) is not None:
      pdf_options.ocr_options.lang = ["en"]

    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options)
        }
    )


def extract_with_docling(converter: DocumentConverter, source: Path) -> tuple[str, dict[str, Any]]:
    result = converter.convert(str(source))
    document = result.document
    markdown = document.export_to_markdown()
    payload = document.export_to_dict()
    return markdown, payload


def qa_report(markdown: str, payload: dict[str, Any], job: ClaimedJob) -> dict[str, Any]:
    text_chars = len(re.sub(r"\s+", "", markdown or ""))
    pages = payload.get("pages")
    page_count = len(pages) if isinstance(pages, list) else None
    tables = payload.get("tables")
    pictures = payload.get("pictures")
    quality = "good"
    notes: list[str] = []

    if text_chars < 1000:
        quality = "weak"
        notes.append("Low extracted text volume.")

    if page_count and text_chars / max(page_count, 1) < 250:
        quality = "review"
        notes.append("Low text-per-page ratio; may be scanned, poster-like, or image-heavy.")

    return {
        "documentTitle": job.title,
        "sourcePath": job.source_path,
        "textChars": text_chars,
        "pageCount": page_count,
        "tableCount": len(tables) if isinstance(tables, list) else None,
        "pictureCount": len(pictures) if isinstance(pictures, list) else None,
        "quality": quality,
        "reviewFlag": quality != "good",
        "notes": notes,
    }


def upload_text(client, key: str, text: str, content_type: str):
    client.put_object(
        Bucket=require_env("BUCKET_NAME"),
        Key=key,
        Body=text.encode("utf-8"),
        ContentType=content_type,
    )


def upload_outputs(client, job: ClaimedJob, markdown: str, payload: dict[str, Any], report: dict[str, Any]) -> dict[str, str]:
    prefix = f"extractions/ghana-health-service/{job.revision_id}"
    bucket = require_env("BUCKET_NAME")
    outputs = {
        "docling_json_uri": f"s3://{bucket}/{prefix}/docling.json",
        "docling_markdown_uri": f"s3://{bucket}/{prefix}/docling.md",
        "qa_report_uri": f"s3://{bucket}/{prefix}/qa-report.json",
    }

    upload_text(client, f"{prefix}/docling.json", json.dumps(payload, ensure_ascii=False), "application/json")
    upload_text(client, f"{prefix}/docling.md", markdown, "text/markdown; charset=utf-8")
    upload_text(client, f"{prefix}/qa-report.json", json.dumps(report, ensure_ascii=False, indent=2), "application/json")

    return outputs


def mark_completed(job: ClaimedJob, outputs: dict[str, str], report: dict[str, Any], payload_preview: dict[str, Any]):
    with connect_db() as conn:
        with conn.transaction():
            conn.execute(
                """
                update ingestion_jobs
                set status = 'completed',
                    output = %s::jsonb,
                    completed_at = now(),
                    updated_at = now()
                where id = %s
                """,
                (json.dumps({**outputs, "qa": report}), job.job_id),
            )
            conn.execute(
                """
                update document_revisions
                set ingestion_status = 'extracted',
                    extraction_status = 'completed',
                    chunking_status = 'pending',
                    extraction_engine = 'docling-pod',
                    extraction_quality = %s,
                    review_flag = %s,
                    quality_notes = %s,
                    page_count = %s,
                    docling_payload = %s::jsonb,
                    updated_at = now()
                where id = %s
                """,
                (
                    report["quality"],
                    report["reviewFlag"],
                    "; ".join(report["notes"]),
                    report["pageCount"],
                    json.dumps(payload_preview),
                    job.revision_id,
                ),
            )
            conn.execute(
                """
                update documents
                set status = 'extracted',
                    updated_at = now()
                where id = %s
                """,
                (job.document_id,),
            )


def mark_failed(job: ClaimedJob, error: Exception):
    with connect_db() as conn:
        with conn.transaction():
            conn.execute(
                """
                update ingestion_jobs
                set status = 'failed',
                    last_error = %s,
                    completed_at = now(),
                    updated_at = now()
                where id = %s
                """,
                (str(error), job.job_id),
            )
            conn.execute(
                """
                update document_revisions
                set ingestion_status = 'failed',
                    extraction_status = 'failed',
                    review_flag = true,
                    quality_notes = %s,
                    updated_at = now()
                where id = %s
                """,
                (str(error), job.revision_id),
            )


def process_job(client, converter: DocumentConverter, job: ClaimedJob, base_work_dir: Path):
    work_dir = base_work_dir / job.revision_id
    work_dir.mkdir(parents=True, exist_ok=True)
    print(json.dumps({"event": "job.started", "sourcePath": job.source_path, "revisionId": job.revision_id}))

    try:
        source = download_source(client, job, work_dir)
        markdown, payload = extract_with_docling(converter, source)
        report = qa_report(markdown, payload, job)
        outputs = upload_outputs(client, job, markdown, payload, report)
        preview = {
            "artifactUris": outputs,
            "preview": markdown[:2000],
            "qa": report,
        }
        mark_completed(job, outputs, report, preview)
        print(json.dumps({"event": "job.completed", "sourcePath": job.source_path, "qa": report}))
    except Exception as error:
        mark_failed(job, error)
        print(json.dumps({"event": "job.failed", "sourcePath": job.source_path, "error": str(error)}))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--sleep", type=int, default=0, help="Sleep and poll again when no jobs are found.")
    args = parser.parse_args()

    base_work_dir = Path(os.environ.get("GHS_WORKER_DIR", "/workspace/ghs-corpus-work"))
    base_work_dir.mkdir(parents=True, exist_ok=True)
    client = s3_client()
    converter = build_converter()

    while True:
        jobs = claim_jobs(args.limit)
        if not jobs:
            print(json.dumps({"event": "no_jobs"}))
            if args.sleep <= 0:
                return
            time.sleep(args.sleep)
            continue

        for job in jobs:
            process_job(client, converter, job, base_work_dir)


if __name__ == "__main__":
    main()
