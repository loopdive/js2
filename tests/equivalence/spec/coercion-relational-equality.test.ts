// #2092 — spec-conformance family: relational (§7.2.13 IsLessThan) and
// equality (§7.2.15 IsLooselyEqual, §7.2.16 IsStrictlyEqual) coercion.
//
// Guards the `emitStrictEq` / `emitLooseEq` / relational steps of the coercion
// engine (#1917) over `any`-typed operands, across host + standalone + ±-O.
// These all PASS today — the #2058 (any `+`) and #2059 (any relational)
// per-site dispatch fixes landed — so this family is the regression *lock* that
// keeps the standalone in-module §7.2.13/§7.2.15 path honest as the engine is
// refactored. Booleans encode as `? 1 : 0`.

import { defineSpecFamily } from "./_harness.js";

defineSpecFamily("coercion/relational-equality", [
  // ── relational: two any strings compare lexicographically (§7.2.13) ──
  {
    name: "any < any string lexicographic",
    src: 'export function run(): number { const a: any = "a"; const b: any = "b"; return (a < b) ? 1 : 0; }',
    expect: 1,
  },
  {
    name: 'any "10" < any "9" is lexicographic (NOT numeric 10<9)',
    src: 'export function run(): number { const a: any = "10"; const b: any = "9"; return (a < b) ? 1 : 0; }',
    expect: 1,
  },
  {
    name: "any string vs any number relational is numeric",
    src: 'export function run(): number { const a: any = "10"; const b: any = 9; return (a < b) ? 1 : 0; }',
    expect: 0, // 10 < 9 → false
  },
  {
    name: "any >= any string",
    src: 'export function run(): number { const a: any = "abc"; const b: any = "abd"; return (a >= b) ? 1 : 0; }',
    expect: 0,
  },
  {
    name: "any <= any equal strings",
    src: 'export function run(): number { const a: any = "x"; const b: any = "x"; return (a <= b) ? 1 : 0; }',
    expect: 1,
  },

  // ── loose equality: §7.2.15 ToNumber dispatch ──
  {
    name: 'any "1" == any 1 (string⇄number ToNumber)',
    src: 'export function run(): number { const a: any = "1"; const b: any = 1; return (a == b) ? 1 : 0; }',
    expect: 1,
  },
  {
    name: "any null == any undefined",
    src: "export function run(): number { const a: any = null; const b: any = undefined; return (a == b) ? 1 : 0; }",
    expect: 1,
  },
  {
    name: "any 0 == any false (boolean⇄number)",
    src: "export function run(): number { const a: any = 0; const b: any = false; return (a == b) ? 1 : 0; }",
    expect: 1,
  },

  // ── strict equality: §7.2.16 type-aware ──
  {
    name: 'any "1" === any 1 is false (different types)',
    src: 'export function run(): number { const a: any = "1"; const b: any = 1; return (a === b) ? 1 : 0; }',
    expect: 0,
  },
  {
    name: "any 5 === any 5 (same number)",
    src: "export function run(): number { const a: any = 5; const b: any = 5; return (a === b) ? 1 : 0; }",
    expect: 1,
  },
]);
