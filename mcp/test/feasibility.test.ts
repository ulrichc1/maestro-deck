import { describe, expect, it } from "vitest";
import { checkFeasibility } from "../src/feasibility.js";
import type { Device } from "../src/types.js";

const dev = (id: string, name: string, platform: "android" | "ios", extra: Partial<Device> = {}): Device => ({
  id, name, platform, state: "device", virtual: true, usable: true, ...extra,
});

describe("checkFeasibility", () => {
  it("sequential needs one usable device", () => {
    expect(checkFeasibility("sequential", []).feasible).toBe("no");
    expect(checkFeasibility("sequential", [dev("a", "Pixel 10", "android")]).feasible).toBe("with_reserve");
  });

  it("ignores devices that are not usable", () => {
    const r = checkFeasibility("android_same_model", [
      dev("a", "Pixel 10", "android"),
      dev("b", "Pixel 10", "android", { usable: false, state: "offline" }),
    ]);
    expect(r.feasible).toBe("no");
    expect(r.reason).toContain("found 1");
  });

  it("android same model needs two devices with the same model", () => {
    const r = checkFeasibility("android_same_model", [dev("a", "Pixel 10", "android"), dev("b", "Pixel 10 Pro", "android")]);
    expect(r.feasible).toBe("no");
    const ok = checkFeasibility("android_same_model", [dev("a", "Pixel 10", "android"), dev("b", "pixel-10", "android")]);
    expect(ok.feasible).toBe("with_reserve");
  });

  it("different models needs two distinct models", () => {
    const same = checkFeasibility("ios_different_models", [dev("a", "iPhone 17", "ios"), dev("b", "iPhone 17", "ios")]);
    expect(same.feasible).toBe("no");
    const diff = checkFeasibility("ios_different_models", [dev("a", "iPhone 17", "ios"), dev("b", "iPhone 17e", "ios")]);
    expect(diff.feasible).toBe("with_reserve");
  });

  it("yes instead of with_reserve when a physical device is used", () => {
    const r = checkFeasibility("ios_android", [
      dev("p", "IphoneU", "ios", { virtual: false }),
      dev("e", "Pixel 10", "android", { virtual: false }),
    ]);
    expect(r.feasible).toBe("yes");
  });

  it("ios_android needs one device on each platform", () => {
    expect(checkFeasibility("ios_android", [dev("a", "Pixel 10", "android")]).feasible).toBe("no");
    const r = checkFeasibility("ios_android", [dev("a", "Pixel 10", "android"), dev("i", "iPhone 17", "ios")]);
    expect(r.feasible).toBe("with_reserve");
  });
});
