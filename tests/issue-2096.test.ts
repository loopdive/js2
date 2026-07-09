import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORACLE_VERSION, ORACLE_VERSION_HISTORY } from "./test262-oracle-version.js";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

/**
 * Run scripts/diff-test262.ts on two JSONL files and capture exit code + output,
 * so the oracle-version guard can be asserted without throwing on non-zero exit.
 */
function runDiff(baseline: string, candidate: string, env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/diff-test262.ts", baseline, candidate, "--quiet"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("#2096 oracle_version stamping + cross-version diff guard", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function paths() {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-2096-"));
    return {
      base: join(tmpDir, "base.jsonl"),
      cand: join(tmpDir, "cand.jsonl"),
      report: join(tmpDir, "report.json"),
    };
  }

  it("ORACLE_VERSION is a positive integer with a matching history entry", () => {
    expect(Number.isInteger(ORACLE_VERSION)).toBe(true);
    expect(ORACLE_VERSION).toBeGreaterThan(0);
    const latest = ORACLE_VERSION_HISTORY[ORACLE_VERSION_HISTORY.length - 1];
    expect(latest?.version).toBe(ORACLE_VERSION);
  });

  it("diffs same-version files normally (net-positive → exit 0)", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", status: "fail" },
      { oracle_version: 1, file: "b.js", status: "pass" },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "a.js", status: "pass" },
      { oracle_version: 1, file: "b.js", status: "pass" },
    ]);
    const { code } = runDiff(p.base, p.cand);
    expect(code).toBe(0);
  });

  // #3086: a FORWARD monotonic bump (baseline v1 → new v2) is always a
  // deliberate re-baseline, so it auto-rebases (exit 0) WITHOUT ORACLE_REBASE —
  // this is what lets an oracle bump self-land in merge_group, where main's YAML
  // never sets the env flag.
  it("auto-rebases a FORWARD cross-version bump (exit 0) without ORACLE_REBASE (#3086)", () => {
    const p = paths();
    writeJsonl(p.base, [{ oracle_version: 1, file: "a.js", status: "pass" }]);
    writeJsonl(p.cand, [{ oracle_version: 2, file: "a.js", status: "pass" }]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(0);
    expect(out).toMatch(/forward-bump auto-rebase/i);
  });

  // #3086: a BACKWARD skew (baseline v2, new v1 — stale code vs a newer
  // baseline) is the accidental case the guard must still catch, so it refuses
  // (exit 2) without an explicit ORACLE_REBASE.
  it("refuses a BACKWARD cross-version diff (exit 2) without ORACLE_REBASE (#3086)", () => {
    const p = paths();
    writeJsonl(p.base, [{ oracle_version: 2, file: "a.js", status: "pass" }]);
    writeJsonl(p.cand, [{ oracle_version: 1, file: "a.js", status: "pass" }]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(2);
    expect(out).toMatch(/cross-version diff refused/i);
  });

  it("allows a cross-version diff with ORACLE_REBASE=1", () => {
    const p = paths();
    writeJsonl(p.base, [{ oracle_version: 1, file: "a.js", status: "pass" }]);
    writeJsonl(p.cand, [{ oracle_version: 2, file: "a.js", status: "pass" }]);
    const { code, out } = runDiff(p.base, p.cand, { ORACLE_REBASE: "1" });
    // net-zero (a.js stays pass) → exit 0; the guard must NOT block.
    expect(code).toBe(0);
    expect(out).toMatch(/ORACLE_REBASE=1/);
  });

  // #3086 — a deliberate oracle re-baseline (forward bump) has ~0 improvements,
  // so the strict net<0/ratio gate is inapplicable; a small residual (main
  // drift) within the drift tolerance must NOT block the re-baseline. The
  // catastrophic/standalone guards (which parse the printed count, not this exit
  // code) remain the coarse nets.
  it("re-baseline (forward bump) with a residual regression within drift tolerance → exit 0 (#3086)", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "b1" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "b2" },
    ]);
    // a.js flips pass→fail with a CHANGED wasm_sha (a non-vacuous residual/drift).
    writeJsonl(p.cand, [
      { oracle_version: 2, file: "a.js", status: "fail", error: "drift", wasm_sha: "c1" },
      { oracle_version: 2, file: "b.js", status: "pass", wasm_sha: "b2" },
    ]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(0);
    expect(out).toMatch(/Re-baseline gate \(#3086\)/);
    // The residual is still surfaced for the coarse guards.
    expect(out).toMatch(/Regressions with wasm-hash change: 1/);
  });

  it("re-baseline (forward bump) exceeding the drift tolerance → exit 1 (#3086)", () => {
    const p = paths();
    const base = [];
    const cand = [];
    for (let i = 0; i < 30; i++) {
      base.push({ oracle_version: 1, file: `t${i}.js`, status: "pass", wasm_sha: `b${i}` });
      cand.push({ oracle_version: 2, file: `t${i}.js`, status: "fail", error: "break", wasm_sha: `c${i}` });
    }
    writeJsonl(p.base, base);
    writeJsonl(p.cand, cand);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(1);
    expect(out).toMatch(/exceeds drift tolerance/);
  });

  it("hard-refuses a MIXED-version file (exit 2) even with ORACLE_REBASE=1", () => {
    const p = paths();
    writeJsonl(p.base, [{ oracle_version: 1, file: "a.js", status: "pass" }]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "a.js", status: "pass" },
      { oracle_version: 2, file: "b.js", status: "pass" },
    ]);
    const { code, out } = runDiff(p.base, p.cand, { ORACLE_REBASE: "1" });
    expect(code).toBe(2);
    expect(out).toMatch(/MIXED oracle versions/i);
  });

  it("treats an unstamped (pre-#2096) file as legacy-comparable", () => {
    const p = paths();
    writeJsonl(p.base, [{ file: "a.js", status: "pass" }]);
    writeJsonl(p.cand, [{ oracle_version: 1, file: "a.js", status: "pass" }]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(0);
    expect(out).toMatch(/unstamped/i);
  });

  it("stamps oracle_version onto the merged report and flags mixed reports", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", category: "x", status: "pass", scope: "standard", scope_official: true },
    ]);
    execFileSync("node", ["scripts/build-test262-report.mjs", "--input", p.base, "--output", p.report], {
      stdio: "ignore",
    });
    const report = JSON.parse(readFileSync(p.report, "utf8"));
    expect(report.oracle_version).toBe(1);
    expect(report.oracle_version_mixed).toBeUndefined();

    const mixed = join(tmpDir!, "mixed.jsonl");
    const mixedReport = join(tmpDir!, "mixed-report.json");
    writeJsonl(mixed, [
      { oracle_version: 1, file: "a.js", category: "x", status: "pass", scope: "standard", scope_official: true },
      { oracle_version: 2, file: "b.js", category: "x", status: "fail", scope: "standard", scope_official: true },
    ]);
    execFileSync("node", ["scripts/build-test262-report.mjs", "--input", mixed, "--output", mixedReport], {
      stdio: "ignore",
    });
    const mr = JSON.parse(readFileSync(mixedReport, "utf8"));
    expect(mr.oracle_version).toBe(1); // lowest seen
    expect(mr.oracle_version_mixed).toBe(true);
  });
});
