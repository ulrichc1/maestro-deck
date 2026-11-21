import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, resolveFlows } from "../src/server.js";
import { RunManager } from "../src/runs.js";

describe("MCP server", () => {
  it("exposes the lot 3 tools over the MCP protocol", async () => {
    const server = createServer({ bin: "maestro-does-not-exist", adbBin: "adb-does-not-exist", runs: new RunManager(mkdtempSync(join(tmpdir(), "home-"))), cloud: { token: undefined } });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "boot_device", "cancel_run", "check_flow_syntax", "check_parallel_feasibility", "cloud_get_jobs", "cloud_run_flows",
      "compare_runs", "describe_flow", "doctor", "edit_flow", "explain_failure", "find_selectors",
      "generate_github_workflow", "get_run_report", "get_run_results", "get_run_status", "get_view_hierarchy",
      "install_app", "list_apps", "list_available_devices", "list_devices", "list_flows", "list_runs", "read_artifact",
      "read_flow", "rerun_failed", "run_flows", "run_steps", "shutdown_device", "take_screenshot", "wait_for_run", "write_flow",
    ]);
    const feasibility = await client.callTool({ name: "check_parallel_feasibility", arguments: { mode: "ios_android" } });
    expect(feasibility.isError).not.toBe(true);
    const status = await client.callTool({ name: "get_run_status", arguments: { runId: "nope" } });
    expect(status.isError).toBe(true);
    await client.close();
  });

  it("resolveFlows rejects missing files and non-YAML files", () => {
    const dir = mkdtempSync(join(tmpdir(), "flows-"));
    const yaml = join(dir, "login.yaml");
    const txt = join(dir, "notes.txt");
    writeFileSync(yaml, "appId: x\n");
    writeFileSync(txt, "x");
    expect(resolveFlows([yaml], "/")).toEqual({ ok: [yaml] });
    expect(resolveFlows([txt], "/")).toHaveProperty("error");
    expect(resolveFlows([join(dir, "missing.yaml")], "/")).toHaveProperty("error");
    expect(resolveFlows([], "/")).toHaveProperty("error");
  });
});
