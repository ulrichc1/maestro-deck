import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSteps } from "./adhoc.js";
import {
  bootAndroid,
  bootIos,
  DeviceToolError,
  fitImage,
  installApp,
  listApps,
  listAvailable,
  readHierarchy,
  shutdownDevice,
  takeScreenshot,
} from "./devicetools.js";
import { buildFlow, describeFlow, editFlow, FlowError, parseStepsInput, stepLine, stepSource, stepsOf, type EditOp } from "./flowfile.js";
import { resolveWritableFlow, writeFlowFile } from "./fsguard.js";
import { discoverDevices } from "./maestro.js";
import { DEFAULT_MAX_IMAGE, fail, image, claimDevice, resolveDevice, text, type FullDeps } from "./tools-common.js";
import { screenSize, suggestSelectors, visibleNodes, labelsOf } from "./ui.js";

const execFileAsync = promisify(execFile);

const stepSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const stepsSchema = z.array(stepSchema).describe('Maestro steps: "launchApp", {"tapOn": "Login"}, {"inputText": "me@x.com"} ...');

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Checks a flow with Maestro's own parser. Returns an error text, or null when valid or when Maestro is unavailable. */
async function maestroSyntaxError(deps: FullDeps, content: string): Promise<string | null> {
  const dir = join(deps.runs.homeDir, "tmp");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `check-${randomUUID()}.yaml`);
  writeFileSync(file, content);
  try {
    await execFileAsync(deps.bin, ["check-syntax", file], { timeout: 60_000 });
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") return null; // No Maestro to ask: the structure was still checked.
    return (e.stderr || e.stdout || e.message).trim().slice(0, 1000);
  } finally {
    rmSync(file, { force: true });
  }
}

function savedFlow(deps: FullDeps, abs: string, content: string, verb: string) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFlowFile(abs, content);
  const info = describeFlow(content);
  return { path: abs, result: verb, appId: info.appId ?? info.url, name: info.name, tags: info.tags, steps: info.stepCount };
}

