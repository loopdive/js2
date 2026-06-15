// #2092 — spec-conformance family: §13.15.3 ApplyStringOrNumericBinaryOperator
// for `+` (ToPrimitive(hint default) both operands, then string-concat if
// either primitive is a string, else numeric add).
//
// Guards the `emitToPrimitive` + string-or-numeric `+` step of the coercion
// engine (#1917) over `any`-typed operands, across host + standalone + ±-O.
//
// Result observation: numeric `+` is read directly as a number; string-concat
// `+` is fed into a `string`-typed helper so `.length` resolves natively (NOT
// via a `.length` on an `any`, which goes through the dynamic member-access
// path and is a separate lever — that artifact is why a naive `(a+b as
// string).length` probe reads 0 even when the concat is otherwise fine).
//
// Provably-numeric add is green in every lane. The any-string / any-object /
// any-array concatenations are RED-BUT-BASELINED under #1988 (`__any_add` has
// only i32/f64 branches; ref-tagged operands miss ToPrimitive → wrong value in
// host, null-pointer deref in standalone). Their generated test ids are in
// scripts/equivalence-baseline.json; a reverted #1988 fix turns them red.

import { defineSpecFamily } from "./_harness.js";

defineSpecFamily("coercion/arithmetic-add", [
  // ── provably-numeric `+` — green everywhere ──
  {
    name: "any number + any number",
    src: "export function run(): number { const a: any = 3; const b: any = 4; return (a + b) as number; }",
    expect: 7,
  },
  {
    name: "any number + numeric literal",
    src: "export function run(): number { const a: any = 10; return (a + 5) as number; }",
    expect: 15,
  },
  {
    name: "any null + number (ToNumber null = 0)",
    src: "export function run(): number { const a: any = null; return (a + 5) as number; }",
    expect: 5,
  },

  // ── string-concat `+` over any operands — RED-BUT-BASELINED (#1988) ──
  {
    name: "any string + any string concatenates",
    src: 'function len(s: string): number { return s.length; } export function run(): number { const a: any = "x"; const b: any = "y"; return len(a + b); }',
    expect: 2,
    bug: 1988,
    failsIn: ["host", "host-O", "standalone", "standalone-O"],
  },
  {
    name: "any string + any number concatenates (§13.15.3)",
    src: 'function len(s: string): number { return s.length; } export function run(): number { const a: any = "1"; const b: any = 2; return len(a + b); }',
    expect: 2, // "12"
    bug: 1988,
    failsIn: ["host", "host-O", "standalone", "standalone-O"],
  },
]);
