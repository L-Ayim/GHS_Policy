import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGhsMcpServer } from "./mcp-tools.mjs";

const server = createGhsMcpServer();

await server.connect(new StdioServerTransport());
