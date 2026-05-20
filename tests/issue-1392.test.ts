// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1392 — `pnpm run refresh:benchmarks` must not hang indefinitely in the
// browser-runtime stage. The fix wraps the Playwright `eval` call in
// `scripts/generate-browser-runtime-benchmarks.mjs` with a bounded
// `execFileSync({ timeout })`, surfaces a typed "timeout" error, and
// emits a heartbeat so the operator can see the stage is alive.
//
// This test exercises the timeout path end-to-end by:
//  1. Pointing `CODEX_HOME` at a temp dir.
//  2. Writing a fake `playwright_cli.sh` that hangs forever for `eval`
//     calls and returns immediately for `open` calls.
//  3. Setting `BROWSER_EVAL_TIMEOUT_MS=1500` so the script gives up
//     quickly.
//  4. Running the script and asserting it exits non-zero with the
//     expected timeout marker in its stderr.

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "scripts",
  "generate-browser-runtime-benchmarks.mjs",
);

function makeFakeCodexHome(): string {
  const root = mkdtempSync(resolve(tmpdir(), "issue-1392-codex-"));
  const scriptsDir = resolve(root, "skills", "playwright", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  // Hang on `eval`, return promptly on anything else (e.g. `open`).
  const fake = [
    "#!/usr/bin/env bash",
    'if [[ "$1" == "eval" ]]; then',
    "  # Hang forever — the script should kill us via its timeout.",
    "  while true; do sleep 60; done",
    "fi",
    "# Other subcommands return an empty success.",
    "echo OK",
    "exit 0",
    "",
  ].join("\n");
  const wrapperPath = resolve(scriptsDir, "playwright_cli.sh");
  writeFileSync(wrapperPath, fake, { encoding: "utf8" });
  chmodSync(wrapperPath, 0o755);
  return root;
}

describe("#1392 — refresh:benchmarks browser-runtime stage timeout", () => {
  it("exits non-zero with a TIMEOUT marker when the Playwright eval hangs", () => {
    // Sanity: pre-requisite playground benchmark file must exist; the
    // script bails out earlier if it doesn't (and that's a separate
    // codepath we don't need to exercise here).
    const playgroundJson = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "benchmarks",
      "results",
      "playground-benchmark-sidebar.json",
    );
    if (!existsSync(playgroundJson)) {
      // Test environment doesn't have the snapshot — skip gracefully.
      return;
    }

    const codexHome = makeFakeCodexHome();
    const start = Date.now();
    const result = spawnSync("node", [SCRIPT], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        BROWSER_EVAL_TIMEOUT_MS: "1500",
      },
      encoding: "utf8",
      // Outer safety net: even if the timeout logic is broken, this
      // kills the test instead of wedging vitest.
      timeout: 30_000,
    });
    const elapsedMs = Date.now() - start;

    expect(result.status, `script should exit non-zero on timeout. stderr:\n${result.stderr}`).not.toBe(0);
    // Should give up close to the configured limit (1.5s) — well under
    // the 30s outer cap. Allow generous slack for cold-start overhead.
    expect(elapsedMs).toBeLessThan(20_000);
    // Stderr should carry the "TIMEOUT" marker emitted by the
    // top-level catch in generate-browser-runtime-benchmarks.mjs.
    expect(result.stderr).toMatch(/TIMEOUT/i);
  }, 60_000);

  it("script passes node --check (no syntax regressions)", () => {
    // Cheap guard so future edits to the script don't break parsing.
    expect(() => execFileSync("node", ["--check", SCRIPT], { encoding: "utf8" })).not.toThrow();
  });
});
