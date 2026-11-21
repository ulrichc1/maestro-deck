import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closestTexts, labelsOf, parseHierarchy, screenSize, similarity, suggestSelectors, visibleNodes, visibleTexts, type UiNode } from "../src/ui.js";

const FIXTURE = join(__dirname, "fixtures/failed-assertion/2026-11-21_000000/settings-fail");
const real = parseHierarchy(readFileSync(join(FIXTURE, "screen-hierarchy/step-004-assertCondition-Nonexistent_screen_text.json"), "utf8"));

const node = (o: Partial<UiNode> & { x?: number; y?: number }): UiNode => ({
  order: 0, depth: 1, text: "", accessibilityText: "", title: "", value: "", hintText: "", resourceId: "", className: "",
  bounds: { x1: o.x ?? 10, y1: o.y ?? 10, x2: (o.x ?? 10) + 100, y2: (o.y ?? 10) + 40 },
  enabled: true, focused: false, selected: false, checked: false, clickable: null, ...o,
});
const root = node({ bounds: { x1: 0, y1: 0, x2: 400, y2: 800 }, enabled: true, depth: 0 });

describe("a real iOS hierarchy", () => {
  it("parses the whole tree and finds the screen size", () => {
    expect(real.length).toBe(167);
    expect(screenSize(real)).toEqual({ width: 402, height: 874 });
  });
  it("reads the labels the user can see, in reading order", () => {
    const texts = visibleTexts(real);
    expect(texts[0]).toBe("Réglages");
    expect(texts).toContain("Général");
    expect(texts).toContain("Accessibilité");
  });
  it("suggests a unique id when the element has one", () => {
    const c = suggestSelectors(real, { query: "apple.id" })[0];
    expect(c.best.kind).toBe("id");
    expect(c.best.selector).toEqual({ id: "apple.id" });
    expect(c.best.unique).toBe(true);
  });
  it("finds a French label by a partial, case-insensitive query", () => {
    const hits = suggestSelectors(real, { query: "général" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].element.text).toBe("Général");
  });
  it("tells which text on screen is close to one that is missing", () => {
    const close = closestTexts(real, "General");
    expect(close[0].text).toBe("Général");
    expect(closestTexts(real, "Nonexistent screen text")).toEqual([]);
  });
});

