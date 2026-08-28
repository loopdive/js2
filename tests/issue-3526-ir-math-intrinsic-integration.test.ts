// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { PURE_MATH_INTRINSIC_IDS, type IntrinsicId } from "../src/ir/intrinsics.js";
import { forEachInstrDeep, irVal, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3526-ir-math-intrinsic-integration");
const F64 = irVal({ kind: "f64" });
const BACKEND_OP_INTRINSICS = new Set<IntrinsicId>(["math.abs", "math.sqrt", "math.floor", "math.ceil", "math.trunc"]);
const BACKEND_SEQUENCE_INTRINSICS = new Set<IntrinsicId>(["math.fround"]);
const BACKEND_COMPOSITE_INTRINSICS = new Set<IntrinsicId>(["math.clz32", "math.imul", "math.max", "math.min"]);

const METHODS = PURE_MATH_INTRINSIC_IDS.map((id) => id.slice("math.".length));

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

function minimalResolver(): IrLowerResolver {
  let nextType = 0;
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => {
      throw new Error("resolveGlobal not used in this test");
    },
    resolveType: () => {
      throw new Error("resolveType not used in this test");
    },
    internFuncType: () => nextType++,
  };
}

function observedOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const outcome = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!outcome) throw new Error(`missing IR outcome for ${name}`);
  return outcome;
}

async function instantiate(result: CompileResult): Promise<Record<string, () => number>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, () => number>;
  (imports as { setExports?: (value: Record<string, () => number>) => void }).setExports?.(exports);
  return exports;
}

