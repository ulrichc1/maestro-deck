import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeFlow } from "../src/maestro.js";
import type { Device, Job } from "../src/types.js";

// Fake `maestro` CLI: records its argv, writes the JUnit report it is asked
// for, and fails when the device id is "bad" or the flow name contains "fail".
let dir: string;
let fakeBin: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-maestro-"));
  fakeBin = join(dir, "maestro");
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const udid = args[args.indexOf("--udid") + 1];
const flow = args[args.indexOf("test") + 1];
const output = args[args.indexOf("--output") + 1];
const failed0 = udid === "bad" || flow.includes("fail");
fs.writeFileSync(output, failed0
  ? '<testsuites><testsuite><testcase name="x"><failure>Assertion is false: "Login" is visible</failure></testcase></testsuite></testsuites>'
  : "<testsuites/>");
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
setTimeout(() => {
  const failed = udid === "bad" || flow.includes("fail");
  if (failed) console.error("assertion failed on " + udid);
  process.exit(failed ? 1 : 0);
}, Number(process.env.FAKE_DELAY_MS || 20));
`,
  );
  chmodSync(fakeBin, 0o755);
});
afterAll(() => {});

const device = (id: string): Device => ({ id, name: id, platform: "android", state: "device", virtual: true, usable: true });
const job = (flow: string): Job => ({ id: `job-${flow}`, flow, platform: "android", deviceId: "" });
const noSignal = new AbortController().signal;

describe("executeFlow with a fake maestro", () => {
  it("passes exit 0 and writes the JUnit report under the job directory", async () => {
    const artifacts = join(dir, "run-pass");
    const log = join(dir, "argv-pass.log");
    process.env.ARGV_LOG = log;
    const run = executeFlow({ bin: fakeBin, artifactsDir: artifacts });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.reportPath).toBe(join(artifacts, "job-ok.yaml", "junit.xml"));
    expect(readFileSync(result.reportPath!, "utf8")).toContain("testsuites");
    const argv = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]);
    expect(argv.slice(0, 2)).toEqual(["--udid", "emulator-5554"]);
    expect(argv).toContain("--format");
    expect(argv).toContain("JUNIT");
  });

  it("reports failed with the stderr tail when the flow fails", async () => {
    process.env.ARGV_LOG = join(dir, "argv-fail.log");
    const run = executeFlow({ bin: fakeBin, artifactsDir: join(dir, "run-fail") });
    const result = await run(job("fail-login.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.errorTail).toContain("Assertion is false");
  });

  it("reports error, not failed, when Maestro says the device is not connected", async () => {
    const notConnected = join(dir, "maestro-unplugged");
    writeFileSync(notConnected, `#!/bin/sh\necho "Device X was requested, but it is not connected." >&2\nexit 1\n`);
    chmodSync(notConnected, 0o755);
    const run = executeFlow({ bin: notConnected, artifactsDir: join(dir, "run-unplugged") });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("error");
    expect(result.errorTail).toContain("Device or driver problem");
  });

  it("reports error when the binary cannot start", async () => {
    const run = executeFlow({ bin: join(dir, "does-not-exist"), artifactsDir: join(dir, "run-missing") });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("error");
    expect(result.errorTail).toMatch(/ENOENT/);
  });

  it("kills the child and reports cancelled when aborted", async () => {
    process.env.FAKE_DELAY_MS = "5000";
    process.env.ARGV_LOG = join(dir, "argv-cancel.log");
    const controller = new AbortController();
    const run = executeFlow({ bin: fakeBin, artifactsDir: join(dir, "run-cancel") });
    const promise = run(job("slow.yaml"), device("emulator-5554"), controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    delete process.env.FAKE_DELAY_MS;
    expect(result.status).toBe("cancelled");
    expect(existsSync(join(dir, "run-cancel", "job-slow.yaml"))).toBe(true);
  });

  it("reports error for a crash with a device-loss stack trace and no test result", async () => {
    const crash = join(dir, "maestro-crash");
    writeFileSync(
      crash,
      `#!/bin/sh
echo "Exception in thread main" >&2
echo "  at maestro.cli.session.MaestroSessionManager.newSession(MaestroSessionManager.kt:66)" >&2
exit 1
`,
    );
    chmodSync(crash, 0o755);
    const run = executeFlow({ bin: crash, artifactsDir: join(dir, "run-crash") });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("error");
    expect(result.errorTail).toContain("MaestroSessionManager");
  });

  it("keeps a real assertion failure as failed even if the output also has a stack trace", async () => {
    const mixed = join(dir, "maestro-mixed");
    writeFileSync(
      mixed,
      `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("--output") + 1], '<testsuites><testsuite><testcase name="x"><failure>Assertion is false: "Login" is visible</failure></testcase></testsuite></testsuites>');
console.error("at maestro.cli.session.MaestroSessionManager.close(MaestroSessionManager.kt:10)");
process.exit(1);
`,
    );
    chmodSync(mixed, 0o755);
    const run = executeFlow({ bin: mixed, artifactsDir: join(dir, "run-mixed") });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("failed");
    expect(result.errorTail).toContain("Assertion is false");
  });

  it("keeps a flow syntax error as failed: it is the flow's fault, not the device's", async () => {
    const syntax = join(dir, "maestro-syntax");
    writeFileSync(syntax, `#!/bin/sh\necho "Flow syntax error: unknown command tapOnn at line 4" >&2\nexit 1\n`);
    chmodSync(syntax, 0o755);
    const run = executeFlow({ bin: syntax, artifactsDir: join(dir, "run-syntax") });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("failed");
    expect(result.errorTail).toContain("syntax error");
  });

  it("reports error when the JUnit failure is a dead device server, not an assertion", async () => {
    const died = join(dir, "maestro-died");
    writeFileSync(
      died,
      `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("--output") + 1], '<testsuites><testsuite><testcase name="x"><failure>maestro.android.DeviceServerDiedException: Device server died during viewHierarchy on emulator-5560</failure></testcase></testsuite></testsuites>');
process.exit(1);
`,
    );
    chmodSync(died, 0o755);
    const run = executeFlow({ bin: died, artifactsDir: join(dir, "run-died") });
    const result = await run(job("ok.yaml"), device("emulator-5560"), noSignal);
    expect(result.status).toBe("error");
    expect(result.errorTail).toContain("DeviceServerDiedException");
  });

  it("does not turn an app assertion that mentions UNAVAILABLE into an infrastructure error", async () => {
    const app = join(dir, "maestro-app");
    writeFileSync(
      app,
      `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.writeFileSync(a[a.indexOf("--output") + 1], '<testsuites><testsuite><testcase name="x"><failure>Assertion is false: "Item UNAVAILABLE" is visible</failure></testcase></testsuite></testsuites>');
process.exit(1);
`,
    );
    chmodSync(app, 0o755);
    const run = executeFlow({ bin: app, artifactsDir: join(dir, "run-app") });
    const result = await run(job("ok.yaml"), device("emulator-5554"), noSignal);
    expect(result.status).toBe("failed");
  });
});
