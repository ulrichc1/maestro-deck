# Maestro Deck MCP server and runner

Two entry points share one engine:

- `maestro-deck-mcp`: an MCP server (stdio) so Claude Code and Codex can run Maestro flows on
  local devices, in parallel, and on the Maestro Deck cloud.
- `maestro-deck-run`: the same engine as a command line, used by the GitHub Action.

## Install

Requirements: Node 22 or newer, the [Maestro CLI](https://maestro.mobile.dev) (found through
`MAESTRO_BIN`, `~/.maestro/bin/maestro`, or the `PATH`), and `adb` for Android (found through
`ADB_BIN`, `ANDROID_HOME`, the default Android Studio SDK, or the `PATH`). iOS needs Xcode.

```bash
cd mcp
npm ci
npm run build
```

### Claude Code

```bash
claude mcp add maestro-deck -- node /absolute/path/to/maestro-deck/mcp/dist/index.js
```

Or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "maestro-deck": {
      "command": "node",
      "args": ["/absolute/path/to/maestro-deck/mcp/dist/index.js"]
    }
  }
}
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.maestro-deck]
command = "node"
args = ["/absolute/path/to/maestro-deck/mcp/dist/index.js"]
```

Check the setup by asking the agent to call `doctor`: it reports the Maestro version, the
devices found, and whether a cloud token is configured.

### Environment

| Variable | Meaning |
|---|---|
| `MAESTRO_BIN` | Path of the Maestro CLI |
| `ADB_BIN` | Path of adb |
| `MAESTRO_DECK_MCP_HOME` | Where runs are stored. Default `~/.maestro-deck-mcp` |
| `MAESTRO_DECK_FLOWS_DIRS` | Extra folders flows may be written to (default: the start folder only) |
| `EMULATOR_BIN` | Path of the Android emulator binary, if not found automatically |
| `MAESTRO_DECK_CLOUD_TOKEN` | Account token for the cloud tools. Never printed |

## Working without the UI

The server covers the whole loop an engineer does in the desktop app: get a device, install the
app, look at the screen, find selectors, try steps, save a flow, run it, understand a failure.

```text
list_available_devices -> boot_device -> install_app (returns the appId)
   -> take_screenshot / get_view_hierarchy -> find_selectors "Sign in"
   -> run_steps (try them, nothing is saved) -> write_flow / edit_flow
   -> run_flows -> explain_failure -> edit_flow -> rerun_failed -> compare_runs
