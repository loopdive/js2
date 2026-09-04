// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3521 R2-T1 (b) — one measured shape per reachable withdrawal reason.
//
// The contract, neutrality, source and CI pins live in the sibling file
// `tests/issue-3521-r2-withdrawal-telemetry.test.ts`. This half is separate
// only for memory: each `compile` retains its `ts.Program` long enough that a
// vitest fork's 512 MB heap (`vitest.config.ts:5`) cannot hold both halves'
// compiles, and every case here passes in isolation.
//
// Each case asserts the FULL triple, the reason, and `preparedComponentId ===
// undefined`. Asserting the triple matters: a reason attached to a row that
// actually prepared, or to one that never emitted an IR body, is invented
// evidence, and that is exactly what the row rule in `check-ir-only.ts`
// rejects. The reasons with no claimable shape on this base are listed, with
// the measurement that establishes it, in the (d) block of the sibling file.
import { afterEach, describe, expect, it } from "vitest";

import { compile, type CompileOptions, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { r2WithdrawalOf, type IrR2Withdrawal } from "../src/ir/r2-withdrawal.js";

// Register the low-level codegen delegates used by the compile paths below.
import "../src/codegen/expressions.js";

// Drop each compile's `ts.Program` before the next one builds another; forks
// already run with `--expose-gc` (`vitest.config.ts:68`).
afterEach(() => {
  (globalThis as { gc?: () => void }).gc?.();
});

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing outcome for ${name}`);
  return observed;
}

async function tracked(source: string, fileName: string, options: CompileOptions = {}): Promise<CompileResult> {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

/** Assert one row's full triple, its reason, and that it sealed no component. */
function expectWithdrawn(result: CompileResult, name: string, expected: IrR2Withdrawal): void {
  const row = outcome(result, name);
  expect({
    prepareAttempts: row.prepareAttempts,
    directBodyEmissions: row.directBodyEmissions,
    irBodyEmissions: row.irBodyEmissions,
    preparedComponentId: row.preparedComponentId,
    withdrawal: r2WithdrawalOf(row),
  }).toEqual({
    prepareAttempts: 1,
    directBodyEmissions: 1,
    irBodyEmissions: 1,
    preparedComponentId: undefined,
    withdrawal: expected,
  });
}

describe("#3521 R2 withdrawal telemetry — (b) one shape per reachable reason", () => {
  it("names the three signature/async admission refusals beside a prepared control row", async () => {
    // One compile, four rows: the three admission predicates that a plain host
    // lane reaches, plus `plain`, which proves the same compile still prepares
    // — so the reasons are not an artifact of the whole source being refused.
    const result = await tracked(
      [
        "interface P { x: number }",
        "export function readX(p: P): number { return p.x; }",
        "export function makeP(x: number): P { return { x }; }",
        "async function inner(): Promise<number> { return 1; }",
        "export async function outer(): Promise<number> { return (await inner()) + 1; }",
        "export function plain(a: number): number { return a + 1; }",
      ].join("\n"),
      "r2-admission-combined.ts",
    );
    expectWithdrawn(result, "readX", { stage: "admission", reason: "param-signature-unstable" });
    expectWithdrawn(result, "makeP", { stage: "admission", reason: "return-signature-unstable" });
    expectWithdrawn(result, "inner", { stage: "admission", reason: "async-declaration" });

    const control = outcome(result, "plain");
    expect([control.directBodyEmissions, control.irBodyEmissions]).toEqual([0, 1]);
    expect(r2WithdrawalOf(control)).toBeUndefined();
    expect(control.preparedComponentId).toMatch(/^prepared-component:/);
  });

  it("admission:fast-signature-unproven", async () => {
    // Fast mode proves only the three admitted signature families — all-scalar,
    // the JS-host string pass-through, and (R2-F1) the mixed declaration-fixed
    // carrier family. An opaque host reference is in none of them.
    //
    // (#5282) This pin used to use `op(o: { a: number }): number`, and before
    // #5282 ANY fast-lane refusal satisfied it: the fast arm is entry zero of
    // the admission table and masked every later predicate. Now the reason is
    // recorded only when no later predicate fires, so the pin needs a shape
    // whose SOLE objection is the fast signature proof. `HTMLElement` is that
    // shape, and the non-fast lane proves it: measured 2026-09-03, `extRef`
    // PREPARES with `(0, 1)` and no withdrawal when `fast` is off, so every
    // predicate after entry zero accepts it and only the fast proof refuses.
    //
    // `op(o: { a: number })` no longer qualifies — it is refused by
    // `param-signature-unstable` in both lanes, which is exactly the masking
    // this pin used to hide. It is pinned as such in the fast-lane specificity
    // test below.
    const result = await tracked(
      "export function extRef(e: HTMLElement): number { return e.childElementCount; }",
      "r2-fast-reference.ts",
      { fast: true },
    );
    expectWithdrawn(result, "extRef", { stage: "admission", reason: "fast-signature-unproven" });
  });

  it("(#5282) a fast-lane refusal names its own predicate, not the fast arm", async () => {
    // The masking this issue closes: before #5282 all three of these rows read
    // `admission:fast-signature-unproven` in a fast lane while the SAME units
    // read their specific reason with `fast` off — same unit, same cause, two
    // reasons. Measured on this exact source, base vs fixed (2026-09-03).
    //
    // The deciding `find` is untouched: `arrParam` below is the control that
    // proves the same compile still admits, and every prepared-set and
    // compiled-artifact hash over the corpus is byte-identical across the fix.
    const result = await tracked(
      [
        "export function objParam(o: { a: number }): number { return o.a; }",
        "export function retObj(a: number): { a: number } { return { a }; }",
        "async function asyncInner(): Promise<number> { return 1; }",
        "export async function asyncOuter(): Promise<number> { return (await asyncInner()) + 1; }",
        "export function arrParam(v: number[]): number { return v[0]; }",
      ].join("\n"),
      "r2-fast-specific-reasons.ts",
      { fast: true },
    );
    expectWithdrawn(result, "objParam", { stage: "admission", reason: "param-signature-unstable" });
    expectWithdrawn(result, "retObj", { stage: "admission", reason: "return-signature-unstable" });
    expectWithdrawn(result, "asyncInner", { stage: "admission", reason: "async-declaration" });

    // (#5282) The POSITIVE pin — this, not any reason pin, is what closes the
    // vacuity #5507 recorded. A reason pin can never catch an admission
    // regression, because a unit that stops being admitted moves INTO the
    // refused set and no reason pin asserts over admitted units. Dropping the
    // R2-F1 `r2FastMixedFixedCarrierSignature` disjunct moves `arrParam` from
    // `(0, 1)` prepared to `(1, 1)` withdrawn, and this assertion goes red.
    // Measured 2026-09-03: with that disjunct replaced by `false`, `arrParam`,
    // `strFn(x: string): string` and `len(s: string): number` are the three
    // shapes that flip; every other shape in the battery is unchanged.
    const admitted = outcome(result, "arrParam");
    expect([admitted.directBodyEmissions, admitted.irBodyEmissions]).toEqual([0, 1]);
    expect(r2WithdrawalOf(admitted)).toBeUndefined();
    expect(admitted.preparedComponentId).toMatch(/^prepared-component:/);
  });

  it("fixed-point:storage-terminal-unprepared", async () => {
    // #4508's edge: reading a top-level binding pins the module-init storage
    // terminal, and this lane does not prepare it.
    const result = await tracked(
      "const base = 1;\nexport function readConst(a: number): number { return a + base; }",
      "r2-storage-terminal.ts",
      { nativeStrings: true },
    );
    expectWithdrawn(result, "readConst", { stage: "fixed-point", reason: "storage-terminal-unprepared" });
  });

  it("fixed-point:outside-caller-uncertified", async () => {
    // #4514's edge and R2-E1's whole population: the signature proof admits the
    // callable parameter, the declaration-fixed carrier certification refuses
    // it, and the module-init caller then withdraws it.
    const result = await tracked(
      "export function apply(f: (v: number) => number, v: number): number { return f(v); }\nexport const seed = apply((v) => v + 1, 1);",
      "r2-outside-caller.ts",
    );
    expectWithdrawn(result, "apply", { stage: "fixed-point", reason: "outside-caller-uncertified" });
  });

  it("fixed-point:callee-outside-component", async () => {
    // The implicit-any component: `sameValue` cannot seal, so both its caller
    // and its caller's caller cross the ownership boundary.
    const result = await tracked(
      "function sameValue(left, right) { return left === right; }\nfunction compare(left, right) { return sameValue(left, right); }\nexport function run(): number { return compare(1, 1) ? 42 : 0; }",
      "r2-callee-outside.ts",
      { skipSemanticDiagnostics: true },
    );
    expectWithdrawn(result, "compare", { stage: "fixed-point", reason: "callee-outside-component" });
    expectWithdrawn(result, "run", { stage: "fixed-point", reason: "callee-outside-component" });
  });

  it("fixed-point:construction-callee-outside", async () => {
    // #4494's parity edge: `new P()` makes `mk` execute P's constructor chain,
    // and P is not in the candidate set.
    const result = await tracked(
      "class P { constructor(public x: number) {} m(): number { return this.x; } }\nexport function mk(x: number): number { return new P(x).m(); }\nexport function other(x: number): number { return x + 1; }",
      "r2-construction-callee.ts",
    );
    expectWithdrawn(result, "mk", { stage: "fixed-point", reason: "construction-callee-outside" });
  });

  it("not-attempted:late-feature-preparation", async () => {
    // The `website/playground/examples/benchmarks/helpers.ts` shape, minimized:
    // a pending late feature (the void host callback) makes the timer routing
    // hand the selector no owners at all, so this name was never a candidate
    // and no admission predicate ever ran on it.
    const result = await tracked(
      'export function scale(a: number): number { return a * 2; }\nexport function wire(node: HTMLElement): void { node.addEventListener("click", () => { node.textContent = "x"; }); }',
      "r2-late-feature.ts",
    );
    expectWithdrawn(result, "wire", { stage: "not-attempted", reason: "late-feature-preparation" });
  });

  it("not-attempted:ir-first-disabled", async () => {
    const previous = process.env.JS2WASM_IR_FIRST;
    process.env.JS2WASM_IR_FIRST = "0";
    try {
      const result = await tracked(
        "export function add(a: number, b: number): number { return a + b; }",
        "r2-ir-first-off.ts",
      );
      expectWithdrawn(result, "add", { stage: "not-attempted", reason: "ir-first-disabled" });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
      else process.env.JS2WASM_IR_FIRST = previous;
    }
  });
});
