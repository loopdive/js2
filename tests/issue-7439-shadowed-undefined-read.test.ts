// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7439 — a read of a binding named `undefined` reads the binding, not the global value. Legacy emitted the global for
// every identifier spelled `undefined`, and the IR claimed some shadowed reads as the global.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target, experimentalIR?: false): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target, experimentalIR });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

const main = (body: string): string => `export function main(): number { ${body} }`;

// [the shadowing form, the program; each returns 43 as node does]. Each read is `(undefined as any)`: a bare
// `undefined` operand of `+` / `===` or a bare initializer goes through legacy's spelling-only tests, #7514.
const CASES: readonly (readonly [string, string])[] = [
  ["module const", `const undefined = 42; ${main("return (undefined as any) + 1;")}`],
  ["module let", `let undefined: any = 42; ${main("return (undefined as any) + 1;")}`],
  ["module var (number)", `var undefined: any = 42; ${main("return (undefined as any) + 1;")}`],
  ["module var (string)", `var undefined: any = "x"; ${main("return (undefined as any).length + 42;")}`],
  ["module function", `function undefined() {} ${main('return typeof undefined === "function" ? 43 : 0;')}`],
  ["module destructuring", `const { undefined } = { undefined: 42 }; ${main("return (undefined as any) + 1;")}`],
  ["parameter", `function g(undefined: any): number { return (undefined as any) + 1; } ${main("return g(42);")}`],
  ["local let", main("let undefined: any = 42; return (undefined as any) + 1;")],
  ["local var", main("var undefined: any = 42; return (undefined as any) + 1;")],
  ["local destructuring", main("const [undefined] = [42]; return (undefined as any) + 1;")],
  ["catch parameter", main("try { throw 42; } catch (undefined) { return (undefined as any) + 1; }")],
  ["closure capture", `const undefined = 42; const read = (): any => undefined; ${main("return read() + 1;")}`],
  ["unshadowed (control)", main("return undefined === void 0 ? 43 : 0;")],
];

describe.each(["gc", "standalone"] as const)("#7439 — a shadowed `undefined` reads its binding (%s)", (target) => {
  for (const experimentalIR of [undefined, false] as const) {
    const pipeline = experimentalIR === false ? "legacy" : "default";
    for (const [name, source] of CASES) {
      it(`${pipeline}: ${name}`, async () => {
        expect(await runMain(source, target, experimentalIR)).toBe(43);
      });
    }
  }
});
