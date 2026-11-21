import type { JobResult } from "./types.js";

export interface RunSummary {
  mode: string;
  shard: { index: number; count: number };
  total: number;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
  cancelled: number;
  /** Jobs that needed more than one attempt. */
  retried: number;
  /** Devices taken out of rotation during the run. */
  retiredDevices: { id: string; name: string; reason: string }[];
  /** True only when every job passed. */
  success: boolean;
  jobs: JobResult[];
}

export function summarize(
  mode: string,
  shard: { index: number; count: number },
  jobs: JobResult[],
  retiredDevices: RunSummary["retiredDevices"] = [],
): RunSummary {
  const count = (s: JobResult["status"]) => jobs.filter((j) => j.status === s).length;
  const passed = count("passed");
  return {
    mode,
    shard,
    total: jobs.length,
    passed,
    failed: count("failed"),
    errors: count("error"),
    timeouts: count("timeout"),
    cancelled: count("cancelled"),
    retried: jobs.filter((j) => (j.attempts ?? 1) > 1).length,
    retiredDevices,
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
    return `| ${flow} | ${j.platform} | \`${j.deviceId || "-"}\` | ${j.status} | ${j.attempts ?? 1} | ${dur} | ${why} |`;
  });
  const lines = [
    `### Maestro Deck: ${verdict}`,
    "",
    `Mode \`${s.mode}\`, shard ${s.shard.index + 1}/${s.shard.count}: ${s.passed} passed, ${s.failed} failed, ${s.errors} errors, ${s.timeouts} timeouts, ${s.cancelled} cancelled, ${s.retried} retried.`,
    "",
    "| Flow | Platform | Device | Status | Attempts | Duration | Message |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ];
  if (s.retiredDevices.length > 0) {
    lines.push(
      "Devices taken out of rotation:",
      ...s.retiredDevices.map((d) => `- \`${d.id}\` (${d.name}): ${d.reason.replace(/\n/g, " ").slice(0, 200)}`),
      "",
    );
  }
  return lines.join("\n");
}
