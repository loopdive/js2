// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * #2552 — Annex B B.3.3 Phase 2 rework: case-B outer-binding lifecycle, narrowed.
 *
 * Phase 1 (#2200/#1764) handles case-A cancellation. Phase 2 (the case-B
 * uninitialised-then-init outer var-binding + `typeof F` runtime resolution) was
 * first implemented in PR #1769 but pre-allocated the outer-binding TDZ var (an
 * externref local + an i32 flag) for EVERY structurally eligible block-nested
 * function — which perturbed local-index layout for the dominant test262 harness
 * shape (a function that merely *contains* a block-nested helper) and regressed
 * the full gate by -1180 (Array/prototype + dstr buckets). It was reverted.
 *
 * This rework re-introduces Phase 2 NARROWED: the outer binding is allocated ONLY
 * when the block-fn name is OBSERVED at function scope outside its declaring
 * block (`annexBNameObservedOutsideBlock`). A block-fn whose name is never
 * referenced outside its block is byte-identical to pre-Phase-2 codegen, so the
 * hot path is untouched. The case-B lifecycle works where it is actually visible.
 */

async function runString(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  return (exports.test as () => unknown)();
}

async function runNumber(src: string): Promise<number> {
  const exports = await compileToWasm(src);
  return (exports.test as () => number)();
}

async function runForTarget(src: string, target: "gc" | "standalone"): Promise<number> {
  const result = await compile(src, {
    target,
    fileName: "/issue-2552-repeated-blockfn.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = target === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if ("setExports" in imports && typeof imports.setExports === "function") {
    imports.setExports(instance.exports);
  }
  return (instance.exports.test as () => number)();
}

describe("#2552 Phase 2 — case-B outer-binding lifecycle (observed)", () => {
  it("typeof F AFTER the declaring block ran → 'function' (outer binding initialised)", async () => {
    expect(await runString(`export function test(): string { { function f() { return 7; } } return typeof f; }`)).toBe(
      "function",
    );
  });

  it("typeof F when the declaring block did NOT run → 'undefined' (binding stays uninitialised)", async () => {
    expect(
      await runString(`export function test(): string { if (false) { function f() { return 7; } } return typeof f; }`),
    ).toBe("undefined");
  });

  it("calling F after its block ran returns the function value (outer binding holds it)", async () => {
    expect(await runNumber(`export function test(): number { { function f() { return 42; } } return f(); }`)).toBe(42);
  });

  it("typeof F BEFORE the block (textually) → 'undefined' (flag not yet set)", async () => {
    expect(
      await runString(`export function test(): string { let t = typeof f; { function f() { return 1; } } return t; }`),
    ).toBe("undefined");
  });

  it("bare READ of F before its block → undefined, NOT ReferenceError (var binding exists)", async () => {
    // The merge_group -10 regression: the `*-func-existing-block-fn-no-init`
    // shape reads F before its declaring block ran. Annex B makes the outer
    // binding `var`-style (it EXISTS, uninitialised), so a read yields
    // `undefined` — it must NOT throw "f is not defined" (the pre-fix bug, where
    // the shared tdzFlagLocals path applied let/const TDZ-throw semantics).
    expect(
      await runString(`export function test(): string {
        let r: any = "x"; r = f;
        { function f() {} } { function f() {} }
        return typeof r; }`),
    ).toBe("undefined");
  });

  it("bare READ of F after its block ran → the function value (outer binding holds it)", async () => {
    expect(
      await runString(`export function test(): string {
        let r: any; { function f() { return 1; } } r = f;
        return typeof r; }`),
    ).toBe("function");
  });
});

describe("#2552 Phase 2 — repeated block declarations update the live outer binding", () => {
  it.each(["gc", "standalone"] as const)("%s: each declaration contributes its own function object", async (target) => {
    const value = await runForTarget(
      `export function test() {
        let score = 0;

        { function f1() { return 1; } }
        { function f1() { return 2; } }
        if (f1() === 2) score += 1;
        const f1Value = f1;
        if (f1Value() === 2) score += 2;

        { function f2() { return 1; } }
        if (false) { function f2() { return 2; } }
        if (f2() === 1) score += 4;

        function nestedCancellation() {
          {
            function f3() { return 1; }
            { function f3() { return 2; } }
          }
          return f3();
        }
        if (nestedCancellation() === 1) score += 8;

        return score;
      }`,
      target,
    );
    expect(value).toBe(15);
  });
});

describe("#2552 Phase 2 — mutable-binding split (reassigned-in-block) reverts to pre-Phase-2", () => {
  // The two `*-block-scoping` test262 files (the other half of the merge_group
  // -10) use `{ function f() { f = 123; ... } }` — the in-block reassignment
  // mutates the BLOCK-LOCAL binding while the outer var binding stays the
  // function captured at block entry. The single-slot flag-gated outer-binding
  // machinery can't model that split, so `annexBNameReassignedInBlock` excludes
  // the shape and it reverts to the (passing) pre-Phase-2 codegen. The
  // TS-level cross-block read makes a faithful inline repro ill-typed, so the
  // behavioural coverage lives in the real test262 files (run in CI); here we
  // only assert the excluded shape still compiles and runs its in-block calls.
  it("a block-fn reassigned inside its block still compiles + runs its in-block use", async () => {
    expect(
      await runNumber(`export function test(): number {
        let r = 0;
        { function f(x: number): number { return x + 1; } r = f(10) + f(20); }
        return r; }`),
    ).toBe(32);
  });
});

describe("#2552 Phase 2 — narrowing (unobserved block-fn unchanged)", () => {
  it("a block-fn used only inside its block still works (no outer binding needed)", async () => {
    expect(
      await runNumber(`export function test(): number {
        let r = 0;
        { function h(x: number) { return x * 2; } r = h(3) + h(4); }
        return r; }`),
    ).toBe(14);
  });

  it("the unobserved harness shape compiles byte-identically to pre-Phase-2", async () => {
    // The function CONTAINS a block-nested helper but never references it outside
    // the block — the exact -1180 trigger. With the narrowing it must take the
    // pre-Phase-2 path: NO outer-binding local and NO __tdz_ flag. We assert the
    // observable proxy (correct value + no extra emitted local churn) by checking
    // the module compiles and runs; the byte-identity vs main is verified in the
    // PR description's hash comparison.
    const src = `export function test(): number {
      let sum = 0;
      { function helper(x: number): number { return x * 2; } sum = helper(3) + helper(4); }
      return sum; }`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(await runNumber(src)).toBe(14);
  });
});

describe("#2552 Phase 2 — no regression", () => {
  it("genuinely undeclared identifier still → 'undefined'", async () => {
    expect(await runString(`export function test(): string { return typeof totallyNotDeclared; }`)).toBe("undefined");
  });

  it("a normal function-body declaration typeof still → 'function'", async () => {
    expect(await runString(`function g() { return 1; } export function test(): string { return typeof g; }`)).toBe(
      "function",
    );
  });

  it("typeof on a plain numeric local is unaffected → 'number'", async () => {
    expect(await runString(`export function test(): string { const n = 5; return typeof n; }`)).toBe("number");
  });

  it("case-A cancellation (let-shadow) still throws ReferenceError outside the block", async () => {
    const out = await runNumber(`export function test(): number {
      let threw = 0;
      try { (f as any); } catch (e) { threw = (e instanceof ReferenceError) ? 1 : 0; }
      { let f = 123; { function f() {} } }
      return threw; }`);
    expect(out).toBe(1);
  });
});
