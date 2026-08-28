// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { forEachInstrDeep, irVal, irValSigned, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { createEmptyModule, type FuncTypeDef, type Instr, type WasmModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5136-ir-exact-touint32");
const F64 = irVal({ kind: "f64" });
const U32 = irValSigned({ kind: "i32" }, false);

const EDGE_VALUES = [
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  -0,
  0,
  -Number.MIN_VALUE,
  Number.MIN_VALUE,
  -0.999,
  0.999,
  -3.9,
  3.9,
  -1,
  2 ** 31 - 1,
  -(2 ** 31),
  2 ** 31,
  -(2 ** 31) - 1,
  2 ** 32 - 1,
  2 ** 32,
  2 ** 32 + 1,
  -(2 ** 32),
  -(2 ** 32) - 1,
  2 ** 63,
  2 ** 63 + 2048,
  2 ** 64,
  2 ** 64 + 4096,
  2 ** 65 + 8192,
  -(2 ** 63) - 2048,
  -(2 ** 64) - 4096,
  -1e20,
  1e20,
  -Number.MAX_VALUE,
  Number.MAX_VALUE,
] as const;

const IMUL_PAIRS = [
  [0xffff_ffff, 2],
  [0x8000_0000, 2],
  [0xffff_ffff, 0xffff_ffff],
  [2 ** 32 + 1, 2 ** 32 + 1],
  [2 ** 63 + 2048, 3],
] as const;

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
}

async function instantiateCompilation(result: CompileResult): Promise<Record<string, unknown>> {
  const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, unknown>;
  (imports as { setExports?: (value: Record<string, unknown>) => void }).setExports?.(exports);
  return exports;
}

function semanticToUint32(): IrFunction {
  const builder = new IrFunctionBuilder(identities.next("toUint32"), [U32], true);
  const value = builder.addParam("value", F64);
  builder.openBlock();
  const result = builder.emitIntrinsic("js.to_uint32", [value]);
  builder.terminate({ kind: "return", values: [result] });
  return builder.finish();
}

function intrinsicInstructions(fn: IrFunction): IrInstrIntrinsic[] {
  const instructions: IrInstrIntrinsic[] = [];
  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "intrinsic") instructions.push(instr);
      });
    }
  }
  return instructions;
}

function resolverFor(module: WasmModule): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => {
      throw new Error("resolveGlobal not used in this test");
    },
    resolveType: () => {
      throw new Error("resolveType not used in this test");
    },
    internFuncType: (type: FuncTypeDef) => {
      const index = module.types.length;
      module.types.push(type);
      return index;
    },
  };
}

async function lowerAndInstantiate(
  fn: IrFunction,
  emitter: WasmGcEmitter | LinearEmitter,
): Promise<{ body: Instr[]; invoke: (value: number) => number }> {
  const module = createEmptyModule();
  const lowered = lowerIrFunctionToWasm(fn, resolverFor(module), emitter).func;
  module.functions.push(lowered);
  module.exports.push({ name: lowered.name, desc: { kind: "func", index: 0 } });
  const { instance } = await WebAssembly.instantiate(emitBinary(module), {});
  return {
    body: lowered.body,
    invoke: instance.exports[lowered.name] as (value: number) => number,
  };
}

