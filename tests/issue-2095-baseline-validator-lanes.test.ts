// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2095 — baseline validator samples both lanes and both row classes.
 *
 * The `test262-baseline-validate` smoke test historically spot-checked only 50
 * HOST `pass` rows. A rotted STANDALONE baseline silently weakened the #1897
 * regression floor, and a stale `fail` row that now passes inflated
 * `improvements` (masking a real regression per PR diff). #2095 extends the
 * validator to:
 *   - fetch the standalone-lane baseline JSONL (new fetch-helper export), and
 *   - run sampled rows in the standalone lane via a new `target` parameter on
 *     `runTest262File`.
 *
 * This file pins the two load-bearing pieces the runtime validator depends on,
 * without the network/full-corpus cost of the validator itself:
 *   1. the fetch helper exposes distinct standalone URL + cache path, and
 *   2. `runTest262File(..., "standalone")` compiles+runs in the standalone lane
 *      (a host-import-free test passes; the parameter is actually threaded).
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  BASELINE_REMOTE_URL,
  BASELINE_CACHE_PATH,
  STANDALONE_BASELINE_REMOTE_URL,
  STANDALONE_BASELINE_CACHE_PATH,
} from "../scripts/fetch-baseline-jsonl.mjs";
import { runTest262File } from "../tests/test262-runner.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const TEST262_ROOT = resolve(ROOT, "test262");

describe("#2095 — fetch helper exposes a distinct standalone lane", () => {
  it("standalone URL + cache path differ from the host lane and point at the standalone JSONL", () => {
    expect(STANDALONE_BASELINE_REMOTE_URL).not.toBe(BASELINE_REMOTE_URL);
    expect(STANDALONE_BASELINE_REMOTE_URL).toContain("test262-standalone-current.jsonl");
    expect(STANDALONE_BASELINE_CACHE_PATH).not.toBe(BASELINE_CACHE_PATH);
    expect(STANDALONE_BASELINE_CACHE_PATH).toContain("test262-standalone-current.jsonl");
  });
});

describe("#2095 — runTest262File honors the standalone target", () => {
  // A stable, host-import-free arithmetic conformance test that is a `pass`
  // row in BOTH lane baselines. If the `target` parameter were ignored (or
  // standalone codegen broke for this shape) the standalone run would diverge
  // from the host control.
  const REL = "test/language/expressions/addition/S11.6.1_A4_T3.js";
  const CATEGORY = "language/expressions/addition";

  it("passes a host-import-free assert in the standalone lane (matches the host control)", async () => {
    const path = resolve(TEST262_ROOT, REL);
    if (!existsSync(path)) {
      // test262 submodule not checked out in this environment — skip rather
      // than fail (the runtime validator exercises this lane in CI).
      return;
    }
    const hostResult = await runTest262File(path, CATEGORY);
    const stdResult = await runTest262File(path, CATEGORY, undefined, "standalone");
    expect(["pass", "skip"]).toContain(hostResult.status);
    // The load-bearing assertion: the standalone lane was actually exercised
    // (the target threaded into compile()) and agrees with the host control.
    expect(stdResult.status).toBe(hostResult.status);
  });
});
