// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import * as oldDemands from "../src/ir/program-runtime-demands.js";
import * as demands from "../src/ir/program/runtime-demands.js";
import * as oldAbi from "../src/ir/program-runtime-abi.js";
import * as abi from "../src/ir/program/runtime-abi.js";
import { irCallableBindingKey, irRuntimeFuncRef, irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { preparedIrProgramOwner } from "../src/ir/program/owner.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { sourceInput, sourcePacket, requireProgram } from "./helpers/typed-program-fixtures.js";

let source: ReturnType<typeof sourcePacket>["source"];
beforeAll(() => {
  source = sourcePacket({ "./entry.ts": "export function main(): number { return 1; }" }).source;
});
function caller(symbols: readonly string[]): IrFunction {
  const original = source.ir.functions[0]!;
  const extern = irVal({ kind: "externref" });
  const builder = new IrFunctionBuilder({ unitId: original.unitId, name: original.name }, [], false);
  builder.openBlock();
  const value = builder.emitConst({ kind: "null", ty: extern }, extern);
  for (const symbol of symbols)
    builder.emitCall(
      symbol === "js.number.from-value" ? irIntrinsicFuncRef(symbol) : irRuntimeFuncRef(symbol),
      [value],
      extern,
    );
  builder.terminate({ kind: "return", values: [] });
  return builder.finish();
}
function input(fn: IrFunction) {
  return { ...source, ir: { functions: [fn] } };
}
function failure(action: () => unknown): PreparedIrProgramInvariantError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PreparedIrProgramInvariantError);
    return error as PreparedIrProgramInvariantError;
  }
  throw new Error("expected refusal");
}

