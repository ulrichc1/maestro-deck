// Copyright (c) 2026 Ethan Morisset
// SPDX-License-Identifier: BUSL-1.1

import type {
  CloudJobPlatform,
  CloudJobStatus,
  SubmitCloudJobInput,
  SubmitCloudJobResult,
} from "@/lib/cloudJobs";
import type { CloudWatch, CloudWatchHandlers } from "@/lib/cloudRun";
import type { WorkspaceNode } from "@/types";

/**
 * Cloud execution modes (lot 3).
 * - `sequential`: one cloud job holds every flow, as today.
 * - `parallel`: one cloud job per flow, all submitted to the same fleet.
 * - `ios_android`: for each flow, one iOS job and one Android job, so both
 *   platforms are checked at the same time.
 *
 * The cloud API picks the device model itself, so "same model" and "different
 * models" cannot be requested from the desktop app yet.
 */
export type CloudParallelMode = "sequential" | "parallel" | "ios_android";

export interface CloudPlanJob {
  platform: CloudJobPlatform;
  appPath: string;
  yamlPaths: string[];
}

export interface CloudArtifacts {
  /** `.apk` for Android. */
  apk: string | null;
  /** Zipped `.app` simulator build for iOS. */
  iosZip: string | null;
}

/** Turns a mode and a flow list into cloud jobs. Throws when an artefact is missing. */
export function planCloudJobs(
  mode: CloudParallelMode,
  flows: string[],
  platform: CloudJobPlatform,
  artifacts: CloudArtifacts,
): CloudPlanJob[] {
  if (flows.length === 0) throw new Error("No flow to run on the cloud.");
  if (mode === "ios_android") {
    if (!artifacts.iosZip) throw new Error("Choose the zipped .app simulator build for iOS first.");
    if (!artifacts.apk) throw new Error("Choose the .apk to install on Android first.");
    return flows.flatMap((flow) => [
      { platform: "ios" as const, appPath: artifacts.iosZip!, yamlPaths: [flow] },
      { platform: "android" as const, appPath: artifacts.apk!, yamlPaths: [flow] },
    ]);
  }
  const appPath = platform === "ios" ? artifacts.iosZip : artifacts.apk;
  if (!appPath) {
    throw new Error(
      platform === "ios"
        ? "Choose the zipped .app simulator build for iOS first."
        : "Choose the .apk to install first.",
    );
  }
  if (mode === "sequential") return [{ platform, appPath, yamlPaths: flows }];
  return flows.map((flow) => ({ platform, appPath: appPath!, yamlPaths: [flow] }));
}

export type CloudJobState =
  | "passed"
  | "failed"
  | "error"
  | "gave_up"
  | "detached"
  | "not_submitted";

export interface CloudJobOutcome {
  platform: CloudJobPlatform;
  flows: string[];
  jobId: string | null;
  state: CloudJobState;
  /** Reason from the cloud or from the watcher. */
  message: string | null;
  reportUrl: string | null;
}

export interface CloudParallelDeps {
  submit: (input: SubmitCloudJobInput) => Promise<SubmitCloudJobResult>;
  watch: (jobId: string, handlers: CloudWatchHandlers) => CloudWatch;
  onLine?: (text: string) => void;
  /** Errors whose code means no further job can be accepted now. */
  isQuotaError?: (err: unknown) => boolean;
}

/**
 * Submits every planned job, then waits for each one to finish. Jobs are
 * submitted in order. If the cloud refuses one for quota, the rest are not
 * submitted, and jobs already accepted keep running and are billed.
 */
export async function runCloudParallel(
  jobs: CloudPlanJob[],
  deps: CloudParallelDeps,
): Promise<CloudJobOutcome[]> {
  const line = deps.onLine ?? (() => {});
  const accepted: { index: number; jobId: string }[] = [];
  const outcomes: CloudJobOutcome[] = jobs.map((job) => ({
    platform: job.platform,
    flows: job.yamlPaths,
    jobId: null,
    state: "not_submitted",
    message: null,
    reportUrl: null,
  }));

  let quotaHit = false;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (quotaHit) {
      outcomes[i].message = "Not submitted: the cloud quota was reached.";
      continue;
    }
    try {
      const { jobId } = await deps.submit({
        platform: job.platform,
        appPath: job.appPath,
        yamlPaths: job.yamlPaths,
      });
      accepted.push({ index: i, jobId });
      outcomes[i].jobId = jobId;
      line(
        `[cloud] job ${jobId} queued on ${job.platform} for ${job.yamlPaths.map(basename).join(", ")}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes[i].state = "error";
      outcomes[i].message = `Not submitted: ${message}`;
      line(
        `[cloud] ${job.platform} job for ${job.yamlPaths.map(basename).join(", ")} was not accepted: ${message}`,
      );
      if (deps.isQuotaError?.(err)) quotaHit = true;
    }
  }

  await Promise.all(
    accepted.map(
      ({ index, jobId }) =>
        new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            settled = true;
            resolve();
          };
          const watch = deps.watch(jobId, {
            onStatus: (status) => line(`[cloud] ${jobId} ${status}`),
            onFinished: ({ job }: { job: CloudJobStatus }) => {
              outcomes[index].state =
                job.status === "passed" ? "passed" : job.status === "error" ? "error" : "failed";
              outcomes[index].message = job.error ?? null;
              outcomes[index].reportUrl = job.reportUrl ?? null;
              line(`[cloud] ${jobId} finished: ${job.status}`);
              settle();
            },
            onGaveUp: () => {
              outcomes[index].state = "gave_up";
              outcomes[index].message = "No news for 20 minutes; the job may still finish.";
              settle();
            },
            onError: (msg: string) => {
              outcomes[index].state = "error";
              outcomes[index].message = msg;
              settle();
            },
          });
          // Stopped by the user before the job ended: the job keeps running in the cloud.
          void watch.then(() => {
            if (settled) return;
            outcomes[index].state = "detached";
            outcomes[index].message = "Stopped watching; the job continues in the cloud.";
            settle();
          });
        }),
    ),
  );

  return outcomes;
}

/** Flow files (.yaml / .yml) under a workspace tree, in tree order. */
export function flowPaths(node: WorkspaceNode | null): string[] {
  if (!node) return [];
  if (node.kind === "file") return /\.ya?ml$/i.test(node.name) ? [node.path] : [];
  return node.children.flatMap((child) => flowPaths(child));
}

/** True only when every job was accepted and passed. */
export function cloudRunPassed(outcomes: CloudJobOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.state === "passed");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
