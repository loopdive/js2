// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  asBlockId,
  asValueId,
  irUnitFuncRef,
  irVal,
  verifyIrFunction,
  type IrFunction,
  type IrInstr,
} from "../src/ir/index.js";
import { inlineSmall } from "../src/ir/passes/inline-small.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("5398/inliner-frames");
const f64 = irVal({ kind: "f64" });
const value = asValueId;

function scalar(): IrFunction {
  return {
    ...identities.next("scalar"),
    params: [],
    resultTypes: [f64],
    exported: false,
    valueCount: 1,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "const", result: value(0), resultType: f64, value: { kind: "f64", value: 7 } }],
        terminator: { kind: "return", values: [value(0)] },
      },
    ],
  };
}

function caller(callee: IrFunction, ownSlot: boolean): IrFunction {
  const instrs: IrInstr[] = [];
  if (ownSlot)
    instrs.push(
      { kind: "const", result: value(0), resultType: f64, value: { kind: "f64", value: 99 } },
      { kind: "slot.write", slot: 0, value: value(0), result: null, resultType: null },
    );
  instrs.push({ kind: "call", target: irUnitFuncRef(callee), args: [], result: value(1), resultType: f64 });
  if (ownSlot) instrs.push({ kind: "slot.read", slot: 0, result: value(2), resultType: f64 });
  return {
    ...identities.next("caller"),
    params: [],
    resultTypes: [f64],
    exported: true,
    valueCount: 3,
    ...(ownSlot ? { slots: [{ index: 0, name: "callerSlot", type: { kind: "f64" as const } }] } : {}),
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [value(ownSlot ? 2 : 1)] },
      },
    ],
  };
}

describe("#5398 inliner frame ownership", () => {
  it("rejects a frame-dependent allocating callee before allocation forks or call retirement", () => {
    const registry = new AllocSiteRegistry();
    const string = { kind: "string" as const };
    const leaf = new IrFunctionBuilder(identities.next("allocating"), [string], false, registry);
    const left = leaf.addParam("left", string);
    const right = leaf.addParam("right", string);
    leaf.declareSlot("private", { kind: "externref" });
    leaf.openBlock();
    const joined = leaf.emitStringConcat(left, right);
    leaf.terminate({ kind: "return", values: [joined] });
    const callee = leaf.finish();
    const parent = new IrFunctionBuilder(identities.next("allocCaller"), [string], true, registry);
    const a = parent.addParam("a", string);
    const b = parent.addParam("b", string);
    parent.openBlock();
    const call = parent.emitCall(irUnitFuncRef(callee), [a, b], string);
    if (call === null) throw new Error("Expected result");
    parent.terminate({ kind: "return", values: [call] });
    const compiledParent = parent.finish();
    const before = registry.snapshot();
    const result = inlineSmall({ functions: [callee, compiledParent] }, registry);
    expect(result.functions[1]).toBe(compiledParent);
    expect(registry.snapshot()).toEqual(before);
  });
  it.each([false, true])("retains callee slots with caller slot0=%s", (ownSlot) => {
    const leaf = scalar();
    const callee: IrFunction = {
      ...leaf,
      slots: [{ index: 0, name: "calleeSlot", type: { kind: "f64" } }],
      valueCount: 2,
      blocks: [
        {
          ...leaf.blocks[0]!,
          instrs: [
            ...leaf.blocks[0]!.instrs,
            { kind: "slot.write", slot: 0, value: value(0), result: null, resultType: null },
            { kind: "slot.read", slot: 0, result: value(1), resultType: f64 },
          ],
          terminator: { kind: "return", values: [value(1)] },
        },
      ],
    };
    const parent = caller(callee, ownSlot);
    expect(verifyIrFunction(callee)).toEqual([]);
    expect(verifyIrFunction(parent)).toEqual([]);
    const result = inlineSmall({ functions: [callee, parent] });
    expect(result.functions[1]).toBe(parent);
    expect(result.functions[1]!.valueCount).toBe(parent.valueCount);
    expect(verifyIrFunction(result.functions[1]!)).toEqual([]);
  });

  it.each([
    { generatorBufferSlot: 0 },
    { funcKind: "generator" },
    { funcKind: "async" },
    { closureSubtype: { signature: { params: [], results: [] }, captureFieldTypes: [] } },
    { asyncPlan: { states: [] } },
    { asyncRuntime: { states: [] } },
  ])("does not erase non-SSA metadata %j", (metadata) => {
    // Intentionally partial metadata also must not license an SSA-only transfer.
    const callee = { ...scalar(), ...metadata } as IrFunction;
    const parent = caller(callee, false);
    expect(inlineSmall({ functions: [callee, parent] }).functions[1]).toBe(parent);
  });

  it.each(["slot.read", "slot.write", "gen.push", "gen.epilogue", "gen.yieldStar", "gen.setReturn", "closure.cap"])(
    "retains a callee with untransferred %s even without frame metadata",
    (kind) => {
      const leaf = scalar();
      const instr = {
        kind,
        result: null,
        resultType: null,
        value: value(0),
        inner: value(0),
        self: value(0),
        slot: 0,
        index: 0,
      } as IrInstr;
      const callee = { ...leaf, blocks: [{ ...leaf.blocks[0]!, instrs: [...leaf.blocks[0]!.instrs, instr] }] };
      const parent = caller(callee, false);
      expect(inlineSmall({ functions: [callee, parent] }).functions[1]).toBe(parent);
    },
  );

  it("actually inlines an ordinary scalar callee", () => {
    const callee = scalar();
    const parent = caller(callee, false);
    const result = inlineSmall({ functions: [callee, parent] }).functions[1]!;
    expect(result).not.toBe(parent);
    expect(result.blocks[0]!.instrs.some((instr) => instr.kind === "call")).toBe(false);
    expect(result.valueCount).toBeGreaterThan(parent.valueCount);
    expect(verifyIrFunction(result)).toEqual([]);
  });

  it.each([0, 2] as const)(
    "executes ignored delegation and numeric return through genuine IR O%s",
    async (optimize) => {
      const result = await compile("function* g(){yield* [1,2];return 7;} export function test(){return g();}", {
        fileName: "completion.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        optimize,
        trackFallbacks: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      console.log(
        "ignored delegation IR evidence",
        Object.fromEntries(Object.entries(result).filter(([key]) => key.startsWith("ir"))),
        result.errors,
      );
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      const iterator = (instance.exports.test as () => Iterator<unknown>)();
      expect(iterator.next()).toEqual({ value: 1, done: false });
      expect(iterator.next()).toEqual({ value: 2, done: false });
      expect(iterator.next()).toEqual({ value: 7, done: true });
      expect(iterator.next()).toEqual({ value: undefined, done: true });
      expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["g", "test"]));
      expect(result.irPostClaimErrors).toEqual([]);
    },
  );
});
