// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { definedFuncAt, funcSignatureOf, nativeStrHelperHandle } from "../src/codegen/func-space.js";
import {
  ensureIrHostStringRepeatProvider,
  hasExactIrStringRepeatProviderAbi,
} from "../src/codegen/ir-host-string-repeat.js";
import {
  ensureIrNativeCountedStringRepeatProvider,
  ensureIrNativeStringRepeatProvider,
  hasExactIrNativeCountedStringRepeatProviderAbi,
  IR_NATIVE_STRING_REPEAT_MAX_RESULT_CODE_UNITS,
  IR_NATIVE_STRING_REPEAT_PROVIDER_FN,
  IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE,
} from "../src/codegen/ir-native-string-repeat.js";
import { addRuntime } from "../src/codegen-linear/runtime.js";
import {
  authenticateLinearStringRepeatProvider,
  reserveLinearStringRepeatProvider,
} from "../src/codegen-linear/string-repeat.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { asAsyncStateId, canonicalPromiseAbi, type IrAsyncPlan } from "../src/ir/async-plan.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irIntrinsicFuncRef } from "../src/ir/callable-bindings.js";
import { createIrCountedStringAppendSiteId } from "../src/ir/counted-string-append-provenance.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import { digestIrInstructions } from "../src/ir/instruction-digest.js";
import { emitBinary } from "../src/emit/binary.js";
import { effectsOf, isSideEffecting } from "../src/ir/effects.js";
import { lowerIrFunctionBody, wasmValueTypeConverter, type IrLowerResolver } from "../src/ir/lower.js";
import { irVal, type IrFunction, type IrInstr, type IrType } from "../src/ir/nodes.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { renameInstrOperands } from "../src/ir/passes/inline-small.js";
import { attachIrStringSupport } from "../src/ir/string-support.js";
import {
  IR_COUNTED_STRING_REPEAT_I32_MAX,
  IR_STRING_REPEAT_COUNTED_NATIVE_FN,
  IR_STRING_REPEAT_FN,
  repeatString,
} from "../src/ir/string-runtime.js";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3518-string-repeat-ir");
const STRING: IrType = { kind: "string" };
const F64: IrType = irVal({ kind: "f64" });

function repeatFunction(
  encodingEvidence: "ascii" | "utf8-guaranteed" | "wtf16" = "ascii",
  withCountedSite = false,
): IrFunction {
  const registry = new AllocSiteRegistry();
  const identity = identities.next(`repeat-${encodingEvidence}`);
  const builder = new IrFunctionBuilder(identity, [STRING], false, registry);
  const value = builder.addParam("value", STRING);
  const count = builder.addParam("count", F64);
  builder.openBlock();
  const countedStringAppendSite = withCountedSite
    ? createIrCountedStringAppendSiteId({
        sourceId: identities.sourceId,
        ownerUnitId: identity.unitId,
        loopStart: 17,
        loopEnd: 43,
      })
    : undefined;
  const result = builder.emitStringRepeat(value, count, encodingEvidence, countedStringAppendSite);
  builder.terminate({ kind: "return", values: [result] });
  return attachIrStringSupport(builder.finish(), {
    storageForConst: () => undefined,
    providerForLength: () => undefined,
  });
}

function repeatNode(fn: IrFunction): Extract<IrInstr, { kind: "string.repeat" }> {
  const instruction = fn.blocks[0]!.instrs.find(
    (candidate): candidate is Extract<IrInstr, { kind: "string.repeat" }> => candidate.kind === "string.repeat",
  );
  if (!instruction) throw new Error("fixture lost string.repeat");
  return instruction;
}

function exactCountedRepeatFunction(tripCount = 3, proof = tripCount): IrFunction {
  const registry = new AllocSiteRegistry();
  const identity = identities.next(`counted-repeat-${tripCount}-${proof}`);
  const builder = new IrFunctionBuilder(identity, [STRING], false, registry);
  builder.addParam("dynamicValue", STRING);
  builder.openBlock();
  const value = builder.emitStringConst("ab");
  const count = builder.emitConst({ kind: "f64", value: tripCount }, F64);
  const site = createIrCountedStringAppendSiteId({
    sourceId: identities.sourceId,
    ownerUnitId: identity.unitId,
    loopStart: 17,
    loopEnd: 43,
  });
  const result = builder.emitStringRepeat(value, count, "ascii", site, proof);
  builder.terminate({ kind: "return", values: [result] });
  return attachIrStringSupport(builder.finish(), {
    storageForConst: () => undefined,
    providerForLength: () => undefined,
    providerForRepeat: () => irIntrinsicFuncRef(IR_STRING_REPEAT_COUNTED_NATIVE_FN),
  });
}

