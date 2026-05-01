import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { corpusStats, fetchChunk, fetchDocument, fetchDocumentMarkdown, searchPolicies } from "./retrieval.mjs";

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: typeof value === "object" && value !== null ? value : undefined
  };
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  };
}

export function createGhsMcpServer() {
  const server = new McpServer({
    name: "ghs-policy",
    version: "0.1.0"
  });

  server.registerTool(
    "search",
    {
      title: "Search GHS Policies",
      description: "Use this when the user asks anything that may require Ghana Health Service policy evidence. Searches extracted policy chunks and returns IDs that can be passed to fetch.",
      inputSchema: {
        query: z.string().min(2).describe("The user's question or search phrase."),
        limit: z.number().int().min(1).max(20).default(8),
        documentId: z.string().uuid().nullable().default(null).describe("Optional document UUID to restrict search.")
      },
      annotations: readOnlyAnnotations()
    },
    async ({ query, limit, documentId }) => {
      const rows = await searchPolicies({ query, limit, documentId });
      return textResult({
        query,
        results: rows.map((row) => ({
          id: `chunk:${row.chunk_id}`,
          title: row.title,
          text: row.snippet,
          metadata: {
            documentId: row.document_id,
            revisionId: row.document_revision_id,
            sourcePath: row.source_path,
            headingPath: row.heading_path,
            chunkIndex: row.chunk_index,
            contentKind: row.content_kind,
            lexicalScore: row.lexical_score
          }
        }))
      });
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch GHS Policy Evidence",
      description: "Use this when ChatGPT needs to read a specific policy chunk or document returned by search. Accepts IDs such as chunk:<uuid> or doc:<uuid>.",
      inputSchema: {
        id: z.string().min(5).describe("Evidence ID from search, usually chunk:<uuid>. Also supports doc:<uuid>.")
      },
      annotations: readOnlyAnnotations()
    },
    async ({ id }) => {
      const [kind, rawId] = id.includes(":") ? id.split(":", 2) : ["chunk", id];

      if (kind === "chunk") {
        const chunk = await fetchChunk({ chunkId: rawId });
        return textResult({ id, kind, result: chunk });
      }

      if (kind === "doc" || kind === "document") {
        const document = await fetchDocument({ documentId: rawId });
        return textResult({ id, kind: "document", result: document });
      }

      throw new Error(`Unsupported fetch id kind: ${kind}`);
    }
  );

  server.registerTool(
    "corpus_stats",
    {
      title: "Corpus Stats",
      description: "Use this when checking whether the Ghana Health Service policy corpus has been extracted, chunked, and indexed.",
      annotations: readOnlyAnnotations()
    },
    async () => textResult(await corpusStats())
  );

  server.registerTool(
    "fetch_document_markdown",
    {
      title: "Fetch Full Document Markdown",
      description: "Use this when a chunk is not enough and ChatGPT needs a larger slice of the extracted document markdown from Tigris.",
      inputSchema: {
        documentId: z.string().uuid(),
        maxChars: z.number().int().min(1000).max(60000).default(20000)
      },
      annotations: readOnlyAnnotations()
    },
    async ({ documentId, maxChars }) => textResult(await fetchDocumentMarkdown({ documentId, maxChars }))
  );

  server.registerTool(
    "search_policies",
    {
      title: "Search Policies",
      description: "Compatibility alias for search. Use search for new integrations.",
      inputSchema: {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(20).default(8),
        documentId: z.string().uuid().nullable().default(null)
      },
      annotations: readOnlyAnnotations()
    },
    async ({ query, limit, documentId }) => textResult(await searchPolicies({ query, limit, documentId }))
  );

  return server;
}
