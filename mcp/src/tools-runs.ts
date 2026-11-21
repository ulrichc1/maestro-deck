import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fitImage } from "./devicetools.js";
import { explainFailure } from "./failure.js";
import { describeFlow, FlowError } from "./flowfile.js";
import { DEFAULT_JOB_TIMEOUT_MS, discoverDevices, envArgs, executeFlow } from "./maestro.js";
import type { RunRecord } from "./runs.js";
import { DEFAULT_MAX_IMAGE, fail, image, text, type FullDeps } from "./tools-common.js";
import type { JobResult, Mode } from "./types.js";

export const MODES = [
  "sequential",
  "android_same_model",
  "android_different_models",
  "ios_same_model",
  "ios_different_models",
  "ios_android",
] as const satisfies readonly Mode[];

const FINISHED_JOB = new Set(["passed", "failed", "error", "timeout", "cancelled"]);

export function summarizeRun(run: RunRecord) {
  return {
    id: run.id,
    mode: run.mode,
    state: run.state,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
    progress: run.results.filter((r) => FINISHED_JOB.has(r.status)).length,
    retiredDevices: run.retiredDevices,
  };
}

export function resultsPayload(run: RunRecord) {
  return {
    ...summarizeRun(run),
    byPlatform: {
      android: run.results.filter((r) => r.platform === "android"),
      ios: run.results.filter((r) => r.platform === "ios"),
    },
  };
}

/** Resolves flow paths against `cwd` and checks each one is a YAML flow file. */
export function resolveFlows(flows: string[], cwd: string): { ok: string[] } | { error: string } {
  const ok: string[] = [];
  for (const f of flows) {
    const abs = resolve(cwd, f);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { error: `Flow not found: ${abs}` };
    if (![".yaml", ".yml"].includes(extname(abs))) return { error: `Not a YAML flow: ${abs}` };
    ok.push(abs);
  }
  if (ok.length === 0) return { error: "No flow given." };
  return { ok };
}

export interface StartArgs {
  flows: string[];
  mode: Mode;
  timeoutSeconds: number;
  retries: number;
  retryFailed: boolean;
  waitSeconds: number;
  deviceIds?: string[];
  env?: Record<string, string>;
  includeTags?: string[];
  excludeTags?: string[];
}

const envSchema = z.record(z.string(), z.string()).describe("Variables for the flows, usable as ${NAME} (maestro -e)");

/** Starts a local run. Shared by run_flows and rerun_failed. */
export async function startRun(deps: FullDeps, args: StartArgs) {
  const resolved = resolveFlows(args.flows, process.cwd());
  if ("error" in resolved) return fail(resolved.error);

  try {
    envArgs(args.env); // Refuse a bad variable name now, not once the run has started.
  } catch (err) {
    return fail((err as Error).message);
  }

  let flows = resolved.ok;
  if (args.includeTags?.length || args.excludeTags?.length) {
    const kept: string[] = [];
    for (const f of flows) {
      let tags: string[];
      try {
        tags = describeFlow(readFileSync(f, "utf8")).tags;
      } catch (err) {
        return fail(`Cannot read ${f}: ${err instanceof FlowError ? err.message : (err as Error).message}`);
      }
      if (args.includeTags?.length && !tags.some((t) => args.includeTags!.includes(t))) continue;
      if (args.excludeTags?.some((t) => tags.includes(t))) continue;
      kept.push(f);
    }
    if (kept.length === 0) return fail("No flow matches the tag filters.");
    flows = kept;
  }

  try {
    const all = await discoverDevices(deps.adbBin);
    const busy = deps.runs.busyDevices();
    let devices = all;
    if (args.deviceIds?.length) {
      const missing = args.deviceIds.filter((id) => !all.some((d) => d.id === id && d.usable));
      if (missing.length > 0) return fail(`Not usable now: ${missing.join(", ")}. Use list_devices.`);
      const taken = args.deviceIds.filter((id) => busy.has(id) || deps.locks.isHeld(id));
      if (taken.length > 0) return fail(`Busy: ${taken.join(", ")}. Wait for the other run or operation, or cancel it.`);
      devices = all.filter((d) => args.deviceIds!.includes(d.id));
    } else {
      devices = all.filter((d) => !busy.has(d.id) && !deps.locks.isHeld(d.id));
    }
    const run = deps.runs.start({
      mode: args.mode,
      flows,
      devices,
      maxAttempts: args.retries + 1,
      retryFailed: args.retryFailed,
      executeFor: (artifactsDir) => executeFlow({ bin: deps.bin, artifactsDir, timeoutMs: args.timeoutSeconds * 1000, env: args.env }),
    });
    if (args.waitSeconds > 0) {
      const finished = await deps.runs.waitFor(run.id, args.waitSeconds * 1000);
      return text(resultsPayload(finished ?? run));
    }
    return text({ runId: run.id, state: run.state, jobs: run.summary.total, artifactsDir: run.artifactsDir });
  } catch (err) {
    return fail((err as Error).message);
  }
}

