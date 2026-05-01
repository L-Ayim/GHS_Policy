import { withClient } from "./lib/db.mjs";
import { createS3Client, presignReadUrl } from "./lib/object-storage.mjs";

const s3 = createS3Client();

await withClient(async (client) => {
  const counts = await client.query(`
    select
      count(*)::int as revisions,
      count(*) filter (where storage_uri like 's3://%')::int as s3_revisions
    from document_revisions
  `);
  const sample = await client.query(`
    select d.title, r.storage_uri
    from document_revisions r
    join documents d on d.id = r.document_id
    where r.storage_uri like 's3://%'
    order by d.title
    limit 1
  `);

  if (sample.rowCount !== 1) {
    throw new Error("No S3-backed revisions found.");
  }

  const url = await presignReadUrl(s3, sample.rows[0].storage_uri, 60);
  const response = await fetch(url, { headers: { Range: "bytes=0-0" } });

  console.log(
    JSON.stringify(
      {
        ...counts.rows[0],
        sampleTitle: sample.rows[0].title,
        signedUrlGetStatus: response.status,
        contentLength: response.headers.get("content-length")
      },
      null,
      2
    )
  );
});
