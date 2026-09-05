// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5318 r4 Step 1 — a class accessor whose ComputedPropertyName is only known
// at ClassDefinitionEvaluation.
//
// Two defects, both in the standalone runtime-keyed member lane #5195 Step 1
// built:
//
//   1a. `get [k]() {}` and `set [k](v) {}` register under two DIFFERENT
//       synthetic names (`__cmdyn$0` / `__cmdyn$1`) — the collector cannot know
//       the two key expressions evaluate to the same property key. Both halves
//       then called `__defineProperty_accessor` with the SAME runtime key under
//       the legacy "both halves specified" flag word, so the trailing `set`
//       blanked the `get` and `c[k]` read back `undefined`.
//   1c. STATIC accessors were not installed on the class's static sidecar
//       `$Object` at all, so `C[k]` was `undefined` for every
//       `static get [k]()` / `static set [k](v)`.
//
// The order-preservation half is the third describe block: a class whose keys
// FOLD keeps the legacy encoding (its two halves are one entry, so replace-both
// is already right), and a static accessor half that READS its receiver is
// still declined — it keeps base's missing-property answer rather than gaining
// the illegal-cast trap that installing it would produce.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/**
 * The Test262 rows Step 1 flips. Every one reads an instance accessor pair AND
 * a static accessor pair under a key the compiler cannot fold, which is why
 * both halves of the step are needed for any of them to pass. Measured
 * fail → pass against a `git archive origin/main` base tree on 2026-09-05.
 */
const STEP_1_ROWS = [
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-arrow-function-expression.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-assignment-expression-bitwise-or.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-async-arrow-function-expression.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-expression-coalesce.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-expression-logical-and.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-expression-logical-or.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-function-declaration.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-function-expression.js",
  "language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-generator-function-declaration.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-arrow-function-expression.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-assignment-expression-bitwise-or.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-async-arrow-function-expression.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-coalesce.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-logical-and.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-expression-logical-or.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-function-declaration.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-function-expression.js",
  "language/statements/class/cpn-class-decl-accessors-computed-property-name-from-generator-function-declaration.js",
] as const;

async function runStandalone(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5318 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

function runHost(source: string, exportName: string): unknown {
  const hostSource = source.replace(/\bexport\s+/g, "");
  return (new Function(`${hostSource}\nreturn ${exportName};`)() as () => unknown)();
}

describe("#5318 r4 Step 1 — Test262 rows", () => {
  for (const relativePath of STEP_1_ROWS) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    it.skipIf(!existsSync(file))(
      `step 1: ${relativePath} passes in standalone`,
      async () => {
        try {
          const standalone = await runTest262File(file, "issue-5318-r4", 60_000, "standalone");
          expect({ status: standalone.status, error: standalone.error }).toEqual({
            status: "pass",
            error: undefined,
          });
        } finally {
          restoreHostBuiltins();
        }
      },
      300_000,
    );
  }
});

