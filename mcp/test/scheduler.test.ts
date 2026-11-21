import { describe, expect, it } from "vitest";
import { runJobs } from "../src/scheduler.js";
import type { Device, Job } from "../src/types.js";

const dev = (id: string, platform: "android" | "ios"): Device => ({
  id, name: id, platform, state: "device", virtual: true, usable: true,
});
const job = (i: number, platform: "android" | "ios" = "android"): Job => ({ id: `j${i}`, flow: `f${i}.yaml`, platform, deviceId: "" });
const ok = async () => ({ status: "passed" as const, durationMs: 1, exitCode: 0, reportPath: null, errorTail: null });

describe("runJobs", () => {
  it("never runs more jobs at once than there are devices", async () => {
    let active = 0;
    let peak = 0;
    const execute = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: "passed" as const, durationMs: 5, exitCode: 0, reportPath: null, errorTail: null };
    };
    const results = await runJobs({
      jobs: [1, 2, 3, 4, 5, 6].map((i) => job(i)),
      devices: [dev("a", "android"), dev("b", "android")],
      parallel: true,
      execute,
      signal: new AbortController().signal,
    });
    expect(peak).toBe(2);
    expect(results.every((r) => r.status === "passed")).toBe(true);
  });

  it("sequential mode uses a single device", async () => {
    const seen = new Set<string>();
    await runJobs({
      jobs: [1, 2, 3].map((i) => job(i)),
      devices: [dev("a", "android"), dev("b", "android")],
      parallel: false,
      execute: async (_j, d) => { seen.add(d.id); return { status: "passed", durationMs: 0, exitCode: 0, reportPath: null, errorTail: null }; },
      signal: new AbortController().signal,
    });
    expect([...seen]).toEqual(["a"]);
  });

  it("a failing job does not stop the others", async () => {
    const results = await runJobs({
      jobs: [1, 2, 3].map((i) => job(i)),
      devices: [dev("a", "android"), dev("b", "android")],
      parallel: true,
      execute: async (j) => {
        if (j.id === "j2") throw new Error("device dropped");
        return { status: "passed", durationMs: 0, exitCode: 0, reportPath: null, errorTail: null };
      },
      signal: new AbortController().signal,
    });
    expect(results.map((r) => r.status)).toEqual(["passed", "error", "passed"]);
    expect(results[1].errorTail).toBe("device dropped");
  });

  it("keeps iOS and Android jobs on devices of their own platform", async () => {
    const results = await runJobs({
      jobs: [job(1, "ios"), job(2, "android"), job(3, "ios")],
      devices: [dev("i1", "ios"), dev("a1", "android")],
      parallel: true,
      execute: async (j, d) => ({ status: "passed", durationMs: 0, exitCode: 0, reportPath: `${d.id}`, errorTail: null }),
      signal: new AbortController().signal,
    });
    expect(results.map((r) => r.deviceId)).toEqual(["i1", "a1", "i1"]);
  });

  it("reports a job as error when no device of its platform exists", async () => {
    const results = await runJobs({
      jobs: [job(1, "ios")],
      devices: [dev("a1", "android")],
      parallel: true,
      execute: ok,
      signal: new AbortController().signal,
    });
    expect(results[0].status).toBe("error");
    expect(results[0].errorTail).toContain("No ios device");
  });

  it("cancellation marks queued jobs as cancelled", async () => {
    const controller = new AbortController();
    const results = await runJobs({
      jobs: [1, 2, 3, 4].map((i) => job(i)),
      devices: [dev("a", "android")],
      parallel: false,
      execute: async (_j, _d, signal) => {
        controller.abort();
        return { status: signal.aborted ? "cancelled" : "passed", durationMs: 0, exitCode: null, reportPath: null, errorTail: null };
      },
      signal: controller.signal,
    });
    expect(results.map((r) => r.status as string)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
  });
});
