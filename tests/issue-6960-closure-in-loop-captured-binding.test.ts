// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6960 — a closure constructed INSIDE a loop body that captures a binding the
 * loop mutates must share ONE binding with the loop (condition, body, closure).
 *
 * The closure-construction site boxes a captured binding where the closure
 * literal is compiled: after the loop condition was compiled against the raw
 * slot, and (re-run every iteration) re-wrapping the raw slot into a fresh cell
 * that drops the previous iteration's write. The #1589 pre-box covered `for`
 * locals only; parameters and while/do-while/for-in/for-of loops spun forever
 * (Octane earley-boyer `deriv_trees`, second blocker after #6959). Every loop
 * here carries a `++g > 50` guard so the base answers `-1` instead of hanging.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, sloppy: boolean): Promise<string> {
  // Read the string result back char by char (a standalone string is a WasmGC
  // value, opaque to JS).
  const program =
    source +
    `\nvar __s = "";\nexport function p() { __s = "" + main(); return __s.length; }\n` +
    `/** @param {number} i */ export function at(i) { return __s.charCodeAt(i); }\n`;
  const result = await compile(program, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    ...(sloppy ? { inferModuleStrictArguments: false, runtimeEvalProvider: false } : {}),
  });
  if (!result.success) return `COMPILE FAIL ${result.errors.map((e) => String(e.message)).join(" | ")}`;
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as unknown as Record<string, (index?: number) => number>;
  try {
    const length = exports.p!();
    let text = "";
    for (let at = 0; at < length; at++) text += String.fromCharCode(exports.at!(at));
    return text;
  } catch (error) {
    return `TRAP ${(error as Error)?.message ?? String(error)}`;
  }
}

const PAIR = `function Pair(car, cdr) { this.car = car; this.cdr = cdr; }
var L = new Pair(1, new Pair(2, new Pair(3, null)));\n`;

/** name → [functions, main expression, node's answer] */
const CASES: [name: string, decls: string, call: string, expected: string][] = [
  // ── the defect: loop-written binding captured by a closure built in the loop
  [
    "while-param",
    `function G(k) { var g = 0; var f = null; while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } return g * 10 + f(); }`,
    "G(3)",
    "30",
  ],
  [
    "while-local",
    `function Lw(n) { var k = n; var g = 0; var f = null; while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } return g * 10 + f(); }`,
    "Lw(3)",
    "30",
  ],
  [
    "for-param",
    `function Mp(k) { var g = 0; var f = null; for (; k > 0; k = k - 1) { if (++g > 50) return -1; f = function () { return k; }; } return g * 10 + f(); }`,
    "Mp(3)",
    "30",
  ],
  [
    "do-while-param",
    `function Np(k) { var g = 0; var f = null; do { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } while (k > 0); return g * 10 + f(); }`,
    "Np(3)",
    "30",
  ],
  [
    "for-of-param",
    `function P(k, xs) { var f = null; var g = 0; for (var x of xs) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } return k * 100 + g * 10 + f(); }`,
    "P(3, [1, 2, 3])",
    "30",
  ],
  [
    "for-in-param",
    `function Q(k, o) { var f = null; var g = 0; for (var p in o) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } return g * 10 + f(); }`,
    "Q(3, { a: 1, b: 2, c: 3 })",
    "30",
  ],
  [
    "for-of-break-on-captured",
    `function U(k) { var f = null; var g = 0; for (var x of [1, 2, 3, 4, 5]) { if (k <= 0) break; if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } return g * 10 + f(); }`,
    "U(3)",
    "30",
  ],
  // The earley-boyer shape: struct-list param walked by the loop, captured.
  [
    "while-true-list-param",
    `${PAIR}function B(l, acc) { var g = 0; while (true) { if (++g > 50) return -1;
       if (l instanceof Pair) { var inner = function () { return l.car; }; acc = acc + inner(); l = l.cdr; } else return acc; } }
     function A(l, acc) { var l; var acc; var g = 0; while (true) { if (++g > 50) return -1;
       if (l instanceof Pair) { var inner = function () { return l.car; }; acc = acc + inner(); l = l.cdr; } else return acc; } }`,
    `B(L, 0) + "," + A(L, 0)`,
    "6,6",
  ],
  [
    "string-param",
    `function S(s) { var f = null; var g = 0; while (s.length < 3) { if (++g > 50) return "x"; f = function () { return s; }; s = s + "a"; } return s + f(); }`,
    `S("")`,
    "aaaaaa",
  ],
  [
    "write-inside-closure",
    `function E(k) { var f = null; var g = 0; while (k > 0) { if (++g > 50) return -1; f = function () { k = k - 1; }; f(); } return k; }`,
    "E(3)",
    "0",
  ],
  [
    "write-after-loop-seen-by-closure",
    `function F(k) { var f = null; var g = 0; while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; } k = 7; return f(); }`,
    "F(3)",
    "7",
  ],
  [
    "loop-in-skipped-branch",
    `function A3(k, c) { var f = null; var g = 0; if (c) { while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k--; } } k = 5; return f === null ? k : f(); }`,
    `A3(3, 1) + "," + A3(3, 0)`,
    "5,5",
  ],
  // ── controls: already correct on the base, must stay correct
  [
    "no-loop-param",
    `function E0(x) { var f = function () { return x; }; x = x + 1; return x * 10 + f(); }`,
    "E0(1)",
    "22",
  ],
  [
    "closure-before-loop",
    `function H(k) { var g = 0; var f = function () { return k; }; while (k > 0) { if (++g > 50) return -1; k = k - 1; } return g * 10 + f(); }`,
    "H(3)",
    "30",
  ],
  [
    "for-head-var",
    `function K(n) { var fs = []; for (var i = 0; i < n; i++) { fs.push(function () { return i; }); } return fs.length * 10 + fs[0](); }`,
    "K(3)",
    "33",
  ],
  [
    "post-loop-read",
    `function B0(k) { var f = null; var g = 0; while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k--; } return k; }`,
    "B0(3)",
    "0",
  ],
  [
    "nested-block-let-shadow",
    `function Sh(k) { var f = null; var g = 0; while (k > 0) { if (++g > 50) return -1; if (k === 2) { let k = 100; f = function () { return k; }; } k = k - 1; } return k + f(); }`,
    "Sh(3)",
    "100",
  ],
  [
    "read-only-capture",
    `function J(k) { var c = 5; var r = 0; var g = 0; while (k > 0) { if (++g > 50) return -1; r += (function () { return c; })(); k--; } return r + c; }`,
    "J(3)",
    "20",
  ],
  [
    "labelled-continue",
    `function Lb(k) { var f = null; var g = 0; lbl: while (k > 0) { if (++g > 50) return -1; f = function () { return k; }; k = k - 1; continue lbl; } return g * 10 + f(); }`,
    "Lb(3)",
    "30",
  ],
];

describe("#6960 closure in a loop shares the loop-written captured binding (standalone)", () => {
  for (const sloppy of [false, true]) {
    for (const [name, decls, call, expected] of CASES) {
      it(`${name} (${sloppy ? "script/sloppy" : "module"})`, async () => {
        const source = `${decls}\nfunction main() { return String(${call}); }\n`;
        expect(await runStandalone(source, sloppy)).toBe(expected);
      });
    }
  }
});
