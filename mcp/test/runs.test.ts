import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/runs.js";
import type { Device, Job } from "../src/types.js";

const ok = async (): Promise<Omit<import("../src/types.js").JobResult, "jobId" | "flow" | "platform" | "deviceId">> => ({
  status: "passed", durationMs: 1, exitCode: 0, reportPath: null, errorTail: null,
});

describe("RunManager", () => {
  it("never assigns a job to an unusable device", async () => {
    const manager = new RunManager(mkdtempSync(join(tmpdir(), "runs-")));
    const usedDevices: string[] = [];
    const devices: Device[] = [
      { id: "locked-phone", name: "IphoneU", platform: "ios", state: "unavailable", virtual: false, usable: false },
      { id: "sim-17", name: "iPhone 17 Pro", platform: "ios", state: "connected", virtual: true, usable: true },
    ];
    const run = manager.start({
      mode: "sequential",
      flows: ["/x/a.yaml"],
      devices,
      executeFor: () => async (job: Job, device: Device) => {
        usedDevices.push(device.id);
        return ok();
      },
    });
    await waitFor(() => manager.get(run.id)?.state === "finished");
    expect(usedDevices).toEqual(["sim-17"]);
    expect(manager.get(run.id)?.results[0].deviceId).toBe("sim-17");
  });

  it("refuses to start an infeasible mode", () => {
    const manager = new RunManager(mkdtempSync(join(tmpdir(), "runs-")));
    expect(() =>
      manager.start({
        mode: "ios_android",
        flows: ["/x/a.yaml"],
        devices: [{ id: "sim", name: "iPhone 17", platform: "ios", state: "connected", virtual: true, usable: true }],
        executeFor: () => ok,
      }),
    ).toThrow(/not feasible/);
  });
});

async function waitFor(cond: () => boolean | undefined, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
