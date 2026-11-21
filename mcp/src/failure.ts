import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stepLine, stepSource } from "./flowfile.js";
import { failureMessage } from "./maestro.js";
import { closestTexts, parseHierarchy, visibleTexts } from "./ui.js";

interface RawCommand {
  command: Record<string, Record<string, unknown>>;
  metadata: {
    status?: string;
    sequenceNumber?: number;
    depth?: number;
    duration?: number;
    error?: { message?: string; debugMessage?: string };
    artifacts?: { type: string; path: string }[];
  };
}

export interface CommandEntry {
  /** Maestro's sequence number. Starts with two internal commands before the first step. */
  n: number;
  command: string;
  status: string;
  depth: number;
  durationMs: number | null;
}

export interface FailureReport {
  /** Folder holding commands.json, logs and screenshots of the failed attempt. */
  artifactsDir: string;
  failedCommand: { n: number; command: string; selector: { kind: string; value: string } | null; params: Record<string, unknown> } | null;
  /** The step of the flow file that failed, numbered from 0, with its line. */
  step: { index: number; line: number | null; yaml: string } | null;
  error: { message: string | null; debugMessage: string | null; junit: string | null };
  screenshot: string | null;
  hierarchyFile: string | null;
  screen: { visibleTexts: string[]; similarToMissing: { text: string; score: number }[] } | null;
  commands: CommandEntry[];
  logTail: string[];
  hints: string[];
}

/** Commands Maestro runs by itself before the first step of every flow. */
const SYSTEM_COMMANDS = new Set(["defineVariablesCommand", "applyConfigurationCommand"]);

const commandName = (raw: RawCommand) => Object.keys(raw.command)[0] ?? "unknown";

/** Looks for commands.json up to a few levels down, newest folder first. */
function findCommandsDir(dir: string, depth = 0): string | null {
  if (!existsSync(dir) || depth > 4) return null;
  if (existsSync(join(dir, "commands.json"))) return dir;
  const subdirs = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isDirectory())
    .sort()
    .reverse();
  for (const sub of subdirs) {
    const found = findCommandsDir(sub, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The selector a command targets, read from its parameters. */
function selectorOf(value: unknown): { kind: string; value: string } | null {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["textRegex", "idRegex", "text", "id"]) {
      if (typeof obj[key] === "string" && obj[key]) return { kind: key.replace("Regex", ""), value: obj[key] as string };
    }
    for (const v of Object.values(obj)) {
      const found = selectorOf(v);
      if (found) return found;
    }
  }
  return null;
}

function describeCommand(raw: RawCommand): string {
  const name = commandName(raw).replace(/Command$/, "");
  const inner = raw.command[commandName(raw)] ?? {};
  const sel = selectorOf(inner);
  if (sel) return `${name} ${sel.kind}="${sel.value}"`;
  const compact = Object.fromEntries(Object.entries(inner).filter(([k, v]) => !(k === "optional" && v === false) && k !== "env"));
  const text = Object.keys(compact).length > 0 ? JSON.stringify(compact) : "";
  return text ? `${name} ${text.length > 100 ? `${text.slice(0, 97)}...` : text}` : name;
}

function tailErrors(logFile: string, max = 8): string[] {
  if (!existsSync(logFile)) return [];
  const lines = readFileSync(logFile, "utf8").split("\n").filter((l) => /\[(ERROR|WARN)\s*\]|Exception/.test(l));
  return lines.slice(-max).map((l) => l.trim().slice(0, 300));
}

export interface ExplainInput {
  /** The job's artifact folder (contains a timestamped folder per attempt). */
  jobDir: string;
  /** The flow file, to point at the failing step and line. */
  flowPath?: string;
  /** JUnit report of the job, for the message when Maestro wrote no command detail. */
  reportPath?: string | null;
}

