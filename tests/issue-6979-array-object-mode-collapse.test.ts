// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6979 S7-c — array/object semantics no longer key off `ctx.standalone`.
 *
 * The structural probe covers carrier storage that the old mode bit hid from
 * WASI. The runtime probe covers a complete semantic path shared by both
 * host-free WasmGC environments.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type NativeTarget = "standalone" | "wasi";

async function compileNative(source: string, target: NativeTarget, emitWat = false) {
  const result = await compile(source, {
    target,
    fileName: `issue-6979-${target}.ts`,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    emitWat,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return { result, module };
}

describe("#6979 S7-c array/object mode collapse — WASI structure", () => {
  it("object-literal expandos use a carrier-owned bag slot", async () => {
    const { result } = await compileNative(
      `
        var object = { declared: 1 };
        object.expando = 2;
      `,
      "wasi",
      true,
    );
    expect(result.wat.includes("$$bag"), "WAT contains the object carrier bag slot").toBe(true);
  });
});

for (const target of ["standalone", "wasi"] as const) {
  describe(`#6979 S7-c array/object mode collapse — ${target} runtime`, () => {
    it("Reflect.defineProperty translates native descriptor rejection to false", async () => {
      const { module } = await compileNative(
        `
          var frozen = Object.freeze({});
          export function readResult() {
            return Reflect.defineProperty(frozen, "x", { value: 1 }) === false ? 1 : 0;
          }
        `,
        target,
      );
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
      exports.__module_init?.();
      expect(exports.readResult()).toBe(1);
    });

    it("an any-typed numeric property read uses the native object MOP", async () => {
      const { module } = await compileNative(
        `
          var object: any = {};
          Object.defineProperty(object, "0", { value: 41 });
          export function readResult() {
            return object[0];
          }
        `,
        target,
      );
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
      exports.__module_init?.();
      expect(exports.readResult()).toBe(41);
    });

    it("an any-typed array HOF dispatches through the native method runtime", async () => {
      const { module } = await compileNative(
        `
          var values: any = [1, 2, 3];
          export function readResult() {
            var mapped = values.map((value: number) => value + 10);
            return mapped[1];
          }
        `,
        target,
      );
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
      exports.__module_init?.();
      expect(exports.readResult()).toBe(12);
    });

    it("a boxed String uses the native string-exotic object arm", async () => {
      const { module } = await compileNative(
        `
          var boxed: any = new String("ab");
          export function readResult() {
            return boxed[1] === "b" ? 1 : 0;
          }
        `,
        target,
      );
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
      exports.__module_init?.();
      expect(exports.readResult()).toBe(1);
    });

    it("an open object literal keeps Symbol.toPrimitive and ordinary fields in one carrier", async () => {
      const { module } = await compileNative(
        `
          var object = {
            [Symbol.toPrimitive]: function (hint: string) {
              return hint === "string" ? "coerced" : 7;
            },
            value: 41,
          };
          var alias = object;
          export function readResult() {
            return String(alias) === "coerced" && alias.value === 41 ? 1 : 0;
          }
        `,
        target,
      );
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as unknown as { __module_init?: () => void; readResult: () => number };
      exports.__module_init?.();
      expect(exports.readResult()).toBe(1);
    });
  });
}
