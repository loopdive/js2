import { describe, expect, it } from "vitest";
import { evaluateTrapCategoryGrowth, evaluateTrapReclassification } from "../scripts/diff-test262.ts";

// #3596 — the #3189 uncatchable-trap ratchet is a strict "traps may only
// shrink" gate. That is correct for a REGRESSION (pass → trap) but wrong for a
// RECLASSIFICATION (fail → fail, flavour changed) — typically a fix that makes
// a module compile far enough to reach a pre-existing latent trap. Two
// net-positive PRs (#3563 +11 pass, #3583 +16 pass) were parked on exactly that
// in one evening.
//
// These tests pin the property that makes it safe to honour a `trap-growth-allow`
// on an ordinary non-rebase PR: the claim is MACHINE-CHECKED, never trusted.

type Row = { status: string; error_category?: string; wasm_sha?: string | null };

const rows = (entries: [string, Row][]) => new Map<string, Row>(entries);

/** Baseline: `zip` already fails (not a trap); `ok.js` passes. */
const baseline = rows([
  ["test/built-ins/Iterator/zip/iterables-iteration.js", { status: "fail", wasm_sha: "aaa" }],
  ["test/ok.js", { status: "pass", wasm_sha: "bbb" }],
]);

/** Candidate: `zip` now traps with null_deref (same file, different binary). */
const candidate = rows([
  [
    "test/built-ins/Iterator/zip/iterables-iteration.js",
    { status: "fail", error_category: "null_deref", wasm_sha: "zzz" },
  ],
  ["test/ok.js", { status: "pass", wasm_sha: "bbb" }],
]);

const growthWith = (tolerance: number) =>
  evaluateTrapCategoryGrowth(baseline, candidate, tolerance, { missingBaselineRowsAreUnknown: true });

const allow = (over: Partial<{ count: number; reason: string; sources: string[]; tests: string[] }> = {}) => ({
  count: 1,
  reason: "pre-existing assert-harness null-deref, unmasked by the dispatcher fix (#3593)",
  sources: ["plan/issues/3596-example.md"],
  tests: ["test/built-ins/Iterator/zip/iterables-iteration.js"],
  ...over,
});

