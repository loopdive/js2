// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6973 stage 2) An ordinary `a[i] = v` on an array element that already
// exists must not allocate a descriptor companion.
//
// In a standalone module that uses the descriptor overlay (any
// `Object.defineProperty` — Octane deltablue installs `Object.prototype.
// inheritsFrom` that way), `__extern_set` routed EVERY indexed write on a vec,
// including an overwrite of a present element, through `__vec_dp_value`. That
// helper `__vec_overlay_ensure`s a companion `$Object`, and the companion table
// is append-only and scanned linearly by every dynamic read of every array. So
// deltablue's `OrderedCollection.remove` (`this.elms[index] = value`) added one
// table entry per call and the run slowed linearly with elapsed reps (40 → 187
// ms/rep over 800 reps, RSS +14 MB per 50 reps).
//
// The overwrite of a backed, present element with no companion is now a plain
// slot store. Every case below is checked against Node's answer for the same
// source; the census rows assert the shape (no companion is ever created).
import { afterEach, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<Record<string, number>> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    if (typeof value === "function" && name.startsWith("t_")) out[name] = (value as () => number)();
    if (name.startsWith("__exec_count_")) out[name] = (value as WebAssembly.Global).value as number;
  }
  return out;
}

// Descriptor-dirty prelude, the deltablue shape: an accessor-free data define on
// Object.prototype arms the inherited-set resolver and the vec overlay.
const DIRTY = `Object.defineProperty(Object.prototype, "inheritsFrom", { value: function () { return 1; } });\n`;
// Overlay without the inherited-set resolver: a define on a plain object only.
const CLEAN = `const __o: any = {}; Object.defineProperty(__o, "k", { value: 1 });\n`;

const CASES: Array<[string, string, number]> = [
  [
    "t_dense_overwrite",
    `export function t_dense_overwrite(): number {
       const a: any = [1, 2, 3];
       for (let i = 0; i < a.length; i++) a[i] = a[i] * 10;
       return a[0] + a[1] + a[2] + a.length;
     }`,
    63,
  ],
  [
    "t_remove_pattern",
    `function Coll(this: any) { this.elms = new Array(); }
     Coll.prototype.add = function (this: any, e: any) { this.elms.push(e); };
     Coll.prototype.remove = function (this: any, elm: any) {
       var index = 0, skipped = 0;
       for (var i = 0; i < this.elms.length; i++) {
         var value = this.elms[i];
         if (value != elm) { this.elms[index] = value; index++; } else { skipped++; }
       }
       for (var j = 0; j < skipped; j++) this.elms.pop();
     };
     export function t_remove_pattern(): number {
       const c: any = new (Coll as any)();
       c.add(1); c.add(2); c.add(3); c.add(2); c.add(5);
       c.remove(2);
       return c.elms.length * 1000 + c.elms[0] * 100 + c.elms[1] * 10 + c.elms[2];
     }`,
    3135,
  ],
  [
    "t_frozen_refuses",
    `export function t_frozen_refuses(): number {
       const a: any = [1, 2];
       Object.freeze(a);
       let r = 0;
       try { a[0] = 9; } catch (e) { r = 100; }
       return r + a[0];
     }`,
    101,
  ],
  [
    "t_nonwritable_element",
    `export function t_nonwritable_element(): number {
       const a: any = [1, 2];
       Object.defineProperty(a, "0", { value: 4, writable: false });
       let r = 0;
       try { a[0] = 9; } catch (e) { r = 100; }
       a[1] = 8;
       return r + a[0] * 10 + a[1];
     }`,
    148,
  ],
  [
    "t_accessor_element",
    `export function t_accessor_element(): number {
       const a: any = [1, 2];
       let seen = 0;
       Object.defineProperty(a, "1", { get: function () { return 7; }, set: function (v: any) { seen = v; }, configurable: true });
       a[1] = 5;
       return seen * 10 + a[1];
     }`,
    57,
  ],
  [
    "t_descriptor_after_write",
    `export function t_descriptor_after_write(): number {
       const a: any = [1, 2];
       a[1] = 6;
       const d: any = Object.getOwnPropertyDescriptor(a, "1");
       return d.value * 1000 + (d.writable ? 100 : 0) + (d.enumerable ? 10 : 0) + (d.configurable ? 1 : 0);
     }`,
    6111,
  ],
  [
    "t_string_key_write",
    `export function t_string_key_write(): number {
       const a: any = [1, 2, 3];
       const k: any = "2";
       a[k] = 30;
       a["01"] = 99;
       return a[2] + a.length * 100 + (a["01"] === 99 ? 1000 : 0);
     }`,
    1330,
  ],
];

describe("#6973 stage 2 — overwriting a present array element is a plain store", () => {
  for (const [label, prelude] of [
    ["descriptor-dirty", DIRTY],
    ["overlay-only", CLEAN],
  ] as const) {
    it(`node-identical answers (${label})`, async () => {
      const src = prelude + CASES.map(([, body]) => body).join("\n");
      const out = await run(src);
      for (const [name, , expected] of CASES) expect(out[name], name).toBe(expected);
    });
  }
});

describe("#6973 stage 2 — no companion is created for plain overwrites (exec census)", () => {
  const saved = process.env.JS2WASM_EXEC_CENSUS;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EXEC_CENSUS");
    else process.env.JS2WASM_EXEC_CENSUS = saved;
  });
  for (const [label, prelude] of [
    ["descriptor-dirty", DIRTY],
    ["overlay-only", CLEAN],
  ] as const) {
    it(`200 overwrites into 200 fresh arrays never ensure a companion (${label})`, async () => {
      process.env.JS2WASM_EXEC_CENSUS = "__vec_overlay_ensure";
      const out = await run(
        prelude +
          `export function t_many(): number {
             let sum = 0;
             for (let n = 0; n < 200; n++) {
               const a: any = new Array();
               a.push(n); a.push(1);
               a[0] = a[1];
               sum += a[0];
             }
             return sum;
           }`,
      );
      expect(out.t_many).toBe(200);
      const counts = Object.entries(out).filter(([k]) => k.startsWith("__exec_count___vec_overlay_ensure"));
      expect(counts.length).toBeGreaterThan(0);
      for (const [name, n] of counts) expect(n, name).toBe(0);
    });
  }
});
