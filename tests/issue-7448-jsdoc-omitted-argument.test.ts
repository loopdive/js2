// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7448 option C — a JSDoc `@param {number} x` is a hint, not an arity: the
// checker accepts `h()` in a JavaScript file, and `x` is then `undefined`, so
// `x + 1` is NaN. The legacy callee lowered `x` to an f64 slot and the caller
// padded the missing argument with 0, answering 1. A direct call in the
// declaring file that omits the argument now makes the parameter omittable,
// like `@param {number=} x` (`parameterMayBeOmitted`), and the IR selector asks
// legacy for that slot instead of claiming an f64 one.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "default" | "standalone";

async function compileJs(source: string, target: Target) {
  const result = await compile(source, {
    fileName: "issue-7448.js",
    allowJs: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function runWasm(source: string, target: Target): Promise<Record<string, unknown>> {
  const result = await compileJs(source, target);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    (target === "standalone" ? {} : imports) as WebAssembly.Imports,
  );
  imports.setInstance?.(instance);
  const answers: Record<string, unknown> = {};
  for (const name of exportNames(source)) answers[name] = (instance.exports[name] as () => unknown)();
  return answers;
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

const CASES: Record<string, string> = {
  "omitted directly": `${H}export function g() { return h(); }`,
  "omitted through a caller": `${H}function c() { return h(); }\nexport function g() { return c(); }`,
  "omitted at one site, passed at another": `${H}export function g() { return h(); }\nexport function k() { return h(2); }`,
  "second of two parameters omitted": `/**
 * @param {number} a
 * @param {number} b
 */
function add(a, b) { return a + b; }
export function g() { return add(1); }
export function k() { return add(1, 2); }`,
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
  for (const target of ["default", "standalone"] as const) {
    for (const [name, source] of Object.entries(CASES)) {
      it(`${target}: ${name}`, async () => {
        expect(await runWasm(source, target)).toEqual(runNode(source));
      });
    }

    it(`${target}: the IR refuses the widened callee at select instead of claiming and withdrawing it`, async () => {
      const result = await compileJs(CASES["omitted with a JSDoc result type"]!, target);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    });

    it(`${target}: a function every caller passes the argument to keeps its numeric claim`, async () => {
      const source = `${H}export function g() { return h(2); }`;
      expect(await runWasm(source, target)).toEqual({ g: 3 });
      expect((await compileJs(source, target)).irCompiledFuncs).toContain("h");
    });
  }
});
