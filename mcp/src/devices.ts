import type { Device } from "./types.js";

/**
 * Parses `adb devices -l`.
 *   List of devices attached
 *   emulator-5554   device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
 *   R5CT20ABCDE     unauthorized usb:1-1 transport_id:3
 * Only `device` is usable; anything else (offline, unauthorized) is reported with its state.
 */
export function parseAdbDevices(output: string): Device[] {
  const devices: Device[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, state, ...props] = line.split(/\s+/);
    if (!serial || !state) continue;
    const model = props.find((p) => p.startsWith("model:"))?.slice("model:".length);
    const virtual = serial.startsWith("emulator-");
    devices.push({
      id: serial,
      name: (model ?? serial).replace(/_/g, " "),
      platform: "android",
      state,
      virtual,
      usable: state === "device",
    });
  }
  return devices;
}

interface DevicectlEntry {
  identifier: string;
  deviceProperties?: { name?: string };
  hardwareProperties?: { platform?: string; reality?: string };
  connectionProperties?: { tunnelState?: string };
}

/**
 * Parses `xcrun devicectl list devices --json-output <file>` (Xcode 15+).
 * Covers simulators (reality "simulated") and physical iPhones ("physical").
 * A physical phone is usable only when its tunnelState is "connected".
 * Simulators are usable when booted (tunnelState "connected").
 */
export function parseDevicectl(json: { result?: { devices?: DevicectlEntry[] } }): Device[] {
  const devices: Device[] = [];
  for (const entry of json.result?.devices ?? []) {
    if (entry.hardwareProperties?.platform !== "iOS") continue;
    const state = entry.connectionProperties?.tunnelState ?? "unknown";
    devices.push({
      id: entry.identifier,
      name: entry.deviceProperties?.name ?? entry.identifier,
      platform: "ios",
      state,
      virtual: entry.hardwareProperties?.reality !== "physical",
      usable: state === "connected",
    });
  }
  return devices;
}

/** Model key used to decide "same model" vs "different models". */
export function modelOf(device: Device): string {
  return device.name.replace(/[_-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
