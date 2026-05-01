import { withClient } from "../scripts/lib/db.mjs";

export async function searchPolicies({ query, limit = 8, documentId = null }) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `
      with q as (
        select websearch_to_tsquery('english', $1) as tsq
      )
      select c.id as chunk_id,
             c.document_id,
             c.document_revision_id,
             d.title,
             r.source_path,
             r.storage_uri,
             c.heading_path,
             c.chunk_index,
             c.content_kind,
             c.char_count,
             ts_rank_cd(c.search_text, q.tsq) as lexical_score,
             left(regexp_replace(c.text, '\\s+', ' ', 'g'), 1200) as snippet
      from chunks c
      join q on true
      join documents d on d.id = c.document_id
      join document_revisions r on r.id = c.document_revision_id
      where c.search_text @@ q.tsq
        and ($3::uuid is null or c.document_id = $3::uuid)
      order by lexical_score desc, d.title asc, c.chunk_index asc
      limit $2
      `,
      [query, limit, documentId]
    );

    return rows;
  });
}

export async function fetchChunk({ chunkId }) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `
      select c.id as chunk_id,
             c.document_id,
             c.document_revision_id,
             d.title,
             r.source_path,
             r.storage_uri,
             c.heading_path,
             c.chunk_index,
             c.content_kind,
             c.text,
             c.metadata
      from chunks c
      join documents d on d.id = c.document_id
      join document_revisions r on r.id = c.document_revision_id
      where c.id = $1
      `,
      [chunkId]
    );

    return rows[0] ?? null;
  });
}

export async function fetchDocument({ documentId }) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `
      select d.id as document_id,
             d.title,
             d.source_path,
             d.policy_area,
             d.issuing_body,
             d.effective_year,
             d.summary,
             r.id as revision_id,
             r.storage_uri,
             r.extraction_status,
             r.chunking_status,
             r.extraction_quality,
             r.review_flag,
             r.quality_notes,
             r.docling_payload,
             count(c.id)::int as chunk_count
      from documents d
      join document_revisions r on r.id = d.latest_revision_id
      left join chunks c on c.document_revision_id = r.id
      where d.id = $1
      group by d.id, r.id
      `,
      [documentId]
    );

    return rows[0] ?? null;
  });
}

export async function corpusStats() {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `
      select
        (select count(*)::int from documents) as documents,
        (select count(*)::int from document_revisions where extraction_status = 'completed') as extracted,
        (select count(*)::int from document_revisions where chunking_status = 'completed') as chunked,
        (select count(*)::int from chunks) as chunks,
        (select count(*)::int from document_revisions where review_flag = true) as review_flagged,
        (select count(*)::int from ingestion_jobs where status = 'failed') as failed_jobs,
        (select count(*)::int from ingestion_jobs where status = 'queued') as queued_jobs,
        (select count(*)::int from ingestion_jobs where status = 'running') as running_jobs
      `
    );

    return rows[0];
  });
}
