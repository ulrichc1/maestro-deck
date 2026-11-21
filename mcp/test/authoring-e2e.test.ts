import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { DeviceCtx, Exec, ExecResult } from "../src/devicetools.js";
import { DeviceLocks } from "../src/locks.js";
import { RunManager } from "../src/runs.js";
import { createServer } from "../src/server.js";

const HIERARCHY = join(__dirname, "fixtures/failed-assertion/2026-11-21_000000/settings-fail/screen-hierarchy/step-004-assertCondition-Nonexistent_screen_text.json");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let dir: string;
let adb: string;
let maestro: string;
let counters: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "authoring-"));
  counters = join(dir, "counters");
  mkdirSync(counters);

  // adb only answers device discovery here; every other device command goes through the fake exec.
  adb = join(dir, "adb");
  writeFileSync(
    adb,
    `#!/bin/sh
if [ "$1" = "-s" ] && [ "$3" = "emu" ]; then echo "Pixel_10"; echo OK; exit 0; fi
echo "List of devices attached"
printf "emulator-5554\\tdevice product:x model:sdk_gphone16k_arm64 device:x transport_id:1\\n"
`,
  );
  chmodSync(adb, 0o755);

  // A Maestro that leaves the same artifacts as the real one: commands.json, and on failure a
  // screenshot and the hierarchy of the screen. A step containing FAILME fails.
  maestro = join(dir, "maestro");
  writeFileSync(
    maestro,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("2.10.0"); process.exit(0); }
