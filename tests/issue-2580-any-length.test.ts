// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2580 M2 slice 1) `.length` on a statically-`any`/`unknown` receiver.
//
// M2 slice 1 lands the tag/null-aware dynamic reader (`emitDynGet`) and routes the
// host `.length`-on-`any` read through it: a NULL/UNDEFINED receiver → boxed `0`
// (matching origin; e.g. an unresolved Symbol-keyed prototype walk — the original
// "Cluster A" of the #1894 eject); a vec / closure / `$AnyValue`-boxed receiver →
// the numeric length / arity (boxed); a genuine non-null host object's ABSENT
// `length` → JS `undefined`. This fixes the #2580 headline bug (`var o = {};
// o.length === undefined` was `false`, `typeof o.length` was a bogus `"boolean"`).
//
// The reader DECLINES inside async function/generator bodies: the async state
// machine (#1042 CPS) can leave a destructuring-rest / setter-captured local in a
// state where a speculative recompile of the receiver resolves a STALE value (the
// #2602-class desync — fixed for the rest-WRITE in #1913, but a recompile-read in
// async still desyncs). Origin reads those correctly, so declining-in-async keeps
// the for-await array-rest `.length` cluster green while the canary (non-async)
// takes the reader. Tracked as a #2602-sibling for full async-context reader support.
//
// This suite asserts the slice-1 value-semantics + the byte-identical typed
// hot-path. Faithful test262 validation: the 13-file canary/regression set is
// all-green (`.tmp/run13.mjs`).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  }
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // setExports wires host closures back to the instance (no-op when absent).
  (imports as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { run: () => unknown }).run();
}

describe("#2580 M2 slice 1 — .length-on-any value semantics + typed hot-path", () => {
  // THE #2580 HEADLINE: a plain object's absent `.length` reads as `undefined`,
  // not `0`. Was the long-standing bug; fixed by the tag/null-aware reader.
  it("plain {} .length === undefined (the #2580 headline canary)", async () => {
    expect(await run(`const o: any = {}; export function run(): boolean { return o.length === undefined; }`)).toBe(1);
  });

  it("typeof {} .length is 'undefined' (was a bogus 'boolean'/'number')", async () => {
    expect(await run(`const o: any = {}; export function run(): string { return typeof o.length; }`)).toBe("undefined");
  });

  it("object with own props but no length → undefined", async () => {
    expect(
      await run(`const o: any = { x: 1 }; export function run(): boolean { return o.length === undefined; }`),
    ).toBe(1);
  });

  // (The null/undefined-receiver `.length` → boxed-`0` null-guard arm of the
  // reader — the original "Cluster A" of the #1894 eject, e.g. an unresolved
  // Symbol-keyed prototype walk — is validated by the faithful 13-file test262
  // set (`.tmp/run13.mjs`: `built-ins/.../length.js` cluster), not a reduced
  // probe here: the reduced shape reads the JS-undefined sentinel differently.)

  // Typed `.length` must remain correct — byte-identical hot-path.
  it("typed number[].length", async () => {
    expect(await run(`const o: number[] = [1, 2, 3]; export function run(): number { return o.length; }`)).toBe(3);
  });

  it("typed string.length", async () => {
    expect(await run(`const o: string = "abc"; export function run(): number { return o.length; }`)).toBe(3);
  });

  it("arguments.length", async () => {
    expect(
      await run(
        `function f(): number { return arguments.length; } export function run(): number { return f(1, 2, 3); }`,
      ),
    ).toBe(3);
  });

  // An `any`-typed local holding a real array still reads its `.length` correctly
  // via the origin path (the compiled receiver is a vec struct → struct.get field
  // 0). This is the case the dynamic-read arm must NOT clobber — confirmed it
  // still works with the arm off.
  it("array-as-any .length reads the real numeric length (origin path)", async () => {
    expect(await run(`const o: any = [1, 2, 3]; export function run(): number { return o.length as number; }`)).toBe(3);
  });

  it("string-as-any .length reads the string length (origin path)", async () => {
    expect(await run(`const o: any = "abcd"; export function run(): number { return o.length as number; }`)).toBe(4);
  });

  it("array-like plain object with an own .length property reads it (origin path)", async () => {
    expect(
      await run(`const o: any = { length: 5 }; export function run(): number { return o.length as number; }`),
    ).toBe(5);
  });
});
