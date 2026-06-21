// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1344 — Generator.prototype.{next,return} must validate the receiver.
// Per ECMAScript §27.5.3.2 GeneratorValidate (step 2), calling a borrowed
// generator method with a `this` that lacks the [[GeneratorState]] internal
// slot (e.g. `GeneratorPrototype.next.call({})`) throws a TypeError. The native
// generator dispatch previously fell through to a silent `{value: 0, done:
// true}` sentinel; it now throws a catchable TypeError instance.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as unknown as Record<string, Function>;
}

describe("#1344 generator prototype receiver validation", () => {
  it("borrowed .next() on a non-generator receiver throws TypeError", async () => {
    const e = await compileAndRun(`
      export function* g(): Generator<number> { yield 1; }
      export function test(): number {
        const it = g();
        const next = (it as any).next;
        try { next.call({} as any); return 0; }
        catch (err) { return (err instanceof TypeError) ? 1 : 2; }
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("borrowed .return() on a non-generator receiver throws TypeError", async () => {
    const e = await compileAndRun(`
      export function* g(): Generator<number> { yield 1; }
      export function test(): number {
        const it = g();
        const ret = (it as any).return;
        try { ret.call({} as any, 5); return 0; }
        catch (err) { return (err instanceof TypeError) ? 1 : 2; }
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("does not regress a real generator's .next() round-trip", async () => {
    const e = await compileAndRun(`
      export function* count(): Generator<number> { yield 10; yield 20; }
      export function test(): number {
        const it = count();
        const a = it.next();   // 10
        const b = it.next();   // 20
        const c = it.next();   // done
        return a.value + b.value + (c.done ? 1000 : 0);
      }
    `);
    expect(e.test()).toBe(1030); // 10 + 20 + 1000
  });

  it("does not regress a real generator's .return()", async () => {
    const e = await compileAndRun(`
      export function* g(): Generator<number> { yield 1; yield 2; }
      export function test(): number {
        const it = g();
        it.next();
        const r = it.return(99);
        return r.done ? 99 : 0;
      }
    `);
    expect(e.test()).toBe(99);
  });

  it("the borrowed-receiver TypeError is catchable (not an unreachable trap)", async () => {
    // A trap would propagate out of the wasm call and surface as a host
    // RuntimeError, not a catchable in-module TypeError. This asserts the
    // throw is a real `__new_TypeError` + `throw $exc` the wasm catch handles.
    const e = await compileAndRun(`
      export function* g(): Generator<number> { yield 1; }
      export function test(): number {
        const it = g();
        const next = (it as any).next;
        let caught: number = 0;
        try { next.call({} as any); } catch (err) { caught = 1; }
        return caught;
      }
    `);
    expect(e.test()).toBe(1);
  });
});
