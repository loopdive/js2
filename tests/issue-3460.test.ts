// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3460 — direct-call of an unmatched typed-callable var read off a host object
// must yield a CATCHABLE TypeError, not an uncatchable null-deref wasm trap.
//
// The #3432 fix stopped destructively recasting a callable-typed var whose slot
// stays externref, but only recorded the decl in `skippedClosureRecastDecls`
// (which drives the #1712 `__call_function` host-dispatch arm via
// `calleeMayBeHostCallable`) for the MATCHED-signature case. A sibling residual
// existed for the NO-MATCH case: a callable-typed var initialized from a host
// object property whose value has no registered closure signature (and may be
// null/undefined/foreign at runtime) was left as a raw externref WITHOUT
// recording the decl, so a direct-call reached the closure-struct dispatch,
// nulled the guarded root cast, and `struct.get`-trapped "dereferencing a null
// pointer" — uncatchable, where the spec wants a catchable TypeError.
//
// Fix: record the decl in the no-match case too (variables.ts). The host arm is
// !standalone&&!wasi-gated, so the #1941 dual-mode guarantee (no host imports in
// pure closure programs) is preserved.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<unknown> {
  const r = await compile(source, {
    fileName: "test.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as unknown as WebAssembly.Imports & {
    setExports?: (e: Record<string, Function>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3460 unmatched typed-callable host-read direct-call", () => {
  it("undefined callable read off a property → CATCHABLE TypeError (not null-deref trap)", async () => {
    // Before the fix this trapped "dereferencing a null pointer" — uncatchable,
    // so the try/catch never ran and the whole module aborted.
    const out = await compileAndRun(`
export function test(): number {
  const obj: any = {};
  const f: (x: number) => number = obj.missingFn;
  try {
    f(10);
    return 0; // no throw -> wrong
  } catch (e) {
    return (e instanceof TypeError) ? 1 : 2;
  }
}`);
    expect(out).toBe(1);
  });

  it("GUARD: a real callable read off an object property still invokes", async () => {
    const out = await compileAndRun(`
export function test(): number {
  const obj: any = { fn: function (x: number): number { return x + 1; } };
  const f: (x: number) => number = obj.fn;
  return f(10);
}`);
    expect(out).toBe(11);
  });

  it("GUARD: a harness-style property alias (compareArray.format) still invokes", async () => {
    const out = await compileAndRun(`
var host: any = {};
host.format = function (a: any): string { return "" + a; };
export function test(): string {
  var format: (a: any) => string = host.format;
  return format([1, 2, 3]);
}`);
    expect(out).toBe("1,2,3");
  });

  it("GUARD: a bound function stored in a typed-callable var still invokes", async () => {
    const out = await compileAndRun(`
function base(x: number): number { return x * 2; }
export function test(): number {
  const f: (x: number) => number = base.bind(null);
  return f(21);
}`);
    expect(out).toBe(42);
  });

  it("GUARD: pure local-closure dispatch is unaffected (arity + capture)", async () => {
    const out = await compileAndRun(`
export function test(): number {
  const makeAdder = (n: number) => (x: number) => x + n;
  const add5 = makeAdder(5);
  const applyTwice = (f: (x: number) => number, v: number): number => f(f(v));
  return applyTwice(add5, 10); // ((10+5)+5) = 20
}`);
    expect(out).toBe(20);
  });
});
