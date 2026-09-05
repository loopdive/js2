// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616: in untyped JS, `const callList = []` + `callList.push(args)` makes
// the checker EVOLVE the binding's type (here to `any[][]`), and the let/const
// hoist pre-pass resolved that evolved type into a vec-of-vec slot while
// `compileVariableStatement` later retyped the slot to the usage-inferred vec
// (`inferArrayVecType`). A nested FunctionDeclaration hoisted in between had
// already baked the STALE slot type into its lifted signature and closure
// struct, so materializing it cast the retyped slot across incompatible vec
// types — an impossible cast (`ref.cast nullref` in the disassembly) that
// trapped `illegal cast` in every jest `vi.fn` spy (the shim is untyped JS;
// jest 322 → 328/358 on this fix, the whole prompt bucket). The hoist now
// applies the SAME `inferArrayVecType` inference as the statement (and the
// var hoister), so both ends agree and the retype is a no-op.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

async function runJs(source: string, fileName: string) {
  const result = await compile(source, {
    fileName,
    skipSemanticDiagnostics: true,
    allowJs: true,
    experimentalIR: true,
    deferTopLevelInit: true,
    platform: "node",
    target: "gc",
  } as Parameters<typeof compile>[1]);
  expect(result.success).toBe(true);
  const imports = buildCompiledImports(result as never, {}) as WebAssembly.Imports & {
    setInstance?: (i: WebAssembly.Instance) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 evolving empty-array const: hoist and statement agree on the slot vec type", () => {
  it("untyped vi.fn shim shape executes without the impossible-cast trap", async () => {
    const exp = await runJs(
      `
      const vi = {
        fn(implementation) {
          const callList = [];
          function spy(...args) {
            callList.push(args);
            if (typeof implementation === "function") return implementation.apply(this, args);
          }
          spy.mock = { calls: callList };
          spy.mockImplementation = function (next) { implementation = next; return spy; };
          spy.mockRestore = function () {};
          return spy;
        },
        spyOn(object, key) {
          const original = object[key];
          const spy = vi.fn(function () { return original.apply(this, arguments); });
          spy.mockRestore = function () { object[key] = original; };
          object[key] = spy;
          return spy;
        },
      };
      export function t1() {
        const f = vi.fn(function (x) { return x + 1; });
        return String(f(1));
      }
      export function t4() {
        const s = vi.spyOn(Array, "isArray").mockImplementation(function () { return true; });
        const r = Array.isArray("not-an-array");
        s.mockRestore();
        return String(r);
      }`,
      "issue-4616-evolving-vifn.js",
    );
    expect(exp.t1!()).toBe("2");
    expect(exp.t4!()).toBe("true");
  });

  it("plain function twin: nested rest fn-decl + fn-expr capture the same evolving array", async () => {
    const exp = await runJs(
      `
      function viFn(implementation) {
        const callList = [];
        function spy(...args) {
          callList.push(args);
          if (typeof implementation === "function") return implementation.apply(this, args);
        }
        spy.count = function () { return callList.length; };
        return spy;
      }
      export function t() {
        const f = viFn(function (x) { return x * 2; });
        return String(f(3)) + "|" + String(f.count());
      }`,
      "issue-4616-evolving-plain.js",
    );
    expect(exp.t!()).toBe("6|1");
  });
});
