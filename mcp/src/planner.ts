import type { Device, Job, Mode, Platform } from "./types.js";

export interface PlanInput {
  mode: Mode;
  flows: string[];
  devices: Device[];
}

export interface Plan {
  mode: Mode;
  /** Devices that will run jobs, grouped by the platform they serve. */
  pools: Record<Platform, Device[]>;
  jobs: Job[];
  /** True when more than one device can run at the same time. */
  parallel: boolean;
}

/**
 * Decomposition rules (lot 3):
 * - sequential: every flow on the first device, in order.
 * - same/different models (one platform): each flow is one job; jobs are
 *   pulled from a shared queue by whichever device of the platform is free
 *   (flow-level sharding).
 * - ios_android: each flow produces one iOS job and one Android job, so both
 *   platforms are verified at the same time and reports are split by OS.
 */
export function buildPlan(input: PlanInput): Plan {
  const { mode, flows, devices } = input;
  const pools: Record<Platform, Device[]> = { android: [], ios: [] };

  if (mode === "sequential") {
    const first = devices[0];
    if (!first) throw new Error("Sequential mode needs at least one device.");
    pools[first.platform] = [first];
    return {
      mode,
      pools,
      parallel: false,
      jobs: flows.map((flow, i) => job(mode, i, flow, first.platform)),
    };
  }

  if (mode === "ios_android") {
    pools.ios = devices.filter((d) => d.platform === "ios");
    pools.android = devices.filter((d) => d.platform === "android");
    if (!pools.ios.length || !pools.android.length) {
      throw new Error("ios_android needs at least one iOS and one Android device.");
    }
    const jobs: Job[] = [];
    flows.forEach((flow, i) => {
      jobs.push(job(mode, i * 2, flow, "ios"));
      jobs.push(job(mode, i * 2 + 1, flow, "android"));
    });
    return { mode, pools, parallel: true, jobs };
  }

  const platform: Platform = mode.startsWith("ios") ? "ios" : "android";
  const candidates = devices.filter((d) => d.platform === platform);
  pools[platform] = mode.endsWith("same_model") ? largestSameModelGroup(candidates) : candidates;
  if (pools[platform].length < 2) {
    throw new Error(`${mode} needs at least two ${platform} devices.`);
  }
  return {
    mode,
    pools,
    parallel: true,
    jobs: flows.map((flow, i) => job(mode, i, flow, platform)),
  };
}

function job(mode: Mode, index: number, flow: string, platform: Platform): Job {
  return { id: `${mode}-${platform}-${index}`, flow, platform, deviceId: "" };
}

/** Keeps the largest group of devices that share a model name. */
export function largestSameModelGroup(devices: Device[]): Device[] {
  const groups = new Map<string, Device[]>();
  for (const d of devices) {
    const key = d.name.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  let best: Device[] = [];
  for (const group of groups.values()) if (group.length > best.length) best = group;
  return best;
}