describe("#3596 trap-growth-allow on a non-rebase PR", () => {
  it("the strict ratchet still fails the reclassification when no allowance is declared", () => {
    const growth = growthWith(0);
    expect(growth.failures).toHaveLength(1);
    expect(growth.failures[0]).toMatch(/trap category "null_deref" grew 0 → 1/);
    expect(growth.failures[0]).toMatch(/iterables-iteration\.js/);
  });

  it("accepts a correctly-declared reclassification (fail → trap on a named, non-passing test)", () => {
    const growth = growthWith(1); // ceiling from the declared count
    expect(growth.failures).toEqual([]);
    const r = evaluateTrapReclassification({ allowance: allow(), baseline, growth });
    expect(r.failures).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/reclassification VERIFIED for 1 declared test/);
  });

  // THE load-bearing property: an allowance must never launder a real regression.
  it("REFUSES a test that was passing on the baseline — pass → trap is a regression, not a reclassification", () => {
    const passBaseline = rows([["test/ok.js", { status: "pass", wasm_sha: "bbb" }]]);
    const passCandidate = rows([["test/ok.js", { status: "fail", error_category: "null_deref", wasm_sha: "zzz" }]]);
    const growth = evaluateTrapCategoryGrowth(passBaseline, passCandidate, 1, {
      missingBaselineRowsAreUnknown: true,
    });
    expect(growth.failures).toEqual([]); // ceiling absorbs the count …
    const r = evaluateTrapReclassification({
      allowance: allow({ tests: ["test/ok.js"] }),
      baseline: passBaseline,
      growth,
    });
    // … but the machine-check refuses it.
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/was "pass" on the baseline/);
    expect(r.failures[0]).toMatch(/REGRESSION, not a reclassification/);
  });

  it("refuses a bare count with no named tests — an uncheckable claim is not a valid declaration", () => {
    const r = evaluateTrapReclassification({ allowance: allow({ tests: [] }), baseline, growth: growthWith(1) });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/must NAME the reclassified tests/);
  });

  it("refuses a named test with no baseline row — absence proves nothing either way", () => {
    const r = evaluateTrapReclassification({
      allowance: allow({ tests: ["test/never/seen.js"] }),
      baseline,
      growth: growthWith(1),
    });
    expect(r.failures.some((f) => /has NO baseline row/.test(f))).toBe(true);
  });

  it("refuses UNDECLARED trap growth — a count:1 cannot silently excuse an unrelated new trap", () => {
    const base2 = rows([
      ["test/a.js", { status: "fail", wasm_sha: "a1" }],
      ["test/b.js", { status: "fail", wasm_sha: "b1" }],
    ]);
    const cand2 = rows([
      ["test/a.js", { status: "fail", error_category: "null_deref", wasm_sha: "a2" }],
      ["test/b.js", { status: "fail", error_category: "oob", wasm_sha: "b2" }],
    ]);
    const growth = evaluateTrapCategoryGrowth(base2, cand2, 1, { missingBaselineRowsAreUnknown: true });
    expect(growth.failures).toEqual([]); // +1 in each of two categories, both within the ceiling
    const r = evaluateTrapReclassification({
      allowance: allow({ tests: ["test/a.js"] }), // only one of the two declared
      baseline: base2,
      growth,
    });
    expect(r.failures.some((f) => /NOT named in the declaration/.test(f) && /test\/b\.js/.test(f))).toBe(true);
  });

  it("reports every violation at once rather than stopping at the first", () => {
    const r = evaluateTrapReclassification({
      allowance: allow({ tests: ["test/ok.js", "test/never/seen.js"] }),
      baseline,
      growth: growthWith(1),
    });
    // pass-on-baseline + missing-row + undeclared-growth all surface together.
    expect(r.failures.length).toBeGreaterThanOrEqual(3);
    expect(r.notes).toEqual([]);
  });
});

describe("#3596 frontmatter parsing of the nested tests: list", () => {
  const parse = async (text: string) => {
    const { parseFrontmatterCountReason } = await import("../scripts/lib/change-scope.mjs");
    return parseFrontmatterCountReason(text, "trap-growth-allow");
  };

  it("reads a block-form tests: list alongside count/reason", async () => {
    const d = await parse(
      [
        "---",
        "id: 1",
        "trap-growth-allow:",
        "  count: 1",
        '  reason: "why"',
        "  tests:",
        "    - test/a.js",
        "    - test/b.js",
        "---",
      ].join("\n"),
    );
    expect(d).toMatchObject({ count: 1, reason: "why", tests: ["test/a.js", "test/b.js"] });
  });

  it("reads an inline tests: list", async () => {
    const d = await parse(
      ["---", "trap-growth-allow:", "  count: 2", '  reason: "why"', "  tests: [test/a.js, test/b.js]", "---"].join(
        "\n",
      ),
    );
    expect(d).toMatchObject({ count: 2, tests: ["test/a.js", "test/b.js"] });
  });

  // Backward compatibility with the #3303/#3370 declarations, which have no
  // tests: list and must keep parsing exactly as before.
  it("still parses a legacy count+reason declaration, yielding an empty tests list", async () => {
    const d = await parse(["---", "trap-growth-allow:", "  count: 3", '  reason: "oracle bump"', "---"].join("\n"));
    expect(d).toMatchObject({ count: 3, reason: "oracle bump", tests: [] });
  });

  it("still rejects a malformed declaration (count present, reason missing)", async () => {
    expect(await parse(["---", "trap-growth-allow:", "  count: 1", "---"].join("\n"))).toBeNull();
  });
});
