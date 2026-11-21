import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explainFailure } from "../src/failure.js";
import { resolveWritableFlow, writeFlowFile } from "../src/fsguard.js";

const FIX = join(__dirname, "fixtures/failed-assertion");

describe("explainFailure on a real Maestro failure", () => {
  const report = explainFailure({ jobDir: FIX, flowPath: join(FIX, "settings-fail.yaml") })!;

  it("names the failed step, its position in the file and its line", () => {
    expect(report.failedCommand?.command).toBe('assertCondition text="Nonexistent screen text"');
    expect(report.failedCommand?.selector).toEqual({ kind: "text", value: "Nonexistent screen text" });
    expect(report.step).toEqual({ index: 1, line: 4, yaml: '- assertVisible: "Nonexistent screen text"' });
  });
  it("gives the error, the screenshot and the screen content", () => {
    expect(report.error.message).toContain("Assertion is false");
    expect(report.screenshot).toMatch(/step-004-assertCondition.*\.png$/);
    expect(report.screen?.visibleTexts).toContain("Réglages");
    expect(report.hints[0]).toContain("is not on screen");
  });
  it("lists the commands that ran with their status", () => {
    expect(report.commands.map((c) => [c.n, c.status])).toEqual([[0, "completed"], [1, "completed"], [2, "completed"], [3, "failed"]]);
  });
  it("returns null when there is no trace of a run and no report", () => {
    expect(explainFailure({ jobDir: mkdtempSync(join(tmpdir(), "nothing-")) })).toBeNull();
  });
  it("falls back to the JUnit message when Maestro wrote no step detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "junit-only-"));
    const junit = join(dir, "junit.xml");
    writeFileSync(junit, "<testsuites><testsuite><testcase><failure>Driver did not start</failure></testcase></testsuite></testsuites>");
    const r = explainFailure({ jobDir: dir, reportPath: junit })!;
    expect(r.error.message).toBe("Driver did not start");
    expect(r.hints[0]).toMatch(/stopped before running the flow/);
  });
  it("suggests similar on-screen text when the missing text has a near match", () => {
    const dir = mkdtempSync(join(tmpdir(), "similar-"));
    cpSync(FIX, dir, { recursive: true });
    const cmds = join(dir, "2026-11-21_000000/settings-fail/commands.json");
    const edited = JSON.parse(readFileSync(cmds, "utf8"));
    edited[3].command.assertConditionCommand.condition.visible.textRegex = "General";
    writeFileSync(cmds, JSON.stringify(edited));
    const r = explainFailure({ jobDir: dir })!;
    expect(r.screen?.similarToMissing[0].text).toBe("Général");
    expect(r.hints[0]).toContain("similar text");
  });
});

describe("resolveWritableFlow", () => {
  const root = mkdtempSync(join(tmpdir(), "flows-root-"));
  mkdirSync(join(root, "sub"));
  it("accepts YAML files inside the allowed folder, relative or absolute", () => {
    expect(resolveWritableFlow("a.yaml", [root])).toBe(join(root, "a.yaml"));
    expect(resolveWritableFlow(join(root, "sub/b.yml"), [root])).toBe(join(root, "sub/b.yml"));
    expect(resolveWritableFlow("new-dir/c.yaml", [root])).toBe(join(root, "new-dir/c.yaml"));
  });
  it("refuses other extensions, escapes and absolute paths elsewhere", () => {
    expect(() => resolveWritableFlow("a.txt", [root])).toThrow(/\.yaml/);
    expect(() => resolveWritableFlow("../outside.yaml", [root])).toThrow(/outside the allowed/);
    expect(() => resolveWritableFlow("/etc/evil.yaml", [root])).toThrow(/outside the allowed/);
    expect(() => resolveWritableFlow("sub/../../x.yaml", [root])).toThrow(/outside the allowed/);
  });
  it("refuses a symlink that leads out of the folder", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(root, "link"));
    expect(() => resolveWritableFlow("link/x.yaml", [root])).toThrow(/outside the allowed/);
  });

  it("refuses a symlink as the file itself, whether it points out of the folder, inside it, or nowhere", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-file-"));
    const target = join(outside, "victim.yaml");
    writeFileSync(target, "precious");
    symlinkSync(target, join(root, "leaf.yaml"));
    symlinkSync(join(outside, "not-yet.yaml"), join(root, "dangling.yaml"));
    writeFileSync(join(root, "real.yaml"), "x");
    symlinkSync(join(root, "real.yaml"), join(root, "inside.yaml"));
    for (const name of ["leaf.yaml", "dangling.yaml", "inside.yaml"]) {
      expect(() => resolveWritableFlow(name, [root])).toThrow(/symlink/);
    }
    expect(readFileSync(target, "utf8")).toBe("precious");
  });

  it("writeFlowFile will not follow a link swapped in after the check", () => {
    const outside = mkdtempSync(join(tmpdir(), "swap-"));
    const target = join(outside, "victim.yaml");
    writeFileSync(target, "precious");
    const path = join(root, "swapped.yaml");
    symlinkSync(target, path); // the "attacker" replaces the file between check and write
    expect(() => writeFlowFile(path, "overwritten")).toThrow(/symlink/);
    expect(readFileSync(target, "utf8")).toBe("precious");
    const ok = join(root, "plain.yaml");
    writeFlowFile(ok, "fine");
    expect(readFileSync(ok, "utf8")).toBe("fine");
    writeFlowFile(ok, "shorter");
    expect(readFileSync(ok, "utf8")).toBe("shorter");
  });
});
