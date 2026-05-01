import { withClient } from "./lib/db.mjs";
import { getRunpodJobStatus } from "./lib/runpod.mjs";

const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? "10");

function isComplete(status) {
  return ["COMPLETED", "completed"].includes(status);
}

function isFailed(status) {
  return ["FAILED", "failed", "CANCELLED", "cancelled", "TIMED_OUT", "timed_out"].includes(status);
}

await withClient(async (client) => {
  const jobs = await client.query(
    `select id, document_revision_id, runpod_job_id
     from ingestion_jobs
     where status = 'running'
       and runpod_job_id is not null
     order by started_at asc
     limit $1`,
    [limit]
  );

  for (const job of jobs.rows) {
    const status = await getRunpodJobStatus(job.runpod_job_id);
    const statusName = status.status ?? status.state;

    if (isComplete(statusName)) {
      const output = status.output ?? status;
      await client.query("begin");
      try {
        await client.query(
          `update ingestion_jobs
           set status = 'completed',
               output = $1::jsonb,
               completed_at = now(),
               updated_at = now()
           where id = $2`,
          [JSON.stringify(output), job.id]
        );
        await client.query(
          `update document_revisions
           set ingestion_status = 'extracted',
               extraction_status = 'completed',
               extraction_engine = 'docling-runpod',
               docling_payload = $1::jsonb,
               updated_at = now()
           where id = $2`,
          [JSON.stringify(output), job.document_revision_id]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    } else if (isFailed(statusName)) {
      await client.query(
        `update ingestion_jobs
         set status = 'failed',
             output = $1::jsonb,
             last_error = $2,
             completed_at = now(),
             updated_at = now()
         where id = $3`,
        [JSON.stringify(status), status.error ?? statusName, job.id]
      );
      await client.query(
        `update document_revisions
         set ingestion_status = 'failed',
             extraction_status = 'failed',
             quality_notes = $1,
             review_flag = true,
             updated_at = now()
         where id = $2`,
        [status.error ?? statusName, job.document_revision_id]
      );
    }

    console.log(
      JSON.stringify({
        jobId: job.id,
        runpodJobId: job.runpod_job_id,
        status: statusName
      })
    );
  }
});
