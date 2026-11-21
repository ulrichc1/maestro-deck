import type { Device, Job, JobResult, JobStatus } from "./types.js";
import type { ExecuteOutcome } from "./maestro.js";

export type Executor = (job: Job, device: Device, signal: AbortSignal) => Promise<ExecuteOutcome>;

export interface ScheduleOptions {
  jobs: Job[];
  /** Devices that may take jobs, all platforms together. */
  devices: Device[];
  /** When false, only the first device runs, one job at a time. */
  parallel: boolean;
  execute: Executor;
  signal: AbortSignal;
  onUpdate?: (result: JobResult) => void;
  /** Called when a device is taken out of rotation after repeated infrastructure errors. */
  onDeviceRetired?: (device: Device, reason: string) => void;
  /** Total attempts per job for infrastructure failures (error, timeout). Default 2. */
  maxAttempts?: number;
  /** Also retry jobs whose flow failed (flaky tests). Default false. */
  retryFailed?: boolean;
  /** Retire a device after this many infrastructure failures in a row. Default 2. */
  quarantineAfter?: number;
}

interface QueueItem {
  job: Job;
  attempt: number;
  /** Devices this job already failed on; other devices are preferred. */
  avoid: Set<string>;
  devicesTried: string[];
}

const isInfra = (s: JobStatus) => s === "error" || s === "timeout";

/**
 * Queue-based runner. Each free device pulls the next queued job whose
 * platform matches its own.
 *
 * - A device that errors only fails its current job; the others keep going.
 * - An infrastructure failure (error, timeout) is retried, on another device
 *   when one exists, up to `maxAttempts`. Test failures are not retried unless
 *   `retryFailed` is set.
 * - A device with `quarantineAfter` infrastructure failures in a row is retired
 *   so it cannot burn through the queue.
 * - Cancellation marks every job not started yet as `cancelled` and aborts the
 *   running ones.
 */
export async function runJobs(opts: ScheduleOptions): Promise<JobResult[]> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const quarantineAfter = Math.max(1, opts.quarantineAfter ?? 2);
  const queue: QueueItem[] = opts.jobs.map((job) => ({ job, attempt: 1, avoid: new Set(), devicesTried: [] }));
  const results = new Map<string, JobResult>();
  const workers = opts.parallel ? opts.devices : opts.devices.slice(0, 1);
  const retired = new Set<string>();

  let running = 0;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  const waitForChange = () => new Promise<void>((resolve) => waiters.push(resolve));

  const record = (item: QueueItem, device: Device | undefined, status: JobStatus, extra: Partial<JobResult> = {}) => {
    const result: JobResult = {
      jobId: item.job.id,
      flow: item.job.flow,
      platform: item.job.platform,
      deviceId: device?.id ?? "",
      status,
      durationMs: null,
      exitCode: null,
      reportPath: null,
      errorTail: null,
      attempts: item.attempt,
      devicesTried: [...item.devicesTried],
      ...extra,
    };
    results.set(item.job.id, result);
    opts.onUpdate?.(result);
  };

  /** Next job this device may take; jobs that avoid it are left for other devices. */
  const take = (device: Device): QueueItem | undefined => {
    const idx = queue.findIndex((q) => q.job.platform === device.platform && !q.avoid.has(device.id));
    return idx === -1 ? undefined : queue.splice(idx, 1)[0];
  };

  const otherDeviceExists = (item: QueueItem, device: Device) =>
    workers.some((d) => d.platform === item.job.platform && d.id !== device.id && !retired.has(d.id));

  /** Devices still working: not retired, not finished. */
  const active = new Set(workers.map((d) => d.id));

  /** Another active device of the same platform that has not already failed this job. */
  const someoneElseCanTake = (q: QueueItem, device: Device) =>
    workers.some(
      (d) => d.id !== device.id && d.platform === q.job.platform && active.has(d.id) && !retired.has(d.id) && !q.avoid.has(d.id),
    );

  const worker = async (device: Device) => {
    let infraInARow = 0;
    try {
      for (;;) {
        if (retired.has(device.id)) return;

        if (opts.signal.aborted) {
          for (let item = take(device); item; item = take(device)) record(item, undefined, "cancelled");
          return;
        }

        let item = take(device);
        if (!item) {
          // A job this device already failed on, which nobody else can take: run it here rather than strand it.
          const idx = queue.findIndex((q) => q.job.platform === device.platform && !someoneElseCanTake(q, device));
          if (idx !== -1) item = queue.splice(idx, 1)[0];
        }
        if (!item) {
          const pending = queue.some((q) => q.job.platform === device.platform);
          if (!pending && running === 0) return;
          await waitForChange();
          continue;
        }

        running++;
        item.devicesTried.push(device.id);
        record(item, device, "running");
        let outcome: Awaited<ReturnType<Executor>>;
        try {
          outcome = await opts.execute(item.job, device, opts.signal);
        } catch (err) {
          outcome = {
            status: "error", durationMs: null, exitCode: null, reportPath: null,
            errorTail: err instanceof Error ? err.message : String(err),
          };
        }

        const infra = isInfra(outcome.status);
        infraInARow = infra ? infraInARow + 1 : 0;
        const quarantine = infra && infraInARow >= quarantineAfter;
        if (quarantine) {
          retired.add(device.id);
          opts.onDeviceRetired?.(device, outcome.errorTail ?? outcome.status);
        }

        const canRetry =
          !opts.signal.aborted &&
          item.attempt < maxAttempts &&
          (infra || (opts.retryFailed === true && outcome.status === "failed"));

        if (canRetry) {
          const avoid = new Set(item.avoid);
          if (otherDeviceExists(item, device)) {
            avoid.add(device.id);
            // Every usable device already failed this job: start another round, away from this one.
            const everyoneAvoided = workers.every(
              (d) => d.platform !== item.job.platform || retired.has(d.id) || avoid.has(d.id),
            );
            if (everyoneAvoided) {
              avoid.clear();
              avoid.add(device.id);
            }
          }
          // The job is not final: show it as queued again, with the reason it is retried.
          record(item, device, "queued", {
            durationMs: outcome.durationMs,
            exitCode: outcome.exitCode,
            errorTail: `Attempt ${item.attempt} ${outcome.status} on ${device.id}: ${outcome.errorTail ?? "no detail"}. Retrying.`,
          });
          queue.push({ job: item.job, attempt: item.attempt + 1, avoid, devicesTried: item.devicesTried });
        } else {
          record(item, device, outcome.status, { ...outcome });
        }
        running--;
        wake();
      }
    } finally {
      active.delete(device.id);
      wake();
    }
  };

  await Promise.all(workers.map(worker));

  // Jobs no worker could take: no device for their platform, or every device was retired.
  for (const item of queue.splice(0)) {
    const previous = results.get(item.job.id);
    if (opts.signal.aborted) {
      record(item, undefined, "cancelled");
    } else {
      record(item, undefined, "error", {
        errorTail: previous?.errorTail
          ? `No healthy ${item.job.platform} device left to retry. Last error: ${previous.errorTail}`
          : `No ${item.job.platform} device available.`,
      });
    }
  }

  return opts.jobs.map((j) => results.get(j.id)!);
}
