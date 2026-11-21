import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { explainFailure, type CommandEntry, type FailureReport } from "./failure.js";
import { buildFlow } from "./flowfile.js";
import { executeFlow } from "./maestro.js";
import { takeScreenshot, type DeviceCtx } from "./devicetools.js";
import type { Device } from "./types.js";

export interface AdhocStep {
  index: number;
  step: string;
  /** completed, failed, or not_run when an earlier step failed. */
  status: "completed" | "failed" | "not_run";
}

export interface AdhocResult {
  status: "passed" | "failed" | "error" | "timeout" | "cancelled";
  durationMs: number | null;
  steps: AdhocStep[];
  error: string | null;
  /** Set when a step failed: the step, the screen, the hints. Paths point to files already removed. */
  failure: Omit<FailureReport, "artifactsDir" | "screenshot" | "hierarchyFile" | "commands" | "logTail"> | null;
  /** The device screen after the steps ran, or at the failure. */
  screenshot: Buffer | null;
}

const SYSTEM = /^(defineVariables|applyConfiguration)/;

export interface AdhocInput {
  device: Device;
  appId: string;
  steps: unknown[];
  maestroBin: string;
  /** Where temporary files go. Everything is deleted before this returns. */
  workDir: string;
  timeoutMs: number;
  ctx: DeviceCtx;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Runs steps on a device without saving a flow: they are written to a temporary file, run with
 * Maestro, and the file and its artifacts are deleted. The result keeps what matters: which step
 * passed or failed, the screen, and why.
 */
export async function runSteps(input: AdhocInput): Promise<AdhocResult> {
  const dir = join(input.workDir, `adhoc-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const content = buildFlow({ appId: input.appId, steps: input.steps, env: input.env });
    const flow = join(dir, "flow.yaml");
    writeFileSync(flow, content);

    const execute = executeFlow({ bin: input.maestroBin, artifactsDir: dir, timeoutMs: input.timeoutMs });
    const outcome = await execute(
      { id: "adhoc", flow, platform: input.device.platform, deviceId: input.device.id },
      input.device,
      input.signal ?? new AbortController().signal,
    );

    const report = explainFailure({ jobDir: join(dir, "adhoc"), flowPath: flow, reportPath: outcome.reportPath });
    const executed: CommandEntry[] = report ? report.commands.filter((c) => c.depth === 0 && !SYSTEM.test(c.command)) : [];
    const steps: AdhocStep[] = input.steps.map((s, i) => {
      const run = executed[i];
      return {
        index: i,
        step: typeof s === "string" ? s : stringify(s, { lineWidth: 0 }).trim().replace(/\n/g, " "),
        status: !run ? "not_run" : run.status === "failed" ? "failed" : run.status === "completed" ? "completed" : "not_run",
      };
    });

    let screenshot: Buffer | null = null;
    if (report?.screenshot && existsSync(report.screenshot) && outcome.status !== "passed") {
      screenshot = readFileSync(report.screenshot);
    } else {
      try {
        screenshot = await takeScreenshot(input.device, input.ctx);
      } catch {
        screenshot = null;
      }
    }

    let failure: AdhocResult["failure"] = null;
    if (report && outcome.status !== "passed") {
      const { failedCommand, step, error, screen, hints } = report;
      failure = { failedCommand, step, error, screen, hints };
    }
    return {
      status: outcome.status === "queued" || outcome.status === "running" ? "error" : outcome.status,
      durationMs: outcome.durationMs,
      steps,
      error: outcome.status === "passed" ? null : outcome.errorTail,
      failure,
      screenshot,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