function resolver(stringType: ValType, callIndex: number): IrLowerResolver {
  return {
    resolveFunc: (ref) => {
      if (ref.binding.kind !== "intrinsic" || ref.binding.symbol !== IR_STRING_REPEAT_FN) {
        throw new Error("unexpected callable");
      }
      return callIndex;
    },
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
    resolveString: () => stringType,
    emitStringRepeat: (_alloc, _encoding, provider): readonly Instr[] => {
      if (!provider) throw new Error("missing repeat provider");
      return [{ op: "call", funcIdx: callIndex }];
    },
  };
}

function addNativeRepeatProbe(
  ctx: ReturnType<typeof createCodegenContext>,
  providerIndex: number,
  name: string,
  codeUnits: readonly number[],
): void {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "func", params: [{ kind: "f64" }], results: [{ kind: "i32" }] });
  const functionIndex = ctx.mod.imports.filter((entry) => entry.desc.kind === "func").length + ctx.mod.functions.length;
  const body: Instr[] = [
    { op: "i32.const", value: codeUnits.length },
    { op: "i32.const", value: 0 },
    ...codeUnits.map((value) => ({ op: "i32.const", value }) as Instr),
    { op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: codeUnits.length },
    { op: "struct.new", typeIdx: ctx.nativeStrTypeIdx },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: providerIndex },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
  ];
  ctx.mod.functions.push({ name, typeIdx, locals: [], body, exported: true });
  ctx.mod.exports.push({ name, desc: { kind: "func", index: functionIndex } });
}