describe("#3526 M1 semantic Math intrinsic integration", () => {
  it("keeps source meaning provider-free until the frozen manifest attaches exact providers", () => {
    const analysis = analyzeSource(`
      export function allMath(x: number, y: number): number {
        return Math.abs(x) + Math.sqrt(x) + Math.floor(x) + Math.ceil(x) + Math.clz32(x) + Math.trunc(x)
          + Math.asin(x) + Math.acos(x) + Math.atan(x) + Math.sin(x) + Math.cos(x) + Math.tan(x)
          + Math.asinh(x) + Math.acosh(x) + Math.atanh(x)
          + Math.sinh(x) + Math.cosh(x) + Math.tanh(x)
          + Math.cbrt(x) + Math.fround(x) + Math.round(x) + Math.sign(x)
          + Math.imul(x, y) + Math.max(x, y) + Math.min(x, y)
          + Math.exp(x) + Math.expm1(x) + Math.log(x) + Math.log10(x) + Math.log1p(x) + Math.log2(x)
          + Math.pow(x, y) + Math.atan2(x, y);
      }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing allMath declaration");
    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("allMath").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);

    expect(semantic.map((instr) => instr.id).sort()).toEqual([...PURE_MATH_INTRINSIC_IDS].sort());
    expect(semantic.every((instr) => instr.provider === undefined)).toBe(true);
    expect(lowered.blocks.flatMap((block) => block.instrs).filter((instr) => instr.kind === "call")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: { name: expect.stringMatching(/^Math_/) } })]),
    );
    expect(() => lowerIrFunctionToWasm(lowered, minimalResolver())).toThrowError(
      /semantic intrinsic math\.abs has no frozen provider/,
    );

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "host", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");
    const instructions = intrinsicInstructions(prepared.functions[0]!);

    expect(prepared.manifest.intrinsicUses.map((use) => use.id).sort()).toEqual([...PURE_MATH_INTRINSIC_IDS].sort());
    for (const instr of instructions) {
      if (BACKEND_OP_INTRINSICS.has(instr.id)) {
        expect(instr.provider).toMatchObject({ kind: "backend-op" });
      } else if (BACKEND_SEQUENCE_INTRINSICS.has(instr.id)) {
        expect(instr.provider).toEqual({ kind: "backend-sequence", sequence: "f64.fround" });
      } else if (BACKEND_COMPOSITE_INTRINSICS.has(instr.id)) {
        expect(instr.provider).toEqual({ kind: "backend-composite", operation: instr.id });
      } else {
        expect(instr.provider).toMatchObject({
          kind: "callable",
          target: { binding: { kind: "intrinsic", symbol: instr.id }, name: `Math_${instr.id.slice(5)}` },
        });
      }
    }
    expect(verifyIrFunction(prepared.functions[0]!)).toEqual([]);
    expect(() => lowerIrFunctionToWasm(prepared.functions[0]!, minimalResolver())).not.toThrow();
  });

  it("emits every certified method as an IR-only body with the established native and self-hosted providers", async () => {
    const source = `
      export function abs(): number { return Math.abs(-3.5); }
      export function sqrt(): number { return Math.sqrt(144); }
      export function floor(): number { return Math.floor(3.9); }
      export function ceil(): number { return Math.ceil(3.1); }
      export function clz32(): number { return Math.clz32(0x100); }
      export function trunc(): number { return Math.trunc(-3.9); }
      export function asin(): number { return Math.asin(0.5); }
      export function acos(): number { return Math.acos(0.5); }
      export function atan(): number { return Math.atan(1); }
      export function asinh(): number { return Math.asinh(1); }
      export function acosh(): number { return Math.acosh(2); }
      export function atanh(): number { return Math.atanh(0.5); }
      export function sin(): number { return Math.sin(0.75); }
      export function cos(): number { return Math.cos(0.75); }
      export function tan(): number { return Math.tan(0.75); }
      export function sinh(): number { return Math.sinh(0.75); }
      export function cosh(): number { return Math.cosh(0.75); }
      export function tanh(): number { return Math.tanh(0.75); }
      export function cbrt(): number { return Math.cbrt(27); }
      export function fround(): number { return Math.fround(1.337); }
      export function imul(): number { return Math.imul(0x7fffffff, 0x7fffffff); }
      export function max(): number { return Math.max(-3, 7); }
      export function min(): number { return Math.min(-3, 7); }
      export function round(): number { return Math.round(-27.5); }
      export function sign(): number { return Math.sign(-27); }
      export function exp(): number { return Math.exp(1.25); }
      export function expm1(): number { return Math.expm1(1.25); }
      export function log(): number { return Math.log(3.5); }
      export function log10(): number { return Math.log10(1000); }
      export function log1p(): number { return Math.log1p(3.5); }
      export function log2(): number { return Math.log2(32); }
      export function pow(): number { return Math.pow(2.5, 3); }
      export function atan2(): number { return Math.atan2(1, -1); }
    `;
    const [ir, direct] = await Promise.all([
      compile(source, {
        fileName: "issue-3526-ir-math-intrinsics.ts",
        emitWat: true,
        experimentalIR: true,
        trackIrOutcomes: true,
      }),
      compile(source, {
        fileName: "issue-3526-direct-math-control.ts",
        experimentalIR: false,
      }),
    ]);

    expect(ir.success, ir.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(ir.binary)).toBe(true);
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(ir.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    for (const method of METHODS) {
      expect(observedOutcome(ir, method)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }

    for (const opcode of ["f64.abs", "f64.sqrt", "f64.floor", "f64.ceil", "f64.trunc"]) {
      expect(ir.wat).toContain(opcode);
    }
    expect(ir.wat).toContain("f32.demote_f64");
    expect(ir.wat).toContain("f64.promote_f32");
    expect(ir.wat).toContain("i32.clz");
    expect(ir.wat).toContain("i32.mul");
    expect(ir.wat).toContain("f64.max");
    expect(ir.wat).toContain("f64.min");
    for (const helper of [
      "asin",
      "acos",
      "atan",
      "asinh",
      "acosh",
      "atanh",
      "sin",
      "cos",
      "tan",
      "sinh",
      "cosh",
      "tanh",
      "cbrt",
      "round",
      "sign",
      "exp",
      "expm1",
      "log",
      "log10",
      "log1p",
      "log2",
      "pow",
      "atan2",
    ]) {
      expect(ir.wat).toContain(`$Math_${helper}`);
    }
    expect(ir.wat).not.toContain("$__box_number");

    const [irExports, directExports] = await Promise.all([instantiate(ir), instantiate(direct)]);
    for (const method of METHODS) expect(irExports[method]!()).toBe(directExports[method]!());
  });

  it("keeps the builder closed over the versioned semantic signatures", () => {
    const builder = new IrFunctionBuilder(identities.next("wrongArity"), [F64]);
    builder.openBlock();
    const x = builder.emitConst({ kind: "f64", value: 1 }, F64);
    expect(() => builder.emitIntrinsic("math.pow", [x])).toThrowError(/expects 2 argument/);
    builder.terminate({ kind: "return", values: [x] });
    builder.finish();
  });
});
