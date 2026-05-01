import { docsDir } from "./lib/config.mjs";
import { sha256File, walkDocuments } from "./lib/files.mjs";

const root = docsDir();
const files = await walkDocuments(root);
let totalBytes = 0;
const byExtension = new Map();

for (const file of files) {
  totalBytes += file.sizeBytes;
  byExtension.set(file.extension, (byExtension.get(file.extension) ?? 0) + 1);
}

console.log(`Documents directory: ${root}`);
console.log(`Supported documents: ${files.length}`);
console.log(`Total size: ${totalBytes} bytes`);
console.log("By extension:");
for (const [extension, count] of [...byExtension.entries()].sort()) {
  console.log(`  ${extension}: ${count}`);
}

console.log("\nFirst 20 documents:");
for (const file of files.slice(0, 20)) {
  console.log(`  ${file.relativePath}`);
}

if (process.argv.includes("--hash")) {
  console.log("\nChecksums:");
  for (const file of files) {
    console.log(`${await sha256File(file.absolutePath)}  ${file.relativePath}`);
  }
}
