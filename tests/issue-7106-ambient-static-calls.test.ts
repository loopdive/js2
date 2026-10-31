// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 module-init lever — a measured static call on an ambient namespace
// intrinsic (`Number.isNaN(v)`, `Object.is(a, b)`, `Array.isArray(v)`) is the
// #7118 realm read plus the generic dynamic method call. Only the calls
// measured exact, in opaque positions, with operands that reach the carrier,
// are claimed; every other call, position and operand is refused at selection.

import { describe, expect, it } from "vitest";

import { intrinsicUseVerdicts, lane, runModuleInit, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

const run = (target: Target, source: string, experimentalIR = true) =>
  runModuleInit(target, source, { fileName: "issue-7106-static-calls.js", experimentalIR });

// The module `var` an operand may read.
const PRELUDE = "var n = 2;";

const NUMBER_OPERANDS = [
  ...["1", "1.5", "-0", "9007199254740992", "1e300", "NaN", "-Infinity", "Infinity", '"1"', '"x"', "true"],
  ...["undefined", "n", "n + 0.5", "-(3)", "0 / 0", "Number.MAX_SAFE_INTEGER", "Math.pow(2, 53)", "typeof 1"],
];

const CALLS: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    ["isSafeInteger", "isInteger", "isFinite", "isNaN"].map((method) => [
      `Number.${method}`,
      [
        ...NUMBER_OPERANDS.map((operand) => `Number.${method}(${operand})`),
        `Number.${method}()`,
        `Number.${method}(1, 2)`,
        `Number.${method}(NaN, "a", 3)`,
      ],
    ]),
  ),
  "Object.is": [
    ...["NaN, NaN", "0, -0", "-0, -0", '"a", "a"', "true, 1", '"", false', '"a" + "b", "ab"', "1 < 2, true"],
    ...["Object.is(1, 1), true", "", "1", "undefined, undefined", "1, 1, 2"],
  ].map((operands) => `Object.is(${operands})`),
  "Array.isArray": ["1", '"a"', "true", "undefined", "Number.isNaN(1)"].map((operand) => `Array.isArray(${operand})`),
};

/** Sources of at most `size` checks each, inside the module-init chunk budget; node supplies the answers. */
function checkSources(calls: readonly string[], size = 10): string[] {
  const sources: string[] = [];
  for (let i = 0; i < calls.length; i += size) {
    const checks = calls.slice(i, i + size).map((call) => {
      const expected = new Function(`${PRELUDE} return ${call};`)() as boolean;
      return `if (${call} !== ${expected}) { throw ${JSON.stringify(call)}; }`;
    });
    sources.push([PRELUDE, ...checks].join("\n"));
  }
  return sources;
}

const CLAIMING: Record<string, string> = Object.fromEntries(
  Object.entries(CALLS).flatMap(([method, calls]) =>
    checkSources(calls).map((source, index) => [`${method} #${index}`, source]),
  ),
);
// The result in each opaque position: a condition, `!`, `typeof`, a statement,
// a comma's left operand, and an argument to a member callee.
CLAIMING.positions = `var seen = 0;
if (!Number.isNaN(NaN)) { throw "#if"; }
while (Number.isNaN(1)) { throw "#while"; }
if ((Object.is(1, 1) ? 1 : 2) !== 1) { throw "#cond"; }
if (typeof Array.isArray(1) !== "boolean") { throw "#typeof"; }
Number.isFinite(1);
if ((Number.isInteger(1.5), 7) !== 7) { throw "#comma"; }
if (!Object.is(Number.isSafeInteger(1), true)) { throw "#arg"; }`;

