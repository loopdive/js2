// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2923 — broaden the constant-string `eval` compile-away (slice A of the
// runtime-eval roadmap, docs/architecture/runtime-eval-interpreter.md §6-A).
//
// `tryStaticEvalInline` (#1163) splices a constant `eval("<literal>")` body
// inline at compile time. It previously BAILED the moment the body contained a
// function declaration, function/arrow expression, class, or for-of/for-in —
// falling through to the dynamic `__extern_eval` host import, which TRAPS at
// instantiation in standalone mode. This slice lifts the SAFELY-liftable kinds:
//
//   - function DECLARATIONS (hoisted; signature-tolerant for the foreign,
//     checker-binding-less eval SourceFile — params/return degrade to externref),
//   - for-of over an array/string LITERAL and for-in over an object/array literal.
//
// Function/arrow EXPRESSIONS and CLASSES keep bailing (their codegen dereferences
// a checker signature/heritage the foreign SourceFile lacks and would THROW an
// internal error — worse than a clean fall-through). They fall to the dynamic
// path (host eval; the Tier-2 interpreter #2928 handles them standalone later).
//
// Pure AOT — no host imports in the lifted standalone modules.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // A lifted eval body must not leak the dynamic `__extern_eval` host import.
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * Compile standalone and report whether the eval bailed to the dynamic path.
 *
 * (#2960) The dynamic standalone-eval path no longer leaks the unsatisfiable
 * `__extern_eval` host import (which trapped at instantiation). It now emits a
 * source-located WARNING and a catchable throw at the eval call site. So a
 * clean bail is discriminated by that warning diagnostic — AND the module must
 * still be host-free (no `__extern_eval` import).
 */
async function bailsToDynamic(src: string): Promise<boolean> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true); // clean bail, NOT a compile error
  // #2960 — the dynamic path must never leak the host eval import standalone.
  expect((r.imports ?? []).some((i) => i.name === "__extern_eval")).toBe(false);
  return (r.errors ?? []).some(
    (e) => (e as { severity?: string }).severity === "warning" && /dynamic eval is not supported/.test(e.message),
  );
}

describe("#2923 — constant eval: function declarations lift (standalone)", () => {
  it('eval("function add(a,b){return a+b} add(2,3)") === 5', async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("function add(a,b){return a+b} add(2,3)") as number; }`,
      ),
    ).toBe(5);
  });

  it("a recursive function declaration works", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("function fac(n){return n<=1?1:n*fac(n-1)} fac(5)") as number; }`,
      ),
    ).toBe(120);
  });

  it("two mutually-referencing function declarations work (forward-reference pre-reserve)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("function a(x){return x+1} function b(x){return x*2} a(b(3))") as number; }`,
      ),
    ).toBe(7);
  });

  it("a zero-parameter function declaration works", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("function five(){return 5} five()") as number; }`,
      ),
    ).toBe(5);
  });
});

describe("#2923 — constant eval: for-of / for-in over literals lift (standalone)", () => {
  it('eval("var s=0; for (const x of [1,2,3]) s+=x; s") === 6', async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("var s=0; for (const x of [1,2,3]) s+=x; s") as number; }`,
      ),
    ).toBe(6);
  });

  it("for-of over a string literal iterates code units", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("var n=0; for (const c of 'abcd') n++; n") as number; }`,
      ),
    ).toBe(4);
  });

  it("for-of + a lifted function declaration compose", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return eval("function sq(x){return x*x} var s=0; for (const x of [1,2,3]) s+=sq(x); s") as number; }`,
      ),
    ).toBe(14);
  });
});

describe("#2923/#3633 — constant eval lift frontier", () => {
  it("a class declaration bails (needs checker heritage/method bindings) — not a compile error", async () => {
    // Acceptance criterion 2: returns 7 OR provably bails with a documented
    // reason. It bails: class codegen dereferences a checker signature the
    // foreign eval SourceFile lacks. Standalone-CE only lifts once the Tier-2
    // interpreter (#2928) lands.
    expect(
      await bailsToDynamic(
        `export function test(): number { return eval("class P{get x(){return 7}} new P().x") as number; }`,
      ),
    ).toBe(true);
  });

  it("a function EXPRESSION bails (checker binding-less closure signature)", async () => {
    expect(
      await bailsToDynamic(
        `export function test(): number { return eval("var f=function(a){return a+1}; f(9)") as number; }`,
      ),
    ).toBe(true);
  });

  it("an arrow expression bails", async () => {
    expect(
      await bailsToDynamic(`export function test(): number { return eval("var f=(a)=>a*2; f(21)") as number; }`),
    ).toBe(true);
  });

  it("a function declaration whose body nests an arrow bails (recursion catches the arrow)", async () => {
    expect(
      await bailsToDynamic(
        `export function test(): number { return eval("function f(){return (x)=>x} typeof f()") as any; }`,
      ),
    ).toBe(true);
  });

  it("for-of over a non-literal iterable (a Map) bails", async () => {
    expect(
      await bailsToDynamic(
        `export function test(): number { return eval("var m=new Map(); var n=0; for (const e of m) n++; n") as number; }`,
      ),
    ).toBe(true);
  });

  // (#2923 park fix, PR #2442 merge_group) The two guards that un-parked the
  // PR: the naive splice regressed 123 test262 files by hoisting function
  // declarations it must not hoist. See eval-inline.ts FunctionDeclaration case.
  it("a function declaration in a STRICT eval body bails (strict early-errors not enforced by the splice)", async () => {
    expect(
      await bailsToDynamic(
        `export function test(): number { return eval("'use strict'; function g(){return 3} g()") as number; }`,
      ),
    ).toBe(true);
  });

  it("a block-nested function declaration uses the Annex B B.3.3 outer binding", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          return eval("{ function h(){return 4} } h()") as number;
        }`,
      ),
    ).toBe(4);
  });

  it("an if-nested function declaration uses the Annex B B.3.3 outer binding", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
          return eval("if (true) function k(){return 5} k()") as number;
        }`,
      ),
    ).toBe(5);
  });

  it("duplicate same-name Annex B declarations bail to preserve eval instantiation lifecycle", async () => {
    expect(
      await bailsToDynamic(
        `export function test(): unknown {
          return eval("var before = f; { function f() {} } { function f() {} }");
        }`,
      ),
    ).toBe(true);
  });

  it("a same-name lexical declaration bails to preserve Annex B early-error suppression", async () => {
    expect(
      await bailsToDynamic(
        `export function test(): unknown {
          return eval("{ let f = 1; { function f() {} } }");
        }`,
      ),
    ).toBe(true);
  });

  it("a function declaration nested inside another function's body bails CLEANLY (hoist fallback), not a compile error", async () => {
    // The park-fix guard classifies an inner fn (inside another function) as
    // not-AnnexB-sensitive, but the foreign-SourceFile hoist path still can't
    // compile it today — it must fall back to the dynamic path cleanly.
    expect(
      await bailsToDynamic(
        `export function test(): number { return eval("function outer(){ function inner(){return 6} return inner() } outer()") as number; }`,
      ),
    ).toBe(true);
  });
});

describe("#2923 — host (gc) mode unchanged (lifted bodies still compute correctly)", () => {
  it("a lifted function-declaration eval body computes in host mode too", async () => {
    const r = await compile(
      `export function test(): number { return eval("function add(a,b){return a+b} add(2,3)") as number; }`,
      {},
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    // Host mode also lifts it (no __extern_eval needed for the constant body).
    expect((r.imports ?? []).some((i) => i.name === "__extern_eval")).toBe(false);
  });
});