describe("#5136 exact ToUint32 prerequisite", () => {
  it("fixes the legacy Math.clz32/imul helper for large finite values", async () => {
    const result = await compile(
      `
        export function clz(value: number): number { return Math.clz32(value); }
        export function imul1(value: number): number { return Math.imul(value, 1); }
        export function imul(left: number, right: number): number { return Math.imul(left, right); }
      `,
      {
        fileName: "issue-5136-direct-control.ts",
        experimentalIR: false,
        emitWat: true,
      },
    );
    expectSuccess(result);

    const exports = await instantiateCompilation(result);
    const clz = exports.clz as (value: number) => number;
    const imul1 = exports.imul1 as (value: number) => number;
    const imul = exports.imul as (left: number, right: number) => number;
    for (const value of EDGE_VALUES) {
      expect(clz(value), `Math.clz32(${String(value)})`).toBe(Math.clz32(value));
      expect(imul1(value), `Math.imul(${String(value)}, 1)`).toBe(Math.imul(value, 1));
    }
    for (const [left, right] of IMUL_PAIRS) {
      const actual = imul(left, right);
      expect(actual, `Math.imul(${left}, ${right})`).toBe(Math.imul(left, right));
      if (actual === 0) expect(Object.is(actual, -0)).toBe(false);
    }

    const importNames = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.name);
    expect(importNames).not.toEqual(expect.arrayContaining(["Math_clz32", "Math_imul", "__toUint32"]));
    const wat = result.wat ?? "";
    const helperStart = wat.indexOf("  (func $__toUint32");
    const helperEnd = wat.indexOf("\n  (func $", helperStart + 1);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    const helperWat = wat.slice(helperStart, helperEnd < 0 ? wat.length : helperEnd);
    expect(helperWat).toContain("i64.reinterpret_f64");
    expect(helperWat).not.toContain("i64.trunc_sat_f64_s");
  });

  it("freezes one dependency-free composite provider and rejects unsupported consumers", () => {
    const raw = semanticToUint32();
    const rawInstructions = intrinsicInstructions(raw);
    expect(rawInstructions).toEqual([expect.objectContaining({ id: "js.to_uint32", resultType: U32 })]);
    expect(rawInstructions[0]?.provider).toBeUndefined();
    expect(() => lowerIrFunctionToWasm(raw, resolverFor(createEmptyModule()))).toThrowError(
      /semantic intrinsic js\.to_uint32 has no frozen provider/,
    );

    for (const backend of ["wasmgc", "linear"] as const) {
      const prepared = prepareIrRuntimeManifest({
        functions: [raw],
        sourceFile: "issue-5136-semantic.ts",
        policy: { target: "standalone", backend },
      });
      if (!prepared) throw new Error("expected a non-empty runtime manifest");
      expect(prepared.manifest.intrinsicUses.map((use) => use.id)).toEqual(["js.to_uint32"]);
      expect(prepared.manifest.features).toEqual(["js.to_uint32"]);
      expect(prepared.manifest.hostCapabilities).toEqual([]);
      expect(prepared.manifest.providers).toEqual([
        expect.objectContaining({
          id: "backend.js.to_uint32",
          feature: "js.to_uint32",
          dependencies: [],
          hostCapabilities: [],
          implementation: { kind: "backend-composite", operation: "to-uint32" },
        }),
      ]);
      expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toEqual({
        kind: "backend-composite",
        operation: "to-uint32",
      });
      expect(verifyIrBackendLegality(prepared.functions[0]!, backend)).toEqual([]);
      expect(verifyIrBackendLegality(prepared.functions[0]!, "bytecode")[0]?.message).toContain(
        "bytecode backend does not support semantic intrinsic 'js.to_uint32'",
      );
      expect(verifyIrBackendLegality(prepared.functions[0]!, "porffor")[0]?.message).toContain(
        "porffor backend does not support semantic intrinsic 'js.to_uint32'",
      );
    }
  });

  it("executes one identical exact sequence on WasmGC and linear", async () => {
    const prepared = prepareIrRuntimeManifest({
      functions: [semanticToUint32()],
      sourceFile: "issue-5136-runtime.ts",
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    const [wasmgc, linear] = await Promise.all([
      lowerAndInstantiate(prepared.functions[0]!, new WasmGcEmitter()),
      lowerAndInstantiate(prepared.functions[0]!, new LinearEmitter()),
    ]);
    expect(linear.body).toEqual(wasmgc.body);
    expect(wasmgc.body).toEqual(expect.arrayContaining([expect.objectContaining({ op: "i64.reinterpret_f64" })]));
    expect(wasmgc.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ op: "i64.trunc_sat_f64_s" })]));
    for (const value of EDGE_VALUES) {
      const expected = value >>> 0;
      expect(wasmgc.invoke(value) >>> 0, `WasmGC ToUint32(${String(value)})`).toBe(expected);
      expect(linear.invoke(value) >>> 0, `linear ToUint32(${String(value)})`).toBe(expected);
    }
  });
});
