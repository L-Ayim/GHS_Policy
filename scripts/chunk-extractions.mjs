import process from "node:process";
import { chunkMarkdown } from "./lib/chunking.mjs";
import { withClient } from "./lib/db.mjs";
import { createS3Client, getObjectText } from "./lib/object-storage.mjs";

const limit = Number.parseInt(process.argv[2] ?? process.env.CHUNK_LIMIT ?? "25", 10);
const s3 = createS3Client();

function markdownUri(row) {
  return row.docling_payload?.artifactUris?.docling_markdown_uri
    ?? row.job_output?.docling_markdown_uri
    ?? row.job_output?.artifactUris?.docling_markdown_uri
    ?? null;
}

async function loadCandidates(client) {
  const { rows } = await client.query(
    `
    select r.id as revision_id,
           r.document_id,
           r.source_path,
           r.docling_payload,
           j.output as job_output
    from document_revisions r
    left join lateral (
      select output
      from ingestion_jobs
      where document_revision_id = r.id
        and job_type = 'docling_extract'
        and status = 'completed'
      order by completed_at desc nulls last
      limit 1
    ) j on true
    where r.extraction_status = 'completed'
      and r.chunking_status in ('pending', 'failed')
    order by r.updated_at asc
    limit $1
    `,
    [limit]
  );

  return rows;
}

async function writeChunks(client, row, chunks) {
  await client.query("begin");

  try {
    await client.query("delete from citation_spans where chunk_id in (select id from chunks where document_revision_id = $1)", [
      row.revision_id
    ]);
    await client.query("delete from chunks where document_revision_id = $1", [row.revision_id]);
    await client.query("delete from document_sections where document_revision_id = $1", [row.revision_id]);

    const sectionByHeading = new Map();
    let sectionOrdinal = 0;

    for (const chunk of chunks) {
      let sectionId = null;

      if (chunk.headingPath) {
        sectionId = sectionByHeading.get(chunk.headingPath);

        if (!sectionId) {
          const section = await client.query(
            `
            insert into document_sections (
              document_revision_id,
              section_path,
              heading,
              ordinal
            )
            values ($1, $2, $3, $4)
            returning id
            `,
            [
              row.revision_id,
              chunk.headingPath,
              chunk.headingPath.split(" > ").at(-1),
              sectionOrdinal++
            ]
          );

          sectionId = section.rows[0].id;
          sectionByHeading.set(chunk.headingPath, sectionId);
        }
      }

      const inserted = await client.query(
        `
        insert into chunks (
          document_id,
          document_revision_id,
          section_id,
          chunk_index,
          text,
          token_count,
          char_count,
          paragraph_start,
          paragraph_end,
          heading_path,
          content_kind,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        returning id
        `,
        [
          row.document_id,
          row.revision_id,
          sectionId,
          chunk.chunkIndex,
          chunk.text,
          chunk.tokenCount,
          chunk.charCount,
          chunk.paragraphStart,
          chunk.paragraphEnd,
          chunk.headingPath,
          chunk.contentKind,
          JSON.stringify({
            sourcePath: row.source_path,
            chunker: "markdown-heading-v1"
          })
        ]
      );

      const quote = chunk.text.slice(0, Math.min(500, chunk.text.length));
      await client.query(
        `
        insert into citation_spans (
          chunk_id,
          start_char,
          end_char,
          quoted_text,
          paragraph_start,
          paragraph_end,
          locator
        )
        values ($1, 0, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          inserted.rows[0].id,
          quote.length,
          quote,
          chunk.paragraphStart,
          chunk.paragraphEnd,
          JSON.stringify({ headingPath: chunk.headingPath, sourcePath: row.source_path })
        ]
      );
    }

    await client.query(
      `
      update document_revisions
      set chunking_status = 'completed',
          embedding_status = 'pending',
          updated_at = now()
      where id = $1
      `,
      [row.revision_id]
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    await client.query(
      `
      update document_revisions
      set chunking_status = 'failed',
          quality_notes = concat_ws('; ', nullif(quality_notes, ''), $2),
          updated_at = now()
      where id = $1
      `,
      [row.revision_id, `Chunking failed: ${error.message}`]
    );
    throw error;
  }
}

await withClient(async (client) => {
  const candidates = await loadCandidates(client);

  if (candidates.length === 0) {
    console.log(JSON.stringify({ event: "no_chunking_candidates" }));
    return;
  }

  for (const row of candidates) {
    const uri = markdownUri(row);

    if (!uri) {
      console.log(JSON.stringify({ event: "chunk.skipped", sourcePath: row.source_path, reason: "missing_markdown_uri" }));
      continue;
    }

    console.log(JSON.stringify({ event: "chunk.started", sourcePath: row.source_path, uri }));
    const markdown = await getObjectText(s3, uri);
    const chunks = chunkMarkdown(markdown);
    await writeChunks(client, row, chunks);
    console.log(JSON.stringify({ event: "chunk.completed", sourcePath: row.source_path, chunks: chunks.length }));
  }
});
