// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3915 — a bot push to `main` discards the in-flight `merge_group` validation.
 *
 * Every push to `main` makes GitHub rebuild the queued merge groups on the new
 * base and throw away the validation already running under them. `[skip ci]`
 * suppresses workflows on that commit; it does NOT make the push inert to the
 * queue. `benchmark-refresh` pushes 7-12 min after each merge, landing inside
 * the next merge's ~11-13 min validation window nearly every time.
 *
 * Two halves are tested, because either alone is worthless:
 *
 *   1. THE DECISION TABLE — `decide()` is pure, so every branch (including both
 *      "I cannot see" branches) is asserted directly.
 *   2. THE WIRING — a gate whose output nothing reads is the silent-empty
 *      failure applied to the fix itself. These assertions pin the step `id`,
 *      the output name, and the fact that the `if:` guard sits on the PUSH
 *      step rather than somewhere harmless.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UNKNOWN, decide, readArtifactAgeHours, readQueueLength } from "../scripts/main-push-queue-gate.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const FLOOR = 6;

/** Slice one workflow step out by name, up to the next sibling `- name:`. */
function step(workflow: string, name: string): string {
  const start = workflow.indexOf(`      - name: ${name}`);
  expect(start, `step not found: ${name}`).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf("\n      - name: ", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

describe("#3915 decision table", () => {
  it("defers only when the queue is KNOWN busy and the artifact is KNOWN fresh", () => {
    const d = decide({
      force: false,
      queueLen: 3,
      ageHours: 0.5,
      staleAfterHours: FLOOR,
    });
    expect(d.decision).toBe("defer");
    expect(d.warnings).toEqual([]);
  });

  it("proceeds on an empty queue", () => {
    expect(decide({ force: false, queueLen: 0, ageHours: 0.1, staleAfterHours: FLOOR }).decision).toBe("proceed");
  });

  it("proceeds past the staleness floor, so a never-draining queue cannot freeze the artifact", () => {
    const d = decide({
      force: false,
      queueLen: 5,
      ageHours: FLOOR + 0.01,
      staleAfterHours: FLOOR,
    });
    expect(d.decision).toBe("proceed");
    expect(d.why).toContain("staleness floor");
    // Exactly at the floor also proceeds — the bound is inclusive, so a clock
    // that lands precisely on it cannot stall.
    expect(decide({ force: false, queueLen: 5, ageHours: FLOOR, staleAfterHours: FLOOR }).decision).toBe("proceed");
  });

  it("--force always proceeds, even into a busy queue with a fresh artifact", () => {
    expect(decide({ force: true, queueLen: 9, ageHours: 0, staleAfterHours: FLOOR }).decision).toBe("proceed");
  });

  /**
   * FAIL-OPEN, AND WHY IT DOES NOT CONTRADICT "a detector must be able to say
   * I don't know". For a VERIFIER the reassuring side hides defects. This is a
   * DEFERRAL and the cost asymmetry is reversed: unknown-⇒-push costs at most
   * one discarded validation, once; unknown-⇒-defer can freeze the artifact
   * indefinitely on a flaky API, silently, because a skipped push looks exactly
   * like a no-op one. The rule's intent survives in the part that matters — it
   * must still REPORT that it could not see.
   */
  it("an unreadable queue length proceeds AND warns", () => {
    const d = decide({
      force: false,
      queueLen: UNKNOWN,
      ageHours: 0.1,
      staleAfterHours: FLOOR,
    });
    expect(d.decision).toBe("proceed");
    expect(d.warnings.join(" ")).toMatch(/queue length could not be read/i);
    expect(d.why).toContain("queue=UNKNOWN");
  });

  it("an unreadable artifact age proceeds AND warns when no fallback is declared", () => {
    const d = decide({
      force: false,
      queueLen: 4,
      ageHours: UNKNOWN,
      staleAfterHours: FLOOR,
    });
    expect(d.decision).toBe("proceed");
    expect(d.warnings.join(" ")).toMatch(/freshness could not be read/i);
    expect(d.why).toContain("artifact-age=UNKNOWN");
  });

  it("an unreadable artifact age DEFERS when another gated path re-lands the artifact", () => {
    const d = decide({
      force: false,
      queueLen: 4,
      ageHours: UNKNOWN,
      staleAfterHours: FLOOR,
      fallback: "the hourly gated baseline-summary-sync.yml (#1951)",
    });
    expect(d.decision).toBe("defer");
    expect(d.why).toContain("baseline-summary-sync");
    // Declared fallback ⇒ the freeze risk is covered elsewhere, so there is
    // nothing to warn about.
    expect(d.warnings).toEqual([]);
  });

  it("states both inputs in the verdict, so a degraded gate is legible in the log", () => {
    const d = decide({
      force: false,
      queueLen: 2,
      ageHours: 1.25,
      staleAfterHours: FLOOR,
    });
    expect(d.why).toContain("queue=2");
    expect(d.why).toContain("artifact-age=1.3h");
    expect(d.why).toContain("floor=6h");
  });
});

describe("#3915 freshness reading", () => {
  /**
   * The trap this exists to prevent: `git log -1 --format=%ct -- <path>` in a
   * `fetch-depth: 1` checkout returns EMPTY, not an error — and every promote
   * job in this repo is shallow. Empty must read as UNKNOWN, never as a
   * timestamp, or the staleness floor silently disables itself forever while
   * the gate keeps reporting success.
   */
  it.each(["", "   ", "null", "undefined", "not-a-date"])("treats %o as UNKNOWN rather than a timestamp", (raw) => {
    expect(readArtifactAgeHours(raw, Date.parse("2026-07-31T20:00:00Z"))).toBe(UNKNOWN);
  });

  it("reads an ISO timestamp as an age in hours", () => {
    const age = readArtifactAgeHours("2026-07-31T18:00:00Z", Date.parse("2026-07-31T21:30:00Z"));
    expect(age).toBeCloseTo(3.5, 6);
  });

  it("treats a future timestamp as UNKNOWN, not as maximum freshness", () => {
    expect(readArtifactAgeHours("2026-08-01T00:00:00Z", Date.parse("2026-07-31T21:00:00Z"))).toBe(UNKNOWN);
  });
});

describe("#3915 queue-length reading", () => {
  it("reports UNKNOWN when the query throws", () => {
    const exec = () => {
      throw new Error("gh: API rate limit exceeded");
    };
    expect(readQueueLength({ repo: "loopdive/js2wasm", exec })).toBe(UNKNOWN);
  });

  /**
   * The silent-empty case: `gh` exits 0 but prints nothing (absent field,
   * partial GraphQL error, permissions gap). Blank is NOT zero — reading it as
   * "queue empty" would make a broken query look like a clear runway.
   */
  it.each(["", "\n", "null"])("reports UNKNOWN for a blank body %o", (out) => {
    expect(readQueueLength({ repo: "loopdive/js2wasm", exec: () => out })).toBe(UNKNOWN);
  });

  it("reads a real count", () => {
    expect(readQueueLength({ repo: "loopdive/js2wasm", exec: () => "0\n" })).toBe(0);
    expect(readQueueLength({ repo: "loopdive/js2wasm", exec: () => "7\n" })).toBe(7);
  });

  it("reports UNKNOWN for a malformed repo slug instead of guessing", () => {
    expect(readQueueLength({ repo: "js2", exec: () => "3" })).toBe(UNKNOWN);
  });
});

describe("#3915 wiring: benchmark-refresh.yml", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/benchmark-refresh.yml"), "utf8");
  const gate = step(wf, "Gate the main push on the merge queue");
  const promote = step(wf, "Atomically promote the complete benchmark set");

  it("the gate step declares the id the push step reads", () => {
    expect(gate).toContain("id: queue_gate");
    expect(gate).toContain('echo "decision=defer" >> "$GITHUB_OUTPUT"');
    expect(gate).toContain('echo "decision=proceed" >> "$GITHUB_OUTPUT"');
  });

  it("the PUSH step — not some other step — is guarded by that output", () => {
    expect(promote).toContain("if: steps.queue_gate.outputs.decision != 'defer'");
    // Positive control on the slice: this really is the step that pushes.
    expect(promote).toContain("git push deploykey HEAD:main");
  });

  it("maps exit 10 to defer and every other non-zero to fail-open", () => {
    expect(gate).toContain('if [ "$RC" -eq 10 ]');
    expect(gate).toMatch(/failing open/);
  });

  it("takes freshness from the artifact's own generatedAt, never from git log", () => {
    expect(gate).toContain("benchmark-manifest.json");
    expect(gate).toContain("generatedAt");
    expect(gate).toContain("--stale-after-hours 6");
    // The value handed to --last-refresh must come from reading the artifact.
    // `git log -1 --format=%ct -- <path>` returns EMPTY in this fetch-depth: 1
    // checkout, which would read as "unknown age" and silently disable the
    // floor. (The step's prose may explain that trap; the CODE must not do it.)
    const assignment = gate
      .split("\n")
      .filter((l) => /^\s*LAST_REFRESH=/.test(l))
      .join("\n");
    expect(assignment).toContain("benchmark-manifest.json");
    expect(assignment).not.toMatch(/git\s+log/);
  });
});

describe("#3915 wiring: refresh-baseline.yml", () => {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/refresh-baseline.yml"), "utf8");
  const gate = step(wf, "Gate the main audit push on the merge queue");
  const promote = step(wf, "Commit baseline refresh to main (audit trail)");

  it("guards the main audit push with the gate's output", () => {
    expect(gate).toContain("id: queue_gate");
    expect(promote).toContain("if: steps.queue_gate.outputs.decision != 'defer'");
    expect(promote).toContain("git push deploykey HEAD:main");
  });

  it("declares the gated fallback instead of carrying its own staleness floor", () => {
    expect(gate).toContain("--fallback");
    expect(gate).toContain("baseline-summary-sync.yml");
    expect(gate).not.toContain("--stale-after-hours");
  });

  it("never defers an emergency (forced) recovery run", () => {
    expect(gate).toContain('if [ "${IS_FORCED}" = "true" ]; then FORCE_ARG="--force"; fi');
  });

  /**
   * The step script is executed VERBATIM here, under the same `bash -e {0}`
   * that GitHub uses, with a stub `node` supplying the exit code. This is the
   * only assertion that proves the exit-code -> output mapping actually works
   * rather than merely looking right.
   *
   * The specific bug it pins: `node ...` on its own line followed by `RC=$?`
   * ABORTS THE WHOLE STEP under `-e` before `RC` is ever read, so the DEFER
   * path would surface as a red step instead of a skipped push. Only the
   * `|| RC=$?` form survives. Verified by running both idioms.
   */
  it.each([
    [10, "decision=defer"],
    [0, "decision=proceed"],
    [3, "decision=proceed"], // gate malfunction => fail OPEN, never freeze
  ])("running the step script verbatim, node exit %i writes %s", (code, expected) => {
    const script = gate.slice(gate.indexOf("\n        run: |") + "\n        run: |".length);
    const body = script
      .split("\n")
      .map((l) => (l.startsWith("          ") ? l.slice(10) : l))
      .join("\n");
    const dir = mkdtempSync(join(tmpdir(), "gate-3915-"));
    // Stub `node` so the gate invocation contributes nothing but its exit code.
    writeFileSync(join(dir, "node"), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    const out = join(dir, "gh-output");
    writeFileSync(out, "");
    const res = spawnSync("bash", ["-e", "-c", body], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: out,
        GITHUB_REPOSITORY: "loopdive/js2wasm",
        IS_FORCED: "false",
      },
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(out, "utf8").trim()).toBe(expected);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("#3915 class coverage: no un-gated pusher is left behind", () => {
  /**
   * The reported instance was `benchmark-refresh`. The class is "a workflow
   * that pushes to `loopdive/js2wasm:main`". These four are the whole class as of
   * 2026-08-01: two were already gated inline by #1951, and this change gates
   * the two that were not. Every other `git push` in `.github/workflows/`
   * targets the baselines repo or a non-main branch.
   */
  const cases: Array<[string, string]> = [
    // gated here (#3915) — via the shared script
    ["benchmark-refresh.yml", "main-push-queue-gate.mjs"],
    ["refresh-baseline.yml", "main-push-queue-gate.mjs"],
    // gated inline by #1951 — left alone deliberately; promote-baseline is the
    // most load-bearing promote path in the repo and its gate works.
    ["test262-sharded.yml", "mergeQueue"],
    ["baseline-summary-sync.yml", "mergeQueue"],
  ];

  it.each(cases)("%s gates its push to main (via %s)", (file, marker) => {
    const wf = readFileSync(resolve(ROOT, ".github/workflows", file), "utf8");
    expect(wf).toContain("HEAD:main");
    expect(wf).toContain(marker);
  });
});
