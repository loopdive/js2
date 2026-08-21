// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4602) The #4504 inherited-[[Set]] machinery is gated PER KEY: a suspicious
// descriptor trigger whose key is statically known poisons only that key, so
// unrelated member writes keep the pre-#4504 direct physical path. This suite
// pins the SEMANTIC side of that gate — every poisoned key must still observe
// its descriptor, through each collection route the scan implements:
//
//   1. a literal `defineProperty` key,
//   2. the buble/rollup ES5 identifier-bag shape
//      (`var acc = {…}; acc.k.get = fn; Object.defineProperties(proto, acc)`),
//   3. an ALIAS escape of the bag (forces the module-wide flag, so a key the
//      per-key walk never saw is still honored).
//
// Clean-key behavior is pinned alongside each case: the point of #4602 is that
// those writes compile to the pre-#4504 path, and they must stay correct.
// (The perf claim itself is measured in the issue file, not asserted here —
// acorn standalone-dynamic 0.075 → 0.138 same-machine, back to its pre-#4658
// band.)
//
// STANDALONE lane only, deliberately: the #4504 machinery this gates is
// standalone-only (`ctx.standalone && …`), and the js-host lane does not honor
// function-constructor prototype accessors at all — verified IDENTICAL on main
// (2026-08-21, `.tmp` probe: every gc-lane case below already fails on
// `26a1801` without this change). Two more shapes are pre-existing standalone
// gaps, also verified main-identical, and are NOT pinned here: a bag GROWN by
// direct writes (`const bag: any = {}; bag.k = {…}` — the module does not
// instantiate), and a frozen prototype refusing an inherited write (freeze
// support predates #4504 and never refused). The scan still classifies both
// conservatively (key-add / all-dirty).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" as const });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4602 — per-key inherited-set gate (standalone)", () => {
  it("a literal defineProperty setter key is honored while a clean key writes directly", async () => {
    expect(
      await run(
        `function C(this: any) {}
         Object.defineProperty(C.prototype, "poisoned", {
           set: function (this: any, v: number) {
             this.log = v * 2;
           },
           configurable: true,
         });
         export function test(): number {
           const c: any = new (C as any)();
           c.clean = 7; // clean key — pre-#4504 direct path
           c.poisoned = 21; // must reach the inherited setter
           return c.log === 42 && c.clean === 7 && c.poisoned === undefined ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("the buble identifier-bag getter is honored and hot writes on other keys stay correct", async () => {
    expect(
      await run(
        `function Parser(this: any) {
           this.pos = 0;
         }
         const prototypeAccessors: any = { doubled: { configurable: true } };
         prototypeAccessors.doubled.get = function (this: any) {
           return this.pos * 2;
         };
         Object.defineProperties(Parser.prototype, prototypeAccessors);
         export function test(): number {
           const p: any = new (Parser as any)();
           let sum = 0;
           for (let i = 0; i < 100; i++) {
             p.pos = i; // clean key — the acorn hot shape
             sum += p.doubled; // poisoned key — must run the getter
           }
           return sum === 9900 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });

  it("an aliased bag escapes per-key tracking and its late key is still honored", async () => {
    expect(
      await run(
        `function C(this: any) {}
         const bag: any = { known: { configurable: true, get: function () { return 1; } } };
         const alias: any = bag; // escape — the scan must fall back to all-keys
         alias.late = {
           set: function (this: any, v: number) {
             this.seen = v * 3;
           },
           configurable: true,
         };
         Object.defineProperties(C.prototype, bag);
         export function test(): number {
           const c: any = new (C as any)();
           c.late = 14;
           return c.seen === 42 && c.known === 1 ? 1 : 0;
         }`,
      ),
    ).toBe(1);
  });
});
