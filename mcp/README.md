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
| `MAESTRO_DECK_CLOUD_TOKEN` | Account token for the cloud tools. Never printed |

## Tools

| Tool | What it does |
|---|---|
| `doctor` | Maestro version, adb, usable devices, cloud token present |
| `list_devices` | Android devices/emulators (adb) and iOS simulators/phones (devicectl), with state |
| `check_parallel_feasibility` | Whether a mode can run on the devices connected now |
| `list_flows`, `read_flow`, `check_flow_syntax` | Find, read and validate flows without a device |
| `run_flows` | Run flows locally. Modes below. `waitSeconds` waits for the verdict |
| `wait_for_run`, `get_run_status`, `get_run_results`, `get_run_report` | Follow a run, read per-job results and JUnit reports |
| `cancel_run` | Stop a run: running jobs are killed, queued jobs cancelled |
| `list_runs` | Runs of this and earlier sessions. A run left mid-flight by a crash is `interrupted` |
| `generate_github_workflow` | YAML for a parallel Android or iOS matrix on GitHub Actions |
| `cloud_run_flows`, `cloud_get_jobs` | Run on the Maestro Deck cloud and read job status |

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
