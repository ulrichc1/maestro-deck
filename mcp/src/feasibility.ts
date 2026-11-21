import { modelOf } from "./devices.js";
import type { Device, Feasibility, FeasibilityReport, Mode, Platform } from "./types.js";

interface Need {
  platform: Platform | "both";
  kind: "any" | "same_model" | "different_models";
  min: number;
}

const NEEDS: Record<Exclude<Mode, "sequential">, Need> = {
  android_same_model: { platform: "android", kind: "same_model", min: 2 },
  android_different_models: { platform: "android", kind: "different_models", min: 2 },
  ios_same_model: { platform: "ios", kind: "same_model", min: 2 },
  ios_different_models: { platform: "ios", kind: "different_models", min: 2 },
  ios_android: { platform: "both", kind: "any", min: 1 },
};

/**
 * Decides whether a mode can run on the devices visible now. Pure function.
 * Only usable devices count. The result is `with_reserve` when every device
 * that would be used is an emulator or simulator, since their results can
 * differ from physical phones.
 */
export function checkFeasibility(mode: Mode, allDevices: Device[]): FeasibilityReport {
  const usable = allDevices.filter((d) => d.usable);
  const devicesFound = summarize(usable);

  if (mode === "sequential") {
    return usable.length >= 1
      ? finish(mode, "yes", "At least one device is usable.", devicesFound, usable.slice(0, 1))
      : finish(mode, "no", "No usable device is connected.", devicesFound, []);
  }

  const need = NEEDS[mode];

  if (need.platform === "both") {
    const ios = usable.filter((d) => d.platform === "ios");
    const android = usable.filter((d) => d.platform === "android");
    if (!ios.length || !android.length) {
      return finish(mode, "no",
        `Needs one usable iOS and one usable Android device; found iOS=${ios.length}, Android=${android.length}.`,
        devicesFound, []);
    }
    return finish(mode, "yes", "One iOS and one Android device are usable.", devicesFound, [ios[0], android[0]]);
  }

  const pool = usable.filter((d) => d.platform === need.platform);
  if (pool.length < need.min) {
    return finish(mode, "no",
      `Needs at least ${need.min} usable ${need.platform} devices; found ${pool.length}.`,
      devicesFound, []);
  }

  if (need.kind === "same_model") {
    const groups = groupByModel(pool);
    const largest = Math.max(...groups.map((g) => g.length));
    if (largest < need.min) {
      return finish(mode, "no", `No model has ${need.min} usable devices; the largest group has ${largest}.`, devicesFound, []);
    }
    const group = groups.find((g) => g.length === largest)!;
    return finish(mode, "yes", `${largest} usable devices share the model ${modelOf(group[0])}.`, devicesFound, group);
  }

  const models = groupByModel(pool);
  if (models.length < need.min) {
    return finish(mode, "no",
      `Needs ${need.min} distinct usable ${need.platform} models; found ${models.length}.`,
      devicesFound, []);
  }
  const picked = models.map((g) => g[0]);
  return finish(mode, "yes", `${picked.length} distinct usable ${need.platform} models are available.`, devicesFound, picked);
}

function groupByModel(devices: Device[]): Device[][] {
  const groups = new Map<string, Device[]>();
  for (const d of devices) {
    const key = modelOf(d);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()];
}

function summarize(devices: Device[]): FeasibilityReport["devicesFound"] {
  const counts = new Map<string, { platform: Platform; model: string; count: number; names: string[] }>();
  for (const d of devices) {
    const model = modelOf(d);
    const key = `${d.platform}|${model}`;
    const entry = counts.get(key) ?? { platform: d.platform, model, count: 0, names: [] as string[] };
    entry.names.push(d.name);
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

function finish(
  mode: Mode,
  base: "yes" | "no",
  reason: string,
  devicesFound: FeasibilityReport["devicesFound"],
  used: Device[],
): FeasibilityReport {
  if (base === "no") return { mode, feasible: "no", reason, devicesFound };
  const allVirtual = used.length > 0 && used.every((d) => d.virtual);
  const feasible: Feasibility = allVirtual ? "with_reserve" : "yes";
  const note = allVirtual ? " Only emulators or simulators would be used: results may differ from physical phones." : "";
  return { mode, feasible, reason: reason + note, devicesFound };
}
