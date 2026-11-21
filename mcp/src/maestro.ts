import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { parseAdbDevices, parseAvdName, parseDevicectl, parseSimctl } from "./devices.js";
import type { Device, Job, JobResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Finds the Maestro CLI. Order: MAESTRO_BIN, the official installer location,
 * then the PATH. Returns the bare name as last resort so the error message
 * from spawn explains what is missing.
 */
export function resolveMaestroBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAESTRO_BIN) return env.MAESTRO_BIN;
  const installer = join(homedir(), ".maestro", "bin", "maestro");
  if (existsSync(installer)) return installer;
  return "maestro";
}

export async function maestroVersion(bin: string): Promise<string> {
  const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 30_000 });
  return stdout.trim();
}

/** Finds adb: ADB_BIN, ANDROID_HOME, the default Android Studio SDK, then PATH. */
export function resolveAdbBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADB_BIN) return env.ADB_BIN;
  const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk")];
  for (const root of sdkRoots) {
    if (!root) continue;
    const candidate = join(root, "platform-tools", "adb");
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

/**
 * Lists the devices Maestro can use now: connected Android devices from adb
 * and iOS simulators or physical iPhones from devicectl. A source that is not
 * installed contributes no devices instead of failing the whole call.
 */
export async function discoverDevices(adbBin: string): Promise<Device[]> {
  const devices: Device[] = [];
  try {
    const { stdout } = await execFileAsync(adbBin, ["devices", "-l"], { timeout: 30_000 });
    const android = parseAdbDevices(stdout);
    // Emulators share one model string; the AVD name is what tells them apart.
    await Promise.all(
      android
        .filter((d) => d.virtual && d.usable)
        .map(async (d) => {
          try {
            const { stdout: avd } = await execFileAsync(adbBin, ["-s", d.id, "emu", "avd", "name"], { timeout: 10_000 });
            const name = parseAvdName(avd);
            if (name) {
              d.name = name.replace(/_/g, " ");
              d.model = name; // emulators share one system model; the AVD tells them apart
            }
          } catch {
            // Keep the model name when the emulator console does not answer.
          }
        }),
    );
    devices.push(...android);
  } catch {
    // adb missing: no Android devices.
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), "devicectl-"));
    const file = join(dir, "devices.json");
    await execFileAsync("xcrun", ["devicectl", "list", "devices", "--json-output", file], { timeout: 60_000 });
    devices.push(...parseDevicectl(JSON.parse(readFileSync(file, "utf8"))));
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Xcode or devicectl missing: no iOS devices from devicectl.
  }
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
    for (const sim of parseSimctl(JSON.parse(stdout))) {
      // A booted simulator is usable even if devicectl listed it as disconnected.
      const existing = devices.find((d) => d.id === sim.id);
      if (existing) {
        existing.usable = existing.usable || sim.usable;
        existing.state = sim.usable ? "connected" : existing.state;
      } else {
        devices.push(sim);
      }
    }
  } catch {
    // simctl missing: no simulator information.
  }
  return devices;
}

export interface ExecuteOptions {
  bin: string;
  artifactsDir: string;
  /** Kill the job after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** After SIGTERM, wait this long before SIGKILL. Default 5 seconds. */
  killGraceMs?: number;
  /** Variables passed to the flow (maestro -e KEY=VALUE). */
  env?: Record<string, string>;
}

