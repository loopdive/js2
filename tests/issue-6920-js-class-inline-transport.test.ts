// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { asBlockId, asValueId, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import type { IrType } from "../src/ir/core/types.js";
import { inlineSmall } from "../src/ir/passes/inline-small.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import type { TypedIrProgramInput } from "../src/ir/program/input-contracts.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

// This is the complete input captured from the source helper-completion repair,
// before optimization, rather than a hand-authored successful prepared program.
// Its source, inventory, callable population, startup and allocations stay visible.
const fixture: {
  schema: string;
  sourceFiles: Record<string, string>;
  sourceVerifierErrors: unknown[];
  expectedJSThrown: number;
  input: TypedIrProgramInput;
} = JSON.parse(readFileSync(new URL("./fixtures/native-js-class-inline-transport.json", import.meta.url), "utf8"));
const identities = createTestIrFunctionIdentityFactory("issue-6920-inline-class-transport");
const dynamic: IrType = { kind: "dynamic" };
const capturedRun = fixture.input.ir.functions.find((fn) => fn.name === "run");
if (!capturedRun) throw new Error("genuine input lost run");
const capturedInvoke = capturedRun.blocks[0]!.instrs.find((instr) => instr.kind === "js.class.invoke");
if (!capturedInvoke || capturedInvoke.kind !== "js.class.invoke") throw new Error("genuine input lost class invoke");
const receiverType = capturedRun.blocks[0]!.instrs.find(
  (instr) => instr.result === capturedInvoke.receiver,
)?.resultType;
if (!receiverType) throw new Error("genuine input lost receiver definition");

function invokeIn(fn: IrFunction): Extract<IrInstr, { kind: "js.class.invoke" }> {
  const instr = fn.blocks.flatMap((block) => block.instrs).find((instr) => instr.kind === "js.class.invoke");
  if (!instr || instr.kind !== "js.class.invoke") throw new Error("class invoke did not survive inlining");
  return instr;
}

function wrapperModule(firstActual: IrType | undefined, firstExpected: IrType = dynamic) {
  const callee: IrFunction = {
    ...identities.next("wrapper"),
    params: [
      { name: "callable", value: asValueId(0), type: dynamic },
      { name: "receiver", value: asValueId(1), type: receiverType! },
      { name: "first", value: asValueId(2), type: firstExpected },
      { name: "second", value: asValueId(3), type: dynamic },
    ],
    resultTypes: [dynamic],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            ...capturedInvoke!,
            callable: asValueId(0),
            receiver: asValueId(1),
            args: [asValueId(2), asValueId(3)],
            signature: { params: [firstExpected, dynamic], result: dynamic },
            result: asValueId(4),
            resultType: dynamic,
          },
        ],
        terminator: { kind: "return", values: [asValueId(4)] },
      },
    ],
    exported: false,
    valueCount: 5,
  };
  // Parameter IDs intentionally coincide across the caller and callee. A real
  // substitution still occurs even when the numeric operand does not change.
  const caller: IrFunction = {
    ...identities.next("caller"),
    params: callee.params.flatMap((param, index) =>
      index === 2 ? (firstActual ? [{ ...param, type: firstActual }] : []) : [{ ...param }],
    ),
    resultTypes: [dynamic],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "call",
            target: irUnitFuncRef(callee),
            args: [asValueId(0), asValueId(1), asValueId(2), asValueId(3)],
            result: asValueId(4),
            resultType: dynamic,
          },
        ],
        terminator: { kind: "return", values: [asValueId(4)] },
      },
    ],
    exported: false,
    valueCount: 5,
  };
  return { callee, caller, module: { functions: [callee, caller] } };
}

