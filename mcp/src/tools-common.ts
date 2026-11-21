import { discoverDevices } from "./maestro.js";
import type { CloudClientConfig } from "./cloud.js";
import type { DeviceCtx } from "./devicetools.js";
import type { DeviceLocks } from "./locks.js";
import type { RunManager } from "./runs.js";
import type { Device } from "./types.js";

export interface ServerDeps {
  bin: string;
  adbBin: string;
  runs: RunManager;
  cloud: CloudClientConfig;
  /** Command runner for device tools. Defaults to real processes; tests pass a fake. */
  ctx?: DeviceCtx;
  locks?: DeviceLocks;
  /** Folders flows may be written into. Default: the directory the server started in. */
  flowRoots?: string[];
}

export type FullDeps = Required<ServerDeps>;

export const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Longest side, in pixels, of the screenshots sent to the agent. */
export const DEFAULT_MAX_IMAGE = 1600;

export const image = (png: Buffer) => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" });

/**
 * The device a tool should act on. With an id: that device, which must be usable. Without one:
 * the only usable device, or an error that lists the choices.
 */
export async function resolveDevice(deps: FullDeps, deviceId?: string): Promise<Device> {
  const all = await discoverDevices(deps.adbBin);
  const usable = all.filter((d) => d.usable);
  if (deviceId) {
    const d = all.find((x) => x.id === deviceId);
    if (!d) throw new Error(`Unknown device "${deviceId}". Use list_devices to see the ids.`);
    if (!d.usable) throw new Error(`${d.name} (${d.id}) is not usable now: state "${d.state}".`);
    return d;
  }
  if (usable.length === 1) return usable[0];
  if (usable.length === 0) throw new Error("No usable device. Start one with boot_device, or connect a phone.");
  throw new Error(`Several devices are usable, pass deviceId: ${usable.map((d) => `${d.id} (${d.name})`).join(", ")}.`);
}

/** Fails when a run or another tool already uses the device. Returns the release function. */
export function claimDevice(deps: FullDeps, device: Device, who: string): () => void {
  const run = deps.runs.busyDevices().get(device.id);
  if (run) throw new Error(`${device.id} is busy with run ${run}. Wait for it, or cancel it with cancel_run.`);
  return deps.locks.acquire(device.id, who);
}