describe("#5318 r4 Step 1 — the runtime-keyed accessor matrix", () => {
  // One class expression per shape, all under keys the compiler cannot fold
  // (`x` is a reassignable `let`, so `x || 1` stays a runtime expression).
  // Each probe is the exact read the Test262 family makes.
  const MATRIX_SOURCE = `
    let x = 0;
    let y = 0;
    const GetOnly = class { get [x || 1]() { return 2; } };
    const SetOnly = class { set [x || 1](v) { y = v; } };
    const Pair = class {
      get [x || 1]() { return 2; }
      set [x || 1](v) { y = v; }
    };
    const StaticGet = class { static get [x || 1]() { return 3; } };
    const StaticPair = class {
      static get [x || 1]() { return 4; }
      static set [x || 1](v) { y = v; }
    };
    const Concat = class { get ["a" + "b"]() { return 5; } };
    const Coalesce = class { get [null ?? "c"]() { return 6; } };
    const Call = class { get [String(1)]() { return 7; } };
    export function probeGetOnly() { return new GetOnly()[x || 1]; }
    export function probeSetOnlyRead() { return new SetOnly()[x || 1] === undefined ? 1 : 0; }
    export function probeSetOnlyWrite() { y = 0; new SetOnly()[x || 1] = 9; return y; }
    export function probePairGet() { return new Pair()[x || 1]; }
    export function probePairSet() { y = 0; new Pair()[x || 1] = 8; return y; }
    export function probeStaticGet() { return StaticGet[x || 1]; }
    export function probeStaticPairGet() { return StaticPair[x || 1]; }
    export function probeStaticPairSet() { y = 0; StaticPair[x || 1] = 7; return y; }
    export function probeConcat() { return new Concat()["ab"]; }
    export function probeCoalesce() { return new Coalesce()["c"]; }
    export function probeCall() { return new Call()["1"]; }
  `;

  // Every READ shape now answers node's value.
  const PROBES = [
    "probeGetOnly",
    "probeSetOnlyRead",
    "probePairGet",
    "probeStaticGet",
    "probeStaticPairGet",
    "probeConcat",
    "probeCoalesce",
    "probeCall",
  ] as const;

  for (const probe of PROBES) {
    it(`standalone matches node for ${probe}`, async () => {
      expect(await runStandalone(MATRIX_SOURCE, probe, "issue-5318-matrix.js")).toEqual(runHost(MATRIX_SOURCE, probe));
    });
  }

  // …and every WRITE shape does NOT, because the class prototype/sidecar
  // lookup arm is prepended into `__extern_get` / `__extern_get_idx` only
  // (`class-proto-lookup.ts::fillClassProtoLookupArm`): `c[k] = v` never
  // reaches the installed setter, so the write is silently dropped. That is
  // base's behaviour too — the step neither fixed nor broke it — and it is the
  // reason `accessor-name-{inst,static}-computed-in.js` still fail. Pinned as
  // the recorded residual so the write lane flips this block loudly.
  const WRITE_RESIDUALS = ["probeSetOnlyWrite", "probePairSet", "probeStaticPairSet"] as const;

  for (const probe of WRITE_RESIDUALS) {
    it(`RESIDUAL: ${probe} drops the write (no __extern_set arm)`, async () => {
      expect(await runStandalone(MATRIX_SOURCE, probe, "issue-5318-matrix.js")).toBe(0);
      expect(runHost(MATRIX_SOURCE, probe)).not.toBe(0);
    });
  }
});

