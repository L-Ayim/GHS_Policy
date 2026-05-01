# GHS One-Time Corpus Build Worker

This worker is intended for a persistent RunPod pod, not serverless.

It builds the frozen Ghana Health Service corpus once:

1. claim queued extraction jobs from Neon
2. download originals from Tigris
3. run Docling with OCR/table/image options
4. store full extraction artifacts in Tigris
5. update Neon statuses and quality metadata

## Recommended Pod

Use a pro-grade 48 GB GPU pod:

- L40S 48 GB preferred
- RTX 6000 Ada 48 GB
- A40 48 GB
- RTX A6000 48 GB

Recommended pod resources:

- 16+ vCPU
- 90+ GB RAM
- 250-500 GB disk
- PyTorch CUDA template
- persistent pod

## Pod Setup

```bash
apt-get update
apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-eng libreoffice curl git

cd /workspace
python -m venv ghs-corpus
source /workspace/ghs-corpus/bin/activate
pip install --upgrade pip
pip install -r /workspace/Ghana\ Health\ Service/workers/pod-batch/requirements.txt
```

Set environment variables on the pod:

```bash
export DATABASE_URL='postgresql://...'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
export AWS_ENDPOINT_URL_S3='https://fly.storage.tigris.dev'
export AWS_REGION='auto'
export BUCKET_NAME='ancient-sun-4815'
export GHS_WORKER_DIR='/workspace/ghs-corpus-work'
```

## Pilot Batch

Run a small first pass:

```bash
python workers/pod-batch/run_corpus_build.py --limit 5
```

Inspect:

- `extractions/ghana-health-service/{revisionId}/docling.md`
- `extractions/ghana-health-service/{revisionId}/docling.json`
- `extractions/ghana-health-service/{revisionId}/qa-report.json`

## Full Batch

```bash
python workers/pod-batch/run_corpus_build.py --limit 200
```

Re-run failed/weak documents after tuning OCR settings.

## Artifact Layout

```text
sources/ghana-health-service/{source-path}
extractions/ghana-health-service/{revisionId}/docling.json
extractions/ghana-health-service/{revisionId}/docling.md
extractions/ghana-health-service/{revisionId}/qa-report.json
```

Future enrichment can add:

```text
extractions/ghana-health-service/{revisionId}/pages/page-{n}.png
extractions/ghana-health-service/{revisionId}/images/picture-{n}.png
extractions/ghana-health-service/{revisionId}/tables/table-{n}.json
```
