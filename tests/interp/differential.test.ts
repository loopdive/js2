// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — differential test: run each constant-string eval body through
// BOTH the bytecode interpreter and the host's `eval` (in a fresh node:vm global
// so each body is isolated exactly like the interpreter's per-run global) and
// assert they agree. Acceptance #2: "a differential check vs `eval` on ≥50
// sampled constant-string test262 eval bodies."
//
// Two corpora:
//  1. CURATED (~60 bodies) — always runs; guarantees the ≥50 differential
//     regardless of whether the test262 submodule is checked out.
//  2. test262 SAMPLE — real bodies extracted with acorn from the checkout; runs
//     only when present (skipIf), asserting high agreement among *supported*
//     bodies (Phase-1-out-of-scope nodes are reported, not failed).

import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { differential, loadAcorn, parse, sampleTest262EvalBodies } from "./harness.js";
import { runScript, UnsupportedNodeError } from "../../src/interp/index.js";

beforeAll(async () => {
  await loadAcorn();
});

// ── curated constant-string corpus (≥50 bodies; drawn from common test262
//    eval-body shapes + the Phase-1 feature surface) ───────────────────────────
const CURATED: string[] = [
  // arithmetic & coercion
  "1 + 2 * 3",
  "10 - 4 - 3",
  "2 ** 0 + 7", // ** unsupported → both handled? (interp rejects → skipped below)
  "17 % 5",
  "1 + '2' + 3",
  "'' + 0.1 + 0.2",
  "-5 + +'10'",
  "1e3 * 2",
  "true + 1",
  "null + 1",
  // comparisons
  "3 > 2",
  "3 >= 3",
  "2 < 5",
  "2 <= 2",
  "1 == '1'",
  "1 === '1'",
  "1 != 2",
  "0 !== '0'",
  "'a' < 'b'",
  "NaN === NaN",
  // logical / conditional
  "true && 'x'",
  "false || 'y'",
  "null ?? 'z'",
  "0 ?? 'w'",
  "1 ? 2 : 3",
  "!0",
  "!!'nonempty'",
  // variables & completion
  "var x = 5; x * 2",
  "let a = 1, b = 2; a + b",
  "var s = 0; for (var i = 0; i < 5; i++) s += i; s",
  "1; 2; 3",
  "var x = 1; x = x + 41; x",
  "1; { 2; }",
  "1; { var y = 3; }",
  "1; if (false) 2;",
  "1; for (var i=0;i<3;i++){}",
  // control flow
  "var n = 5, f = 1; while (n > 1) { f *= n; n--; } f",
  "var x = 0; do { x++; } while (x < 3); x",
  "if (2 > 1) 'yes'; else 'no'",
  "var c = 0; for (var i=0;i<9;i++){ if(i===4) break; c++; } c",
  "var t = 0; for (var i=0;i<5;i++){ if(i%2===0) continue; t += i; } t",
  // property / objects / arrays
  "var o = { a: 1, b: 2, c: 3 }; o.a + o.b + o.c",
  "var o = {}; o.x = 9; o.x",
  "var a = [10, 20, 30]; a[1]",
  "[1,2,3].length",
  "[1,2,3,4].map(function(x){ return x + 1; })",
  "[5,3,8,1].filter(function(x){ return x > 3; })",
  "({ n: 7 }).n",
  "var o = { k: 'v' }; o['k']",
  // calls / closures / recursion
  "function add(a, b) { return a + b; } add(4, 5)",
  "function fib(n){ return n < 2 ? n : fib(n-1) + fib(n-2); } fib(12)",
  "(function(x){ return x * x; })(9)",
  "((a, b) => a - b)(10, 3)",
  "function twice(f, x){ return f(f(x)); } twice(function(n){ return n + 1; }, 5)",
  "var o = { n: 5 }; function g(){ return this.n; } g.call(o)",
  // operand evaluation order (side effects must match JS left→right)
  "var s=''; var a=function(){s+='a';return 2}; var b=function(){s+='b';return 1}; a()>b(); s",
  "var s=''; var a=function(){s+='a';return 1}; var b=function(){s+='b';return 2}; a()>=b(); s",
  // #3356 — ToPrimitive COERCION order for > / >= (§13.10.1 LeftFirst=false)
  "var s=''; var a={valueOf:function(){s+='a';return 1}}; var b={valueOf:function(){s+='b';return 2}}; a>b; s",
  "var s=''; var a={valueOf:function(){s+='a';return 1}}; var b={valueOf:function(){s+='b';return 2}}; a>=b; s",
  // exceptions
  "var r; try { throw 7; } catch (e) { r = e * 2; } r",
  "var o = 0; try { o = 1; } finally { o += 10; } o",
  "function boom(){ throw 'e'; } var r; try { boom(); } catch(e){ r = e; } r",
  "var log=''; try { log+='t'; throw 1; } catch(e){ log+='c'; } finally { log+='f'; } log",
  "var caught='no'; try { try { throw 'x'; } finally {} } catch(e){ caught=e; } caught",
  // strings / templates / builtins
  "'hello'.length",
  "'hello'.toUpperCase()",
  "var x = 3; `val=${x * 2}`",
  "Math.max(3, 7, 2)",
  "String(123)",
  "typeof undefinedThing",
  "typeof 42",
  // #4137 C1 — bitwise binary ops (ToInt32/ToUint32 comes from the native op)
  "5 | 3",
  "12 & 10",
  "5 ^ 3",
  "-1 >>> 0",
  "16 >>> 1", // operand order matters: syntactic left must land in the register
  "'3' | 0",
  "undefined | 0",
  "null ^ 5",
  "2.9 | 0",
  "1 | 2 & 3 ^ 4",
  // #4137 C1 — the compound forms the same opcode table drives
  "var x = 5; x |= 3; x",
  "var x = 12; x &= 10; x",
  "var x = 5; x ^= 3; x",
  "var x = -1; x >>>= 0; x",
  "var o = { v: 5 }; o.v |= 3; o.v",
  // #4137 C2 — regex literals (compare through primitives; a bare RegExp would
  // structurally compare equal to anything with no own enumerable keys)
  "/a+b/.test('aab')",
  "/x/g.flags",
  "/x/gi.source",
  "String(/ab+c/gi)",
  "/(\\d+)/.exec('a123b')[1]",
  "'a1b2'.replace(/\\d/g, '#')",
  "var r = /a/g; r.test('aa'); r.lastIndex",
  "var a = []; for (var i = 0; i < 2; i++) a.push(/x/); a[0] === a[1]", // fresh object per evaluation
  "typeof /x/",
];

