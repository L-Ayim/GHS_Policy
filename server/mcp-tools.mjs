import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { optionalEnv } from "../scripts/lib/config.mjs";
import { corpusStats, fetchChunk, fetchDocument, fetchDocumentMarkdown, searchPolicies } from "./retrieval.mjs";
import { fetchDocumentSource, listUnunderstoodDocuments, saveDocumentUnderstanding } from "./understanding.mjs";

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

function internalWriteAnnotations() {
  return {
    readOnlyHint: false,
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

  if (optionalEnv("GHS_STEWARD_TOOLS", "true") === "true") {
    server.registerTool(
      "list_ununderstood_documents",
      {
        title: "List Documents Needing Understanding",
        description: "Use this during corpus setup to find GHS documents that have source files in Tigris but do not yet have GPT-generated understanding, chunks, and navigation metadata.",
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(10),
          includeReview: z.boolean().default(true)
        },
        annotations: readOnlyAnnotations()
      },
      async ({ limit, includeReview }) => textResult(await listUnunderstoodDocuments({ limit, includeReview }))
    );

    server.registerTool(
      "fetch_document_source",
      {
        title: "Fetch Document Source",
        description: "Use this during corpus setup to get a temporary signed Tigris URL for one source PDF or DOCX before creating understanding/chunks.",
        inputSchema: {
          documentId: z.string().uuid(),
          expiresIn: z.number().int().min(60).max(3600).default(900)
        },
        annotations: readOnlyAnnotations()
      },
      async ({ documentId, expiresIn }) => textResult(await fetchDocumentSource({ documentId, expiresIn }))
    );

    server.registerTool(
      "save_document_understanding",
      {
        title: "Save Document Understanding",
        description: "Use this only during corpus setup after reading a source document. Writes GPT-created metadata, outline, navigational chunks, citation spans, and quality notes into the GHS policy DB.",
        inputSchema: {
          documentId: z.string().uuid(),
          summary: z.string().min(20),
          policyArea: z.string().nullable().default(null),
          issuingBody: z.string().nullable().default(null),
          effectiveYear: z.number().int().min(1900).max(2100).nullable().default(null),
          audience: z.array(z.string()).default([]),
          tags: z.array(z.string()).default([]),
          outline: z.array(z.object({
            sectionPath: z.string().optional(),
            heading: z.string().optional(),
            summary: z.string().optional(),
            pageStart: z.number().int().optional(),
            pageEnd: z.number().int().optional()
          })).default([]),
          navigation: z.record(z.string(), z.unknown()).default({}),
          chunks: z.array(z.object({
            text: z.string().min(1),
            headingPath: z.string().nullable().optional(),
            sectionPath: z.string().nullable().optional(),
            contentKind: z.string().default("body"),
            pageStart: z.number().int().nullable().optional(),
            pageEnd: z.number().int().nullable().optional(),
            paragraphStart: z.number().int().nullable().optional(),
            paragraphEnd: z.number().int().nullable().optional(),
            tokenCount: z.number().int().nullable().optional(),
            concepts: z.array(z.string()).optional(),
            questionsAnswered: z.array(z.string()).optional(),
            locator: z.record(z.string(), z.unknown()).optional()
          })).min(1).max(300),
          quality: z.object({
            needsReview: z.boolean().default(false),
            notes: z.string().nullable().default(null),
            confidence: z.number().min(0).max(1).optional(),
            coverage: z.string().optional()
          }).default({})
        },
        annotations: internalWriteAnnotations()
      },
      async (input) => textResult(await saveDocumentUnderstanding(input))
    );
  }

  return server;
}
