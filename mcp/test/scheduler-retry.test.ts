import { describe, expect, it } from "vitest";
import { runJobs, type Executor } from "../src/scheduler.js";
import type { Device, Job } from "../src/types.js";

const dev = (id: string, platform: "android" | "ios" = "android"): Device => ({
  id, name: id, platform, state: "device", virtual: true, usable: true,
});
const job = (i: number, platform: "android" | "ios" = "android"): Job => ({ id: `j${i}`, flow: `f${i}.yaml`, platform, deviceId: "" });
const jobs = (n: number, platform: "android" | "ios" = "android") => Array.from({ length: n }, (_, i) => job(i + 1, platform));
const noAbort = () => new AbortController().signal;
const pass = { status: "passed" as const, durationMs: 1, exitCode: 0, reportPath: null, errorTail: null };
const infra = (msg = "device dropped") => ({ status: "error" as const, durationMs: 1, exitCode: 1, reportPath: null, errorTail: msg });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("retry", () => {
  it("retries an infrastructure failure on another device", async () => {
    const seen: string[] = [];
    const execute: Executor = async (_j, d) => {
      seen.push(d.id);
      return d.id === "bad" ? infra("adb offline") : pass;
    };
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("bad"), dev("good")],
      parallel: true,
      execute,
      signal: noAbort(),
    });
    expect(results[0].status).toBe("passed");
    expect(results[0].attempts).toBe(2);
    expect(results[0].devicesTried).toEqual(["bad", "good"]);
    expect(results[0].deviceId).toBe("good");
  });

  it("retries on the same device when it is the only one", async () => {
    let calls = 0;
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("only")],
      parallel: true,
      execute: async () => (++calls === 1 ? infra("flaky usb") : pass),
      signal: noAbort(),
    });
    expect(results[0].status).toBe("passed");
    expect(results[0].devicesTried).toEqual(["only", "only"]);
  });

  it("gives up after maxAttempts and reports the last error", async () => {
    let calls = 0;
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("a"), dev("b")],
      parallel: true,
      maxAttempts: 3,
      quarantineAfter: 99,
      execute: async () => {
        calls++;
        return infra(`boom ${calls}`);
      },
      signal: noAbort(),
    });
    expect(calls).toBe(3);
    expect(results[0].status).toBe("error");
    expect(results[0].attempts).toBe(3);
    expect(results[0].errorTail).toBe("boom 3");
  });

  it("does not retry a failed flow by default", async () => {
    let calls = 0;
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("a"), dev("b")],
      parallel: true,
      execute: async () => {
        calls++;
        return { status: "failed", durationMs: 1, exitCode: 1, reportPath: null, errorTail: "assertion" };
      },
      signal: noAbort(),
    });
    expect(calls).toBe(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].attempts).toBe(1);
  });

  it("retries a failed flow when retryFailed is on", async () => {
    let calls = 0;
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("a")],
      parallel: true,
      retryFailed: true,
      execute: async () =>
        ++calls === 1 ? { status: "failed", durationMs: 1, exitCode: 1, reportPath: null, errorTail: "flaky" } : pass,
      signal: noAbort(),
    });
    expect(results[0].status).toBe("passed");
    expect(results[0].attempts).toBe(2);
  });

  it("retries a timeout like any infrastructure failure", async () => {
    let calls = 0;
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("a"), dev("b")],
      parallel: true,
      execute: async () =>
        ++calls === 1 ? { status: "timeout", durationMs: 600000, exitCode: null, reportPath: null, errorTail: "Timed out" } : pass,
      signal: noAbort(),
    });
    expect(results[0].status).toBe("passed");
    expect(results[0].attempts).toBe(2);
  });

  it("reports a retried job as queued, not final, while it waits", async () => {
    const updates: string[] = [];
    await runJobs({
      jobs: [job(1)],
      devices: [dev("a"), dev("b")],
      parallel: true,
      execute: async (_j, d) => (d.id === "a" ? infra() : pass),
      signal: noAbort(),
      onUpdate: (r) => updates.push(r.status),
    });
    expect(updates).toEqual(["running", "queued", "running", "passed"]);
  });
});

describe("device quarantine", () => {
  it("retires a device after repeated infrastructure failures so it cannot drain the queue", async () => {
    const retired: string[] = [];
    const perDevice: Record<string, number> = { bad: 0, good: 0 };
    const results = await runJobs({
      jobs: jobs(8),
      devices: [dev("bad"), dev("good")],
      parallel: true,
      quarantineAfter: 2,
      maxAttempts: 3,
      execute: async (_j, d) => {
        perDevice[d.id]++;
        await sleep(2);
        return d.id === "bad" ? infra("adb offline") : pass;
      },
      signal: noAbort(),
      onDeviceRetired: (d) => retired.push(d.id),
    });
    expect(retired).toEqual(["bad"]);
    expect(perDevice.bad).toBe(2);
    expect(results.every((r) => r.status === "passed")).toBe(true);
  });

  it("fails the remaining jobs clearly when every device is retired", async () => {
    const results = await runJobs({
      jobs: jobs(4),
      devices: [dev("a"), dev("b")],
      parallel: true,
      quarantineAfter: 1,
      maxAttempts: 5,
      execute: async () => infra("emulator crashed"),
      signal: noAbort(),
    });
    expect(results.every((r) => r.status === "error")).toBe(true);
    expect(results.some((r) => r.errorTail?.includes("No healthy android device left"))).toBe(true);
  });

  it("a passing result resets the failure streak", async () => {
    const retired: string[] = [];
    let n = 0;
    await runJobs({
      jobs: jobs(6),
      devices: [dev("a")],
      parallel: true,
      quarantineAfter: 2,
      maxAttempts: 2,
      // fail, pass, fail, pass, ... never two in a row
      execute: async () => (n++ % 2 === 0 ? infra() : pass),
      signal: noAbort(),
      onDeviceRetired: (d) => retired.push(d.id),
    });
    expect(retired).toEqual([]);
  });
});

