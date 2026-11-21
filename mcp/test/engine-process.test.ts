import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { executeFlow } from "../src/maestro.js";
import type { Device, Job } from "../src/types.js";

// A fake `maestro` that behaves like the real one where it matters for
// process control: it starts a child process (like the JVM), can hang, and can
// ignore SIGTERM. Behaviour is chosen by environment variables:
//   FAKE_MODE=hang        wait 60s (time limit and cancel tests)
//   FAKE_IGNORE_TERM=1    ignore SIGTERM, so only SIGKILL stops it
//   FAKE_CHILD_PID_FILE   write the pid of a long-lived grandchild here
//   FAKE_MODE=daemon      start a grandchild that keeps stdout open, then exit 0 at once
let dir: string;
let fake: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-proc-"));
  fake = join(dir, "maestro");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const a = process.argv.slice(2);
const out = a[a.indexOf("--output") + 1];
fs.writeFileSync(out, "<testsuites/>");
if (process.env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
const mode = process.env.FAKE_MODE || "ok";
if (process.env.FAKE_CHILD_PID_FILE) {
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: mode === "daemon" ? ["ignore", "inherit", "inherit"] : "ignore" });
  fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
}
if (mode === "hang") setTimeout(() => process.exit(0), 60000);
else process.exit(0);
`,
  );
  chmodSync(fake, 0o755);
});

const device: Device = { id: "emulator-5554", name: "Pixel 10", platform: "android", state: "device", virtual: true, usable: true };
const job = (id: string): Job => ({ id, flow: "/f/a.yaml", platform: "android", deviceId: "" });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms = 3000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("time limit", () => {
  it("stops a job that hangs and reports timeout", async () => {
    const started = Date.now();
    const result = await withEnv({ FAKE_MODE: "hang" }, () =>
      executeFlow({ bin: fake, artifactsDir: join(dir, "t1"), timeoutMs: 400, killGraceMs: 300 })(job("t1"), device, new AbortController().signal),
    );
    expect(result.status).toBe("timeout");
    expect(result.errorTail).toMatch(/Timed out after/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills the grandchild process too (no orphan JVM)", async () => {
    const pidFile = join(dir, "pid-timeout");
    const result = await withEnv({ FAKE_MODE: "hang", FAKE_CHILD_PID_FILE: pidFile }, () =>
      executeFlow({ bin: fake, artifactsDir: join(dir, "t2"), timeoutMs: 600, killGraceMs: 300 })(job("t2"), device, new AbortController().signal),
    );
    expect(result.status).toBe("timeout");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(await waitDead(pid)).toBe(true);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await withEnv({ FAKE_MODE: "hang", FAKE_IGNORE_TERM: "1" }, () =>
      executeFlow({ bin: fake, artifactsDir: join(dir, "t3"), timeoutMs: 300, killGraceMs: 500 })(job("t3"), device, new AbortController().signal),
    );
    expect(result.status).toBe("timeout");
    // Must wait about the grace period, then die: not hang for 60s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(Date.now() - started).toBeLessThan(6000);
  });
});

describe("cancellation", () => {
  it("stops the job and its grandchild when aborted, escalating past SIGTERM", async () => {
    const pidFile = join(dir, "pid-cancel");
    const controller = new AbortController();
    const promise = withEnv({ FAKE_MODE: "hang", FAKE_IGNORE_TERM: "1", FAKE_CHILD_PID_FILE: pidFile }, () =>
      executeFlow({ bin: fake, artifactsDir: join(dir, "c1"), timeoutMs: 60_000, killGraceMs: 400 })(job("c1"), device, controller.signal),
    );
    setTimeout(() => controller.abort(), 500);
    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(await waitDead(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("does not even start a job when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeFlow({ bin: fake, artifactsDir: join(dir, "c2") })(job("c2"), device, controller.signal);
    expect(result.status).toBe("cancelled");
    expect(existsSync(join(dir, "c2", "c2", "junit.xml"))).toBe(false);
  });
});

describe("normal exit", () => {
  it("does not wait forever for a grandchild that keeps stdout open", async () => {
    const pidFile = join(dir, "pid-daemon");
    const started = Date.now();
    const result = await withEnv({ FAKE_MODE: "daemon", FAKE_CHILD_PID_FILE: pidFile }, () =>
      executeFlow({ bin: fake, artifactsDir: join(dir, "d1"), timeoutMs: 30_000 })(job("d1"), device, new AbortController().signal),
    );
    expect(result.status).toBe("passed");
    expect(Date.now() - started).toBeLessThan(8000);
    // Clean up the test's own daemon.
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  });
});
