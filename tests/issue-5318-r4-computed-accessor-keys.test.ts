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
