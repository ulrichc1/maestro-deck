import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkFeasibility } from "./feasibility.js";
import { discoverDevices, executeFlow, maestroVersion, resolveAdbBin, resolveMaestroBin } from "./maestro.js";
import { RunManager, type RunRecord } from "./runs.js";
import type { Mode } from "./types.js";

export const MODES = [
  "sequential",
  "android_same_model",
  "android_different_models",
  "ios_same_model",
  "ios_different_models",
  "ios_android",
] as const satisfies readonly Mode[];

export interface ServerDeps {
  bin: string;
  adbBin: string;
  runs: RunManager;
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Resolves flow paths against `cwd` and checks each one is a YAML flow file. */
export function resolveFlows(flows: string[], cwd: string): { ok: string[] } | { error: string } {
  const ok: string[] = [];
  for (const f of flows) {
    const abs = isAbsolute(f) ? f : resolve(cwd, f);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { error: `Flow not found: ${abs}` };
    if (![".yaml", ".yml"].includes(extname(abs))) return { error: `Not a YAML flow: ${abs}` };
    ok.push(abs);
  }
  if (ok.length === 0) return { error: "No flow given." };
  return { ok };
}

function summarizeRun(run: RunRecord) {
  return {
    id: run.id,
    mode: run.mode,
    state: run.state,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
    progress: run.results.filter((r) => ["passed", "failed", "error", "cancelled"].includes(r.status)).length,
  };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "maestro-deck", version: "0.1.0" });

  server.registerTool(
    "doctor",
    { description: "Check the Maestro CLI, its version, and the devices it can see." },
    async () => {
      try {
        const version = await maestroVersion(deps.bin);
        const devices = await discoverDevices(deps.adbBin);
        return text({ maestroBin: deps.bin, maestroVersion: version, adbBin: deps.adbBin, devices: devices.length, usable: devices.filter((d) => d.usable).length });
      } catch (err) {
        return fail(`Maestro CLI not usable at "${deps.bin}": ${(err as Error).message}. Set MAESTRO_BIN to its path.`);
      }
    },
  );

  server.registerTool(
    "list_devices",
    { description: "List local Android and iOS devices and simulators that Maestro can use." },
    async () => {
      return text(await discoverDevices(deps.adbBin));
    },
  );

  server.registerTool(
    "check_parallel_feasibility",
    {
      description:
        "Tell whether a parallel mode can run on the usable devices connected now. Modes: same-model or different-model devices on one platform, or iOS and Android together.",
      inputSchema: { mode: z.enum(MODES) },
    },
    async ({ mode }) => {
      return text(checkFeasibility(mode, await discoverDevices(deps.adbBin)));
    },
  );

  server.registerTool(
    "list_flows",
    {
      description: "List Maestro YAML flow files in a directory (not recursive).",
      inputSchema: { directory: z.string().describe("Absolute or relative to the server working directory") },
    },
    async ({ directory }) => {
      const dir = resolve(directory);
      if (!existsSync(dir)) return fail(`Directory not found: ${dir}`);
      const files = readdirSync(dir)
        .filter((f) => [".yaml", ".yml"].includes(extname(f)))
        .map((f) => join(dir, f));
      return text(files);
    },
  );

  server.registerTool(
    "run_flows",
    {
      description:
        "Start Maestro flows on devices. Returns a runId immediately; poll get_run_status and get_run_results. Mode 'sequential' runs one device; the other modes run in parallel from a queue.",
      inputSchema: {
        flows: z.array(z.string()).min(1).describe("Flow files (YAML)"),
        mode: z.enum(MODES).default("sequential"),
      },
    },
    async ({ flows, mode }) => {
      const resolved = resolveFlows(flows, process.cwd());
      if ("error" in resolved) return fail(resolved.error);
      try {
        const devices = await discoverDevices(deps.adbBin);
        const run = deps.runs.start({
          mode,
          flows: resolved.ok,
          devices,
          executeFor: (artifactsDir) => executeFlow({ bin: deps.bin, artifactsDir }),
        });
        return text({ runId: run.id, state: run.state, jobs: run.summary.total, artifactsDir: run.artifactsDir });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "get_run_status",
    {
      description: "Current state and progress of a run.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = deps.runs.get(runId);
      return run ? text(summarizeRun(run)) : fail(`Unknown run: ${runId}`);
    },
  );

  server.registerTool(
    "get_run_results",
    {
      description:
        "Per-job results of a run: status, device, platform, duration, JUnit report path. Results are grouped by platform.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = deps.runs.get(runId);
      if (!run) return fail(`Unknown run: ${runId}`);
      const byPlatform = { android: run.results.filter((r) => r.platform === "android"), ios: run.results.filter((r) => r.platform === "ios") };
      return text({ ...summarizeRun(run), byPlatform });
    },
  );

  server.registerTool(
    "cancel_run",
    {
      description: "Stop a running run: running jobs are killed, queued jobs are marked cancelled.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      return deps.runs.cancel(runId) ? text({ cancelled: true, runId }) : fail(`Run ${runId} is not running.`);
    },
  );

  server.registerTool(
    "list_runs",
    { description: "All runs started by this server process, most recent first." },
    async () => text(deps.runs.list().map(summarizeRun).reverse()),
  );

  return server;
}

export function defaultDeps(): ServerDeps {
  return { bin: resolveMaestroBin(), adbBin: resolveAdbBin(), runs: new RunManager() };
}
