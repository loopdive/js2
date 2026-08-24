// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618 regression (merge_group park on PR #4728): the fix-49 checker-identity
// guard on classObjectGlobals identifier reads opted out EVERY
// VariableDeclaration binding — but `var C = class { … }` (the dominant
// test262 language/expressions/class/elements shape, 205 park regressions) IS
// the class the arm serves. Reads of `C` then fell to the normal identifier
// lanes and answered undefined ("Cannot convert undefined or null to object"
// in every verifyProperty/module-init). The var opt-out is now narrowed to
// bindings whose initializer is provably a NON-class function value (the
// react StrictMode `const Foo = () => …` twin the guard exists for).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string, fileName: string) {
  const result = await compile(source, { testRuntime: true, fileName, skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4618 var-bound class expression keeps the class-object identity", () => {
  it("test262 class-elements shape: generator method + private field on `var C = class`", async () => {
    const exp = await run(
      `
      var C = class {
        *m() { return 42; }
        #x = "meep";
        x(): any { return (this as any).#x; }
      };
      export function t(): any {
        const c: any = new (C as any)();
        const g = c.m();
        return String(g.next().value) + "|" + String(c.x());
      }`,
      "issue-4618-var-class-expr.ts",
    );
    expect(exp.t!()).toBe("42|meep");
  });

  it("function-valued const still opts out (the fix-49 react cross-kind case)", async () => {
    const exp = await run(
      `
      class Foo { tag(): any { return "class"; } }
      export function t(): any {
        const Foo = function (): any { return "function"; };
        const f: any = Foo;
        return String(f());
      }`,
      "issue-4618-fn-valued-const.ts",
    );
    expect(exp.t!()).toBe("function");
  });
});
