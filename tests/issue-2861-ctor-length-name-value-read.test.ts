// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2861 (slice 4) — standalone `<Ctor>.length` (declared arity) / `<Ctor>.name`
// (ctor name string) value reads.
//
// Reading a built-in constructor's own `length`/`name` AS A VALUE refused in
// standalone with the "built-in static property value read is not supported in
// --target standalone (#1907 / #1888 S6-b)" compile error (e.g.
// `test/built-ins/Boolean/S15.6.3_A3.js` reads `Boolean.length`). Both are
// statically known per constructor name, so they fold to a constant:
//   - `<Ctor>.length` → the ctor's declared arity (an `f64.const` / `i32.const`),
//     via the new BUILTIN_CTOR_ARITY table (values verified against Node).
//   - `<Ctor>.name`   → the ctor-name string (`Ctor.name === "Ctor"`).
// The fold is wired through the existing native-constant defer path
// (`hasNativeBuiltinConstantHandler` → downstream emitter), mirroring the
// `BYTES_PER_ELEMENT` / `Math.PI` folds. Host (gc) mode is unchanged — it reads
// the identical value via `__get_builtin` and never reaches the fold. The
// NAMESPACES (Math/JSON/Reflect/Atomics) are excluded (their `.length`/`.name`
// are `undefined`), so they keep refusing (namespace static reads are the #2860
// follow-up).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2861 slice 4 — standalone <Ctor>.length declared-arity fold", () => {
  it("Boolean.length === 1 (was a compile refusal — S15.6.3_A3)", async () => {
    expect(await runStandalone(`export function test(): number { return Boolean.length; }`)).toBe(1);
  });

  it("Symbol.length === 0 (not pre-empted by the Symbol well-known branch)", async () => {
    expect(await runStandalone(`export function test(): number { return Symbol.length; }`)).toBe(0);
  });

  it("Date.length === 7", async () => {
    expect(await runStandalone(`export function test(): number { return Date.length; }`)).toBe(7);
  });

  it("RegExp.length === 2", async () => {
    expect(await runStandalone(`export function test(): number { return RegExp.length; }`)).toBe(2);
  });

  it("Map.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return Map.length; }`)).toBe(0);
  });

  it("Int8Array.length === 3", async () => {
    expect(await runStandalone(`export function test(): number { return Int8Array.length; }`)).toBe(3);
  });

  it("TypeError.length === 1", async () => {
    expect(await runStandalone(`export function test(): number { return TypeError.length; }`)).toBe(1);
  });

  it("DisposableStack.length === 0", async () => {
    expect(await runStandalone(`export function test(): number { return DisposableStack.length; }`)).toBe(0);
  });
});

describe("#2861 slice 4 — standalone <Ctor>.name string fold", () => {
  it("Boolean.name is a string equal to 'Boolean'", async () => {
    expect(await runStandalone(`export function test(): number { return Boolean.name === "Boolean" ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("Array.name.length === 5 ('Array')", async () => {
    expect(await runStandalone(`export function test(): number { const n: any = Array.name; return n.length; }`)).toBe(
      5,
    );
  });

  it("TypeError.name === 'TypeError'", async () => {
    expect(
      await runStandalone(`export function test(): number { return TypeError.name === "TypeError" ? 1 : 0; }`),
    ).toBe(1);
  });
});

describe("#2861 slice 4 — a shadowing local wins over the ctor fold", () => {
  it("a local `Boolean = { length: 42 }` reads 42, not the fold", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const Boolean: any = { length: 42 }; return Boolean.length; }`,
      ),
    ).toBe(42);
  });
});

describe("#2861 slice 4 — namespace .length reads (#2860)", () => {
  // (#7014 wave 15) This used to pin a compile REFUSAL while namespace value
  // reads were out of scope. Standalone now compiles the read, and it answers
  // exactly what JS does — Math is not a function, so `Math.length` is
  // undefined (re-measured 2026-10-17 on upstream main 0727e2985b).
  it("Math.length reads undefined (Math is not a function)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const v: any = Math.length; return v === undefined ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#2861 slice 4 — sibling native-constant reads unregressed", () => {
  it("Int8Array.BYTES_PER_ELEMENT still folds to 1", async () => {
    expect(await runStandalone(`export function test(): number { return Int8Array.BYTES_PER_ELEMENT; }`)).toBe(1);
  });

  it("Math.PI still folds", async () => {
    expect(
      await runStandalone(`export function test(): number { return Math.PI > 3.14 && Math.PI < 3.15 ? 1 : 0; }`),
    ).toBe(1);
  });
});
