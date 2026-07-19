import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORACLE_FAST_REV, ORACLE_FAST_HISTORY, ORACLE_VERSION } from "./test262-oracle-version.js";
import {
  FAST_BASELINE_CACHE_PATH,
  FAST_BASELINE_REMOTE_URL,
  ensureFastBaselineJsonl,
} from "../scripts/fetch-baseline-jsonl.mjs";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

/**
 * Run scripts/diff-test262.ts on two JSONL files and capture exit code + output,
 * mirroring tests/issue-2096.test.ts so the oracle-LANE guard (#3462) can be
 * asserted without throwing on a non-zero exit.
 */
function runDiff(baseline: string, candidate: string, env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/diff-test262.ts", baseline, candidate, "--quiet"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REGRESSIONS_ALLOW_FILE: "/dev/null", ...env },
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// Honest rows use the current honest oracle_version and lane; fast rows share
// the SAME oracle_version (both are v8) but carry the fast lane + rev — the
// whole point of #3462 is that the version axis cannot distinguish them, so the
// lane is a separate guard.
const V = ORACLE_VERSION;
const honest = (file: string, status: string, extra: Record<string, unknown> = {}) => ({
  oracle_version: V,
  oracle_lane: "honest",
  file,
  status,
  ...extra,
});
const fast = (file: string, status: string, rev = ORACLE_FAST_REV, extra: Record<string, unknown> = {}) => ({
  oracle_version: V,
  oracle_lane: "fast-nativeharness",
  oracle_fast_rev: rev,
  file,
  status,
  ...extra,
});

describe("#3462 oracle_lane stamping + fast/honest diff guard", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function paths() {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-3462-"));
    return { base: join(tmpDir, "base.jsonl"), cand: join(tmpDir, "cand.jsonl") };
  }

  it("ORACLE_FAST_REV is a positive integer with a matching history entry", () => {
    expect(Number.isInteger(ORACLE_FAST_REV)).toBe(true);
    expect(ORACLE_FAST_REV).toBeGreaterThan(0);
    const latest = ORACLE_FAST_HISTORY[ORACLE_FAST_HISTORY.length - 1];
    expect(latest?.rev).toBe(ORACLE_FAST_REV);
  });

  it("diffs honest-vs-honest normally (exit 0)", () => {
    const p = paths();
    writeJsonl(p.base, [honest("a.js", "pass"), honest("b.js", "pass")]);
    writeJsonl(p.cand, [honest("a.js", "pass"), honest("b.js", "pass")]);
    expect(runDiff(p.base, p.cand).code).toBe(0);
  });

  // Backward compatibility: a pre-#3462 honest baseline carries NO oracle_lane;
  // absent ⇒ honest, so it still compares cleanly against a stamped honest run.
  it("treats an absent oracle_lane as honest (exit 0 against a stamped honest candidate)", () => {
    const p = paths();
    writeJsonl(p.base, [{ oracle_version: V, file: "a.js", status: "pass" }]);
    writeJsonl(p.cand, [honest("a.js", "pass")]);
    expect(runDiff(p.base, p.cand).code).toBe(0);
  });

  it("diffs fast-vs-fast (same rev) normally (exit 0)", () => {
    const p = paths();
    writeJsonl(p.base, [fast("a.js", "pass"), fast("b.js", "pass")]);
    writeJsonl(p.cand, [fast("a.js", "pass"), fast("b.js", "pass")]);
    expect(runDiff(p.base, p.cand).code).toBe(0);
  });

  it("REFUSES a fast candidate against an honest baseline (exit 2) without ORACLE_REBASE", () => {
    const p = paths();
    writeJsonl(p.base, [honest("a.js", "pass")]);
    writeJsonl(p.cand, [fast("a.js", "pass")]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(2);
    expect(out).toMatch(/cross-lane diff refused/i);
  });

  it("REFUSES an honest candidate against a fast baseline (exit 2) without ORACLE_REBASE", () => {
    const p = paths();
    writeJsonl(p.base, [fast("a.js", "pass")]);
    writeJsonl(p.cand, [honest("a.js", "pass")]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(2);
    expect(out).toMatch(/cross-lane diff refused/i);
  });

  it("allows a cross-lane diff with ORACLE_REBASE=1 (fast-lane re-seed)", () => {
    const p = paths();
    writeJsonl(p.base, [honest("a.js", "pass")]);
    writeJsonl(p.cand, [fast("a.js", "pass")]);
    const { code, out } = runDiff(p.base, p.cand, { ORACLE_REBASE: "1" });
    expect(code).toBe(0);
    expect(out).toMatch(/comparing across oracle LANES/i);
  });

  it("REFUSES a fast-lane rev mismatch (exit 2) without ORACLE_REBASE", () => {
    const p = paths();
    writeJsonl(p.base, [fast("a.js", "pass", 1)]);
    writeJsonl(p.cand, [fast("a.js", "pass", 2)]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(2);
    expect(out).toMatch(/fast-lane rev mismatch/i);
  });

  it("allows a fast-lane rev mismatch with ORACLE_REBASE=1", () => {
    const p = paths();
    writeJsonl(p.base, [fast("a.js", "pass", 1)]);
    writeJsonl(p.cand, [fast("a.js", "pass", 2)]);
    const { code, out } = runDiff(p.base, p.cand, { ORACLE_REBASE: "1" });
    expect(code).toBe(0);
    expect(out).toMatch(/across fast oracle revisions/i);
  });

  it("hard-refuses a MIXED-lane file (exit 2) even with ORACLE_REBASE=1", () => {
    const p = paths();
    writeJsonl(p.base, [honest("a.js", "pass")]);
    writeJsonl(p.cand, [honest("a.js", "pass"), fast("b.js", "pass")]);
    const { code, out } = runDiff(p.base, p.cand, { ORACLE_REBASE: "1" });
    expect(code).toBe(2);
    expect(out).toMatch(/MIXED oracle lanes/i);
  });

  it("hard-refuses a MIXED fast-rev file (exit 2) even with ORACLE_REBASE=1", () => {
    const p = paths();
    writeJsonl(p.base, [fast("a.js", "pass", 1)]);
    writeJsonl(p.cand, [fast("a.js", "pass", 1), fast("b.js", "pass", 2)]);
    const { code, out } = runDiff(p.base, p.cand, { ORACLE_REBASE: "1" });
    expect(code).toBe(2);
    expect(out).toMatch(/MIXED fast revs/i);
  });
});

describe("#3462 fast-baseline fetch helper", () => {
  it("exposes the fast-baseline URL, cache path, and ensure helper", () => {
    expect(FAST_BASELINE_REMOTE_URL).toMatch(/js2wasm-baselines\/main\/test262-fast-current\.jsonl$/);
    expect(FAST_BASELINE_CACHE_PATH).toMatch(/[\\/]\.test262-cache[\\/]test262-fast-current\.jsonl$/);
    expect(typeof ensureFastBaselineJsonl).toBe("function");
  });
});