describe("#3101 differential — curated constant-string corpus", () => {
  it("has at least 50 bodies (acceptance #2)", () => {
    expect(CURATED.length).toBeGreaterThanOrEqual(50);
  });

  for (const body of CURATED) {
    it(`interp ≡ eval: ${body.slice(0, 60)}`, () => {
      // Skip a body the emitter cannot lower yet (Phase-1 out of scope): it is
      // reported as coverage in the summary test, not a failure here.
      let unsupported = false;
      try {
        runScript(parse(body));
      } catch (e) {
        if (e instanceof UnsupportedNodeError) unsupported = true;
        // other throws are legitimate program exceptions — keep going
      }
      if (unsupported) return; // covered by the coverage-summary test below
      const d = differential(body);
      expect(d.verdict === "match" || d.verdict === "both-throw", `${d.verdict}: ${body}\n  ${d.detail}`).toBe(true);
    });
  }

  it("reports curated coverage (supported vs Phase-1-unsupported)", () => {
    let supported = 0;
    let unsupported = 0;
    const unsupportedKinds = new Map<string, number>();
    for (const body of CURATED) {
      try {
        runScript(parse(body));
        supported += 1;
      } catch (e) {
        if (e instanceof UnsupportedNodeError) {
          unsupported += 1;
          unsupportedKinds.set(e.nodeType, (unsupportedKinds.get(e.nodeType) ?? 0) + 1);
        } else {
          supported += 1; // a real program throw still exercises the pipeline
        }
      }
    }
    // The overwhelming majority of the curated corpus is within Phase-1 scope.
    expect(supported).toBeGreaterThanOrEqual(CURATED.length - 3);
    // Emit a human-readable breakdown for the reviewer.
    // eslint-disable-next-line no-console
    console.log(
      `[#3101 curated] supported=${supported} unsupported=${unsupported} kinds=${JSON.stringify(
        Object.fromEntries(unsupportedKinds),
      )}`,
    );
  });
});

// ── real test262 sample (bonus coverage; runs only when the submodule exists) ──
const T262_ROOTS = [
  "test262/test/language/eval-code",
  "test262/test/built-ins/eval",
  "test262/test/language/expressions/addition",
];
const HAS_T262 = existsSync("test262/test/language/eval-code");

describe.skipIf(!HAS_T262)("#3101 differential — sampled real test262 eval bodies", () => {
  let bodies: string[] = [];
  beforeAll(() => {
    bodies = sampleTest262EvalBodies(T262_ROOTS, 120);
  });

  it("samples ≥50 real constant-string eval bodies", () => {
    expect(bodies.length).toBeGreaterThanOrEqual(50);
  });

  it("agrees with eval on ≥85% of SUPPORTED sampled bodies", () => {
    let supported = 0;
    let agree = 0;
    const divergences: string[] = [];
    for (const body of bodies) {
      let unsupported = false;
      try {
        runScript(parse(body));
      } catch (e) {
        if (e instanceof UnsupportedNodeError) unsupported = true;
      }
      if (unsupported) continue;
      supported += 1;
      const d = differential(body);
      if (d.verdict === "match" || d.verdict === "both-throw") agree += 1;
      else if (divergences.length < 20) divergences.push(`${d.verdict}: ${body} — ${d.detail}`);
    }
    const ratio = supported > 0 ? agree / supported : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[#3101 test262] sampled=${bodies.length} supported=${supported} agree=${agree} ratio=${(ratio * 100).toFixed(
        1,
      )}%\n  ` + divergences.join("\n  "),
    );
    expect(supported).toBeGreaterThanOrEqual(40);
    // Known Phase-1 divergences (TDZ / strict-mode assignment / harness-scope
    // bodies) keep this below 100%; 85% is a comfortable, non-flaky floor.
    expect(ratio).toBeGreaterThanOrEqual(0.85);
  });
});
