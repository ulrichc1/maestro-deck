import { describe, expect, it } from "vitest";
import { modelOf, parseAdbDevices, parseAvdName, parseDevicectl, parseSimctl } from "../src/devices.js";

describe("parseAdbDevices", () => {
  it("reads usable emulators and physical phones, keeps offline state", () => {
    const out = [
      "List of devices attached",
      "emulator-5554\tdevice product:sdk_gphone64_arm64 model:Pixel_10 device:emu64a transport_id:1",
      "R5CT20ABCDE\tunauthorized usb:1-1 transport_id:3",
      "",
    ].join("\n");
    const devices = parseAdbDevices(out);
    expect(devices).toEqual([
      { id: "emulator-5554", name: "Pixel 10", model: "pixel_10", platform: "android", state: "device", virtual: true, usable: true },
      { id: "R5CT20ABCDE", name: "R5CT20ABCDE", platform: "android", state: "unauthorized", virtual: false, usable: false },
    ]);
  });

  it("returns nothing when no device is attached", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });
});

describe("parseDevicectl", () => {
  it("separates simulators from physical iPhones and ignores other platforms", () => {
    const json = {
      result: {
        devices: [
          {
            identifier: "A5639C88",
            deviceProperties: { name: "iPhone 17 Pro" },
            hardwareProperties: { platform: "iOS", reality: "simulated" },
            connectionProperties: { tunnelState: "connected" },
          },
          {
            identifier: "9DDA20F3",
            deviceProperties: { name: "IphoneU" },
            hardwareProperties: { platform: "iOS", reality: "physical" },
            connectionProperties: { tunnelState: "unavailable" },
          },
          {
            identifier: "79D3780E",
            deviceProperties: { name: "Apple Watch SE 3 (40mm)" },
            hardwareProperties: { platform: "watchOS", reality: "simulated" },
            connectionProperties: { tunnelState: "disconnected" },
          },
        ],
      },
    };
    const devices = parseDevicectl(json);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ id: "A5639C88", platform: "ios", virtual: true, usable: true });
    expect(devices[1]).toMatchObject({ id: "9DDA20F3", platform: "ios", virtual: false, usable: false, state: "unavailable" });
  });

  it("does not use a physical iPhone reached over the local network", () => {
    const json = {
      result: {
        devices: [
          {
            identifier: "9DDA20F3",
            deviceProperties: { name: "IphoneU" },
            hardwareProperties: { platform: "iOS", reality: "physical" },
            connectionProperties: { tunnelState: "connected", transportType: "localNetwork" },
          },
          {
            identifier: "00008130",
            deviceProperties: { name: "IphoneCable" },
            hardwareProperties: { platform: "iOS", reality: "physical" },
            connectionProperties: { tunnelState: "connected", transportType: "wired" },
          },
        ],
      },
    };
    const [network, cable] = parseDevicectl(json);
    expect(network).toMatchObject({ usable: false, state: "connected-network" });
    expect(cable).toMatchObject({ usable: true, virtual: false });
  });
});

describe("parseSimctl", () => {
  it("marks booted iOS simulators usable and skips unavailable or non-iOS ones", () => {
    const json = {
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
          { name: "iPhone 17 Pro", udid: "A", state: "Booted", isAvailable: true },
          { name: "iPhone 16e", udid: "B", state: "Shutdown", isAvailable: true },
          { name: "iPhone old", udid: "C", state: "Booted", isAvailable: false },
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-26-2": [
          { name: "Apple Watch", udid: "D", state: "Booted", isAvailable: true },
        ],
      },
    };
    const devices = parseSimctl(json);
    expect(devices.map((d) => [d.id, d.usable])).toEqual([["A", true], ["B", false]]);
  });
});

describe("parseAvdName", () => {
  it("reads the AVD name before the OK line", () => {
    expect(parseAvdName("Pixel_10_Pro\nOK\n")).toBe("Pixel_10_Pro");
    expect(parseAvdName("Pixel_10\r\nOK\r\n")).toBe("Pixel_10");
  });
  it("returns null when the console gives no name", () => {
    expect(parseAvdName("OK\n")).toBeNull();
    expect(parseAvdName("KO: unknown command\n")).toBeNull();
    expect(parseAvdName("")).toBeNull();
  });
});

describe("model identity", () => {
  it("uses the iPhone product type, so a custom-named phone matches an identical simulator", () => {
    const json = {
      result: {
        devices: [
          {
            identifier: "PHYS", deviceProperties: { name: "IphoneU" },
            hardwareProperties: { platform: "iOS", reality: "physical", productType: "iPhone16,2", marketingName: "iPhone 15 Pro Max" },
            connectionProperties: { tunnelState: "connected", transportType: "wired" },
          },
          {
            identifier: "SIM", deviceProperties: { name: "Mate 15 Pro Max" },
            hardwareProperties: { platform: "iOS", reality: "simulated", productType: "iPhone16,2", marketingName: "iPhone 15 Pro Max" },
            connectionProperties: { tunnelState: "connected" },
          },
        ],
      },
    };
    const [phys, sim] = parseDevicectl(json);
    expect(modelOf(phys)).toBe(modelOf(sim));
  });

  it("falls back to the name when no model is known, and ignores case and separators", () => {
    const d = (name: string, model?: string) => ({ id: name, name, model, platform: "android" as const, state: "device", virtual: true, usable: true });
    expect(modelOf(d("Pixel_10"))).toBe(modelOf(d("pixel 10")));
    expect(modelOf(d("Pixel 10", "Pixel_10_Pro"))).toBe("pixel 10 pro");
  });

  it("reads the simulator device type from simctl", () => {
    const devices = parseSimctl({
      devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
        { name: "iPhone 17 Pro", udid: "A", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
        { name: "My clone", udid: "B", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
      ] },
    });
    expect(modelOf(devices[0])).toBe(modelOf(devices[1]));
  });
});
