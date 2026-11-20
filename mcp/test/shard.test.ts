import { describe, expect, it } from "vitest";
import { shardFlows } from "../src/shard.js";
import { summarize, toMarkdown } from "../src/summary.js";

describe("shardFlows", () => {
  const flows = ["a", "b", "c", "d", "e"];
  it("splits every flow exactly once across shards", () => {
    const all = [0, 1, 2].flatMap((i) => shardFlows(flows, i, 3));
    expect(all.sort()).toEqual(flows);
  });
  it("keeps shard sizes within one flow of each other", () => {
    const sizes = [0, 1, 2].map((i) => shardFlows(flows, i, 3).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
  it("one shard takes everything", () => {
    expect(shardFlows(flows, 0, 1)).toEqual(flows);
  });
  it("rejects invalid indexes", () => {
    expect(() => shardFlows(flows, 3, 3)).toThrow(/between 0 and 2/);
    expect(() => shardFlows(flows, 0, 0)).toThrow(/>= 1/);
  });
});

describe("summary", () => {
  const job = (status: "passed" | "failed" | "error", flow: string) => ({
    jobId: flow, flow, platform: "android" as const, deviceId: "emulator-5554", status,
    durationMs: 1500, exitCode: status === "passed" ? 0 : 1, reportPath: null, errorTail: status === "passed" ? null : "Assertion | failed",
  });
  it("is successful only when every job passed", () => {
    expect(summarize("sequential", { index: 0, count: 1 }, [job("passed", "a.yaml")]).success).toBe(true);
    expect(summarize("sequential", { index: 0, count: 1 }, [job("passed", "a.yaml"), job("failed", "b.yaml")]).success).toBe(false);
    expect(summarize("sequential", { index: 0, count: 1 }, []).success).toBe(false);
  });
  it("renders a markdown table with escaped pipes", () => {
    const md = toMarkdown(summarize("sequential", { index: 0, count: 1 }, [job("failed", "b.yaml")]));
    expect(md).toContain("❌ Some jobs did not pass");
    expect(md).toContain("| b.yaml | android |");
    expect(md).toContain("Assertion \\| failed");
  });
});
