// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3435 — `new ctor(...)` on a binding statically typed as the bare lib
// `Function` interface must route through the dynamic `__construct_closure`
// bridge (spec IsConstructor probe), not the name-keyed `__new_<name>`
// extern-class import. Under checkJs the test262 TypedArray harness JSDoc
// contextually types callback params as `Function`, which previously fell to
// "No dependency provided for extern class 'TA'".
import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

describe("#3435 Function-typed dynamic ctor param", () => {
  it("constructs through a Function-typed param holding a real ctor", async () => {
    const ex = (await compileAndInstantiate(`
function build(C: Function, n: number) {
  var inst: any = new (C as any)(n);
  return inst.length;
}
export function test(): number { return build(Int8Array, 3); }
`)) as Record<string, unknown>;
    expect((ex.test as () => number)()).toBe(3);
  });

  it("throws TypeError for a Function-typed param holding a non-constructor", async () => {
    const ex = (await compileAndInstantiate(`
function tryNew(f: Function): number {
  try { new (f as any)(); return 0; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
}
export function test(): number { return tryNew(Math.max.bind(null)); }
`)) as Record<string, unknown>;
    expect((ex.test as () => number)()).toBe(1);
  });
});
