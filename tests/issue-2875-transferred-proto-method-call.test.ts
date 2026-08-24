// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 sub-cluster b2 — a builtin prototype method TRANSFERRED into an object
// literal and called through that object's own slot.
//
//     var o = { toString: …, charAt: String.prototype.charAt };
//     o.charAt(1);        // spec "b"; base THREW
//                         // "TypeError: Cannot access property on null or undefined"
//
// The `.call` spelling of the SAME operation already answered correctly, so the
// two spellings disagreed. Root cause: `compileCallablePropertyCall`'s funcref
// dispatch admits candidates by EXACT param count against the field's DECLARED
// signature (`charAt: (pos: number) => string`, 1 param), while a native-proto
// member closure is lifted to `(self, this, …args)` — 2 params — so nothing
// matched, the guarded `ref.cast` nulled out, and the null funcref surfaced as
// that TypeError. `transferred-native-proto-call.ts` resolves the initializer
// SYNTAX and re-emits through the one reflective emitter both spellings share.
//
// Compile through the SAME lane the test262 standalone runner uses — literal
// JavaScript with `allowJs`. A `.ts` probe does NOT reproduce this: an
// annotated receiver takes a different, statically-typed member-call route.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(r.imports ?? []).toEqual([]); // host-free
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2875 b2 — transferred builtin-proto method called through its slot", () => {
  it("o.charAt(1) runs the receiver's own toString (test262 charAt/S15.5.4.4_A5 shape)", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var o = {
             toString: function () { return "abcd"; },
             charAt: String.prototype.charAt
           };
           return o.charAt(1) === "b" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("a THROWING toString propagates out of the slot call, not a TypeError", async () => {
    // The exact assertion of charAt/S15.5.4.4_A5 and charCodeAt/S15.5.4.5_A4:
    // the receiver's `toString` must run FIRST, so its abrupt completion — not
    // a dispatch failure — is what escapes.
    expect(
      await runStandalone(
        `export function test() {
           var o = {
             valueOf: 1,
             toString: function () { throw "intostring"; },
             charAt: String.prototype.charAt
           };
           try { o.charAt(); return 0; } catch (e) { return e === "intostring" ? 1 : 0; }
         }`,
      ),
    ).toBe(1);
  });

  it("charCodeAt through a slot agrees with the .call spelling", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var o = {
             toString: function () { return "abcd"; },
             charCodeAt: String.prototype.charCodeAt
           };
           return o.charCodeAt(2) === String.prototype.charCodeAt.call(o, 2) ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("a REASSIGNED slot keeps the pre-existing lowering (arm declines)", async () => {
    // The initializer no longer proves what the slot holds, so the arm must
    // step aside rather than run `String.prototype.charAt` on the receiver.
    expect(
      await runStandalone(
        `export function test() {
           var o = { charAt: String.prototype.charAt };
           o.charAt = function (i) { return "Z"; };
           return o.charAt(0) === "Z" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("an ordinary object-literal method is unaffected", async () => {
    expect(
      await runStandalone(
        `export function test() {
           var o = { value: 5, twice: function () { return this.value * 2; } };
           return o.twice() === 10 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});
