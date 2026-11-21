import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunManager } from "../src/runs.js";
import { createServer } from "../src/server.js";

// Everything below goes through a real MCP client and server (in memory), with a fake adb
// and a fake maestro on disk, so the tools are exercised as an agent would use them.
let dir: string;
let adb: string;
let maestro: string;
let flows: string;
let counters: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
  counters = join(dir, "counters");
  mkdirSync(counters);
  flows = join(dir, "flows");
  mkdirSync(flows);

  adb = join(dir, "adb");
  writeFileSync(
    adb,
    `#!/bin/sh
if [ "$1" = "-s" ] && [ "$3" = "emu" ]; then
  if [ "$2" = "emulator-5554" ]; then echo "Pixel_10"; else echo "Pixel_10_Pro"; fi
  echo OK; exit 0
fi
echo "List of devices attached"
printf "emulator-5554\\tdevice product:x model:sdk_gphone16k_arm64 device:x transport_id:1\\n"
printf "emulator-5556\\tdevice product:x model:sdk_gphone16k_arm64 device:x transport_id:2\\n"
`,
  );
  chmodSync(adb, 0o755);

  maestro = join(dir, "maestro");
  writeFileSync(
    maestro,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("2.10.0"); process.exit(0); }
if (a[0] === "check-syntax") {
  const body = fs.readFileSync(a[1], "utf8");
  if (body.includes("BAD")) { console.error("Syntax error: unknown command"); process.exit(1); }
  process.exit(0);
}
const udid = a[a.indexOf("--udid") + 1];
const flow = a[a.indexOf("test") + 1];
const name = path.basename(flow);
const out = a[a.indexOf("--output") + 1];
const failure = (msg) => '<testsuites><testsuite><testcase name="x"><failure>' + msg + '</failure></testcase></testsuite></testsuites>';
const counterFile = path.join(process.env.FAKE_COUNTERS, name + ".count");
const n = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
fs.writeFileSync(counterFile, String(n));
if (name.startsWith("hang")) { setTimeout(() => process.exit(0), 60000); return; }
if (name.startsWith("flaky") && n === 1) {
  fs.writeFileSync(out, failure("maestro.android.DeviceServerDiedException: Device server died on " + udid));
  process.exit(1);
}
if (name.startsWith("fail")) {
  fs.writeFileSync(out, failure('Assertion is false: "Login" is visible'));
  process.exit(1);
}
fs.writeFileSync(out, "<testsuites><testsuite><testcase name='" + name + "'/></testsuite></testsuites>");
setTimeout(() => process.exit(0), Number(process.env.FAKE_DELAY_MS || 30));
`,
  );
  chmodSync(maestro, 0o755);

  for (const f of ["ok1.yaml", "ok2.yaml", "ok3.yaml", "ok4.yaml", "fail1.yaml", "flaky1.yaml", "hang1.yaml", "hang2.yaml"]) {
    writeFileSync(join(flows, f), "appId: x\n---\n- launchApp\n");
  }
  writeFileSync(join(flows, "bad.yaml"), "appId: x\n---\n- BAD\n");
});

interface Harness {
  client: Client;
  runs: RunManager;
  home: string;
}

/** Starts a server wired to the fake adb/maestro, without any real iOS tooling on the PATH. */
async function harness(cloud: { token?: string; baseUrl?: string } = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  const runs = new RunManager(home);
  const server = createServer({ bin: maestro, adbBin: adb, runs, cloud: { token: cloud.token, baseUrl: cloud.baseUrl } });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(c);
  return { client, runs, home };
}

const withEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = { PATH: process.env.PATH, FAKE_COUNTERS: process.env.FAKE_COUNTERS };
  // Keep node reachable for the fake scripts but hide xcrun, so only the fake Android devices exist.
  process.env.PATH = `${dirname(process.execPath)}:/bin`;
  process.env.FAKE_COUNTERS = counters;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_COUNTERS === undefined) delete process.env.FAKE_COUNTERS;
    else process.env.FAKE_COUNTERS = saved.FAKE_COUNTERS;
  }
};

const call = async (h: Harness, name: string, args: Record<string, unknown> = {}) => {
  const r = await h.client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  const body = content[0].text;
  let json: unknown = body;
  try {
    json = JSON.parse(body);
  } catch {
    /* plain text */
  }
  return { isError: r.isError === true, json, body };
};

const f = (name: string) => join(flows, name);

describe("run control through the MCP", () => {
  it("discovers the two fake emulators by AVD name and checks feasibility", async () => {
    await withEnv(async () => {
      const h = await harness();
      const devices = (await call(h, "list_devices")).json as { name: string; usable: boolean }[];
      expect(devices.map((d) => d.name).sort()).toEqual(["Pixel 10", "Pixel 10 Pro"]);
      const feas = (await call(h, "check_parallel_feasibility", { mode: "android_different_models" })).json as { feasible: string };
      expect(feas.feasible).toBe("with_reserve");
      const same = (await call(h, "check_parallel_feasibility", { mode: "android_same_model" })).json as { feasible: string };
      expect(same.feasible).toBe("no");
    });
  });

  it("runs flows in parallel and waits for the verdict", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "run_flows", {
        flows: [f("ok1.yaml"), f("ok2.yaml"), f("ok3.yaml"), f("ok4.yaml")],
        mode: "android_different_models",
        waitSeconds: 30,
      });
      const res = r.json as { state: string; summary: { passed: number; total: number }; byPlatform: { android: { deviceId: string }[] } };
      expect(res.state).toBe("finished");
      expect(res.summary).toMatchObject({ passed: 4, total: 4 });
      expect(new Set(res.byPlatform.android.map((j) => j.deviceId)).size).toBe(2);
    });
  });

  it("reports a time limit as timeout and kills the job", async () => {
    await withEnv(async () => {
      const h = await harness();
      const started = Date.now();
      const r = await call(h, "run_flows", { flows: [f("hang1.yaml")], timeoutSeconds: 1, retries: 0, waitSeconds: 30 });
      const res = r.json as { summary: { timeouts: number }; byPlatform: { android: { status: string; errorTail: string }[] } };
      expect(res.summary.timeouts).toBe(1);
      expect(res.byPlatform.android[0].errorTail).toMatch(/Timed out after 1s/);
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });

  it("retries a job whose device died on another device", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "run_flows", { flows: [f("flaky1.yaml")], mode: "android_different_models", retries: 1, waitSeconds: 30 });
      const res = r.json as { summary: { passed: number; retried: number }; byPlatform: { android: { attempts: number; devicesTried: string[] }[] } };
      expect(res.summary).toMatchObject({ passed: 1, retried: 1 });
      expect(res.byPlatform.android[0].attempts).toBe(2);
      expect(new Set(res.byPlatform.android[0].devicesTried).size).toBe(2);
    });
  });

  it("does not retry a real assertion failure and exposes its JUnit report", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "run_flows", { flows: [f("fail1.yaml")], retries: 2, waitSeconds: 30 });
      const res = r.json as { id: string; summary: { failed: number; retried: number } };
      expect(res.summary).toMatchObject({ failed: 1, retried: 0 });
      const report = (await call(h, "get_run_report", { runId: res.id })).json as { status: string; junit: string; files: string[] }[];
      expect(report[0].status).toBe("failed");
      expect(report[0].junit).toContain("Assertion is false");
      expect(report[0].files).toContain("junit.xml");
    });
  });

  it("cancels a running run: the job is stopped and the rest cancelled", async () => {
    await withEnv(async () => {
      const h = await harness();
      const started = (await call(h, "run_flows", { flows: [f("hang1.yaml"), f("hang2.yaml"), f("ok1.yaml")], mode: "android_different_models" })).json as { runId: string };
      await new Promise((r) => setTimeout(r, 600));
      expect((await call(h, "cancel_run", { runId: started.runId })).isError).toBe(false);
      const res = (await call(h, "wait_for_run", { runId: started.runId, waitSeconds: 20 })).json as { state: string; summary: { cancelled: number } };
      expect(res.state).toBe("cancelled");
      expect(res.summary.cancelled).toBe(3);
      expect((await call(h, "cancel_run", { runId: started.runId })).isError).toBe(true);
    });
  });

  it("stopAll stops every running run and waits for the processes", async () => {
    await withEnv(async () => {
      const h = await harness();
      const started = (await call(h, "run_flows", { flows: [f("hang1.yaml")] })).json as { runId: string };
      await new Promise((r) => setTimeout(r, 400));
      const t0 = Date.now();
      await h.runs.stopAll(10_000);
      expect(Date.now() - t0).toBeLessThan(9000);
      expect(h.runs.get(started.runId)?.state).toBe("cancelled");
    });
  });

  it("still knows finished runs after a restart, and marks a run left running as interrupted", async () => {
    await withEnv(async () => {
      const h = await harness();
      const done = (await call(h, "run_flows", { flows: [f("ok1.yaml")], waitSeconds: 30 })).json as { id: string };
      // A second manager on the same home stands for a restarted server.
      const restarted = new RunManager(h.home);
      expect(restarted.get(done.id)?.state).toBe("finished");
      expect(restarted.list().map((r) => r.id)).toContain(done.id);
      // Fake a record left "running" by a crashed process.
      const crashedId = "11111111-2222-3333-4444-555555555555";
      const crashedDir = join(h.home, "runs", crashedId);
      mkdirSync(crashedDir, { recursive: true });
      const record = JSON.parse(readFileSync(join(h.home, "runs", done.id, "run.json"), "utf8"));
      writeFileSync(join(crashedDir, "run.json"), JSON.stringify({ ...record, id: crashedId, state: "running" }));
      expect(new RunManager(h.home).get(crashedId)?.state).toBe("interrupted");
    });
  });

  it("refuses an infeasible mode with a clear reason", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "run_flows", { flows: [f("ok1.yaml")], mode: "ios_android" });
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/not feasible/);
    });
  });
});

describe("flows and workflow tools", () => {
  it("lists, reads and syntax-checks flows", async () => {
    await withEnv(async () => {
      const h = await harness();
      const list = (await call(h, "list_flows", { directory: flows })).json as string[];
      expect(list).toContain(f("ok1.yaml"));
      expect((await call(h, "read_flow", { path: f("ok1.yaml") })).body).toContain("launchApp");
      const check = (await call(h, "check_flow_syntax", { flows: [f("ok1.yaml"), f("bad.yaml")] })).json as { allValid: boolean; results: { valid: boolean; message?: string }[] };
      expect(check.allValid).toBe(false);
      expect(check.results.map((r) => r.valid)).toEqual([true, false]);
      expect(check.results[1].message).toContain("Syntax error");
    });
  });

  it("generates valid GitHub workflows and rejects injection attempts", async () => {
    const h = await harness();
    for (const platform of ["android", "ios"] as const) {
      const r = await call(h, "generate_github_workflow", { flows: "flows/", platform, shards: 3 });
      expect(r.isError).toBe(false);
      const doc = parseYaml(r.body) as { jobs: Record<string, { strategy: { matrix: { shard: number[] } } }> };
      expect(doc.jobs[platform].strategy.matrix.shard).toEqual([0, 1, 2]);
    }
    const bad = await call(h, "generate_github_workflow", { flows: "flows/; rm -rf /", platform: "android" });
    expect(bad.isError).toBe(true);
  });
});

// A fake of the cloud API, with a switch to refuse jobs for quota.
interface CloudFake {
  server: Server;
  baseUrl: string;
  requests: string[];
  refuseFinalizeAfter: number;
}

async function startCloudFake(): Promise<CloudFake> {
  const requests: string[] = [];
  const state = { finalized: 0, jobSeq: 0 };
  const fake = { requests, refuseFinalizeAfter: Infinity } as CloudFake;
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
  const server = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    requests.push(`${req.method} ${req.url}`);
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url?.startsWith("/upload/")) return send(200, {});
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: "UNAUTHENTICATED" });
    if (req.method === "POST" && req.url === "/api/jobs/init") {
      const input = JSON.parse(body) as { yamls: { name: string }[] };
      const jobId = `job-${++state.jobSeq}`;
      return send(200, {
        jobId,
        apk: { uploadUrl: `${fake.baseUrl}/upload/apk/${jobId}`, gsPath: `gs://b/${jobId}/app.apk` },
        yamls: input.yamls.map((y, i) => ({ name: y.name, uploadUrl: `${fake.baseUrl}/upload/y${i}/${jobId}`, gsPath: `gs://b/${jobId}/${y.name}` })),
      });
    }
    if (req.method === "POST" && req.url === "/api/jobs/finalize") {
      if (state.finalized >= fake.refuseFinalizeAfter) return send(429, { error: "QUOTA_EXCEEDED", message: "No runs left." });
      state.finalized++;
      return send(200, {});
    }
    const m = /^\/api\/jobs\/([\w-]+)\/status$/.exec(req.url ?? "");
    if (m) return send(200, { jobId: m[1], status: "passed", reportUrl: `https://dashboard.example/runs/${m[1]}` });
    return send(404, { error: "NOT_FOUND" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  fake.server = server;
  fake.baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return fake;
}

describe("cloud tools", () => {
  let cloud: CloudFake;
  let apk: string;
  beforeAll(async () => {
    cloud = await startCloudFake();
    apk = join(dir, "app.apk");
    writeFileSync(apk, "fake apk");
  });
  afterAll(() => {
    cloud.server.close();
  });

  it("does not submit, or spend, anything without confirmSpend", async () => {
    const before = cloud.requests.length;
    const h = await harness({ token: "test-token", baseUrl: cloud.baseUrl });
    const r = await call(h, "cloud_run_flows", { flows: [f("ok1.yaml"), f("ok2.yaml")], mode: "parallel", appPath: apk });
    expect((r.json as { submitted: boolean; wouldSpendRuns: number })).toMatchObject({ submitted: false, wouldSpendRuns: 2 });
    expect(cloud.requests.length).toBe(before);
  });

  it("submits one job per flow in parallel mode and reads their status", async () => {
    const h = await harness({ token: "test-token", baseUrl: cloud.baseUrl });
    const r = await call(h, "cloud_run_flows", {
      flows: [f("ok1.yaml"), f("ok2.yaml")], mode: "parallel", appPath: apk, confirmSpend: true, waitSeconds: 10,
    });
    const res = r.json as { runsSpent: number; jobs: { jobId: string }[]; statuses: { status: string }[] };
    expect(res.runsSpent).toBe(2);
    expect(res.statuses.map((s) => s.status)).toEqual(["passed", "passed"]);
    const status = (await call(h, "cloud_get_jobs", { jobIds: res.jobs.map((j) => j.jobId) })).json as { reportUrl: string }[];
    expect(status[0].reportUrl).toContain("dashboard.example");
  });

  it("stops submitting after a quota refusal and reports what was spent", async () => {
    const h = await harness({ token: "test-token", baseUrl: cloud.baseUrl });
    // The fake accepts exactly one more job, then answers QUOTA_EXCEEDED.
    const finalizedSoFar = cloud.requests.filter((q) => q === "POST /api/jobs/finalize").length;
    cloud.refuseFinalizeAfter = finalizedSoFar + 1;
    try {
      const r = await call(h, "cloud_run_flows", {
        flows: [f("ok1.yaml"), f("ok2.yaml"), f("ok3.yaml")], mode: "parallel", appPath: apk, confirmSpend: true,
      });
      const res = r.json as { runsSpent: number; jobs: { jobId?: string; error?: string }[] };
      expect(res.runsSpent).toBe(1);
      expect(res.jobs[1].error).toMatch(/No runs left/);
      expect(res.jobs[2].error).toMatch(/earlier job was refused/);
    } finally {
      cloud.refuseFinalizeAfter = Infinity;
    }
  });

  it("fails clearly without a token and with a rejected token", async () => {
    const none = await harness({ baseUrl: cloud.baseUrl });
    const r1 = await call(none, "cloud_run_flows", { flows: [f("ok1.yaml")], appPath: apk, confirmSpend: true });
    expect(r1.isError).toBe(true);
    expect(r1.body).toMatch(/MAESTRO_DECK_CLOUD_TOKEN/);
    const wrong = await harness({ token: "expired", baseUrl: cloud.baseUrl });
    const r2 = await call(wrong, "cloud_get_jobs", { jobIds: ["job-1"] });
    expect(r2.isError).toBe(true);
    expect(r2.body).toMatch(/rejected or has expired/);
  });

  it("never prints the token", async () => {
    const h = await harness({ token: "test-token", baseUrl: cloud.baseUrl });
    const r = await call(h, "doctor");
    expect(r.body).not.toContain("test-token");
    expect((r.json as { cloudTokenConfigured: boolean }).cloudTokenConfigured).toBe(true);
  });
});
