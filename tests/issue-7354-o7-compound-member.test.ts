// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice O, step O7 — a compound write of a dynamic value's named member (`o.x op= v`, `o.x++`) on the Prepared
// lane (`lowerDynamicMemberCompound` in src/ir/from-ast.ts): one `[[Get]]`, the RHS, the dynamic binary producer (or
// `++` / `--`'s ToNumeric step), one `[[Set]]` with the plain write's strict/sloppy failure rule. Every program asserts
// node's answer (must return) and a wrong one (must throw). A computed key, `**=` and a script-var array refuse by
// name (the array at its literal); the ordinary pipeline keeps its refusal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile as compileOrdinary } from "../src/index.js";
import { agreesWithNode, refusal, runPrepared, runnerOptions } from "./helpers/prepared-node-agreement.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const OPERANDS = "{ a: 7, b: 7, c: 7, d: 7, e: 7, f: 7, g: -7, h: -7, i: 7, j: 7, k: 7 }";
const READ_ALL = `var out = o.a + "," + o.b + "," + o.c + "," + o.d + "," + o.e + "," + o.f + "," + o.g + "," + o.h + "," +
  o.i + "," + o.j + "," + o.k;`;

/** `[label, body]`: a script that assigns `out`. */
const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "each of the 11 operators on a script-var object",
    `var o = ${OPERANDS};
o.a *= 3; o.b /= 2; o.c %= 4; o.d += 2; o.e -= 9; o.f <<= 2; o.g >>= 1; o.h >>>= 1; o.i &= 3; o.j ^= 5; o.k |= 8;
${READ_ALL}`,
  ],
  [
    "each of the 11 operators through a parameter, with a dynamic RHS",
    `function f(p, v) {
  p.a *= v; p.b /= v; p.c %= v; p.d += v; p.e -= v; p.f <<= v; p.g >>= v; p.h >>>= v; p.i &= v; p.j ^= v; p.k |= v;
  return 0;
}
var o = ${OPERANDS};
f(o, 2);
${READ_ALL}`,
  ],
  // §13.4.2.1: an update expression is ToNumeric(old) ± 1, never ApplyStringOrNumericBinaryOperator.
  [
    "++ / -- convert a string, where += 1 concatenates",
    `var o = { x: "1", y: "1", z: "1", w: 5 };
o.x++; o.y--; o.z += 1; ++o.w; --o.w; --o.w;
var out = typeof o.x + o.x + "," + o.y + "," + typeof o.z + o.z + "," + o.w;`,
  ],
  ["+= with a string operand", `var o = { s: 1, n: "a" }; o.s += "x"; o.n += 2; var out = o.s + "|" + o.n;`],
  [
    "a getter/setter pair: one get and one set per write",
    // The counters are members: a closure's write of a script var is not this slice's.
    `var c = { gets: 0, sets: 0, store: 5 };
var o = { get x() { c.gets++; return c.store; }, set x(v) { c.sets++; c.store = v; } };
o.x *= 2; o.x += 1;
var out = c.gets + "," + c.sets + "," + c.store;`,
  ],
  // N2: GetValue(lref), the RHS, then ToPrimitive / ToNumeric of the old value and of the RHS.
  [
    "order: get, the RHS, the old value's valueOf, the RHS's valueOf, set (a numeric operator and +=)",
    `var log = { s: "" };
var old = { valueOf: function () { log.s += "old;"; return 2; } };
var r = { valueOf: function () { log.s += "rhs;"; return 3; } };
var o = { get x() { log.s += "get;"; return old; }, set x(v) { log.s += "set" + v + ";"; } };
function rhs() { log.s += "eval;"; return r; }
o.x *= rhs();
o.x += rhs();
var out = log.s;`,
  ],
  [
    "strict non-writable: TypeError, the value unchanged",
    `"use strict";
var o = {}; Object.defineProperty(o, "x", { value: 1 });
function f() { try { o.x *= 2; } catch (e) { return e.name; } return "none"; }
var out = f() + o.x;`,
  ],
  [
    "strict getter-only: TypeError",
    `"use strict";
var o = {}; Object.defineProperty(o, "x", { get: function () { return 1; } });
function f() { try { o.x += 2; } catch (e) { return e.name; } return "none"; }
var out = f() + o.x;`,
  ],
  [
    "sloppy non-writable: the write is ignored",
    `var o = {}; Object.defineProperty(o, "x", { value: 1 }); o.x += 1; o.x++; var out = "" + o.x;`,
  ],
  // N4: the [[Get]] of a nullish receiver throws (O4), before the RHS.
  [
    "a nullish receiver throws the TypeError",
    `function f(v) { try { v.x += 1; } catch (e) { return e.name; } return "none"; }
var out = f(null);
if (f(undefined) !== out) out = "differs";`,
  ],
];

describe("#7354 O7 — a compound write of a dynamic value's member", () => {
  // The runner's options: a test262 script writes values its lib types do not admit (`o.s += "x"` on a number).
  it.each(PROGRAMS)("%s", async (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);

  // (#7579) A computed key's compound and B4's script-var array (`a.length += 1`) run now
  // (tests/issue-7579-array-literals.test.ts).
  it.each([["**=", "var o = { x: 2 }; o.x **= 2;", "dynamic compound **= of"]])(
    "refuses %s by name",
    async (_label, source, reason) => {
      expect(await refusal(source)).toContain(reason);
    },
  );

  // B3: no new JS-host work; the ordinary pipeline demotes the function with today's text, on both targets.
  it.each([undefined, "standalone" as const])(
    "the ordinary pipeline (target %s) keeps its refusal",
    async (target) => {
      const result = await compileOrdinary("export function f(o: any): number { o.x++; return 0; }", {
        ...(target ? { target } : {}),
        trackFallbacks: true,
      });
      expect(result.success).toBe(true);
      expect(result.irPostClaimErrors?.map((error) => error.message)).toEqual([
        "ir/from-ast: compound property write on dynamic not in IR scope (f)",
      ]);
    },
    SLOW,
  );
});

const ROOT = join(__dirname, "..");
const TEST262 = existsSync(join(ROOT, "test262", "harness", "assert.js"));
/** The runner's assembly of a test262 source: the harness, and the strict prologue of an `onlyStrict` row. */
const assembled = (source: string): string => assembleOriginalHarness(source, parseMeta(source)).primary.source;

describe.skipIf(!TEST262)("#7354 O7 — cluster rows through the real harness (strict)", () => {
  it.each([
    ["non-writable /=", "11.13.2-24-s.js"],
    ["getter-only -=", "11.13.2-38-s.js"],
  ])(
    "%s (%s)",
    async (_label, file) => {
      const test = readFileSync(join(ROOT, "test262/test/language/expressions/compound-assignment", file), "utf8");
      expect(await runPrepared(assembled(test), runnerOptions())).toBe("returned");
      // The wrong twin expects another error: assert.throws' constructor check throws a Test262Error. (A failed
      // `assert.sameValue` ends at `formatIdentityFreeValue`'s run-time abort instead, #7354 T follow-up.)
      const wrong = test.replace("assert.throws(TypeError,", "assert.throws(RangeError,");
      expect(wrong).not.toBe(test);
      expect(await runPrepared(assembled(wrong), runnerOptions())).toBe("threw");
    },
    SLOW,
  );
});
