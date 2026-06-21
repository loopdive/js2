// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #28 — `new Promise(executor)` with an INLINE executor must invoke the
 * executor synchronously during construction (ECMA-262 §27.2.3.1).
 *
 * Before this fix, an inline executor (`new Promise((resolve, reject) => …)`)
 * was routed through the `__make_callback` host-callback path by
 * `isHostCallbackArgument` (its NewExpression arm treated any non-user-class
 * ctor arg as a host callback). That path emitted no `__call_fn_*` dispatcher
 * for the executor, so the host `Promise_new` import could not make the wasm
 * closure JS-callable (`_maybeWrapCallable`), and the executor was therefore
 * never invoked — `resolve`/`reject` were `undefined` and the body silently
 * no-op'd ("executor param stripped + invocation elided").
 *
 * The pre-assigned form (`const exec = …; new Promise(exec)`) already worked
 * because the arrow compiles as a first-class closure at the assignment, which
 * DOES emit the `__call_fn_2` dispatcher. The fix routes the inline Promise
 * executor through the same first-class-closure path.
 *
 * Scope: the synchronous executor-invocation protocol (executor runs, captures
 * mutate, resolve/reject are callable, a real Promise is returned). The
 * await-resumption / microtask settling (`resolve(v)` → `await` resumes) is the
 * separate #1042 / #1326 async-machinery work and is not asserted here.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(src: string, exportName = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  const setExports = (imports as { setExports?: (e: unknown) => void }).setExports;
  if (typeof setExports === "function") setExports(instance.exports);
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

describe("#28 new Promise(inline executor) invocation", () => {
  it("invokes an inline arrow executor synchronously (capture write is visible)", async () => {
    const src = `
export function test(): number {
  let c = 0;
  new Promise((resolve: any): void => { c = 7; });
  return c;
}
`;
    expect(await runHost(src)).toBe(7);
  });

  it("passes a callable resolve to the inline executor", async () => {
    const src = `
export function test(): number {
  let isFn = 0;
  new Promise((resolve: any, reject: any): void => {
    if (typeof resolve === "function") isFn += 1;
    if (typeof reject === "function") isFn += 10;
  });
  return isFn;
}
`;
    expect(await runHost(src)).toBe(11);
  });

  it("calling resolve(v) inside the executor does not throw and code after it runs", async () => {
    const src = `
export function test(): number {
  let after = 0;
  new Promise((resolve: any): void => { resolve(1); after = 9; });
  return after;
}
`;
    expect(await runHost(src)).toBe(9);
  });

  it("new Promise(...) returns a real object (typeof === 'object')", async () => {
    const src = `
export function test(): string {
  const p: any = new Promise((resolve: any): void => { resolve(1); });
  return typeof p;
}
`;
    expect(await runHost(src)).toBe("object");
  });

  it("inline anonymous function-expression executor is also invoked", async () => {
    const src = `
export function test(): number {
  let c = 0;
  new Promise(function (resolve: any): void { c = 42; });
  return c;
}
`;
    expect(await runHost(src)).toBe(42);
    // NOTE: a *named* inline executor (`function exec(resolve) {…}`) is a
    // separate named-function-expression closure-registration gap (the name
    // routes it away from the first-class-closure path) and is out of scope
    // for this fix — tracked as a follow-up in the issue file.
  });

  it("regression: pre-assigned executor still works (unchanged path)", async () => {
    const src = `
export function test(): number {
  let c = 0;
  const exec = function (resolve: any): void { c = 5; };
  new Promise(exec);
  return c;
}
`;
    expect(await runHost(src)).toBe(5);
  });
});
