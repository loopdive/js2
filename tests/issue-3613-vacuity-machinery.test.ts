// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) Unit tests for the anti-vacuity MACHINERY itself:
//   • scripts/lib/verifier-guard.mjs        — the vacuous-verifier guard
//   • scripts/detect-vacuity.ts             — the standing detector's pure parts
//   • scripts/diff-test262.ts               — the guard wired into the trap-frame check
//   • scripts/check-test-vacuity-shapes.ts  — OUR OWN tests can pass vacuously too
//
// These are cheap, hermetic and need no test262 inputs, so they can guard the
// detector even when the corpus is not checked out. The behavioural half (does
// the ORACLE reach the right verdict) lives in
// tests/test262-harness-truth-table.test.ts.
import { describe, expect, it } from "vitest";
import { ALLOW_MARKER, findVacuityShapes, scanRepoTests } from "../scripts/check-test-vacuity-shapes.ts";
import { evaluateDevacuificationAllowance } from "../scripts/diff-test262.ts";
import {
  PROBE_MARKER,
  VACUITY_PROBE,
  injectVacuityProbe,
  probeEligibility,
  seededSample,
} from "../scripts/detect-vacuity.ts";
import {
  VACUOUS_VERIFIER_MIN_POPULATION,
  assertVerifierNotVacuous,
  checkVerifierCoverage,
  guardedFilter,
  warnIfVerifierVacuous,
} from "../scripts/lib/verifier-guard.mjs";

describe("#3613 vacuous-verifier guard", () => {
  it("flags a checker that answered for 0 of a non-empty population", () => {
    const r = checkVerifierCoverage({ name: "trapInnermostFrame", population: 65, verified: 0 });
    expect(r.vacuous).toBe(true);
    expect(r.message).toMatch(/VACUOUS VERIFIER/);
    // The message must say what to suspect FIRST — a bare "0 verified" is the
    // silent zero this guard exists to replace.
    expect(r.message).toMatch(/BROKEN CHECKER/);
    expect(r.message).toMatch(/#3601/);
  });

  it("does NOT flag a checker that answered for at least one input", () => {
    expect(checkVerifierCoverage({ name: "x", population: 65, verified: 1 }).vacuous).toBe(false);
    expect(checkVerifierCoverage({ name: "x", population: 65, verified: 65 }).vacuous).toBe(false);
  });

  it("does NOT flag an EMPTY population — nothing to verify is not the same as verifying nothing", () => {
    const r = checkVerifierCoverage({ name: "x", population: 0, verified: 0 });
    expect(r.vacuous).toBe(false);
    expect(r.message).toBeNull();
  });

  it("tolerates a population below the minimum (one unparseable row is not a broken parser)", () => {
    expect(
      checkVerifierCoverage({ name: "x", population: VACUOUS_VERIFIER_MIN_POPULATION - 1, verified: 0 }).vacuous,
    ).toBe(false);
    expect(checkVerifierCoverage({ name: "x", population: VACUOUS_VERIFIER_MIN_POPULATION, verified: 0 }).vacuous).toBe(
      true,
    );
  });

  it("warnIfVerifierVacuous is LOUD (writes to the log channel) and returns the banner", () => {
    const lines: string[] = [];
    const msg = warnIfVerifierVacuous({ name: "x", population: 10, verified: 0 }, { log: (m) => lines.push(m) });
    expect(msg).toBeTruthy();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(msg);
    // and silent when there is nothing to say
    const quiet: string[] = [];
    expect(warnIfVerifierVacuous({ name: "x", population: 10, verified: 3 }, { log: (m) => quiet.push(m) })).toBeNull();
    expect(quiet).toHaveLength(0);
  });

  it("assertVerifierNotVacuous throws, for callers whose whole output would be the silent zero", () => {
    expect(() => assertVerifierNotVacuous({ name: "probe", population: 40, verified: 0 })).toThrow(/VACUOUS VERIFIER/);
    expect(() => assertVerifierNotVacuous({ name: "probe", population: 40, verified: 40 })).not.toThrow();
  });

  // The reusable form. It exists so a gate author CANNOT forget the guard: the
  // warning comes back from the same call that produces the filtered set,
  // instead of being a separate step someone has to remember.
  describe("guardedFilter — the reusable form for any gate", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

    it("partitions AND warns when the predicate answers for none of a non-empty set", () => {
      const r = guardedFilter(rows, () => false, { name: "someParser", quiet: true });
      expect(r.matched).toEqual([]);
      expect(r.unmatched).toHaveLength(4);
      expect(r.warning).toMatch(/VACUOUS VERIFIER/);
      expect(r.warning).toMatch(/someParser/);
      expect(r.rate).toBe(0);
    });

    it("stays quiet when the predicate answers for at least one", () => {
      const r = guardedFilter(rows, (x) => x.id === 2, { name: "someParser", quiet: true });
      expect(r.matched).toEqual([{ id: 2 }]);
      expect(r.warning).toBeNull();
      expect(r.rate).toBe(0.25);
    });

    it("stays quiet on an EMPTY population — nothing to verify is not verifying nothing", () => {
      const r = guardedFilter([], () => false, { name: "someParser", quiet: true });
      expect(r.warning).toBeNull();
    });

    it("is LOUD by default (the whole point) and routes through the log channel", () => {
      const lines: string[] = [];
      guardedFilter(rows, () => false, { name: "someParser", log: (m) => lines.push(m) });
      expect(lines).toHaveLength(1);
    });
  });
});

