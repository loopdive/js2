// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3303 — PR-scoped `regressions-allow:` ceiling for HONEST verdict-logic
// reclassifications, plus the #1668/#1897 guard exit-code contract.
//
// A verdict-logic reclassification (e.g. #3285/#3104: 2615 previously inflated
// false passes becoming honest fails — plain assertion_fail/type_error rows the
// #2940 vacuity excusal does not cover, see #3286) exceeds the #3086 rebase
// drift tolerance (25) and previously required a risky repo-wide
// "temporary-lever dance". #3303 lets the PR declare a ceiling in its OWN issue
// file's frontmatter:
//
//   regressions-allow:
//     count: 2700
//     reason: "#3285 assert_throws error-type tightening, see #3286"
//
// These tests pin the safety properties the mechanism depends on:
//   1. CEILING EXACTNESS — the gate passes at exactly the declared count and
//      fails at declared+1 (a ceiling the PR commits to, not a blank check);
//   2. REBASE-MODE ONLY — without a forward oracle bump the allowance is
//      inert (an ordinary PR cannot use it to sneak regressions through);
//   3. TRAP-RATCHET CONTAINMENT — regressions-allow never suppresses the #3189
//      ratchet; a separate bounded trap-growth-allow is rebase-only;
//   4. PR-SCOPING — the declaration is read from issue files in the change-set
//      diff only (change-scope.mjs), with a required reason;
//   5. GUARD AGREEMENT — the #1668 catastrophic and #1897 standalone guard
//      steps in test262-sharded.yml (their REAL bash, extracted from the YAML
//      and executed against canned diff outputs) treat diff-test262.ts's exit
//      code as authoritative on PASS (exit 0) and only apply their coarse
//      thresholds when the script's own gate FAILED (exit 1) — fixing the
//      pre-#3303 structural bug where they re-derived pass/fail from the raw
//      printed count and vetoed re-baselines the script had approved.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ORACLE_REBASE_DRIFT_TOLERANCE,
  REGRESSION_BUCKET_LIMIT,
  REGRESSIONS_ALLOW_KEY,
  evaluateRebaseGate,
} from "../scripts/diff-test262.js";
import { effectiveBaselineTrapTolerance } from "../scripts/check-baseline-trap-growth.js";
// Untyped .mjs helper (scripts/ is outside the tsc include set — runtime only).
import { parseFrontmatterCountReason } from "../scripts/lib/change-scope.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

// ---------------------------------------------------------------------------
// 1. Frontmatter parser (change-scope.mjs parseFrontmatterCountReason)
// ---------------------------------------------------------------------------

function fm(body: string): string {
  return `---\nid: 9999\n${body}\n---\n\n# body\n`;
}

describe("#3303 — parseFrontmatterCountReason", () => {
  it("parses a valid count + reason block", () => {
    const text = fm(`regressions-allow:\n  count: 2700\n  reason: "#3285 assert_throws tightening, see #3286"`);
    expect(parseFrontmatterCountReason(text, REGRESSIONS_ALLOW_KEY)).toEqual({
      count: 2700,
      reason: "#3285 assert_throws tightening, see #3286",
      // #3596 added an optional nested `tests:` list; a declaration without one
      // parses exactly as before and reports an empty list.
      tests: [],
    });
  });

  it("returns undefined when the key is absent", () => {
    expect(parseFrontmatterCountReason(fm("priority: high"), REGRESSIONS_ALLOW_KEY)).toBeUndefined();
    expect(parseFrontmatterCountReason("no frontmatter at all", REGRESSIONS_ALLOW_KEY)).toBeUndefined();
  });

  it("rejects (null) a declaration missing the required reason", () => {
    expect(parseFrontmatterCountReason(fm("regressions-allow:\n  count: 100"), REGRESSIONS_ALLOW_KEY)).toBeNull();
  });

  it("rejects (null) a declaration missing/invalid count", () => {
    expect(
      parseFrontmatterCountReason(fm(`regressions-allow:\n  reason: "no count"`), REGRESSIONS_ALLOW_KEY),
    ).toBeNull();
    expect(
      parseFrontmatterCountReason(fm(`regressions-allow:\n  count: lots\n  reason: "x"`), REGRESSIONS_ALLOW_KEY),
    ).toBeNull();
    expect(
      parseFrontmatterCountReason(fm(`regressions-allow:\n  count: -5\n  reason: "x"`), REGRESSIONS_ALLOW_KEY),
    ).toBeNull();
    expect(
      parseFrontmatterCountReason(fm(`regressions-allow:\n  count: 0\n  reason: "x"`), REGRESSIONS_ALLOW_KEY),
    ).toBeNull();
  });

  it("rejects (null) an inline scalar form (block form only)", () => {
    expect(parseFrontmatterCountReason(fm("regressions-allow: 2700"), REGRESSIONS_ALLOW_KEY)).toBeNull();
  });

  it("does not read the key from the document BODY (frontmatter only)", () => {
    const text = `---\nid: 9999\n---\n\nregressions-allow:\n  count: 100\n  reason: "in body, not frontmatter"\n`;
    expect(parseFrontmatterCountReason(text, REGRESSIONS_ALLOW_KEY)).toBeUndefined();
  });
});

