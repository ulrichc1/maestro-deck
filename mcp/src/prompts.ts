import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const user = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

/** Ready-made instructions that walk an agent through the usual jobs, using the tools in the right order. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "author_flow",
    {
      title: "Write a Maestro flow",
      description: "Build a working flow for an app by looking at the real screen, trying steps, then saving.",
      argsSchema: {
        goal: z.string().describe("What the flow must do, e.g. 'sign in with a valid account and see the home screen'"),
        app: z.string().optional().describe("Path of the .apk / .app, or the appId if already installed"),
        path: z.string().optional().describe("Where to save the flow"),
      },
    },
    ({ goal, app, path }) =>
      user(
        `Write a Maestro flow that does this: ${goal}\n\n` +
          `Work like this, and do not guess selectors:\n` +
          `1. list_devices. If none is usable, list_available_devices then boot_device.\n` +
          `2. ${app ? `install_app for ${app} if it is a file, otherwise use ${app} as the appId.` : "list_apps to find the appId of the app, or ask me."}\n` +
          `3. run_steps with launchApp, then take_screenshot to see where you are.\n` +
          `4. For each step you need: find_selectors with part of the visible text, take the best selector, and check it with run_steps before moving on. Keep the sequence that worked.\n` +
          `5. Finish with an assertVisible that proves the goal was reached.\n` +
          `6. write_flow${path ? ` to ${path}` : ""} with the steps that passed, then run_flows to confirm it passes on its own.\n` +
          `If a step fails, call explain_failure on the run or read the error from run_steps before changing anything.`,
      ),
  );

  server.registerPrompt(
    "debug_failure",
    {
      title: "Find why a test failed",
      description: "Explain a failed run, decide whether it is the app, the flow or the device, and fix the flow if needed.",
      argsSchema: { runId: z.string().describe("The run to investigate") },
    },
    ({ runId }) =>
      user(
        `Run ${runId} did not pass. Find out why.\n\n` +
          `1. explain_failure for the run: read the failed step, the error, the screenshot and what was on screen.\n` +
          `2. Decide which it is:\n` +
          `   - a device or driver problem (status "error", device lost, timeout): rerun_failed once; if it keeps failing on one device, check list_devices.\n` +
          `   - the flow is wrong (selector not found, text changed, wrong appId): use find_selectors on the current screen, fix the step with edit_flow, check it with run_steps.\n` +
          `   - the app is wrong (the screen shows a real error or a crash): report it with the screenshot instead of changing the flow.\n` +
          `3. After a fix, rerun_failed and confirm with compare_runs that the failure is gone and nothing else broke.\n` +
          `Say plainly which of the three it was and what you changed.`,
      ),
  );

  server.registerPrompt(
    "run_suite_everywhere",
    {
      title: "Run flows on several devices",
      description: "Run a folder of flows in parallel on the devices available, and summarize.",
      argsSchema: { directory: z.string().describe("Folder containing the flows") },
    },
    ({ directory }) =>
      user(
        `Run the flows in ${directory} on as many devices as are available.\n\n` +
          `1. list_flows for the folder, and list_devices.\n` +
          `2. check_parallel_feasibility for the best mode: android_different_models or ios_different_models if you have several models, ` +
          `android_same_model / ios_same_model for identical devices, ios_android to check both platforms.\n` +
          `3. run_flows with that mode and waitSeconds so you get the verdict.\n` +
          `4. Summarize per platform and device. For each failure call explain_failure and say whether it is the app, the flow or the device.`,
      ),
  );
}
