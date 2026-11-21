import { describe, expect, it } from "vitest";
import { FlowError, buildFlow, describeFlow, editFlow, normalizeStep, parseStepsInput, stepLine, stepsOf } from "../src/flowfile.js";

const FLOW = `# Checks sign-in
appId: com.example.app
name: Sign in
tags: [smoke]
---
- launchApp
# enter the email
- tapOn: "Email"
- inputText: "user@example.com"
- assertVisible: "Welcome"
`;

describe("describeFlow", () => {
  it("reads header and step count", () => {
    expect(describeFlow(FLOW)).toEqual({ appId: "com.example.app", url: undefined, name: "Sign in", tags: ["smoke"], env: {}, stepCount: 4 });
  });
  it("explains what is wrong with a flow that is not a flow", () => {
    expect(() => describeFlow("appId: x")).toThrow(/header.*---.*steps/s);
    expect(() => describeFlow("appId: x\n---\nnot: a list")).toThrow(/list of steps/);
    expect(() => describeFlow("a: 1\n---\n- x\n---\n- y")).toThrow(/more than one/);
    expect(() => describeFlow("appId: [oops\n---\n- x")).toThrow(FlowError);
    expect(() => describeFlow("")).toThrow(/empty/);
  });
  it("accepts a header with no step yet", () => {
    expect(describeFlow("appId: x\n---\n").stepCount).toBe(0);
  });
});

describe("normalizeStep", () => {
  it("turns agent-style steps into Maestro steps", () => {
    expect(normalizeStep("launchApp")).toBe("launchApp");
    expect(normalizeStep("tapOn: Login")).toEqual({ tapOn: "Login" });
    expect(normalizeStep("- tapOn: Login")).toEqual({ tapOn: "Login" });
    expect(normalizeStep({ tapOn: { id: "email" } })).toEqual({ tapOn: { id: "email" } });
  });
  it("rejects empty steps and lists", () => {
    expect(() => normalizeStep("  ")).toThrow(/empty/);
    expect(() => normalizeStep(null)).toThrow(/empty/);
    expect(() => normalizeStep("- a\n- b")).toThrow(/one step at a time/);
  });
});

describe("buildFlow", () => {
  it("writes header, separator and steps without folding long text", () => {
    const long = "a ".repeat(80).trim();
    const yaml = buildFlow({ appId: "com.x", name: "N", tags: ["t"], steps: ["launchApp", { tapOn: "Login" }, { inputText: long }] });
    expect(yaml).toContain("appId: com.x\nname: N\ntags:\n  - t\n---\n- launchApp\n- tapOn: Login\n");
    expect(yaml).toContain(long);
    expect(describeFlow(yaml).stepCount).toBe(3);
  });
  it("requires an appId and at least one step", () => {
    expect(() => buildFlow({ steps: ["launchApp"] })).toThrow(/appId/);
    expect(() => buildFlow({ appId: "x", steps: [] })).toThrow(/at least one step/);
    expect(buildFlow({ url: "https://example.com", steps: ["launchApp"] })).toContain("url: https://example.com");
  });
});

describe("editFlow", () => {
  it("inserts steps and keeps the comments", () => {
    const r = editFlow(FLOW, { op: "insert_steps", at: 2, steps: [{ waitForAnimationToEnd: {} }] });
    expect(r.content).toContain("# Checks sign-in");
    expect(r.content).toContain("# enter the email");
    expect(stepsOf(r.content)).toHaveLength(5);
    expect(stepsOf(r.content)[2]).toEqual({ waitForAnimationToEnd: {} });
  });
  it("appends with -1 or at the end", () => {
    expect(stepsOf(editFlow(FLOW, { op: "insert_steps", at: -1, steps: ["back"] }).content).pop()).toBe("back");
    expect(stepsOf(editFlow(FLOW, { op: "insert_steps", at: 4, steps: ["back"] }).content).pop()).toBe("back");
    expect(() => editFlow(FLOW, { op: "insert_steps", at: 9, steps: ["back"] })).toThrow(/Cannot insert at 9/);
  });
  it("replaces a step", () => {
    const r = editFlow(FLOW, { op: "replace_step", index: 3, step: { assertVisible: "Hello" } });
    expect(stepsOf(r.content)[3]).toEqual({ assertVisible: "Hello" });
    expect(() => editFlow(FLOW, { op: "replace_step", index: 4, step: "x" })).toThrow(/Step 4 does not exist/);
  });
  it("deletes steps, but never all of them", () => {
    expect(stepsOf(editFlow(FLOW, { op: "delete_steps", index: 1, count: 2 }).content)).toEqual(["launchApp", { assertVisible: "Welcome" }]);
    expect(() => editFlow(FLOW, { op: "delete_steps", index: 0, count: 4 })).toThrow(/every step/);
    expect(() => editFlow(FLOW, { op: "delete_steps", index: 3, count: 2 })).toThrow(/only 1 remain/);
  });
  it("changes the header", () => {
    const r = editFlow(FLOW, { op: "set_header", appId: "com.other", tags: ["a", "b"] });
    const info = describeFlow(r.content);
    expect(info.appId).toBe("com.other");
    expect(info.tags).toEqual(["a", "b"]);
    expect(info.name).toBe("Sign in");
    expect(() => editFlow(FLOW, { op: "set_header" })).toThrow(/Nothing to change/);
  });
});

describe("stepLine and parseStepsInput", () => {
  it("finds the line of a step in the file", () => {
    expect(stepLine(FLOW, 0)).toBe(6);
    expect(stepLine(FLOW, 1)).toBe(8);
    expect(stepLine(FLOW, 3)).toBe(10);
    expect(stepLine(FLOW, 9)).toBeNull();
  });
  it("accepts a list of steps or a full flow", () => {
    expect(parseStepsInput("- launchApp\n- tapOn: Login")).toEqual({ steps: ["launchApp", { tapOn: "Login" }] });
    expect(parseStepsInput("appId: com.x\n---\n- launchApp")).toEqual({ appId: "com.x", steps: ["launchApp"] });
    expect(() => parseStepsInput("tapOn: Login")).toThrow(/YAML list/);
  });
});
