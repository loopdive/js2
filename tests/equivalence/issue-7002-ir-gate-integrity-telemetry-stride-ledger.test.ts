// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7002 — `trackIrOutcomes` must be observation-only. Before the fix, two
// telemetry-only code paths changed the compile result:
//
//  1. The outcome reconcile pushed its `IR outcome invariant […]` diagnostics
//     as ERRORS. A class EXPRESSION's members are compiled twice by the direct
//     path (once under the binding name, once under the synthetic
//     `__anonClass_N` identity), which the receipt audit reports as
//     `duplicate-direct-function-body-receipt`; production compile never runs
//     that audit, so the same source succeeded without telemetry and failed
//     with it.
//  2. The legacy body-route recorder threw on a synthesized node with no
//     SourceFile (`getLineAndCharacterOfPosition` of undefined), turning a
//     successful compile into an "Internal error compiling expression".
//
// The invariant ROW used to be recorded — gates read rows, not `success`.
// (#7106) The twin identity is the DESIGNED shape (`declarations.ts`:
// "Variable-bound class expressions are registered under both"), so the
// receipt audit now records it instead of counting it and this source yields
// no invariant row at all; the warning-severity contract for genuine
// invariants stays pinned by tests/issue-3519-ir-outcomes.test.ts,
// issue-3520-outcome-correlation-identity and issue-5262-accounting-precedence.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const REPO_ROOT = resolve(__dirname, "../..");

/** The `check:ir-only` population (scripts/check-ir-only.ts SINGLE_HOST_ENTRIES). */
const PLAYGROUND_ENTRIES = [
  "website/playground/examples/dom/calendar.ts",
  "website/playground/examples/js/algorithms.ts",
  "website/playground/examples/js/async.ts",
  "website/playground/examples/js/builtins.ts",
  "website/playground/examples/js/classes.ts",
] as const;

/** Reduced from test262 language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-math.js. */
const CLASS_EXPR_ACCESSORS = `
let C = class {
  get [1 + 2 - 3 * 4 / 5 ** 6]() { return 2.999232; }
  set [1 + 2 - 3 * 4 / 5 ** 6](v) { return 2.999232; }
  static get [1 + 2 - 3 * 4 / 5 ** 6]() { return 2.999232; }
  static set [1 + 2 - 3 * 4 / 5 ** 6](v) { return 2.999232; }
};
let c = new C();
export function main() {
  let ok = 1;
  if (c[1 + 2 - 3 * 4 / 5 ** 6] !== 2.999232) ok = 0;
  if (C[1 + 2 - 3 * 4 / 5 ** 6] !== 2.999232) ok = 0;
  if (c[String(1 + 2 - 3 * 4 / 5 ** 6)] !== 2.999232) ok = 0;
  return ok;
}
`;

/** test262 built-ins/Function/prototype/S15.3.3.1_A3.js body, compiled without its harness. */
const SYNTHETIC_NODE_SOURCE = `
verifyNotConfigurable(Function, "prototype");
try {
  assert.sameValue(delete Function.prototype, false);
} catch (e) {
  if (e instanceof Test262Error) {
    throw e;
  }
  assert(e instanceof TypeError);
}
if (!(Function.hasOwnProperty('prototype'))) {
  throw new Test262Error('#2: the Function.prototype property has the attributes DontDelete.');
}
`;

const PARITY_CASES: { name: string; fileName: string; source: () => string }[] = [
  ...PLAYGROUND_ENTRIES.map((entry) => ({
    name: entry,
    fileName: "test.ts",
    source: () => readFileSync(resolve(REPO_ROOT, entry), "utf8"),
  })),
  { name: "class-expression accessors (compile-twice)", fileName: "test.js", source: () => CLASS_EXPR_ACCESSORS },
  { name: "synthesized node in the body-route recorder", fileName: "test.js", source: () => SYNTHETIC_NODE_SOURCE },
];

/**
 * Known telemetry-induced BYTE divergence (success still matches). With
 * `trackIrOutcomes` the compiler hands the IR inventory its compiler-origin
 * map, so the timer-shim prelude is inventoried as `synthetic-support` and takes
 * the isolated timer-shim preparation; without telemetry it is an ordinary
 * top-level function. Same behaviour, different type/function order. Tracked as
 * #7071 — when that lands, the assertion below fails and this entry must go.
 */
const KNOWN_BYTE_DIVERGENCE: ReadonlyMap<string, string> = new Map([
  ["gc:website/playground/examples/js/async.ts", "#7071"],
]);

const TARGETS: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc", options: { semanticProviders: "host-assisted" } },
];

describe("#7002 trackIrOutcomes is observation-only", () => {
  for (const target of TARGETS) {
    for (const testCase of PARITY_CASES) {
      it(`${target.name}: ${testCase.name} — same success and byte-identical binary`, async () => {
        const source = testCase.source();
        const plain = await compile(source, { fileName: testCase.fileName, ...target.options });
        const tracked = await compile(source, {
          fileName: testCase.fileName,
          ...target.options,
          trackIrOutcomes: true,
        });
        const hard = tracked.errors.filter((error) => error.severity !== "warning").map((error) => error.message);
        expect(tracked.success, hard.join("\n")).toBe(plain.success);
        const identical = Buffer.from(tracked.binary).equals(Buffer.from(plain.binary));
        const known = KNOWN_BYTE_DIVERGENCE.get(`${target.name}:${testCase.name}`);
        expect(
          identical,
          known
            ? `${known} no longer diverges — remove it from KNOWN_BYTE_DIVERGENCE`
            : "binary differs with trackIrOutcomes",
        ).toBe(known === undefined);
        expect(tracked.irOutcomes?.length ?? 0).toBeGreaterThan(0);
      }, 60_000);
    }
  }

  it("the class-expression twin identity records no compile-twice invariant row (#7106)", async () => {
    const tracked = await compile(CLASS_EXPR_ACCESSORS, {
      fileName: "test.js",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(tracked.success).toBe(true);
    const invariants = (tracked.irOutcomes ?? []).filter((outcome) => outcome.kind === "invariant");
    expect(invariants, JSON.stringify(invariants, null, 2)).toEqual([]);
    const notes = tracked.errors.filter((error) => error.message.startsWith("IR outcome invariant ["));
    expect(notes).toEqual([]);
    expect(tracked.irOutcomes?.length ?? 0).toBeGreaterThan(0);
  }, 60_000);
});

describe("#7002 class-expression accessors run like JS", () => {
  const expected = (evaluateAsJs(CLASS_EXPR_ACCESSORS).main as () => number)();

  it("JS reference answer is 1", () => {
    expect(expected).toBe(1);
  });

  for (const target of TARGETS) {
    for (const trackIrOutcomes of [false, true]) {
      it(`${target.name}${trackIrOutcomes ? " + trackIrOutcomes" : ""}: main() matches JS`, async () => {
        const result = await compile(CLASS_EXPR_ACCESSORS, {
          fileName: "test.js",
          ...target.options,
          ...(trackIrOutcomes ? { trackIrOutcomes } : {}),
        });
        const hard = result.errors.filter((error) => error.severity !== "warning").map((error) => error.message);
        expect(result.success, hard.join("\n")).toBe(true);
        const instance = await instantiateWithRuntime(result);
        const exports = instance.exports as Record<string, () => unknown>;
        exports.__module_init?.();
        expect(exports.main!()).toBe(expected);
      }, 60_000);
    }
  }
});
