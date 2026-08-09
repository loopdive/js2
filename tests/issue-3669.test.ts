// #3669 — property slot monomorphism.
//
// A slot seeded with an UNBOXED PRIMITIVE (number / boolean) corrupts when
// written with a REFERENCE-kind value (string / null / object). The read-back
// is self-unequal (the sNaN-like type-default sentinel #2760 names) while
// `typeof` reports the new kind — so the write partially lands.
//
// WHY THIS RUNS THROUGH THE ASSEMBLED HARNESS AND NOT A BARE compile():
// measured 2026-07-26, bare `compile()` disagrees with the harness lane on two
// cells — `bool->number` is BROKEN under the harness but OK under bare compile,
// and `bool->undefined` is the reverse. `bool->number` is one half of the
// `num->bool` works / `bool->num` fails asymmetry, i.e. the most diagnostic
// cell in the matrix, so a fast unit test would silently pass exactly the case
// that matters most. Do not "optimise" these onto compile().
import { describe, expect, it } from "vitest";
import { resolve } from "path";
import { runTest262File } from "./test262-runner.js";

const FIXTURES = resolve(__dirname, "..", "scripts", "fixtures", "issue-3669-monomorphism");
const TIMEOUT = 120_000;
const ARRAY_GENERIC_NONTRAP_CASES = [
  "built-ins/Array/prototype/join/S15.4.4.5_A2_T1.js",
  "built-ins/Array/prototype/pop/S15.4.4.6_A2_T1.js",
  "built-ins/Array/prototype/shift/S15.4.4.9_A2_T1.js",
];

/**
 * Each fixture always throws a Test262Error carrying a report of `<arm>:ok` /
 * `<arm>:BROKEN` tokens, so one run yields every arm's verdict. We assert on
 * the tokens rather than on pass/fail, because the fixture is a reporter.
 */
async function armVerdicts(fixture: string): Promise<Map<string, string>> {
  const r = await runTest262File(resolve(FIXTURES, fixture), "probe", TIMEOUT);
  const text = String(r.error ?? r.reason ?? "");
  const verdicts = new Map<string, string>();
  // Capture ANY token value, not just ok/BROKEN — arms like
  // `third-write:still-broken` and `corrupt:self-unequal` report their own
  // vocabulary, and a regex that silently skipped them would make the
  // assertions below vacuously pass.
  for (const m of text.matchAll(/([A-Za-z0-9.>_-]+):([A-Za-z0-9-]+)/g)) {
    verdicts.set(m[1]!, m[2]!);
  }
  return verdicts;
}

function expectArm(v: Map<string, string>, arm: string, want: "ok" | "BROKEN"): void {
  expect(v.get(arm), `arm ${arm} missing from report — probe did not reach it`).toBeDefined();
  expect(v.get(arm), `arm ${arm}`).toBe(want);
}

