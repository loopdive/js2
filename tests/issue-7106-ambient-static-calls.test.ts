// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the ambient boolean statics `Number.isNaN` / `isFinite` /
// `isInteger` / `isSafeInteger`, `Object.is` and `Array.isArray` lower in IR
// bodies by operand family (`src/ir/static-predicates/`), as the #1371 Math
// whitelist does: no realm read, no runtime call, an IR boolean answer the
// checker's `boolean` agrees with. Any operand, arity or consumer the lowering
// cannot take is refused at selection, so nothing withdraws after the claim.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { lane, runModuleInit, TARGETS, type Target } from "./helpers/ambient-intrinsic-probe.js";

const run = (target: Target, source: string, experimentalIR = true) =>
  runModuleInit(target, source, { fileName: "issue-7106-static-calls.js", experimentalIR });

// What node answers for a typed function's exported `f`.
const nodeFunction = (source: string) =>
  new Function(
    `${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace(/export /g, "")}; return f;`,
  )() as (...args: number[]) => number;

// The module `var` an operand may read.
const PRELUDE = "var n = 2;";

const OPERANDS = [
  ...["1", "1.5", "-0", "9007199254740992", "1e300", "NaN", "-Infinity", "Infinity", "n", "n + 0.5", "-(3)"],
  ...["0 / 0", "1 << 31", "n >>> 0", "Number.MAX_SAFE_INTEGER", "Math.pow(2, 53)", "Math.round(-0.4)"],
  ...['"1"', '"x"', "typeof 1", "String(1)", "true", "1 < 2", "Number.isNaN(1)", "undefined", "void 0", "null"],
];

const CALLS: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    ["isSafeInteger", "isInteger", "isFinite", "isNaN"].map((method) => [
      `Number.${method}`,
      [...OPERANDS.map((operand) => `Number.${method}(${operand})`), `Number.${method}()`],
    ]),
  ),
  "Object.is": [
    ...OPERANDS.map((operand) => `Object.is(${operand}, ${operand})`),
    ...["NaN, 0 / 0", "0, -0", "1, true", '"", false', "undefined, null", "null, void 0", '"a" + "b", "ab"'],
    ...["Object.is(1, 1), true", "", "undefined", "1"],
  ].map((operands) => (operands.startsWith("Object.is(") ? operands : `Object.is(${operands})`)),
  // `Array.isArray()` stays out: legacy cannot compile it (`__get_builtin`), with or without the IR.
  "Array.isArray": OPERANDS.map((operand) => `Array.isArray(${operand})`),
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
// Every consumer of the boolean answer that lowers it.
CLAIMING.consumers = `var b = true; var c = false;
if (!Number.isNaN(NaN)) { throw "#if"; }
while (Number.isNaN(1)) { throw "#while"; }
if (typeof Array.isArray(1) !== "boolean") { throw "#typeof"; }
Number.isFinite(1);
if ((Number.isInteger(1.5), 7) !== 7) { throw "#comma"; }
if (b !== Number.isNaN(NaN) || Object.is(1, 2) === b) { throw "#module-boolean"; }
if (Number.isNaN(1) == null) { throw "#null"; }
if (c ? Number.isNaN(1) : !Number.isFinite(NaN)) {} else { throw "#branch"; }
if (Number.isNaN(NaN) && !Array.isArray(1)) {} else { throw "#and"; }
if (\`\${Number.isNaN(1)}\` !== "false") { throw "#template"; }`;
CLAIMING.valueSinks = `function h(v) { return v === false; }
function g() { return Object.is(-0, -0); }
function k() { const r = Number.isSafeInteger(9007199254740992); return r === false; }
if (!h(Number.isNaN(1)) || !g() || !k()) { throw "#sink"; }`;

