import { withClient } from "../scripts/lib/db.mjs";
import { createS3Client, presignReadUrl } from "../scripts/lib/object-storage.mjs";

export async function listUnunderstoodDocuments({ limit = 10, includeReview = true } = {}) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `
      select d.id as document_id,
             d.title,
             d.source_path,
             d.mime_type,
             d.status as document_status,
             r.id as revision_id,
             r.storage_uri,
             r.file_size_bytes,
             r.understanding_status,
             r.extraction_status,
             r.chunking_status,
             r.review_flag,
             r.quality_notes,
             r.updated_at
      from documents d
      join document_revisions r on r.id = d.latest_revision_id
      where r.storage_uri is not null
        and (
          r.understanding_status <> 'completed'
          or ($2::boolean = true and r.review_flag = true)
        )
      order by
        case r.understanding_status
          when 'not_started' then 0
          when 'needs_review' then 1
          when 'failed' then 2
          else 3
        end,
        r.file_size_bytes asc,
        d.title asc
      limit $1
      `,
      [limit, includeReview]
    );

    return rows.map((row) => ({
      id: `doc:${row.document_id}`,
      revisionId: row.revision_id,
      title: row.title,
      sourcePath: row.source_path,
      mimeType: row.mime_type,
      fileSizeBytes: Number(row.file_size_bytes),
      storageUri: row.storage_uri,
      understandingStatus: row.understanding_status,
      extractionStatus: row.extraction_status,
      chunkingStatus: row.chunking_status,
      reviewFlag: row.review_flag,
      qualityNotes: row.quality_notes
    }));
  });
}

export async function fetchDocumentSource({ documentId, expiresIn = 900 }) {
  return withClient(async (client) => {
    const { rows } = await client.query(
      `
      select d.id as document_id,
             d.title,
             d.source_path,
             d.mime_type,
             r.id as revision_id,
             r.storage_uri,
             r.checksum_sha256,
             r.file_size_bytes,
             r.understanding_status
      from documents d
      join document_revisions r on r.id = d.latest_revision_id
      where d.id = $1
      `,
      [documentId]
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: `doc:${row.document_id}`,
      documentId: row.document_id,
      revisionId: row.revision_id,
      title: row.title,
      sourcePath: row.source_path,
      mimeType: row.mime_type,
      fileSizeBytes: Number(row.file_size_bytes),
      checksumSha256: row.checksum_sha256,
      storageUri: row.storage_uri,
      signedUrl: await presignReadUrl(createS3Client(), row.storage_uri, expiresIn),
      signedUrlExpiresInSeconds: expiresIn,
      understandingStatus: row.understanding_status
    };
  });
}

