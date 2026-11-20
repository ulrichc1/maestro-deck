import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, collectFlows, main, parseArgs } from "../src/cli.js";

let dir: string;
let adb: string;
let maestro: string;
let flowsDir: string;

// Fake adb: prints two Pixel_10 emulators, or the list named by FAKE_ADB_DEVICES.
// Fake maestro: writes JUnit, fails when the flow name contains "fail".
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-"));
  adb = join(dir, "adb");
  writeFileSync(adb, `#!/bin/sh
echo "List of devices attached"
if [ -n "$FAKE_ADB_DEVICES" ]; then printf "%b" "$FAKE_ADB_DEVICES"; else
printf "emulator-5554\\tdevice product:x model:Pixel_10 device:x transport_id:1\\n"
printf "emulator-5556\\tdevice product:x model:Pixel_10 device:x transport_id:2\\n"; fi
`);
  chmodSync(adb, 0o755);
  maestro = join(dir, "maestro");
  writeFileSync(maestro, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const flow = a[a.indexOf("test") + 1];
const out = a[a.indexOf("--output") + 1];
fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
fs.writeFileSync(out, "<testsuites/>");
process.exit(flow.includes("fail") ? 1 : 0);
`);
  chmodSync(maestro, 0o755);
  flowsDir = join(dir, "flows");
  mkdirSync(flowsDir);
  for (const name of ["a.yaml", "b.yaml", "c.yaml"]) writeFileSync(join(flowsDir, name), "appId: x\n---\n- launchApp\n");
});

afterEach(() => {
  delete process.env.FAKE_ADB_DEVICES;
});

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  ADB_BIN: adb,
  MAESTRO_BIN: maestro,
  GITHUB_STEP_SUMMARY: "",
  ...extra,
});

describe("parseArgs and collectFlows", () => {
  it("requires --flows", () => {
    expect(() => parseArgs([])).toThrow(/--flows is required/);
  });
  it("rejects an unknown mode", () => {
    expect(() => parseArgs(["--flows", "x.yaml", "--mode", "turbo"])).toThrow(/Unknown --mode/);
  });
  it("expands directories to sorted YAML files only", () => {
    writeFileSync(join(flowsDir, "notes.txt"), "x");
    const files = collectFlows([flowsDir]);
    expect(files.map((f) => f.split("/").pop())).toEqual(["a.yaml", "b.yaml", "c.yaml"]);
  });
});

describe("maestro-deck-run main", () => {
  it("exits 0 when every flow passes, and writes summary files", async () => {
    const output = join(dir, "out");
    const code = await main(["--flows", flowsDir, "--mode", "android_same_model", "--output", output], env());
    expect(code).toBe(EXIT.OK);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    expect(summary.total).toBe(3);
    expect(summary.success).toBe(true);
    expect(readFileSync(join(output, "summary.md"), "utf8")).toContain("All jobs passed");
  });

  it("exits 1 when a flow fails", async () => {
    writeFileSync(join(flowsDir, "fail-login.yaml"), "appId: x\n---\n- launchApp\n");
    const output = join(dir, "out-fail");
    const code = await main(["--flows", flowsDir, "--output", output], env());
    expect(code).toBe(EXIT.TESTS_FAILED);
  });

  it("exits 2 when the requested mode is not feasible with the devices present", async () => {
    process.env.FAKE_ADB_DEVICES = "emulator-5554\\tdevice model:Pixel_10 device:x\\n";
    const code = await main(["--flows", flowsDir, "--mode", "android_same_model", "--output", join(dir, "o")], env());
    expect(code).toBe(EXIT.INFRA);
  });

  it("runs only its shard of the flows", async () => {
    const output = join(dir, "out-shard");
    const code = await main(["--flows", flowsDir, "--shard-index", "1", "--shard-count", "3", "--output", output], env());
    expect(code).toBe(EXIT.OK);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    expect(summary.total).toBe(1);
    expect(summary.jobs[0].flow.endsWith("b.yaml")).toBe(true);
  });

  it("appends the markdown summary to GITHUB_STEP_SUMMARY", async () => {
    const step = join(dir, "step.md");
    writeFileSync(step, "");
    await main(["--flows", flowsDir, "--output", join(dir, "o2")], env({ GITHUB_STEP_SUMMARY: step }));
    expect(readFileSync(step, "utf8")).toContain("Maestro Deck");
  });
});