// Refused at selection, and still answering as node does through legacy:
// calls the dynamic route answers wrongly (legacy's static arms own them),
// positions outside the opaque class, and operands that do not reach the carrier.
const REFUSED: Record<string, string> = {
  fromCodePoint: `if (String.fromCodePoint(65) !== "A") { throw "#1"; }`,
  isExtensibleNull: `if (Object.isExtensible(null) !== false) { throw "#2"; }`,
  hasOwn: `if (Object.hasOwn({ a: 1 }, "a") !== true) { throw "#3"; }`,
  arrayOf: `if (Array.of(1, 2).length !== 2) { throw "#4"; }`,
  arrayFrom: `if (Array.from("ab").length !== 2) { throw "#5"; }`,
  jsonParse: `if (JSON.parse("1") !== 1) { throw "#6"; }`,
  getPrototypeOfPrimitive: `if (Object.getPrototypeOf(1) !== Number.prototype) { throw "#7"; }`,
  varInitializer: `var r = Number.isNaN(1); if (r !== false) { throw "#8"; }`,
  returnValue: `function f() { return Number.isNaN(1); } if (f() !== false) { throw "#9"; }`,
  plusOperand: `if ("" + Number.isNaN(1) !== "false") { throw "#10"; }`,
  arrayElement: `var a = [Number.isNaN(1)]; if (a[0] !== false) { throw "#11"; }`,
  nullOperand: `if (Number.isNaN(null) !== false) { throw "#12"; }`,
  voidOperand: `if (Number.isNaN(void 0) !== false) { throw "#13"; }`,
  arrayLiteralOperand: `if (Array.isArray([1]) !== true) { throw "#14"; }`,
  objectBindingOperand: `var o = { a: 1 }; if (Number.isNaN(o) !== false) { throw "#15"; }`,
  fourArguments: `if (Number.isSafeInteger(1, 2, 3, 4) !== true) { throw "#16"; }`,
};

describe("#7106 — measured static calls on ambient namespace intrinsics", () => {
  for (const [name, source] of Object.entries(CLAIMING)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`${name} claims <module-init> with no errors and runs (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: true, threw: false });
      });
      it(`${name} answers as legacy (${lane(target)}, IR off)`, async () => {
        expect(await run(target, source, false)).toEqual({ claimed: false, threw: false });
      });
    }
  }

  for (const [name, source] of Object.entries(REFUSED)) {
    it(`node agrees: ${name}`, () => {
      expect(() => new Function(source)()).not.toThrow();
    });
    for (const target of TARGETS) {
      it(`${name} stays legacy and answers as node does (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual({ claimed: false, threw: false });
      });
    }
  }

  for (const target of TARGETS) {
    it(`a failing static-call check throws from the IR body (${lane(target)})`, async () => {
      expect(await run(target, `if (Number.isNaN(NaN) !== false) { throw "#neg"; }`)).toEqual({
        claimed: true,
        threw: true,
      });
    });
  }

  // The predicate itself: the receiver of a direct call to a listed method, in
  // an opaque position, admits; every other shape refuses.
  describe("isAmbientIntrinsicValueUse on static calls", () => {
    it("admits the receiver of a listed call in an opaque position", () => {
      expect(intrinsicUseVerdicts(`if (Number.isNaN(1)) {} (Number).isFinite(1);`, "Number")).toEqual([true, true]);
      expect(intrinsicUseVerdicts(`Object.is(1, Array.isArray(1));`, "Object")).toEqual([true]);
    });
    it.each([
      ["an alias receiver", `var N = Number; N.isNaN(1);`],
      ["a parenthesized callee", `(Number.isNaN)(1);`],
      ["an element-access callee", `Number["isNaN"](1);`],
      ["an optional call", `Number.isNaN?.(1);`],
      ["a spread argument", `Number.isNaN(...[1]);`],
      ["an unlisted method", `Number.parseFloat("1");`],
      ["a var initializer", `var r = Number.isNaN(1);`],
      ["a return value", `function f() { return Number.isNaN(1); }`],
    ])("refuses %s", (_label, source) => {
      expect(intrinsicUseVerdicts(source, "Number")).toEqual([false]);
    });
  });
});
