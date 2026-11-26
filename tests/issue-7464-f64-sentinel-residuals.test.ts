// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7464 — residual wrong answers of the f64 `undefined` sentinel (a `number | undefined` slot lowered to an f64
// that carries `UNDEF_F64_BITS`). Every row runs the same program in node and compares, on gc and standalone.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

function nodeMain(source: string): number {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports: { main?: () => number } = {};
  new Function("exports", outputText)(exports);
  return exports.main!();
}

const ROWS: readonly (readonly [string, string])[] = [
  [
    "a function-local class re-seeds its `undefined` static on every evaluation",
    `function f(set: boolean): number { class C { static a: number | undefined } const r = C.a ?? 7; if (set) C.a = 1; return r; }
     export function main(): number { return f(true) + f(false) * 10; }`,
  ],
  [
    "a `for (var …)` head with several bindings keeps the hoisted slot",
    `function f(): number { let n = 0; for (var g: number | undefined, i = 0; i < 2; i++) { n += g === undefined ? 1 : 0; } return n; }
     export function main(): number { return f(); }`,
  ],
  [
    "a single-binding `for (var …)` head keeps the hoisted slot",
    `function f(): number { let n = 0; for (var g: number | undefined; n < 2; ) { n += g === undefined ? 1 : 0; } return n; }
     export function main(): number { return f(); }`,
  ],
  [
    "String, `+` concatenation and unary `+` of an uninitialised module `let`",
    `let g: number | undefined;
     export function main(): number { return (String(g) === "undefined" ? 1 : 0) + ("" + g === "undefined" ? 10 : 0) + (g + "" === "undefined" ? 100 : 0) + (String(+(g as number)) === "NaN" ? 1000 : 0); }`,
  ],
  [
    "String, typeof and concatenation of a never-initialised field, then of a NaN stored in it",
    `class C { a: number | undefined; }
     export function main(): number { const c = new C(); const r = (String(c.a) === "undefined" ? 1 : 0) + (typeof c.a === "undefined" ? 10 : 0) + ("" + c.a === "undefined" ? 100 : 0); c.a = NaN; return r + (String(c.a) + typeof c.a === "NaNnumber" ? 1000 : 0); }`,
  ],
  [
    "String and typeof of a never-initialised static",
    `class C { static a: number | undefined; }
     export function main(): number { return (String(C.a) === "undefined" ? 1 : 0) + (typeof C.a === "undefined" ? 10 : 0); }`,
  ],
];

describe("#7464 f64 undefined-sentinel residuals", () => {
  for (const target of ["gc", "standalone"] as const) {
    for (const [name, source] of ROWS) {
      it(`${target}: ${name}`, async () => {
        expect(await runMain(source, target)).toBe(nodeMain(source));
      });
    }
  }
});
