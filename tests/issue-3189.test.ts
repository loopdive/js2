import { describe, it, expect } from "vitest";
import { TRAP_ERROR_CATEGORIES, evaluateTrapCategoryGrowth } from "../scripts/diff-test262.js";

// #3189 — uncatchable-trap GROWTH ratchet. The four trap categories
// (null_deref / illegal_cast / oob / unreachable) may only shrink or hold: any
// growth in any category fails the gate independent of net_per_test, because a
// trap escapes try/catch and poisons the whole test file (#3179). These unit
// tests pin the pure ratchet logic (mirrors #1943's threshold tests).

type Row = { status: string; error_category?: string; wasm_sha?: string | null };
const mk = (rows: Record<string, Row>): Map<string, Row> => new Map(Object.entries(rows));

describe("#3189 — trap-category growth ratchet", () => {
  it("exposes the four uncatchable-trap categories", () => {
    expect([...TRAP_ERROR_CATEGORIES]).toEqual(["null_deref", "illegal_cast", "oob", "unreachable"]);
  });

  it("passes when trap population holds", () => {
    const base = mk({
      "a.js": { status: "fail", error_category: "illegal_cast", wasm_sha: "aa" },
      "b.js": { status: "pass", wasm_sha: "bb" },
    });
    const cur = mk({
      "a.js": { status: "fail", error_category: "illegal_cast", wasm_sha: "aa2" },
      "b.js": { status: "pass", wasm_sha: "bb" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toEqual([]);
    expect(r.newCounts.illegal_cast).toBe(1);
    expect(r.baseCounts.illegal_cast).toBe(1);
  });

  it("passes (banks) when trap population shrinks", () => {
    const base = mk({
      "a.js": { status: "fail", error_category: "null_deref", wasm_sha: "aa" },
      "b.js": { status: "fail", error_category: "null_deref", wasm_sha: "bb" },
    });
    const cur = mk({
      "a.js": { status: "pass", wasm_sha: "aa2" },
      "b.js": { status: "fail", error_category: "null_deref", wasm_sha: "bb2" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toEqual([]);
    expect(r.baseCounts.null_deref).toBe(2);
    expect(r.newCounts.null_deref).toBe(1);
  });

  it("FAILS when a trap category grows, naming the newly-trapping files", () => {
    const base = mk({
      "a.js": { status: "fail", error_category: "assertion_fail", wasm_sha: "aa" },
      "b.js": { status: "pass", wasm_sha: "bb" },
    });
    const cur = mk({
      // a.js: assertion_fail → illegal_cast (a new trap where there was none)
      "a.js": { status: "fail", error_category: "illegal_cast", wasm_sha: "aa2" },
      // b.js: pass → illegal_cast (a new trap), different wasm so not noise
      "b.js": { status: "fail", error_category: "illegal_cast", wasm_sha: "bb2" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("illegal_cast");
    expect(r.failures[0]).toContain("0 → 2");
    expect(r.failures[0]).toContain("a.js");
    expect(r.failures[0]).toContain("b.js");
    expect(r.newlyTrapping.illegal_cast.sort()).toEqual(["a.js", "b.js"]);
  });

  it("blocks a NET-POSITIVE PR that trades assertion-fails for new traps", () => {
    // Baseline: 3 assertion fails, 0 traps. Candidate: fixes all 3 fails but
    // introduces 2 new oob traps. net_per_test is +1, so the ordinary gate would
    // pass — the trap ratchet must still block it.
    const base = mk({
      "f1.js": { status: "fail", error_category: "assertion_fail", wasm_sha: "1" },
      "f2.js": { status: "fail", error_category: "assertion_fail", wasm_sha: "2" },
      "f3.js": { status: "fail", error_category: "assertion_fail", wasm_sha: "3" },
    });
    const cur = mk({
      "f1.js": { status: "pass", wasm_sha: "1b" },
      "f2.js": { status: "pass", wasm_sha: "2b" },
      "f3.js": { status: "pass", wasm_sha: "3b" },
      "t1.js": { status: "fail", error_category: "oob", wasm_sha: "t1" },
      "t2.js": { status: "fail", error_category: "oob", wasm_sha: "t2" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures.some((f) => f.includes("oob") && f.includes("0 → 2"))).toBe(true);
  });

  it("ignores a byte-identical (same wasm_sha) pass→trap flip as CI noise", () => {
    const base = mk({ "n.js": { status: "pass", wasm_sha: "same" } });
    const cur = mk({ "n.js": { status: "fail", error_category: "unreachable", wasm_sha: "same" } });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toEqual([]);
    expect(r.newCounts.unreachable).toBe(0);
  });

  it("counts a genuinely new trap on a CHANGED binary (different wasm_sha)", () => {
    const base = mk({ "n.js": { status: "pass", wasm_sha: "old" } });
    const cur = mk({ "n.js": { status: "fail", error_category: "unreachable", wasm_sha: "new" } });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.newCounts.unreachable).toBe(1);
  });

  it("treats compile_timeout → trap as an unknown baseline runtime outcome", () => {
    const base = mk({
      "null.js": { status: "compile_timeout" },
      "oob.js": { status: "compile_timeout" },
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

  it("does not let a timeout-unknown trap hide genuine observed trap growth", () => {
    const base = mk({
      "unknown.js": { status: "compile_timeout" },
      "observed.js": { status: "pass", wasm_sha: "before" },
    });
    const cur = mk({
      "unknown.js": { status: "fail", error_category: "null_deref", wasm_sha: "unknown" },
      "observed.js": { status: "fail", error_category: "null_deref", wasm_sha: "after" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('null_deref" grew 0 → 1');
    expect(r.newlyTrapping.null_deref).toEqual(["observed.js"]);
    expect(r.unknownBaselineTimeouts.null_deref).toEqual(["unknown.js"]);
  });

  // (#3595) A `compile_error` baseline is the same class of can't-testify as a
  // `compile_timeout`: an invalid-Wasm module never instantiated, so
  // `__module_init` never ran and never had the chance to trap. Evidence: the
  // #3593 minimized repro traps IDENTICALLY with and without the PR that made
  // the file compile — the trap pre-existed the change that merely reached it.
  it("(#3595) treats compile_error → trap as an unknown baseline runtime outcome", () => {
    const base = mk({
      "null.js": { status: "compile_error", error_category: "wasm_compile" },
      "oob.js": { status: "compile_error", error_category: "wasm_compile" },
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

  // The other direction — the exclusion MUST NOT blind the gate to real
  // regressions. A baseline that actually ran (pass/fail) and now traps is
  // still a hard failure. Getting this wrong permissively would be worse than
  // the problem the exclusion solves.
  it("(#3595) still FAILS on a genuine pass → trap transition", () => {
    const base = mk({ "observed.js": { status: "pass", wasm_sha: "before" } });
    const cur = mk({ "observed.js": { status: "fail", error_category: "null_deref", wasm_sha: "after" } });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('null_deref" grew 0 → 1');
    expect(r.newlyTrapping.null_deref).toEqual(["observed.js"]);
  });

  it("(#3595) still FAILS on a genuine fail → trap transition", () => {
    const base = mk({ "observed.js": { status: "fail", error_category: "assertion_fail", wasm_sha: "before" } });
    const cur = mk({ "observed.js": { status: "fail", error_category: "null_deref", wasm_sha: "after" } });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('null_deref" grew 0 → 1');
    expect(r.newlyTrapping.null_deref).toEqual(["observed.js"]);
  });

  it("(#3595) a compile_error-unknown trap does not hide genuine observed growth", () => {
    const base = mk({
      "unknown.js": { status: "compile_error", error_category: "wasm_compile" },
      "observed.js": { status: "pass", wasm_sha: "before" },
    });
    const cur = mk({
      "unknown.js": { status: "fail", error_category: "null_deref", wasm_sha: "unknown" },
      "observed.js": { status: "fail", error_category: "null_deref", wasm_sha: "after" },
    });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('null_deref" grew 0 → 1');
    expect(r.newlyTrapping.null_deref).toEqual(["observed.js"]);
    expect(r.unknownBaselineTimeouts.null_deref).toEqual(["unknown.js"]);
  });

  it("honours a per-category tolerance (operational safety valve)", () => {
    const base = mk({ "x.js": { status: "pass", wasm_sha: "x" } });
    const cur = mk({
      "x.js": { status: "fail", error_category: "oob", wasm_sha: "x2" },
      "y.js": { status: "fail", error_category: "oob", wasm_sha: "y2" },
    });
    // Growth of 2 with tolerance 2 → within ratchet (no failure).
    expect(evaluateTrapCategoryGrowth(base, cur, 2).failures).toEqual([]);
    // Growth of 2 with tolerance 1 → fails.
    expect(evaluateTrapCategoryGrowth(base, cur, 1).failures).toHaveLength(1);
  });

  it("treats a lateral trap move (illegal_cast → null_deref) as null_deref growth", () => {
    // Per #3189: growth in ANY trap category fails, even if total trap count is
    // flat — the crash-free goal ratchets per-category. (A lateral move banks on
    // the next promote once the baseline picks up the new distribution.)
    const base = mk({ "x.js": { status: "fail", error_category: "illegal_cast", wasm_sha: "x" } });
    const cur = mk({ "x.js": { status: "fail", error_category: "null_deref", wasm_sha: "x2" } });
    const r = evaluateTrapCategoryGrowth(base, cur);
    expect(r.failures.some((f) => f.includes("null_deref"))).toBe(true);
    expect(r.baseCounts.illegal_cast).toBe(1);
    expect(r.newCounts.null_deref).toBe(1);
  });
});
