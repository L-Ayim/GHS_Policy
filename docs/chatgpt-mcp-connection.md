# GHS Policy ChatGPT MCP Connection

## Shape

This app is a tool-only, data-first ChatGPT app. GPT does the reasoning. The MCP server only gives GPT flexible access to Ghana Health Service policy evidence.

The server exposes Streamable HTTP at:

```text
POST /mcp
```

Health check:

```text
GET /health
```

## Tools

- `search`: searches extracted/chunked policy evidence and returns IDs like `chunk:<uuid>`.
- `fetch`: fetches a specific `chunk:<uuid>` or `doc:<uuid>`.
- `fetch_document_markdown`: fetches a larger slice of a document's extracted Docling markdown from Tigris.
- `corpus_stats`: checks extraction/chunking/index status.
- `search_policies`: compatibility alias for earlier local tests.

All tools are read-only.

## Local Or Pod Test

Set the existing Neon/Tigris environment variables, then run:

```bash
npm install
npm run mcp:http
```

Expected log:

```text
GHS Policy MCP server listening on http://0.0.0.0:3000/mcp
```

In another terminal:

```bash
curl http://localhost:3000/health
```

## ChatGPT Developer Mode Test

Expose the MCP server over HTTPS. For local development:

```bash
ngrok http 3000
```

Use this MCP URL in ChatGPT:

```text
https://YOUR-NGROK-DOMAIN/mcp
```

In ChatGPT:

1. Open Settings.
2. Open Apps & Connectors.
3. Enable Developer Mode under advanced settings.
4. Create a new app/connector from a remote MCP server.
5. Paste the HTTPS `/mcp` URL.
6. Save and test prompts such as:

```text
What does Ghana policy say about malaria treatment for children? Search the GHS policy corpus and cite what you used.
```

```text
Find ethical review application requirements in the Ghana Health Service corpus.
```

## Production

For production, host this server behind a stable HTTPS endpoint and set secrets as environment variables. Use `GHS_MCP_BEARER_TOKEN` if you want ChatGPT/dev clients to call the endpoint with a bearer token.

Do not expose Neon or Tigris credentials to ChatGPT. ChatGPT only sees MCP tool results.