describe("#3669 property slot monomorphism", () => {
  it.each(ARRAY_GENERIC_NONTRAP_CASES)(
    "does not turn an anticipated undefined/null slot into a null receiver: %s",
    async (relativePath) => {
      const result = await runTest262File(
        resolve(__dirname, "..", "test262", "test", relativePath),
        "built-ins/Array",
        TIMEOUT,
      );
      expect(["pass", "fail"], "the exact case must execute rather than skip or fail compilation").toContain(
        result.status,
      );
      expect(String(result.error ?? "")).not.toContain("dereferencing a null pointer");
    },
    TIMEOUT,
  );

  it(
    "reports every arm and its own positive control",
    async () => {
      const v = await armVerdicts("transitions.js");
      // THE INSTRUMENT'S OWN CONTROL. If this is absent or wrong, the fixture
      // never ran and every assertion below is vacuous.
      expectArm(v, "CTL0", "ok");
      expect(v.size, "expected many arms in the report").toBeGreaterThan(15);
    },
    TIMEOUT,
  );

  it(
    "same-kind overwrites work (controls — these must never regress)",
    async () => {
      const v = await armVerdicts("transitions.js");
      expectArm(v, "C.num>num", "ok");
      expectArm(v, "C.str>str", "ok");
      expectArm(v, "C.bool>bool", "ok");
      expectArm(v, "C.literal-str>str", "ok");
    },
    TIMEOUT,
  );

  it(
    "a NUMBER-seeded slot accepts a reference-kind write",
    async () => {
      const v = await armVerdicts("transitions.js");
      expectArm(v, "num>str", "ok");
      expectArm(v, "num>null", "ok");
      expectArm(v, "num>obj", "ok");
    },
    TIMEOUT,
  );

  // KNOWN REMAINING GAP — a NON-EMPTY object literal (`var o = {p: 1}`) takes a
  // different code path from the `var o = {}` + sibling-assignment widening
  // pre-pass this issue fixes, so its field type is still first-write-wins.
  //
  // `it.fails` is deliberate: it does NOT assert that the broken behaviour is
  // correct (which would freeze a bug into CI). It records a known-failing
  // expectation, and vitest ERRORS when it starts passing — so whoever closes
  // the literal path is told to delete this block rather than discovering it by
  // accident. See #3671.
  it.fails(
    "KNOWN GAP (#3671): a non-empty object literal's slot is still monomorphic",
    async () => {
      const v = await armVerdicts("transitions.js");
      expectArm(v, "literal-num>str", "ok");
    },
    TIMEOUT,
  );

  it(
    "a BOOLEAN-seeded slot accepts number and reference-kind writes",
    async () => {
      const v = await armVerdicts("bool-row.js");
      expectArm(v, "CTL0", "ok");
      // bool>num is the single most diagnostic cell: it is BROKEN under the
      // harness but OK under a bare compile(), so it only fails here.
      expectArm(v, "bool>num", "ok");
      expectArm(v, "bool>null", "ok");
      expectArm(v, "bool>obj", "ok");
      // `bool>str` is measured in transitions.js, not bool-row.js.
      const t = await armVerdicts("transitions.js");
      expectArm(t, "bool>str", "ok");
    },
    TIMEOUT,
  );

  it(
    "transitions that already work must KEEP working (regression sentinels)",
    async () => {
      // An over-broad widening fix could break these. They pass today; a fix
      // that trades them for the broken cells is a net loss, not a win.
      const v = await armVerdicts("transitions.js");
      expectArm(v, "num>bool", "ok");
      expectArm(v, "num>undef", "ok");
      expectArm(v, "str>num", "ok");
      expectArm(v, "str>bool", "ok");
      expectArm(v, "str>obj", "ok");
      expectArm(v, "obj>num", "ok");
      expectArm(v, "obj>str", "ok");

      const b = await armVerdicts("bool-row.js");
      expectArm(b, "bool>undef", "ok");
      expectArm(b, "C.str>null", "ok");
      expectArm(b, "C.obj>null", "ok");
      expectArm(b, "num>undef", "ok");
      expectArm(b, "num>bool", "ok");
    },
    TIMEOUT,
  );

  // The two broadest invariants of the surviving rule:
  //   "unboxed-primitive seed + reference-kind write corrupts;
  //    reference seeds never corrupt; `undefined` writes always work."
  // These are the cheapest tripwires for an over-widening fix. If either
  // breaks, the fix has widened something it should not have — and unlike the
  // per-cell sentinels above, these two are stated as rules, so they also
  // cover cells nobody has measured yet.
  it(
    "INVARIANT: an `undefined` write always works, whatever the seed",
    async () => {
      const v = await armVerdicts("transitions.js");
      expectArm(v, "num>undef", "ok");
      const b = await armVerdicts("bool-row.js");
      expectArm(b, "bool>undef", "ok");
      expectArm(b, "num>undef", "ok");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT: a reference-seeded slot never corrupts",
    async () => {
      const v = await armVerdicts("transitions.js");
      for (const arm of ["str>num", "str>bool", "str>obj", "obj>num", "obj>str"]) {
        expectArm(v, arm, "ok");
      }
      const b = await armVerdicts("bool-row.js");
      expectArm(b, "C.str>null", "ok");
      expectArm(b, "C.obj>null", "ok");
    },
    TIMEOUT,
  );

  it(
    "the defect is per-slot, not per-shape, and the slot recovers",
    async () => {
      const v = await armVerdicts("transitions.js");
      // Already true today — an identically-built sibling is unaffected.
      expectArm(v, "shape-sibling", "ok");
      // Currently reports `third-write:still-broken`; after the fix the slot
      // must accept a later same-kind write. Assert the arm was REACHED, so a
      // missing token fails loudly instead of passing by absence.
      expect(v.get("third-write"), "third-write arm missing from report").toBeDefined();
      expect(v.get("third-write")).toBe("recovers");
    },
    TIMEOUT,
  );
});
