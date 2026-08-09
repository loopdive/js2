import { describe, it, expect } from "vitest";
import { evaluateTrapCategoryGrowth } from "../scripts/diff-test262.js";

// #4141 — a baseline `skip` row is the same "baseline can't testify" class as
// `compile_timeout` (#3189) and `compile_error` (#3595): a skipped test was
// never compiled and never instantiated, so the predecessor run made NO runtime
// observation of that file. It therefore cannot establish that the file was
// trap-free, and a candidate trap on it is *unknown*, not *introduced*.
//
// The concrete failure that motivated it: the baseline heal step
// (`heal-poison-rows.ts`, run only on the BASELINE path) executed without
// `TEST262_INCLUDE_PROPOSALS=1`, so re-running a poison `built-ins/Temporal/**`
// row classified it as an excluded proposal and rewrote its verdict to `skip`.
// The candidate JSONL is never healed and kept the same rows as traps. Result:
// `skip 1322 → 115 (−1207)` alongside `null_deref 156 → 1360 (+1204)`, with
// ZERO pass→trap transitions, charged to whichever PR was in the merge group —
// which parked two unrelated PRs (#4074, #4088) in different lanes with a
// byte-identical delta.
//
// The workflow fix removes the producer asymmetry; this exclusion is the
// defense in depth, and is correct independent of that bug for any skip reason.

type Row = { status: string; error_category?: string; wasm_sha?: string | null };
const mk = (rows: Record<string, Row>): Map<string, Row> => new Map(Object.entries(rows));

describe("#4141 — baseline `skip` is a can't-testify outcome, not trap growth", () => {
  it("treats skip → trap as an unknown baseline runtime outcome", () => {
    const base = mk({
      "null.js": { status: "skip" },
      "oob.js": { status: "skip" },
    });
    const cur = mk({
      "null.js": { status: "fail", error_category: "null_deref", wasm_sha: "null" },
      "oob.js": { status: "fail", error_category: "oob", wasm_sha: "oob" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toEqual([]);
    expect(r.newCounts.null_deref).toBe(0);
    expect(r.newCounts.oob).toBe(0);
    expect(r.unknownBaselineTimeouts.null_deref).toEqual(["null.js"]);
    expect(r.unknownBaselineTimeouts.oob).toEqual(["oob.js"]);
  });

  it("holds for a healer-laundered proposal skip specifically (the #4141 row shape)", () => {
    // The exact baseline row shape observed in `test262-current.jsonl`:
    // status "skip", poison_healed, and a proposal-exclusion error, on a file
    // the candidate reports as a real trap.
    const base = mk({
      "test/built-ins/Temporal/PlainDate/prototype/subtract/basic.js": { status: "skip", wasm_sha: null },
    });
    const cur = mk({
      "test/built-ins/Temporal/PlainDate/prototype/subtract/basic.js": {
        status: "fail",
        error_category: "null_deref",
        wasm_sha: "candidate",
      },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toEqual([]);
    expect(r.newCounts.null_deref).toBe(0);
  });

  it("neutralises a bulk phantom (scaled reconstruction of +1204 → 0)", () => {
    // 1,204 files the baseline skipped and the candidate traps on, plus a real
    // trap population that merely HOLDS. Before the fix this reported
    // `null_deref 0 → 1204`; after it, the ratchet sees no growth.
    const baseRows: Record<string, Row> = {};
    const curRows: Record<string, Row> = {};
    for (let i = 0; i < 1204; i++) {
      const f = `test/built-ins/Temporal/t${i}.js`;
      baseRows[f] = { status: "skip", wasm_sha: null };
      curRows[f] = { status: "fail", error_category: "null_deref", wasm_sha: `c${i}` };
    }
    // A pre-existing, still-present trap: population holds at 1.
    baseRows["held.js"] = { status: "fail", error_category: "null_deref", wasm_sha: "h" };
    curRows["held.js"] = { status: "fail", error_category: "null_deref", wasm_sha: "h2" };

    const r = evaluateTrapCategoryGrowth(mk(baseRows), mk(curRows));
    expect(r.baseCounts.null_deref).toBe(1);
    expect(r.newCounts.null_deref).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.unknownBaselineTimeouts.null_deref).toHaveLength(1204);
  });

  // The other direction. Loosening a ratchet can hide the very trap explosion
  // the gate exists to catch, so pin that the exclusion is NARROW: only the
  // baseline-never-ran case is excused.
  it("still FAILS on a genuine pass → trap transition alongside skip unknowns", () => {
    const base = mk({
      "skipped.js": { status: "skip" },
      "observed.js": { status: "pass", wasm_sha: "before" },
    });
    const cur = mk({
      "skipped.js": { status: "fail", error_category: "null_deref", wasm_sha: "s" },
      "observed.js": { status: "fail", error_category: "null_deref", wasm_sha: "after" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('null_deref" grew 0 → 1');
    expect(r.newlyTrapping.null_deref).toEqual(["observed.js"]);
    expect(r.unknownBaselineTimeouts.null_deref).toEqual(["skipped.js"]);
  });

  it("still FAILS on a genuine fail → trap transition (skip exclusion does not generalise)", () => {
    const base = mk({ "observed.js": { status: "fail", error_category: "assertion_fail", wasm_sha: "before" } });
    const cur = mk({ "observed.js": { status: "fail", error_category: "null_deref", wasm_sha: "after" } });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('null_deref" grew 0 → 1');
  });

  it("a bulk skip-unknown bucket does not mask a real trap explosion hiding inside it", () => {
    // 500 legitimately-unknown skip rows PLUS 5 real pass→trap regressions.
    // The gate must still fail, and must name only the 5 observed ones.
    const baseRows: Record<string, Row> = {};
    const curRows: Record<string, Row> = {};
    for (let i = 0; i < 500; i++) {
      baseRows[`skipped${i}.js`] = { status: "skip" };
      curRows[`skipped${i}.js`] = { status: "fail", error_category: "unreachable", wasm_sha: `s${i}` };
    }
    for (let i = 0; i < 5; i++) {
      baseRows[`real${i}.js`] = { status: "pass", wasm_sha: `b${i}` };
      curRows[`real${i}.js`] = { status: "fail", error_category: "unreachable", wasm_sha: `a${i}` };
    }
    const r = evaluateTrapCategoryGrowth(mk(baseRows), mk(curRows));
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('unreachable" grew 0 → 5');
    expect(r.newlyTrapping.unreachable.sort()).toEqual(["real0.js", "real1.js", "real2.js", "real3.js", "real4.js"]);
  });
});
