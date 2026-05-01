import { docsDir } from "./lib/config.mjs";
import { withClient } from "./lib/db.mjs";
import { sha256File, walkDocuments } from "./lib/files.mjs";
import { slugify, titleFromFileName } from "./lib/slug.mjs";

const root = docsDir();
const files = await walkDocuments(root);

await withClient(async (client) => {
  await client.query("begin");

  try {
    const workspace = await client.query("select id from workspaces where slug = $1", [
      "ghana-health-service"
    ]);
    const collection = await client.query(
      `select c.id
       from collections c
       join workspaces w on w.id = c.workspace_id
       where w.slug = $1 and c.slug = $2`,
      ["ghana-health-service", "public-policy-corpus"]
    );

    if (workspace.rowCount !== 1 || collection.rowCount !== 1) {
      throw new Error("Missing default workspace/collection. Run db:migrate first.");
    }

    const workspaceId = workspace.rows[0].id;
    const collectionId = collection.rows[0].id;
    let discovered = 0;
    let newRevisions = 0;
    let unchanged = 0;

    for (const file of files) {
      const checksum = await sha256File(file.absolutePath);
      const title = titleFromFileName(file.fileName);
      const slug = slugify(title);

      const documentResult = await client.query(
        `insert into documents (
           workspace_id, collection_id, title, slug, source_path, mime_type, status
         )
         values ($1, $2, $3, $4, $5, $6, 'discovered')
         on conflict (collection_id, source_path) do update
         set title = excluded.title,
             slug = excluded.slug,
             mime_type = excluded.mime_type,
             updated_at = now()
         returning id`,
        [workspaceId, collectionId, title, slug, file.relativePath, file.mimeType]
      );
      const documentId = documentResult.rows[0].id;
      discovered += 1;

      const existingRevision = await client.query(
        "select id from document_revisions where document_id = $1 and checksum_sha256 = $2",
        [documentId, checksum]
      );

      if (existingRevision.rowCount > 0) {
        unchanged += 1;
        continue;
      }

      const nextRevision = await client.query(
        "select coalesce(max(revision_number), 0) + 1 as next_revision from document_revisions where document_id = $1",
        [documentId]
      );
      const revisionNumber = Number(nextRevision.rows[0].next_revision);
      const revision = await client.query(
        `insert into document_revisions (
           document_id,
           revision_number,
           storage_uri,
           source_path,
           checksum_sha256,
           file_size_bytes,
           mime_type,
           ingestion_status
         )
         values ($1, $2, $3, $4, $5, $6, $7, 'queued')
         returning id`,
        [
          documentId,
          revisionNumber,
          `file://${file.absolutePath}`,
          file.relativePath,
          checksum,
          file.sizeBytes,
          file.mimeType
        ]
      );
      const revisionId = revision.rows[0].id;

      await client.query(
        "update documents set latest_revision_id = $1, status = 'queued', updated_at = now() where id = $2",
        [revisionId, documentId]
      );

      await client.query(
        `insert into ingestion_jobs (
           document_revision_id, job_type, status, input, worker_hint
         )
         values ($1, 'docling_extract', 'queued', $2::jsonb, 'runpod-docling')`,
        [
          revisionId,
          JSON.stringify({
            sourcePath: file.relativePath,
            absolutePath: file.absolutePath,
            mimeType: file.mimeType,
            checksumSha256: checksum
          })
        ]
      );

      await client.query(
        `insert into audit_events (workspace_id, event_type, entity_type, entity_id, payload)
         values ($1, 'document.revision_queued', 'document_revision', $2, $3::jsonb)`,
        [
          workspaceId,
          revisionId,
          JSON.stringify({
            sourcePath: file.relativePath,
            fileSizeBytes: file.sizeBytes,
            checksumSha256: checksum
          })
        ]
      );

      newRevisions += 1;
    }

    await client.query("commit");
    console.log(
      JSON.stringify(
        {
          docsDir: root,
          discovered,
          newRevisions,
          unchanged
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
});
