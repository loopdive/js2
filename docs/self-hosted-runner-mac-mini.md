# Self-hosted runner: Mac mini (M4, 24 GB)

This runbook sets up a Mac mini at home as a self-hosted GitHub Actions runner
host for the `test262-shard` matrix in `.github/workflows/test262-sharded.yml`.
Trusted PRs (from collaborators on `loopdive/js2wasm`) route to the Mac mini;
fork PRs continue to use `ubuntu-latest`.

> No workflow changes have been made yet. This runbook is the host-side plan —
> review and adjust before we touch the YAML.

## Sizing (M4, 10 cores, 24 GB RAM)

| Resource | Budget |
|---|---|
| macOS + Docker Desktop overhead | ~6 GB |
| 4 runner containers @ ~4 GB peak each | ~16 GB |
| Safety margin | ~2 GB |
| **Parallel runners** | **4** |

Each test262 shard's measured peak is ~4 GB (see `CLAUDE.md`, memory budget).
The base M4 has 4 performance + 6 efficiency cores, so each runner gets ~2.5
cores — plenty for shard work which uses `TEST262_WORKERS=3` internally.

If you upgrade RAM later: 32 GB → 6 runners; 48 GB → 9; 64 GB → 12+.

## What the runner host trusts

- **Trusted code**: any commit reachable from a PR opened by a `loopdive/js2wasm`
  collaborator, plus pushes to `main`.
- **Untrusted code**: fork PRs. These keep using `ubuntu-latest` via the
  workflow's `runs-on` gate. They never run on your Mac mini.
- **Trust boundary** = the existing collaborator list. A compromised
  collaborator account could execute arbitrary code inside a container on your
  Mac mini. Mitigations:
  - Ephemeral containers (one job, then destroyed) — no state leaks between
    jobs.
  - No `--privileged`, no host network, no host volume mounts.
  - Docker Desktop's Linux VM is itself a sandbox between containers and macOS.
  - Don't pass `secrets:` into self-hosted jobs unless needed. Today the shard
    matrix only uses `GITHUB_TOKEN`, which is scoped per-run.

## One-time setup

### 1. Docker Desktop

1. Install Docker Desktop for Apple Silicon.
2. Settings → Resources:
   - **Memory: 20 GB** (leaves ~4 GB for macOS)
   - **CPUs: 10** (all cores; the OS still preempts)
   - **Swap: 4 GB**
   - **Disk image size: 100 GB** (pnpm + node_modules + caches per container)
3. Settings → General: **Start Docker Desktop when you log in** = on.
4. Pull the runner image once to warm cache:
   ```sh
   docker pull --platform linux/arm64 myoung34/github-runner:latest
   ```

### 2. Allow self-hosted runners at the org

Go to https://github.com/organizations/loopdive/settings/actions and ensure
self-hosted runners are not blocked. Recommended policy:

- **Runner groups** → create a group `mac-mini` that is restricted to
  `loopdive/js2wasm` only. (Prevents other repos in the org from accidentally
  scheduling onto your hardware.)
- **Workflow permissions** for the repo stay as-is.

### 3. Mint a runner registration PAT

The runner image needs a token to register itself. Two options:

- **Short-lived registration token** (UI: org settings → Actions → Runners →
  New runner). Expires in 1 hour. Painful for ephemeral runners that keep
  re-registering.
- **Fine-grained PAT** (recommended). Generate at
  https://github.com/settings/personal-access-tokens with:
  - **Resource owner**: `loopdive`
  - **Repository access**: only `loopdive/js2wasm`
  - **Organization permissions**: `Self-hosted runners: Read and write`
  - **Expiration**: 90 days (rotate via calendar reminder)

The image (`myoung34/github-runner`) will use this PAT to fetch a fresh
registration token before each container start.

Save the token to `~/.github-runner-token` and lock it down:

```sh
chmod 600 ~/.github-runner-token
```

### 4. Wrapper script

`docker run --rm` gives true ephemerality (image layer reused, writable layer
destroyed after each job). A wrapper loop restarts the container after each
job so the slot stays filled.

Create `/usr/local/bin/js2wasm-runner-slot.sh`:

```sh
#!/bin/bash
set -u
TOKEN_FILE="$HOME/.github-runner-token"

while true; do
  docker run --rm \
    --platform linux/arm64 \
    --memory 5g \
    --memory-swap 6g \
    --cpus 3 \
    -e ACCESS_TOKEN="$(cat "$TOKEN_FILE")" \
    -e RUNNER_SCOPE=org \
    -e ORG_NAME=loopdive \
    -e RUNNER_GROUP=mac-mini \
    -e LABELS=self-hosted,linux,arm64,mac-mini \
    -e EPHEMERAL=true \
    -e DISABLE_AUTO_UPDATE=true \
    -e RUNNER_WORKDIR=/tmp/runner/_work \
    myoung34/github-runner:latest \
    || true

  # Pause briefly if docker run fails (token expired, network blip, etc.)
  # so launchd doesn't see a fast restart loop.
  sleep 5
done
```

