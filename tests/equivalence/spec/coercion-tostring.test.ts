// #2092 — spec-conformance family: ToString / ToPrimitive(hint string).
//
// Guards the `emitToString` step of the coercion engine (#1917): §7.1.17
// ToString and the template-literal / `String(x)` paths over `any`-typed
// operands, across host + standalone + ±-O lanes.
//
// Each row is a self-contained zero-arg `run(): number`. ToString results are
// observed via `.length` (an exact i32) so the table compares a number, not an
// opaque string ref. The SAME snippet is evaluated as JS for the expected value.
//
// Open standalone gaps are landed RED-BUT-BASELINED (see the `bug` rows): in
// standalone mode `String(any)`/`` `${any}` `` over a boxed number/boolean
// currently does not produce the spec ToString (it yields a default
// object-ish string), tracked by #2072 (value-rep P0: type-aware AnyValue
// boxing) and #2005 (template-literal boolean/undefined/numeric). Their
// generated test ids are registered in scripts/equivalence-baseline.json; a
// reverted fix turns exactly the standalone lane red.

import { defineSpecFamily } from "./_harness.js";

defineSpecFamily("coercion/tostring", [
  // ── Provably-string fast path (no `any`) — green in every lane. ──
  {
    name: "string-literal template is identity",
    src: 'export function run(): number { const x = "hi"; return `${x}!`.length; }',
    expect: 3,
  },
  {
    name: "String(number-literal) flattens",
    src: "export function run(): number { return String(123).length; }",
    expect: 3,
  },

  // ── any-typed ToString — host green, standalone RED-BUT-BASELINED (#2072). ──
  {
    name: "template over any-number",
    src: "export function run(): number { const x: any = 42; return `${x}`.length; }",
    expect: 2,
    bug: 2072,
    failsIn: ["standalone", "standalone-O"],
  },
  {
    name: "String(any-number)",
    src: "export function run(): number { const x: any = 7; return String(x).length; }",
    expect: 1,
    bug: 2072,
    failsIn: ["standalone", "standalone-O"],
  },
  {
    name: "template over any-negative-number",
    src: "export function run(): number { const x: any = -3; return `v${x}`.length; }",
    expect: 3,
    bug: 2072,
    failsIn: ["standalone", "standalone-O"],
  },
  {
    name: "template over any-boolean",
    src: "export function run(): number { const x: any = true; return `${x}`.length; }",
    expect: 4, // "true"
    bug: 2005,
    failsIn: ["standalone", "standalone-O"],
  },
]);