// Refused at selection — legacy answers as node does. (`Object.getPrototypeOf(1)`
// is the #7189 suite's `primitiveCall`.)
const REFUSED: Record<string, string> = {
  fromCodePoint: `if (String.fromCodePoint(65) !== "A") { throw "#1"; }`,
  isExtensible: `if (Object.isExtensible(null) !== false) { throw "#2"; }`,
  hasOwn: `if (Object.hasOwn({ a: 1 }, "a") !== true) { throw "#3"; }`,
  arrayOf: `if (Array.of(1, 2).length !== 2) { throw "#4"; }`,
  arrayFrom: `if (Array.from("ab").length !== 2) { throw "#5"; }`,
  jsonParse: `if (JSON.parse("1") !== 1) { throw "#6"; }`,
  arrayOperand: `if (Array.isArray([1]) !== true) { throw "#7"; }`,
  objectOperand: `var o = { a: 1 }; if (Number.isNaN(o) !== false) { throw "#8"; }`,
  hoistedOperand: `if (Number.isFinite(x) !== false) { throw "#9"; } var x = 1;`,
  concatOperand: `if (Object.is("a" + 1, "a1") !== true) { throw "#10"; }`,
  fourArguments: `if (Number.isSafeInteger(1, 2, 3, 4) !== true) { throw "#11"; }`,
  spread: `var a = [NaN]; if (Number.isNaN(...a) !== true) { throw "#12"; }`,
  nullishLeft: `if (Number.isNaN(1) ?? true) { throw "#13"; }`,
  plusOperand: `if (Number.isNaN(1) + 1 !== 1) { throw "#14"; }`,
  numberRelational: `if (Number.isNaN(1) < 1) {} else { throw "#15"; }`,
  stringEquality: `if ("false" == Number.isNaN(1)) { throw "#16"; }`,
  stringMethodArgument: `if ("abc".indexOf(Number.isNaN(1)) !== -1) { throw "#17"; }`,
  throwOperand: `var c = false; if (c) { throw Number.isNaN(1); }`,
  // (round 2) The family the IR lowers, not the checker's: a module boolean is
  // an i32 read without the brand, a rewritten or logically joined local is not
  // its initializer's family, and an out-of-bounds element reads as NaN.
  moduleBooleanOperand: `var t = true; if (Object.is(t, true) !== true || Number.isNaN(t)) { throw "#19"; }`,
  moduleBooleanFromPredicate: `var t = Number.isNaN(NaN); if (Object.is(t, true) !== true) { throw "#20"; }`,
  moduleBooleanArray: `var t = true; if (Array.isArray(t) !== false) { throw "#21"; }`,
  logicalLocal: `{ let x = undefined || 1; if (Object.is(x, 1) !== true) { throw "#22"; } }`,
  rewrittenLocal: `{ let x = 1; x = undefined; if (Object.is(x, undefined) !== true) { throw "#23"; } }`,
  outOfBoundsUndefined: `{ let a = [1, 2]; if (Object.is(a[5], undefined) !== true) { throw "#24"; } }`,
  outOfBoundsAbsent: `{ let a = [1, 2]; if (Object.is(a[5]) !== true) { throw "#25"; } }`,
  outOfBoundsLocal: `{ let a = [1, 2]; let v = a[5]; if (Number.isFinite(v) !== false) { throw "#25a"; } }`,
  holeRead: `{ let a = [1, , 2]; if (Object.is(a[1], undefined) !== true) { throw "#25b"; } }`,
  // Consumers the lowering cannot take.
  numberSlotWrite: `{ let r = 0; r = Number.isNaN(NaN); if (r !== true) { throw "#26"; } }`,
  voidOperand: `if (void Number.isNaN(NaN) !== undefined) { throw "#27"; }`,
  elementRead: `if (Number.isNaN(1)[0] !== undefined) { throw "#28"; }`,
  memberRead: `if (Number.isNaN(NaN).toString() !== "true") { throw "#29"; }`,
  orModuleBooleanTemplate: `var t = true; if (\`\${Number.isNaN(1) || t}\` !== "true") { throw "#30"; }`,
  branchModuleBooleanTemplate: `var t = true; var c = true; if (\`\${c ? Number.isNaN(NaN) : t}\` !== "true") { throw "#31"; }`,
  orModuleBooleanString: `var t = true; if (String(Number.isNaN(1) || t) !== "true") { throw "#32"; }`,
  destructuringDeclaration: `function f() { const { toString } = Object.is(1, 1); return typeof toString; }
if (f() !== "function") { throw "#33"; }`,
  // A module boolean's slot reads back without the brand, so `String(t)` would withdraw.
  moduleBooleanDeclaration: `var t = Number.isNaN(NaN); if (String(t) !== "true") { throw "#40"; }`,
};