describe("#3613 the guard is wired into the trap-frame verifier (#3601 regression)", () => {
  const allowance = {
    count: 100,
    reason: "test",
    sources: ["plan/issues/3613-test262-machinery-vacuity-guards.md"],
    tests: ["a.js", "b.js", "c.js"],
  };

  // The #3601 shape: every trap row carries a frame the parser cannot read
  // (here: a hypothetical THIRD renderer). Before #3613 this returned a silent
  // "0 verified"; the excusal correctly refused, but nobody was told WHY.
  const unparseableTraps = ["a.js", "b.js", "c.js"].map((file) => ({
    file,
    to: "fail",
    error: `illegal cast <<in ${file}_leaf() from someOtherRenderer>>`,
    error_category: "illegal_cast",
  }));

  it("warns LOUDLY when the frame parser can answer for none of the trap candidates", () => {
    const r = evaluateDevacuificationAllowance({ allowance, candidates: unparseableTraps });
    expect(r.notes.join("\n")).toMatch(/VACUOUS VERIFIER/);
    expect(r.notes.join("\n")).toMatch(/trapInnermostFrame/);
    // Conservative behaviour is unchanged: an unverifiable trap is still refused.
    expect(r.excusedFiles.size).toBe(0);
  });

  it("stays quiet when the parser CAN read the frames (both known grammars)", () => {
    const parseable = [
      {
        file: "a.js",
        to: "fail",
        error: "illegal cast in __closure_57() at source L618 (via __call_fn_method_3@L24)",
        error_category: "illegal_cast",
      },
      {
        file: "b.js",
        to: "fail",
        error: "dereferencing a null pointer [in __closure_38() ← __apply_closure]",
        error_category: "null_deref",
      },
      {
        file: "c.js",
        to: "fail",
        error: "illegal cast in __closure_12() at source L1",
        error_category: "illegal_cast",
      },
    ];
    const r = evaluateDevacuificationAllowance({ allowance, candidates: parseable });
    expect(r.notes.join("\n")).not.toMatch(/VACUOUS VERIFIER/);
    expect([...r.excusedFiles].sort()).toEqual(["a.js", "b.js", "c.js"]);
  });

  it("stays quiet when there are no trap candidates at all (empty population)", () => {
    const r = evaluateDevacuificationAllowance({
      allowance,
      candidates: [{ file: "a.js", to: "fail", error: "Test262Error: nope", error_category: "assertion_fail" }],
    });
    expect(r.notes.join("\n")).not.toMatch(/VACUOUS VERIFIER/);
  });
});

