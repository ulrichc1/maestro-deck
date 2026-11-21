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
      model: model?.toLowerCase(),
      platform: "android",
      state,
      virtual,
      usable: state === "device",
    });
  }
  return devices;
}

/**
 * Parses the output of `adb -s <serial> emu avd name`: the AVD name on the
 * first line, then "OK". Emulators all report the same system-image model
 * (for example sdk_gphone16k_arm64), so the AVD name is what tells a Pixel 10
 * from a Pixel 10 Pro.
 */
export function parseAvdName(output: string): string | null {
  const first = output.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first || first === "OK" || /^KO/.test(first)) return null;
  return first;
}

interface DevicectlEntry {
  identifier: string;
  deviceProperties?: { name?: string };
  hardwareProperties?: { platform?: string; reality?: string; productType?: string; marketingName?: string };
  connectionProperties?: { tunnelState?: string; transportType?: string };
}

/**
 * Parses `xcrun devicectl list devices --json-output <file>` (Xcode 15+).
 * Covers simulators (reality "simulated") and physical iPhones ("physical").
 * A physical phone is usable only when its tunnelState is "connected" AND it
 * is attached by cable ("wired"). A phone reached over "localNetwork" is listed
 * as connected but Maestro refuses it ("was requested, but it is not connected").
 * Simulators are usable when booted (tunnelState "connected").
 */
export function parseDevicectl(json: { result?: { devices?: DevicectlEntry[] } }): Device[] {
  const devices: Device[] = [];
  for (const entry of json.result?.devices ?? []) {
    if (entry.hardwareProperties?.platform !== "iOS") continue;
    const state = entry.connectionProperties?.tunnelState ?? "unknown";
    const virtual = entry.hardwareProperties?.reality !== "physical";
    const wired = entry.connectionProperties?.transportType === "wired";
    devices.push({
      id: entry.identifier,
      name: entry.deviceProperties?.name ?? entry.identifier,
      // The name is chosen by the user ("IphoneU"); the product type is the real model.
      model: entry.hardwareProperties?.productType ?? entry.hardwareProperties?.marketingName,
      platform: "ios",
      state: !virtual && state === "connected" && !wired ? "connected-network" : state,
      virtual,
      usable: state === "connected" && (virtual || wired),
    });
  }
  return devices;
}

interface SimctlDevice {
  name: string;
  udid: string;
  state: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

/**
 * Parses `xcrun simctl list devices available -j`. A simulator is usable when
 * its state is "Booted". Used as a second source because devicectl does not
 * always report a booted simulator as connected (seen on hosted macOS runners).
 */
export function parseSimctl(json: { devices?: Record<string, SimctlDevice[]> }): Device[] {
  const devices: Device[] = [];
  for (const [runtime, list] of Object.entries(json.devices ?? {})) {
    if (!/iOS/.test(runtime)) continue;
    for (const d of list) {
      if (d.isAvailable === false) continue;
      devices.push({
        id: d.udid,
        name: d.name,
        model: d.deviceTypeIdentifier?.split(".").pop(),
        platform: "ios",
        state: d.state === "Booted" ? "connected" : d.state.toLowerCase(),
        virtual: true,
        usable: d.state === "Booted",
      });
    }
  }
  return devices;
}

/** Model key used to decide "same model" vs "different models". */
export function modelOf(device: Device): string {
  return (device.model ?? device.name).replace(/[_-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
