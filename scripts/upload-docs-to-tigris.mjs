import { docsDir } from "./lib/config.mjs";
import { createPool } from "./lib/db.mjs";
import { sha256File, walkDocuments } from "./lib/files.mjs";
import { bucketName, createS3Client, objectExists, s3Uri, sourceObjectKey, uploadFile } from "./lib/object-storage.mjs";

const root = docsDir();
const files = await walkDocuments(root);
const client = createS3Client();
const bucket = bucketName();
const pool = createPool();
let uploaded = 0;
let skipped = 0;
let updatedRevisions = 0;

async function retry(label, fn, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        error?.code === "ECONNRESET" ||
        error?.name === "TimeoutError" ||
        error?.$retryable ||
        (error?.$metadata?.httpStatusCode && error.$metadata.httpStatusCode >= 500);

      if (!retryable || attempt === attempts) {
        throw error;
      }

      const delayMs = 1000 * attempt * attempt;
      console.warn(`${label} failed on attempt ${attempt}; retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

try {
  for (const file of files) {
    const key = sourceObjectKey(file.relativePath);
    const uri = s3Uri(bucket, key);
    const checksum = await sha256File(file.absolutePath);
    const exists = await retry(`head ${file.relativePath}`, () => objectExists(client, bucket, key));

    if (!exists) {
      await retry(`upload ${file.relativePath}`, () =>
        uploadFile(client, {
          bucket,
          key,
          filePath: file.absolutePath,
          contentType: file.mimeType,
          metadata: {
            checksum_sha256: checksum,
            source_path: encodeURIComponent(file.relativePath)
          }
        })
      );
      uploaded += 1;
    } else {
      skipped += 1;
    }

    const result = await retry(`db update ${file.relativePath}`, () =>
      pool.query(
      `update document_revisions
       set storage_uri = $1,
           updated_at = now()
       where source_path = $2
         and checksum_sha256 = $3
       returning id`,
        [uri, file.relativePath, checksum]
      )
    );
    updatedRevisions += result.rowCount ?? 0;

    console.log(JSON.stringify({ sourcePath: file.relativePath, uri, uploaded: !exists }));
  }
} finally {
  await pool.end();
}

console.log(
  JSON.stringify(
    {
      docsDir: root,
      bucket,
      uploaded,
      skipped,
      updatedRevisions
    },
    null,
    2
  )
);
