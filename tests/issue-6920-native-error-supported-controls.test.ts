// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import * as legacyGc from "../src/codegen/index.js";
import * as legacyLinear from "../src/codegen-linear/index.js";

afterEach(() => vi.restoreAllMocks());
for (const backend of ["linear", "wasmgc"] as const) {
  for (const target of ["standalone", "wasi"] as const) {
    it(`${backend}/${target}: supported statement TDZ is caught before startup and initialized afterward`, async () => {
      const gc = vi.spyOn(legacyGc, "generateModule").mockImplementation(() => {
        throw new Error("forbidden direct frontend");
      });
      const linear = vi.spyOn(legacyLinear, "generateLinearModule").mockImplementation(() => {
        throw new Error("forbidden direct frontend");
      });
      const result = await compile(
        "export function run():number { let result:number=0; try { result=value; } catch(error) { result=7; } return result; } const value:number=4;",
        {
          backend,
          target,
          deferTopLevelInit: true,
          sourceMap: false,
          optimize: false,
        },
      );
      expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
      expect(gc).not.toHaveBeenCalled();
      expect(linear).not.toHaveBeenCalled();
      const binary = new Uint8Array(result.binary);
      expect(WebAssembly.validate(binary)).toBe(true);
      expect(WebAssembly.Module.imports(new WebAssembly.Module(binary))).toEqual([]);
      const { instance } = await WebAssembly.instantiate(binary, {});
      expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(7);
      Reflect.apply(
        (target === "wasi" ? instance.exports._start : instance.exports.__module_init) as Function,
        undefined,
        [],
      );
      expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(4);
    });
    it(`${backend}/${target}: supported statement finally executes and rethrow preserves real exception behavior`, async () => {
      const result = await compile(
        "export var visits:number=0; export function run():number { let result:number=0; try { result=value; } catch(error) { throw error; } finally { visits=visits+1; } return result; } const value:number=4;",
        {
          backend,
          target,
          deferTopLevelInit: true,
          sourceMap: false,
          optimize: false,
        },
      );
      expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
      const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
      let thrown: unknown;
      try {
        Reflect.apply(instance.exports.run as Function, undefined, []);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WebAssembly.Exception);
      expect((instance.exports.visits as WebAssembly.Global).value).toBe(1);
      Reflect.apply(
        (target === "wasi" ? instance.exports._start : instance.exports.__module_init) as Function,
        undefined,
        [],
      );
      expect((instance.exports.visits as WebAssembly.Global).value).toBe(0);
      expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(4);
      expect((instance.exports.visits as WebAssembly.Global).value).toBe(1);
    });
  }
}
