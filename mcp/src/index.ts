#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, defaultDeps } from "./server.js";

const server = createServer(defaultDeps());
await server.connect(new StdioServerTransport());
