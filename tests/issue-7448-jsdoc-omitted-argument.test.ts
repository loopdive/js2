// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7448 option C — a JSDoc `@param {number} x` is a hint, not an arity: the
// checker accepts `h()` in a JavaScript file, and `x` is then `undefined`, so
// `x + 1` is NaN. The legacy callee lowered `x` to an f64 slot and the caller
// padded the missing argument with 0, answering 1. A direct call in the
// declaring file that omits the argument now makes the parameter omittable,
// like `@param {number=} x` (`parameterMayBeOmitted`): legacy widens the slot
// and stops re-narrowing its reads (`checkerTypeIgnoresOmission`), and the IR
// selector asks legacy for that slot instead of claiming an f64 one. Every
// shape is also compiled with the IR off, so the legacy half is pinned on its
// own, and no shape may claim a function and then withdraw it.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "default" | "standalone" | "legacy";

async function compileJs(source: string, lane: Lane) {
  const result = await compile(source, {
    fileName: "issue-7448.js",
    allowJs: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
    ...(lane === "legacy" ? { experimentalIR: false } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function runWasm(source: string, lane: Lane) {
  const result = await compileJs(source, lane);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    (lane === "standalone" ? {} : imports) as WebAssembly.Imports,
  );
  imports.setInstance?.(instance);
  const answers: Record<string, unknown> = {};
  for (const name of exportNames(source)) answers[name] = (instance.exports[name] as () => unknown)();
  return { answers, postClaimErrors: result.irPostClaimErrors ?? [] };
}

function exportNames(source: string): string[] {
  return [...source.matchAll(/export function (\w+)\(\)/g)].map((match) => match[1]!);
}

function runNode(source: string): Record<string, unknown> {
  const exports: Record<string, () => unknown> = {};
  new Function("exports", ts.transpile(source, { module: ts.ModuleKind.CommonJS }))(exports);
  const answers: Record<string, unknown> = {};
  // A Wasm boolean result is an i32.
  for (const name of exportNames(source)) {
    const value = exports[name]!();
    answers[name] = typeof value === "boolean" ? Number(value) : value;
  }
  return answers;
}

const H = "/** @param {number} x */\nfunction h(x) { return x + 1; }\n";
const XY = "/**\n * @param {number} x\n * @param {number} y\n */\n";

const CASES: Record<string, string> = {
  "omitted directly": `${H}export function g() { return h(); }`,
  "omitted through a caller": `${H}function c() { return h(); }\nexport function g() { return c(); }`,
  "omitted at one site, passed at another": `${H}export function g() { return h(); }\nexport function k() { return h(2); }`,
  "second of two parameters omitted": `${XY}function add(x, y) { return x + y; }
export function g() { return add(1); }
export function k() { return add(1, 2); }`,
  "second of two parameters omitted, compared to undefined": `${XY}function h(x, y) { return y === undefined ? 1 : 0; }
export function a() { return h(1); }`,
  "both of two parameters omitted": `/**
 * @param {number} a
 * @param {string} b
 */
function h(a, b) { return a === undefined && b === undefined ? 1 : 0; }
export function x() { return h(); }`,
  "arguments.length with an omitted argument": `${XY}function h(x, y) { return arguments.length * 10 + (y === undefined ? 1 : 0); }
export function a() { return h(1); }
export function b() { return h(1, 2); }`,
  "a loop bound by an omitted second argument": `/**
 * @param {number} a
 * @param {number} x
 */
function h(a, x) { var s = 0; for (var i = 0; i < x; i++) s += i; return s; }
export function g() { return h(1); }
export function k() { return h(2, 5); }`,
  "typeof guard on an omitted argument": `/** @param {number} x */
function h(x) { if (typeof x !== "number") return -1; return x * 2; }
export function a() { return h(); }
export function b() { return h(4); }`,
  "recursion that omits the argument": `/** @param {number} n */
function f(n) { if (n === undefined) return 100; if (n <= 0) return 1 + f(); return 1 + f(n - 1); }
export function a() { return f(3); }`,
  "nested declaration omitted": `export function a() {
  /** @param {number} x */
  function h(x) { return x === undefined ? -1 : x + 1; }
  return h();
}`,
  "omitted with a JSDoc result type": `/**
 * @param {number} x
 * @returns {number}
 */
function h(x) { return x + 1; }
export function a() { return h(); }
export function b() { return h(2); }`,
  "string parameter omitted": `/** @param {string} s */
function h(s) { return s + "!"; }
export function g() { return h() === "undefined!"; }`,
  "boolean parameter omitted": `/** @param {boolean} b */
function h(b) { return b === undefined; }
export function g() { return h(); }`,
  "omitted, and also used as a value": `${H}var f = h;\nvar o = { m: h };\nexport function g() { return h(); }\nexport function k() { return f(2) + o.m(3); }`,
  "exported and omitted": `/** @param {number} x */\nexport function h2(x) { return x + 1; }\nexport function g() { return h2(); }`,
};

describe("#7448 — a JS caller omits a JSDoc-typed parameter", () => {
  for (const lane of ["default", "standalone", "legacy"] as const) {
    for (const [name, source] of Object.entries(CASES)) {
      it(`${lane}: ${name}`, async () => {
        const { answers, postClaimErrors } = await runWasm(source, lane);
        expect(answers).toEqual(runNode(source));
        expect(postClaimErrors).toEqual([]);
      });
    }
  }

  for (const lane of ["default", "standalone"] as const) {
    it(`${lane}: a function every caller passes the argument to keeps its numeric claim`, async () => {
      const source = `${H}export function g() { return h(2); }`;
      expect((await runWasm(source, lane)).answers).toEqual({ g: 3 });
      expect((await compileJs(source, lane)).irCompiledFuncs).toContain("h");
    });

    // `new h()` binds `undefined` too, but a constructed function's body is
    // compiled by the fnctor path, which does not read the direct slot.
    it(`${lane}: \`new h()\` does not widen the slot direct callers use`, async () => {
      const source = `${H}export function g() { var o = new h(); return h(2); }`;
      const result = await compile(source, {
        fileName: "issue-7448.js",
        allowJs: true,
        emitWat: true,
        ...(lane === "standalone" ? { target: "standalone" as const } : {}),
      });
      expect(result.success).toBe(true);
      expect(result.wat).toContain("(func $h (param f64) (result f64)");
    });
  }
});