describe("#5318 r4 Step 1 — order preservation", () => {
  // A class whose accessor key FOLDS keeps the pre-#5318 install: the pair is
  // one entry, so nothing about its flag word changes.
  const FOLDED_SOURCE = `
    class F {
      get p() { return 1; }
      set p(v) { this.q = v; }
      static get s() { return 2; }
    }
    export function probe() {
      const f = new F();
      f.p = 5;
      return f.p === 1 && f.q === 5 && F.s === 2;
    }
  `;

  it("standalone: a folded-key accessor class is unchanged", async () => {
    expect(await runStandalone(FOLDED_SOURCE, "probe", "issue-5318-folded.js")).toBe(1);
  });

  it("host lane agrees", () => {
    expect(runHost(FOLDED_SOURCE, "probe")).toBe(true);
  });

  // A static accessor half that READS its receiver is deliberately NOT
  // installed on the sidecar: its compiled half takes the class STRUCT as
  // `this`, while the sidecar hands it an `$Object`, and the resulting cast is
  // a trap. Declining leaves base's answer (the property is missing) — which
  // is a wrong ANSWER, not a new throw, and is what this pin records. A future
  // per-half dummy-receiver trampoline flips this expectation.
  const RECEIVER_READING_SOURCE = `
    let x = 0;
    const R = class {
      static get [x || 1]() { return this === undefined ? 1 : 2; }
    };
    export function probe() { return R[x || 1] === undefined; }
  `;

  it("standalone: a receiver-reading static accessor declines rather than traps", async () => {
    expect(await runStandalone(RECEIVER_READING_SOURCE, "probe", "issue-5318-receiver.js")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Review round 1 (2026-09-05) — the three findings the reviewer confirmed.
// ---------------------------------------------------------------------------

describe("#5318 r4 review — §15.7.14 declaration order on the static sidecar", () => {
  // Finding 1. `emitClassStaticSidecar` emitted every static METHOD first and
  // every static ACCESSOR second, discarding `decl.members` order, AND the
  // method install's flag word omitted bit 7 (`HOST_HAS_VALUE`) — which
  // §10.1.6.3 step 6 reads as a GENERIC descriptor, so it updated attributes
  // and left a live accessor's halves in place. Together those made a
  // same-key accessor win in BOTH declaration orders. node is the oracle:
  // whichever member is textually LAST wins.
  const ACCESSOR_THEN_METHOD = `
    let x = 0;
    class P { static get [x || "k"]() { return 11; } static k() { return 9; } }
    class Q { static k = 7; }
    export function probe() { const v = P[x || "k"]; return typeof v === "function" ? v() : (v === 11 ? 11 : -1); }
  `;
  const METHOD_THEN_ACCESSOR = `
    let x = 0;
    class P { static k() { return 9; } static get [x || "k"]() { return 11; } }
    class Q { static k = 7; }
    export function probe() { const v = P[x || "k"]; return typeof v === "function" ? v() : (v === 11 ? 11 : -1); }
  `;

  it("standalone: a static method textually AFTER a same-key accessor wins", async () => {
    expect(await runStandalone(ACCESSOR_THEN_METHOD, "probe", "issue-5318-order-a.js")).toBe(9);
  });

  it("host lane agrees (accessor then method)", () => {
    expect(runHost(ACCESSOR_THEN_METHOD, "probe")).toBe(9);
  });

  it("standalone: a static accessor textually AFTER a same-key method wins", async () => {
    expect(await runStandalone(METHOD_THEN_ACCESSOR, "probe", "issue-5318-order-b.js")).toBe(11);
  });

  it("host lane agrees (method then accessor)", () => {
    expect(runHost(METHOD_THEN_ACCESSOR, "probe")).toBe(11);
  });

  // Two static members under DIFFERENT keys must both stay reachable — the
  // order pass must not drop either.
  const DISTINCT_KEYS = `
    let x = 0;
    class P { static get [x || "k"]() { return 11; } static m() { return 9; } }
    class Q { static k = 7; }
    export function probeK() { const v = P[x || "k"]; return v === 11 ? 11 : -1; }
    export function probeM() { const v = P[x || "m"]; return typeof v === "function" ? v() : -1; }
  `;

  it("standalone: distinct keys both stay installed", async () => {
    expect(await runStandalone(DISTINCT_KEYS, "probeK", "issue-5318-order-c.js")).toBe(11);
    expect(await runStandalone(DISTINCT_KEYS, "probeM", "issue-5318-order-c.js")).toBe(9);
  });

  // The INSTANCE twin of the same defect, RECORDED not fixed. The prototype
  // `$Object` (`class-proto-object.ts`) installs methods first and accessors
  // second by the same #4455 decision, and its method flag word omits bit 7 for
  // the same reason. This is base-equal — the r4 work neither caused nor changed
  // it — and fixing it moves the bytes of every class that has a prototype
  // object, which needs its own control sweep.
  //
  // Measured, NOT assumed: in this ISOLATED shape standalone reaches NEITHER
  // member — the probe answers -1 on base AND on this tree — so the ordering
  // never gets a chance to be wrong here. The reviewer's `m13.js` (four such
  // classes in one module, where the members ARE reached) is where the ordering
  // itself shows: `probeG2` answers the accessor (2) on base, lane and this tree
  // where node answers the method (1).
  const INSTANCE_ORDER = `
    let x = 0;
    class G { get [x || "k"]() { return 2; } [x || "k"]() { return 1; } }
    export function probe() {
      const v = new G()[x || "k"];
      if (typeof v === "function") return v();
      return v === 2 ? 2 : -1;
    }
  `;

  it("standalone: RESIDUAL — the prototype twin is unreached here (node: 1)", async () => {
    expect(await runStandalone(INSTANCE_ORDER, "probe", "issue-5318-order-inst.js")).toBe(-1);
  });

  it("host lane shows what the prototype residual costs", () => {
    expect(runHost(INSTANCE_ORDER, "probe")).toBe(1);
  });
});

describe("#5318 r4 review — a nested class hides a receiver read", () => {
  // Finding 2. The install predicate used `genBodyReferencesThis`, which stops
  // descending at `ts.isClassLike`, so the `this` in a NESTED class's static
  // field initializer was invisible. The half was installed, its compiled body
  // really does read `local 0`, and the call TRAPPED uncatchably — strictly
  // worse than the missing-property answer it replaced. The predicate now
  // descends into nested classes (and consults the compiled body when it
  // exists), so this half is declined again. `undefined` here is a WRONG
  // answer (node returns 6) but it is not a throw; a future dummy-receiver
  // trampoline flips it to 6.
  const NESTED_CLASS_THIS = `
    let x = 0;
    class C2 { static get [x || "k"]() { class X { static f = this; } return 6; } }
    export function probe() { const v = C2[x || "k"]; return v === undefined ? -1 : v; }
    export function probeCatch() { try { C2[x || "k"]; return 0; } catch (e) { return -2; } }
  `;

  it("standalone: declines the install instead of trapping", async () => {
    expect(await runStandalone(NESTED_CLASS_THIS, "probe", "issue-5318-nested.js")).toBe(-1);
  });

  it("standalone: the read does not throw", async () => {
    expect(await runStandalone(NESTED_CLASS_THIS, "probeCatch", "issue-5318-nested.js")).toBe(0);
  });

  // The compiled-body gate OVER-declines in one measured shape: an object
  // literal inside the half whose computed key merely COMPARES `this` emits a
  // `local.get 0` that never dereferences, so installing it would have been
  // safe and would have answered 6 (node's answer). Declining costs a correct
  // answer here. That is the deliberate direction of the trade — a `local.get
  // 0` that DOES dereference is an uncatchable trap, and the gate cannot tell
  // the two apart. Pinned so the cost is visible if the gate is ever refined.
  const COMPUTED_KEY_THIS = `
    let x = 0;
    class C3 { static get [x || "k"]() { const o = { [this === undefined ? "a" : "b"]() { return 1; } }; return 6; } }
    export function probe() { const v = C3[x || "k"]; return v === undefined ? -1 : v; }
  `;

  it("standalone: OVER-DECLINE — a half that only compares `this` also declines (node: 6)", async () => {
    expect(await runStandalone(COMPUTED_KEY_THIS, "probe", "issue-5318-nested-key.js")).toBe(-1);
  });
});

describe("#5318 r4 review — RESIDUAL: a static FIELD does not shadow the sidecar", () => {
  // Finding 3, recorded not fixed. Static fields keep the `staticProps` global
  // lowering and never enter the sidecar (mirroring a mutable slot there would
  // give it two sources of truth). §15.7.14 runs static field initializers
  // AFTER every method and accessor is installed, so in BOTH declaration
  // orders node answers the FIELD (7); the sidecar answers its accessor (11).
  // Base answered `undefined` — both are wrong, and this is not a regression
  // the r4 work introduced relative to a working program. Closing it means
  // widening the sidecar to fields.
  const FIELD_COLLISION = `
    let x = 0;
    class Q1 { static get [x || "k"]() { return 11; } static k = 7; }
    class Q2 { static k = 7; static get [x || "k"]() { return 11; } }
    export function probeQ1() { const v = Q1[x || "k"]; return v === undefined ? -1 : v; }
    export function probeQ2() { const v = Q2[x || "k"]; return v === undefined ? -1 : v; }
  `;

  it("standalone: accessor-then-field answers the accessor (node says 7)", async () => {
    expect(await runStandalone(FIELD_COLLISION, "probeQ1", "issue-5318-field.js")).toBe(11);
  });

  it("standalone: field-then-accessor answers the accessor (node says 7)", async () => {
    expect(await runStandalone(FIELD_COLLISION, "probeQ2", "issue-5318-field.js")).toBe(11);
  });

  it("host lane shows what the residual costs", () => {
    expect(runHost(FIELD_COLLISION, "probeQ1")).toBe(7);
    expect(runHost(FIELD_COLLISION, "probeQ2")).toBe(7);
  });
});
