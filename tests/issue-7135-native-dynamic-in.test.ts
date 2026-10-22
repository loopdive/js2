// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { parameterHasDynamicExternrefAbi } from "../src/codegen/ir-dynamic-parameter-abi.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { ValType } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

async function build(source: string, experimentalIR: boolean, target: "standalone" | "wasi") {
  const result = await compile(source, {
    target,
    fileName: "native-in.ts",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    experimentalIR,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return { result, run: instance.exports.run as () => number };
}

describe("#7135 native dynamic in", () => {
  for (const target of ["standalone", "wasi"] as const) {
    for (const [name, receiver, key, expected] of [
      ["own property", "{ name: 3 }", '"name"', 1],
      ["present undefined", "{ name: undefined }", '"name"', 1],
      ["absent property", "{ other: 3 }", '"name"', 0],
      ["inherited property", "makeInherited()", '"name"', 1],
      ["numeric key", "{ 2: 3 }", "2", 1],
      ["Proxy has trap", "new Proxy({}, { has() { return true; } })", '"name"', 1],
      ["callable receiver", "(function () {})", '"absent"', 0],
    ] as const) {
      it(`${name}: native IR emits a body and agrees with legacy and JavaScript (${target})`, async () => {
        const source = `
        function makeInherited(): any { const proto: any = Object.create(null); proto.name = 3; return Object.create(proto); }
        export function has(o: any): boolean { return ${key} in o; }
        export function run(): number { return (has(${receiver}) ? 1 : 0) + 0; }
      `;
        for (const ir of [false, true]) {
          const { result, run } = await build(source, ir, target);
          expect(run()).toBe(expected);
          if (ir) {
            expect(
              result.irOutcomes?.find((o) => o.displayName === "has"),
              JSON.stringify(result.irOutcomes),
            ).toMatchObject({ irBodyEmitted: true });
            expect(result.irPostClaimErrors ?? []).toEqual([]);
          }
        }
      });
    }

    for (const [type, key, argument, property] of [
      ["boolean", "k", "true", "true"],
      ["number", "k | 0", "2", "2"],
      ["number", "k >>> 0", "-1", "4294967295"],
    ] as const) {
      it(`boxes a concrete ${type} key ${key} (${target})`, async () => {
        const source = `
          export function has(o: any, k: ${type}): boolean { return (${key}) in o; }
          export function run(): number { return has({ "${property}": 3 }, ${argument}) ? 1 : 0; }
        `;
        for (const ir of [false, true]) {
          const { result, run } = await build(source, ir, target);
          expect(run()).toBe(1);
          if (ir)
            expect(
              result.irOutcomes?.find((o) => o.displayName === "has"),
              JSON.stringify(result.irOutcomes),
            ).toMatchObject({ irBodyEmitted: true });
          expect(result.irPostClaimErrors ?? []).toEqual([]);
        }
      });
    }

    it(`preserves the dynamic key carrier (${target})`, async () => {
      const source = `
      export function has(o: any, key: any): boolean { return key in o; }
      export function run(): number { return (has({ name: 3 }, "name") ? 1 : 0) + 0; }
    `;
      for (const ir of [false, true]) {
        const { result, run } = await build(source, ir, target);
        expect(run()).toBe(1);
        if (ir) expect(result.irOutcomes?.find((o) => o.displayName === "has")).toMatchObject({ irBodyEmitted: true });
      }
    });

    it(`preserves a dynamic symbol key (${target})`, async () => {
      const source = `
        export function has(o: any, k: any): boolean { return k in o; }
        export function run(): number {
          var k = Symbol.for("name");
          return (has({ [k]: 3 }, k) ? 1 : 0) + 0;
        }
      `;
      for (const ir of [false, true]) {
        const { result, run } = await build(source, ir, target);
        expect(run()).toBe(1);
        if (ir)
          expect(
            result.irOutcomes?.find((o) => o.displayName === "has"),
            JSON.stringify(result.irOutcomes),
          ).toMatchObject({ irBodyEmitted: true });
      }
    });

    for (const primitive of ["null", "undefined", "1", "true", '"abc"'] as const) {
      it(`${primitive} on the RHS throws TypeError before property search (${target})`, async () => {
        const source = `
        export function has(o: any): boolean { return "name" in o; }
        export function run(): number {
          try { has(${primitive}); return 0; }
          catch (e) { return e instanceof TypeError ? 1 : 2; }
        }
      `;
        const { result, run } = await build(source, true, target);
        expect(run()).toBe(1);
        expect(result.irOutcomes?.find((o) => o.displayName === "has")).toMatchObject({ irBodyEmitted: true });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      });
    }

    it(`evaluates the key before the receiver exactly once (${target})`, async () => {
      const source = `
      var order = 0;
      function key(): any { order = order * 10 + 1; return "name"; }
      function receiver(o: any): any { order = order * 10 + 2; return o; }
      export function has(o: any): boolean { return key() in receiver(o); }
      export function run(): number { return has({ name: 3 }) ? order : -1; }
    `;
      for (const ir of [false, true]) {
        const { result, run } = await build(source, ir, target);
        expect(run()).toBe(12);
        if (ir) expect(result.irOutcomes?.find((o) => o.displayName === "has")).toMatchObject({ irBodyEmitted: true });
      }
    });
    for (const valid of [true, false]) {
      it(`coerces an object key once, after validating the receiver (${target}, valid=${valid})`, async () => {
        const source = `
        var order = 0;
        function key(k: any): any { order = order * 10 + 1; return k; }
        function receiver(o: any): any { order = order * 10 + 2; return o; }
        export function has(o: any, k: any): boolean { return key(k) in receiver(o); }
        export function run(): number {
          const proto: any = Object.create(null); proto.name = 3;
          var o = ${valid ? "Object.create(proto)" : "null"};
          var k = { toString() { order = order * 10 + 3; return "name"; } };
          try { return has(o, k) ? order : -1; }
          catch (e) { return e instanceof TypeError ? order : -2; }
        }
      `;
        const { result, run } = await build(source, true, target);
        expect(run()).toBe(valid ? 123 : 12);
        expect(
          result.irOutcomes?.find((o) => o.displayName === "has"),
          JSON.stringify(result.irOutcomes),
        ).toMatchObject({ irBodyEmitted: true });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      });
    }
  }
});

describe("#7135 dynamic parameter physical ABI proof", () => {
  const source = ts.createSourceFile(
    "abi.ts",
    "function f(p: any): boolean { return true; }",
    ts.ScriptTarget.Latest,
    true,
  );
  const parameter = (source.statements[0] as ts.FunctionDeclaration).parameters[0]!;
  for (const [name, environment, fast, slot, registered, expected] of [
    ["standalone externref", "none", false, { kind: "externref" }, true, true],
    ["WASI externref", "wasi", false, { kind: "externref" }, true, true],
    ["fast carrier", "none", true, { kind: "externref" }, true, false],
    ["JS host", "javascript", false, { kind: "externref" }, true, false],
    ["missing registration", "none", false, { kind: "externref" }, false, false],
    ["refined struct", "none", false, { kind: "ref_null", typeIdx: 1 }, true, false],
    ["numeric slot", "none", false, { kind: "f64" }, true, false],
  ] as const) {
    it(name, () => {
      const ctx = {
        fast,
        targetProfile: { environment },
        numImportFuncs: 0,
        funcMap: new Map(registered ? [["f", 0]] : []),
        mod: {
          functions: [{ typeIdx: 0 }],
          types: [{ kind: "func", params: [slot as ValType], results: [] }],
          funcOrdinalToPosition: [],
        },
      } as unknown as CodegenContext;
      expect(parameterHasDynamicExternrefAbi(ctx, parameter)).toBe(expected);
    });
  }
});
