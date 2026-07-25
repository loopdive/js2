// #2910 — reconciliation of landing-page edition feature rows with the section
// headline. These tests pin the structural guarantees of
// `computeFeatureRowCounts` (the edition-sliced, `features:`-tag row source):
//   1. a row is the UNION of tests carrying any of its tags (a test with two of
//      the row's tags is counted once, never summed),
//   2. a row is scoped to its own edition (a tag shared across editions only
//      contributes within the row's edition),
//   3. a row is a strict SUBSET of its edition ⇒ a 100% edition ⇒ 100% rows,
//   4. an empty tag list, or a headline-only edition (≤ES3 / ES5), yields 0/0.
import { describe, expect, it } from "vitest";
import { computeFeatureRowCounts, editionStringToYear, type ClassifiedTest } from "../scripts/generate-editions.ts";

describe("editionStringToYear", () => {
  it("maps real edition labels to their edition years", () => {
    expect(editionStringToYear("ES5")).toBe(5);
    expect(editionStringToYear("ES2015")).toBe(2015);
    expect(editionStringToYear("ES2026")).toBe(2026);
    expect(editionStringToYear("Proposals")).toBe(-1);
    // No feature axis → undefined (headline-only).
    expect(editionStringToYear("Legacy / Deprecated")).toBeUndefined();
    expect(editionStringToYear("npm libraries")).toBeUndefined();
  });

  // (#3639) The two absence-of-evidence buckets are NOT editions. They must
  // resolve to negative sentinels, which the feature-row scorer treats as
  // headline-only (`yr <= 0`), so they can never present as a conformance
  // figure for an edition they were never measured against.
  it("maps the unclassified buckets to non-edition sentinels", () => {
    expect(editionStringToYear("Unclassified (legacy)")).toBe(-2);
    expect(editionStringToYear("Unclassified (untagged)")).toBe(-3);
  });

  // The old "≤ ES3" labels are still accepted so feature-example rows written
  // before the rename keep resolving — but they must NOT resolve to a positive
  // edition year any more. `toBe(0)` was the previous contract and is exactly
  // what this issue removes: 0 was a real edition key that rendered beside
  // measured editions.
  it("keeps legacy ES3 labels resolvable, but no longer as an edition", () => {
    for (const legacy of ["≤ ES3", "ES3 / Core", "ES3"]) {
      const yr = editionStringToYear(legacy);
      expect(yr).toBe(-2);
      expect(yr).toBeLessThan(0); // headline-only, never a feature-row edition
    }
  });
});

describe("computeFeatureRowCounts (#2910)", () => {
  it("counts a multi-tag test once per row (union, not sum)", () => {
    const tests: ClassifiedTest[] = [
      // Carries BOTH of the row's tags — must be counted once.
      { edition: 2022, features: ["class-fields-public", "class-fields-private"], status: "pass" },
      { edition: 2022, features: ["class-fields-private"], status: "fail" },
    ];
    const rows = computeFeatureRowCounts(
      tests,
      { "Class fields": ["class-fields-public", "class-fields-private"] },
      { "Class fields": 2022 },
    );
    expect(rows["Class fields"]).toEqual({ pass: 1, fail: 1, ce: 0, skip: 0, total: 2, pct: 50 });
  });

  it("scopes a shared tag to the row's own edition", () => {
    const tests: ClassifiedTest[] = [
      { edition: 2015, features: ["class"], status: "pass" }, // basic class → ES2015 row
      { edition: 2022, features: ["class"], status: "pass" }, // class w/ fields → ES2022, NOT the ES2015 row
      { edition: 2022, features: ["class"], status: "fail" },
    ];
    const rows = computeFeatureRowCounts(
      tests,
      { Classes: ["class"], "Class fields": ["class"] },
      { Classes: 2015, "Class fields": 2022 },
    );
    expect(rows["Classes"]).toEqual({ pass: 1, fail: 0, ce: 0, skip: 0, total: 1, pct: 100 });
    expect(rows["Class fields"]).toEqual({ pass: 1, fail: 1, ce: 0, skip: 0, total: 2, pct: 50 });
  });

  it("guarantees a 100% edition yields 100% rows (reconciliation invariant)", () => {
    // Every test in edition 2018 passes → each feature slice must read 100%.
    const tests: ClassifiedTest[] = [
      { edition: 2018, features: ["async-iteration"], status: "pass" },
      { edition: 2018, features: ["object-spread", "object-rest"], status: "pass" },
      { edition: 2018, features: ["object-rest"], status: "pass" },
    ];
    const rows = computeFeatureRowCounts(
      tests,
      { "Async iteration": ["async-iteration"], "Object spread / rest": ["object-spread", "object-rest"] },
      { "Async iteration": 2018, "Object spread / rest": 2018 },
    );
    for (const name of Object.keys(rows)) {
      if (rows[name]!.total > 0) expect(rows[name]!.pct).toBe(100);
    }
    // Union, deduped: 2 distinct tests carry object-spread/object-rest.
    expect(rows["Object spread / rest"]!.total).toBe(2);
  });

  it("never lets a row total exceed its edition population", () => {
    const tests: ClassifiedTest[] = [
      { edition: 2020, features: ["BigInt"], status: "pass" },
      { edition: 2020, features: ["BigInt"], status: "fail" },
      { edition: 2020, features: ["globalThis"], status: "pass" },
      { edition: 2020, features: [], status: "pass" }, // untagged — in headline, in no row
    ];
    const editionTotal = tests.length; // 4 tests classified into ES2020
    const rows = computeFeatureRowCounts(
      tests,
      { BigInt: ["BigInt"], globalThis: ["globalThis"] },
      { BigInt: 2020, globalThis: 2020 },
    );
    for (const name of Object.keys(rows)) {
      expect(rows[name]!.total).toBeLessThanOrEqual(editionTotal);
    }
    expect(rows["BigInt"]!.total).toBe(2);
    expect(rows["globalThis"]!.total).toBe(1);
  });

  it("treats empty tag lists and headline-only editions as 0/0", () => {
    const tests: ClassifiedTest[] = [
      { edition: 0, features: [], status: "pass" }, // ≤ES3 — no feature axis
      { edition: 5, features: ["caller"], status: "pass" }, // ES5 — headline-only
      { edition: 2015, features: ["arrow-function"], status: "pass" },
    ];
    const rows = computeFeatureRowCounts(
      tests,
      { Operators: [], "Arrow functions": ["arrow-function"] },
      { Operators: 0, "Arrow functions": 2015 },
    );
    // Empty tag list → intentional headline-only row.
    expect(rows["Operators"]).toEqual({ pass: 0, fail: 0, ce: 0, skip: 0, total: 0, pct: 0 });
    // ES5 tag "caller" is not mapped to any row → uncounted.
    expect(rows["Arrow functions"]!.total).toBe(1);
  });
});
