// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1b — properties on function values: a declaration's or a function expression's own `length`, `name` and
// `prototype` from its creation, member writes and reads through the realm's kernel, the read-only `length` / `name`,
// and the harness's module-init statements against stand-in declarations. Each accepted program runs twice: with
// node's answer (returns) and with a wrong one (throws); a refusal is asserted by its exact text.
import { describe, expect, it } from "vitest";
import { refusal, runPrepared, throwsAsNode } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

/** `source` and `wrong` (the same program asserting a wrong answer): node returns on the first and throws on both. */
async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

describe("#7354 F1b — function objects", () => {
  const OWN =
    "function a(p, q) {} var e = function () {}; var o = { m: function (x) {} };\n" +
    "function mk() { return function () {}; } var f0 = mk(); var f1 = mk();\n" +
    "a.x = 1; a.x = 2; e.k = 3; f0.k = 4; a.length = 9; a.name = 'z';\n";
  it(
    "reads own length, name and prototype and absent keys, keeps writes per function, ignores a sloppy read-only write",
    () =>
      agrees(
        `${OWN}if (a.length !== 2 || a.name !== "a" || a.x !== 2 || e.name !== "e" || e.k !== 3 || o.m.name !== "m" || f0.k !== 4 || f1.k !== undefined || a.k !== undefined || typeof a.prototype !== "object" || a.prototype === e.prototype) throw 1;`,
        `${OWN}if (a.length !== 9) throw 1;`,
      ),
    SLOW,
  );

  const PROTOTYPE =
    "function T() {} T.prototype.k = 2; T.prototype.toString = function () { return 'T'; };\n" +
    "T.m = function (v) { return v; }; var g = T.m;\n";
  it(
    "writes a constructor's prototype, Object.prototype's data keys included, and stores a function value as a member",
    () =>
      agrees(
        `${PROTOTYPE}if (T.prototype.k !== 2 || typeof T.m !== "function" || g !== T.m || T.m.name !== "") throw 1;`,
        `${PROTOTYPE}if (T.m.name !== "m") throw 1;`,
      ),
    SLOW,
  );

  const NUMBER =
    "function f() {} f.valueOf = 1; function h() {}\n" +
    "function g() {} g.toString = 1; var c = 0; try { var n = +g; } catch (e) { c = 1; }\n";
  it(
    "answers ToNumber of a function NaN beside an own non-callable valueOf, and a TypeError for a non-callable toString",
    () =>
      agrees(
        `${NUMBER}if (+h === +h || +f === +f || h * 1 === h * 1 || c !== 1) throw 1;`,
        `${NUMBER}if (c !== 0) throw 1;`,
      ),
    SLOW,
  );

  // Without a declaration read as a value, the function expression alone admits the object kind its prototype is.
  const EXPRESSION = "var e = function () {}; var p = e.prototype;\n";
  it(
    "gives a function expression a prototype object",
    () =>
      agrees(`${EXPRESSION}if (typeof p !== "object") throw 1;`, `${EXPRESSION}if (typeof p !== "function") throw 1;`),
    SLOW,
  );

  it(
    "throws a TypeError for a strict write of a function's read-only length",
    () => throwsAsNode('"use strict"; function a() {} a.length = 5;'),
    SLOW,
  );

  it.each([
    // (#7557) `call`, `apply` and `bind` are the realm's (tests/issue-7557-builtins-through-values.test.ts).
    [
      "a Function.prototype key",
      "function a() {} var c = a.toString;",
      "member read 'toString' of a function needs Function.prototype's properties",
    ],
    [
      "an Object.prototype key the realm does not hold",
      "function a() {} var c = a.valueOf;",
      "member read 'valueOf' of a function needs Function.prototype's properties",
    ],
  ])("refuses a read of %s off a function by name", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  // (#7354 P1) An Object.prototype method the realm holds is found on a function's chain.
  const METHOD = "function a() {} var h = a.hasOwnProperty;\n";
  it(
    "reads Object.prototype's hasOwnProperty off a function",
    () =>
      agrees(
        `${METHOD}if (typeof h !== "function" || !a.hasOwnProperty("length")) throw 1;`,
        `${METHOD}if (typeof h !== "function" || a.hasOwnProperty("length")) throw 1;`,
      ),
    SLOW,
  );
});

describe("#7354 F1b — the harness's module-init statements against stand-in declarations", () => {
  const PRELUDE =
    "function assert(mustBeTrue, message) { if (mustBeTrue === true) return; throw message; }\n" +
    "function compareArray(a, b) { return a === b; }\n" +
    "function Test262Error(message) {}\n" +
    "function formatIdentityFreeValue(v) { return v; }\n" +
    "function formatSimpleValue(v) { return v; }\n" +
    "assert._isSameValue = function (a, b) { if (a === b) { return a !== 0 || 1 / a === 1 / b; } return a !== a && b !== b; };\n" +
    "assert._formatIdentityFreeValue = formatIdentityFreeValue;\n" +
    "assert._toString = formatSimpleValue;\n" +
    "assert.sameValue = function () { return 1; }; assert.notSameValue = function () { return 1; };\n" +
    "assert.throws = function () { return 1; }; assert.compareArray = function () { return 1; };\n" +
    "compareArray.format = function () { return 1; };\n" +
    "Test262Error.prototype.toString = function () { return 1; }; Test262Error.thrower = function () { return 1; };\n";
  it(
    "runs the ten statements, the two aliases verbatim and the eight function expressions with stand-in bodies",
    () =>
      agrees(
        `${PRELUDE}if (typeof assert._isSameValue !== "function" || assert._toString !== formatSimpleValue || typeof assert.sameValue !== "function" || typeof compareArray.format !== "function" || typeof Test262Error.thrower !== "function" || assert._formatIdentityFreeValue !== formatIdentityFreeValue) throw 1;`,
        `${PRELUDE}if (assert._toString === formatSimpleValue) throw 1;`,
      ),
    SLOW,
  );
});