export function registerAuthoringTools(server: McpServer, deps: FullDeps): void {
  // ------------------------------------------------------------------ flows

  server.registerTool(
    "describe_flow",
    {
      description: "Read a flow as a list of numbered steps (from 0) with their line in the file. Use the numbers with edit_flow.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const abs = resolve(path);
      if (!existsSync(abs)) return fail(`Flow not found: ${abs}`);
      const content = readFileSync(abs, "utf8");
      try {
        const info = describeFlow(content);
        const steps = stepsOf(content).map((_, i) => ({ index: i, line: stepLine(content, i), yaml: stepSource(content, i) }));
        return text({ path: abs, appId: info.appId ?? info.url, name: info.name, tags: info.tags, env: info.env, steps });
      } catch (err) {
        return fail(`${abs} is not a valid flow: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    "write_flow",
    {
      description:
        "Create a Maestro flow file from a header and steps (or from raw YAML). The flow is checked with Maestro before anything is written, and an existing file is never replaced unless overwrite is true. Writing is limited to the project folder (MAESTRO_DECK_FLOWS_DIRS).",
      inputSchema: {
        path: z.string().describe("Where to write, ending in .yaml"),
        appId: z.string().optional().describe("Package name (Android) or bundle id (iOS). Required with steps"),
        steps: stepsSchema.optional(),
        name: z.string().optional(),
        tags: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        content: z.string().optional().describe("Raw flow YAML instead of appId and steps"),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ path, appId, steps, name, tags, env, content, overwrite }) => {
      try {
        const abs = resolveWritableFlow(path, deps.flowRoots);
        if (existsSync(abs) && !overwrite) return fail(`${abs} already exists. Pass overwrite=true to replace it, or use edit_flow to change it.`);
        let yaml: string;
        if (content !== undefined) {
          yaml = content.endsWith("\n") ? content : `${content}\n`;
          describeFlow(yaml);
        } else {
          if (!steps) return fail("Give steps (with appId), or content.");
          yaml = buildFlow({ appId, name, tags, env, steps });
        }
        const bad = await maestroSyntaxError(deps, yaml);
        if (bad) return fail(`Maestro rejected the flow, nothing was written:\n${bad}`);
        return text({ ...savedFlow(deps, abs, yaml, existsSync(abs) ? "overwritten" : "created"), syntax: "valid" });
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "edit_flow",
    {
      description:
        "Change an existing flow while keeping its comments: insert steps, replace or delete a step, or change the header. Steps are numbered from 0 (see describe_flow). The result is checked with Maestro before it is written; dryRun shows the result without writing.",
      inputSchema: {
        path: z.string(),
        operation: z.enum(["insert_steps", "replace_step", "delete_steps", "set_header"]),
        at: z.number().int().optional().describe("insert_steps: position to insert at; -1 or the step count appends"),
        index: z.number().int().optional().describe("replace_step, delete_steps: the step number"),
        count: z.number().int().optional().describe("delete_steps: how many steps, default 1"),
        steps: stepsSchema.optional().describe("insert_steps: the steps to insert"),
        step: stepSchema.optional().describe("replace_step: the new step"),
        appId: z.string().optional(),
        name: z.string().optional(),
        tags: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        dryRun: z.boolean().default(false),
      },
    },
    async (a) => {
      try {
        const abs = resolveWritableFlow(a.path, deps.flowRoots);
        if (!existsSync(abs)) return fail(`Flow not found: ${abs}. Use write_flow to create it.`);
        const before = readFileSync(abs, "utf8");
        let op: EditOp;
        switch (a.operation) {
          case "insert_steps":
            if (!a.steps) return fail("insert_steps needs steps.");
            op = { op: "insert_steps", at: a.at ?? -1, steps: a.steps };
            break;
          case "replace_step":
            if (a.index === undefined || a.step === undefined) return fail("replace_step needs index and step.");
            op = { op: "replace_step", index: a.index, step: a.step };
            break;
          case "delete_steps":
            if (a.index === undefined) return fail("delete_steps needs index.");
            op = { op: "delete_steps", index: a.index, count: a.count };
            break;
          case "set_header":
            op = { op: "set_header", appId: a.appId, name: a.name, tags: a.tags, env: a.env };
            break;
        }
        const { content, summary } = editFlow(before, op);
        describeFlow(content);
        const bad = await maestroSyntaxError(deps, content);
        if (bad) return fail(`Maestro rejected the edited flow, the file is unchanged:\n${bad}`);
        const steps = stepsOf(content).map((_, i) => stepSource(content, i));
        if (a.dryRun) return text({ path: abs, dryRun: true, summary, steps, content });
        writeFlowFile(abs, content);
        return text({ path: abs, summary, steps, syntax: "valid" });
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  // ---------------------------------------------------------------- devices

  server.registerTool(
    "list_available_devices",
    {
      description: "Emulators (AVDs) and iOS simulators that exist on this machine, whether running or not. Start one with boot_device.",
    },
    async () => {
      const [avail, running] = await Promise.all([listAvailable(deps.ctx), discoverDevices(deps.adbBin)]);
      const runningModels = new Set(running.filter((d) => d.platform === "android" && d.virtual && d.usable).map((d) => d.model));
      return text({
        androidEmulators: avail.androidEmulators.map((e) => ({ ...e, running: runningModels.has(e.name) })),
        iosSimulators: avail.iosSimulators,
      });
    },
  );

  server.registerTool(
    "boot_device",
    {
      description:
        "Start an Android emulator (by AVD name) or an iOS simulator (by name or UDID) and wait until it is ready. Returns the deviceId to use with the other tools. A started emulator keeps running after the server stops: shut it down with shutdown_device.",
      inputSchema: {
        kind: z.enum(["android_emulator", "ios_simulator"]),
        name: z.string().describe("AVD name, or simulator name / UDID (see list_available_devices)"),
        headless: z.boolean().default(true).describe("Android only: no emulator window"),
        readOnly: z.boolean().default(false).describe("Android only: allow a second instance of an AVD that is already running"),
        timeoutSeconds: z.number().int().min(30).max(900).default(240),
      },
    },
    async ({ kind, name, headless, readOnly, timeoutSeconds }) => {
      try {
        const timeoutMs = timeoutSeconds * 1000;
        const result =
          kind === "android_emulator"
            ? await bootAndroid(name, deps.ctx, { headless, readOnly, timeoutMs })
            : await bootIos(name, deps.ctx, { timeoutMs });
        const device = (await discoverDevices(deps.adbBin)).find((d) => d.id === result.deviceId);
        return text({ ...result, usable: device?.usable ?? false, state: device?.state });
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "shutdown_device",
    {
      description: "Shut an emulator or simulator down. A physical phone is refused. Refused while a run uses the device.",
      inputSchema: { deviceId: z.string() },
    },
    async ({ deviceId }) => {
      try {
        const device = await resolveDevice(deps, deviceId);
        const release = claimDevice(deps, device, "shutdown_device");
        try {
          await shutdownDevice(device, deps.ctx);
        } finally {
          release();
        }
        return text({ shutDown: device.id, name: device.name });
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "install_app",
    {
      description:
        "Install an app on a device: an .apk on Android, a .app folder (or a zip of it) on iOS. Returns the appId (package or bundle id) to put in flows.",
      inputSchema: {
        path: z.string(),
        deviceId: z.string().optional().describe("Optional when only one device is usable"),
        grantPermissions: z.boolean().default(true).describe("Android only: grant every runtime permission"),
      },
    },
    async ({ path, deviceId, grantPermissions }) => {
      try {
        const device = await resolveDevice(deps, deviceId);
        return text(await installApp(device, resolve(path), deps.ctx, { grantPermissions }));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "list_apps",
    {
      description: "Apps installed on a device by the user (not system apps). The ids are valid appId values for flows.",
      inputSchema: { deviceId: z.string().optional() },
    },
    async ({ deviceId }) => {
      try {
        const device = await resolveDevice(deps, deviceId);
        return text(await listApps(device, deps.ctx));
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  // ------------------------------------------------------------ the screen

  server.registerTool(
    "take_screenshot",
    {
      description: "See what the device shows now: returns the screen as an image.",
      inputSchema: {
        deviceId: z.string().optional().describe("Optional when only one device is usable"),
        maxSize: z.number().int().min(0).max(4000).default(DEFAULT_MAX_IMAGE).describe("Longest side in pixels; 0 keeps the full size"),
      },
    },
    async ({ deviceId, maxSize }) => {
      try {
        const device = await resolveDevice(deps, deviceId);
        const physicalIos = device.platform === "ios" && !device.virtual;
        const release = physicalIos ? claimDevice(deps, device, "take_screenshot") : () => {};
        try {
          const png = await fitImage(await takeScreenshot(device, deps.ctx), maxSize, deps.ctx);
          return { content: [{ type: "text" as const, text: `${device.name} (${device.id})` }, image(png)] };
        } finally {
          release();
        }
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "get_view_hierarchy",
    {
      description:
        "Read the elements on the device screen: text, id, accessibility labels, bounds, state. Only elements with something to read are returned unless includeHidden is set. To pick a selector for a step, prefer find_selectors.",
      inputSchema: {
        deviceId: z.string().optional(),
        maxElements: z.number().int().min(1).max(500).default(150),
        includeHidden: z.boolean().default(false),
      },
    },
    async ({ deviceId, maxElements, includeHidden }) => {
      try {
        const device = await resolveDevice(deps, deviceId);
        const release = claimDevice(deps, device, "get_view_hierarchy");
        try {
          const nodes = await readHierarchy(device, deps.ctx);
          const shown = (includeHidden ? nodes : visibleNodes(nodes)).slice(0, maxElements);
          return text({
            device: device.id,
            screen: screenSize(nodes),
            totalElements: nodes.length,
            returned: shown.length,
            elements: shown.map((n) => ({
              labels: labelsOf(n),
              id: n.resourceId || undefined,
              class: n.className || undefined,
              bounds: n.bounds ? `[${n.bounds.x1},${n.bounds.y1}][${n.bounds.x2},${n.bounds.y2}]` : undefined,
              enabled: n.enabled,
              focused: n.focused || undefined,
              selected: n.selected || undefined,
              checked: n.checked || undefined,
              clickable: n.clickable ?? undefined,
            })),
          });
        } finally {
          release();
        }
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "find_selectors",
    {
      description:
        "Find the right selector for an element on the current screen. Give a query (part of its text, id or label) and get ready-to-use steps, best first: a unique id, a unique text, an index among identical elements, or a screen position as a last resort. Text is escaped because Maestro matches it as a regular expression.",
      inputSchema: {
        query: z.string().optional().describe("Part of the text, id or accessibility label. Omit to list the screen's elements"),
        deviceId: z.string().optional(),
        interactiveOnly: z.boolean().default(false).describe("Only elements the screen says can be tapped or typed into"),
        limit: z.number().int().min(1).max(50).default(15),
        includeScreenshot: z.boolean().default(false),
      },
    },
    async ({ query, deviceId, interactiveOnly, limit, includeScreenshot }) => {
      try {
        const device = await resolveDevice(deps, deviceId);
        const release = claimDevice(deps, device, "find_selectors");
        try {
          const nodes = await readHierarchy(device, deps.ctx);
          const candidates = suggestSelectors(nodes, { query, interactiveOnly, limit });
          const body = {
            device: device.id,
            screen: screenSize(nodes),
            query: query ?? null,
            count: candidates.length,
            candidates,
            note: candidates.length === 0 && query ? "Nothing on screen contains that. Try a shorter query, or call without a query to list what is there." : undefined,
          };
          if (!includeScreenshot) return text(body);
          const png = await fitImage(await takeScreenshot(device, deps.ctx), DEFAULT_MAX_IMAGE, deps.ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }, image(png)] };
        } finally {
          release();
        }
      } catch (err) {
        return fail(message(err));
      }
    },
  );

  server.registerTool(
    "run_steps",
    {
      description:
        "Try a few steps on a device without saving any file. The steps run in a temporary flow that is deleted afterwards. Returns which step passed or failed, why, and a screenshot. Use it to check a selector or a sequence before write_flow.",
      inputSchema: {
        appId: z.string().describe("Package name (Android) or bundle id (iOS) of the app the steps act on"),
        steps: stepsSchema.optional(),
        yaml: z.string().optional().describe("The steps as a YAML list, instead of steps"),
        deviceId: z.string().optional(),
        timeoutSeconds: z.number().int().min(5).max(600).default(120),
        env: z.record(z.string(), z.string()).optional(),
        screenshot: z.boolean().default(true),
      },
    },
    async ({ appId, steps, yaml, deviceId, timeoutSeconds, env, screenshot }) => {
      try {
        let list: unknown[];
        let id = appId;
        if (steps) list = steps;
        else if (yaml) {
          const parsed = parseStepsInput(yaml);
          list = parsed.steps;
          id = parsed.appId ?? appId;
        } else return fail("Give steps or yaml.");
        if (list.length === 0) return fail("No step to run.");
        const device = await resolveDevice(deps, deviceId);
        const release = claimDevice(deps, device, "run_steps");
        try {
          const result = await runSteps({
            device, appId: id, steps: list, maestroBin: deps.bin, workDir: join(deps.runs.homeDir, "tmp"),
            timeoutMs: timeoutSeconds * 1000, ctx: deps.ctx, env,
          });
          const { screenshot: png, ...rest } = result;
          const content: ({ type: "text"; text: string } | ReturnType<typeof image>)[] = [
            { type: "text", text: JSON.stringify({ device: device.id, ...rest }, null, 2) },
          ];
          if (screenshot && png) content.push(image(await fitImage(png, DEFAULT_MAX_IMAGE, deps.ctx)));
          return { content, isError: result.status === "error" || undefined };
        } finally {
          release();
        }
      } catch (err) {
        return fail(err instanceof FlowError || err instanceof DeviceToolError ? err.message : message(err));
      }
    },
  );
}
