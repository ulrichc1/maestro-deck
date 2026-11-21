#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, defaultDeps } from "./server.js";

const deps = defaultDeps();
const server = createServer(deps);

// When the client goes away (window closed, Ctrl+C, SIGTERM), stop every running job and
// wait for Maestro and its child processes to be gone, so nothing is left running.
let closing = false;
async function shutdown(code: number) {
  if (closing) return;
  closing = true;
  await deps.runs.stopAll(10_000);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));

await server.connect(new StdioServerTransport());
