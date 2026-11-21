import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloudError, planCloudJobs, submitCloudJob, waitForCloudJobs, getCloudJobStatus } from "./cloud.js";
import { defaultExec, resolveEmulatorBin } from "./devicetools.js";
import { checkFeasibility } from "./feasibility.js";
import { flowRoots } from "./fsguard.js";
import { DeviceLocks } from "./locks.js";
import { discoverDevices, maestroVersion, resolveAdbBin, resolveMaestroBin } from "./maestro.js";
import { RunManager } from "./runs.js";
import { registerAuthoringTools } from "./tools-authoring.js";
import { fail, text, type FullDeps, type ServerDeps } from "./tools-common.js";
import { registerPrompts } from "./prompts.js";
import { MODES, registerRunTools, resolveFlows, resultsPayload, summarizeRun } from "./tools-runs.js";
import { generateWorkflow } from "./workflow.js";

const execFileAsync = promisify(execFile);

export type { ServerDeps } from "./tools-common.js";
export { MODES, resolveFlows };

const MAX_REPORT_CHARS = 20_000;

export function createServer(input: ServerDeps): McpServer {
  const deps: FullDeps = {
    ...input,
    ctx: input.ctx ?? {
      adbBin: input.adbBin,
      maestroBin: input.bin,
      emulatorBin: resolveEmulatorBin(input.adbBin),
      logDir: join(input.runs.homeDir, "logs"),
      exec: defaultExec,
    },
    locks: input.locks ?? new DeviceLocks(),
    flowRoots: input.flowRoots ?? flowRoots(),
  };
  const server = new McpServer({ name: "maestro-deck", version: "0.3.0" });

  server.registerTool(
    "doctor",
    { description: "Check the Maestro CLI, its version, adb, the usable devices, and whether a cloud token is configured." },
    async () => {
      try {
        const version = await maestroVersion(deps.bin);
        const devices = await discoverDevices(deps.adbBin);
        return text({
          maestroBin: deps.bin,
          maestroVersion: version,
          adbBin: deps.adbBin,
          devices: devices.length,
          usable: devices.filter((d) => d.usable).length,
          cloudTokenConfigured: Boolean(deps.cloud.token),
        });
      } catch (err) {
        return fail(`Maestro CLI not usable at "${deps.bin}": ${(err as Error).message}. Set MAESTRO_BIN to its path.`);
      }
    },
  );

  server.registerTool(
    "list_devices",
    {
      description:
        "List the Android devices/emulators (adb) and iOS simulators/phones (devicectl) with their state. Only devices with usable=true can run flows.",
    },
    async () => text(await discoverDevices(deps.adbBin)),
  );

  server.registerTool(
    "check_parallel_feasibility",
    {
      description:
        "Tell whether a parallel mode can run on the usable devices connected now. Modes: same-model or different-model devices on one platform, or iOS and Android together.",
      inputSchema: { mode: z.enum(MODES) },
    },
    async ({ mode }) => text(checkFeasibility(mode, await discoverDevices(deps.adbBin))),
  );

  server.registerTool(
    "read_flow",
    {
      description: "Read the content of a Maestro YAML flow file.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const resolved = resolveFlows([path], process.cwd());
      if ("error" in resolved) return fail(resolved.error);
      return text(readFileSync(resolved.ok[0], "utf8"));
    },
  );

  server.registerTool(
    "check_flow_syntax",
    {
      description: "Validate the syntax of Maestro flows without running them (maestro check-syntax). No device needed.",
      inputSchema: { flows: z.array(z.string()).min(1) },
    },
    async ({ flows }) => {
      const resolved = resolveFlows(flows, process.cwd());
      if ("error" in resolved) return fail(resolved.error);
      const results = await Promise.all(
        resolved.ok.map(async (file) => {
          try {
            await execFileAsync(deps.bin, ["check-syntax", file], { timeout: 60_000 });
            return { flow: file, valid: true as const };
          } catch (err) {
            const e = err as { stderr?: string; stdout?: string; message: string };
            return { flow: file, valid: false as const, message: (e.stderr || e.stdout || e.message).trim().slice(0, 1000) };
          }
        }),
      );
      return text({ allValid: results.every((r) => r.valid), results });
    },
  );

  server.registerTool(
    "wait_for_run",
    {
      description: "Wait until a run finishes, or until waitSeconds elapses, then return its results.",
      inputSchema: { runId: z.string(), waitSeconds: z.number().int().min(1).max(1800).default(60) },
    },
    async ({ runId, waitSeconds }) => {
      const run = await deps.runs.waitFor(runId, waitSeconds * 1000);
      return run ? text(resultsPayload(run)) : fail(`Unknown run: ${runId}`);
    },
  );

  server.registerTool(
    "get_run_status",
    { description: "Current state and progress of a run.", inputSchema: { runId: z.string() } },
    async ({ runId }) => {
      const run = deps.runs.get(runId);
      return run ? text(summarizeRun(run)) : fail(`Unknown run: ${runId}`);
    },
  );

  server.registerTool(
    "get_run_results",
    {
      description:
        "Per-job results of a run: status, device, platform, attempts, devices tried, duration, report path. Grouped by platform.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = deps.runs.get(runId);
      return run ? text(resultsPayload(run)) : fail(`Unknown run: ${runId}`);
    },
  );

  server.registerTool(
    "get_run_report",
    {
      description: "Read the JUnit report of one job (or every job) of a run, and list its artifact files (screenshots, logs).",
      inputSchema: { runId: z.string(), jobId: z.string().optional() },
    },
    async ({ runId, jobId }) => {
      const run = deps.runs.get(runId);
      if (!run) return fail(`Unknown run: ${runId}`);
      const jobs = run.results.filter((r) => (jobId ? r.jobId === jobId : true));
      if (jobs.length === 0) return fail(jobId ? `Unknown job: ${jobId}` : "This run has no job yet.");
      return text(
        jobs.map((j) => {
          const dir = join(run.artifactsDir, j.jobId);
          const files = existsSync(dir) ? readdirSync(dir).slice(0, 50) : [];
          let junit: string | null = null;
          if (j.reportPath && existsSync(j.reportPath)) {
            junit = readFileSync(j.reportPath, "utf8").slice(0, MAX_REPORT_CHARS);
          }
          return { jobId: j.jobId, flow: j.flow, status: j.status, deviceId: j.deviceId, artifactsDir: dir, files, junit };
        }),
      );
    },
  );

  server.registerTool(
    "cancel_run",
    {
      description: "Stop a running run: running jobs are stopped (SIGTERM then SIGKILL on the whole process group), queued jobs are marked cancelled.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => (deps.runs.cancel(runId) ? text({ cancelled: true, runId }) : fail(`Run ${runId} is not running.`)),
  );

  server.registerTool(
    "list_runs",
    { description: "Runs started by this server and by earlier sessions, most recent first. A run found mid-flight after a restart is 'interrupted'." },
    async () => text(deps.runs.list().map(summarizeRun)),
  );

  server.registerTool(
    "generate_github_workflow",
    {
      description:
        "Generate a GitHub Actions workflow that runs flows in parallel on a matrix of emulators (Android) or simulators (iOS), using the Maestro Deck CLI or composite action. Returns YAML text; it does not write any file.",
      inputSchema: {
        flows: z.string().describe("Flow file or directory in the repository, e.g. flows/"),
        platform: z.enum(["android", "ios"]),
        shards: z.number().int().min(1).max(20).default(2).describe("Matrix jobs, each with its own device"),
        jobTimeoutSeconds: z.number().int().min(1).max(7200).default(600),
        retries: z.number().int().min(0).max(5).default(1),
        workflowName: z.string().optional(),
      },
    },
    async (opts) => {
      try {
        return text(generateWorkflow(opts));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "cloud_run_flows",
    {
      description:
        "Run flows on the Maestro Deck cloud. EVERY accepted job spends one run of the account and cannot be cancelled. Without confirmSpend=true this only returns the plan and the number of runs it would spend. Needs MAESTRO_DECK_CLOUD_TOKEN. Modes: sequential (one job), parallel (one job per flow), ios_android (an iOS and an Android job per flow).",
      inputSchema: {
        flows: z.array(z.string()).min(1),
        mode: z.enum(["sequential", "parallel", "ios_android"]).default("sequential"),
        platform: z.enum(["android", "android_physical", "ios"]).default("android"),
        appPath: z.string().optional().describe(".apk to install on Android"),
        iosAppPath: z.string().optional().describe("Zipped .app simulator build for iOS"),
        confirmSpend: z.boolean().default(false).describe("Must be true to actually submit and spend runs"),
        waitSeconds: z.number().int().min(0).max(1800).default(0),
      },
    },
    async ({ flows, mode, platform, appPath, iosAppPath, confirmSpend, waitSeconds }) => {
      const resolved = resolveFlows(flows, process.cwd());
      if ("error" in resolved) return fail(resolved.error);
      for (const p of [appPath, iosAppPath]) {
        if (p && !existsSync(p)) return fail(`File not found: ${p}`);
      }
      let plan;
      try {
        plan = planCloudJobs(mode, resolved.ok, platform, { apk: appPath, iosZip: iosAppPath });
      } catch (err) {
        return fail((err as Error).message);
      }
      const summary = plan.map((j) => ({ platform: j.platform, app: j.appPath, flows: j.yamlPaths }));
      if (!confirmSpend) {
        return text({ submitted: false, wouldSpendRuns: plan.length, plan: summary, note: "Call again with confirmSpend=true to submit." });
      }
      if (!deps.cloud.token) return fail("No cloud token. Set MAESTRO_DECK_CLOUD_TOKEN, or run on the desktop app.");
      const jobs: { jobId?: string; platform: string; flows: string[]; error?: string }[] = [];
      let stop = false;
      for (const job of plan) {
        if (stop) {
          jobs.push({ platform: job.platform, flows: job.yamlPaths, error: "Not submitted: an earlier job was refused." });
          continue;
        }
        try {
          const { jobId } = await submitCloudJob(deps.cloud, job);
          jobs.push({ jobId, platform: job.platform, flows: job.yamlPaths });
        } catch (err) {
          jobs.push({ platform: job.platform, flows: job.yamlPaths, error: (err as Error).message });
          // Quota, auth and disabled-jobs errors apply to every later job as well.
          if (err instanceof CloudError && err.code !== "UPLOAD_FAILED" && err.code !== "REQUEST_FAILED") stop = true;
        }
      }
      const ids = jobs.flatMap((j) => (j.jobId ? [j.jobId] : []));
      const statuses = waitSeconds > 0 && ids.length > 0 ? await waitForCloudJobs(deps.cloud, ids, waitSeconds * 1000) : undefined;
      return text({ submitted: true, runsSpent: ids.length, jobs, statuses });
    },
  );

  server.registerTool(
    "cloud_get_jobs",
    {
      description: "Get the status of cloud jobs by id, optionally waiting for them to finish. Needs MAESTRO_DECK_CLOUD_TOKEN.",
      inputSchema: {
        jobIds: z.array(z.string()).min(1).max(50),
        waitSeconds: z.number().int().min(0).max(1800).default(0),
      },
    },
    async ({ jobIds, waitSeconds }) => {
      try {
        const statuses =
          waitSeconds > 0
            ? await waitForCloudJobs(deps.cloud, jobIds, waitSeconds * 1000)
            : await Promise.all(jobIds.map((id) => getCloudJobStatus(deps.cloud, id)));
        return text(statuses);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  registerRunTools(server, deps);
  registerAuthoringTools(server, deps);
  registerPrompts(server);

  return server;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  return {
    bin: resolveMaestroBin(env),
    adbBin: resolveAdbBin(env),
    runs: new RunManager(),
    cloud: { token: env.MAESTRO_DECK_CLOUD_TOKEN },
  };
}
