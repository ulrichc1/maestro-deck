import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkFeasibility } from "./feasibility.js";
import { buildPlan, type Plan } from "./planner.js";
import { runJobs, type Executor } from "./scheduler.js";
import type { Device, JobResult, Mode } from "./types.js";

export type RunState = "queued" | "running" | "finished" | "cancelled";

export interface RunRecord {
  id: string;
  mode: Mode;
  state: RunState;
  createdAt: string;
  finishedAt: string | null;
  flows: string[];
  devices: Pick<Device, "id" | "name" | "platform">[];
  results: JobResult[];
  summary: { total: number; passed: number; failed: number; errors: number; cancelled: number };
  artifactsDir: string;
}

export interface StartOptions {
  mode: Mode;
  flows: string[];
  devices: Device[];
  executeFor: (artifactsDir: string) => Executor;
  homeDir?: string;
}

/**
 * Keeps run records in memory and mirrors them to `<home>/runs/<id>/run.json`
 * so an agent can read the result of a run after a server restart.
 */
export class RunManager {
  private runs = new Map<string, { record: RunRecord; controller: AbortController }>();
  private readonly home: string;

  constructor(home: string = process.env.MAESTRO_DECK_MCP_HOME ?? join(homedir(), ".maestro-deck-mcp")) {
    this.home = resolve(home);
  }

  /** Validates the request, then starts the run in the background. Returns the id at once. */
  start(opts: StartOptions): RunRecord {
    // Only usable devices may take jobs: a physical phone that is locked or
    // not connected must never be picked, even if it was listed.
    const usable = opts.devices.filter((d) => d.usable);
    const feasibility = checkFeasibility(opts.mode, usable);
    if (feasibility.feasible === "no") throw new Error(`Mode ${opts.mode} is not feasible: ${feasibility.reason}`);
    const plan: Plan = buildPlan({ mode: opts.mode, flows: opts.flows, devices: usable });

    const id = randomUUID();
    const artifactsDir = join(this.home, "runs", id);
    mkdirSync(artifactsDir, { recursive: true });
    const record: RunRecord = {
      id,
      mode: opts.mode,
      state: "running",
      createdAt: new Date().toISOString(),
      finishedAt: null,
      flows: opts.flows,
      devices: [...plan.pools.android, ...plan.pools.ios].map((d) => ({ id: d.id, name: d.name, platform: d.platform })),
      results: [],
      summary: { total: plan.jobs.length, passed: 0, failed: 0, errors: 0, cancelled: 0 },
      artifactsDir,
    };
    const controller = new AbortController();
    this.runs.set(id, { record, controller });
    this.persist(record);

    const devices = [...plan.pools.android, ...plan.pools.ios];
    runJobs({
      jobs: plan.jobs,
      devices,
      parallel: plan.parallel,
      execute: opts.executeFor(artifactsDir),
      signal: controller.signal,
      onUpdate: (result) => this.onUpdate(record, result),
    })
      .then((results) => this.finish(record, results, controller.signal.aborted))
      .catch((err) => this.fail(record, err));

    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id)?.record;
  }

  list(): RunRecord[] {
    return [...this.runs.values()].map((r) => r.record);
  }

  cancel(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry || entry.record.state !== "running") return false;
    entry.controller.abort();
    return true;
  }

  private onUpdate(record: RunRecord, result: JobResult) {
    const idx = record.results.findIndex((r) => r.jobId === result.jobId);
    if (idx === -1) record.results.push(result);
    else record.results[idx] = result;
    this.persist(record);
  }

  private finish(record: RunRecord, results: JobResult[], cancelled: boolean) {
    record.results = results;
    record.summary = {
      total: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      errors: results.filter((r) => r.status === "error").length,
      cancelled: results.filter((r) => r.status === "cancelled").length,
    };
    record.state = cancelled ? "cancelled" : "finished";
    record.finishedAt = new Date().toISOString();
    this.persist(record);
  }

  private fail(record: RunRecord, err: unknown) {
    record.state = "finished";
    record.finishedAt = new Date().toISOString();
    record.results.push({
      jobId: "run", flow: "", platform: "android", deviceId: "", status: "error",
      durationMs: null, exitCode: null, reportPath: null,
      errorTail: err instanceof Error ? err.message : String(err),
    });
    this.persist(record);
  }

  private persist(record: RunRecord) {
    try {
      writeFileSync(join(record.artifactsDir, "run.json"), JSON.stringify(record, null, 2));
    } catch {
      // Persistence is best effort; the in-memory record stays authoritative.
    }
  }
}

