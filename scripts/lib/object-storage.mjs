import fs from "node:fs";
import path from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { optionalEnv, requireEnv } from "./config.mjs";

export function bucketName() {
  return requireEnv("BUCKET_NAME");
}

export function createS3Client() {
  return new S3Client({
    region: optionalEnv("AWS_REGION", "auto"),
    endpoint: requireEnv("AWS_ENDPOINT_URL_S3"),
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY")
    }
  });
}

export function sourceObjectKey(relativePath) {
  return `sources/ghana-health-service/${relativePath.replace(/\\/g, "/")}`;
}

export function s3Uri(bucket, key) {
  return `s3://${bucket}/${key}`;
}

export function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri ?? "");

  if (!match) {
    return null;
  }

  return {
    bucket: match[1],
    key: match[2]
  };
}

export async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
      return false;
    }
    throw error;
  }
}

export async function uploadFile(client, params) {
  const body = fs.createReadStream(params.filePath);
  await client.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: body,
      ContentType: params.contentType,
      Metadata: params.metadata
    })
  );
}

export async function presignReadUrl(client, uri, expiresIn = 3600) {
  const parsed = parseS3Uri(uri);

  if (!parsed) {
    throw new Error(`Expected s3:// URI, got ${uri}`);
  }

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key
    }),
    { expiresIn }
  );
}
