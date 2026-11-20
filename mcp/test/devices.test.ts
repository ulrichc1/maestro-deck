import { describe, expect, it } from "vitest";
import { parseAdbDevices, parseDevicectl } from "../src/devices.js";

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
      { id: "emulator-5554", name: "Pixel 10", platform: "android", state: "device", virtual: true, usable: true },
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
});
