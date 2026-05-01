import path from "node:path";
import { withClient } from "./lib/db.mjs";
import { buildDoclingInputFromLocalFile, submitRunpodJob } from "./lib/runpod.mjs";
import { createS3Client, parseS3Uri, presignReadUrl } from "./lib/object-storage.mjs";

const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? "1");
const s3Client = createS3Client();

await withClient(async (client) => {
  const jobs = await client.query(
    `select
       j.id as job_id,
       j.document_revision_id,
       r.source_path,
       r.storage_uri,
       r.mime_type,
       d.title
     from ingestion_jobs j
     join document_revisions r on r.id = j.document_revision_id
     join documents d on d.id = r.document_id
     where j.status = 'queued'
       and j.job_type = 'docling_extract'
     order by j.priority asc, j.queued_at asc
     limit $1`,
    [limit]
  );

  for (const job of jobs.rows) {
    let input;
    const baseInput = {
      filename: path.basename(job.source_path),
      source_path: job.source_path,
      mime_type: job.mime_type,
      document_title: job.title,
      output_format: "markdown_json"
    };

    if (parseS3Uri(job.storage_uri)) {
      input = {
        ...baseInput,
        file_url: await presignReadUrl(s3Client, job.storage_uri, 60 * 60 * 6)
      };
    } else {
      const localPath = job.storage_uri?.startsWith("file://")
        ? job.storage_uri.slice("file://".length)
        : null;

      if (!localPath) {
        throw new Error(`Revision ${job.document_revision_id} does not have a usable storage URI.`);
      }

      input = await buildDoclingInputFromLocalFile(localPath, baseInput);
    }

    const submitted = await submitRunpodJob(input);
    const runpodJobId = submitted.id ?? submitted.jobId;

    if (!runpodJobId) {
      throw new Error(`RunPod did not return a job id: ${JSON.stringify(submitted)}`);
    }

    await client.query(
      `update ingestion_jobs
       set status = 'running',
           runpod_job_id = $1,
           attempt_count = attempt_count + 1,
           started_at = coalesce(started_at, now()),
           updated_at = now()
       where id = $2`,
      [runpodJobId, job.job_id]
    );

    await client.query(
      `update document_revisions
       set ingestion_status = 'running',
           extraction_status = 'running',
           docling_job_id = $1,
           updated_at = now()
       where id = $2`,
      [runpodJobId, job.document_revision_id]
    );

    console.log(
      JSON.stringify({
        queuedJobId: job.job_id,
        runpodJobId,
        sourcePath: job.source_path
      })
    );
  }
});