const READABLE_TEXT = new Set([".json", ".txt", ".log", ".xml", ".yaml", ".yml", ".html"]);
const MAX_ARTIFACT_CHARS = 20_000;

export function registerRunTools(server: McpServer, deps: FullDeps): void {
  server.registerTool(
    "list_flows",
    {
      description:
        "List the Maestro flows in a folder with their appId, name, tags and number of steps, so you can pick which to run. Invalid flows are listed with their problem.",
      inputSchema: {
        directory: z.string().describe("Absolute or relative to the server working directory"),
        recursive: z.boolean().default(false),
        tag: z.string().optional().describe("Only flows with this tag"),
      },
    },
    async ({ directory, recursive, tag }) => {
      const dir = resolve(directory);
      if (!existsSync(dir)) return fail(`Directory not found: ${dir}`);
      const found: string[] = [];
      const walk = (d: string, depth: number) => {
        for (const name of readdirSync(d).sort()) {
          const p = join(d, name);
          if (statSync(p).isDirectory()) {
            if (recursive && depth < 6 && !name.startsWith(".") && name !== "node_modules") walk(p, depth + 1);
          } else if ([".yaml", ".yml"].includes(extname(name)) && name !== "config.yaml") {
            found.push(p);
          }
        }
      };
      walk(dir, 0);
      const flows = found.map((path) => {
        try {
          const info = describeFlow(readFileSync(path, "utf8"));
          return { path, appId: info.appId ?? info.url, name: info.name, tags: info.tags, steps: info.stepCount };
        } catch (err) {
          return { path, error: err instanceof FlowError ? err.message : (err as Error).message };
        }
      });
      return text(tag ? flows.filter((f) => "tags" in f && (f.tags ?? []).includes(tag)) : flows);
    },
  );

  server.registerTool(
    "run_flows",
    {
      description:
        "Start Maestro flows on local devices. Returns a runId at once unless waitSeconds is set. 'sequential' uses one device; the other modes run in parallel from a queue, retry infrastructure failures on another device, and retire a device that keeps failing. Each job has a time limit. Pin devices with deviceIds, filter flows by tags, pass variables with env.",
      inputSchema: {
        flows: z.array(z.string()).min(1).describe("Flow files (YAML)"),
        mode: z.enum(MODES).default("sequential"),
        timeoutSeconds: z.number().int().min(1).max(7200).default(DEFAULT_JOB_TIMEOUT_MS / 1000).describe("Kill a job that runs longer than this"),
        retries: z.number().int().min(0).max(5).default(1).describe("Extra attempts after an infrastructure failure"),
        retryFailed: z.boolean().default(false).describe("Also retry flows that failed their assertions"),
        waitSeconds: z.number().int().min(0).max(1800).default(0).describe("Wait up to this long for the run to finish before answering"),
        deviceIds: z.array(z.string()).optional().describe("Run only on these devices (ids from list_devices)"),
        env: envSchema.optional(),
        includeTags: z.array(z.string()).optional().describe("Run only flows having one of these tags"),
        excludeTags: z.array(z.string()).optional().describe("Skip flows having one of these tags"),
      },
    },
    async (args) => startRun(deps, args),
  );

  server.registerTool(
    "rerun_failed",
    {
      description: "Run again only the jobs of a finished run that failed, errored or timed out, with the same mode. Returns a new run.",
      inputSchema: {
        runId: z.string(),
        waitSeconds: z.number().int().min(0).max(1800).default(0),
        timeoutSeconds: z.number().int().min(1).max(7200).default(DEFAULT_JOB_TIMEOUT_MS / 1000),
        retries: z.number().int().min(0).max(5).default(1),
      },
    },
    async ({ runId, waitSeconds, timeoutSeconds, retries }) => {
      const run = deps.runs.get(runId);
      if (!run) return fail(`Unknown run: ${runId}`);
      if (run.state === "running") return fail("This run is still running. Wait for it or cancel it first.");
      const bad = new Set(["failed", "error", "timeout"]);
      // ios_android lists a flow twice (once per platform): rerun each flow once.
      const flows = [...new Set(run.results.filter((r) => bad.has(r.status)).map((r) => r.flow))];
      if (flows.length === 0) return fail("Nothing to rerun: no job of this run failed.");
      return startRun(deps, { flows, mode: run.mode, timeoutSeconds, retries, retryFailed: false, waitSeconds });
    },
  );

  server.registerTool(
    "compare_runs",
    {
      description: "Compare two runs flow by flow: what broke (regressions), what got fixed, what stayed the same.",
      inputSchema: { baseRunId: z.string().describe("The earlier run"), runId: z.string().describe("The later run") },
    },
    async ({ baseRunId, runId }) => {
      const a = deps.runs.get(baseRunId);
      const b = deps.runs.get(runId);
      if (!a || !b) return fail(`Unknown run: ${!a ? baseRunId : runId}`);
      const key = (r: JobResult) => `${r.flow}@${r.platform}`;
      const verdict = (r: JobResult | undefined) => (r ? (r.status === "passed" ? "passed" : r.status) : "absent");
      const before = new Map(a.results.map((r) => [key(r), r]));
      const after = new Map(b.results.map((r) => [key(r), r]));
      const rows = [...new Set([...before.keys(), ...after.keys()])].sort().map((k) => {
        const x = before.get(k);
        const y = after.get(k);
        const kind =
          verdict(x) === "passed" && verdict(y) !== "passed" && y ? "regression" :
          verdict(x) !== "passed" && x && verdict(y) === "passed" ? "fixed" :
          !x ? "new" : !y ? "removed" : verdict(x) === verdict(y) ? "same" : "changed";
        return {
          flow: basename(k.split("@")[0]), platform: k.split("@")[1], kind, before: verdict(x), after: verdict(y),
          durationBeforeMs: x?.durationMs ?? null, durationAfterMs: y?.durationMs ?? null,
        };
      });
      const count = (kind: string) => rows.filter((r) => r.kind === kind).length;
      return text({
        regressions: count("regression"), fixed: count("fixed"), unchanged: count("same"), newJobs: count("new"), removedJobs: count("removed"),
        rows: rows.filter((r) => r.kind !== "same"),
      });
    },
  );

  server.registerTool(
    "explain_failure",
    {
      description:
        "Explain why a job failed: which step (with its line in the flow file), the error, what was on screen (visible texts, similar text when an assertion misses), the screenshot at the failure, the error lines of the log, and what to try next. Without jobId it explains every job that did not pass.",
      inputSchema: {
        runId: z.string(),
        jobId: z.string().optional(),
        includeScreenshot: z.boolean().default(true),
        maxScreenshots: z.number().int().min(0).max(4).default(2),
      },
    },
    async ({ runId, jobId, includeScreenshot, maxScreenshots }) => {
      const run = deps.runs.get(runId);
      if (!run) return fail(`Unknown run: ${runId}`);
      const bad = new Set(["failed", "error", "timeout"]);
      const jobs = run.results.filter((r) => (jobId ? r.jobId === jobId : bad.has(r.status)));
      if (jobs.length === 0) return fail(jobId ? `Unknown job: ${jobId}` : "No job of this run failed.");
      const content: ({ type: "text"; text: string } | ReturnType<typeof image>)[] = [];
      const reports = [];
      let shots = 0;
      for (const j of jobs) {
        const report = explainFailure({ jobDir: join(run.artifactsDir, j.jobId), flowPath: j.flow, reportPath: j.reportPath });
        reports.push({
          jobId: j.jobId, flow: j.flow, device: j.deviceId, status: j.status, attempts: j.attempts, devicesTried: j.devicesTried,
          explanation: report ?? { hints: ["Maestro left no trace for this job."], error: { message: j.errorTail } },
        });
        if (includeScreenshot && report?.screenshot && shots < maxScreenshots && existsSync(report.screenshot)) {
          content.push({ type: "text", text: `Screen at the failure of ${basename(j.flow)} on ${j.deviceId}:` });
          content.push(image(await fitImage(readFileSync(report.screenshot), DEFAULT_MAX_IMAGE, deps.ctx)));
          shots++;
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(reports, null, 2) }, ...content] };
    },
  );

  server.registerTool(
    "read_artifact",
    {
      description:
        "Read a file a job left behind: a screenshot (returned as an image), a log, the commands list or the hierarchy at a failure (text, truncated). Use the paths given by explain_failure or get_run_report. Limited to the run's folder.",
      inputSchema: { runId: z.string(), file: z.string().describe("A path inside the run folder, absolute or relative to it") },
    },
    async ({ runId, file }) => {
      const run = deps.runs.get(runId);
      if (!run) return fail(`Unknown run: ${runId}`);
      const abs = resolve(run.artifactsDir, file);
      const rel = relative(run.artifactsDir, abs);
      if (rel.startsWith("..") || resolve(abs) !== abs) return fail("That file is outside the run folder.");
      if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`File not found: ${file}`);
      const ext = extname(abs).toLowerCase();
      if (ext === ".png") return { content: [image(await fitImage(readFileSync(abs), DEFAULT_MAX_IMAGE, deps.ctx))] };
      if (!READABLE_TEXT.has(ext)) return fail(`Cannot read ${ext || "this type of"} files. Readable: .png and ${[...READABLE_TEXT].join(", ")}.`);
      const body = readFileSync(abs, "utf8");
      return text(body.length > MAX_ARTIFACT_CHARS ? `${body.slice(0, MAX_ARTIFACT_CHARS)}\n... truncated (${body.length} characters)` : body);
    },
  );
}