export async function saveDocumentUnderstanding(input) {
  const {
    documentId,
    summary,
    policyArea = null,
    issuingBody = null,
    effectiveYear = null,
    audience = [],
    tags = [],
    outline = [],
    navigation = {},
    chunks = [],
    quality = {}
  } = input;

  if (!chunks.length) {
    throw new Error("At least one chunk is required.");
  }

  if (chunks.length > 300) {
    throw new Error("Too many chunks in one save. Split the document into at most 300 chunks.");
  }

  return withClient(async (client) => {
    await client.query("begin");

    try {
      const doc = await client.query(
        `
        select d.id as document_id,
               d.latest_revision_id as revision_id,
               d.source_path
        from documents d
        where d.id = $1
        for update
        `,
        [documentId]
      );

      if (doc.rowCount === 0) {
        throw new Error(`Unknown document: ${documentId}`);
      }

      const { revision_id: revisionId, source_path: sourcePath } = doc.rows[0];

      await client.query("delete from citation_spans where chunk_id in (select id from chunks where document_revision_id = $1)", [
        revisionId
      ]);
      await client.query("delete from chunks where document_revision_id = $1", [revisionId]);
      await client.query("delete from document_sections where document_revision_id = $1", [revisionId]);

      const sectionByPath = new Map();

      for (let i = 0; i < outline.length; i++) {
        const section = outline[i];
        const sectionPath = section.sectionPath || section.heading || `Section ${i + 1}`;
        const inserted = await client.query(
          `
          insert into document_sections (
            document_revision_id,
            section_path,
            heading,
            ordinal,
            page_start,
            page_end,
            summary
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          returning id
          `,
          [
            revisionId,
            sectionPath,
            section.heading ?? sectionPath.split(" > ").at(-1),
            i,
            section.pageStart ?? null,
            section.pageEnd ?? null,
            section.summary ?? null
          ]
        );
        sectionByPath.set(sectionPath, inserted.rows[0].id);
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const text = String(chunk.text ?? "").trim();

        if (!text) {
          throw new Error(`Chunk ${i} has no text.`);
        }

        const headingPath = chunk.headingPath ?? chunk.sectionPath ?? null;
        const sectionId = headingPath ? sectionByPath.get(headingPath) ?? null : null;
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
            page_start,
            page_end,
            paragraph_start,
            paragraph_end,
            heading_path,
            content_kind,
            metadata
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
          returning id
          `,
          [
            documentId,
            revisionId,
            sectionId,
            i,
            text,
            chunk.tokenCount ?? Math.ceil(text.length / 4),
            text.length,
            chunk.pageStart ?? null,
            chunk.pageEnd ?? null,
            chunk.paragraphStart ?? null,
            chunk.paragraphEnd ?? null,
            headingPath,
            chunk.contentKind ?? "body",
            JSON.stringify({
              sourcePath,
              chunker: "gpt-app-understanding-v1",
              concepts: chunk.concepts ?? [],
              questionsAnswered: chunk.questionsAnswered ?? [],
              locator: chunk.locator ?? {}
            })
          ]
        );

        const quotedText = text.slice(0, Math.min(700, text.length));
        await client.query(
          `
          insert into citation_spans (
            chunk_id,
            start_char,
            end_char,
            quoted_text,
            page_start,
            page_end,
            paragraph_start,
            paragraph_end,
            locator
          )
          values ($1, 0, $2, $3, $4, $5, $6, $7, $8::jsonb)
          `,
          [
            inserted.rows[0].id,
            quotedText.length,
            quotedText,
            chunk.pageStart ?? null,
            chunk.pageEnd ?? null,
            chunk.paragraphStart ?? null,
            chunk.paragraphEnd ?? null,
            JSON.stringify({
              headingPath,
              sourcePath,
              locator: chunk.locator ?? {}
            })
          ]
        );
      }

      await client.query(
        `
        update documents
        set summary = $2,
            policy_area = $3,
            issuing_body = $4,
            effective_year = $5,
            audience = $6,
            tags = $7,
            status = 'understood',
            updated_at = now()
        where id = $1
        `,
        [documentId, summary, policyArea, issuingBody, effectiveYear, audience, tags]
      );

      const payload = {
        summary,
        policyArea,
        issuingBody,
        effectiveYear,
        audience,
        tags,
        outline,
        navigation,
        quality,
        chunkCount: chunks.length
      };

      await client.query(
        `
        update document_revisions
        set understanding_status = $2,
            understanding_engine = 'gpt-app',
            understanding_payload = $3::jsonb,
            understanding_completed_at = now(),
            chunking_status = 'completed',
            embedding_status = 'pending',
            review_flag = $4,
            quality_notes = $5,
            updated_at = now()
        where id = $1
        `,
        [
          revisionId,
          quality.needsReview ? "needs_review" : "completed",
          JSON.stringify(payload),
          Boolean(quality.needsReview),
          quality.notes ?? null
        ]
      );

      await client.query(
        `
        insert into document_understanding_runs (
          document_revision_id,
          status,
          actor,
          input,
          output,
          completed_at
        )
        values ($1, 'completed', 'gpt_app', $2::jsonb, $3::jsonb, now())
        `,
        [
          revisionId,
          JSON.stringify({ documentId }),
          JSON.stringify({ chunkCount: chunks.length, quality })
        ]
      );

      await client.query("commit");

      return {
        documentId,
        revisionId,
        status: quality.needsReview ? "needs_review" : "completed",
        chunkCount: chunks.length
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
