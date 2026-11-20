import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { parseAdbDevices, parseDevicectl } from "./devices.js";
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
    devices.push(...parseAdbDevices(stdout));
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
    // Xcode or devicectl missing: no iOS devices.
  }
  return devices;
}

export interface ExecuteOptions {
  bin: string;
  artifactsDir: string;
}

/** First `<failure>` message of a JUnit report, or null. */
export function failureMessage(reportPath: string): string | null {
  if (!existsSync(reportPath)) return null;
  const m = /<failure[^>]*>([\s\S]*?)<\/failure>/.exec(readFileSync(reportPath, "utf8"));
  return m ? m[1].trim().slice(0, 1000) : null;
}

/**
 * Runs one flow on one device with `maestro --udid <id> test`. The JUnit
 * report and the per-job artifacts go to `artifactsDir/<jobId>/`.
 * Exit code 0 is `passed`, any other exit is `failed`; a process that cannot
 * start is `error`. Aborting kills the child process and reports `cancelled`.
 */
export function executeFlow(opts: ExecuteOptions) {
  return (job: Job, device: Device, signal: AbortSignal): Promise<Omit<JobResult, "jobId" | "flow" | "platform" | "deviceId">> => {
    const jobDir = join(opts.artifactsDir, job.id);
    mkdirSync(jobDir, { recursive: true });
    const reportPath = join(jobDir, "junit.xml");
    const args = [
      "--udid", device.id,
      "test", job.flow,
      "--format", "JUNIT",
      "--output", reportPath,
      "--test-output-dir", jobDir,
    ];

    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(opts.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      };
      child.stderr.on("data", collect);
      child.stdout.on("data", collect);

      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ status: "error", durationMs: Date.now() - started, exitCode: null, reportPath: null, errorTail: err.message });
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        const durationMs = Date.now() - started;
        if (signal.aborted) {
          resolve({ status: "cancelled", durationMs, exitCode: code, reportPath: null, errorTail: null });
          return;
        }
        const passed = code === 0;
        // Maestro refused the device before any flow ran: an infrastructure
        // problem, not a test failure, so it must not count as a red flow.
        if (!passed && /is not connected/.test(output)) {
          resolve({
            status: "error",
            durationMs,
            exitCode: code,
            reportPath: null,
            errorTail: `Device not usable by Maestro: ${output.match(/was requested, but it is not connected\.?/)?.[0] ?? "not connected"}`,
          });
          return;
        }
        resolve({
          status: passed ? "passed" : "failed",
          durationMs,
          exitCode: code,
          reportPath: existsSync(reportPath) ? reportPath : null,
          errorTail: passed ? null : failureMessage(reportPath) ?? (output.trim().slice(-1000) || null),
        });
      });
    });
  };
}
