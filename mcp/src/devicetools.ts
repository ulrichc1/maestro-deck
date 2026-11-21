import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { parseAvdName } from "./devices.js";
import { parseHierarchy, type UiNode } from "./ui.js";
import type { Device } from "./types.js";

export interface ExecOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Text written to the command's standard input. */
  input?: string;
}
export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}
/** Runs a command and returns its raw output. Never throws on a non-zero exit. */
export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const defaultExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    let timedOut = false;
    const timer = opts.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeout)
      : undefined;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= max) out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-8000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${basename(file)} timed out after ${Math.round((opts.timeout ?? 0) / 1000)}s`));
        return;
      }
      resolve({ stdout: Buffer.concat(out), stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });

export interface DeviceCtx {
  adbBin: string;
  maestroBin: string;
  emulatorBin: string;
  /** Where emulator logs go. */
  logDir: string;
  exec: Exec;
}

export class DeviceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceToolError";
  }
}

const text = (r: ExecResult) => r.stdout.toString("utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Finds the emulator binary: EMULATOR_BIN, ANDROID_HOME, the default SDK, next to adb, then the PATH. */
export function resolveEmulatorBin(adbBin: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.EMULATOR_BIN) return env.EMULATOR_BIN;
  const candidates = [
    env.ANDROID_HOME && join(env.ANDROID_HOME, "emulator", "emulator"),
    env.ANDROID_SDK_ROOT && join(env.ANDROID_SDK_ROOT, "emulator", "emulator"),
    join(homedir(), "Library", "Android", "sdk", "emulator", "emulator"),
    adbBin.includes("/") ? join(dirname(adbBin), "..", "emulator", "emulator") : null,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return "emulator";
}

const isPhysicalIos = (d: Device) => d.platform === "ios" && !d.virtual;

// ---------------------------------------------------------------- screenshot

/** Width and height read from a PNG header, or null when it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 4).equals(PNG)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Shrinks a screenshot so its longest side is at most `maxDim` pixels. A full-size iPhone capture
 * is over 2 MB, which would fill an agent's context for little gain. Uses `sips` (macOS); where it
 * is missing or fails, the original image is returned unchanged.
 */
export async function fitImage(png: Buffer, maxDim: number, ctx: DeviceCtx): Promise<Buffer> {
  const size = pngSize(png);
  if (maxDim <= 0 || !size || Math.max(size.width, size.height) <= maxDim) return png;
  const dir = mkdtempSync(join(tmpdir(), "fit-"));
  try {
    const input = join(dir, "in.png");
    const output = join(dir, "out.png");
    writeFileSync(input, png);
    const r = await ctx.exec("sips", ["-Z", String(maxDim), input, "--out", output], { timeout: 20_000 });
    if (r.code !== 0 || !existsSync(output)) return png;
    const small = readFileSync(output);
    return small.length > 0 && small.length < png.length ? small : png;
  } catch {
    return png;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A PNG of what the device shows now. Works on emulators, simulators and (through Maestro) real iPhones. */
export async function takeScreenshot(device: Device, ctx: DeviceCtx): Promise<Buffer> {
  let png: Buffer;
  if (device.platform === "android") {
    const r = await ctx.exec(ctx.adbBin, ["-s", device.id, "exec-out", "screencap", "-p"], { timeout: 30_000 });
    png = r.stdout;
  } else if (!isPhysicalIos(device)) {
    const dir = mkdtempSync(join(tmpdir(), "shot-"));
    const file = join(dir, "screen.png");
    try {
      const r = await ctx.exec("xcrun", ["simctl", "io", device.id, "screenshot", "--type=png", file], { timeout: 30_000 });
      if (!existsSync(file)) throw new DeviceToolError(`simctl could not take a screenshot: ${r.stderr.trim() || "no output"}`);
      png = readFileSync(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    png = await screenshotViaMaestro(device, ctx);
  }
  if (png.length < 8 || !png.subarray(0, 4).equals(PNG)) {
    throw new DeviceToolError(`The device did not return an image (${device.id}). Is the screen on and the device unlocked?`);
  }
  return png;
}

/** For devices with no direct capture tool (physical iPhones): a one-step Maestro flow. */
async function screenshotViaMaestro(device: Device, ctx: DeviceCtx): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "shot-maestro-"));
  try {
    const target = join(dir, "screen");
    const flow = join(dir, "shot.yaml");
    writeFileSync(flow, `appId: com.apple.springboard\n---\n- takeScreenshot: ${JSON.stringify(target)}\n`);
    const r = await ctx.exec(ctx.maestroBin, ["--udid", device.id, "test", flow], { timeout: 120_000 });
    const file = `${target}.png`;
    if (!existsSync(file)) throw new DeviceToolError(`Maestro could not take a screenshot: ${r.stderr.trim().slice(-300) || text(r).slice(-300)}`);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- hierarchy

/** The elements on the device's screen, read through Maestro. Takes a few seconds the first time. */
export async function readHierarchy(device: Device, ctx: DeviceCtx): Promise<UiNode[]> {
  const r = await ctx.exec(ctx.maestroBin, ["--udid", device.id, "hierarchy"], { timeout: 120_000 });
  const out = text(r);
  if (!out.includes("{")) {
    throw new DeviceToolError(`Maestro returned no hierarchy for ${device.id}: ${(r.stderr || out).trim().slice(-300) || "no output"}`);
  }
  return parseHierarchy(out);
}

// ------------------------------------------------------------- availability

export interface AvailableDevices {
  androidEmulators: { name: string }[];
  iosSimulators: { name: string; udid: string; state: string; os: string }[];
}

interface SimctlList {
  devices?: Record<string, { name: string; udid: string; state: string; isAvailable?: boolean }[]>;
}

/** Emulators and simulators that exist on this machine, running or not. */
export async function listAvailable(ctx: DeviceCtx): Promise<AvailableDevices> {
  const result: AvailableDevices = { androidEmulators: [], iosSimulators: [] };
  try {
    const r = await ctx.exec(ctx.emulatorBin, ["-list-avds"], { timeout: 30_000 });
    result.androidEmulators = text(r)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("INFO") && !/\s/.test(l))
      .map((name) => ({ name }));
  } catch {
    // No Android SDK emulator on this machine.
  }
  try {
    const r = await ctx.exec("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeout: 60_000 });
    const json = JSON.parse(text(r)) as SimctlList;
    for (const [runtime, list] of Object.entries(json.devices ?? {})) {
      const m = /iOS-(\d+)-(\d+)/.exec(runtime);
      if (!m) continue;
      for (const d of list) {
        if (d.isAvailable === false || !/iPhone|iPad/.test(d.name)) continue;
        result.iosSimulators.push({ name: d.name, udid: d.udid, state: d.state, os: `${m[1]}.${m[2]}` });
      }
    }
  } catch {
    // No Xcode on this machine.
  }
  return result;
}

// ------------------------------------------------------------------- boot

export interface BootResult {
  deviceId: string;
  name: string;
  alreadyRunning: boolean;
  seconds: number;
  log?: string;
}

async function adbDevices(ctx: DeviceCtx): Promise<string[]> {
  const r = await ctx.exec(ctx.adbBin, ["devices"], { timeout: 15_000 });
  return text(r)
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
}

async function avdNameOf(serial: string, ctx: DeviceCtx): Promise<string | null> {
  try {
    return parseAvdName(text(await ctx.exec(ctx.adbBin, ["-s", serial, "emu", "avd", "name"], { timeout: 10_000 })));
  } catch {
    return null;
  }
}

/**
 * Starts an Android emulator by AVD name and waits until it has finished booting.
 * Without `readOnly` an AVD that is already running cannot be started a second time.
 */
export async function bootAndroid(
  avd: string,
  ctx: DeviceCtx,
  opts: { headless?: boolean; readOnly?: boolean; timeoutMs?: number } = {},
): Promise<BootResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const known = (await listAvailable(ctx)).androidEmulators.map((e) => e.name);
  if (!known.includes(avd)) {
    throw new DeviceToolError(`No emulator named "${avd}". Available: ${known.join(", ") || "none"}.`);
  }
  const before = await adbDevices(ctx);
  if (!opts.readOnly) {
    for (const serial of before) {
      if ((await avdNameOf(serial, ctx)) === avd) {
        return { deviceId: serial, name: avd, alreadyRunning: true, seconds: 0 };
      }
    }
  }

  mkdirSync(ctx.logDir, { recursive: true });
  const logFile = join(ctx.logDir, `emulator-${avd}-${Date.now()}.log`);
  const fd = openSync(logFile, "a");
  const args = ["-avd", avd, "-no-snapshot", "-no-audio", "-no-boot-anim", "-gpu", "swiftshader_indirect"];
  if (opts.headless !== false) args.push("-no-window");
  if (opts.readOnly) args.push("-read-only");
  const child = spawn(ctx.emulatorBin, args, { detached: true, stdio: ["ignore", fd, fd] });
  let exited: number | null | undefined;
  let spawnError: Error | undefined;
  child.on("exit", (code) => {
    exited = code;
  });
  child.on("error", (e) => {
    spawnError = e;
  });
  child.unref();
  closeSync(fd);

  const tail = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").slice(-4).join(" | ").slice(-400);
    } catch {
      return "";
    }
  };

  while (Date.now() - started < timeoutMs) {
    if (spawnError) throw new DeviceToolError(`Could not start the emulator: ${spawnError.message}. Set EMULATOR_BIN to its path.`);
    if (exited !== undefined) throw new DeviceToolError(`The emulator stopped right away (exit ${exited}): ${tail()}`);
    const now = await adbDevices(ctx);
    for (const serial of now.filter((s) => !before.includes(s))) {
      if ((await avdNameOf(serial, ctx)) !== avd) continue;
      const done = text(await ctx.exec(ctx.adbBin, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 10_000 })).trim();
      if (done === "1") {
        return { deviceId: serial, name: avd, alreadyRunning: false, seconds: Math.round((Date.now() - started) / 1000), log: logFile };
      }
    }
    await sleep(3000);
  }
  throw new DeviceToolError(`The emulator "${avd}" did not finish booting within ${Math.round(timeoutMs / 1000)}s. Log: ${logFile}. ${tail()}`);
}

/** Boots an iOS simulator by UDID or by name, and waits until it is ready. */
export async function bootIos(target: string, ctx: DeviceCtx, opts: { timeoutMs?: number } = {}): Promise<BootResult> {
  const started = Date.now();
  const sims = (await listAvailable(ctx)).iosSimulators;
  const found = sims.find((s) => s.udid === target) ?? sims.find((s) => s.name === target);
  if (!found) {
    throw new DeviceToolError(`No simulator "${target}". Available: ${sims.map((s) => `${s.name} (${s.udid})`).join(", ") || "none"}.`);
  }
  const alreadyRunning = found.state === "Booted";
  if (!alreadyRunning) {
    const r = await ctx.exec("xcrun", ["simctl", "boot", found.udid], { timeout: 60_000 });
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) {
      throw new DeviceToolError(`simctl could not boot ${found.name}: ${r.stderr.trim().slice(-300)}`);
    }
  }
  const status = await ctx.exec("xcrun", ["simctl", "bootstatus", found.udid, "-b"], { timeout: opts.timeoutMs ?? 240_000 });
  if (status.code !== 0) {
    throw new DeviceToolError(`${found.name} did not finish booting: ${status.stderr.trim().slice(-300)}`);
  }
  return { deviceId: found.udid, name: found.name, alreadyRunning, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Shuts an emulator or simulator down. A physical phone is never touched. */
export async function shutdownDevice(device: Device, ctx: DeviceCtx): Promise<void> {
  if (!device.virtual) throw new DeviceToolError(`${device.name} is a physical device: it cannot be shut down from here.`);
  const r =
    device.platform === "android"
      ? await ctx.exec(ctx.adbBin, ["-s", device.id, "emu", "kill"], { timeout: 30_000 })
      : await ctx.exec("xcrun", ["simctl", "shutdown", device.id], { timeout: 60_000 });
  if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) {
    throw new DeviceToolError(`Could not shut ${device.name} down: ${r.stderr.trim().slice(-300)}`);
  }
}

// ----------------------------------------------------------------- apps

export interface InstallResult {
  installed: true;
  /** Package name (Android) or bundle id (iOS) when it could be read. Use it as appId in flows. */
  appId: string | null;
  device: string;
}

/** The package name of an APK, from the Android build tools when available. */
async function apkPackage(apk: string, ctx: DeviceCtx): Promise<string | null> {
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library", "Android", "sdk");
  const tools = join(sdk, "build-tools");
  if (!existsSync(tools)) return null;
  for (const v of readdirSync(tools).sort().reverse()) {
    const aapt2 = join(tools, v, "aapt2");
    if (!existsSync(aapt2)) continue;
    const r = await ctx.exec(aapt2, ["dump", "packagename", apk], { timeout: 20_000 });
    const name = text(r).trim();
    if (r.code === 0 && /^[\w.]+$/.test(name)) return name;
  }
  return null;
}

async function thirdPartyPackages(serial: string, ctx: DeviceCtx): Promise<string[]> {
  const r = await ctx.exec(ctx.adbBin, ["-s", serial, "shell", "pm", "list", "packages", "-3"], { timeout: 30_000 });
  return text(r).split("\n").map((l) => l.trim().replace(/^package:/, "")).filter(Boolean).sort();
}

async function plistValue(plist: string, key: string, ctx: DeviceCtx): Promise<string | null> {
  const r = await ctx.exec("plutil", ["-extract", key, "raw", "-o", "-", plist], { timeout: 10_000 });
  const v = text(r).trim();
  return r.code === 0 && v ? v : null;
}

/** Finds the .app bundle in a directory, or inside Payload/ or a zip. */
async function locateApp(path: string, ctx: DeviceCtx): Promise<{ app: string; cleanup?: string }> {
  if (!existsSync(path)) throw new DeviceToolError(`File not found: ${path}`);
  if (statSync(path).isDirectory() && extname(path) === ".app") return { app: path };
  if (extname(path) === ".zip") {
    const dir = mkdtempSync(join(tmpdir(), "app-"));
    const r = await ctx.exec("unzip", ["-q", "-o", path, "-d", dir], { timeout: 120_000 });
    if (r.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new DeviceToolError(`Could not unzip ${basename(path)}: ${r.stderr.trim().slice(-200)}`);
    }
    const find = (d: string, depth = 0): string | null => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (name.endsWith(".app") && statSync(p).isDirectory()) return p;
        if (depth < 2 && statSync(p).isDirectory()) {
          const inner = find(p, depth + 1);
          if (inner) return inner;
        }
      }
      return null;
    };
    const app = find(dir);
    if (!app) {
      rmSync(dir, { recursive: true, force: true });
      throw new DeviceToolError("No .app bundle inside the zip. iOS needs a simulator build (.app), not an .ipa.");
    }
    return { app, cleanup: dir };
  }
  throw new DeviceToolError("For iOS give a .app folder or a zip of it. An .ipa cannot be installed on a simulator.");
}

/** Installs an app on the device: an .apk on Android, a .app (or zipped .app) on iOS. */
export async function installApp(
  device: Device,
  path: string,
  ctx: DeviceCtx,
  opts: { grantPermissions?: boolean } = {},
): Promise<InstallResult> {
  if (device.platform === "android") {
    if (!existsSync(path)) throw new DeviceToolError(`File not found: ${path}`);
    if (extname(path) !== ".apk") throw new DeviceToolError("Android installs an .apk file (not an .aab bundle).");
    const before = await thirdPartyPackages(device.id, ctx);
    const args = ["-s", device.id, "install", "-r", ...(opts.grantPermissions === false ? [] : ["-g"]), path];
    const r = await ctx.exec(ctx.adbBin, args, { timeout: 180_000 });
    const out = `${text(r)} ${r.stderr}`;
    if (r.code !== 0 || !/Success/.test(out)) {
      throw new DeviceToolError(`adb could not install ${basename(path)}: ${out.trim().slice(-400)}`);
    }
    let appId = await apkPackage(path, ctx);
    if (!appId) {
      const after = await thirdPartyPackages(device.id, ctx);
      appId = after.find((p) => !before.includes(p)) ?? null;
    }
    return { installed: true, appId, device: device.id };
  }

  const { app, cleanup } = await locateApp(path, ctx);
  try {
    const r = isPhysicalIos(device)
      ? await ctx.exec("xcrun", ["devicectl", "device", "install", "app", "--device", device.id, app], { timeout: 300_000 })
      : await ctx.exec("xcrun", ["simctl", "install", device.id, app], { timeout: 180_000 });
    if (r.code !== 0) throw new DeviceToolError(`Could not install ${basename(app)}: ${(r.stderr || text(r)).trim().slice(-400)}`);
    return { installed: true, appId: await plistValue(join(app, "Info.plist"), "CFBundleIdentifier", ctx), device: device.id };
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

export interface InstalledApp {
  appId: string;
  name?: string;
}

/** Apps the user installed (not the system ones). Use the id as appId in a flow. */
export async function listApps(device: Device, ctx: DeviceCtx): Promise<InstalledApp[]> {
  if (device.platform === "android") {
    return (await thirdPartyPackages(device.id, ctx)).map((appId) => ({ appId }));
  }
  if (isPhysicalIos(device)) {
    throw new DeviceToolError("Listing apps on a physical iPhone is not supported. Use the bundle id of the app instead.");
  }
  const r = await ctx.exec("xcrun", ["simctl", "listapps", device.id], { timeout: 60_000 });
  const json = await ctx.exec("plutil", ["-convert", "json", "-o", "-", "-"], { input: text(r), timeout: 20_000 });
  const apps = JSON.parse(text(json)) as Record<string, { CFBundleIdentifier?: string; CFBundleDisplayName?: string; CFBundleName?: string; ApplicationType?: string }>;
  return Object.values(apps)
    .filter((a) => a.ApplicationType === "User" && a.CFBundleIdentifier)
    .map((a) => ({ appId: a.CFBundleIdentifier!, name: a.CFBundleDisplayName ?? a.CFBundleName }));
}
