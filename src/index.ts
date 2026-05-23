#!/usr/bin/env node
import cors from "cors";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { runCliCommand } from "./cli/commands.js";
import { registerSamsungHealthPrompts } from "./prompts/samsung-health-prompts.js";
import { registerSamsungHealthResources } from "./resources/samsung-health-resources.js";
import { registerSamsungHealthTools } from "./tools/samsung-health-tools.js";
import { getConfig } from "./services/config.js";
import { getExportSnapshot } from "./services/samsung-health-export.js";

// Parsing a multi-year nested zip takes ~30 s; the first request that hits a cold cache used to
// exceed the MCP client's 60 s timeout. Triggering the parse on startup means by the time real
// tool calls arrive the in-memory cache is warm. Errors are swallowed so missing/invalid export
// data never blocks server startup — the actual tools surface those errors through their normal
// error paths.
function warmExportCache(): void {
  const { exportPath } = getConfig();
  if (!exportPath) return;
  getExportSnapshot({ exportPath })
    .then((snapshot) => {
      console.error(`Export cache warmed: ${snapshot.records.length} records, ${snapshot.workouts.length} workouts.`);
    })
    .catch((error) => {
      console.error(`Export cache warmup failed (ignored): ${(error as Error).message}`);
    });
}

function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });
  registerSamsungHealthTools(server);
  registerSamsungHealthResources(server);
  registerSamsungHealthPrompts(server);
  return server;
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  warmExportCache();
}

async function runHttp(): Promise<void> {
  const app = express();
  const host = process.env.SAMSUNG_HEALTH_MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.SAMSUNG_HEALTH_MCP_PORT ?? 3000);
  const allowedOrigin = process.env.SAMSUNG_HEALTH_MCP_ALLOWED_ORIGIN ?? `http://${host}:${port}`;

  app.use(express.json({ limit: "1mb" }));
  app.use(cors({ origin: allowedOrigin }));
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });
  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP HTTP request failed:", error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  app.listen(port, host, () => {
    console.error(`${SERVER_NAME} HTTP transport listening on http://${host}:${port}/mcp`);
    warmExportCache();
  });
}

const args = new Set(process.argv.slice(2));
let cliResult: number | undefined;

try {
  cliResult = await runCliCommand(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
}

if (cliResult !== undefined) {
  process.exitCode = cliResult;
} else if (process.exitCode === undefined) {
  const transport = process.env.SAMSUNG_HEALTH_MCP_TRANSPORT ?? (args.has("--http") ? "http" : "stdio");
  if (transport === "http") await runHttp();
  else await runStdio();
}
