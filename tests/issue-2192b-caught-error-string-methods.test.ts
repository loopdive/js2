// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2192 follow-up — standalone: string METHODS on a caught-Error string field.
 *
 * #2192 made `e.message === "literal"` route through `__str_equals` for a
 * `catch (e)` binding. But the read's RESULT TYPE was only consumed by the
 * equality dispatch; a string METHOD call on the same read
 * (`e.message.charCodeAt(0)`, `e.name.indexOf("Range")`) still keyed its dispatch
 * off the receiver's STATIC type — `any` (the catch binding) — so it fell through
 * to the host `__extern_get`/dynamic path, which returns null/0 in standalone
 * mode.
 *
 * Fix: `receiverIsCaughtErrorStringRead` (property-access.ts) recognizes a
 * `<catchBinding>.message|name|stack` receiver, and the string-method dispatch in
 * calls.ts ORs it into the `isStringType` gate so the call routes through
 * `compileNativeStringMethodCall` (which compiles + flattens the receiver to a
 * `$AnyString` ref — already the read's result type in standalone mode).
 *
 * Scope (deliberately sliced — see the issue file): this covers i32/boolean-
 * returning string methods (`charCodeAt`, `indexOf`, `includes`, `startsWith`,
 * `endsWith`, …) on an EXPLICITLY-thrown error (`throw new X("…")`). Out of scope
 * here (deferred — broad `any`-receiver value-propagation work):
 *   - `e.message.length` — the `.length` dispatch is entangled with the generic
 *     `any`-receiver length/extern-get path; it returns 0 on main for ALL
 *     `any`-typed `.message.length` (not Error-specific).
 *   - chained string-RETURNING methods (`e.message.slice(1).charCodeAt(0)`) —
 *     the intermediate result's type isn't carried.
 *   - `.cause` — not a `$Error_struct` field yet.
 *   - errors from a runtime TRAP (`null.x`) rather than `new X()` — those don't
 *     populate the `$Error_struct` string fields the same way (separate gap).
 *
 * Values are read IN wasm (returned as numbers/booleans): a native-string ref
 * returned to a JS host reads as undefined, so assertions compute char codes /
 * indices / predicates inside the module.
 */

async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2192 follow-up — caught-Error string-field method calls (standalone)", () => {
  it("e.message.charCodeAt(0) reads the first code unit", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("msg1"); } catch (e) { return e.message.charCodeAt(0); }
      }
    `);
    expect(got).toBe(109); // 'm'
  });

  it("e.message.indexOf(substr) finds the index", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("hello"); } catch (e) { return e.message.indexOf("ll"); }
      }
    `);
    expect(got).toBe(2);
  });

  it("e.message.includes(substr) is a boolean predicate", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("hello"); } catch (e) { return e.message.includes("ell") ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("e.message.startsWith(prefix)", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("hello"); } catch (e) { return e.message.startsWith("he") ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("e.message.endsWith(suffix)", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("hello"); } catch (e) { return e.message.endsWith("lo") ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });

  it("e.name.charCodeAt(0) reads the error-type name", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new TypeError("x"); } catch (e) { return e.name.charCodeAt(0); }
      }
    `);
    expect(got).toBe(84); // 'T' of TypeError
  });

  it("e.name.indexOf(substr) on a RangeError", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new RangeError("x"); } catch (e) { return e.name.indexOf("Range"); }
      }
    `);
    expect(got).toBe(0);
  });

  it("no regression: a string method on a typed string still works", async () => {
    const got = await runStandalone(`
      export function test(): number {
        const s = "hello";
        return s.indexOf("ll");
      }
    `);
    expect(got).toBe(2);
  });

  it("no regression: e.message === literal (the #2192 equality slice) still holds", async () => {
    const got = await runStandalone(`
      export function test(): number {
        try { throw new Error("ab"); } catch (e) { return e.message === "ab" ? 1 : 0; }
      }
    `);
    expect(got).toBe(1);
  });
});
