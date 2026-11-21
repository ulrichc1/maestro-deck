/** One element of the screen, flattened from Maestro's hierarchy tree. */
export interface UiNode {
  order: number;
  depth: number;
  text: string;
  accessibilityText: string;
  title: string;
  value: string;
  hintText: string;
  resourceId: string;
  className: string;
  bounds: { x1: number; y1: number; x2: number; y2: number } | null;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  /** Only Android reports it. */
  clickable: boolean | null;
}

interface RawNode {
  attributes?: Record<string, string>;
  children?: RawNode[];
}

const BOUNDS = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

function parseBounds(value: string | undefined): UiNode["bounds"] {
  const m = value ? BOUNDS.exec(value) : null;
  return m ? { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) } : null;
}

/** Reads the JSON tree printed by `maestro hierarchy`, ignoring any log lines around it. */
export function parseHierarchy(raw: string): UiNode[] {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("No hierarchy found in the output.");
  let tree: RawNode;
  try {
    tree = JSON.parse(raw.slice(start));
  } catch {
    const end = raw.lastIndexOf("}");
    try {
      tree = JSON.parse(raw.slice(start, end + 1));
    } catch {
      throw new Error("The hierarchy is not valid JSON.");
    }
  }
  const nodes: UiNode[] = [];
  const walk = (n: RawNode, depth: number) => {
    const a = n.attributes ?? {};
    nodes.push({
      order: nodes.length,
      depth,
      text: a.text ?? "",
      accessibilityText: (a.accessibilityText ?? "").trim(),
      title: a.title ?? "",
      value: a.value ?? "",
      hintText: a.hintText ?? "",
      resourceId: a["resource-id"] ?? "",
      className: a.class ?? a.className ?? "",
      bounds: parseBounds(a.bounds),
      enabled: a.enabled === "true",
      focused: a.focused === "true",
      selected: a.selected === "true",
      checked: a.checked === "true",
      clickable: a.clickable === undefined ? null : a.clickable === "true",
    });
    for (const child of n.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);
  return nodes;
}

/** Non-empty, distinct labels of an element, in the order Maestro matches them. */
export function labelsOf(n: UiNode): string[] {
  const out: string[] = [];
  for (const v of [n.text, n.accessibilityText, n.title, n.value, n.hintText]) {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const area = (n: UiNode) => (n.bounds ? Math.max(0, n.bounds.x2 - n.bounds.x1) * Math.max(0, n.bounds.y2 - n.bounds.y1) : 0);

/** Elements that are on screen and carry a label or an id. */
export function visibleNodes(nodes: UiNode[]): UiNode[] {
  return nodes.filter((n) => area(n) > 0 && (labelsOf(n).length > 0 || n.resourceId !== ""));
}

/**
 * Size of the screen: the largest element anchored at the top-left corner, normally the root
 * window. An element scrolled partly off screen can be larger but never starts at 0,0.
 */
export function screenSize(nodes: UiNode[]): { width: number; height: number } | null {
  let best: UiNode | null = null;
  for (const n of nodes) {
    if (n.bounds && n.bounds.x1 === 0 && n.bounds.y1 === 0 && (!best || area(n) > area(best))) best = n;
  }
  return best?.bounds ? { width: best.bounds.x2, height: best.bounds.y2 } : null;
}

const INTERACTIVE_CLASS = /(Button|TextField|SecureTextField|TextView|EditText|Switch|Toggle|CheckBox|RadioButton|Cell|Link|Tab|Slider|Stepper|SearchField|Picker)/i;

/** Whether the hierarchy tells us an element can be interacted with, or null when it cannot tell. */
function isInteractive(n: UiNode, hasClickableInfo: boolean, hasClassInfo: boolean): boolean | null {
  if (hasClickableInfo) return n.clickable === true && n.enabled;
  if (hasClassInfo) return INTERACTIVE_CLASS.test(n.className) && n.enabled;
  return null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface SelectorOption {
  kind: "id" | "text" | "accessibilityText" | "hintText" | "point";
  /** The selector as Maestro takes it: { text: "Login" } or { id: "email" } or { point: "50%,40%" }. */
  selector: Record<string, unknown>;
  /** Ready-to-use steps. */
  steps: { tapOn: unknown; assertVisible?: unknown };
  /** True when exactly one element on screen matches this selector. */
  unique: boolean;
  matches: number;
}

export interface Candidate {
  element: {
    text: string;
    labels: string[];
    id: string;
    className: string;
    bounds: string;
    center: { x: number; y: number } | null;
    enabled: boolean;
    interactive: boolean | null;
  };
  /** Best first: a unique id, then a unique text, then positional fallbacks. */
  selectors: SelectorOption[];
  best: SelectorOption;
}

const contains = (outer: UiNode, inner: UiNode) =>
  !!outer.bounds && !!inner.bounds &&
  outer.bounds.x1 <= inner.bounds.x1 && outer.bounds.y1 <= inner.bounds.y1 &&
  outer.bounds.x2 >= inner.bounds.x2 && outer.bounds.y2 >= inner.bounds.y2;

/**
 * Groups elements that are the same thing to the eye: a cell and the label inside it carry the same
 * text, one rectangle inside the other. Returns one group per distinct thing on screen, in order;
 * the first element of a group is the outermost.
 */
function groupSights(list: UiNode[]): UiNode[][] {
  const groups: UiNode[][] = [];
  for (const n of list) {
    const home = groups.find((g) => contains(g[0], n));
    if (home) home.push(n);
    else groups.push([n]);
  }
  return groups;
}

const groupIndex = (groups: UiNode[][], node: UiNode) => Math.max(0, groups.findIndex((g) => g.includes(node)));

function textSelector(kind: SelectorOption["kind"], label: string, all: UiNode[], node: UiNode): SelectorOption {
  const escaped = escapeRegex(label);
  const groups = groupSights(all.filter((o) => labelsOf(o).some((l) => sameText(l, label))));
  const matching = groups;
  const unique = groups.length === 1;
  const selector: Record<string, unknown> = { text: escaped };
  if (!unique) selector.index = groupIndex(groups, node);
  const asStep = unique ? escaped : selector;
  return { kind, selector, steps: { tapOn: asStep, assertVisible: asStep }, unique, matches: matching.length };
}

function idSelector(node: UiNode, all: UiNode[]): SelectorOption {
  const groups = groupSights(all.filter((o) => o.resourceId === node.resourceId));
  const matching = groups;
  const unique = groups.length === 1;
  const selector: Record<string, unknown> = { id: node.resourceId };
  if (!unique) selector.index = groupIndex(groups, node);
  return { kind: "id", selector, steps: { tapOn: selector, assertVisible: selector }, unique, matches: matching.length };
}

function pointSelector(node: UiNode, screen: { width: number; height: number } | null): SelectorOption | null {
  if (!node.bounds || !screen || screen.width === 0 || screen.height === 0) return null;
  const cx = (node.bounds.x1 + node.bounds.x2) / 2;
  const cy = (node.bounds.y1 + node.bounds.y2) / 2;
  const point = `${Math.round((cx / screen.width) * 100)}%,${Math.round((cy / screen.height) * 100)}%`;
  const selector = { point };
  return { kind: "point", selector, steps: { tapOn: selector }, unique: true, matches: 1 };
}

function matchRank(n: UiNode, query: string): number {
  const q = query.toLowerCase();
  const fields = [...labelsOf(n), n.resourceId];
  let best = 0;
  for (const f of fields) {
    const l = f.toLowerCase();
    if (l === q) best = Math.max(best, 3);
    else if (l.startsWith(q)) best = Math.max(best, 2);
    else if (l.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

export interface SuggestOptions {
  /** Keep elements whose text, id or accessibility label contains this (case-insensitive). */
  query?: string;
  /** Only elements the hierarchy says can be interacted with. Ignored when it cannot tell. */
  interactiveOnly?: boolean;
  limit?: number;
}

/**
 * Proposes selectors for the elements on screen, the way the desktop inspector ranks them:
 * a unique id first, then a unique text, then an index among identical ones, then a position.
 */
export function suggestSelectors(nodes: UiNode[], opts: SuggestOptions = {}): Candidate[] {
  const visible = visibleNodes(nodes);
  const screen = screenSize(nodes);
  const hasClickable = nodes.some((n) => n.clickable !== null);
  const hasClass = nodes.some((n) => n.className !== "");
  const limit = opts.limit ?? 20;

  let pool = visible;
  if (opts.interactiveOnly) {
    pool = pool.filter((n) => isInteractive(n, hasClickable, hasClass) !== false);
  }
  const q = opts.query?.trim();
  const ranked = (q ? pool.filter((n) => matchRank(n, q) > 0) : pool)
    .map((n) => ({ n, rank: q ? matchRank(n, q) : 0 }))
    .sort((a, b) => b.rank - a.rank || (a.n.bounds?.y1 ?? 0) - (b.n.bounds?.y1 ?? 0) || (a.n.bounds?.x1 ?? 0) - (b.n.bounds?.x1 ?? 0));

  const out: Candidate[] = [];
  for (const { n } of ranked) {
    const options: SelectorOption[] = [];
    if (n.resourceId) options.push(idSelector(n, visible));
    const labels = labelsOf(n);
    if (n.text.trim()) options.push(textSelector("text", n.text.trim(), visible, n));
    else if (labels[0]) options.push(textSelector(n.accessibilityText ? "accessibilityText" : "hintText", labels[0], visible, n));
    const point = pointSelector(n, screen);
    if (point) options.push(point);
    if (options.length === 0) continue;
    // Unique selectors first, in the order built (id before text), the point last.
    options.sort((a, b) => Number(b.unique && b.kind !== "point") - Number(a.unique && a.kind !== "point"));
    const cx = n.bounds ? Math.round((n.bounds.x1 + n.bounds.x2) / 2) : null;
    const cy = n.bounds ? Math.round((n.bounds.y1 + n.bounds.y2) / 2) : null;
    out.push({
      element: {
        text: labels[0] ?? "",
        labels,
        id: n.resourceId,
        className: n.className,
        bounds: n.bounds ? `[${n.bounds.x1},${n.bounds.y1}][${n.bounds.x2},${n.bounds.y2}]` : "",
        center: cx !== null && cy !== null ? { x: cx, y: cy } : null,
        enabled: n.enabled,
        interactive: isInteractive(n, hasClickable, hasClass),
      },
      selectors: options,
      best: options[0],
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Distinct labels on screen in reading order (top to bottom, left to right). */
export function visibleTexts(nodes: UiNode[], limit = 60): string[] {
  const seen = new Set<string>();
  const ordered = [...visibleNodes(nodes)].sort(
    (a, b) => (a.bounds?.y1 ?? 0) - (b.bounds?.y1 ?? 0) || (a.bounds?.x1 ?? 0) - (b.bounds?.x1 ?? 0),
  );
  const out: string[] = [];
  for (const n of ordered) {
    for (const l of labelsOf(n)) {
      const k = l.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(l);
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const edit = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const tx = new Set(x.split(/\s+/));
  const ty = new Set(y.split(/\s+/));
  const shared = [...tx].filter((t) => ty.has(t)).length;
  const tokens = shared / new Set([...tx, ...ty]).size;
  const contains = x.includes(y) || y.includes(x) ? 0.7 : 0;
  return Math.max(edit, tokens, contains);
}

/** Labels on screen most like `target`, to explain an assertion on text that is not there. */
export function closestTexts(nodes: UiNode[], target: string, n = 3, min = 0.4): { text: string; score: number }[] {
  const wanted = target.replace(/\\(.)/g, "$1");
  const seen = new Set<string>();
  const scored: { text: string; score: number }[] = [];
  for (const node of visibleNodes(nodes)) {
    for (const l of labelsOf(node)) {
      if (seen.has(l)) continue;
      seen.add(l);
      scored.push({ text: l, score: Math.round(similarity(l, wanted) * 100) / 100 });
    }
  }
  return scored.filter((s) => s.score >= min && s.score < 1).sort((a, b) => b.score - a.score).slice(0, n);
}
