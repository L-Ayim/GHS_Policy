import process from "node:process";
import { withClient } from "./lib/db.mjs";

const confirm = process.argv.includes("--yes");
const requeue = !process.argv.includes("--no-requeue");

if (!confirm) {
  console.error("Refusing to reset without --yes.");
  console.error("This preserves documents and Tigris source URIs, but clears extraction/chunking/job state.");
  process.exit(1);
}

await withClient(async (client) => {
  await client.query("begin");

  try {
    await client.query("delete from answer_citations");
    await client.query("delete from answer_records");
    await client.query("delete from retrieval_candidates");
    await client.query("delete from retrieval_traces");
    await client.query("delete from evidence_artifacts");
    await client.query("delete from citation_spans");
    await client.query("delete from chunks");
    await client.query("delete from document_sections");
    await client.query("delete from ingestion_jobs");

    await client.query(`
      update document_revisions
      set ingestion_status = 'pending',
          extraction_status = 'pending',
          chunking_status = 'pending',
          embedding_status = 'not_started',
          extraction_engine = null,
          extraction_quality = null,
          review_flag = false,
          quality_notes = null,
          page_count = null,
          docling_job_id = null,
          docling_payload = null,
          understanding_status = 'not_started',
          understanding_engine = null,
          understanding_payload = null,
          understanding_completed_at = null,
          updated_at = now()
    `);

    await client.query(`
      update documents
      set status = 'uploaded',
          summary = null,
          policy_area = null,
          issuing_body = null,
          effective_year = null,
          audience = null,
          tags = '{}',
          updated_at = now()
    `);

    let queuedJobs = 0;

    if (requeue) {
      const inserted = await client.query(`
        insert into ingestion_jobs (
          document_revision_id,
          job_type,
          status,
          priority,
          input
        )
        select id,
               'docling_extract',
               'queued',
               100,
               jsonb_build_object('sourcePath', source_path, 'storageUri', storage_uri)
        from document_revisions
        where storage_uri is not null
        returning id
      `);
      queuedJobs = inserted.rowCount;
    }

    await client.query("commit");

    console.log(JSON.stringify({
      event: "processing_state_reset",
      requeue,
      queuedJobs
    }));
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
});
