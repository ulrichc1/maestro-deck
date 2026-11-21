import { isScalar, isSeq, parse, parseAllDocuments, stringify, type Document, type YAMLSeq } from "yaml";

/** A problem with the flow's content that the author can fix. */
export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

const STRINGIFY = { lineWidth: 0 } as const;

export interface FlowInfo {
  appId?: string;
  url?: string;
  name?: string;
  tags: string[];
  env: Record<string, string>;
  stepCount: number;
}

interface SplitFlow {
  configDoc: Document | null;
  stepsDoc: Document;
}

/** Splits a flow into its header (appId, name, tags...) and its list of steps. */
export function splitFlow(content: string): SplitFlow {
  const docs = parseAllDocuments(content);
  if (docs.length === 0) throw new FlowError("The flow is empty.");
  for (const d of docs) {
    if (d.errors.length > 0) throw new FlowError(d.errors[0].message);
  }
  if (docs.length > 2) throw new FlowError("A flow has a header, one line '---', and the steps. Found more than one '---'.");
  if (docs.length === 1) {
    const only = docs[0];
    if (isSeq(only.contents)) return { configDoc: null, stepsDoc: only };
    throw new FlowError("A flow needs a header (appId: ...), a line '---', then the steps.");
  }
  const [configDoc, stepsDoc] = docs;
  const empty = stepsDoc.contents === null || (isScalar(stepsDoc.contents) && stepsDoc.contents.value === null);
  if (empty) stepsDoc.contents = stepsDoc.createNode([]) as unknown as typeof stepsDoc.contents;
  if (!isSeq(stepsDoc.contents)) throw new FlowError("The part after '---' must be a list of steps (lines starting with '- ').");
  return { configDoc, stepsDoc };
}

/** Header and step count of a flow. Throws FlowError when the YAML is not a flow. */
export function describeFlow(content: string): FlowInfo {
  const { configDoc, stepsDoc } = splitFlow(content);
  const config = (configDoc?.toJS() ?? {}) as Record<string, unknown>;
  const envRaw = config.env;
  const env: Record<string, string> = {};
  if (envRaw && typeof envRaw === "object") {
    for (const [k, v] of Object.entries(envRaw as Record<string, unknown>)) env[k] = String(v);
  }
  return {
    appId: typeof config.appId === "string" ? config.appId : undefined,
    url: typeof config.url === "string" ? config.url : undefined,
    name: typeof config.name === "string" ? config.name : undefined,
    tags: Array.isArray(config.tags) ? config.tags.map(String) : [],
    env,
    stepCount: (stepsDoc.contents as YAMLSeq).items.length,
  };
}

/**
 * Accepts a step as an agent is likely to write it: an object ({tapOn: "Login"}), a bare command
 * name ("launchApp"), or a one-line YAML string ("tapOn: Login", "- tapOn: Login").
 */
export function normalizeStep(step: unknown): unknown {
  if (typeof step !== "string") {
    if (step === null || step === undefined) throw new FlowError("A step cannot be empty.");
    return step;
  }
  const trimmed = step.trim();
  if (!trimmed) throw new FlowError("A step cannot be empty.");
  let parsed: unknown;
  try {
    parsed = parse(trimmed);
  } catch (err) {
    throw new FlowError(`Cannot read the step "${trimmed}": ${(err as Error).message}`);
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new FlowError(`Give one step at a time, got a list of ${parsed.length}.`);
    parsed = parsed[0];
  }
  if (parsed === null || parsed === undefined) throw new FlowError(`Cannot read the step "${trimmed}".`);
  return parsed;
}

export interface NewFlow {
  appId?: string;
  url?: string;
  name?: string;
  tags?: string[];
  env?: Record<string, string>;
  steps: unknown[];
}

/** Builds a flow file from a header and structured steps. */
export function buildFlow(flow: NewFlow): string {
  if (!flow.appId && !flow.url) throw new FlowError("appId is required (or url for a web flow).");
  const config: Record<string, unknown> = {};
  if (flow.appId) config.appId = flow.appId;
  if (flow.url) config.url = flow.url;
  if (flow.name) config.name = flow.name;
  if (flow.tags && flow.tags.length > 0) config.tags = flow.tags;
  if (flow.env && Object.keys(flow.env).length > 0) config.env = flow.env;
  const steps = flow.steps.map(normalizeStep);
  if (steps.length === 0) throw new FlowError("A flow needs at least one step.");
  return `${stringify(config, STRINGIFY)}---\n${stringify(steps, STRINGIFY)}`;
}

/** The steps of a flow, as plain values. */
export function stepsOf(content: string): unknown[] {
  return (splitFlow(content).stepsDoc.toJS() ?? []) as unknown[];
}

/** 1-based line of a step in the file, or null. */
export function stepLine(content: string, index: number): number | null {
  const { stepsDoc } = splitFlow(content);
  const item = (stepsDoc.contents as YAMLSeq).items[index] as { range?: [number, number, number] } | undefined;
  if (!item?.range) return null;
  return content.slice(0, item.range[0]).split("\n").length;
}

