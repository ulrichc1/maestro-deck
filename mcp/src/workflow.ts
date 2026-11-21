export interface WorkflowOptions {
  /** Flow file or directory in the repository. */
  flows: string;
  platform: "android" | "ios";
  /** Number of matrix jobs (devices) the flows are split across. Default 2. */
  shards?: number;
  /** Seconds before a single job is killed. Default 600. */
  jobTimeoutSeconds?: number;
  /** Extra attempts after an infrastructure failure. Default 1. */
  retries?: number;
  workflowName?: string;
}

/**
 * Builds a GitHub Actions workflow that runs flows in parallel on a matrix.
 * Android boots an emulator per matrix job (reactivecircus/android-emulator-runner)
 * and runs the CLI from its script; iOS boots a simulator on a macOS runner and uses
 * the composite action. The workflow assumes the repository holds the Maestro Deck
 * `mcp/` package and the composite action, as in this project.
 */
export function generateWorkflow(opts: WorkflowOptions): string {
  const shards = Math.max(1, Math.floor(opts.shards ?? 2));
  const timeout = Math.max(1, Math.floor(opts.jobTimeoutSeconds ?? 600));
  const retries = Math.max(0, Math.floor(opts.retries ?? 1));
  const name = opts.workflowName ?? `Maestro Deck ${opts.platform}`;
  const matrix = Array.from({ length: shards }, (_, i) => i).join(", ");
  // Reject anything that could break out of the YAML or the shell.
  if (!/^[\w./-]+$/.test(opts.flows)) throw new Error("flows may only contain letters, digits, '.', '_', '-' and '/'.");
  if (!/^[\w .-]+$/.test(name)) throw new Error("workflowName may only contain letters, digits, spaces, '.', '_' and '-'.");

  const header = `name: ${name}

on:
  workflow_dispatch:
  pull_request:

permissions:
  contents: read

`;

  if (opts.platform === "ios") {
    return (
      header +
      `jobs:
  ios:
    runs-on: macos-15
    strategy:
      fail-fast: false
      matrix:
        shard: [${matrix}]
    steps:
      - uses: actions/checkout@v4
      - name: Boot an iPhone simulator
        run: |
          UDID=$(xcrun simctl list devices available -j | python3 -c "import json,sys; d=json.load(sys.stdin)['devices']; print([x['udid'] for r,v in d.items() if 'iOS' in r for x in v if x['name'].startswith('iPhone')][-1])")
          xcrun simctl boot "$UDID"
          xcrun simctl bootstatus "$UDID" -b
      - uses: ./.github/actions/maestro-deck-run
        with:
          flows: ${opts.flows}
          mode: sequential
          shard-index: \${{ matrix.shard }}
          shard-count: "${shards}"
          output: results-ios-\${{ matrix.shard }}
`
    );
  }

  return (
    header +
    `jobs:
  android:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [${matrix}]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Build the Maestro Deck CLI
        working-directory: mcp
        run: npm ci && npm run build
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=kvm
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 35
          target: google_apis
          arch: x86_64
          script: |
            curl -fsSL "https://get.maestro.mobile.dev" | bash
            export PATH="$HOME/.maestro/bin:$PATH"
            node mcp/dist/cli.js --flows ${opts.flows} --mode sequential --shard-index \${{ matrix.shard }} --shard-count ${shards} --job-timeout ${timeout} --retries ${retries} --output results-android-\${{ matrix.shard }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: android-\${{ matrix.shard }}
          path: results-android-\${{ matrix.shard }}
`
  );
}