// (round 3) Consumers whose slot the answer is written into and from-ast would
// withdraw on: the unit stays legacy, with no post-claim error, and answers as
// legacy does (legacy's own answer is wrong for most of them, on main too).
const LEGACY_PARITY: Record<string, string> = {
  rewrittenNumber: `function f() { let r = Number.isNaN(NaN); r = 5; return r; } if (f() !== 5) { throw "#34"; }`,
  rewrittenString: `function f() { let r = Number.isNaN(NaN); r = "s"; return r; } if (f() !== "s") { throw "#35"; }`,
  rewrittenUndefined: `function f() { let r = Number.isNaN(NaN); r = undefined; return r; } if (f() !== undefined) { throw "#36"; }`,
  jsDocNumberResult: `/** @returns {number} */ function f() { return Number.isNaN(1); } if (f() !== false) { throw "#37"; }`,
  jsDocNumberParameter: `/** @param {number} v */ function g(v) { return v; } if (g(Number.isNaN(1)) !== false) { throw "#38"; }`,
  jsDocStringParameter: `/** @param {string} v */ function g(v) { return v; } if (g(Number.isNaN(1)) !== false) { throw "#39"; }`,
};

describe("#7106 — the ambient boolean statics in IR bodies", () => {
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

  for (const [name, source] of Object.entries(LEGACY_PARITY)) {
    for (const target of TARGETS) {
      it(`${name} stays legacy with no errors and answers as legacy (${lane(target)})`, async () => {
        expect(await run(target, source)).toEqual(await run(target, source, false));
      });
    }
  }

  for (const target of TARGETS) {
    it(`a failing check throws from the IR body (${lane(target)})`, async () => {
      expect(await run(target, `if (Number.isNaN(NaN) !== false) { throw "#neg"; }`)).toEqual({
        claimed: true,
        threw: true,
      });
    });
  }

  // A TypeScript function with typed operands: claimed, answering as node, and
  // lowered without a realm read, a dynamic call or a host import (the
  // reviewer's hot loop ran 230× slower through the dynamic route).
  const FUNCTIONS: Record<string, [string, readonly (readonly number[])[]]> = {
    isNaN: [`export function f(x: number): number { return Number.isNaN(x) ? 1 : 0; }`, [[NaN], [1], [-0]]],
    isFinite: [`export function f(x: number): number { return Number.isFinite(x) ? 1 : 0; }`, [[Infinity], [3]]],
    isSafeInteger: [
      `export function f(x: number): number { return Number.isSafeInteger(x) ? 1 : 0; }`,
      [[2 ** 53], [2 ** 53 - 1], [-0], [1.5]],
    ],
    // Against a constant, `Object.is` needs only the bits (`NaN`: `x ≠ x`); an arithmetic result is never `undefined`.
    objectIsConstants: [
      `export function f(a: number): number {
  return (Object.is(a, NaN) ? 1 : 0) + (Object.is(a, -0) ? 2 : 0) + (Object.is(0, a) ? 4 : 0) + (Object.is(a * 2, undefined) ? 8 : 0);
}`,
      [[NaN], [-0], [0], [1]],
    ],
    objectIs: [
      `export function f(a: number, b: number): number { return Object.is(a, b) ? 1 : 0; }`,
      [
        [0, -0],
        [NaN, NaN],
        [1, 1],
        [-0, -0],
      ],
    ],
    isArray: [`export function f(x: number): number { return Array.isArray(x) ? 1 : 0; }`, [[1]]],
    localDeclaration: [
      `export function f(x: number): number { const nan = Number.isNaN(x); return nan ? 1 : 0; }`,
      [[NaN], [1]],
    ],
    hotLoop: [
      `export function f(n: number): number { let s = 0; for (let i = 0; i < n; i++) { if (Number.isInteger(i / 2)) s++; } return s; }`,
      [[10], [1001]],
    ],
  };
  // Typed functions the selector refuses: legacy keeps them and answers as node.
  const REFUSED_FUNCTIONS: Record<string, [string, readonly (readonly number[])[]]> = {
    outOfBoundsUndefined: [
      `export function f(x: number): number { const a: number[] = [x]; return Object.is(a[3], undefined) ? 1 : 0; }`,
      [[1]],
    ],
    outOfBoundsAbsent: [
      `export function f(x: number): number { const a: number[] = [x]; return Object.is(void 0, a[x]) ? 1 : 0; }`,
      [[1], [5]],
    ],
    nativeI32Field: [
      `type i32 = number; class C { v: i32 = 3; } export function f(x: number): number { return Number.isInteger(new C().v) ? x : -x; }`,
      [[1]],
    ],
    moduleBoolean: [
      `const flag: boolean = true; export function f(x: number): number { return Object.is(flag, true) ? x : -x; }`,
      [[1]],
    ],
    asAny: [`export function f(x: number): number { return (Number.isNaN(x) as any) + 1; }`, [[NaN], [1]]],
    asUnknown: [
      `export function f(x: number): number { const u = Number.isNaN(x) as unknown; return u ? 1 : 0; }`,
      [[NaN], [1]],
    ],
    satisfies: [
      `export function f(x: number): number { return (Number.isNaN(x) satisfies boolean) ? 1 : 0; }`,
      [[NaN], [1]],
    ],
    nonNull: [`export function f(x: number): number { return Number.isNaN(x)! ? 1 : 0; }`, [[NaN], [1]]],
    numberSlot: [
      `export function f(x: number): number { let r: any = 0; r = Number.isNaN(x); return r ? 1 : 0; }`,
      [[NaN], [1]],
    ],
    // `String(<module boolean>)`: from-ast renders no unbranded i32.
    stringOfModuleBoolean: [
      `let t = true; export function f(x: number): number { return Object.is(String(t), "true") ? x : -x; }`,
      [[1]],
    ],
  };
  for (const [name, [source, inputs]] of Object.entries(REFUSED_FUNCTIONS)) {
    const node = nodeFunction(source);
    for (const target of TARGETS) {
      it(`${name}: a typed function stays legacy with no errors and answers as node (${lane(target)})`, async () => {
        const result = await compile(source, {
          fileName: "issue-7106-static-calls.ts",
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect((result.irOutcomes ?? []).find((o) => o.displayName === "f")?.irBodyEmitted).toBe(false);
        const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
        const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
        const f = instance.exports.f as (...args: number[]) => number;
        for (const input of inputs) expect(f(...input)).toBe(node(...input));
      });
    }
  }

  // An f64 that holds legacy's `undefined` marker (here a legacy-compiled
  // callee's `undefined as any`) is `undefined` to `Object.is(v, undefined)`.
  // Against a number it counts as NaN, as on main (the plan's follow-ups).
  for (const target of TARGETS) {
    it(`legacy's f64 undefined marker is undefined to Object.is (${lane(target)})`, async () => {
      const source = `function g(): number { return undefined as any; }
export function f(): number {
  return (Object.is(g(), undefined) ? 1 : 0) + (Object.is(g(), 1) ? 2 : 0) + (Object.is(g(), g()) ? 4 : 0);
}`;
      const result = await compile(source, {
        fileName: "issue-7106-static-calls.ts",
        trackIrOutcomes: true,
        ...(target ? { target } : {}),
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "f")).toEqual([]);
      expect((result.irOutcomes ?? []).find((o) => o.displayName === "f")?.irBodyEmitted).toBe(true);
      const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      expect((instance.exports.f as () => number)()).toBe(5);
    });
  }

  for (const [name, [source, inputs]] of Object.entries(FUNCTIONS)) {
    const node = nodeFunction(source);
    for (const target of TARGETS) {
      it(`${name}: a typed function claims, answers as node, and stays native (${lane(target)})`, async () => {
        const result = await compile(source, {
          fileName: "issue-7106-static-calls.ts",
          trackIrOutcomes: true,
          emitWat: true,
          ...(target ? { target } : {}),
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect((result.irOutcomes ?? []).find((o) => o.displayName === "f")?.irBodyEmitted).toBe(true);
        const module = new WebAssembly.Module(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        expect(result.wat).not.toMatch(/__dyn_member_get|__ir_dyn_method_call|__extern_method_call/);
        const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
        const instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
        const f = instance.exports.f as (...args: number[]) => number;
        for (const input of inputs) expect(f(...input)).toBe(node(...input));
      });
    }
  }
});
