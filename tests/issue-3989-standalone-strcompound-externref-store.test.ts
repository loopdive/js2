// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3989 — the STORE half of #3472.
 *
 * #3472 fixed the LOAD side of `compileNativeStringCompoundAssignment`: an
 * externref slot is coerced to `ref $AnyString` before `__str_concat`. But
 * `__str_concat` also RETURNS `ref $AnyString`, and the result was stored
 * straight back into the externref slot:
 *
 *   __module_init failed: global.set[0] expected type externref,
 *                         found call of type (ref null 6)
 *
 * i.e. an INVALID module — which costs the whole file, not the statement.
 *
 * Repro shape (test262 `language/types/reference/S8.7_A4.js`):
 *
 *   var item = new String("test");   // String OBJECT wrapper -> externref slot
 *   var itemRef = item;
 *   item += "ing";                   // __str_concat -> ref $AnyString -> BOOM
 *
 * Fix: `extern.convert_any` before the store — the exact inverse of the
 * `any.convert_extern` the load uses — and report `externref` as the expression
 * type, since `local.tee` / `global.set`+`global.get` re-expose the SLOT type,
 * not the concat's return type.
 *
 * Gated on the same `noJsHost && externref-slot` condition as the load, so the
 * JS-host lane stays byte-identical (its load is deliberately uncoerced —
 * adding `__extern_toString` mid-body would shift function indices, #1175).
 */

async function instantiateStandalone(source: string) {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Empty import object — proves the module is JS-host-free (pure Wasm).
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3989 standalone: string += storing into an externref slot", () => {
  it("compiles a VALID module and preserves S8.7_A4 semantics", async () => {
    // The actual test262 assertion: `+=` on a String wrapper produces a NEW
    // primitive string, so `item` must no longer be `itemRef`.
    const ex = await instantiateStandalone(`
      var item = new String("test");
      var itemRef = item;
      item += "ing";
      export function test(): number {
        if (item == itemRef) { return 3; }
        return (item === "testing") ? 1 : 2;
      }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("concatenates by VALUE, not merely validating", async () => {
    const ex = await instantiateStandalone(`
      var item = new String("ab");
      item += "cde";
      export function test(): number { return item.length; }
    `);
    expect(ex.test!()).toBe(5);
  });

  it("composes across chained compound assignments", async () => {
    const ex = await instantiateStandalone(`
      var item = new String("a");
      item += "b";
      item += "c";
      export function test(): number { return (item === "abc") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("coerces a numeric RHS through ToString", async () => {
    const ex = await instantiateStandalone(`
      var item = new String("v");
      item += 42;
      export function test(): number { return (item === "v42") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("handles an aliased wrapper (the two-global form)", async () => {
    const ex = await instantiateStandalone(`
      var a = new String("t");
      var b = a;
      a += "ing";
      export function test(): number { return (a === "ting" && b !== a) ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("does not regress a plain string global (native-string ref slot)", async () => {
    const ex = await instantiateStandalone(`
      var s = "a";
      s += "b";
      export function test(): number { return (s === "ab") ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("does not regress the `let s = ''` builder pattern", async () => {
    const ex = await instantiateStandalone(`
      export function test(): number {
        let out = "";
        for (let i = 0; i < 3; i++) { out += "x"; }
        return (out === "xxx") ? 1 : 0;
      }
    `);
    expect(ex.test!()).toBe(1);
  });

  it("does not regress non-string wrapper compound assignment", async () => {
    // `new Number` etc. take the numeric path and were never affected; assert
    // it stays that way so a future widening of the gate is caught here.
    const ex = await instantiateStandalone(`
      var n = new Number(1);
      n += 1;
      export function test(): number { return (n === 2) ? 1 : 0; }
    `);
    expect(ex.test!()).toBe(1);
  });
});
