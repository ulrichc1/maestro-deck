#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { checkFeasibility } from "./feasibility.js";
import { discoverDevices, executeFlow, resolveAdbBin, resolveMaestroBin } from "./maestro.js";
import { buildPlan } from "./planner.js";
import { shardFlows } from "./shard.js";
import { runJobs } from "./scheduler.js";
import { summarize, toMarkdown } from "./summary.js";
import { MODES } from "./server.js";
import type { Mode } from "./types.js";

/** Exit codes: 0 all passed, 1 at least one flow failed, 2 the run could not start. */
export const EXIT = { OK: 0, TESTS_FAILED: 1, INFRA: 2 } as const;

export interface CliArgs {
  flows: string[];
  mode: Mode;
  shardIndex: number;
  shardCount: number;
  output: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const flows: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--flows") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--flows needs a path");
      flows.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  if (flows.length === 0) throw new Error("--flows is required (a YAML file, a directory, or a comma-separated list)");
  const mode = (get("mode") ?? "sequential") as Mode;
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`Unknown --mode ${mode}. Expected one of: ${MODES.join(", ")}`);
  const shardIndex = Number(get("shard-index") ?? 0);
  const shardCount = Number(get("shard-count") ?? 1);
  return {
    flows,
    mode,
    shardIndex,
    shardCount,
    output: resolve(get("output") ?? "maestro-deck-results"),
  };
}

/** Expands directories to their YAML files (sorted, not recursive). */
export function collectFlows(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    const abs = resolve(input);
    if (!existsSync(abs)) throw new Error(`Flow path not found: ${abs}`);
    if (statSync(abs).isDirectory()) {
      files.push(
        ...readdirSync(abs)
          .filter((f) => [".yaml", ".yml"].includes(extname(f)))
          .sort()
          .map((f) => join(abs, f)),
      );
    } else {
      if (![".yaml", ".yml"].includes(extname(abs))) throw new Error(`Not a YAML flow: ${abs}`);
      files.push(abs);
    }
  }
  return [...new Set(files)];
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`maestro-deck-run: ${(err as Error).message}`);
    return EXIT.INFRA;
  }

  let flows: string[];
  try {
    flows = shardFlows(collectFlows(args.flows), args.shardIndex, args.shardCount);
  } catch (err) {
    console.error(`maestro-deck-run: ${(err as Error).message}`);
    return EXIT.INFRA;
  }
  if (flows.length === 0) {
    console.log("maestro-deck-run: this shard has no flow to run.");
    return EXIT.OK;
  }

  const devices = await discoverDevices(resolveAdbBin(env));
  const usable = devices.filter((d) => d.usable);
  const feasibility = checkFeasibility(args.mode, usable);
  if (feasibility.feasible === "no") {
    console.error(`maestro-deck-run: mode ${args.mode} cannot run here: ${feasibility.reason}`);
    console.error(`Usable devices: ${usable.map((d) => `${d.platform}:${d.id} (${d.name})`).join(", ") || "none"}`);
    return EXIT.INFRA;
  }
  if (feasibility.feasible === "with_reserve") console.log(`note: ${feasibility.reason}`);

  const plan = buildPlan({ mode: args.mode, flows, devices: usable });
  const artifactsDir = join(args.output, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const execute = executeFlow({ bin: resolveMaestroBin(env), artifactsDir });

  const results = await runJobs({
    jobs: plan.jobs,
    devices: [...plan.pools.android, ...plan.pools.ios],
    parallel: plan.parallel,
    execute,
    signal: new AbortController().signal,
    onUpdate: (r) => console.log(`[${r.status}] ${r.flow.split(/[\\/]/).pop()} on ${r.deviceId || "-"}`),
  });

  const summary = summarize(args.mode, { index: args.shardIndex, count: args.shardCount }, results);
  mkdirSync(args.output, { recursive: true });
  writeFileSync(join(args.output, "summary.json"), JSON.stringify(summary, null, 2));
  const markdown = toMarkdown(summary);
  writeFileSync(join(args.output, "summary.md"), markdown);
  console.log(markdown);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);

  return summary.success ? EXIT.OK : EXIT.TESTS_FAILED;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isEntry) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
