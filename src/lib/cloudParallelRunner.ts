// Copyright (c) 2026 Ethan Morisset
// SPDX-License-Identifier: BUSL-1.1

import { CloudJobError, submitCloudJob } from "@/lib/cloudJobs";
import { watchCloudJob } from "@/lib/cloudRun";
import { cloudRunPassed, planCloudJobs, runCloudParallel, type CloudParallelMode } from "@/lib/cloudParallel";
import { useRunStore } from "@/stores/runStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/**
 * Desktop entry point for cloud parallel runs. Uses the same API and watcher
 * as the single-job cloud run, and writes progress to the run console.
 * Returns true when every cloud job passed.
 */
export async function startCloudParallelRun(
  mode: CloudParallelMode,
  flows: string[],
  platform: "android" | "ios" = "android",
): Promise<boolean> {
  const ws = useWorkspaceStore.getState();
  const log = (text: string) => useRunStore.getState().appendLog("system", text);

  const jobs = planCloudJobs(mode, flows, platform, {
    apk: ws.cloudApkPath,
    iosZip: ws.cloudIosAppPath,
  });
  log(`[cloud] ${mode}: ${jobs.length} job(s) for ${flows.length} flow(s). Each accepted job spends one run once it starts, and cannot be cancelled.`);

  const outcomes = await runCloudParallel(jobs, {
    submit: submitCloudJob,
    watch: watchCloudJob,
    onLine: log,
    isQuotaError: (err) => err instanceof CloudJobError && err.code === "QUOTA_EXCEEDED",
  });

  const passed = outcomes.filter((o) => o.state === "passed").length;
  log(`[cloud] ${passed}/${outcomes.length} job(s) passed`);
  for (const o of outcomes) {
    if (o.reportUrl) log(`[cloud] ${o.platform} report: ${o.reportUrl}`);
  }
  return cloudRunPassed(outcomes);
}
