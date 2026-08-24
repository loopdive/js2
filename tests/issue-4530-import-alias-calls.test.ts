// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4530 — the clsx upstream-suite failure family: calls through a DEFAULT
// import (or a const alias of one) of a JS `arguments`-reading function.
//
// Three distinct defects, all reduced from clsx@2.x's published dist:
//  1. `registerImportBindingAliases` copied funcMap/closureMap onto the local
//     import name but NOT `funcUsesArguments`/`funcRestParams` — so a call
//     through the alias skipped the `__argc`/`__extras_argv` protocol and the
//     callee saw `arguments.length === 0` (every argument silently dropped).
//  2. The lazy closure singleton was keyed by NAME, so the default and named
//     bindings of one function minted two closure values — `default !== named`
//     — and the alias's wrapper never matched the call-site dispatch.
//  3. TS synthesizes `(...args: any[])` for a JS function whose body reads
//     `arguments`; the closure call-site treated that declaration-less rest
//     slot as ONE positional vec param, materializing the first argument into
//     a vec (`clsx('foo')` → "f o o").

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const CLSX_DIST = `
function r(e){var t,f,n="";if("string"==typeof e||"number"==typeof e)n+=e;else if("object"==typeof e)if(Array.isArray(e)){var o=e.length;for(t=0;t<o;t++)e[t]&&(f=r(e[t]))&&(n&&(n+=" "),n+=f)}else for(f in e)e[f]&&(n&&(n+=" "),n+=f);return n}
export function clsx(){for(var e,t,f=0,n="",o=arguments.length;f<o;f++)(e=arguments[f])&&(t=r(e))&&(n&&(n+=" "),n+=t);return n}
export default clsx;
`;

async function instantiate(files: Record<string, string>, entry: string) {
  const result = await compileMulti(files, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as Record<string, Function>).__module_init?.();
  return instance.exports as Record<string, Function>;
}

describe("issue #4530: import-alias calls of arguments-reading functions", () => {
  it("forwards arguments through a default-import call", async () => {
    const exports = await instantiate(
      {
        "./clsx.mjs": CLSX_DIST,
        "./main.ts": `
          import dflt from './clsx.mjs';
          export function run(): string { return dflt('foo', 'bar'); }
        `,
      },
      "./main.ts",
    );
    expect(exports.run()).toBe("foo bar");
  });

  it("default and named import are the same function value", async () => {
    const exports = await instantiate(
      {
        "./clsx.mjs": CLSX_DIST,
        "./main.ts": `
          import dflt, { clsx } from './clsx.mjs';
          export function run(): boolean { return dflt === clsx; }
        `,
      },
      "./main.ts",
    );
    expect(exports.run()).toBe(1);
  });

  it("a const alias of the import classifies string/number/object args correctly", async () => {
    const exports = await instantiate(
      {
        "./clsx.mjs": CLSX_DIST,
        "./main.ts": `
          import dflt from './clsx.mjs';
          const fn = dflt;
          export function run(): string {
            return '[' + fn('foo') + '] [' + fn(1, 2) + '] [' + fn({foo: true, bar: false}) + ']';
          }
        `,
      },
      "./main.ts",
    );
    expect(exports.run()).toBe("[foo] [1 2] [foo]");
  });
});