if (a[0] === "check-syntax") {
  if (fs.readFileSync(a[1], "utf8").includes("SYNTAXBAD")) { console.error("Syntax error: unknown command SYNTAXBAD"); process.exit(1); }
  process.exit(0);
}
const t = a.indexOf("test");
let i = t + 1;
while (a[i] === "-e") i += 2;
const flow = a[i];
const outDir = a[a.indexOf("--test-output-dir") + 1];
const junit = a[a.indexOf("--output") + 1];
const body = fs.readFileSync(flow, "utf8");
const steps = body.split("\\n---\\n")[1].split("\\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
const name = path.basename(flow, ".yaml");
const dir = path.join(outDir, "2026-01-01_000000", name);
fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
fs.mkdirSync(path.join(dir, "screen-hierarchy"), { recursive: true });
fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
const cmd = (type, inner, n, status, extra) => ({ command: { [type]: inner }, metadata: { status, sequenceNumber: n, depth: 0, duration: 5, ...extra } });
const commands = [cmd("defineVariablesCommand", { env: {} }, 0, "COMPLETED"), cmd("applyConfigurationCommand", {}, 1, "COMPLETED")];
let failed = false;
let message = "";
steps.forEach((s, k) => {
  if (failed) return;
  const verb = s.split(":")[0].trim();
  const type = (verb === "assertVisible" ? "assertCondition" : verb === "tapOn" ? "tapOnElement" : verb) + "Command";
  const text = (s.split(":")[1] || "").trim().replace(/^"|"$/g, "");
  if (s.includes("FAILME")) {
    failed = true;
    message = 'Assertion is false: "' + text + '" is visible';
    fs.writeFileSync(path.join(dir, "screenshots", "step-00" + (k + 1) + ".png"), Buffer.from("${PNG.toString("base64")}", "base64"));
    fs.copyFileSync(process.env.FAKE_HIERARCHY, path.join(dir, "screen-hierarchy", "step-00" + (k + 1) + ".json"));
    commands.push(cmd(type, { condition: { visible: { textRegex: text, optional: false } } }, k + 2, "FAILED", {
      error: { message },
      artifacts: [{ type: "SCREEN_HIERARCHY", path: "screen-hierarchy/step-00" + (k + 1) + ".json" }, { type: "SCREENSHOT", path: "screenshots/step-00" + (k + 1) + ".png" }],
    }));
  } else {
    commands.push(cmd(type, { text }, k + 2, "COMPLETED"));
  }
});
fs.writeFileSync(path.join(dir, "commands.json"), JSON.stringify(commands));
fs.writeFileSync(path.join(dir, "logs", "maestro.log"), failed ? "00:00:00 [ERROR] CommandFailed: " + message + "\\n" : "");
fs.writeFileSync(junit, failed ? '<testsuites><testsuite><testcase name="x"><failure>' + message + '</failure></testcase></testsuite></testsuites>' : "<testsuites/>");
setTimeout(() => process.exit(failed ? 1 : 0), Number(process.env.FAKE_DELAY_MS || 20));
`,
  );
  chmodSync(maestro, 0o755);
});

interface Call {
  file: string;
  args: string[];
}

/** A command runner for the device tools that records what was asked and answers like the real tools. */
function fakeExec(calls: Call[], overrides: Partial<Record<string, (args: string[]) => ExecResult>> = {}): Exec {
  const ok = (stdout: string | Buffer = "", code: number | null = 0, stderr = ""): ExecResult => ({
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr, code,
  });
  return async (file, args) => {
    calls.push({ file, args });
    const key = `${file.split("/").pop()} ${args.join(" ")}`;
    for (const [pattern, fn] of Object.entries(overrides)) if (key.includes(pattern) && fn) return fn(args);
    const tool = file.split("/").pop();
    if (tool === "adb") {
      if (args.includes("screencap")) return ok(PNG);
      if (args.includes("packages")) return ok("package:com.example.one\npackage:com.example.two\n");
      if (args.includes("install")) return ok("Performing Streamed Install\nSuccess\n");
      if (args.includes("devices")) return ok("List of devices attached\nemulator-5554\tdevice\n");
      if (args.includes("emu") && args.includes("kill")) return ok("OK: killing emulator, bye bye\n");
      if (args.includes("emu")) return ok("Pixel_10\nOK\n");
      if (args.includes("getprop")) return ok("1\n");
    }
    if (tool === "maestro" && args.includes("hierarchy")) return ok(readFileSync(HIERARCHY));
    if (tool === "emulator") return ok("INFO    | Storing crashdata\nPixel_10\nPixel_10_Pro\n");
    return ok();
  };
}

interface Harness {
  client: Client;
  runs: RunManager;
  home: string;
  root: string;
  calls: Call[];
  locks: DeviceLocks;
}

async function harness(overrides: Partial<Record<string, (args: string[]) => ExecResult>> = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "auth-home-"));
  const root = mkdtempSync(join(tmpdir(), "auth-root-"));
  const calls: Call[] = [];
  const runs = new RunManager(home);
  const locks = new DeviceLocks();
  const ctx: DeviceCtx = { adbBin: adb, maestroBin: maestro, emulatorBin: "/sdk/emulator/emulator", logDir: join(home, "logs"), exec: fakeExec(calls, overrides) };
  const server = createServer({ bin: maestro, adbBin: adb, runs, cloud: { token: undefined }, ctx, locks, flowRoots: [root] });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "auth", version: "0.0.0" });
  await client.connect(c);
  return { client, runs, home, root, calls, locks };
}

const withEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = { PATH: process.env.PATH, FAKE_HIERARCHY: process.env.FAKE_HIERARCHY };
  process.env.PATH = `${dirname(process.execPath)}:/bin`; // node reachable, xcrun hidden
  process.env.FAKE_HIERARCHY = HIERARCHY;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_HIERARCHY === undefined) delete process.env.FAKE_HIERARCHY;
    else process.env.FAKE_HIERARCHY = saved.FAKE_HIERARCHY;
  }
};

interface Reply {
  isError: boolean;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  body: string;
  images: number;
}
const call = async (h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
  const r = await h.client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text?: string }[];
  const body = content.find((c) => c.type === "text")?.text ?? "";
  let json: unknown = body;
  try {
    json = JSON.parse(body);
  } catch {
    /* plain text */
  }
  return { isError: r.isError === true, json, body, images: content.filter((c) => c.type === "image").length };
};

describe("creating and editing flows", () => {
  it("writes a flow from a header and steps, and it can be read back", async () => {
    const h = await harness();
    const r = await call(h, "write_flow", { path: "login.yaml", appId: "com.example", name: "Login", tags: ["smoke"], steps: ["launchApp", { tapOn: "Email" }, "- inputText: me@x.com", "assertVisible: Welcome"] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ result: "created", appId: "com.example", steps: 4, syntax: "valid" });
    const file = join(h.root, "login.yaml");
    expect(readFileSync(file, "utf8")).toContain("- inputText: me@x.com");
    const d = await call(h, "describe_flow", { path: file });
    expect(d.json.steps.map((s: { index: number; line: number }) => [s.index, s.line])).toEqual([[0, 6], [1, 7], [2, 8], [3, 9]]);
    expect(d.json.steps[1].yaml).toBe("- tapOn: Email");
  });

  it("never overwrites a flow unless asked", async () => {
    const h = await harness();
    await call(h, "write_flow", { path: "a.yaml", appId: "x", steps: ["launchApp"] });
    const again = await call(h, "write_flow", { path: "a.yaml", appId: "x", steps: ["back"] });
    expect(again.isError).toBe(true);
    expect(again.body).toMatch(/already exists/);
    expect(readFileSync(join(h.root, "a.yaml"), "utf8")).toContain("launchApp");
    const forced = await call(h, "write_flow", { path: "a.yaml", appId: "x", steps: ["back"], overwrite: true });
    expect(forced.json.result).toBe("overwritten");
  });

  it("delete_flow only shows what it would remove until it is confirmed", async () => {
    const h = await harness();
    await call(h, "write_flow", { path: "gone.yaml", appId: "com.example", name: "Gone", steps: ["launchApp", "back"] });
    const file = join(h.root, "gone.yaml");
    const preview = await call(h, "delete_flow", { path: "gone.yaml" });
    expect(preview.json).toMatchObject({ deleted: false, wouldDelete: { appId: "com.example", name: "Gone", steps: 2 } });
    expect(existsSync(file)).toBe(true);
    const done = await call(h, "delete_flow", { path: "gone.yaml", confirm: true });
    expect(done.json).toMatchObject({ deleted: true, was: { appId: "com.example" } });
    expect(existsSync(file)).toBe(false);
    expect((await call(h, "delete_flow", { path: "gone.yaml", confirm: true })).body).toMatch(/Flow not found/);
  });

  it("delete_flow stays inside the project folder, on YAML files, and never follows a symlink", async () => {
    const h = await harness();
    const outside = join(mkdtempSync(join(tmpdir(), "auth-out-")), "victim.yaml");
    writeFileSync(outside, "appId: x\n---\n- launchApp\n");
    symlinkSync(outside, join(h.root, "link.yaml"));
    writeFileSync(join(h.root, "notes.txt"), "keep");
    mkdirSync(join(h.root, "dir.yaml"));
    expect((await call(h, "delete_flow", { path: outside, confirm: true })).body).toMatch(/outside the allowed/);
    expect((await call(h, "delete_flow", { path: "../x.yaml", confirm: true })).body).toMatch(/outside the allowed/);
    expect((await call(h, "delete_flow", { path: "link.yaml", confirm: true })).body).toMatch(/symlink/);
    expect((await call(h, "delete_flow", { path: "notes.txt", confirm: true })).body).toMatch(/\.yaml/);
    expect((await call(h, "delete_flow", { path: "dir.yaml", confirm: true })).body).toMatch(/folder/);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(h.root, "notes.txt"))).toBe(true);
    expect(existsSync(join(h.root, "dir.yaml"))).toBe(true);
  });

  it("delete_flow refuses a flow that a run in progress is using, and can delete a broken flow", async () => {
    const h = await harness();
    await call(h, "write_flow", { path: "busy.yaml", appId: "x", steps: ["launchApp"] });
    const file = join(h.root, "busy.yaml");
    const real = h.runs.list.bind(h.runs);
    h.runs.list = () => [{ id: "run-1", state: "running", flows: [file] } as never];
    const blocked = await call(h, "delete_flow", { path: "busy.yaml", confirm: true });
    expect(blocked.isError).toBe(true);
    expect(blocked.body).toMatch(/run-1/);
    expect(existsSync(file)).toBe(true);
    h.runs.list = real;
    writeFileSync(join(h.root, "broken.yaml"), "this: [is not\n a flow");
    expect((await call(h, "delete_flow", { path: "broken.yaml", confirm: true })).json.deleted).toBe(true);
    expect((await call(h, "delete_flow", { path: "busy.yaml", confirm: true })).json.deleted).toBe(true);
  });

  it("refuses to write outside the project folder or a non-YAML file", async () => {
    const h = await harness();
    expect((await call(h, "write_flow", { path: "../escape.yaml", appId: "x", steps: ["launchApp"] })).body).toMatch(/outside the allowed/);
    expect((await call(h, "write_flow", { path: "/tmp/elsewhere.yaml", appId: "x", steps: ["launchApp"] })).isError).toBe(true);
    expect((await call(h, "write_flow", { path: "a.txt", appId: "x", steps: ["launchApp"] })).body).toMatch(/\.yaml/);
  });

  it("writes nothing when Maestro rejects the flow, or the content is not a flow", async () => {
    await withEnv(async () => {
      const h = await harness();
      const bad = await call(h, "write_flow", { path: "bad.yaml", appId: "x", steps: ["SYNTAXBAD"] });
      expect(bad.isError).toBe(true);
      expect(bad.body).toMatch(/Maestro rejected the flow, nothing was written/);
      expect(existsSync(join(h.root, "bad.yaml"))).toBe(false);
      const notFlow = await call(h, "write_flow", { path: "n.yaml", content: "just: a map" });
      expect(notFlow.isError).toBe(true);
      expect(existsSync(join(h.root, "n.yaml"))).toBe(false);
      expect((await call(h, "write_flow", { path: "m.yaml", steps: ["launchApp"] })).body).toMatch(/appId/);
    });
  });

  it("edits a flow: insert, replace, delete, header, keeping comments", async () => {
    const h = await harness();
    await call(h, "write_flow", { path: "e.yaml", content: "# my flow\nappId: x\n---\n- launchApp\n# tap it\n- tapOn: A\n- assertVisible: B\n" });
    const file = join(h.root, "e.yaml");
    await call(h, "edit_flow", { path: "e.yaml", operation: "insert_steps", at: 1, steps: [{ waitForAnimationToEnd: {} }] });
    await call(h, "edit_flow", { path: "e.yaml", operation: "replace_step", index: 3, step: { tapOn: "A2" } });
    const del = await call(h, "edit_flow", { path: "e.yaml", operation: "delete_steps", index: 0 });
    await call(h, "edit_flow", { path: "e.yaml", operation: "set_header", name: "Renamed", tags: ["t"] });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my flow");
    expect(text).toContain("# tap it");
    expect(text).toContain("name: Renamed");
    // Step 3 (assertVisible: B) was replaced by tapOn: A2, then step 0 (launchApp) deleted.
    expect(del.json.steps).toEqual(["- waitForAnimationToEnd: {}", "- tapOn: A", "- tapOn: A2"]);
  });

  it("dry run shows the result and leaves the file alone; bad input is explained", async () => {
    const h = await harness();
    await call(h, "write_flow", { path: "d.yaml", appId: "x", steps: ["launchApp"] });
    const before = readFileSync(join(h.root, "d.yaml"), "utf8");
    const dry = await call(h, "edit_flow", { path: "d.yaml", operation: "insert_steps", steps: ["back"], dryRun: true });
    expect(dry.json).toMatchObject({ dryRun: true });
    expect(dry.json.content).toContain("- back");
    expect(readFileSync(join(h.root, "d.yaml"), "utf8")).toBe(before);
    expect((await call(h, "edit_flow", { path: "d.yaml", operation: "replace_step", index: 5, step: "back" })).body).toMatch(/Step 5 does not exist/);
    expect((await call(h, "edit_flow", { path: "d.yaml", operation: "delete_steps", index: 0 })).body).toMatch(/every step/);
    expect((await call(h, "edit_flow", { path: "missing.yaml", operation: "insert_steps", steps: ["back"] })).body).toMatch(/Flow not found/);
    expect((await call(h, "edit_flow", { path: "d.yaml", operation: "insert_steps" })).body).toMatch(/needs steps/);
  });

  it("leaves the file untouched when Maestro rejects the edit", async () => {
    await withEnv(async () => {
      const h = await harness();
      await call(h, "write_flow", { path: "k.yaml", appId: "x", steps: ["launchApp"] });
      const before = readFileSync(join(h.root, "k.yaml"), "utf8");
      const r = await call(h, "edit_flow", { path: "k.yaml", operation: "insert_steps", steps: ["SYNTAXBAD"] });
      expect(r.isError).toBe(true);
      expect(readFileSync(join(h.root, "k.yaml"), "utf8")).toBe(before);
    });
  });
});

describe("seeing the screen", () => {
  it("returns the screenshot as an image", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "take_screenshot");
      expect(r.isError).toBe(false);
      expect(r.images).toBe(1);
      expect(r.body).toContain("emulator-5554");
    });
  });

  it("refuses a reply that is not an image, with a useful reason", async () => {
    await withEnv(async () => {
      const h = await harness({ screencap: () => ({ stdout: Buffer.from("error: device offline"), stderr: "", code: 1 }) });
      const r = await call(h, "take_screenshot");
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/did not return an image/);
    });
  });

  it("reads the elements on screen", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "get_view_hierarchy", { maxElements: 5 });
      expect(r.json).toMatchObject({ device: "emulator-5554", totalElements: 167, returned: 5, screen: { width: 402, height: 874 } });
      expect(r.json.elements[0].labels).toContain("Réglages");
    });
  });

  it("finds selectors for a partial text, with ready-to-use steps", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "find_selectors", { query: "général", limit: 3 });
      expect(r.json.count).toBeGreaterThan(0);
      const best = r.json.candidates[0];
      expect(best.element.text).toBe("Général");
      // This element has an accessibility id, which is the most stable selector: it ranks first.
      expect(best.best).toMatchObject({ kind: "id", unique: true });
      // The label here is the accessibility label (the element has no text of its own).
      expect(best.selectors.map((s: { kind: string }) => s.kind)).toEqual(["id", "accessibilityText", "point"]);
      expect(best.selectors[1].steps.tapOn).toBe("Général");
      const id = await call(h, "find_selectors", { query: "apple.id" });
      expect(id.json.candidates[0].best).toMatchObject({ kind: "id", unique: true });
      expect(id.json.candidates[0].best.steps.tapOn).toEqual({ id: "apple.id" });
      const none = await call(h, "find_selectors", { query: "zzzz-nothing" });
      expect(none.json.count).toBe(0);
      expect(none.json.note).toMatch(/Nothing on screen/);
    });
  });

  it("includes a screenshot with the selectors when asked", async () => {
    await withEnv(async () => {
      const h = await harness();
      expect((await call(h, "find_selectors", { query: "Général", includeScreenshot: true })).images).toBe(1);
    });
  });

  it("reports a hierarchy it cannot read instead of failing silently", async () => {
    await withEnv(async () => {
      const h = await harness({ hierarchy: () => ({ stdout: Buffer.from("Device not found"), stderr: "driver error", code: 1 }) });
      const r = await call(h, "get_view_hierarchy");
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/no hierarchy/i);
    });
  });
});

describe("trying steps without saving a file", () => {
  it("runs steps, reports each one, and leaves no file behind", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "run_steps", { appId: "com.example", steps: ["launchApp", { tapOn: "Login" }] });
      expect(r.json.status).toBe("passed");
      expect(r.json.steps.map((s: { status: string }) => s.status)).toEqual(["completed", "completed"]);
      expect(r.images).toBe(1);
      const tmp = join(h.home, "tmp");
      expect(existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith("adhoc-")) : []).toEqual([]);
    });
  });

  it("names the step that failed, why, and what is on screen", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "run_steps", { appId: "com.example", steps: ["launchApp", { assertVisible: "FAILME General" }, { tapOn: "never reached" }] });
      expect(r.isError).toBe(false);
      expect(r.json.status).toBe("failed");
      expect(r.json.steps.map((s: { status: string }) => s.status)).toEqual(["completed", "failed", "not_run"]);
      expect(r.json.failure.step.index).toBe(1);
      expect(r.json.failure.error.message).toContain("Assertion is false");
      expect(r.json.failure.screen.visibleTexts).toContain("Réglages");
      expect(r.images).toBe(1); // the screen at the failure
    });
  });

  it("accepts the steps as YAML, and a full flow with its appId", async () => {
    await withEnv(async () => {
      const h = await harness();
      expect((await call(h, "run_steps", { appId: "x", yaml: "- launchApp\n- tapOn: Hi" })).json.status).toBe("passed");
      const full = await call(h, "run_steps", { appId: "ignored", yaml: "appId: com.real\n---\n- launchApp" });
      expect(full.json.status).toBe("passed");
      expect((await call(h, "run_steps", { appId: "x" })).body).toMatch(/Give steps or yaml/);
      expect((await call(h, "run_steps", { appId: "x", yaml: "tapOn: Hi" })).body).toMatch(/YAML list/);
    });
  });

  it("does not let two operations drive the same device at once", async () => {
    await withEnv(async () => {
      const h = await harness();
      const release = h.locks.acquire("emulator-5554", "run_steps");
      const r = await call(h, "get_view_hierarchy");
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/busy: run_steps/);
      release();
      expect((await call(h, "get_view_hierarchy")).isError).toBe(false);
    });
  });

  it("keeps a device that a run is using out of the way", async () => {
    await withEnv(async () => {
      const h = await harness();
      const started = await call(h, "run_flows", { flows: [join(h.root, "x.yaml")] });
      expect(started.isError).toBe(true); // the flow does not exist yet: nothing started
      writeFileSync(join(h.root, "x.yaml"), "appId: x\n---\n- launchApp\n");
      process.env.FAKE_DELAY_MS = "800";
      try {
        const run = (await call(h, "run_flows", { flows: [join(h.root, "x.yaml")] })).json as { runId: string };
        await new Promise((r) => setTimeout(r, 300));
        const busy = await call(h, "get_view_hierarchy");
        expect(busy.isError).toBe(true);
        expect(busy.body).toMatch(new RegExp(`busy with run ${run.runId}`));
        await call(h, "wait_for_run", { runId: run.runId, waitSeconds: 20 });
      } finally {
        delete process.env.FAKE_DELAY_MS;
      }
      expect((await call(h, "get_view_hierarchy")).isError).toBe(false);
    });
  });
});

describe("understanding a failure", () => {
  async function failingRun(h: Harness) {
    const flow = join(h.root, "checkout.yaml");
    writeFileSync(flow, "# checkout\nappId: com.shop\n---\n- launchApp\n- tapOn: Cart\n- assertVisible: FAILME Total\n");
    const run = (await call(h, "run_flows", { flows: [flow], waitSeconds: 30, retries: 0 })).json;
    return { flow, run };
  }

  it("explains the step, its line, the error, the screen and gives the screenshot", async () => {
    await withEnv(async () => {
      const h = await harness();
      const { run } = await failingRun(h);
      expect(run.summary.failed).toBe(1);
      const r = await call(h, "explain_failure", { runId: run.id });
      const e = r.json[0].explanation;
      expect(r.json[0]).toMatchObject({ status: "failed", device: "emulator-5554" });
      expect(e.step).toEqual({ index: 2, line: 6, yaml: "- assertVisible: FAILME Total" });
      expect(e.failedCommand.selector).toEqual({ kind: "text", value: "FAILME Total" });
      expect(e.error.message).toContain("Assertion is false");
      expect(e.screen.visibleTexts).toContain("Réglages");
      expect(e.hints.length).toBeGreaterThan(0);
      expect(e.commands.map((c: { status: string }) => c.status)).toEqual(["completed", "completed", "completed", "completed", "failed"]);
      expect(r.images).toBe(1);
    });
  });

  it("can skip the screenshot, and reports when nothing failed", async () => {
    await withEnv(async () => {
      const h = await harness();
      const { run } = await failingRun(h);
      expect((await call(h, "explain_failure", { runId: run.id, includeScreenshot: false })).images).toBe(0);
      const ok = join(h.root, "ok.yaml");
      writeFileSync(ok, "appId: x\n---\n- launchApp\n");
      const passing = (await call(h, "run_flows", { flows: [ok], waitSeconds: 30 })).json;
      expect((await call(h, "explain_failure", { runId: passing.id })).body).toMatch(/No job of this run failed/);
      expect((await call(h, "explain_failure", { runId: "nope" })).isError).toBe(true);
    });
  });

  it("reads artifacts inside the run folder only", async () => {
    await withEnv(async () => {
      const h = await harness();
      const { run } = await failingRun(h);
      const explained = (await call(h, "explain_failure", { runId: run.id })).json[0].explanation;
      const shot = await call(h, "read_artifact", { runId: run.id, file: explained.screenshot });
      expect(shot.images).toBe(1);
      const cmds = await call(h, "read_artifact", { runId: run.id, file: join(explained.artifactsDir, "commands.json") });
      expect(cmds.body).toContain("assertConditionCommand");
      expect((await call(h, "read_artifact", { runId: run.id, file: "../../etc/hosts" })).body).toMatch(/outside the run folder/);
      expect((await call(h, "read_artifact", { runId: run.id, file: "/etc/hosts" })).body).toMatch(/outside the run folder/);
      expect((await call(h, "read_artifact", { runId: run.id, file: "nope.json" })).body).toMatch(/not found/);
    });
  });

  it("reruns only what failed and compares the two runs", async () => {
    await withEnv(async () => {
      const h = await harness();
      const good = join(h.root, "good.yaml");
      writeFileSync(good, "appId: x\n---\n- launchApp\n");
      const bad = join(h.root, "bad.yaml");
      writeFileSync(bad, "appId: x\n---\n- launchApp\n- assertVisible: FAILME Z\n");
      const first = (await call(h, "run_flows", { flows: [good, bad], mode: "sequential", waitSeconds: 30, retries: 0 })).json;
      expect(first.summary).toMatchObject({ passed: 1, failed: 1 });
      // Fix the flow, then rerun what failed.
      writeFileSync(bad, "appId: x\n---\n- launchApp\n- assertVisible: Fine\n");
      const rerun = (await call(h, "rerun_failed", { runId: first.id, waitSeconds: 30 })).json;
      expect(rerun.summary).toMatchObject({ total: 1, passed: 1 });
      const diff = (await call(h, "compare_runs", { baseRunId: first.id, runId: rerun.id })).json;
      expect(diff).toMatchObject({ regressions: 0, fixed: 1 });
      expect(diff.rows[0]).toMatchObject({ flow: "bad.yaml", kind: "fixed", before: "failed", after: "passed" });
      expect((await call(h, "rerun_failed", { runId: rerun.id })).body).toMatch(/no job of this run failed/);
    });
  });

  it("runs only flows with a tag, passes variables, and refuses unknown devices", async () => {
    await withEnv(async () => {
      const h = await harness();
      writeFileSync(join(h.root, "smoke.yaml"), "appId: x\ntags: [smoke]\n---\n- launchApp\n");
      writeFileSync(join(h.root, "slow.yaml"), "appId: x\ntags: [slow]\n---\n- launchApp\n");
      const files = [join(h.root, "smoke.yaml"), join(h.root, "slow.yaml")];
      const smoke = (await call(h, "run_flows", { flows: files, includeTags: ["smoke"], waitSeconds: 30 })).json;
      expect(smoke.summary.total).toBe(1);
      const noSlow = (await call(h, "run_flows", { flows: files, excludeTags: ["slow"], waitSeconds: 30 })).json;
      expect(noSlow.summary.total).toBe(1);
      expect((await call(h, "run_flows", { flows: files, includeTags: ["nope"] })).body).toMatch(/No flow matches the tag filters/);
      expect((await call(h, "run_flows", { flows: files, deviceIds: ["emulator-9999"] })).body).toMatch(/Not usable now: emulator-9999/);
      expect((await call(h, "run_flows", { flows: files, env: { "BAD-NAME": "x" } })).isError).toBe(true);
      expect((await call(h, "run_flows", { flows: files, env: { USER_NAME: "ann" }, waitSeconds: 30 })).isError).toBe(false);
      const listed = (await call(h, "list_flows", { directory: h.root, tag: "smoke" })).json;
      expect(listed.map((f: { path: string }) => f.path)).toEqual([files[0]]);
    });
  });
});

describe("devices and apps", () => {
  it("lists emulators that exist and marks the running ones", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = (await call(h, "list_available_devices")).json;
      expect(r.androidEmulators).toEqual([{ name: "Pixel_10", running: true }, { name: "Pixel_10_Pro", running: false }]);
    });
  });

  it("returns an emulator that is already running instead of starting a second one", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "boot_device", { kind: "android_emulator", name: "Pixel_10" });
      expect(r.json).toMatchObject({ deviceId: "emulator-5554", alreadyRunning: true, usable: true });
      expect(h.calls.some((c) => c.args.includes("-avd"))).toBe(false);
    });
  });

  it("explains an emulator name that does not exist", async () => {
    await withEnv(async () => {
      const h = await harness();
      const r = await call(h, "boot_device", { kind: "android_emulator", name: "Nexus_Nope" });
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/No emulator named "Nexus_Nope". Available: Pixel_10, Pixel_10_Pro/);
    });
  });

  it("installs an apk and returns its package name, granting permissions by default", async () => {
    await withEnv(async () => {
      const h = await harness();
      const apk = join(dir, "app.apk");
      writeFileSync(apk, "apk");
      const r = await call(h, "install_app", { path: apk });
      expect(r.json).toMatchObject({ installed: true, device: "emulator-5554" });
      const install = h.calls.find((c) => c.args.includes("install"))!;
      expect(install.args).toEqual(["-s", "emulator-5554", "install", "-r", "-g", apk]);
      expect((await call(h, "install_app", { path: join(dir, "nope.apk") })).body).toMatch(/File not found/);
      const aab = join(dir, "app.aab");
      writeFileSync(aab, "x");
      expect((await call(h, "install_app", { path: aab })).body).toMatch(/\.apk/);
    });
  });

  it("reports an install that adb refused", async () => {
    await withEnv(async () => {
      const h = await harness({ install: () => ({ stdout: Buffer.from(""), stderr: "Failure [INSTALL_FAILED_OLDER_SDK]", code: 1 }) });
      const apk = join(dir, "old.apk");
      writeFileSync(apk, "apk");
      const r = await call(h, "install_app", { path: apk });
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/INSTALL_FAILED_OLDER_SDK/);
    });
  });

  it("lists the user's apps", async () => {
    await withEnv(async () => {
      const h = await harness();
      expect((await call(h, "list_apps")).json).toEqual([{ appId: "com.example.one" }, { appId: "com.example.two" }]);
    });
  });

  it("shuts an emulator down, and refuses while a run uses it", async () => {
    await withEnv(async () => {
      const h = await harness();
      const release = h.locks.acquire("emulator-5554", "run_steps");
      expect((await call(h, "shutdown_device", { deviceId: "emulator-5554" })).body).toMatch(/busy/);
      release();
      expect((await call(h, "shutdown_device", { deviceId: "emulator-5554" })).json).toMatchObject({ shutDown: "emulator-5554" });
      expect(h.calls.some((c) => c.args.join(" ") === "-s emulator-5554 emu kill")).toBe(true);
      expect((await call(h, "shutdown_device", { deviceId: "emulator-1" })).body).toMatch(/Unknown device/);
    });
  });

  it("asks which device when several are usable and none is named", async () => {
    await withEnv(async () => {
      const h = await harness();
      writeFileSync(adb, readFileSync(adb, "utf8") + `printf "emulator-5556\\tdevice product:x model:sdk_gphone16k_arm64 device:x transport_id:2\\n"\n`);
      const r = await call(h, "take_screenshot");
      expect(r.isError).toBe(true);
      expect(r.body).toMatch(/Several devices are usable, pass deviceId: emulator-5554 .*emulator-5556/);
    });
  });
});

describe("prompts", () => {
  it("offers guided workflows that name the right tools", async () => {
    const h = await harness();
    const list = await h.client.listPrompts();
    expect(list.prompts.map((p) => p.name).sort()).toEqual(["author_flow", "debug_failure", "run_suite_everywhere"]);
    const author = await h.client.getPrompt({ name: "author_flow", arguments: { goal: "sign in", path: "flows/login.yaml" } });
    const body = (author.messages[0].content as { text: string }).text;
    for (const tool of ["find_selectors", "run_steps", "take_screenshot", "write_flow", "boot_device"]) expect(body).toContain(tool);
    expect(body).toContain("flows/login.yaml");
    const debug = await h.client.getPrompt({ name: "debug_failure", arguments: { runId: "abc" } });
    expect((debug.messages[0].content as { text: string }).text).toContain("explain_failure");
  });
});
