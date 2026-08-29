// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4646: the graph-wide class tables (`structMap`, `classSet`, `structFields`,
// the method table) are keyed by class NAME, and several sites used
// `structMap.has(className)` as a stand-in for "this DECLARATION is already
// compiled". Two same-named class declarations in different scopes collapse
// onto that one key, so the second declaration's bodies were never emitted and
// every use of it ran the FIRST declaration's code — no invalid wasm and no
// compile error, just silently wrong results.
//
// #4618 fixed the shape the collection pass can see (two sibling function
// bodies). Three scopes it does NOT walk survived and are covered here:
//   - a class inside a class/object-literal METHOD body,
//   - two classes in sibling BLOCKS at module scope,
//   - two classes in sibling BLOCKS inside function bodies (the eager
//     top-level body lane deliberately clears `insideFunction`, so both wrote
//     the same name-keyed method-table entries and the second won).
//
// The real-world instance is test262's `harness/temporalHelpers.js`, which
// declares `class MySubclass extends construct` in five helper functions with
// different constructor bodies.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string, fileName: string) {
  const result = await compile(source, { testRuntime: true, fileName, skipSemanticDiagnostics: true });
  expect(result.errors ?? []).toEqual([]);
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4646 same-named classes in different scopes keep their own bodies", () => {
  it("each function's MySubclass runs its OWN constructor", async () => {
    // The temporalHelpers shape verbatim: one helper counts (`++called`), the
    // next assigns (`called = true`). Sharing one compiled body made the second
    // helper's assertion read a value produced by code it never wrote.
    const exp = await run(
      `
      export function checkConstructorCalled(): any {
        let called: any = 0;
        class MySubclass { constructor() { called = called + 1; } }
        new MySubclass();
        return called;
      }
      export function checkThisValueNotCalled(): any {
        let called: any = false;
        class MySubclass { constructor() { called = true; } }
        new MySubclass();
        return called;
      }`,
      "issue-4646-ctor-bodies.ts",
    );
    expect(exp.checkConstructorCalled!()).toBe(1);
    expect(exp.checkThisValueNotCalled!()).toBe(true);
  });

  it("five same-named subclasses of a dynamic parent each run their own constructor", async () => {
    // The full helper fan-out: `class MySubclass extends construct` declared in
    // five object-literal methods, reached through a dynamic `extends` value.
    const exp = await run(
      `
      class Base { tag: any; constructor(t: any) { this.tag = t; } }
      var Helpers: any = {
        h1(construct: any): any { let m: any = ""; class MySubclass extends construct { constructor() { super("b"); m = "one"; } } new MySubclass(); return m; },
        h2(construct: any): any { let m: any = ""; class MySubclass extends construct { constructor() { super("b"); m = "two"; } } new MySubclass(); return m; },
        h3(construct: any): any { let m: any = ""; class MySubclass extends construct { constructor() { super("b"); m = "three"; } } new MySubclass(); return m; },
        h4(construct: any): any { let m: any = ""; class MySubclass extends construct { constructor() { super("b"); m = "four"; } } new MySubclass(); return m; },
        h5(construct: any): any { let m: any = ""; class MySubclass extends construct { constructor() { super("b"); m = "five"; } } new MySubclass(); return m; },
      };
      export function t(): any {
        return Helpers.h1(Base) + "," + Helpers.h2(Base) + "," + Helpers.h3(Base) + "," +
               Helpers.h4(Base) + "," + Helpers.h5(Base);
      }`,
      "issue-4646-five-helpers.ts",
    );
    expect(exp.t!()).toBe("one,two,three,four,five");
  });

  it("a class declared in a class METHOD body is not the same class as a same-named one in a function", async () => {
    // The collection pass never walks class-method bodies, so this declaration
    // was never collected: it took the name-keyed early return and answered
    // with the function-scope class's (absent) member — `null`.
    const exp = await run(
      `
      class Holder { m(): any { class Foo { where(): any { return "method"; } } return new Foo().where(); } }
      function g(): any { class Foo { where(): any { return "function"; } } return new Foo().where(); }
      export function t(): any { return new Holder().m() + "|" + g(); }`,
      "issue-4646-method-body-class.ts",
    );
    expect(exp.t!()).toBe("method|function");
  });

  it("same-named classes in sibling BLOCKS at module scope keep their own bodies", async () => {
    const exp = await run(
      `
      var r1: any = "";
      var r2: any = "";
      { class Foo { tag(): any { return "block1"; } } r1 = new Foo().tag(); }
      { class Foo { tag(): any { return "block2"; } } r2 = new Foo().tag(); }
      export function t(): any { return r1 + "|" + r2; }`,
      "issue-4646-module-blocks.ts",
    );
    expect(exp.t!()).toBe("block1|block2");
  });

  it("same-named classes in sibling BLOCKS inside functions keep their own bodies", async () => {
    const exp = await run(
      `
      function f(): any { { class Foo { tag(): any { return "f"; } } return new Foo().tag(); } }
      function g(): any { { class Foo { tag(): any { return "g"; } } return new Foo().tag(); } }
      export function t(): any { return f() + "|" + g(); }`,
      "issue-4646-function-blocks.ts",
    );
    expect(exp.t!()).toBe("f|g");
  });

  it("same-named classes in sibling blocks of ONE function keep their own field initializers", async () => {
    const exp = await run(
      `
      export function t(): any {
        let a: any = "";
        let b: any = "";
        { class Foo { v: any = "first"; } a = new Foo().v; }
        { class Foo { v: any = "second"; } b = new Foo().v; }
        return a + "|" + b;
      }`,
      "issue-4646-block-fields.ts",
    );
    expect(exp.t!()).toBe("first|second");
  });
});
