// Copyright (c) 2026 Ethan Morisset
// SPDX-License-Identifier: BUSL-1.1

import { CloudJobError, submitCloudJob, type CloudJobPlatform } from "@/lib/cloudJobs";
import { watchCloudJob, type CloudWatch, type CloudWatchHandlers } from "@/lib/cloudRun";
import {
  cloudRunPassed,
  planCloudJobs,
  runCloudParallel,
  type CloudJobOutcome,
  type CloudParallelMode,
} from "@/lib/cloudParallel";
import { useRunStore } from "@/stores/runStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

/** Watches of the parallel run in flight, so Stop can detach from all of them. */
let activeWatches: CloudWatch[] = [];

/** Detaches from every job of the parallel run. Returns false when none is running. */
export function stopWatchingParallelRun(): boolean {
  if (activeWatches.length === 0) return false;
  for (const w of activeWatches) w.stop();
  activeWatches = [];
  return true;
}

/**
 * Desktop entry point for cloud parallel runs. Uses the same API and watcher
 * as the single-job cloud run, and writes progress to the run console.
 * Resolves with every job's outcome once they have all settled or been detached.
 */
export async function startCloudParallelRun(
  mode: CloudParallelMode,
  flows: string[],
  platform: CloudJobPlatform = "android",
): Promise<CloudJobOutcome[]> {
  const ws = useWorkspaceStore.getState();
  const log = (text: string) => useRunStore.getState().appendLog("system", text);

  const jobs = planCloudJobs(mode, flows, platform, {
    apk: ws.cloudApkPath,
    iosZip: ws.cloudIosAppPath,
  });
  log(
    `[cloud] ${mode}: ${jobs.length} job(s) for ${flows.length} flow(s). Each accepted job spends one run once it starts, and cannot be cancelled.`,
  );
  useRunStore.getState().cloudParallelStarted();

  activeWatches = [];
  const watchTracked = (jobId: string, handlers: CloudWatchHandlers): CloudWatch => {
    const w = watchCloudJob(jobId, handlers);
    activeWatches.push(w);
    return w;
  };

  let outcomes: CloudJobOutcome[];
  try {
    outcomes = await runCloudParallel(jobs, {
      submit: submitCloudJob,
      watch: watchTracked,
      onLine: log,
      isQuotaError: (err) => err instanceof CloudJobError && err.code === "QUOTA_EXCEEDED",
    });
  } finally {
    activeWatches = [];
  }

  const passed = outcomes.filter((o) => o.state === "passed").length;
  log(`[cloud] ${passed}/${outcomes.length} job(s) passed`);
  for (const o of outcomes) {
    if (o.reportUrl) log(`[cloud] ${o.platform} report: ${o.reportUrl}`);
  }
  useRunStore.getState().setStopped(cloudRunPassed(outcomes) ? 0 : 1);
  return outcomes;
}
