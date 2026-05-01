import process from "node:process";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { optionalEnv } from "../scripts/lib/config.mjs";
import { createGhsMcpServer } from "./mcp-tools.mjs";

const port = Number.parseInt(optionalEnv("PORT", "3000"), 10);
const host = optionalEnv("HOST", "0.0.0.0");
const bearerToken = optionalEnv("GHS_MCP_BEARER_TOKEN");
const allowedHosts = optionalEnv("MCP_ALLOWED_HOSTS");

const app = createMcpExpressApp({
  host,
  allowedHosts: allowedHosts ? allowedHosts.split(",").map((value) => value.trim()).filter(Boolean) : undefined
});

function requireAuth(req, res, next) {
  if (!bearerToken) {
    next();
    return;
  }

  const header = req.headers.authorization ?? "";
  if (header !== `Bearer ${bearerToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ghs-policy-mcp",
    transport: "streamable-http",
    mcpPath: "/mcp"
  });
});

app.post("/mcp", requireAuth, async (req, res) => {
  const server = createGhsMcpServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", async () => {
      await transport.close();
      await server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use Streamable HTTP POST."
    },
    id: null
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  });
});

app.listen(port, host, (error) => {
  if (error) {
    console.error("Failed to start GHS MCP server:", error);
    process.exit(1);
  }

  console.log(`GHS Policy MCP server listening on http://${host}:${port}/mcp`);
});
