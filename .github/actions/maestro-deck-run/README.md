# Maestro Deck parallel run (GitHub Action)

Runs Maestro flows on the devices booted in the current job, sequentially or in
parallel, and publishes a per-flow summary in the job summary and in
`summary.json`. Parallelism across machines comes from a **matrix**: each job
boots one device and takes its shard of the flows.

## Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `flows` | yes | | YAML files or directories, comma-separated |
| `mode` | no | `sequential` | `sequential`, `android_same_model`, `android_different_models`, `ios_same_model`, `ios_different_models`, `ios_android` |
| `shard-index` | no | `0` | 0-based index of this job in the matrix |
| `shard-count` | no | `1` | number of matrix jobs sharing the flows |
| `output` | no | `maestro-deck-results` | folder for `summary.json`, `summary.md`, per-job artifacts |
| `maestro-version` | no | `2.10.0` | Maestro CLI version |

## Outputs

- `success`: `true` when every flow passed.
- `summary-path`: path of `summary.json`.

Exit codes of the underlying CLI: `0` all passed, `1` a flow failed, `2` the run
could not start (no usable device for the mode, bad input).

## Example: two Android emulators, flows split in two

The emulator must be running while the action's steps run. Boot it with
`reactivecircus/android-emulator-runner` and call the CLI from its `script`:

```yaml
jobs:
  android:
    strategy:
      matrix:
        shard: [0, 1]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - name: Build CLI
        working-directory: mcp
        run: npm ci && npm run build
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 35
          target: google_apis
          arch: x86_64
          script: |
            curl -fsSL "https://get.maestro.mobile.dev" | bash
            export PATH="$HOME/.maestro/bin:$PATH"
            node mcp/dist/cli.js --flows flows/ \
              --mode sequential \
              --shard-index ${{ matrix.shard }} --shard-count 2 \
              --output results-${{ matrix.shard }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: android-${{ matrix.shard }}
          path: results-${{ matrix.shard }}
```

## Example: iOS simulator and Android emulator in separate matrix legs

iOS runs on a macOS runner, where the simulator is booted with `xcrun simctl`.
The per-OS results are then merged by a final job that reads each `summary.json`.

```yaml
jobs:
  ios:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - name: Boot simulator
        run: |
          UDID=$(xcrun simctl list devices available -j | python3 -c "import json,sys; d=json.load(sys.stdin)['devices']; print([x['udid'] for r in d.values() for x in r if 'iPhone' in x['name']][0])")
          xcrun simctl boot "$UDID" || true
      - uses: ./.github/actions/maestro-deck-run
        with:
          flows: flows/
          mode: sequential
          output: results-ios
```

## Limits

- Parallel modes inside one job only see the devices booted in that job. Use the
  matrix to get more devices.
- A physical phone is not available in a hosted runner: the iOS and Android
  physical modes need a self-hosted runner with the device attached.
- The action does not start emulators or simulators itself; the workflow does.