```

Three prompts walk an agent through it: `author_flow`, `debug_failure`, `run_suite_everywhere`.

## Tools

**Devices and apps**

| Tool | What it does |
|---|---|
| `doctor` | Maestro version, adb, usable devices, cloud token present |
| `list_devices` | Android devices/emulators (adb) and iOS simulators/phones (devicectl), with state |
| `list_available_devices` | Emulators (AVDs) and simulators that exist here, running or not |
| `boot_device` | Start an Android emulator (by AVD name) or an iOS simulator (by name or UDID) and wait until ready |
| `shutdown_device` | Stop an emulator or simulator. A physical phone is refused |
| `install_app` | Install an `.apk`, or a `.app` (or zipped `.app`) on iOS. Returns the `appId` |
| `list_apps` | Apps the user installed, with the ids to use as `appId` |

**The screen**

| Tool | What it does |
|---|---|
| `take_screenshot` | The device screen as an image, shrunk to 1600 px by default (`maxSize`) |
| `get_view_hierarchy` | The elements on screen: text, id, labels, bounds, state |
| `find_selectors` | Ready-to-use steps for an element, best first: unique id, unique text, index, position |
| `run_steps` | Try steps in a temporary flow that is deleted afterwards. Per-step result, the reason, a screenshot |

**Flows**

| Tool | What it does |
|---|---|
| `list_flows`, `describe_flow`, `read_flow` | Find flows (appId, tags, step count), read them as numbered steps with their line |
| `write_flow` | Create a flow from a header and steps. Checked with Maestro first; never overwrites unless asked |
| `edit_flow` | Insert, replace or delete steps, or change the header, keeping comments. `dryRun` previews |
| `delete_flow` | Delete a flow file. Shows what would go unless `confirm: true`; refuses symlinks and flows a run is using |
| `check_flow_syntax` | Validate flows without a device |

**Runs and failures**

| Tool | What it does |
|---|---|
| `check_parallel_feasibility` | Whether a mode can run on the devices connected now |
| `run_flows` | Run flows. Modes below. Pin devices (`deviceIds`), filter by `includeTags` / `excludeTags`, pass `env`, `waitSeconds` waits for the verdict |
| `wait_for_run`, `get_run_status`, `get_run_results`, `get_run_report` | Follow a run, read per-job results and JUnit reports |
| `explain_failure` | Why a job failed: the step and its line, the error, what was on screen, similar text, the screenshot, log errors, what to try |
| `read_artifact` | Read a screenshot or log a job left behind, limited to the run folder |
| `rerun_failed`, `compare_runs` | Run again only what failed; list regressions and fixes between two runs |
| `cancel_run`, `list_runs` | Stop a run; runs of this and earlier sessions (a run left mid-flight is `interrupted`) |

**CI and cloud**

| Tool | What it does |
|---|---|
| `generate_github_workflow` | YAML for a parallel Android or iOS matrix on GitHub Actions |
| `cloud_run_flows`, `cloud_get_jobs` | Run on the Maestro Deck cloud and read job status |

### Safety

- `write_flow`, `edit_flow` and `delete_flow` only touch files inside the folder the server was started in, plus any
  folders listed in `MAESTRO_DECK_FLOWS_DIRS` (separated like `PATH`). Paths that escape it, even
  through a symlink, are refused, and only `.yaml` / `.yml` files are written or deleted.
- A flow is validated, structurally and by Maestro, before anything is written or changed.
- Only one operation at a time drives a device: while a run uses it, `run_steps`,
  `get_view_hierarchy` and `find_selectors` say it is busy instead of fighting over the driver.
- `read_artifact` cannot read outside the run's folder.

### Modes

`sequential`, `android_same_model`, `android_different_models`, `ios_same_model`,
`ios_different_models`, `ios_android`. Flows are split one per job and pulled from a shared queue
by each free device. In `ios_android` every flow runs on both platforms.

"Same model" compares the hardware model: the AVD name for an emulator, the product type for an
iPhone (a phone named "IphoneU" and a simulator named "Mate" are the same model if both are
iPhone16,2).

## Reliability

- **Time limit**: every job has one (`timeoutSeconds`, default 600). A job past it is stopped and
  reported as `timeout`.
- **Clean stop**: stopping a job (time limit, `cancel_run`, Ctrl+C, closing the MCP client) sends
  SIGTERM to the whole process group, then SIGKILL after 5 seconds. No Maestro JVM is left behind.
  Closing the MCP client mid-run stops every job before the server exits.
- **Retries**: an infrastructure failure (device lost, driver crash, timeout) is retried on another
  device, up to `retries` extra times (default 1). A flow that fails its assertions is not retried
  unless `retryFailed` is set. A flow syntax error is a flow failure, not a device problem.
- **Device quarantine**: a device with two infrastructure failures in a row is taken out of
  rotation for the rest of the run and listed in `retiredDevices`.

## Cloud and cost

Every accepted cloud job spends **one run** of the account once it starts, and cannot be cancelled.
`cloud_run_flows` therefore only returns the plan and `wouldSpendRuns` unless `confirmSpend` is
`true`. Once the cloud refuses a job (quota, expired token), no further job is submitted, and the
jobs already accepted are reported.

The cloud tools follow the API the desktop app uses. They were tested against a local fake of that
API, not against the real service.

## Command line

```bash
node dist/cli.js --flows flows/ --mode android_different_models \
  --job-timeout 300 --retries 1 --output results
```

Options: `--flows` (files or directories, comma separated), `--mode`, `--shard-index` and
`--shard-count` (split flows across matrix jobs), `--job-timeout` (seconds), `--retries`,
`--retry-failed`, `--output`. Exit code `0` all passed, `1` a flow failed or timed out, `2` the run
could not start. Ctrl+C or SIGTERM stops the running flows cleanly.

## Tests

```bash
npm test
```

Unit and end-to-end tests use a fake `adb` and a fake `maestro`, a real MCP client, and a fake
cloud API. They do not need a device.