Make it executable: `chmod +x /usr/local/bin/js2wasm-runner-slot.sh`.

Notes:

- `--memory 5g` caps each container to 5 GB resident (≈4 GB shard peak + 1 GB
  Node overhead). `--memory-swap 6g` gives 1 GB of swap headroom.
- `--cpus 3` caps each container; with 4 runners that's 12 cpu-shares against
  the M4's 10 cores — Linux scheduler oversubscribes fine.
- `RUNNER_WORKDIR=/tmp/runner/_work` keeps GitHub's `_work` directory on
  tmpfs-like storage inside the container's writable layer; destroyed with the
  container.

### 5. launchd plists (one per slot)

Create 4 plists at `~/Library/LaunchAgents/com.loopdive.js2wasm-runner.N.plist`
(N = 1..4):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.loopdive.js2wasm-runner.1</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/js2wasm-runner-slot.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/js2wasm-runner-1.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/js2wasm-runner-1.err.log</string>
</dict>
</plist>
```

Load them:

```sh
for n in 1 2 3 4; do
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.loopdive.js2wasm-runner.$n.plist
done
```

To unload (e.g., for maintenance):

```sh
for n in 1 2 3 4; do
  launchctl bootout gui/$(id -u)/com.loopdive.js2wasm-runner.$n
done
```

### 6. Verify

1. Check the org runners page:
   https://github.com/organizations/loopdive/settings/actions/runners
   You should see 4 runners with labels `self-hosted, linux, arm64, mac-mini`,
   status **Idle**.
2. Trigger a dry-run by re-running an existing `test262-sharded` workflow on a
   collaborator PR. (Still routes to `ubuntu-latest` until the YAML is changed
   — this step is just to confirm runners are alive.)
3. Tail logs:
   ```sh
   tail -f /tmp/js2wasm-runner-*.out.log
   ```

## Maintenance

| Task | Frequency | Command |
|---|---|---|
| Update runner image | Monthly | `docker pull myoung34/github-runner:latest` — wrapper picks up on next loop |
| Prune images/volumes | Weekly | `docker system prune -af --volumes` |
| Rotate PAT | Every 90 days | New token at github.com/settings/personal-access-tokens → overwrite `~/.github-runner-token` |
| Check runner health | When CI feels slow | `docker ps` (should show 4 containers, or fewer if jobs are mid-run) |
| Update macOS | Monthly | `launchctl bootout` all 4 → reboot → `launchctl bootstrap` all 4 |

### A weekly prune launchd entry (optional)

`~/Library/LaunchAgents/com.loopdive.js2wasm-runner.prune.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.loopdive.js2wasm-runner.prune</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/docker</string>
    <string>system</string><string>prune</string>
    <string>-af</string><string>--volumes</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
</dict>
</plist>
```

## Failure modes & recovery

- **Mac mini powered off / asleep**: collaborator PRs queue. Either
  (a) wake the Mac, or (b) temporarily remove the `mac-mini` label from the
  workflow (`runs-on: ubuntu-latest`) and re-run. Consider a "fallback to
  hosted" branch in the workflow if downtime is frequent.
- **PAT expired**: all 4 wrapper loops will fail their `docker run`. Logs in
  `/tmp/js2wasm-runner-*.err.log` show the registration error. Rotate the PAT.
- **Docker Desktop crashed**: launchd keeps restarting the wrapper, which
  keeps failing. Restart Docker Desktop manually.
- **Single hung container**: GitHub will reassign the job after the workflow's
  `timeout-minutes: 90`, but the container slot is dead until `docker kill`'d.
  Find it with `docker ps`, then `docker kill <id>`; the wrapper relaunches.
- **All 4 slots occupied, more shards pending**: shards queue. With 16 shards
  and 4 slots, expect 4 rounds = ~20 min total wall-clock (assuming 5 min per
  shard with warm cache).

## What ships next (when you're ready)

After the host is verified Idle on the org runners page:

1. PR to add a dynamic `runs-on` to the `test262-shard` job in
   `.github/workflows/test262-sharded.yml`:

   ```yaml
   runs-on: ${{
     (github.event_name == 'push'
      || github.event.pull_request.head.repo.full_name == github.repository)
     && fromJSON('["self-hosted", "linux", "arm64", "mac-mini"]')
     || 'ubuntu-latest' }}
   ```

   Leaves `merge-report`, `regression-gate`, `promote-baseline` on
   `ubuntu-latest` — they're small and the latter two need branch-write
   permissions handled cleanly by hosted runners.

2. Monitor the first few PRs. Watch for ARM64 vs x64 surprises:
   - `pnpm` / `node` / `esbuild` / `vitest` / `binaryen` — all known to work on
     linux/arm64.
   - `wasmtime` — arm64 binary is published.
   - Any binary fetched in CI without an arm64 download URL will break loudly
     in the first run; we'd fix-forward.

3. If the host proves reliable for a week, consider moving
   `benchmark-refresh.yml` and `diff-test.yml` over too.