/** The step as written in the file (without its comments), prefixed with "- ". Null when out of range. */
export function stepSource(content: string, index: number): string | null {
  const { stepsDoc } = splitFlow(content);
  const item = (stepsDoc.contents as YAMLSeq).items[index] as { range?: [number, number, number] } | undefined;
  if (!item?.range) return null;
  const text = content.slice(item.range[0], item.range[1]).trimEnd();
  return `- ${text.split("\n").map((l, i) => (i === 0 ? l : `  ${l.trimStart()}`)).join("\n")}`;
}

export type EditOp =
  | { op: "insert_steps"; at: number; steps: unknown[] }
  | { op: "replace_step"; index: number; step: unknown }
  | { op: "delete_steps"; index: number; count?: number }
  | { op: "set_header"; appId?: string; name?: string; tags?: string[]; env?: Record<string, string> };

export interface EditResult {
  content: string;
  /** What changed, in words, for the agent to relay. */
  summary: string;
}

function render(configDoc: Document | null, stepsDoc: Document): string {
  // The steps document keeps its own "---" marker when it has one.
  const raw = stepsDoc.toString(STRINGIFY);
  const steps = raw.startsWith("---") ? raw : `---\n${raw}`;
  return configDoc ? `${configDoc.toString(STRINGIFY)}${steps}` : raw;
}

/**
 * Edits a flow while keeping its comments and layout. Steps are numbered from 0, as in
 * `describe_flow`. `at` may equal the step count (or -1) to append.
 */
export function editFlow(content: string, op: EditOp): EditResult {
  const { configDoc, stepsDoc } = splitFlow(content);
  const seq = stepsDoc.contents as YAMLSeq;
  const count = seq.items.length;

  switch (op.op) {
    case "insert_steps": {
      const at = op.at === -1 ? count : op.at;
      if (!Number.isInteger(at) || at < 0 || at > count) throw new FlowError(`Cannot insert at ${op.at}: the flow has ${count} step(s) (use 0 to ${count}, or -1 to append).`);
      if (op.steps.length === 0) throw new FlowError("No step to insert.");
      seq.items.splice(at, 0, ...op.steps.map((s) => stepsDoc.createNode(normalizeStep(s))));
      return { content: render(configDoc, stepsDoc), summary: `Inserted ${op.steps.length} step(s) at position ${at}.` };
    }
    case "replace_step": {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= count) throw new FlowError(`Step ${op.index} does not exist: the flow has ${count} step(s) (0 to ${count - 1}).`);
      seq.items[op.index] = stepsDoc.createNode(normalizeStep(op.step));
      return { content: render(configDoc, stepsDoc), summary: `Replaced step ${op.index}.` };
    }
    case "delete_steps": {
      const n = op.count ?? 1;
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= count) throw new FlowError(`Step ${op.index} does not exist: the flow has ${count} step(s) (0 to ${count - 1}).`);
      if (!Number.isInteger(n) || n < 1 || op.index + n > count) throw new FlowError(`Cannot delete ${n} step(s) from ${op.index}: only ${count - op.index} remain.`);
      if (count - n === 0) throw new FlowError("This would remove every step. A flow needs at least one.");
      seq.items.splice(op.index, n);
      return { content: render(configDoc, stepsDoc), summary: `Deleted ${n} step(s) from position ${op.index}.` };
    }
    case "set_header": {
      if (!configDoc) throw new FlowError("This flow has no header to change.");
      const changed: string[] = [];
      if (op.appId !== undefined) { configDoc.set("appId", op.appId); changed.push("appId"); }
      if (op.name !== undefined) { configDoc.set("name", op.name); changed.push("name"); }
      if (op.tags !== undefined) { configDoc.set("tags", configDoc.createNode(op.tags)); changed.push("tags"); }
      if (op.env !== undefined) { configDoc.set("env", configDoc.createNode(op.env)); changed.push("env"); }
      if (changed.length === 0) throw new FlowError("Nothing to change in the header.");
      return { content: render(configDoc, stepsDoc), summary: `Changed the header: ${changed.join(", ")}.` };
    }
  }
}

/** Parses the steps an agent passes to run_steps: a YAML list, or a full flow. Returns appId when present. */
export function parseStepsInput(input: string): { appId?: string; steps: unknown[] } {
  const docs = parseAllDocuments(input);
  for (const d of docs) if (d.errors.length > 0) throw new FlowError(d.errors[0].message);
  if (docs.length === 2) {
    const info = describeFlow(input);
    return { appId: info.appId, steps: stepsOf(input) };
  }
  const value = docs[0]?.toJS();
  if (!Array.isArray(value)) throw new FlowError("Give the steps as a YAML list (lines starting with '- ').");
  return { steps: value };
}
