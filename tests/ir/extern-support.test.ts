// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { type IrAsyncPlan, type IrAsyncState, asAsyncStateId, canonicalPromiseAbi } from "../../src/ir/async-plan.js";
import { irImportFuncRef } from "../../src/ir/callable-bindings.js";
import { attachIrExternSupport, irExternCallableProviderRef } from "../../src/ir/extern-support.js";
import {
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrValueId,
  asBlockId,
  asValueId,
  irVal,
} from "../../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "../helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("ir/extern-support");

function value(index: number): IrValueId {
  return asValueId(index);
}

function functionWith(instrs: readonly IrInstr[]): IrFunction {
  return {
    ...identities.next("f"),
    params: [],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: 8,
  };
}

const EXTERN_CASES = [
  {
    label: "constructor",
    expectedField: "Intl_ListFormat_new",
    instr: {
      kind: "extern.new",
      className: "ListFormat",
      importPrefix: "Intl_ListFormat",
      args: [],
      result: value(0),
      resultType: { kind: "extern", className: "ListFormat" },
    },
  },
  {
    label: "method",
    expectedField: "Document_createElement",
    instr: {
      kind: "extern.call",
      className: "Document",
      method: "createElement",
      receiver: value(0),
      args: [value(1)],
      result: value(2),
      resultType: { kind: "extern", className: "HTMLElement" },
    },
  },
  {
    label: "property read",
    expectedField: "HTMLElement_get_style",
    instr: {
      kind: "extern.prop",
      className: "HTMLElement",
      property: "style",
      receiver: value(0),
      result: value(1),
      resultType: { kind: "extern", className: "CSSStyleDeclaration" },
    },
  },
  {
    label: "property write",
    expectedField: "CSSStyleDeclaration_set_cssText",
    instr: {
      kind: "extern.propSet",
      className: "CSSStyleDeclaration",
      property: "cssText",
      receiver: value(0),
      value: value(1),
      result: null,
      resultType: null,
    },
  },
] as const satisfies readonly {
  label: string;
  expectedField: string;
  instr: IrInstr;
}[];

