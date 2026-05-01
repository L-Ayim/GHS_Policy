import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx"]);

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");

  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }

  return hash.digest("hex");
}

export async function walkDocuments(rootDir) {
  const output = [];

  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (SUPPORTED_EXTENSIONS.has(extension)) {
        const stat = await fs.stat(fullPath);
        output.push({
          absolutePath: fullPath,
          relativePath: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
          fileName: entry.name,
          extension,
          mimeType:
            extension === ".pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: stat.size,
          modifiedAt: stat.mtime
        });
      }
    }
  }

  await visit(rootDir);
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