describe("native class argument transport after actual inlining", () => {
  it("keeps the captured JavaScript argument-before-callability oracle", () => {
    expect(fixture.schema).toBe("genuine-native-js-class-inline-transport-input-v1");
    expect(Object.keys(fixture.sourceFiles)).toEqual(["./entry.ts"]);
    expect(fixture.sourceVerifierErrors).toEqual([]);
    const source = fixture.sourceFiles["./entry.ts"]!;
    expect(source).toContain("c.m=undefined;c.m(effect())");
    const javascript = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText;
    let thrown: unknown;
    try {
      runInNewContext(`${javascript}\nrun();`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(fixture.expectedJSThrown);
    expect(thrown).toBe(7);
  });

  it("inlines the genuine helper and follows its refined return, preserving the original input", () => {
    const module = {
      functions: fixture.input.ir.functions.filter((fn) => fn.name === "run" || fn.name === "effect"),
    };
    expect(module.functions).toHaveLength(2);
    for (const fn of module.functions) expect(verifyIrFunction(fn)).toEqual([]);
    const before = JSON.stringify(module);
    const original = module.functions.find((fn) => fn.name === "run")!;
    const originalInvoke = invokeIn(original);
    expect(originalInvoke.signature.params).toEqual([dynamic]);
    const registry = AllocSiteRegistry.fromSnapshot(fixture.input.allocations);
    const out = inlineSmall(module, registry);
    const actual = out.functions.find((fn) => fn.unitId === original.unitId)!;
    expect(actual).not.toBe(original);
    expect(actual.blocks.flatMap((block) => block.instrs).filter((instr) => instr.kind === "call")).toEqual([]);
    const invoke = invokeIn(actual);
    const definition = actual.blocks.flatMap((block) => block.instrs).find((instr) => instr.result === invoke.args[0]);
    expect(definition).toMatchObject({
      kind: "const",
      value: { kind: "undefined" },
    });
    expect(invoke.signature.params).toEqual([definition!.resultType]);
    expect(invoke.signature.params[0]).not.toEqual(dynamic);
    expect(invoke.signature.result).toEqual(originalInvoke.signature.result);
    expect(verifyIrFunction(actual)).toEqual([]);
    expect(JSON.stringify(module)).toBe(before);
  });

  for (const backend of ["wasmgc", "linear"] as const)
    for (const target of ["standalone", "wasi"] as const)
      it(`${backend}:${target} prepares and exactly round-trips the genuine complete input`, () => {
        const policy = { backend, target };
        const inputBefore = JSON.stringify(fixture.input);
        const result = prepareTypedIrProgram(fixture.input, {
          policy,
          runtimePolicies: [policy],
          controls: {
            gvnMode: "off",
            ownership: false,
            escape: false,
            verifyIntermediateAllocations: true,
            verifyDominanceNaive: true,
          },
        });
        expect(result.kind).toBe("prepared");
        if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
        const encoded = encodePreparedIrProgram(result.program);
        expect(encodePreparedIrProgram(decodePreparedIrProgram(encoded))).toBe(encoded);
        expect(JSON.stringify(fixture.input)).toBe(inputBefore);
      });

  it("updates a callee parameter transport even when substituted numeric SSA IDs coincide", () => {
    const actualType = fixture.input.ir.functions
      .find((fn) => fn.name === "effect")!
      .blocks[0]!.instrs.at(-1)!.resultType!;
    const { module, caller, callee } = wrapperModule(actualType);
    expect(verifyIrFunction(callee)).toEqual([]);
    const out = inlineSmall(module);
    const actual = out.functions.find((fn) => fn.unitId === caller.unitId)!;
    const invoke = invokeIn(actual);
    expect(invoke.args).toEqual([asValueId(2), asValueId(3)]);
    expect(invoke.signature.params).toEqual([actualType, dynamic]);
    expect(invoke.signature.result).toBe(dynamic);
    expect(invoke.callable).toBe(asValueId(0));
    expect(invoke.receiver).toBe(asValueId(1));
    expect(verifyIrFunction(actual)).toEqual([]);
  });

  it("uses actual block argument types during a callee substitution", () => {
    const actualType = fixture.input.ir.functions
      .find((fn) => fn.name === "effect")!
      .blocks[0]!.instrs.at(-1)!.resultType!;
    const { module, caller } = wrapperModule(actualType);
    const blockCaller: IrFunction = {
      ...caller,
      params: caller.params.filter((param) => param.value !== asValueId(2)),
      blocks: [
        {
          ...caller.blocks[0]!,
          blockArgs: [asValueId(2)],
          blockArgTypes: [actualType],
        },
      ],
    };
    const out = inlineSmall({
      ...module,
      functions: [module.functions[0]!, blockCaller],
    });
    expect(invokeIn(out.functions[1]!).signature.params).toEqual([actualType, dynamic]);
  });

  it("refuses a missing substituted value type", () => {
    const { module } = wrapperModule(undefined);
    expect(() => inlineSmall(module)).toThrow("class argument substitution contradicts its logical transport");
  });
  it("refuses a substitution that changes the boxed carrier", () => {
    const { module } = wrapperModule({ kind: "val", val: { kind: "f64" } });
    expect(() => inlineSmall(module)).toThrow("class argument substitution contradicts its logical transport");
  });
  it("refuses a substitution contradicting an already refined class signature", () => {
    const effect = fixture.input.ir.functions.find((fn) => fn.name === "effect")!;
    const numberType = effect.blocks[0]!.instrs.find((instr) => instr.kind === "box")!.resultType!;
    const undefinedType = effect.blocks[0]!.instrs.at(-1)!.resultType!;
    expect(numberType).not.toEqual(undefinedType);
    const { module } = wrapperModule(numberType, undefinedType);
    expect(() => inlineSmall(module)).toThrow("class argument substitution contradicts its logical transport");
  });
});