describe("suggestSelectors", () => {
  it("escapes regex characters in text, since Maestro matches text as a regex", () => {
    const nodes = [root, node({ text: "Total (EUR) 10.50?" })];
    const c = suggestSelectors(nodes)[0];
    expect(c.best.selector).toEqual({ text: "Total \\(EUR\\) 10\\.50\\?" });
  });
  it("adds an index when several elements share the text", () => {
    const nodes = [root, node({ text: "Add", y: 100 }), node({ text: "Add", y: 200 }), node({ text: "Add", y: 300 })];
    const cands = suggestSelectors(nodes);
    const second = cands.find((c) => c.element.center?.y === 220)!;
    expect(second.best.unique).toBe(false);
    expect(second.best.matches).toBe(3);
    expect(second.best.selector).toEqual({ text: "Add", index: 1 });
  });
  it("counts a cell and its inner label on the same rectangle as one element", () => {
    const nodes = [root, node({ text: "General", x: 20, y: 100 }), node({ text: "General", x: 20, y: 100 })];
    const c = suggestSelectors(nodes)[0];
    expect(c.best.unique).toBe(true);
    expect(c.best.selector).toEqual({ text: "General" });
  });
  it("counts a cell and a label nested inside it as one element, like the real Settings screen", () => {
    const cell = node({ text: "General", bounds: { x1: 16, y1: 311, x2: 386, y2: 363 } });
    const label = node({ text: "General", x: 29, y: 323, bounds: { x1: 29, y1: 323, x2: 131, y2: 352 } });
    const c = suggestSelectors([root, cell, label]).find((x) => x.element.text === "General")!;
    expect(c.best.unique).toBe(true);
    expect(c.best.matches).toBe(1);
  });
  it("still needs an index when identical text sits in different places", () => {
    const nodes = [root, node({ text: "General", x: 20, y: 100 }), node({ text: "General", x: 20, y: 100 }), node({ text: "General", x: 20, y: 300 })];
    const second = suggestSelectors(nodes).find((c) => c.element.center?.y === 320)!;
    expect(second.best.selector).toEqual({ text: "General", index: 1 });
  });
  it("matches text without regard to case when judging uniqueness", () => {
    const nodes = [root, node({ text: "Login", y: 100 }), node({ text: "LOGIN", y: 200 })];
    expect(suggestSelectors(nodes)[0].best.unique).toBe(false);
  });
  it("prefers an id over a text, and a unique one over an indexed one", () => {
    const nodes = [root, node({ text: "Save", resourceId: "save_btn", y: 100 }), node({ text: "Save", resourceId: "", y: 200 })];
    const withId = suggestSelectors(nodes, { query: "save_btn" })[0];
    expect(withId.best.kind).toBe("id");
    const a11y = suggestSelectors([root, node({ accessibilityText: "Close dialog" })])[0];
    expect(a11y.best.kind).toBe("accessibilityText");
  });
  it("gives a percentage point as the last resort", () => {
    const c = suggestSelectors([root, node({ text: "A", x: 150, y: 380 })])[0];
    const point = c.selectors.find((s) => s.kind === "point")!;
    expect(point.selector).toEqual({ point: "50%,50%" });
    expect(c.selectors[c.selectors.length - 1].kind).toBe("point");
  });
  it("keeps only interactive elements when asked and the hierarchy says which are", () => {
    const nodes = [
      root,
      node({ text: "Title", clickable: false, y: 50 }),
      node({ text: "Go", clickable: true, y: 100 }),
      node({ text: "Disabled", clickable: true, enabled: false, y: 150 }),
    ];
    expect(suggestSelectors(nodes, { interactiveOnly: true }).map((c) => c.element.text)).toEqual(["Go"]);
    expect(suggestSelectors(nodes).length).toBe(3);
  });
  it("uses the class when the platform gives no clickable flag", () => {
    const nodes = [root, node({ text: "Hello", className: "XCUIElementTypeStaticText", y: 50 }), node({ text: "Sign in", className: "XCUIElementTypeButton", y: 100 })];
    expect(suggestSelectors(nodes, { interactiveOnly: true }).map((c) => c.element.text)).toEqual(["Sign in"]);
  });
  it("skips structural elements that have no label or id", () => {
    expect(visibleNodes([root, node({}), node({ text: "x" })]).length).toBe(1);
  });
  it("orders matches: exact first, then prefix, then contains", () => {
    const nodes = [root, node({ text: "Sign in with email", y: 50 }), node({ text: "Sign in", y: 100 }), node({ text: "Please sign in", y: 150 })];
    expect(suggestSelectors(nodes, { query: "sign in" }).map((c) => c.element.text)).toEqual(["Sign in", "Sign in with email", "Please sign in"]);
  });
  it("respects the limit", () => {
    const many = [root, ...Array.from({ length: 30 }, (_, i) => node({ text: `Item ${i}`, y: 20 + i * 20 }))];
    expect(suggestSelectors(many, { limit: 5 })).toHaveLength(5);
  });
});

describe("parsing and similarity", () => {
  it("ignores log lines around the JSON", () => {
    const raw = `INFO starting\n${JSON.stringify({ attributes: { text: "Hi", bounds: "[0,0][10,10]" }, children: [] })}\nbye`;
    expect(parseHierarchy(raw)[0].text).toBe("Hi");
    expect(() => parseHierarchy("nothing")).toThrow(/No hierarchy/);
    expect(() => parseHierarchy("{ nope")).toThrow(/not valid JSON/);
  });
  it("lists distinct labels of an element", () => {
    expect(labelsOf(node({ text: "A", accessibilityText: "A", title: "B" }))).toEqual(["A", "B"]);
  });
  it("scores similar text higher than unrelated text", () => {
    expect(similarity("Login", "Log in")).toBeGreaterThan(similarity("Login", "Settings"));
    expect(similarity("a", "")).toBe(0);
    expect(similarity("Same", "same")).toBe(1);
  });
});
