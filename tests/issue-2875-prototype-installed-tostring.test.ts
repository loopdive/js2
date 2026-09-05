// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2875 sub-cluster b2 — a `toString` installed on a plain function
// constructor's PROTOTYPE, then called directly on an instance.
//
//     function F(v){ this.value = v; }
//     F.prototype.toString = function(){ return "T" + this.value; };
//     new F(7).toString();          // spec "T7"; base answered "[object Object]"
//
// #4482 taught the direct-`.toString()` arm to step aside when the program
// installs its OWN `toString` on the receiver, but it only saw two routes: a
// write on the BINDING (`a.toString = …`) and a write on `this` inside the
// constructor. The prototype route's receiver is `F.prototype`, which matches
// neither — so the static `Object.prototype.toString` arm kept answering
// "[object Object]" for an instance whose prototype defines a real `toString`.
// An ORDINARY prototype method (`F.prototype.gimme`) already dispatched
// correctly, which is what makes this a repair of one name rather than a
// missing feature.
//
// SCOPE, stated plainly: this fixes the DIRECT call only. `String(i)`, `"" + i`
// and a borrowed `String.prototype.<m>` on the same receiver still render
// "[object Object]" — they route through the `__call_toString` dispatcher
// (index.ts `emitDispatchForMethod`), which builds entries from own struct
// FIELDS and has no prototype-installed arm. That is why this change moves no
// test262 row; see the issue's Slice E note.
//
// Compile through the SAME lane the test262 standalone runner uses — literal
// JavaScript with `allowJs`.
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
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2875 b2 — prototype-installed toString on a plain function constructor", () => {
  it("new F(7).toString() runs F.prototype.toString", async () => {
    expect(
      await runStandalone(
        `export function test() {
           function F(v) { this.value = v; }
           F.prototype.toString = function () { return "T" + this.value; };
           var i = new F(7);
           return i.toString() === "T7" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("the test262 slice/S15.5.4.13_A3_T4 shape stringifies to 'undefined'", async () => {
    expect(
      await runStandalone(
        `export function test() {
           function F(value) { this.value = value; }
           F.prototype.toString = function () { return this.value + ""; };
           var i = new F(void 0);
           var t = i.toString();
           return (typeof t === "string" && t === "undefined") ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("an ordinary prototype method is unchanged", async () => {
    expect(
      await runStandalone(
        `export function test() {
           function F(v) { this.value = v; }
           F.prototype.gimme = function () { return "G" + this.value; };
           var i = new F(7);
           return i.gimme() === "G7" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("a constructor with NO prototype toString keeps the static arm", async () => {
    expect(
      await runStandalone(
        `export function test() {
           function F(v) { this.value = v; }
           var i = new F(7);
           return i.toString() === "[object Object]" ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});
