// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1 — the function kind of the Prepared dynamic value: `typeof`, the kind tests, `Object.prototype.toString`,
// and the run-time abort of a ToPrimitive that would call a function (slice F2 calls it). Each accepted program runs
// twice: with node's answer (returns) and with a wrong one (throws).
import { describe, expect, it } from "vitest";
import { abortsAtRunTime, refusal, runPrepared } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

/** `source` and `wrong` (the same program asserting a wrong answer): node returns on the first and throws on both. */
async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

describe("#7354 F1 — the function kind", () => {
  const KINDS =
    "function t(v) { return typeof v; }\n" +
    'function isObject(v) { return typeof v === "object"; }\n' +
    "function isPrimitive(v) { return typeof v !== 'object' && typeof v !== 'function'; }\n" +
    "var g = function () {};\n";
  it(
    "answers typeof and the harness's isPrimitive for a function value",
    () =>
      agrees(
        `${KINDS}if (typeof g !== "function" || t(g) !== "function" || isObject(g) || isPrimitive(g) || !isPrimitive(1)) throw 1;`,
        `${KINDS}if (t(g) !== "object") throw 1;`,
      ),
    SLOW,
  );

  const NUM = "function num(v) { return +v; }\nvar f = function () {};\n";
  it(
    "answers ToNumber of a function value with NaN, known statically and through a parameter",
    () =>
      agrees(
        `${NUM}if (+f === +f || f * 1 === f * 1 || f < 1 || num(f) === num(f) || num(2) !== 2) throw 1;`,
        `${NUM}if (num(f) !== num(f)) throw 1;`,
      ),
    SLOW,
  );

  const TAGS =
    "function tag(v) { return Object.prototype.toString.call(v); }\n" +
    "function nm(v) { return v === null ? 'null' : typeof v; }\n" +
    "var g = function () {}; var o = {};\n";
  it(
    "tags a function value [object Function] beside an object",
    () =>
      agrees(
        `${TAGS}if (tag(g) !== "[object Function]" || tag(o) !== "[object Object]" || nm(g) !== "function" || nm(o) !== "object" || nm(null) !== "null") throw 1;`,
        `${TAGS}if (tag(g) !== "[object Object]") throw 1;`,
      ),
    SLOW,
  );

  // D6: Function.prototype.toString (the source text) is not built. A function value's ToString without an own
  // conversion method ends at the run-time abort ((#7354 F2) an own method is called: it is a run-time fact of the
  // value, so even a value that may only be a function compiles). Where the value may also be a kind that answers (a
  // parameter, a caught value), that kind answers first: a kind that answers wrongly throws 1 before the abort, so
  // each row of the function kind's conversion tables changed alone fails here.
  it.each([
    [
      "`+` through a parameter that is also a number and a string",
      'function op(v) { return v + 1; } var f = function () {}; if (op(1) !== 2 || op("a") !== "a1") throw 1; op(f);',
    ],
    [
      "ToString through a parameter, beside ToNumber of a function (NaN)",
      'function str(v) { return "" + v; } function num(v) { return +v; } var f = function () {};\n' +
        'if (str(1) !== "1" || str(true) !== "true" || num(f) === num(f) || num(2) !== 2) throw 1; str(f);',
    ],
    [
      "ToString of a caught function value",
      'var f = function () {}; var c; try { throw f; } catch (e) { c = e; } if (c !== f) throw 1; var s = "" + c;',
    ],
    ...["f + 1", "String(f)"].map((use) => [
      `ToString of a value that is only a function (${use})`,
      `var f = function () { return 1; }; ${use};`,
    ]),
    // (#7354 F1b) `+` with a function operand takes its ToPrimitive: without an own method the source text's abort,
    // never a sum.
    ["`+` of a function value through a parameter", "function op(v) { return v + 1; } var x = op(function () {});"],
    // (#7354 C2, C2-D1) `__proto__`'s setter is the realm's lack, but `undefined` and `null` answer (the TypeError):
    // a refusal at compile time became the abort of the kinds that cannot answer.
    [
      "a member write of Object.prototype's accessor on a value that may be a function",
      "function w(v) { v.__proto__ = null; } w(function () {});",
    ],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source), SLOW);

  it.each([
    // (#7354 F1b) A function value is the realm's object now: only the keys its built-in prototypes hold refuse.
    // (#7489) The realm holds `call` and `apply`; `bind` still refuses.
    [
      "a member read of a Function.prototype key",
      "function g() {} var k = g.bind;",
      "member read 'bind' of a function needs Function.prototype's properties",
    ],
    // (#7354 H2) The write of the inherited accessor refuses at its own site.
    [
      "a member write of Object.prototype's accessor on a function",
      "function g() {} g.__proto__ = null;",
      "dynamic operation member write '__proto__' of a function needs Object.prototype's accessor",
    ],
  ])("refuses %s by name", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });
});