describe("prepared extern support", () => {
  it.each(EXTERN_CASES)("derives the exact env import for $label", ({ instr, expectedField }) => {
    expect(irExternCallableProviderRef(instr)).toEqual(
      expect.objectContaining({
        kind: "func",
        name: expectedField,
        binding: { kind: "import", module: "env", field: expectedField },
      }),
    );
  });

  it("attaches every exact provider and preserves object identity at the fixpoint", () => {
    const originalInstrs = EXTERN_CASES.map(({ instr }) => instr);
    const original = functionWith(originalInstrs);

    const attached = attachIrExternSupport(original);
    expect(attached).not.toBe(original);
    expect(attached.blocks[0]).not.toBe(original.blocks[0]);
    expect(attached.blocks[0]!.instrs).not.toBe(original.blocks[0]!.instrs);
    expect(
      attached.blocks[0]!.instrs.map((instr) =>
        "provider" in instr && instr.provider?.binding.kind === "import" ? instr.provider.binding.field : undefined,
      ),
    ).toEqual(EXTERN_CASES.map(({ expectedField }) => expectedField));
    expect(originalInstrs.every((instr) => !("provider" in instr) || instr.provider === undefined)).toBe(true);

    const attachedAgain = attachIrExternSupport(attached);
    expect(attachedAgain).toBe(attached);
    expect(attachedAgain.blocks[0]).toBe(attached.blocks[0]);
    expect(attachedAgain.blocks[0]!.instrs).toBe(attached.blocks[0]!.instrs);
  });

  it("walks nested instruction buffers", () => {
    const nestedCall = EXTERN_CASES[1].instr;
    const nestedWrite = EXTERN_CASES[3].instr;
    const conditional: IrInstr = {
      kind: "if.stmt",
      cond: value(7),
      then: [nestedCall],
      else: [nestedWrite],
      result: null,
      resultType: null,
    };
    const original = functionWith([conditional]);

    const attached = attachIrExternSupport(original);
    const rewritten = attached.blocks[0]!.instrs[0]!;
    expect(rewritten.kind).toBe("if.stmt");
    if (rewritten.kind !== "if.stmt") throw new Error("expected if.stmt fixture");
    expect(rewritten.then[0]).toMatchObject({
      kind: "extern.call",
      provider: {
        binding: {
          kind: "import",
          module: "env",
          field: "Document_createElement",
        },
      },
    });
    expect(rewritten.else[0]).toMatchObject({
      kind: "extern.propSet",
      provider: {
        binding: {
          kind: "import",
          module: "env",
          field: "CSSStyleDeclaration_set_cssText",
        },
      },
    });
    expect(rewritten.then[0]).not.toBe(nestedCall);
    expect(rewritten.else[0]).not.toBe(nestedWrite);
  });

  it("attaches only prepared async runtime states and preserves the logical plan", () => {
    const base = functionWith([]);
    const f64: IrType = irVal({ kind: "f64" });
    const logicalInstr: IrInstr = {
      kind: "const",
      value: { kind: "f64", value: 1 },
      result: value(6),
      resultType: f64,
    };
    const logicalBody = [logicalInstr] as const;
    const logicalState: IrAsyncState = {
      id: asAsyncStateId(0),
      body: logicalBody,
      terminator: { kind: "complete" },
    };
    const logicalStates = [logicalState] as const;
    const asyncPlan: IrAsyncPlan = {
      schemaVersion: 1,
      ownerUnitId: base.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(null),
      entry: logicalState.id,
      params: [],
      values: [{ value: value(6), type: f64 }],
      spills: [],
      states: logicalStates,
      handlers: [],
      runtimeIntents: [],
    };

    const runtimeNew = EXTERN_CASES[0].instr;
    const runtimeCall = EXTERN_CASES[1].instr;
    const runtimeWrite = EXTERN_CASES[3].instr;
    const nestedRuntime: IrInstr = {
      kind: "if.stmt",
      cond: value(7),
      then: [runtimeCall],
      else: [runtimeWrite],
      result: null,
      resultType: null,
    };
    const runtimeState0: IrAsyncState = {
      id: asAsyncStateId(0),
      body: [runtimeNew],
      terminator: { kind: "goto", target: asAsyncStateId(1) },
    };
    const runtimeState1: IrAsyncState = {
      id: asAsyncStateId(1),
      body: [nestedRuntime],
      terminator: { kind: "complete" },
    };
    const runtimeStates = [runtimeState0, runtimeState1] as const;
    const asyncRuntime = {
      kind: "host-wasmgc" as const,
      adapters: [],
      states: runtimeStates,
    };
    const original: IrFunction = { ...base, asyncPlan, asyncRuntime };

    const attached = attachIrExternSupport(original);
    expect(attached).not.toBe(original);
    expect(attached.blocks).toBe(original.blocks);
    expect(attached.asyncPlan).toBe(asyncPlan);
    expect(attached.asyncPlan!.states).toBe(logicalStates);
    expect(attached.asyncPlan!.states[0]).toBe(logicalState);
    expect(attached.asyncPlan!.states[0]!.body).toBe(logicalBody);
    expect(attached.asyncPlan!.states[0]!.body[0]).toBe(logicalInstr);
    expect(attached.asyncPlan!.states[0]!.body[0]).toEqual(logicalInstr);

    const attachedRuntime = attached.asyncRuntime!;
    expect(attachedRuntime).not.toBe(asyncRuntime);
    expect(attachedRuntime.states).not.toBe(runtimeStates);
    expect(attachedRuntime.states[0]).not.toBe(runtimeState0);
    expect(attachedRuntime.states[0]!.body).not.toBe(runtimeState0.body);
    expect(attachedRuntime.states[0]!.body[0]).toMatchObject({
      kind: "extern.new",
      provider: {
        binding: {
          kind: "import",
          module: "env",
          field: "Intl_ListFormat_new",
        },
      },
    });
    expect(attachedRuntime.states[1]).not.toBe(runtimeState1);
    expect(attachedRuntime.states[1]!.body).not.toBe(runtimeState1.body);
    const rewrittenNested = attachedRuntime.states[1]!.body[0]!;
    expect(rewrittenNested.kind).toBe("if.stmt");
    if (rewrittenNested.kind !== "if.stmt") throw new Error("expected if.stmt runtime fixture");
    expect(rewrittenNested.then[0]).toMatchObject({
      kind: "extern.call",
      provider: {
        binding: {
          kind: "import",
          module: "env",
          field: "Document_createElement",
        },
      },
    });
    expect(rewrittenNested.else[0]).toMatchObject({
      kind: "extern.propSet",
      provider: {
        binding: {
          kind: "import",
          module: "env",
          field: "CSSStyleDeclaration_set_cssText",
        },
      },
    });
    expect(runtimeState0.body[0]).toBe(runtimeNew);
    expect(runtimeState1.body[0]).toBe(nestedRuntime);
    expect(runtimeNew.provider).toBeUndefined();
    expect(runtimeCall.provider).toBeUndefined();
    expect(runtimeWrite.provider).toBeUndefined();

    const attachedAgain = attachIrExternSupport(attached);
    expect(attachedAgain).toBe(attached);
    expect(attachedAgain.asyncPlan).toBe(asyncPlan);
    expect(attachedAgain.asyncRuntime).toBe(attachedRuntime);
    expect(attachedAgain.asyncRuntime!.states).toBe(attachedRuntime.states);
    expect(attachedAgain.asyncRuntime!.states[0]!.body).toBe(attachedRuntime.states[0]!.body);
    expect(attachedAgain.asyncRuntime!.states[1]!.body).toBe(attachedRuntime.states[1]!.body);
  });

  it("rejects a conflicting pre-attached provider", () => {
    const conflicting: IrInstr = {
      ...EXTERN_CASES[1].instr,
      provider: irImportFuncRef("env", "Wrong_createElement"),
    };

    expect(() => attachIrExternSupport(functionWith([conflicting]))).toThrow(
      "IR extern.call already carries a different prepared provider binding",
    );
  });

  it("leaves extern.regex unattached so its implicit string support remains fail-closed", () => {
    const regex: IrInstr = {
      kind: "extern.regex",
      pattern: "a+",
      flags: "g",
      result: value(0),
      resultType: { kind: "extern", className: "RegExp" },
    };
    const original = functionWith([regex]);

    expect(irExternCallableProviderRef(regex)).toBeUndefined();
    const attached = attachIrExternSupport(original);
    expect(attached).toBe(original);
    expect(attached.blocks[0]!.instrs[0]).toBe(regex);
    expect(attached.blocks[0]!.instrs[0]).not.toHaveProperty("provider");
  });
});
