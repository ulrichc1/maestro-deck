import { describe, expect, it } from "vitest";
import { buildPlan, largestSameModelGroup } from "../src/planner.js";
import type { Device } from "../src/types.js";

const dev = (id: string, name: string, platform: "android" | "ios"): Device => ({
  id, name, platform, state: "device", virtual: true, usable: true,
});

describe("buildPlan", () => {
  const flows = ["a.yaml", "b.yaml", "c.yaml"];

  it("sequential puts every flow on one device, not parallel", () => {
    const plan = buildPlan({ mode: "sequential", flows, devices: [dev("1", "Pixel 10", "android"), dev("2", "Pixel 10", "android")] });
    expect(plan.parallel).toBe(false);
    expect(plan.pools.android.map((d) => d.id)).toEqual(["1"]);
    expect(plan.jobs.map((j) => j.flow)).toEqual(flows);
  });

  it("same-model mode uses only the largest same-model group", () => {
    const devices = [dev("1", "Pixel 10", "android"), dev("2", "Pixel 10", "android"), dev("3", "Pixel 10 Pro", "android")];
    const plan = buildPlan({ mode: "android_same_model", flows, devices });
    expect(plan.pools.android.map((d) => d.id)).toEqual(["1", "2"]);
    expect(plan.jobs).toHaveLength(3);
    expect(plan.parallel).toBe(true);
  });

  it("different-models mode keeps every device of the platform", () => {
    const devices = [dev("1", "Pixel 10", "android"), dev("2", "Pixel 10 Pro", "android")];
    const plan = buildPlan({ mode: "android_different_models", flows, devices });
    expect(plan.pools.android).toHaveLength(2);
  });

  it("ios_android creates one iOS and one Android job per flow", () => {
    const devices = [dev("i", "iPhone 17", "ios"), dev("a", "Pixel 10", "android")];
    const plan = buildPlan({ mode: "ios_android", flows: ["a.yaml", "b.yaml"], devices });
    expect(plan.jobs).toHaveLength(4);
    expect(plan.jobs.filter((j) => j.platform === "ios")).toHaveLength(2);
    expect(plan.jobs.filter((j) => j.platform === "android")).toHaveLength(2);
    expect(new Set(plan.jobs.map((j) => j.id)).size).toBe(4);
  });

  it("throws when the mode cannot be planned", () => {
    expect(() => buildPlan({ mode: "ios_android", flows, devices: [dev("i", "iPhone 17", "ios")] })).toThrow();
    expect(() => buildPlan({ mode: "android_same_model", flows, devices: [dev("1", "Pixel 10", "android")] })).toThrow();
  });
});

describe("largestSameModelGroup", () => {
  it("returns the biggest model group, first one on ties", () => {
    const group = largestSameModelGroup([dev("a", "X", "ios"), dev("b", "Y", "ios"), dev("c", "y", "ios")]);
    expect(group.map((d) => d.id)).toEqual(["b", "c"]);
  });
});
