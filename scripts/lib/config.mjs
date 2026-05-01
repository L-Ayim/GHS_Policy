import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";

loadDotenv();

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name, fallback = null) {
  return process.env[name] || fallback;
}

export function docsDir() {
  return path.resolve(process.cwd(), optionalEnv("DOCS_DIR", "docs"));
}