describe("#3370 — baseline-writer trap ceiling containment", () => {
  it("uses the change-scoped ceiling only for a forward oracle bump", () => {
    expect(effectiveBaselineTrapTolerance(4, 7, 8, 47)).toBe(47);
    expect(effectiveBaselineTrapTolerance(4, 8, 8, 47)).toBe(4);
    expect(effectiveBaselineTrapTolerance(4, 8, 7, 47)).toBe(4);
    expect(effectiveBaselineTrapTolerance(4, undefined, 8, 47)).toBe(4);
  });

  it("keeps the landed merge parent available in both baseline writers", () => {
    const sharded = readFileSync(join(ROOT, ".github/workflows/test262-sharded.yml"), "utf8");
    const refresh = readFileSync(join(ROOT, ".github/workflows/refresh-baseline.yml"), "utf8");

    function checkoutForJob(workflow: string, job: string): string {
      const start = workflow.indexOf(`\n  ${job}:\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const setupNode = workflow.indexOf("\n      - name: Setup Node", start);
      expect(setupNode).toBeGreaterThan(start);
      return workflow.slice(start, setupNode);
    }

    expect(checkoutForJob(sharded, "promote-baseline")).toContain("fetch-depth: 2");
    expect(checkoutForJob(refresh, "merge-and-promote")).toContain("fetch-depth: 2");

    const predecessorStep = sharded.slice(
      sharded.indexOf("- name: Resolve predecessor-group baseline (#1956)"),
      sharded.indexOf(
        "- name: Check baseline staleness (#1235",
        sharded.indexOf("- name: Resolve predecessor-group baseline (#1956)"),
      ),
    );
    expect(predecessorStep).toContain("pred_path=oracle-mismatch");
    expect(predecessorStep).toContain('[ "$LATEST_ORACLE" != "$PRED_ORACLE" ]');
    expect(predecessorStep).toContain(
      "PRED_ORACLE=$(node -e \"try { const line=require('fs').readFileSync(process.argv[1]",
    );
    expect(predecessorStep).toContain("/tmp/pred-group/test262-results-merged.jsonl)");
    expect(predecessorStep).not.toContain("/tmp/pred-group/test262-report-merged.json");
  });
});

// ---------------------------------------------------------------------------
// 2. Pure rebase-gate logic (evaluateRebaseGate)
// ---------------------------------------------------------------------------

function files(n: number, bucket?: string): string[] {
  return Array.from({ length: n }, (_, i) => (bucket ? `${bucket}/case${i}.js` : `test/x${i}/a/b/c/t.js`));
}

describe("#3303 — evaluateRebaseGate (pure)", () => {
  it("without an allowance: passes within the #3086 drift tolerance", () => {
    const r = evaluateRebaseGate({
      regressionsWasmChange: ORACLE_REBASE_DRIFT_TOLERANCE,
      regressedFiles: files(ORACLE_REBASE_DRIFT_TOLERANCE),
    });
    expect(r.failures).toEqual([]);
    expect(r.notes.some((n) => n.includes("Re-baseline gate (#3086)"))).toBe(true);
  });

  it("without an allowance: fails one above the drift tolerance", () => {
    const n = ORACLE_REBASE_DRIFT_TOLERANCE + 1;
    const r = evaluateRebaseGate({ regressionsWasmChange: n, regressedFiles: files(n) });
    expect(r.failures.some((f) => f.includes("exceeds drift tolerance"))).toBe(true);
  });

  it("without an allowance: bucket concentration still fails", () => {
    const n = REGRESSION_BUCKET_LIMIT + 10;
    const r = evaluateRebaseGate({
      regressionsWasmChange: n,
      regressedFiles: files(n, "test/built-ins/Array/prototype/every"),
    });
    expect(r.failures.some((f) => f.includes("bucket"))).toBe(true);
  });

  it("allowance: passes at EXACTLY the declared count (ceiling exactness)", () => {
    const allowance = { count: 30, reason: "#3285 fixture", sources: ["plan/issues/9999-x.md"] };
    const r = evaluateRebaseGate({ regressionsWasmChange: 30, regressedFiles: files(30), allowance });
    expect(r.failures).toEqual([]);
    expect(r.notes.some((n) => n.includes("regressions-allow (#3303): excused 30 of 30"))).toBe(true);
  });

  it("allowance: FAILS at declared+1 (a ceiling, not a blank check)", () => {
    const allowance = { count: 30, reason: "#3285 fixture", sources: ["plan/issues/9999-x.md"] };
    const r = evaluateRebaseGate({ regressionsWasmChange: 31, regressedFiles: files(31), allowance });
    expect(r.failures.some((f) => f.includes("regressions-allow ceiling exceeded (#3303)"))).toBe(true);
  });

  it("allowance supersedes the bucket-concentration check up to the ceiling", () => {
    const n = REGRESSION_BUCKET_LIMIT + 10; // one bucket, over the 50 limit
    const allowance = { count: 100, reason: "#3285 fixture", sources: ["plan/issues/9999-x.md"] };
    const r = evaluateRebaseGate({
      regressionsWasmChange: n,
      regressedFiles: files(n, "test/built-ins/Array/prototype/every"),
      allowance,
    });
    expect(r.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. CLI end-to-end (rebase-mode fixtures; hermetic via REGRESSIONS_ALLOW_FILE)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** n honest pass→fail flips with changed wasm hashes, oracle v1 → v2 (rebase). */
function rebaseRows(n: number, opts: { sameOracle?: boolean; traps?: number } = {}): { base: Row[]; cand: Row[] } {
  const base: Row[] = [];
  const cand: Row[] = [];
  const candOracle = opts.sameOracle ? 1 : 2;
  for (let i = 0; i < n; i++) {
    const file = `test/x${i}/a/b/c/t.js`;
    base.push({ oracle_version: 1, file, status: "pass", wasm_sha: `sha${i}aaaa1` });
    cand.push({
      oracle_version: candOracle,
      file,
      status: "fail",
      error: "Test262Error: honest assertion fail",
      error_category: "assertion_fail",
      wasm_sha: `sha${i}aaaa2`,
    });
  }
  for (let i = 0; i < (opts.traps ?? 0); i++) {
    const file = `test/trap${i}/a/b/c/t.js`;
    base.push({ oracle_version: 1, file, status: "pass", wasm_sha: `trap${i}aaa1` });
    cand.push({
      oracle_version: candOracle,
      file,
      status: "fail",
      error: "RuntimeError: null dereference",
      error_category: "null_deref",
      wasm_sha: `trap${i}aaa2`,
    });
  }
  return { base, cand };
}

function allowanceFileText(count: number): string {
  return fm(`regressions-allow:\n  count: ${count}\n  reason: "#3285 fixture reclassification, see #3286"`);
}

function combinedAllowanceFileText(regressions: number, trapGrowth: number): string {
  return fm(
    `regressions-allow:\n  count: ${regressions}\n  reason: "fixture reclassification"\n` +
      `trap-growth-allow:\n  count: ${trapGrowth}\n  reason: "fixture harness trap transition"`,
  );
}

function runDiffCli(rows: { base: Row[]; cand: Row[] }, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-3303-cli-"));
  try {
    const basePath = join(dir, "base.jsonl");
    const candPath = join(dir, "cand.jsonl");
    writeFileSync(basePath, rows.base.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(candPath, rows.cand.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/diff-test262.ts", basePath, candPath, "--quiet"],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, TRAP_GROWTH_ALLOW_FILE: "/dev/null", ...env },
      },
    );
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a one-off allowance file and return its path (caller's tmp dir). */
function writeAllowanceFile(dir: string, count: number): string {
  const p = join(dir, "9999-fixture-allowance.md");
  writeFileSync(p, allowanceFileText(count));
  return p;
}

describe("#3303 — CLI gate behaviour (rebase-mode, REGRESSIONS_ALLOW_FILE hook)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "issue-3303-allow-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes at EXACTLY the declared count (30/30) with the excusal line", () => {
    const allowFile = writeAllowanceFile(tmp, 30);
    const r = runDiffCli(rebaseRows(30), { REGRESSIONS_ALLOW_FILE: allowFile });
    expect(r.out).toContain("=== Regressions with wasm-hash change: 30 ===");
    expect(r.out).toContain("regressions-allow (#3303): excused 30 of 30");
    expect(r.status).toBe(0);
  });

  it("FAILS at declared+1 (31 > 30) with a loud ceiling GATE FAIL", () => {
    const allowFile = writeAllowanceFile(tmp, 30);
    const r = runDiffCli(rebaseRows(31), { REGRESSIONS_ALLOW_FILE: allowFile });
    expect(r.out).toContain("GATE FAIL: regressions-allow ceiling exceeded (#3303)");
    expect(r.status).toBe(1);
  });

  it("does NOT alter the raw printed regression count (guards' fallback parse stays honest)", () => {
    const allowFile = writeAllowanceFile(tmp, 100);
    const r = runDiffCli(rebaseRows(40), { REGRESSIONS_ALLOW_FILE: allowFile });
    expect(r.out).toContain("=== Regressions with wasm-hash change: 40 ===");
    expect(r.status).toBe(0);
  });

  it("no allowance: #3086 drift tolerance still governs (25 passes, 26 fails)", () => {
    const ok = runDiffCli(rebaseRows(ORACLE_REBASE_DRIFT_TOLERANCE), { REGRESSIONS_ALLOW_FILE: "/dev/null" });
    expect(ok.status).toBe(0);
    expect(ok.out).toContain("Re-baseline gate (#3086)");
    const over = runDiffCli(rebaseRows(ORACLE_REBASE_DRIFT_TOLERANCE + 1), { REGRESSIONS_ALLOW_FILE: "/dev/null" });
    expect(over.out).toContain("exceeds drift tolerance");
    expect(over.status).toBe(1);
  });

  it("REBASE-MODE ONLY: without an oracle bump the allowance is inert (containment)", () => {
    const allowFile = writeAllowanceFile(tmp, 100);
    const r = runDiffCli(rebaseRows(3, { sameOracle: true }), { REGRESSIONS_ALLOW_FILE: allowFile });
    expect(r.out).not.toContain("regressions-allow (#3303): excused");
    expect(r.out).toContain("GATE FAIL: net_per_test");
    expect(r.status).toBe(1);
  });

  it("TRAP-RATCHET IMMUNITY: an allowance never excuses a new uncatchable trap (#3189)", () => {
    const allowFile = writeAllowanceFile(tmp, 100);
    const r = runDiffCli(rebaseRows(5, { traps: 1 }), {
      REGRESSIONS_ALLOW_FILE: allowFile,
      TRAP_RATCHET_TOLERANCE: "0",
    });
    expect(r.out).toMatch(/GATE FAIL: trap category "null_deref" grew/);
    expect(r.status).toBe(1);
  });

  it("allows measured trap growth only through a separate rebase-scoped ceiling (#3370)", () => {
    const allowFile = join(tmp, "9999-combined-allowance.md");
    writeFileSync(allowFile, combinedAllowanceFileText(100, 1));
    const r = runDiffCli(rebaseRows(5, { traps: 1 }), {
      REGRESSIONS_ALLOW_FILE: allowFile,
      TRAP_GROWTH_ALLOW_FILE: allowFile,
      TRAP_RATCHET_TOLERANCE: "0",
    });
    expect(r.out).toContain("trap-growth-allow (#3370): maximum category growth 1 within declared");
    expect(r.status).toBe(0);
  });

  it("fails when trap growth exceeds the separate declared ceiling (#3370)", () => {
    const allowFile = join(tmp, "9999-combined-overflow.md");
    writeFileSync(allowFile, combinedAllowanceFileText(100, 1));
    const r = runDiffCli(rebaseRows(5, { traps: 2 }), {
      REGRESSIONS_ALLOW_FILE: allowFile,
      TRAP_GROWTH_ALLOW_FILE: allowFile,
      TRAP_RATCHET_TOLERANCE: "0",
    });
    expect(r.out).toMatch(/GATE FAIL: trap category "null_deref" grew/);
    expect(r.status).toBe(1);
  });

  // #3596 SUPERSEDES the original "#3370 inert without an oracle bump" case.
  // The PROPERTY it protected is unchanged and still asserted below: a BARE
  // count:/reason: declaration grants nothing on a same-oracle PR. What changed
  // is only the mechanism — instead of never being read, the declaration is now
  // read and then REFUSED for being uncheckable, which fails with a message that
  // says what to do. The PR is blocked either way (status 1).
  it("a bare trap-growth-allow still grants nothing without an oracle bump (#3370/#3596)", () => {
    const allowFile = join(tmp, "9999-combined-same-oracle.md");
    writeFileSync(allowFile, combinedAllowanceFileText(100, 100));
    const r = runDiffCli(rebaseRows(1, { sameOracle: true, traps: 1 }), {
      REGRESSIONS_ALLOW_FILE: allowFile,
      TRAP_GROWTH_ALLOW_FILE: allowFile,
      TRAP_RATCHET_TOLERANCE: "0",
    });
    expect(r.out).toMatch(/must NAME the reclassified tests/);
    expect(r.status).toBe(1);
  });

  // #3596 — the load-bearing containment at CLI level. `rebaseRows`' trap rows
  // are `pass` on the baseline, so naming one is a REGRESSION claim, not a
  // reclassification, and must be refused even though the ceiling would cover it.
  it("refuses a named trap-growth-allow test that was passing on the baseline (#3596)", () => {
    const allowFile = join(tmp, "9999-named-but-passing.md");
    writeFileSync(
      allowFile,
      fm(
        `regressions-allow:\n  count: 100\n  reason: "fixture reclassification"\n` +
          `trap-growth-allow:\n  count: 100\n  reason: "fixture claim"\n  tests:\n    - test/trap0/a/b/c/t.js`,
      ),
    );
    const r = runDiffCli(rebaseRows(1, { sameOracle: true, traps: 1 }), {
      REGRESSIONS_ALLOW_FILE: allowFile,
      TRAP_GROWTH_ALLOW_FILE: allowFile,
      TRAP_RATCHET_TOLERANCE: "0",
    });
    expect(r.out).toMatch(/was "pass" on the baseline/);
    expect(r.out).toMatch(/REGRESSION, not a reclassification/);
    expect(r.status).toBe(1);
  });

  // #3596 — the case the valve exists for: a test that ALREADY failed and only
  // changed the flavour of its failure (fail → trap), correctly named.
  it("honours a named trap-growth-allow for a genuine fail→trap reclassification (#3596)", () => {
    const allowFile = join(tmp, "9999-named-reclass.md");
    writeFileSync(
      allowFile,
      fm(
        `trap-growth-allow:\n  count: 1\n  reason: "pre-existing latent trap, unmasked"\n` +
          `  tests:\n    - test/zip/a/b/c/t.js`,
      ),
    );
    const rows = {
      base: [
        {
          oracle_version: 1,
          file: "test/zip/a/b/c/t.js",
          status: "fail",
          error_category: "assertion_fail",
          wasm_sha: "z1",
        },
        {
          oracle_version: 1,
          file: "test/win/a/b/c/t.js",
          status: "fail",
          error_category: "assertion_fail",
          wasm_sha: "w1",
        },
      ],
      cand: [
        {
          oracle_version: 1,
          file: "test/zip/a/b/c/t.js",
          status: "fail",
          error_category: "null_deref",
          wasm_sha: "z2",
        },
        { oracle_version: 1, file: "test/win/a/b/c/t.js", status: "pass", wasm_sha: "w2" },
      ],
    };
    const r = runDiffCli(rows, { TRAP_GROWTH_ALLOW_FILE: allowFile, TRAP_RATCHET_TOLERANCE: "0" });
    expect(r.out).toMatch(/reclassification VERIFIED for 1 declared test/);
    expect(r.out).not.toMatch(/GATE FAIL/);
    expect(r.status).toBe(0);
  });

  // #3596 MODE-INDEPENDENCE. The declaration's own SHAPE selects the contract,
  // not the run mode. Motivation is concrete: #3583 declared a `tests:` list and
  // merged, but an oracle v10→v11 bump happened to be in flight, so the run took
  // the rebase path and the named list was never verified. Whether a PR lands
  // during a re-baseline is not something the author can predict, so identical
  // frontmatter must not receive weaker enforcement purely because of timing.
  describe("#3596 — a `tests:` list is enforced in BOTH modes", () => {
    const namedButPassingAllowance = (dir: string, name: string) => {
      const f = join(dir, name);
      writeFileSync(
        f,
        fm(
          `regressions-allow:\n  count: 100\n  reason: "fixture reclassification"\n` +
            `trap-growth-allow:\n  count: 100\n  reason: "fixture claim"\n  tests:\n    - test/trap0/a/b/c/t.js`,
        ),
      );
      return f;
    };

    // `rebaseRows`' trap rows are `pass` on the baseline, so naming one is a
    // REGRESSION claim. Before this change, rebase mode accepted it unchecked.
    it("REBASE mode: refuses a named test that was passing on the baseline", () => {
      const allowFile = namedButPassingAllowance(tmp, "9999-named-passing-rebase.md");
      const r = runDiffCli(rebaseRows(1, { traps: 1 }), {
        REGRESSIONS_ALLOW_FILE: allowFile,
        TRAP_GROWTH_ALLOW_FILE: allowFile,
        TRAP_RATCHET_TOLERANCE: "0",
      });
      expect(r.out).toMatch(/was "pass" on the baseline/);
      expect(r.status).toBe(1);
    });

    it("NON-REBASE mode: refuses the same declaration identically", () => {
      const allowFile = namedButPassingAllowance(tmp, "9999-named-passing-same-oracle.md");
      const r = runDiffCli(rebaseRows(1, { sameOracle: true, traps: 1 }), {
        REGRESSIONS_ALLOW_FILE: allowFile,
        TRAP_GROWTH_ALLOW_FILE: allowFile,
        TRAP_RATCHET_TOLERANCE: "0",
      });
      expect(r.out).toMatch(/was "pass" on the baseline/);
      expect(r.status).toBe(1);
    });

    // Backward compatibility, the reason this is shape-driven rather than
    // "always check": a BARE count with no `tests:` list is a valid #3370
    // declaration and must keep working in rebase mode. Making the check
    // unconditional would hard-fail these mid-re-baseline.
    it("REBASE mode: a bare count (no tests:) keeps #3370 semantics and is NOT checked", () => {
      const allowFile = join(tmp, "9999-bare-rebase.md");
      writeFileSync(allowFile, combinedAllowanceFileText(100, 1));
      const r = runDiffCli(rebaseRows(5, { traps: 1 }), {
        REGRESSIONS_ALLOW_FILE: allowFile,
        TRAP_GROWTH_ALLOW_FILE: allowFile,
        TRAP_RATCHET_TOLERANCE: "0",
      });
      expect(r.out).toContain("trap-growth-allow (#3370): maximum category growth 1 within declared");
      expect(r.out).not.toMatch(/must NAME the reclassified tests/);
      expect(r.status).toBe(0);
    });
  });

  it("resets compile-time gate signals when an oracle bump changes the harness workload (#3370)", () => {
    const allowFile = writeAllowanceFile(tmp, 100);
    const rows = {
      base: [{ oracle_version: 1, file: "test/x/a.js", status: "pass", compile_ms: 100, wasm_sha: "base" }],
      cand: [
        {
          oracle_version: 2,
          file: "test/x/a.js",
          status: "compile_timeout",
          compile_ms: 1000,
          wasm_sha: "candidate",
        },
      ],
    };
    const r = runDiffCli(rows, { REGRESSIONS_ALLOW_FILE: allowFile });
    expect(r.out).toContain("Compile timeouts (pass → compile_timeout): 0");
    expect(r.out).toContain("1 raw pass→compile_timeout transition(s) are not comparable");
    expect(r.out).toContain("Aggregate compile time (shared 1 tests): baseline 100ms → current 1000ms (Δ +0.0%)");
    expect(r.out).toContain("raw aggregate delta +900.0%");
    expect(r.status).toBe(0);
  });

  it("keeps compile-time gate signals unchanged for the same oracle", () => {
    const rows = {
      base: [{ oracle_version: 1, file: "test/x/a.js", status: "pass", compile_ms: 100, wasm_sha: "base" }],
      cand: [
        {
          oracle_version: 1,
          file: "test/x/a.js",
          status: "compile_timeout",
          compile_ms: 1000,
          wasm_sha: "candidate",
        },
      ],
    };
    const r = runDiffCli(rows, { REGRESSIONS_ALLOW_FILE: "/dev/null" });
    expect(r.out).toContain("Compile timeouts (pass → compile_timeout): 1");
    expect(r.out).toContain("Aggregate compile time (shared 1 tests): baseline 100ms → current 1000ms (Δ +900.0%)");
    expect(r.out).not.toContain("Oracle re-baseline compile-time note (#3370)");
    expect(r.status).toBe(0);
  });

  it("MALFORMED declaration (count without reason) is ignored with a loud warning", () => {
    const bad = join(tmp, "9999-malformed.md");
    writeFileSync(bad, fm("regressions-allow:\n  count: 100"));
    const r = runDiffCli(rebaseRows(ORACLE_REBASE_DRIFT_TOLERANCE + 5), { REGRESSIONS_ALLOW_FILE: bad });
    expect(r.out).toContain("MALFORMED declaration");
    expect(r.out).toContain("exceeds drift tolerance");
    expect(r.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Git change-set scoping (the REAL read path) in a temp repo
// ---------------------------------------------------------------------------

describe("#3303 — change-set-scoped allowance read (git)", () => {
  function makeRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "issue-3303-repo-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
      expect(r.status).toBe(0);
    };
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "base", "-q");
    mkdirSync(join(repo, "plan", "issues"), { recursive: true });
    return repo;
  }

  function runFromRepo(repo: string, rows: { base: Row[]; cand: Row[] }) {
    const basePath = join(repo, "base.jsonl");
    const candPath = join(repo, "cand.jsonl");
    writeFileSync(basePath, rows.base.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(candPath, rows.cand.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "scripts/diff-test262.ts"), basePath, candPath, "--quiet"],
      {
        cwd: repo,
        encoding: "utf-8",
        // LOC_GATE_BASE pins the diff base (change-scope.mjs env arm) so the
        // read exercises changedPaths(HEAD → worktree) incl. untracked files —
        // exactly how a PR's own new issue file is seen. REGRESSIONS_ALLOW_FILE
        // is cleared ("" = unset) so the git path is what's under test.
        env: { ...process.env, REGRESSIONS_ALLOW_FILE: "", LOC_GATE_BASE: "HEAD" },
      },
    );
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("reads the ceiling from an issue file in the change-set and names it in the excusal", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "plan", "issues", "9999-fixture.md"), allowanceFileText(40));
      const r = runFromRepo(repo, rebaseRows(40));
      expect(r.out).toContain("regressions-allow (#3303): excused 40 of 40");
      expect(r.out).toContain("plan/issues/9999-fixture.md");
      expect(r.status).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("no issue file in the change-set ⇒ no allowance ⇒ drift tolerance governs", () => {
    const repo = makeRepo();
    try {
      const r = runFromRepo(repo, rebaseRows(ORACLE_REBASE_DRIFT_TOLERANCE + 5));
      expect(r.out).toContain("exceeds drift tolerance");
      expect(r.status).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("malformed in-diff declaration warns and grants nothing", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "plan", "issues", "9999-bad.md"), fm("regressions-allow:\n  count: 100"));
      const r = runFromRepo(repo, rebaseRows(ORACLE_REBASE_DRIFT_TOLERANCE + 5));
      expect(r.out).toContain("MALFORMED declaration in plan/issues/9999-bad.md");
      expect(r.out).toContain("exceeds drift tolerance");
      expect(r.status).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Workflow-guard agreement — execute the REAL #1668/#1897 step bash
// ---------------------------------------------------------------------------

const WORKFLOW = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf-8");

/** Extract the dedented `run: |` body of the named step from the workflow. */
function extractRunBlock(stepName: string): string {
  const lines = WORKFLOW.split("\n");
  const nameIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  expect(nameIdx, `step "${stepName}" not found`).toBeGreaterThan(-1);
  let runIdx = -1;
  for (let i = nameIdx + 1; i < lines.length; i++) {
    if (/^\s+run: \|/.test(lines[i])) {
      runIdx = i;
      break;
    }
    if (/^\s+- name: /.test(lines[i])) break;
  }
  expect(runIdx, `run block for "${stepName}" not found`).toBeGreaterThan(-1);
  const runIndent = lines[runIdx].match(/^(\s*)/)![1].length;
  const raw: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      raw.push("");
      continue;
    }
    if (line.match(/^(\s*)/)![1].length <= runIndent) break;
    raw.push(line);
  }
  const minIndent = Math.min(...raw.filter((l) => l.trim() !== "").map((l) => l.match(/^(\s*)/)![1].length));
  return raw.map((l) => (l.trim() === "" ? "" : l.slice(minIndent))).join("\n");
}

function cannedDiffOutput(opts: { reg: number; imp: number; ct?: number }): string {
  return (
    [
      `=== Compile timeouts (pass → compile_timeout): ${opts.ct ?? 0} ===`,
      `=== Regressions excluding compile_timeout: ${opts.reg} ===`,
      `=== Regressions with wasm-hash change: ${opts.reg} ===`,
      `=== Improvements (other → pass): ${opts.imp} ===`,
      `=== Re-baseline gate (#3086): canned verdict line for the guard grep ===`,
    ].join("\n") + "\n"
  );
}

describe("#3303 — #1668/#1897 guards agree with diff-test262.ts's exit code (real YAML bash)", () => {
  let sandbox: string;
  let shimDir: string;
  let createdCatBaselines = false;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "issue-3303-guards-"));
    // The standalone guard requires a non-empty merged standalone JSONL in cwd.
    mkdirSync(join(sandbox, "merged-reports"), { recursive: true });
    writeFileSync(join(sandbox, "merged-reports", "test262-standalone-results-merged.jsonl"), "{}\n");
    // Plant a non-empty /tmp/cat-baselines so the guards' defensive
    // `git clone … || true` fails instantly on the non-empty destination
    // (no network) and both baseline-JSONL existence checks pass.
    if (!existsSync("/tmp/cat-baselines")) {
      createdCatBaselines = true;
      mkdirSync("/tmp/cat-baselines", { recursive: true });
    }
    if (!existsSync("/tmp/cat-baselines/test262-current.jsonl")) {
      writeFileSync("/tmp/cat-baselines/test262-current.jsonl", "{}\n");
    }
    if (!existsSync("/tmp/cat-baselines/test262-standalone-current.jsonl")) {
      writeFileSync("/tmp/cat-baselines/test262-standalone-current.jsonl", "{}\n");
    }
    // PATH-shimmed `npx`: emits $CANNED_DIFF_OUTPUT_FILE and exits
    // $CANNED_DIFF_EXIT — the guard captures it exactly like a real diff run.
    shimDir = join(sandbox, "shim");
    mkdirSync(shimDir);
    const shim = join(shimDir, "npx");
    writeFileSync(shim, `#!/bin/bash\ncat "$CANNED_DIFF_OUTPUT_FILE"\nexit "$CANNED_DIFF_EXIT"\n`);
    chmodSync(shim, 0o755);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (createdCatBaselines) rmSync("/tmp/cat-baselines", { recursive: true, force: true });
    rmSync("/tmp/cat-diff.txt", { force: true });
    rmSync("/tmp/standalone-diff.txt", { force: true });
  });

  function runGuard(stepName: string, diffExit: number, diffOutput: string) {
    const outFile = join(sandbox, "canned-out.txt");
    writeFileSync(outFile, diffOutput);
    const r = spawnSync("bash", ["-c", extractRunBlock(stepName)], {
      cwd: sandbox,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        CANNED_DIFF_OUTPUT_FILE: outFile,
        CANNED_DIFF_EXIT: String(diffExit),
        // Pinned below to match the step-level env in the YAML.
        CATASTROPHIC_REGRESSION_THRESHOLD: "200",
        STANDALONE_REGRESSION_TOLERANCE: "15",
        TEST262_SCOPE: "",
      },
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("the YAML still declares the thresholds this harness pins (200 / 15)", () => {
    expect(WORKFLOW).toContain('CATASTROPHIC_REGRESSION_THRESHOLD: "200"');
    expect(WORKFLOW).toContain('STANDALONE_REGRESSION_TOLERANCE: "15"');
  });

  it("merge-report checkout keeps fetch-depth 2 (HEAD^1 must resolve for the allowance read)", () => {
    // Without depth ≥ 2 the guards' regressions-allow read cannot resolve the
    // synthetic merge parent in merge_group/push and silently grants nothing.
    expect(WORKFLOW).toContain("#3303 — depth 2 (not the default 1)");
    expect(WORKFLOW).toContain("fetch-depth: 2");
  });

  describe("catastrophic guard (#1668)", () => {
    const NAME = "Catastrophic regression guard (#1668)";

    it("exit 0 + raw 2615 → PASSES (authoritative script verdict; the #3104 landing shape)", () => {
      const r = runGuard(NAME, 0, cannedDiffOutput({ reg: 2615, imp: 0 }));
      expect(r.out).toContain("authoritative");
      expect(r.status).toBe(0);
    });

    it("exit 1 + raw 2615 → FAILS (catastrophic threshold on a failed script gate)", () => {
      const r = runGuard(NAME, 1, cannedDiffOutput({ reg: 2615, imp: 0 }));
      expect(r.out).toContain("CATASTROPHIC test262 regression");
      expect(r.status).toBe(1);
    });

    it("exit 1 + raw 30 → PASSES (small fine-grained failure stays the regression-gate job's business)", () => {
      const r = runGuard(NAME, 1, cannedDiffOutput({ reg: 30, imp: 0 }));
      expect(r.out).toContain("left to the regression-gate job");
      expect(r.status).toBe(0);
    });

    it("exit 2 → propagates the script error", () => {
      const r = runGuard(NAME, 2, "oracle guard refusal\n");
      expect(r.status).toBe(2);
    });
  });

  describe("standalone guard (#1897)", () => {
    const NAME = "Standalone regression guard (#1897)";

    it("exit 0 + net −2615 → PASSES (authoritative script verdict)", () => {
      const r = runGuard(NAME, 0, cannedDiffOutput({ reg: 2615, imp: 0 }));
      expect(r.out).toContain("authoritative");
      expect(r.status).toBe(0);
    });

    it("exit 1 + net −16 → FAILS (below the −15 tolerance on a failed script gate)", () => {
      const r = runGuard(NAME, 1, cannedDiffOutput({ reg: 16, imp: 0 }));
      expect(r.out).toContain("STANDALONE test262 regression");
      expect(r.status).toBe(1);
    });

    it("exit 1 + net −10 → PASSES (within the −15 tolerance, pre-#3303 looseness preserved)", () => {
      const r = runGuard(NAME, 1, cannedDiffOutput({ reg: 10, imp: 0 }));
      expect(r.out).toContain("left to the regression-gate job");
      expect(r.status).toBe(0);
    });

    it("exit 2 → propagates the script error", () => {
      const r = runGuard(NAME, 2, "oracle guard refusal\n");
      expect(r.status).toBe(2);
    });
  });
});
