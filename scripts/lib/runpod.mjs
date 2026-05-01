import fs from "node:fs/promises";
import { optionalEnv, requireEnv } from "./config.mjs";

const RUNPOD_REST_BASE = "https://rest.runpod.io/v1";
const RUNPOD_SERVERLESS_BASE = "https://api.runpod.ai/v2";

function runpodHeaders() {
  return {
    Authorization: `Bearer ${requireEnv("RUNPOD_API_KEY")}`,
    "Content-Type": "application/json"
  };
}

async function assertOk(response) {
  if (response.ok) {
    return response;
  }

  const body = await response.text().catch(() => "");
  throw new Error(`RunPod request failed: ${response.status} ${response.statusText} ${body}`);
}

export async function listRunpodEndpoints() {
  const response = await assertOk(
    await fetch(`${RUNPOD_REST_BASE}/endpoints?includeTemplate=true&includeWorkers=true`, {
      headers: runpodHeaders()
    })
  );
  return response.json();
}

export async function submitRunpodJob(input) {
  const endpointId = optionalEnv("RUNPOD_DOCLING_ENDPOINT_ID");

  if (!endpointId) {
    throw new Error("Missing RUNPOD_DOCLING_ENDPOINT_ID. Run npm run runpod:endpoints or create a Docling endpoint first.");
  }

  const response = await assertOk(
    await fetch(`${RUNPOD_SERVERLESS_BASE}/${endpointId}/run`, {
      method: "POST",
      headers: runpodHeaders(),
      body: JSON.stringify({ input })
    })
  );
  return response.json();
}

export async function getRunpodJobStatus(jobId) {
  const endpointId = optionalEnv("RUNPOD_DOCLING_ENDPOINT_ID");

  if (!endpointId) {
    throw new Error("Missing RUNPOD_DOCLING_ENDPOINT_ID.");
  }

  const response = await assertOk(
    await fetch(`${RUNPOD_SERVERLESS_BASE}/${endpointId}/status/${jobId}`, {
      headers: runpodHeaders()
    })
  );
  return response.json();
}

export async function buildDoclingInputFromLocalFile(filePath, metadata = {}) {
  const stat = await fs.stat(filePath);
  const maxInlineBytes = Number(optionalEnv("RUNPOD_INLINE_FILE_MAX_BYTES", `${8 * 1024 * 1024}`));

  if (stat.size > maxInlineBytes) {
    throw new Error(
      `File is ${stat.size} bytes, above inline limit ${maxInlineBytes}. Use a signed download URL/object storage path for this file.`
    );
  }

  const bytes = await fs.readFile(filePath);
  return {
    ...metadata,
    file_base64: bytes.toString("base64")
  };
}
