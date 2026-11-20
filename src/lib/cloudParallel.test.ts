import { describe, expect, it } from "vitest";
import { cloudRunPassed, planCloudJobs, runCloudParallel, type CloudJobOutcome } from "./cloudParallel";

const artifacts = { apk: "/a/app.apk", iosZip: "/a/App.zip" };

describe("planCloudJobs", () => {
  const flows = ["/f/a.yaml", "/f/b.yaml"];

  it("sequential keeps every flow in one job", () => {
    const jobs = planCloudJobs("sequential", flows, "android", artifacts);
    expect(jobs).toEqual([{ platform: "android", appPath: "/a/app.apk", yamlPaths: flows }]);
  });

  it("parallel makes one job per flow on the chosen platform", () => {
    const jobs = planCloudJobs("parallel", flows, "ios", artifacts);
    expect(jobs.map((j) => j.yamlPaths)).toEqual([["/f/a.yaml"], ["/f/b.yaml"]]);
    expect(jobs.every((j) => j.platform === "ios" && j.appPath === "/a/App.zip")).toBe(true);
  });

  it("ios_android pairs an iOS and an Android job per flow", () => {
    const jobs = planCloudJobs("ios_android", flows, "android", artifacts);
    expect(jobs).toHaveLength(4);
    expect(jobs.filter((j) => j.platform === "ios")).toHaveLength(2);
    expect(jobs.filter((j) => j.platform === "android")).toHaveLength(2);
  });

  it("refuses a run with a missing artefact before anything is sent", () => {
    expect(() => planCloudJobs("parallel", flows, "android", { apk: null, iosZip: "/a/App.zip" })).toThrow(/apk/);
    expect(() => planCloudJobs("ios_android", flows, "android", { apk: "/a/app.apk", iosZip: null })).toThrow(/zipped/);
    expect(() => planCloudJobs("parallel", [], "android", artifacts)).toThrow(/No flow/);
  });
});

/** Fake cloud: each job finishes with the status given for its flow name. */
function fakeCloud(finish: Record<string, "passed" | "failed" | "error">, refuse: string[] = []) {
  let next = 0;
  const submitted: string[] = [];
  return {
    submitted,
    submit: async (input: { yamlPaths: string[]; platform: string }) => {
      const flow = input.yamlPaths[0];
      if (refuse.includes(flow)) throw Object.assign(new Error("Quota exceeded"), { code: "QUOTA_EXCEEDED" });
      submitted.push(flow);
      return { jobId: `job-${next++}`, billed: true };
    },
    watch: (jobId: string, handlers: any) => {
      const flow = submitted[Number(jobId.split("-")[1])];
      queueMicrotask(() =>
        handlers.onFinished({ job: { jobId, status: finish[flow] ?? "passed", error: null, reportUrl: `https://r/${jobId}` }, detail: {} }),
      );
      return Object.assign(Promise.resolve(), { stop() {} }) as any;
    },
  };
}

describe("runCloudParallel", () => {
  it("submits every job and reports each outcome", async () => {
    const cloud = fakeCloud({ "/f/b.yaml": "failed" });
    const jobs = planCloudJobs("parallel", ["/f/a.yaml", "/f/b.yaml"], "android", artifacts);
    const outcomes = await runCloudParallel(jobs, cloud);
    expect(outcomes.map((o) => o.state)).toEqual(["passed", "failed"]);
    expect(outcomes[1].reportUrl).toBe("https://r/job-1");
    expect(cloudRunPassed(outcomes)).toBe(false);
  });

  it("stops submitting after a quota refusal but keeps accepted jobs", async () => {
    const cloud = fakeCloud({}, ["/f/b.yaml"]);
    const jobs = planCloudJobs("parallel", ["/f/a.yaml", "/f/b.yaml", "/f/c.yaml"], "android", artifacts);
    const outcomes: CloudJobOutcome[] = await runCloudParallel(jobs, {
      ...cloud,
      isQuotaError: (err) => (err as { code?: string }).code === "QUOTA_EXCEEDED",
    });
    expect(cloud.submitted).toEqual(["/f/a.yaml"]);
    expect(outcomes[0].state).toBe("passed");
    expect(outcomes[1].state).toBe("error");
    expect(outcomes[2].state).toBe("not_submitted");
    expect(outcomes[2].message).toMatch(/quota/);
  });

  it("is passed only when every job passed", () => {
    const base = { platform: "ios" as const, flows: [], jobId: "x", message: null, reportUrl: null };
    expect(cloudRunPassed([{ ...base, state: "passed" }, { ...base, state: "passed" }])).toBe(true);
    expect(cloudRunPassed([{ ...base, state: "passed" }, { ...base, state: "gave_up" }])).toBe(false);
    expect(cloudRunPassed([])).toBe(false);
  });
});
