// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2924 — `new Function("<const>")` compile-away MVP (slice B of the
// runtime-eval roadmap, docs/architecture/runtime-eval-interpreter.md §6-B).
//
// Per §20.2.1.1 CreateDynamicFunction the created function's scope is ALWAYS
// the global environment (no lexical capture), so a constant param list + body
// is compiled away to a real AOT function at the call site:
//   - value form: `new Function(...)` / `Function(...)` → capture-free closure
//     (`tryStaticNewFunction`, materialized via emitFuncRefAsClosure),
//   - immediate-call form: `new Function(...)(args)` / `Function(...)(args)` →
//     direct `call` against the synthesized funcIdx
//     (`tryStaticFunctionCtorCall`, marshalled per the reserved signature).
//
// Non-constant (dynamic) bodies keep falling to the legacy no-op stub — the
// Tier-2 interpreter (#2928) owns those. Pure AOT — no host imports.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // A compiled-away Function body must not leak any host import.
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2924 — new Function('<const>') compile-away (standalone)", () => {
  it('acceptance 1: new Function("a","b","return a+b")(1,2) === 3 (immediate call)', async () => {
    expect(
      await runStandalone(
        `export function test(): number { return new Function("a","b","return a+b")(1,2) === 3 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it('acceptance 2: Function("return 42")() === 42 (plain-call form)', async () => {
    expect(
      await runStandalone(`export function test(): number { return Function("return 42")() === 42 ? 1 : 0; }`),
    ).toBe(1);
  });

  it('acceptance 3 (flatten): params spread across args — new Function("a","b,c","return c")(1,2,3) === 3', async () => {
    // The comma-split flatten itself (§20.2.1.1.1). The issue's exact
    // `return a+b+c` body is blocked standalone by the pre-existing
    // chained-any-add substrate gap (result of one any-add cannot feed the
    // next; eval("function q(a,b,c){return a+b+c} q(1,2,3)") fails
    // identically) — covered in host mode below and tracked as a follow-up.
    expect(
      await runStandalone(
        `export function test(): number { return new Function("a","b,c","return c")(1,2,3) === 3 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("acceptance 4: a body identifier colliding with a caller local resolves as a GLOBAL (no capture)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const x = 99; if (x) {} const f = new Function("return typeof x"); return f() === "undefined" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it('acceptance 5: new Function("return")() === undefined via a REAL callable', async () => {
    expect(
      await runStandalone(
        `export function test(): number { const f = new Function("return"); return f() === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("no-arg new Function() → function anonymous() {} (callable, returns undefined)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const f = new Function(); return f() === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("value form via variable: const f = new Function(...); f(1,2) — dynamic closure dispatch", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const f = new Function("a","b","return a+b"); return f(1,2) as number; }`,
      ),
    ).toBe(3);
  });

  it("gives a constant-AOT Function value its ordinary own prototype descriptor", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const f = new Function("", "null");
        const p = f.prototype;
        const d = Object.getOwnPropertyDescriptor(f, "prototype");
        return f.hasOwnProperty("prototype") && typeof p === "object" &&
          d !== undefined && d.value === p && d.writable === true &&
          d.enumerable === false && d.configurable === false && f.prototype === p ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("f64-resolved body result coerces (return 42 checker-resolves to number)", async () => {
    expect(
      await runStandalone(`export function test(): number { return new Function("return 42")() as number; }`),
    ).toBe(42);
  });

  it("extra args are evaluated then ignored (§7.3.14)", async () => {
    // (`return typeof a` would be the sharper probe, but the boxed-primitive
    // typeof layer misreports a marshalled boxed number in standalone — the
    // known #1629b-class rep gap. Identity return keeps the test honest.)
    expect(
      await runStandalone(
        `export function test(): number { let n = 0; const bump = (): number => { n = n + 1; return n; }; const r = new Function("a","return a")(7, bump(), bump()); return r === 7 && n === 2 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("missing args pad undefined (§7.3.14)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return new Function("a","b","return b")(1) === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#2924 — unsupported shapes keep the legacy fallback (clean bail, no compile error)", () => {
  async function compiles(src: string): Promise<boolean> {
    const r = await compile(src, { target: "standalone" });
    return r.success;
  }

  it("dynamic (non-constant) body falls through to the stub — still compiles", async () => {
    expect(
      await compiles(
        `export function test(): number { const b: string = "return 1"; const f = new Function(b); return f === null ? 0 : 1; }`,
      ),
    ).toBe(true);
  });

  it("strict-prologue body bails (strict early-errors not enforced by the splice)", async () => {
    // Value must still compile; the callable falls back to the legacy stub.
    expect(
      await compiles(`export function test(): number { const f = new Function("'use strict'; return 1"); return 1; }`),
    ).toBe(true);
  });

  it("malformed body (SyntaxError case) does not become a compile error", async () => {
    expect(await compiles(`export function test(): number { const f = new Function("|||"); return 1; }`)).toBe(true);
  });

  // (#2474 park fix) A sloppy dynamic function's bare call must see
  // this === globalThis (§10.4.3), which the splice cannot provide — any
  // `this` in the body bails to the legacy path. Guards the 4 parked
  // language/function-code/10.4.3-1-1{3,5}{-s,gs} regressions.
  it('body referencing `this` bails ("return typeof this;" — never a wrongly-strict "undefined")', async () => {
    expect(
      await compiles(`export function test(): number { const f = new Function("return typeof this;"); return 1; }`),
    ).toBe(true);
  });
});

describe("#2924 — host (gc) mode", () => {
  it("the issue's exact a+b+c flatten shape computes in host mode (value form)", async () => {
    // Value form: host-mode dynamic dispatch computes the chained add
    // correctly; the standalone chained-any-add gap is the follow-up issue.
    const r = await compile(
      `export function test(): number { const f = new Function("a","b,c","return a+b+c"); return f(1,2,3) === 6 ? 1 : 0; }`,
      {},
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { buildImports } = await import("../src/runtime.js");
    const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports & {
      setExports?: (e: WebAssembly.Exports) => void;
    };
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  // (#2474 park fix) funcIdx staleness: host-mode arg compiles add late
  // imports and shift function indices between synthesis and the emitted
  // `call` — the 3-arg immediate call targeted the wrong function (wrong
  // value / invalid Wasm in the [CI-FIX] handoff findings). The emit now
  // re-fetches the index from funcMap after arg marshalling.
  it("host immediate call with 3 args survives late-import index shifts", async () => {
    const r = await compile(
      `export function test(): number { return new Function("a","b","c","return c")(1,2,3) as number; }`,
      {},
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { buildImports } = await import("../src/runtime.js");
    const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports & {
      setExports?: (e: WebAssembly.Exports) => void;
    };
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports as { test(): number }).test()).toBe(3);
  });

  it("host two immediate calls in one expression each target their own synthesized fn", async () => {
    const r = await compile(
      `export function test(): number { return (new Function("a","return a")(1) as number) + (new Function("a","return a")(2) as number); }`,
      {},
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { buildImports } = await import("../src/runtime.js");
    const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports & {
      setExports?: (e: WebAssembly.Exports) => void;
    };
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports as { test(): number }).test()).toBe(3);
  });
});
