// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function native(source: string, target: "standalone" | "wasi") {
  const result = await compile(source, {
    target,
    fileName: "issue-6979-carrier-materialization.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    optimize: 0,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, exports };
}

for (const target of ["standalone", "wasi"] as const) {
  describe(`#6979 shared builtin carrier materialization — ${target}`, () => {
    it("emits one complete Object getter instead of repeating its seed at every read", async () => {
      const readers = (count: number) =>
        Array.from({ length: count }, (_, i) => `export function read${i}(): any { return Object; }`).join("\n");
      const single = await native(readers(1), target);
      const repeated = await native(readers(12), target);
      expect(repeated.result.wat.match(/\(func \$__builtin_namespace_Object\b/g)).toHaveLength(1);
      expect(repeated.result.binary.length - single.result.binary.length).toBeLessThan(4096);
      const first = repeated.exports.read0!();
      expect(first).not.toBeNull();
      expect(first).not.toBeUndefined();
      for (let i = 1; i < 12; i++) expect(repeated.exports[`read${i}`]!()).toBe(first);
    });

    it("keeps the full function-valued Object surface on a dynamically discovered constructor", async () => {
      const { exports } = await native(
        `
        function ctorOf(value: any): any { return value.constructor; }
        export function readResult(): number {
          var ctor = ctorOf({ marker: 1 });
          var keys: any = ctor.keys({ first: 1, second: 2 });
          var desc: any = Object.getOwnPropertyDescriptor(ctor, "keys");
          return ctor === Object && keys.length === 2 && desc.value === Object.keys
            && desc.writable === true && desc.enumerable === false
            && desc.configurable === true && typeof ctor.defineProperty === "function" ? 42 : -1;
        }
      `,
        target,
      );
      expect(exports.readResult!()).toBe(42);
    });

    it("does not restore a mutated method when another reader enters the shared getter", async () => {
      const { exports } = await native(
        `
        function first(): any { return Array; }
        function second(): any { return Array; }
        var initial: any = first();
        initial.isArray = 17;
        export function readResult(): number {
          var later = second();
          var desc: any = Object.getOwnPropertyDescriptor(later, "isArray");
          return later === initial && later.isArray === 17 && desc.value === 17 ? 42 : -1;
        }
      `,
        target,
      );
      expect(exports.readResult!()).toBe(42);
    });

    it("preserves identity when prototype seeding re-enters constructor materialization", async () => {
      const { exports } = await native(
        `
        function get(value: any, key: string): any { return value[key]; }
        export function readResult(): number {
          var ctor = get([1], "constructor");
          var proto = get(ctor, "prototype");
          return get(proto, "constructor") === ctor && ctor === Array
            && ctor !== Object && ctor.isArray([1]) === true ? 42 : -1;
        }
      `,
        target,
      );
      expect(exports.readResult!()).toBe(42);
    });
  });
}