/** Explains why a flow failed: which step, what was on screen, and what to try. */
export function explainFailure(input: ExplainInput): FailureReport | null {
  const dir = findCommandsDir(input.jobDir);
  const junit = input.reportPath ? failureMessage(input.reportPath) : null;
  if (!dir) {
    return junit
      ? {
          artifactsDir: input.jobDir, failedCommand: null, step: null,
          error: { message: junit, debugMessage: null, junit }, screenshot: null, hierarchyFile: null,
          screen: null, commands: [], logTail: [],
          hints: ["Maestro wrote no step detail, so it stopped before running the flow: check the device and the app with doctor and list_devices."],
        }
      : null;
  }

  const raw = JSON.parse(readFileSync(join(dir, "commands.json"), "utf8")) as RawCommand[];
  const ordered = [...raw].sort((a, b) => (a.metadata.sequenceNumber ?? 0) - (b.metadata.sequenceNumber ?? 0));
  const commands: CommandEntry[] = ordered.map((c) => ({
    n: c.metadata.sequenceNumber ?? 0,
    command: describeCommand(c),
    status: (c.metadata.status ?? "UNKNOWN").toLowerCase(),
    depth: c.metadata.depth ?? 0,
    durationMs: c.metadata.duration ?? null,
  }));

  const failed = ordered.find((c) => c.metadata.status === "FAILED") ?? null;
  const failedName = failed ? commandName(failed) : null;
  const inner = failed && failedName ? failed.command[failedName] : null;

  // The failing step may sit inside runFlow or repeat: the step of the file is its top-level ancestor.
  let step: FailureReport["step"] = null;
  if (failed) {
    const top = [...ordered].filter((c) => (c.metadata.depth ?? 0) === 0 && (c.metadata.sequenceNumber ?? 0) <= (failed.metadata.sequenceNumber ?? 0)).pop();
    const userSteps = ordered.filter((c) => (c.metadata.depth ?? 0) === 0 && !SYSTEM_COMMANDS.has(commandName(c)));
    const index = top ? userSteps.findIndex((c) => c.metadata.sequenceNumber === top.metadata.sequenceNumber) : -1;
    if (index >= 0) {
      let yaml = "";
      let line: number | null = null;
      if (input.flowPath && existsSync(input.flowPath)) {
        try {
          const content = readFileSync(input.flowPath, "utf8");
          yaml = stepSource(content, index) ?? "";
          line = stepLine(content, index);
        } catch {
          // The file changed or is not valid any more: keep the index only.
        }
      }
      step = { index, line, yaml };
    }
  }

  const artifactPath = (type: string) => {
    const rel = failed?.metadata.artifacts?.find((a) => a.type === type)?.path;
    const p = rel ? join(dir, rel) : null;
    return p && existsSync(p) ? p : null;
  };
  let screenshot = artifactPath("SCREENSHOT");
  if (!screenshot && existsSync(join(dir, "screenshots"))) {
    const shots = readdirSync(join(dir, "screenshots")).filter((f) => f.endsWith(".png")).sort();
    if (shots.length > 0) screenshot = join(dir, "screenshots", shots[shots.length - 1]);
  }
  const hierarchyFile = artifactPath("SCREEN_HIERARCHY");

  const selector = inner ? selectorOf(inner) : null;
  let screen: FailureReport["screen"] = null;
  if (hierarchyFile) {
    try {
      const nodes = parseHierarchy(readFileSync(hierarchyFile, "utf8"));
      screen = {
        visibleTexts: visibleTexts(nodes),
        similarToMissing: selector && selector.kind !== "id" ? closestTexts(nodes, selector.value) : [],
      };
    } catch {
      screen = null;
    }
  }

  const message = failed?.metadata.error?.message ?? junit;
  const hints: string[] = [];
  if (failedName === "assertConditionCommand" && selector) {
    if (screen && screen.similarToMissing.length > 0) {
      hints.push(`"${selector.value}" is not on screen, but similar text is: ${screen.similarToMissing.map((s) => `"${s.text}"`).join(", ")}. Check spelling, case and language.`);
    } else if (screen && screen.visibleTexts.length === 0) {
      hints.push("The screen has no readable element: the app may have crashed, still be loading, or not be in the foreground.");
    } else {
      hints.push(`"${selector.value}" is not on screen. Compare with visibleTexts, and consider waiting for it with extendedWaitUntil if the screen loads slowly.`);
    }
  }
  // Maestro names it tapOnElementCommand (and tapOnPointCommand for coordinates).
  if (failedName?.startsWith("tapOn") && selector) {
    hints.push(`Nothing matching ${selector.kind} "${selector.value}" could be tapped. Use find_selectors on the current screen to get a valid selector.`);
  }
  if (failedName === "launchAppCommand" || /unable to launch|app .*not (installed|found)/i.test(message ?? "")) {
    hints.push("The app did not launch: check that it is installed on the device (list_apps) and that appId in the flow header is right.");
  }
  if (screen && screen.visibleTexts.length === 0 && !hints.some((h) => h.includes("crashed"))) {
    hints.push("The screen was empty at the failure: the app may have crashed. The device log tail may say why.");
  }
  if (!failed) hints.push("No step failed in Maestro's record: the run stopped for another reason (timeout, device lost, cancelled).");

  return {
    artifactsDir: dir,
    failedCommand: failed && failedName
      ? { n: failed.metadata.sequenceNumber ?? 0, command: describeCommand(failed), selector, params: (inner ?? {}) as Record<string, unknown> }
      : null,
    step,
    error: { message: message ?? null, debugMessage: failed?.metadata.error?.debugMessage ?? null, junit },
    screenshot,
    hierarchyFile,
    screen,
    commands: commands.slice(0, 80),
    logTail: tailErrors(join(dir, "logs", "maestro.log")),
    hints,
  };
}