/** `-e KEY=VALUE` arguments, refusing names that Maestro or the shell could misread. */
export function envArgs(env: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid variable name "${k}": use letters, digits and underscores.`);
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

export type ExecuteOutcome = Omit<JobResult, "jobId" | "flow" | "platform" | "deviceId" | "attempts" | "devicesTried">;

/** First `<failure>` message of a JUnit report, or null. */
export function failureMessage(reportPath: string): string | null {
  if (!existsSync(reportPath)) return null;
  const m = /<failure[^>]*>([\s\S]*?)<\/failure>/.exec(readFileSync(reportPath, "utf8"));
  return m ? m[1].trim().slice(0, 1000) : null;
}

/**
 * Output signatures of a lost device or a driver that could not start, as opposed to a
 * flow that ran and failed an assertion. Flow-syntax errors deliberately do not match:
 * they are the flow's fault, so they must not retire a healthy device.
 */
const INFRA_PATTERNS = [
  /is not connected/i,
  /device ['"]?[\w:.-]+['"]? not found/i,
  /no (connected )?devices/i,
  /device offline/i,
  /MaestroSessionManager/,
  /StatusRuntimeException/,
  /UNAVAILABLE/,
  /Connection refused/i,
  /ConnectException/,
  /Failed to (start|connect to|install|launch) (the )?(driver|device|emulator|simulator|maestro)/i,
  /(driver|xctest runner).{0,40}(timed out|did not start|failed to start)/i,
  /adb: .*error/i,
  /unable to (find|connect to|reach) (a )?(device|emulator|simulator)/i,
];

/**
 * Exception names that only a lost device or crashed driver produces. These are safe to
 * look for even inside a reported failure message, because an app assertion never
 * contains them. The generic patterns above are only used when there is no test result.
 */
const STRONG_INFRA_PATTERNS = [
  /DeviceServerDied/,
  /Device server died/i,
  /StatusRuntimeException/,
  /MaestroSessionManager/,
  /is not connected/i,
  /ConnectException/,
  /IOException: (Broken pipe|Connection reset)/i,
];

export function looksLikeInfraFailure(output: string): boolean {
  return INFRA_PATTERNS.some((re) => re.test(output));
}

export function isInfraFailureMessage(message: string): boolean {
  return STRONG_INFRA_PATTERNS.some((re) => re.test(message));
}

function summarizeInfraOutput(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => INFRA_PATTERNS.some((re) => re.test(l)));
  return (line ?? output.trim().split("\n").pop() ?? "unknown").slice(0, 300);
}

/** Sends a signal to the whole process group (Maestro starts child JVMs). */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs one flow on one device with `maestro --udid <id> test`. The JUnit
 * report and the per-job artifacts go to `artifactsDir/<jobId>/`.
 *
 * - Exit 0 is `passed`, any other exit is `failed`.
 * - A process that cannot start, or a device Maestro refuses, is `error`.
 * - A job that outlives `timeoutMs` is stopped and reported as `timeout`.
 * - Cancelling (abort) or timing out stops the whole process group: SIGTERM
 *   first so Maestro can clean up, then SIGKILL after `killGraceMs`.
 */
export function executeFlow(opts: ExecuteOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return (job: Job, device: Device, signal: AbortSignal): Promise<ExecuteOutcome> => {
    if (signal.aborted) {
      return Promise.resolve({ status: "cancelled", durationMs: 0, exitCode: null, reportPath: null, errorTail: null });
    }
    const jobDir = join(opts.artifactsDir, job.id);
    mkdirSync(jobDir, { recursive: true });
    const reportPath = join(jobDir, "junit.xml");
    const args = [
      "--udid", device.id,
      "test", ...envArgs(opts.env), job.flow,
      "--format", "JUNIT",
      "--output", reportPath,
      "--test-output-dir", jobDir,
    ];

    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(opts.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      };
      child.stderr?.on("data", collect);
      child.stdout?.on("data", collect);

      let timedOut = false;
      let terminating = false;
      let done = false;
      let killTimer: NodeJS.Timeout | undefined;
      let exitFallback: NodeJS.Timeout | undefined;

      const terminate = () => {
        if (terminating) return;
        terminating = true;
        killTree(child, "SIGTERM");
        killTimer = setTimeout(() => killTree(child, "SIGKILL"), graceMs);
      };
      const onAbort = () => terminate();
      signal.addEventListener("abort", onAbort, { once: true });
      const limit = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);

      const finish = (code: number | null, spawnError?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(limit);
        clearTimeout(killTimer);
        clearTimeout(exitFallback);
        signal.removeEventListener("abort", onAbort);
        // After a stop, sweep anything the group still holds (grandchildren).
        if (terminating) killTree(child, "SIGKILL");
        const durationMs = Date.now() - started;

        if (spawnError) {
          resolve({ status: "error", durationMs, exitCode: null, reportPath: null, errorTail: spawnError.message });
          return;
        }
        if (signal.aborted) {
          resolve({ status: "cancelled", durationMs, exitCode: code, reportPath: null, errorTail: null });
          return;
        }
        if (timedOut) {
          resolve({
            status: "timeout",
            durationMs,
            exitCode: code,
            reportPath: null,
            errorTail: `Timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.`,
          });
          return;
        }
        const passed = code === 0;
        if (!passed) {
          // A flow that really failed leaves a JUnit report with a failure. No report, plus
          // the signature of a lost device or a crashed driver, means infrastructure.
          const reportedFailure = failureMessage(reportPath);
          const infra = reportedFailure ? isInfraFailureMessage(reportedFailure) : looksLikeInfraFailure(output);
          if (infra) {
            resolve({
              status: "error",
              durationMs,
              exitCode: code,
              reportPath: null,
              errorTail: `Device or driver problem: ${reportedFailure ? reportedFailure.split("\n")[0].slice(0, 300) : summarizeInfraOutput(output)}`,
            });
            return;
          }
          resolve({
            status: "failed",
            durationMs,
            exitCode: code,
            reportPath: existsSync(reportPath) ? reportPath : null,
            errorTail: reportedFailure ?? (output.trim().slice(-1000) || null),
          });
          return;
        }
        resolve({ status: "passed", durationMs, exitCode: code, reportPath: existsSync(reportPath) ? reportPath : null, errorTail: null });
      };

      child.on("error", (err) => finish(null, err));
      child.on("close", (code) => finish(code));
      // A grandchild can keep the pipes open after Maestro exits; do not wait for it forever.
      child.on("exit", (code) => {
        exitFallback = setTimeout(() => finish(code), 2_000);
      });
    });
  };
}
