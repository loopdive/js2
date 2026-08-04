// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4038 — a JSDoc function-type parameter has no name, and feeding that
// `undefined` to `ts.isObjectBindingPattern` crashed expression compilation.
// #4037 — the multi-source path never reserved `$ObjVecArr`, so any dynamic
// `new K(...args)` in a multi-source graph refused to emit.
// #4030 — an exception escaping a codegen catch now names the innermost `src/`
// frame, which is how #4038 was localised in one run instead of an instrumented
// re-run of a ~16-minute compile.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";
import { innermostCompilerFrame } from "../src/codegen/internal-error.js";

describe("#4038 — a nameless JSDoc function-type parameter must not crash codegen", () => {
  it("compiles a call to a function whose JSDoc declares a function-type param", async () => {
    // `@param {function(string): void}` models ITS OWN parameters as
    // `ParameterDeclaration` nodes with no `name`, even though the TypeScript
    // type declares `name` non-optional. That is the only shape that reaches
    // `ts.isObjectBindingPattern(undefined)`.
    const result = await compileMulti(
      {
        "./dep.js": `/**
 * @param {function(string): void} cb
 * @returns {number}
 */
export function run(cb) { cb("x"); return 1; }
`,
        "./main.js": `import { run } from "./dep.js";
export function go() { return run(function (s) { return s.length; }); }
`,
      },
      "./main.js",
      { target: "gc", allowJs: true },
    );

    const internal = result.errors.filter((e) => e.message.includes("Internal error compiling expression"));
    expect(internal.map((e) => e.message)).toEqual([]);
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  });
});

describe("#4037 — multi-source parity for the up-front $ObjVecArr reservation", () => {
  it("compiles and runs a dynamic `new K(...args)` across modules", async () => {
    const result = await compileMulti(
      {
        "./k.ts": `export class K {
  a: number;
  b: number;
  constructor(a: number, b: number) { this.a = a; this.b = b; }
  sum(): number { return this.a + this.b; }
}`,
        "./main.ts": `import { K } from "./k.js";
const args: number[] = [1, 2];
export function run(): number { const k = new K(...args); return k.sum(); }`,
      },
      "./main.ts",
      { target: "gc" },
    );

    expect(result.errors.filter((e) => e.message.includes("ObjVecArr")).map((e) => e.message)).toEqual([]);
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);

    const imports = { ...(result.importObject as Record<string, Record<string, unknown>>) };
    for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
      const mod = (imports[imp.module] ??= {});
      if (mod[imp.name] !== undefined) continue;
      if (imp.kind === "function") mod[imp.name] = () => undefined;
      else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
    }
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    expect((instance.exports as { run: () => number }).run()).toBe(3);
  });
});

describe("#4030 — internal codegen exceptions carry a location", () => {
  it("extracts the innermost compiler frame from a real stack", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at Object.isObjectBindingPattern (/x/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js:30857:15)",
      "    at compileIdentifierCall (/home/user/js2/src/codegen/expressions/call-identifier.ts:1071:17)",
    ].join("\n");
    // The node_modules frame is skipped: pointing at TypeScript's internals is
    // exactly the unhelpful answer this exists to avoid.
    expect(innermostCompilerFrame(error)).toBe("src/codegen/expressions/call-identifier.ts:1071:17");
  });

  it("returns undefined rather than inventing a location", () => {
    const noStack = new Error("boom");
    noStack.stack = undefined;
    expect(innermostCompilerFrame(noStack)).toBeUndefined();

    const foreign = new Error("boom");
    foreign.stack = "Error: boom\n    at foo (/x/node_modules/dep/index.js:1:1)";
    expect(innermostCompilerFrame(foreign)).toBeUndefined();

    expect(innermostCompilerFrame("not an error")).toBeUndefined();
  });

  it("reports the frame in a real compile diagnostic", async () => {
    // A compile that does NOT crash must carry no internal-error diagnostic at
    // all — this guards the reporting path from firing spuriously.
    const ok = await compile(`export function f(n: number): number { return n + 1; }`, { target: "gc" });
    expect(ok.errors.filter((e) => e.message.includes("Internal error"))).toEqual([]);
  });
});
