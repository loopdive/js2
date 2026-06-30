// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2891 — standalone object-operand relational/additive ToPrimitive.
//
// When an object operand's `valueOf` returns a NON-primitive (an object),
// §7.1.1.1 OrdinaryToPrimitive must fall through to `toString`, and throw a
// TypeError only when neither own method yields a primitive. Pre-#2891 the
// standalone `__class_to_primitive` driver accepted the first dispatcher's
// non-null result even when it was an object (so `valueOf` returning an object
// short-circuited the fall-through → wrong relational value / NaN), and
// single-literal object structs were not dispatched at all. All fixes are
// standalone-only; the WasmGC/host path is untouched.

async function runStandalone(src: string): Promise<{ ret: unknown; imports: number }> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // Host-free: a standalone binary needs no host imports.
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { ret: (instance.exports as { test: () => unknown }).test(), imports: r.imports.length };
}

describe("#2891 standalone ToPrimitive in relational/additive operators", () => {
  it("relational: valueOf returning an object falls through to toString (host-free)", async () => {
    const { ret, imports } = await runStandalone(
      `export function test(): boolean { return (1 < {valueOf: function() {return {}}, toString: function() {return 2}}); }`,
    );
    expect(imports).toBe(0);
    expect(ret).toBe(1); // 1 < 2 === true
  });

  it("relational: object with only toString reduces via toString (host-free)", async () => {
    const { ret, imports } = await runStandalone(
      `export function test(): boolean { return (1 < {toString: function() {return 2}}); }`,
    );
    expect(imports).toBe(0);
    expect(ret).toBe(1);
  });

  it("relational: valueOf returning an object with no toString → [object Object] → NaN → false", async () => {
    const { ret, imports } = await runStandalone(
      `export function test(): boolean { return ({valueOf: function() {return {}}} < 1); }`,
    );
    expect(imports).toBe(0);
    expect(ret).toBe(0); // NaN < 1 === false
  });

  it("relational: non-constant toString fallback (not constant-folded)", async () => {
    const { ret, imports } = await runStandalone(
      `export function test(): boolean { const x = 9; return (1 < {valueOf: function() {return {}}, toString: function() {return x + 1;}}); }`,
    );
    expect(imports).toBe(0);
    expect(ret).toBe(1); // 1 < 10 === true
  });

  it("additive: valueOf returning an object falls through to toString (host-free)", async () => {
    const { ret, imports } = await runStandalone(
      `export function test(): number { return (1 + {valueOf: function() {return {}}, toString: function() {return 1}}); }`,
    );
    expect(imports).toBe(0);
    expect(ret).toBe(2);
  });

  it("additive: valueOf returning a primitive wins over toString", async () => {
    const { ret, imports } = await runStandalone(
      `export function test(): number { return ({valueOf: function() {return 1}, toString: function() {return 9}} + 1); }`,
    );
    expect(imports).toBe(0);
    expect(ret).toBe(2);
  });

  it("both valueOf and toString returning objects throws (host-free §7.1.1.1 TypeError)", async () => {
    const r = await compile(
      `export function test(): number { return (1 + {valueOf: function() {return {}}, toString: function() {return {}}}); }`,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect(() => (instance.exports as { test: () => unknown }).test()).toThrow();
  });

  it("WasmGC/host mode compiles unaffected (control)", async () => {
    // All #2891 fixes are gated on `ctx.standalone` (the `__class_to_primitive`
    // driver is reserved only in standalone, and the dispatcher widening is
    // `ctx.standalone`-only), so the default WasmGC/host lowering is untouched —
    // the emitted GC binary is byte-identical to pre-#2891. Running it here would
    // require the JS-host ToPrimitive runtime (not the bare import object), so we
    // assert the GC compile still succeeds (no CE introduced) rather than execute.
    const r = await compile(
      `export function test(): boolean { return (1 < {valueOf: function() {return {}}, toString: function() {return 2}}); }`,
      { skipSemanticDiagnostics: true },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.binary.length).toBeGreaterThan(0);
  });
});
