export type Platform = "android" | "ios";

export interface Device {
  /** adb serial (Android) or UDID (iOS). */
  id: string;
  name: string;
  platform: Platform;
  /** Raw state from the source tool, e.g. "device", "connected", "unavailable". */
  state: string;
  /** Emulator or simulator rather than a physical phone. */
  virtual: boolean;
  /** True when a job can be sent to it right now. */
  usable: boolean;
}

/** Execution modes of lot 3. `sequential` is the default and runs one device. */
export type Mode =
  | "sequential"
  | "android_same_model"
  | "android_different_models"
  | "ios_same_model"
  | "ios_different_models"
  | "ios_android";

export interface Job {
  id: string;
  flow: string;
  platform: Platform;
  /** Device the job is pinned to; set by the planner. */
  deviceId: string;
}

export type JobStatus = "queued" | "running" | "passed" | "failed" | "error" | "cancelled";

export interface JobResult {
  jobId: string;
  flow: string;
  platform: Platform;
  deviceId: string;
  status: JobStatus;
  durationMs: number | null;
  exitCode: number | null;
  reportPath: string | null;
  errorTail: string | null;
}

export type Feasibility = "yes" | "with_reserve" | "no";

export interface FeasibilityReport {
  mode: Mode;
  feasible: Feasibility;
  reason: string;
  devicesFound: { platform: Platform; model: string; count: number }[];
}
