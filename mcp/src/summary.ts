import type { JobResult } from "./types.js";

export interface RunSummary {
  mode: string;
  shard: { index: number; count: number };
  total: number;
  passed: number;
  failed: number;
  errors: number;
  cancelled: number;
  /** True only when every job passed. */
  success: boolean;
  jobs: JobResult[];
}

export function summarize(mode: string, shard: { index: number; count: number }, jobs: JobResult[]): RunSummary {
  const count = (s: JobResult["status"]) => jobs.filter((j) => j.status === s).length;
  const passed = count("passed");
  const failed = count("failed");
  const errors = count("error");
  const cancelled = count("cancelled");
  return {
    mode,
    shard,
    total: jobs.length,
    passed,
    failed,
    errors,
    cancelled,
    success: jobs.length > 0 && passed === jobs.length,
    jobs,
  };
}

/** Markdown for the GitHub job summary and for the console. */
export function toMarkdown(s: RunSummary): string {
  const verdict = s.success ? "✅ All jobs passed" : "❌ Some jobs did not pass";
  const rows = s.jobs.map((j) => {
    const flow = j.flow.split(/[\\/]/).pop();
    const dur = j.durationMs === null ? "-" : `${(j.durationMs / 1000).toFixed(1)}s`;
    const why = j.errorTail ? j.errorTail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200) : "";
    return `| ${flow} | ${j.platform} | \`${j.deviceId || "-"}\` | ${j.status} | ${dur} | ${why} |`;
  });
  return [
    `### Maestro Deck: ${verdict}`,
    "",
    `Mode \`${s.mode}\`, shard ${s.shard.index + 1}/${s.shard.count}: ${s.passed} passed, ${s.failed} failed, ${s.errors} errors, ${s.cancelled} cancelled.`,
    "",
    "| Flow | Platform | Device | Status | Duration | Message |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