describe("canonical program runtime demand and ABI owners", () => {
  it("forwards every scanner and ABI value with the same identity", () => {
    expect(Object.keys(oldDemands).sort()).toEqual(Object.keys(demands).sort());
    for (const name of Object.keys(demands) as (keyof typeof demands)[]) expect(oldDemands[name]).toBe(demands[name]);
    expect(Object.keys(oldAbi).sort()).toEqual(Object.keys(abi).sort());
    for (const name of Object.keys(abi) as (keyof typeof abi)[]) expect(oldAbi[name]).toBe(abi[name]);
  });
  it("scans nested ordinary instructions without changing the genuine owner", () => {
    const fn = source.ir.functions[0]!;
    const before = JSON.stringify(fn);
    const nested = {
      ...fn,
      blocks: fn.blocks.map((block) => ({
        ...block,
        instrs: [
          {
            kind: "if.stmt",
            cond: 0,
            then: [{ kind: "string.const", value: "x\ud800" }],
            else: [{ kind: "string.const", value: "plain" }],
            result: null,
            resultType: null,
          } as unknown as IrInstr,
        ],
      })),
    };
    expect(demands.irProgramRuntimeDemands(nested).stringConstDemand).toEqual({ literal: true, utf16: true });
    expect(JSON.stringify(fn)).toBe(before);
    expect(oldDemands.irProgramRuntimeDemands(nested)).toEqual(demands.irProgramRuntimeDemands(nested));
  });
  it("scans genuine async states even when ordinary blocks have no string literal", () => {
    const program = requireProgram(
      prepareWholeIrProgram(
        sourceInput({
          "./entry.ts":
            "export async function main(value: number): Promise<number> { const next = await value; return next; }",
        }),
      ),
    );
    const fn = program.ir.functions.find((fn) => fn.asyncPlan)!;
    expect(fn.asyncPlan!.states.length).toBeGreaterThan(0);
    const mutant = {
      ...fn,
      blocks: fn.blocks.map((block) => ({ ...block, instrs: [] })),
      asyncPlan: {
        ...fn.asyncPlan!,
        states: fn.asyncPlan!.states.map((state, index) => ({
          ...state,
          body: index === 0 ? [{ kind: "string.const", value: "state" } as unknown as IrInstr] : [],
        })),
      },
    };
    expect(demands.irProgramRuntimeDemands(mutant).stringConstDemand).toEqual({ literal: true, utf16: false });
  });
  it("keeps guarded char-code demand separate from trusted intrinsic admission", () => {
    const fn = caller([]),
      block = fn.blocks[0]!;
    const call = (symbol: string) =>
      ({ kind: "call", target: irIntrinsicFuncRef(symbol), args: [], result: null, resultType: null }) as IrInstr;
    const withCall = (symbol: string) => ({ ...fn, blocks: [{ ...block, instrs: [call(symbol)] }] });
    expect(demands.irStringCharCodeAtDemand([withCall("__jsstr_charCodeAt")])).toBe(true);
    expect(demands.irStringCharCodeAtDemand([withCall("__jsstr_charCodeAt_trusted")])).toBe(false);
  });
  it("deduplicates runtime declarations and returns canonical lexical frozen order", () => {
    const result = abi.prepareIrProgramRuntimeCallables(
      input(caller(["js.number.from-value", "__new_ReferenceError", "js.number.from-value"])),
    );
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.declarations).toEqual([
      irRuntimeCallableDeclaration(irIntrinsicFuncRef("js.number.from-value")),
      irRuntimeCallableDeclaration(irRuntimeFuncRef("__new_ReferenceError")),
    ]);
    expect(result.declarations.map((row) => irCallableBindingKey(row.ref.binding))).toEqual(
      result.declarations.map((row) => irCallableBindingKey(row.ref.binding)).sort(),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.declarations)).toBe(true);
  });
  it("keeps a genuine nonempty population with no runtime demands explicit", () => {
    expect(source.ir.functions).toHaveLength(1);
    expect(abi.prepareIrProgramRuntimeCallables(source)).toEqual({ kind: "prepared", declarations: [] });
  });
  it("locates an unknown runtime reference at the actual original owner", () => {
    const fn = caller(["__unknown_owner_runtime"]);
    expect(abi.prepareIrProgramRuntimeCallables(input(fn))).toEqual({
      kind: "invariant",
      code: "unknown-function-ref",
      stage: "resolve",
      detail: `runtime callable ${irCallableBindingKey(irRuntimeFuncRef("__unknown_owner_runtime").binding)} has no canonical declaration`,
      ...preparedIrProgramOwner(source, fn.unitId),
    });
  });
  it("leaves unrelated intrinsic families to their own admission guards", () => {
    const fn = caller([]),
      block = fn.blocks[0]!;
    const intrinsic = {
      kind: "call",
      target: irIntrinsicFuncRef("__other_intrinsic_family"),
      args: [],
      result: null,
      resultType: null,
    } as IrInstr;
    expect(abi.prepareIrProgramRuntimeCallables(input({ ...fn, blocks: [{ ...block, instrs: [intrinsic] }] }))).toEqual(
      { kind: "prepared", declarations: [] },
    );
  });
  it("checks population before an unknown callable when both are defective", () => {
    const fn = caller(["__unknown_owner_runtime"]);
    const missing = { ...source, ir: { functions: [] } };
    const single = failure(() => abi.prepareIrProgramRuntimeCallables(missing));
    const paired = failure(() => abi.prepareIrProgramRuntimeCallables({ ...source, ir: { functions: [fn, fn] } }));
    expect(single.code).toBe("invalid-prepared-data");
    expect(single.message).toContain("missing body");
    expect(paired.code).toBe("invalid-prepared-data");
    expect(paired.message).toContain("duplicated");
    expect(paired.message).not.toContain("canonical declaration");
  });
  it("rejects contradictory catalog data without inventing a source location", () => {
    const canonical = irRuntimeCallableDeclaration(irRuntimeFuncRef("__new_ReferenceError"))!;
    expect(() => abi.assertPreparedIrRuntimeCallableDeclaration(canonical)).not.toThrow();
    const error = failure(() =>
      abi.assertPreparedIrRuntimeCallableDeclaration({
        ...canonical,
        feature: "false-feature" as typeof canonical.feature,
      }),
    );
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("contradicts its canonical declaration");
    expect(error).not.toHaveProperty("location");
    expect(error).not.toHaveProperty("unitId");
  });
  it("sorts unique fused concat arities and retains both concat ownership modes", () => {
    const fn = source.ir.functions[0]!,
      block = fn.blocks[0]!;
    const instrs = [
      ...[12, 3, 12].map((arity) => ({
        kind: "call",
        target: irIntrinsicFuncRef(`string.concat$arity${arity}`),
        args: [],
        result: null,
        resultType: null,
      })),
      {
        kind: "call",
        target: irIntrinsicFuncRef("async.string.concat$arity5"),
        args: [],
        result: null,
        resultType: null,
      },
      { kind: "string.concat", concatMode: "owned-append" },
      { kind: "string.concat" },
    ] as unknown as IrInstr[];
    const scanned = { ...fn, blocks: [{ ...block, instrs }] };
    const result = demands.irProgramRuntimeDemands(scanned);
    expect(result.stringConcatManyDemand.arities).toEqual([3, 5, 12]);
    expect(Object.isFrozen(result.stringConcatManyDemand.arities)).toBe(true);
    expect(result.stringConcatDemand).toEqual({ immutable: true, owned: true });
  });
  it("keeps host callback and native dispatch marker demands independent", () => {
    const fn = source.ir.functions[0]!,
      block = fn.blocks[0]!;
    const scan = (properties: object) =>
      demands.irHostCallbackWrapDemand([
        { ...fn, blocks: [{ ...block, instrs: [{ kind: "closure.new", ...properties } as unknown as IrInstr] }] },
      ]);
    expect(scan({})).toEqual({ host: false, nativeDispatch: false });
    expect(scan({ hostOneShot: true })).toEqual({ host: true, nativeDispatch: false });
    expect(scan({ domCallbackAuthority: {} })).toEqual({ host: false, nativeDispatch: true });
  });
  it("selects Function.prototype.call demand by runtime binding rather than display name", () => {
    const fn = source.ir.functions[0]!,
      block = fn.blocks[0]!;
    const scan = (target: ReturnType<typeof irRuntimeFuncRef>) =>
      demands.irFunctionPrototypeCallDemand([
        { ...fn, blocks: [{ ...block, instrs: [{ kind: "call", target, args: [], result: null, resultType: null }] }] },
      ]);
    expect(scan(irRuntimeFuncRef("__function_prototype_call", "different-display"))).toBe(true);
    expect(scan(irIntrinsicFuncRef("__function_prototype_call"))).toBe(false);
    expect(scan(irRuntimeFuncRef("another-symbol", "__function_prototype_call"))).toBe(false);
  });
});
