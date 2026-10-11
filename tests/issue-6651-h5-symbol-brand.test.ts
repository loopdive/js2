// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 cluster H, slice H5 — the SYMBOL brand on a wrapper's
// `[[PrimitiveValue]]` slot, `--target standalone`.
//
// Lane I4 landed the Symbol wrapper carrier, so `Object(sym)` now builds a real
// `[[PrimitiveValue]]` `$Object` on the host-free lane. It stopped one step
// short: the two ladders that classify a wrapper by the BOX TYPE in that slot
// knew `$AnyString` → String, `$__box_number`/i31 → Number and `$__box_boolean`
// → Boolean, and had no `$Symbol` row. So a Symbol wrapper answered the Object
// brand and `Symbol.prototype`'s members were unreachable from it.
//
// Two ladders, one rule, and they answer DIFFERENT questions:
//
//  - `__protoidx_brand_off` (proto-index-store.ts) classifies the RECEIVER and
//    is key-AGNOSTIC — `__protoidx_get_k` hands the key straight to
//    `__obj_find`. That is the one that can serve a SYMBOL key, which is how
//    `Object(Symbol.toPrimitive)[Symbol.toPrimitive]` reaches the seeded `@@3`
//    companion entry. (Symbol-keyed reads carry a boxed `$Symbol` externref,
//    never a string, so the string-key ladder below cannot look at them at all.)
//  - `wrapperClassify` (native-proto-instance-method-read.ts) answers the
//    inherited-builtin-method VALUE read for a STRING key, so that
//    `Object(sym).toString` IS `Symbol.prototype.toString` rather than
//    `Object.prototype`'s different function object.
//
// KNOWN LIMIT, measured and deliberately not closed here (see the issue
// receipt): both ladders live inside the #2175 proto-index store, which a
// module only materializes when it is "proto-member dirty" — when a builtin
// `.prototype` reaches the dynamic reader as a VALUE. A module that builds a
// Symbol wrapper but never names a builtin prototype arms neither the store nor
// the Symbol companion seeder, so it still answers `undefined`. Arming the
// store from `Object(sym)` was measured at +57,125 bytes (139,254 → 196,379) on
// the smallest program that shows the defect — far more than the one test262
// row it would move. The `not-dirty` case below LOCKS that boundary so a future
// reader sees it is a known gate, not an oversight.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // A leaked `env` import would mean the case silently ran on a JS host
  // fast-path and the answer is not the standalone substrate's.
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

/** Names a builtin prototype as a VALUE — the #2175 arming condition. */
const ARM = `const __keep: any = Symbol.prototype;\n`;

describe("#6651 H5 — a Symbol wrapper classifies as the Symbol brand", () => {
  it("a symbol-keyed @@toPrimitive read off the wrapper is a function [base: undefined]", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const s: any = Object(Symbol.toPrimitive);
        const f: any = s[Symbol.toPrimitive];
        return typeof f === "function" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("…and calling it returns the wrapped symbol (§20.4.3.5 thisSymbolValue) [base: trap]", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const s: any = Object(Symbol.toPrimitive);
        return s[Symbol.toPrimitive]() === Symbol.toPrimitive ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the inline spelling test262 uses works too — no intermediate binding", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        return (Object(Symbol.toPrimitive) as any)[Symbol.toPrimitive]() === Symbol.toPrimitive ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a transferred @@toPrimitive still unwraps the wrapper receiver", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const s: any = Object(Symbol.toPrimitive);
        const f: any = s[Symbol.toPrimitive];
        return f.call(s) === Symbol.toPrimitive ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the wrapper's inherited toString is Symbol.prototype's, not Object.prototype's", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const o: any = Object(Symbol("x"));
        return o.toString() === "Symbol(x)" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("valueOf on the wrapper recovers the identical symbol", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const s = Symbol("y");
        const o: any = Object(s);
        return o.valueOf() === s ? 1 : 0;
      }`),
    ).toBe(1);
  });

  // The LOCK described in the header: this is the demand gate, not a bug.
  it("LOCK: a module that names no builtin prototype still answers undefined", async () => {
    expect(
      await runStandalone(`export function run(): number {
        const s: any = Object(Symbol.toPrimitive);
        return typeof s[Symbol.toPrimitive] === "undefined" ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#6651 H5 — the other three wrapper brands are unchanged", () => {
  it("a String wrapper still answers String.prototype", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const o: any = Object("ab");
        return o.toString() === "ab" && o.valueOf() === "ab" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a Number wrapper still answers Number.prototype", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const o: any = Object(5);
        return o.valueOf() === 5 && o.toString() === "5" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a Boolean wrapper still answers Boolean.prototype", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const o: any = Object(true);
        return o.valueOf() === true && o.toString() === "true" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a plain object is still the Object brand — the new row must not claim it", async () => {
    expect(
      await runStandalone(`${ARM}export function run(): number {
        const o: any = { a: 1 };
        return o.toString() === "[object Object]" && o.hasOwnProperty("a") ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