describe("multiple devices", () => {
  it("spreads 20 jobs over 5 devices with at most 5 running at once", async () => {
    let active = 0;
    let peak = 0;
    const perDevice: Record<string, number> = {};
    const devices = ["a", "b", "c", "d", "e"].map((id) => dev(id));
    const results = await runJobs({
      jobs: jobs(20),
      devices,
      parallel: true,
      execute: async (_j, d) => {
        active++;
        peak = Math.max(peak, active);
        perDevice[d.id] = (perDevice[d.id] ?? 0) + 1;
        await sleep(5 + Math.random() * 10);
        active--;
        return pass;
      },
      signal: noAbort(),
    });
    expect(results.every((r) => r.status === "passed")).toBe(true);
    expect(peak).toBe(5);
    expect(Object.keys(perDevice)).toHaveLength(5);
    expect(Object.values(perDevice).reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("a slow device does not hold back the others", async () => {
    const perDevice: Record<string, number> = {};
    await runJobs({
      jobs: jobs(10),
      devices: [dev("slow"), dev("fast1"), dev("fast2")],
      parallel: true,
      execute: async (_j, d) => {
        perDevice[d.id] = (perDevice[d.id] ?? 0) + 1;
        await sleep(d.id === "slow" ? 80 : 5);
        return pass;
      },
      signal: noAbort(),
    });
    expect(perDevice.slow).toBeLessThan(perDevice.fast1);
    expect(perDevice.fast1 + perDevice.fast2 + perDevice.slow).toBe(10);
  });

  it("runs iOS and Android devices side by side without crossing platforms", async () => {
    const platformsByDevice: Record<string, Set<string>> = {};
    const mixed = [...jobs(6, "ios").map((j) => ({ ...j, id: `i${j.id}` })), ...jobs(6, "android").map((j) => ({ ...j, id: `a${j.id}` }))];
    const results = await runJobs({
      jobs: mixed,
      devices: [dev("ios1", "ios"), dev("ios2", "ios"), dev("and1"), dev("and2"), dev("and3")],
      parallel: true,
      execute: async (j, d) => {
        (platformsByDevice[d.id] ??= new Set()).add(j.platform);
        await sleep(3);
        return pass;
      },
      signal: noAbort(),
    });
    expect(results.every((r) => r.status === "passed")).toBe(true);
    for (const set of Object.values(platformsByDevice)) expect(set.size).toBe(1);
  });

  it("does not deadlock when retries are requeued while other devices are idle", async () => {
    let flaky = 0;
    const results = await runJobs({
      jobs: jobs(12),
      devices: [dev("a"), dev("b"), dev("c")],
      parallel: true,
      maxAttempts: 4,
      quarantineAfter: 99,
      execute: async (j) => {
        await sleep(2);
        // Every third job fails once, then succeeds.
        const failFirst = Number(j.id.slice(1)) % 3 === 0 && flaky++ < 4;
        return failFirst ? infra("transient") : pass;
      },
      signal: noAbort(),
    });
    expect(results.every((r) => r.status === "passed")).toBe(true);
  });

  it("cancels cleanly with many devices: running jobs stop, queued jobs are cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running: string[] = [];
    const promise = runJobs({
      jobs: jobs(12),
      devices: [dev("a"), dev("b"), dev("c")],
      parallel: true,
      execute: async (j, _d, signal) => {
        running.push(j.id);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000);
          signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return signal.aborted
          ? { status: "cancelled" as const, durationMs: 1, exitCode: null, reportPath: null, errorTail: null }
          : pass;
      },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    const results = await promise;
    expect(running).toHaveLength(3); // only the first wave ever started
    expect(results).toHaveLength(12);
    expect(results.every((r) => r.status === "cancelled")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("never retries after a cancel", async () => {
    const controller = new AbortController();
    let calls = 0;
    const results = await runJobs({
      jobs: [job(1)],
      devices: [dev("a"), dev("b")],
      parallel: true,
      maxAttempts: 5,
      execute: async () => {
        calls++;
        controller.abort();
        return infra("killed by cancel");
      },
      signal: controller.signal,
    });
    expect(calls).toBe(1);
    expect(results[0].status).toBe("error");
  });
});
