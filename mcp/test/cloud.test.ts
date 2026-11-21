import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudError, getCloudJobStatus, planCloudJobs, submitCloudJob, waitForCloudJobs } from "../src/cloud.js";

const artifacts = { apk: "/a/app.apk", iosZip: "/a/App.zip" };
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("planCloudJobs", () => {
  const flows = ["/f/a.yaml", "/f/b.yaml"];
  it("sequential: one job with every flow", () => {
    expect(planCloudJobs("sequential", flows, "android", artifacts)).toEqual([{ platform: "android", appPath: "/a/app.apk", yamlPaths: flows }]);
  });
  it("parallel: one job per flow", () => {
    expect(planCloudJobs("parallel", flows, "ios", artifacts).map((j) => j.yamlPaths)).toEqual([["/f/a.yaml"], ["/f/b.yaml"]]);
  });
  it("ios_android: an iOS and an Android job per flow", () => {
    const jobs = planCloudJobs("ios_android", flows, "android", artifacts);
    expect(jobs.map((j) => j.platform)).toEqual(["ios", "android", "ios", "android"]);
  });
  it("refuses missing artefacts and empty flow lists before anything is sent", () => {
    expect(() => planCloudJobs("parallel", flows, "android", {})).toThrow(/appPath/);
    expect(() => planCloudJobs("ios_android", flows, "android", { apk: "/a/app.apk" })).toThrow(/iosAppPath/);
    expect(() => planCloudJobs("parallel", [], "android", artifacts)).toThrow(/No flow/);
  });
});

describe("submitCloudJob safety", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-"));
  const apk = join(dir, "app.apk");
  const yaml = join(dir, "a.yaml");
  writeFileSync(apk, "x");
  writeFileSync(yaml, "appId: x\n");

  it("refuses to upload to a host that is not Google Cloud Storage", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/api/jobs/init")) {
        return jsonResponse(200, {
          jobId: "j1",
          apk: { uploadUrl: "https://evil.example/steal", gsPath: "gs://b/j1/app.apk" },
          yamls: [{ name: "a.yaml", uploadUrl: "https://storage.googleapis.com/b/j1/a.yaml", gsPath: "gs://b/j1/a.yaml" }],
        });
      }
      return jsonResponse(200, {});
    }) as typeof fetch;
    await expect(
      submitCloudJob({ token: "t", fetchImpl }, { platform: "android", appPath: apk, yamlPaths: [yaml] }),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(calls.some((c) => c.includes("evil.example"))).toBe(false);
    expect(calls.some((c) => c.includes("/finalize"))).toBe(false);
  });

  it("does not call the API at all without a token", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse(200, {});
    }) as typeof fetch;
    await expect(submitCloudJob({ token: undefined, fetchImpl }, { platform: "android", appPath: apk, yamlPaths: [yaml] })).rejects.toMatchObject({
      code: "NO_TOKEN",
    });
    expect(called).toBe(false);
  });

  it("rejects an API path that could change the host and a malformed job id", async () => {
    await expect(getCloudJobStatus({ token: "t" }, "../../etc")).rejects.toBeInstanceOf(CloudError);
    await expect(getCloudJobStatus({ token: "t" }, "a b")).rejects.toBeInstanceOf(CloudError);
  });

  it("maps 401 and quota answers to clear error codes", async () => {
    const make = (status: number, body: unknown) => (async () => jsonResponse(status, body)) as unknown as typeof fetch;
    await expect(getCloudJobStatus({ token: "t", fetchImpl: make(401, {}) }, "j1")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      submitCloudJob({ token: "t", fetchImpl: make(429, { error: "QUOTA_EXCEEDED", message: "No runs left." }) }, { platform: "android", appPath: apk, yamlPaths: [yaml] }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});

describe("waitForCloudJobs", () => {
  it("polls until every job is terminal", async () => {
    let n = 0;
    const fetchImpl = (async () => jsonResponse(200, { jobId: "j", status: ++n < 3 ? "running" : "passed" })) as unknown as typeof fetch;
    const statuses = await waitForCloudJobs({ token: "t", fetchImpl }, ["j"], 5000, 5);
    expect(statuses[0].status).toBe("passed");
    expect(n).toBe(3);
  });
  it("returns the latest statuses when the wait runs out", async () => {
    const fetchImpl = (async () => jsonResponse(200, { jobId: "j", status: "running" })) as unknown as typeof fetch;
    const statuses = await waitForCloudJobs({ token: "t", fetchImpl }, ["j"], 30, 10);
    expect(statuses[0].status).toBe("running");
  });
});