describe("#3613 vacuity probe injection", () => {
  const SRC = `/*---\ndescription: x\n---*/\nassert.sameValue(1, 1);\n`;

  it("injects a CONDITIONAL throw — never a bare top-level ThrowStatement", () => {
    // #3592 RC1 dropped an unconditional top-level `throw` entirely, which is
    // what produced the spurious "43/43 vacuous" reading. The probe must be
    // nested inside an `if` so it is structurally immune to that collector bug.
    expect(VACUITY_PROBE).toMatch(/^\s*if \(/m);
    expect(VACUITY_PROBE).toContain("throw new Test262Error");
    // The throw must not be the statement's own top-level form.
    expect(VACUITY_PROBE.trim().startsWith("throw")).toBe(false);
  });

  it("guards on the harness being present, so an un-run harness cannot silently pass the probe", () => {
    expect(VACUITY_PROBE).toContain('typeof Test262Error === "function"');
  });

  it("carries a searchable marker so a probed failure is attributable", () => {
    expect(VACUITY_PROBE).toContain(PROBE_MARKER);
  });

  it("tail injection appends after the whole body (the 'did the body COMPLETE' question)", () => {
    const out = injectVacuityProbe(SRC, "tail");
    expect(out.indexOf("assert.sameValue")).toBeLessThan(out.indexOf(PROBE_MARKER));
    expect(out.startsWith(SRC)).toBe(true);
  });

  it("head injection lands after the frontmatter (the 'did the body START' question)", () => {
    const out = injectVacuityProbe(SRC, "head");
    expect(out.indexOf(PROBE_MARKER)).toBeLessThan(out.indexOf("assert.sameValue"));
    // The metadata block must stay intact and first — parseMeta reads it.
    expect(out.indexOf("---*/")).toBeLessThan(out.indexOf(PROBE_MARKER));
    expect(out.startsWith("/*---")).toBe(true);
  });
});

describe("#3613 probe eligibility — every exclusion is a case where a probed pass would NOT prove vacuity", () => {
  it("excludes negative tests (the probe changes the program under test)", () => {
    const e = probeEligibility(
      `/*---\ndescription: x\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar 1 = 2;\n`,
    );
    expect(e.eligible).toBe(false);
    expect(e.reason).toMatch(/negative/);
  });

  it("excludes `raw` tests — no harness means Test262Error does not exist and the probe cannot bite", () => {
    const e = probeEligibility(`/*---\ndescription: x\nflags: [raw]\n---*/\nvar x = 1;\n`);
    expect(e.eligible).toBe(false);
    expect(e.reason).toMatch(/raw/);
  });

  it("keeps ordinary asserting tests eligible", () => {
    expect(probeEligibility(`/*---\ndescription: x\n---*/\nassert.sameValue(1, 1);\n`).eligible).toBe(true);
  });

  it("keeps — but flags — a body that never references the harness", () => {
    const e = probeEligibility(`/*---\ndescription: x\n---*/\nvar x = 1;\n`);
    expect(e.eligible).toBe(true);
    expect(e.reason).toMatch(/no harness reference/);
  });
});

describe("#3613 seeded sampling is reproducible", () => {
  const pop = Array.from({ length: 200 }, (_, i) => `t${i}.js`);

  it("same seed ⇒ same sample; different seed ⇒ different sample", () => {
    expect(seededSample(pop, 10, 20260725)).toEqual(seededSample(pop, 10, 20260725));
    expect(seededSample(pop, 10, 20260725)).not.toEqual(seededSample(pop, 10, 1));
  });

  it("never over-draws and never mutates the input", () => {
    const before = pop.slice();
    expect(seededSample(pop, 1000, 7)).toHaveLength(200);
    expect(pop).toEqual(before);
  });
});

// ── Our own regression tests can pass vacuously too ────────────────────────
//
// A TypeScript cast around a `new` callee is a type-level no-op that CHANGES
// THE AST, so it routes past the `ts.isIdentifier(calleeExpr)` gates in
// src/codegen/expressions/new-super.ts. Measured on the standalone lane:
//
//   throw new TypeError("MARKER-77")          → "TypeError: MARKER-77"
//   throw new (TypeError as any)("MARKER-77") → "[object WebAssembly.Exception]"
//
// A regression test written the second way exercises a DIFFERENT path than the
// fix it guards: it looks protected when it is not. The `assertion_fail` lane
// shipped 3-of-6 vacuous cases this way on 2026-07-25, caught only by manually
// removing the fix and checking the test went red.
describe("#3613 identifier-gate-defeating `new` callees in our own tests", () => {
  it("DETECTS the trap shape — positive control, so a zero below means clean, not broken", () => {
    const hits = findVacuityShapes(
      "probe.test.ts",
      `const e = new (TypeError as any)("x");\nconst f = new (<any>RangeError)("y");\nconst g = new (Ctor!)("z");\n`,
    );
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.callee)).toEqual(["TypeError", "RangeError", "Ctor"]);
    // The suggested fix names the bare identifier to write instead.
    expect(hits[0]!.line).toBe(1);
  });

  it("does NOT flag a cast on an ARGUMENT, or a genuinely computed callee", () => {
    // `new X(y as any)` keeps the identifier callee — the gated path is taken.
    expect(findVacuityShapes("p.ts", `new X(y as any);`)).toHaveLength(0);
    // A real computed callee is deliberate, not an accidental no-op cast.
    expect(findVacuityShapes("p.ts", `new (getCtor())(1);`)).toHaveLength(0);
    expect(findVacuityShapes("p.ts", `new ns.Ctor(1);`)).toHaveLength(0);
  });

  it("honours an explicit opt-out on the line or the line above", () => {
    expect(
      findVacuityShapes("p.ts", `const e = new (TypeError as any)("x"); // ${ALLOW_MARKER}: on purpose`),
    ).toHaveLength(0);
    expect(
      findVacuityShapes("p.ts", `// ${ALLOW_MARKER}: on purpose\nconst e = new (TypeError as any)("x");`),
    ).toHaveLength(0);
  });

  it("the repo is clean — a ratchet at zero, not a baseline to grind down", () => {
    const { findings, scanned } = scanRepoTests();
    // Positive control on the SCANNER: a zero finding count from a scanner
    // that looked at nothing would be the very silent zero this file guards.
    expect(scanned).toBeGreaterThan(100);
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.text}`),
      "cast the RESULT, not the callee: `new X(...) as T`",
    ).toEqual([]);
  });
});