describe("#3518 Transaction B — typed string.repeat foundation", () => {
  it("defines full ToIntegerOrInfinity repeat semantics, including throwing counts", () => {
    expect(repeatString("ab", Number.NaN)).toBe("");
    expect(repeatString("ab", -0)).toBe("");
    expect(repeatString("ab", -0.5)).toBe("");
    expect(repeatString("ab", 1.9)).toBe("ab");
    expect(repeatString("ab", 3)).toBe("ababab");
    expect(() => repeatString("", -1)).toThrow(RangeError);
    expect(() => repeatString("ab", -Infinity)).toThrow(RangeError);
    expect(() => repeatString("ab", Infinity)).toThrow(RangeError);
  });

  it("builds verifier-clean allocation/provider evidence and rejects tampering", () => {
    const fn = repeatFunction("ascii", true);
    const node = repeatNode(fn);
    expect(node).toMatchObject({
      kind: "string.repeat",
      encodingEvidence: "ascii",
      provider: irIntrinsicFuncRef(IR_STRING_REPEAT_FN),
      resultType: STRING,
    });
    expect(node.alloc).toBeDefined();
    expect(node.countedStringAppendSite).toBeDefined();
    expect(verifyIrFunction(fn)).toEqual([]);

    const wrongCount: IrFunction = {
      ...fn,
      blocks: [{ ...fn.blocks[0]!, instrs: [{ ...node, count: node.value }] }],
    };
    expect(verifyIrFunction(wrongCount).some((error) => /count.*f64/.test(error.message))).toBe(true);
    const wrongProvider: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [{ ...node, provider: irIntrinsicFuncRef("__tampered_repeat_provider") }],
        },
      ],
    };
    expect(verifyIrFunction(wrongProvider).some((error) => /canonical.*provider/.test(error.message))).toBe(true);

    const malformedSite: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [
            {
              ...node,
              countedStringAppendSite: `${node.countedStringAppendSite}:suffix` as NonNullable<
                typeof node.countedStringAppendSite
              >,
            },
          ],
        },
      ],
    };
    expect(verifyIrFunction(malformedSite).some((error) => /malformed or foreign-owner/.test(error.message))).toBe(
      true,
    );

    const foreignIdentity = identities.next("foreign-repeat-owner");
    const foreignSite = createIrCountedStringAppendSiteId({
      sourceId: identities.sourceId,
      ownerUnitId: foreignIdentity.unitId,
      loopStart: 17,
      loopEnd: 43,
    });
    const foreignOwnerSite: IrFunction = {
      ...fn,
      blocks: [{ ...fn.blocks[0]!, instrs: [{ ...node, countedStringAppendSite: foreignSite }] }],
    };
    expect(verifyIrFunction(foreignOwnerSite).some((error) => /malformed or foreign-owner/.test(error.message))).toBe(
      true,
    );
  });

  it("authenticates the exact counted-native trip proof and rejects every mismatch", () => {
    const fn = exactCountedRepeatFunction();
    const node = repeatNode(fn);
    expect(node).toMatchObject({
      countedStringAppendTripCount: 3,
      provider: irIntrinsicFuncRef(IR_STRING_REPEAT_COUNTED_NATIVE_FN),
    });
    expect(verifyIrFunction(fn)).toEqual([]);

    const mutate = (replacement: Partial<typeof node>): IrFunction => ({
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: fn.blocks[0]!.instrs.map((instruction) =>
            instruction.kind === "string.repeat" ? { ...instruction, ...replacement } : instruction,
          ),
        },
      ],
    });
    expect(
      verifyIrFunction(mutate({ countedStringAppendTripCount: 4 })).some((error) =>
        /does not match.*f64/.test(error.message),
      ),
    ).toBe(true);
    expect(
      verifyIrFunction(mutate({ countedStringAppendTripCount: 1 })).some((error) =>
        /invalid counted trip-count/.test(error.message),
      ),
    ).toBe(true);
    expect(
      verifyIrFunction(mutate({ countedStringAppendTripCount: IR_COUNTED_STRING_REPEAT_I32_MAX + 1 })).some((error) =>
        /invalid counted trip-count/.test(error.message),
      ),
    ).toBe(true);
    expect(
      verifyIrFunction(mutate({ countedStringAppendSite: undefined })).some((error) =>
        /requires counted-loop provenance/.test(error.message),
      ),
    ).toBe(true);
    expect(
      verifyIrFunction(mutate({ countedStringAppendTripCount: undefined })).some((error) =>
        /provider requires.*proof/.test(error.message),
      ),
    ).toBe(true);
    expect(
      verifyIrFunction(mutate({ value: fn.params[0]!.value })).some((error) =>
        /requires an exact string\.const/.test(error.message),
      ),
    ).toBe(true);
    expect(
      verifyIrFunction(exactCountedRepeatFunction(0x2000_0001)).some((error) =>
        /result-length bound/.test(error.message),
      ),
    ).toBe(true);
  });

  it("authenticates counted provenance inside semantic async state bodies", () => {
    const base = repeatFunction("ascii", true);
    const node = repeatNode(base);
    if (node.result === null) throw new Error("fixture lost string.repeat result");
    const repeatResult = node.result;
    const stateId = asAsyncStateId(0);
    const asyncPlan: IrAsyncPlan = {
      schemaVersion: 1,
      ownerUnitId: base.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(STRING),
      entry: stateId,
      params: base.params.map(({ value, type }) => ({ value, type })),
      values: [...base.params.map(({ value, type }) => ({ value, type })), { value: repeatResult, type: STRING }],
      spills: [],
      states: [{ id: stateId, body: [node], terminator: { kind: "resolve", value: repeatResult } }],
      handlers: [],
      runtimeIntents: ["promise.capability.create", "promise.settle.fulfill"],
    };
    const asyncFn: IrFunction = {
      ...base,
      funcKind: "async",
      blocks: [
        {
          ...base.blocks[0]!,
          instrs: [],
          terminator: { kind: "unreachable" },
        },
      ],
      asyncPlan,
    };
    expect(verifyIrFunction(asyncFn)).toEqual([]);

    const foreignIdentity = identities.next("async-foreign-repeat-owner");
    const foreignSite = createIrCountedStringAppendSiteId({
      sourceId: identities.sourceId,
      ownerUnitId: foreignIdentity.unitId,
      loopStart: 17,
      loopEnd: 43,
    });
    for (const countedStringAppendSite of [
      `${node.countedStringAppendSite}:suffix` as NonNullable<typeof node.countedStringAppendSite>,
      foreignSite,
    ]) {
      const tampered: IrFunction = {
        ...asyncFn,
        asyncPlan: {
          ...asyncPlan,
          states: [
            {
              ...asyncPlan.states[0]!,
              body: [{ ...node, countedStringAppendSite }],
            },
          ],
        },
      };
      expect(
        verifyIrFunction(tampered).some((error) =>
          /malformed or foreign-owner counted-string provenance/.test(error.message),
        ),
      ).toBe(true);
    }

    const runtimeTampered: IrFunction = {
      ...asyncFn,
      asyncRuntime: {
        kind: "standalone-native-wasmgc",
        adapters: [],
        states: [
          {
            ...asyncPlan.states[0]!,
            body: [{ ...node, countedStringAppendSite: foreignSite }],
          },
        ],
      },
    };
    expect(
      verifyIrFunction(runtimeTampered).some((error) =>
        /^asyncRuntime state 0: string\.repeat carries malformed or foreign-owner counted-string provenance$/.test(
          error.message,
        ),
      ),
    ).toBe(true);
  });

  it("is never DCE'd or reordered as a pure allocation", () => {
    const registry = new AllocSiteRegistry();
    const builder = new IrFunctionBuilder(identities.next("unused-repeat"), [], false, registry);
    const value = builder.addParam("value", STRING);
    const count = builder.addParam("count", F64);
    builder.openBlock();
    builder.emitRawWasm([{ op: "i32.const", value: 101 }, { op: "drop" }], 0);
    builder.emitStringRepeat(value, count, "ascii");
    builder.emitRawWasm([{ op: "i32.const", value: 202 }, { op: "drop" }], 0);
    builder.terminate({ kind: "return", values: [] });
    const fn = builder.finish();
    const node = fn.blocks[0]!.instrs.find(
      (instruction): instruction is Extract<IrInstr, { kind: "string.repeat" }> => instruction.kind === "string.repeat",
    )!;
    const after = deadCode(fn, registry);
    expect(after).toBe(fn);
    expect(after.blocks[0]!.instrs.some((instruction) => instruction.kind === "string.repeat")).toBe(true);
    expect(isSideEffecting(node)).toBe(true);
    expect(effectsOf(node)).toMatchObject({ readsHeap: true, writesHeap: true, control: true });

    const prepared = attachIrStringSupport(after, {
      storageForConst: () => undefined,
      providerForLength: () => undefined,
    });
    const gcResolver = resolver({ kind: "externref" }, 71);
    const lowered = lowerIrFunctionBody(
      prepared,
      gcResolver,
      new WasmGcEmitter(gcResolver),
      wasmValueTypeConverter("wasmgc", gcResolver, prepared.name),
    ).body;
    const beforeIndex = lowered.findIndex((instruction) => instruction.op === "i32.const" && instruction.value === 101);
    const repeatIndex = lowered.findIndex((instruction) => instruction.op === "call" && instruction.funcIdx === 71);
    const afterIndex = lowered.findIndex((instruction) => instruction.op === "i32.const" && instruction.value === 202);
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(repeatIndex).toBeGreaterThan(beforeIndex);
    expect(afterIndex).toBeGreaterThan(repeatIndex);
  });

  it("preserves provider/evidence through cloning and detects every semantic digest tamper", () => {
    const fn = repeatFunction("ascii", true);
    const node = repeatNode(fn);
    const renamed = renameInstrOperands(node, new Map([[node.value, node.count]]));
    expect(renamed).toMatchObject({
      kind: "string.repeat",
      value: node.count,
      count: node.count,
      provider: node.provider,
      encodingEvidence: node.encodingEvidence,
      alloc: node.alloc,
      countedStringAppendSite: node.countedStringAppendSite,
    });

    const unpreparedNested = { ...node, provider: undefined };
    const nestedFn: IrFunction = {
      ...fn,
      resultTypes: [],
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [
            {
              kind: "if.stmt",
              cond: node.count,
              then: [unpreparedNested],
              else: [],
              result: null,
              resultType: null,
            },
          ],
          terminator: { kind: "return", values: [] },
        },
      ],
    };
    const preparedNested = attachIrStringSupport(nestedFn, {
      storageForConst: () => undefined,
      providerForLength: () => undefined,
    });
    const conditional = preparedNested.blocks[0]!.instrs[0]!;
    expect(conditional.kind).toBe("if.stmt");
    if (conditional.kind !== "if.stmt") throw new Error("fixture lost nested string.repeat");
    expect(conditional.then[0]).toMatchObject({
      kind: "string.repeat",
      provider: node.provider,
      countedStringAppendSite: node.countedStringAppendSite,
    });

    const changedSite = createIrCountedStringAppendSiteId({
      sourceId: identities.sourceId,
      ownerUnitId: fn.unitId,
      loopStart: 18,
      loopEnd: 44,
    });
    const foreignIdentity = identities.next("digest-foreign-owner");
    const borrowedSite = createIrCountedStringAppendSiteId({
      sourceId: identities.sourceId,
      ownerUnitId: foreignIdentity.unitId,
      loopStart: 17,
      loopEnd: 43,
    });
    const digest = digestIrInstructions([node]);
    for (const tampered of [
      { ...node, count: node.value },
      { ...node, encodingEvidence: "wtf16" as const },
      { ...node, provider: irIntrinsicFuncRef("__tampered_repeat_provider") },
      { ...node, alloc: undefined },
      { ...node, countedStringAppendSite: undefined },
      { ...node, countedStringAppendSite: changedSite },
      { ...node, countedStringAppendSite: borrowedSite },
    ]) {
      expect(digestIrInstructions([tampered])).not.toBe(digest);
    }
  });

  it("lowers the same prepared node through WasmGC and authenticated-ASCII linear emitters", () => {
    const fn = repeatFunction("ascii");
    const gcResolver = resolver({ kind: "externref" }, 17);
    const linearResolver = resolver({ kind: "i32" }, 23);
    const gc = lowerIrFunctionBody(
      fn,
      gcResolver,
      new WasmGcEmitter(gcResolver),
      wasmValueTypeConverter("wasmgc", gcResolver, fn.name),
    ).body;
    const linear = lowerIrFunctionBody(
      fn,
      linearResolver,
      new LinearEmitter({ stringRuntime: linearResolver }),
      wasmValueTypeConverter("linear", linearResolver, fn.name),
    ).body;
    expect(gc).toContainEqual({ op: "call", funcIdx: 17 });
    expect(linear).toContainEqual({ op: "call", funcIdx: 23 });
    expect(verifyIrBackendLegality(fn, "wasmgc")).toEqual([]);
    expect(verifyIrBackendLegality(fn, "linear")).toEqual([]);
    expect(verifyIrBackendLegality(repeatFunction("utf8-guaranteed"), "linear")[0]?.message).toMatch(
      /authenticated ASCII evidence/,
    );
    expect(verifyIrBackendLegality(fn, "bytecode").some((error) => /string\.repeat/.test(error.message))).toBe(true);
    expect(verifyIrBackendLegality(fn, "porffor").some((error) => /string\.repeat/.test(error.message))).toBe(true);
  });

  it("registers the exact host ABI and refuses signature tampering", () => {
    const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {});
    const index = ensureIrHostStringRepeatProvider(ctx);
    expect(ctx.mod.imports).toContainEqual(
      expect.objectContaining({
        module: "env",
        name: "string_repeat",
        desc: expect.objectContaining({ kind: "func" }),
      }),
    );
    expect(funcSignatureOf(ctx, index)).toMatchObject({
      params: [{ kind: "externref" }, { kind: "f64" }],
      results: [{ kind: "externref" }],
    });
    expect(hasExactIrStringRepeatProviderAbi(ctx, index)).toBe(true);
    const signature = funcSignatureOf(ctx, index)!;
    signature.params[1] = { kind: "i32" };
    expect(hasExactIrStringRepeatProviderAbi(ctx, index)).toBe(false);
    expect(() => ensureIrHostStringRepeatProvider(ctx)).toThrow(/exact env\.string_repeat import/);
  });

  it("executes host repeat through the compiled adapter manifest", async () => {
    // Load the public compiler only after the leaf provider modules above have
    // settled; eager co-import creates the repository's collections cycle.
    const { buildCompiledImports, compile } = await import("../src/index.js");
    const result = await compile(
      `export function repeat(value: string, count: number): string { return value.repeat(count); }`,
      { fileName: "issue-3518-host-repeat.ts", experimentalIR: false },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toContainEqual(
      expect.objectContaining({
        module: "env",
        name: "string_repeat",
        kind: "func",
        paramCount: 2,
        intent: { type: "string_method", method: "repeat" },
      }),
    );
    const imports = buildCompiledImports(result);
    expect(typeof imports.env.string_repeat).toBe("function");
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const repeat = instance.exports.repeat as (value: string, count: number) => string;
    expect(repeat("a", -0.5)).toBe("");
    expect(repeat("a", Number.NaN)).toBe("");
    expect(repeat("a", -0)).toBe("");
    expect(repeat("a", 0)).toBe("");
    expect(repeat("a", 1)).toBe("a");
    expect(repeat("a", 1.9)).toBe("a");
    expect(() => repeat("a", -1)).toThrow(RangeError);
    expect(() => repeat("a", -Infinity)).toThrow(RangeError);
    expect(() => repeat("a", Infinity)).toThrow(RangeError);
    expect(() => repeat("", -1)).toThrow(RangeError);
    expect(repeat("", Number.MAX_SAFE_INTEGER)).toBe("");
    expect(() => repeat("a", Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it("executes a native f64 adapter whose validation precedes empty and kernel paths", async () => {
    // Self-hosted native helpers need the expression delegates. Register them
    // only after the leaf provider graph has settled to avoid its known cycle.
    await import("../src/codegen/expressions.js");
    const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {
      target: "standalone",
      nativeStrings: true,
    });
    const index = ensureIrNativeStringRepeatProvider(ctx);
    const provider = definedFuncAt(ctx, index);
    const kernel = nativeStrHelperHandle(ctx, "__str_repeat");
    expect(provider?.name).toBe(IR_NATIVE_STRING_REPEAT_PROVIDER_FN);
    expect(funcSignatureOf(ctx, index)).toMatchObject({
      params: [{ kind: "ref_null", typeIdx: ctx.anyStrTypeIdx }, { kind: "f64" }],
      results: [{ kind: "ref_null", typeIdx: ctx.anyStrTypeIdx }],
    });
    const conditionals = provider!.body.filter(
      (instruction): instruction is Extract<Instr, { op: "if" }> => instruction.op === "if",
    );
    expect(conditionals).toHaveLength(4);
    expect(conditionals[0]!.then.at(-1)?.op).toBe("throw");
    expect(conditionals[1]!.then.at(-1)).toEqual({ op: "local.set", index: 2 });
    expect(conditionals[2]!.then.at(-1)?.op).toBe("return");
    expect(conditionals[3]!.then.at(-1)?.op).toBe("throw");
    expect(provider!.body.at(-1)).toEqual({ op: "call", funcIdx: kernel });
    expect(provider!.body).toContainEqual({
      op: "f64.const",
      value: IR_NATIVE_STRING_REPEAT_MAX_RESULT_CODE_UNITS,
    });
    expect(provider!.body.some((instruction) => instruction.op === "i32.trunc_sat_f64_s")).toBe(false);
    expect(provider!.body).toContainEqual({ op: "i32.trunc_f64_s" });

    // These cases are decided by the first validation branch, before the
    // empty-receiver branch or the raw i32 kernel can observe the receiver.
    for (const count of [-1, -Infinity, Infinity]) {
      const integer = Math.trunc(count);
      expect(integer < 0 || count === Infinity).toBe(true);
    }
    for (const count of [-0.5, Number.NaN, -0, 0, 1, 1.9]) {
      const integer = Math.trunc(count);
      expect(integer < 0 || count === Infinity).toBe(false);
    }
    // After NaN normalization, the empty branch returns before the f64 result
    // bound; the final guard protects only non-empty i32 rope construction.
    expect(IR_NATIVE_STRING_REPEAT_MAX_RESULT_CODE_UNITS).toBe(0x40000000);

    addNativeRepeatProbe(ctx, index, "repeat_nonempty", ["a".charCodeAt(0)]);
    addNativeRepeatProbe(ctx, index, "repeat_empty", []);
    expect(ctx.mod.imports).toEqual([]);
    widenNonDefaultableTypes(ctx.mod);
    const { instance } = await WebAssembly.instantiate(emitBinary(ctx.mod));
    const nonempty = instance.exports.repeat_nonempty as (count: number) => number;
    const empty = instance.exports.repeat_empty as (count: number) => number;
    expect(nonempty(-0.5)).toBe(0);
    expect(nonempty(Number.NaN)).toBe(0);
    expect(nonempty(-0)).toBe(0);
    expect(nonempty(0)).toBe(0);
    expect(nonempty(1)).toBe(1);
    expect(nonempty(1.9)).toBe(1);
    expect(() => nonempty(-1)).toThrow();
    expect(() => nonempty(-Infinity)).toThrow();
    expect(() => nonempty(Infinity)).toThrow();
    expect(() => empty(-1)).toThrow();
    expect(empty(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(() => nonempty(Number.MAX_SAFE_INTEGER)).toThrow();

    const signature = funcSignatureOf(ctx, index)!;
    signature.params[1] = { kind: "i32" };
    expect(() => ensureIrNativeStringRepeatProvider(ctx)).toThrow(/lost its exact ABI/);
  });

  it("reuses the exact native i32 kernel for authenticated counted repeats", async () => {
    await import("../src/codegen/expressions.js");
    const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {
      target: "standalone",
      nativeStrings: true,
    });
    const index = ensureIrNativeCountedStringRepeatProvider(ctx);
    expect(index).toBe(nativeStrHelperHandle(ctx, "__str_repeat"));
    expect(hasExactIrNativeCountedStringRepeatProviderAbi(ctx, index)).toBe(true);
    expect(funcSignatureOf(ctx, index)).toMatchObject({
      params: [{ kind: "ref", typeIdx: ctx.anyStrTypeIdx }, { kind: "i32" }],
      results: [{ kind: "ref", typeIdx: ctx.anyStrTypeIdx }],
    });
    expect(ctx.mod.functions.some((fn) => fn.name === IR_NATIVE_STRING_REPEAT_PROVIDER_FN)).toBe(false);
    expect(ctx.mod.stringPool).toContain(IR_NATIVE_STRING_REPEAT_RANGE_ERROR_MESSAGE);

    const signature = funcSignatureOf(ctx, index)!;
    signature.params[1] = { kind: "f64" };
    expect(hasExactIrNativeCountedStringRepeatProviderAbi(ctx, index)).toBe(false);
    expect(() => ensureIrNativeCountedStringRepeatProvider(ctx)).toThrow(/malformed __str_repeat ABI/);
  });

  it("executes the reserved linear provider with validation before empty handling", async () => {
    const module = createEmptyModule();
    addRuntime(module);
    const reservation = reserveLinearStringRepeatProvider(module);
    const index = authenticateLinearStringRepeatProvider(module, reservation);
    const importCount = module.imports.filter((entry) => entry.desc.kind === "func").length;
    expect(module.functions[index - importCount]).toBe(reservation.provider);
    expect(reserveLinearStringRepeatProvider(module)).toBe(reservation);

    module.exports.push({ name: "repeat", desc: { kind: "func", index } });
    const { instance } = await WebAssembly.instantiate(emitBinary(module));
    const memory = instance.exports.memory as WebAssembly.Memory;
    const repeat = instance.exports.repeat as (value: number, count: number) => number;
    const view = new DataView(memory.buffer);
    const source = 64;
    view.setUint32(source + 4, 1, true);
    view.setUint32(source + 8, 1, true);
    view.setUint8(source + 12, "a".charCodeAt(0));
    const empty = 96;
    view.setUint32(empty + 4, 0, true);
    view.setUint32(empty + 8, 0, true);

    const returnedLength = (count: number): number => view.getUint32(repeat(source, count) + 8, true);
    expect(returnedLength(-0.5)).toBe(0);
    expect(returnedLength(Number.NaN)).toBe(0);
    expect(returnedLength(-0)).toBe(0);
    expect(returnedLength(0)).toBe(0);
    expect(repeat(source, 1)).toBe(source);
    expect(repeat(source, 1.9)).toBe(source);
    expect(() => repeat(source, -1)).toThrow(WebAssembly.RuntimeError);
    expect(() => repeat(source, -Infinity)).toThrow(WebAssembly.RuntimeError);
    expect(() => repeat(source, Infinity)).toThrow(WebAssembly.RuntimeError);
    expect(() => repeat(empty, -1)).toThrow(WebAssembly.RuntimeError);
    expect(repeat(empty, Number.MAX_SAFE_INTEGER)).toBe(empty);
    expect(() => repeat(source, Number.MAX_SAFE_INTEGER)).toThrow(WebAssembly.RuntimeError);

    const signature = module.types[reservation.provider.typeIdx];
    if (!signature || signature.kind !== "func") throw new Error("fixture lost repeat signature");
    signature.params[1] = { kind: "i32" };
    expect(() => authenticateLinearStringRepeatProvider(module, reservation)).toThrow(/exact provider ABI/);
  });
});
