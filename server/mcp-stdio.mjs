import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { corpusStats, fetchChunk, fetchDocument, searchPolicies } from "./retrieval.mjs";

function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: "ghana-health-policy-corpus",
  version: "0.1.0"
});

server.registerTool(
  "corpus_stats",
  {
    title: "Corpus Stats",
    description: "Read high-level ingestion, chunking, and review counts for the Ghana Health Service policy corpus.",
    annotations: { readOnlyHint: true }
  },
  async () => jsonContent(await corpusStats())
);

server.registerTool(
  "search_policies",
  {
    title: "Search Policies",
    description: "Search Ghana Health Service policy chunks and return ranked snippets with document and chunk ids.",
    inputSchema: {
      query: z.string().min(2).describe("User question or search phrase."),
      limit: z.number().int().min(1).max(20).default(8),
      documentId: z.string().uuid().nullable().default(null)
    },
    annotations: { readOnlyHint: true }
  },
  async ({ query, limit, documentId }) => jsonContent(await searchPolicies({ query, limit, documentId }))
);

server.registerTool(
  "fetch_chunk",
  {
    title: "Fetch Chunk",
    description: "Fetch the full text and metadata for one retrieved policy chunk.",
    inputSchema: {
      chunkId: z.string().uuid()
    },
    annotations: { readOnlyHint: true }
  },
  async ({ chunkId }) => jsonContent(await fetchChunk({ chunkId }))
);

server.registerTool(
  "fetch_document",
  {
    title: "Fetch Document",
    description: "Fetch metadata and extraction artifact links for a policy document.",
    inputSchema: {
      documentId: z.string().uuid()
    },
    annotations: { readOnlyHint: true }
  },
  async ({ documentId }) => jsonContent(await fetchDocument({ documentId }))
);

await server.connect(new StdioServerTransport());
