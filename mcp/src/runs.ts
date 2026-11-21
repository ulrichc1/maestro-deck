import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkFeasibility } from "./feasibility.js";
import { buildPlan, type Plan } from "./planner.js";
import { runJobs, type Executor } from "./scheduler.js";
import type { Device, JobResult, Mode } from "./types.js";

/** `interrupted`: the server stopped while the run was in progress, so its outcome is unknown. */
export type RunState = "queued" | "running" | "finished" | "cancelled" | "interrupted";

export interface RunRecord {
  id: string;
  mode: Mode;
  state: RunState;
  createdAt: string;
  finishedAt: string | null;
  flows: string[];
  devices: Pick<Device, "id" | "name" | "platform">[];
  /** Devices taken out of rotation after repeated infrastructure failures. */
  retiredDevices: { id: string; name: string; reason: string }[];
  results: JobResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    timeouts: number;
    cancelled: number;
    retried: number;
  };
  artifactsDir: string;
}

export interface StartOptions {
  mode: Mode;
  flows: string[];
  devices: Device[];
  executeFor: (artifactsDir: string) => Executor;
  /** Total attempts per job for infrastructure failures. Default 2. */
  maxAttempts?: number;
  retryFailed?: boolean;
  quarantineAfter?: number;
}

export function summarizeResults(results: JobResult[]): RunRecord["summary"] {
  const count = (s: JobResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    passed: count("passed"),
    failed: count("failed"),
    errors: count("error"),
    timeouts: count("timeout"),
    cancelled: count("cancelled"),
    retried: results.filter((r) => r.attempts > 1).length,
  };
}

/**
 * Keeps run records in memory and mirrors them to `<home>/runs/<id>/run.json`
 * so an agent can read a run after a server restart. A run found on disk as
 * `running` but not owned by this process is reported as `interrupted`.
 */
export class RunManager {
  private runs = new Map<string, { record: RunRecord; controller: AbortController }>();
  private inflight = new Set<Promise<unknown>>();
  private readonly home: string;

  constructor(home: string = process.env.MAESTRO_DECK_MCP_HOME ?? join(homedir(), ".maestro-deck-mcp")) {
    this.home = resolve(home);
  }

  /** Validates the request, then starts the run in the background. Returns the record at once. */
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
      retiredDevices: [],
      results: [],
      summary: { total: plan.jobs.length, passed: 0, failed: 0, errors: 0, timeouts: 0, cancelled: 0, retried: 0 },
      artifactsDir,
    };
    const controller = new AbortController();
    this.runs.set(id, { record, controller });
    this.persist(record);

    const devices = [...plan.pools.android, ...plan.pools.ios];
    const done = runJobs({
      jobs: plan.jobs,
      devices,
      parallel: plan.parallel,
      execute: opts.executeFor(artifactsDir),
      signal: controller.signal,
      maxAttempts: opts.maxAttempts,
      retryFailed: opts.retryFailed,
      quarantineAfter: opts.quarantineAfter,
      onUpdate: (result) => this.onUpdate(record, result),
      onDeviceRetired: (device, reason) => {
        record.retiredDevices.push({ id: device.id, name: device.name, reason });
        this.persist(record);
      },
    })
      .then((results) => this.finish(record, results, controller.signal.aborted))
      .catch((err) => this.fail(record, err));
    this.inflight.add(done);
    void done.finally(() => this.inflight.delete(done));

    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id)?.record ?? this.readFromDisk(id);
  }

  /** Runs of this process and of earlier ones, most recent first. */
  list(): RunRecord[] {
    const all = new Map<string, RunRecord>();
    const runsDir = join(this.home, "runs");
    if (existsSync(runsDir)) {
      for (const id of readdirSync(runsDir)) {
        const record = this.readFromDisk(id);
        if (record) all.set(id, record);
      }
    }
    for (const [id, { record }] of this.runs) all.set(id, record);
    return [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  cancel(id: string): boolean {
    const entry = this.runs.get(id);
    if (!entry || entry.record.state !== "running") return false;
    entry.controller.abort();
    return true;
  }

  /** Aborts every run still going. Used when the server shuts down. */
  cancelAll(): void {
    for (const { record, controller } of this.runs.values()) {
      if (record.state === "running") controller.abort();
    }
  }

  /**
   * Cancels every run and waits until their processes are really gone (or `maxMs`),
   * so closing the MCP server never leaves Maestro or its JVM running.
   */
  async stopAll(maxMs = 10_000): Promise<void> {
    this.cancelAll();
    const settled = Promise.allSettled([...this.inflight]);
    await Promise.race([settled, new Promise((r) => setTimeout(r, maxMs))]);
  }

  /** Resolves when the run is no longer running, or after `timeoutMs`. */
  async waitFor(id: string, timeoutMs: number): Promise<RunRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = this.get(id);
      if (!record || record.state !== "running" || Date.now() >= deadline) return record;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private readFromDisk(id: string): RunRecord | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const file = join(this.home, "runs", id, "run.json");
    if (!existsSync(file)) return undefined;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
      if (record.state === "running" && !this.runs.has(id)) record.state = "interrupted";
      return record;
    } catch {
      return undefined;
    }
  }

  private onUpdate(record: RunRecord, result: JobResult) {
    const idx = record.results.findIndex((r) => r.jobId === result.jobId);
    if (idx === -1) record.results.push(result);
    else record.results[idx] = result;
    record.summary = summarizeResults(record.results);
    record.summary.total = Math.max(record.summary.total, record.results.length);
    this.persist(record);
  }

  private finish(record: RunRecord, results: JobResult[], cancelled: boolean) {
    record.results = results;
    record.summary = summarizeResults(results);
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
      attempts: 1, devicesTried: [],
    });
    record.summary = summarizeResults(record.results);
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
