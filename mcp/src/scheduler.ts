import type { Device, Job, JobResult, JobStatus } from "./types.js";

export type Executor = (job: Job, device: Device, signal: AbortSignal) => Promise<Omit<JobResult, "jobId" | "flow" | "platform" | "deviceId">>;

export interface ScheduleOptions {
  jobs: Job[];
  /** Devices that may take jobs, all platforms together. */
  devices: Device[];
  /** When false, only the first device runs, one job at a time. */
  parallel: boolean;
  execute: Executor;
  signal: AbortSignal;
  onUpdate?: (result: JobResult) => void;
}

/**
 * Queue-based runner. Each free device pulls the next queued job whose
 * platform matches its own. A device that errors only fails its current job;
 * the others keep going. Cancellation marks every job not started yet as
 * `cancelled` and aborts the running ones.
 */
export async function runJobs(opts: ScheduleOptions): Promise<JobResult[]> {
  const queue = [...opts.jobs];
  const results = new Map<string, JobResult>();
  const workers = opts.parallel ? opts.devices : opts.devices.slice(0, 1);

  const record = (job: Job, device: Device | undefined, status: JobStatus, extra: Partial<JobResult> = {}) => {
    const result: JobResult = {
      jobId: job.id,
      flow: job.flow,
      platform: job.platform,
      deviceId: device?.id ?? "",
      status,
      durationMs: null,
      exitCode: null,
      reportPath: null,
      errorTail: null,
      ...extra,
    };
    results.set(job.id, result);
    opts.onUpdate?.(result);
  };

  const takeNext = (platform: Device["platform"]): Job | undefined => {
    const idx = queue.findIndex((j) => j.platform === platform);
    return idx === -1 ? undefined : queue.splice(idx, 1)[0];
  };

  const worker = async (device: Device) => {
    for (let job = takeNext(device.platform); job; job = takeNext(device.platform)) {
      if (opts.signal.aborted) {
        record(job, undefined, "cancelled");
        continue;
      }
      record(job, device, "running");
      try {
        const outcome = await opts.execute(job, device, opts.signal);
        record(job, device, outcome.status, outcome);
      } catch (err) {
        record(job, device, "error", { errorTail: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  await Promise.all(workers.map(worker));

  // Jobs no worker could take (no device for their platform).
  for (const job of queue.splice(0)) record(job, undefined, "error", { errorTail: `No ${job.platform} device available.` });

  return opts.jobs.map((j) => results.get(j.id)!);
}
