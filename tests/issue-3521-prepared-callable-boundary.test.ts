// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { ProgramAbiSourceCallableRegistry } from "../src/codegen/program-abi-source-callable-planning.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { buildIrUnitInventory, createIrBindingId, type IrBindingId, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  assertPreparedCallableBoundaryCandidate,
  type PreparedCallableBoundaryCandidate,
} from "../src/ir/prepared-callable-boundary.js";
import { projectIrFunctionSignature, type IrLoweredSignature } from "../src/ir/lower.js";
import type { IrFunction, IrInstr, IrType, IrTypeRef } from "../src/ir/nodes.js";
import { createEmptyModule, type FuncTypeDef, type ValType, type WasmFunction } from "../src/ir/types.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { ts } from "../src/ts-api.js";

interface Fixture {
  readonly ctx: CodegenContext;
  readonly registry: ProgramAbiSourceCallableRegistry;
  readonly unitId: IrUnitId;
  readonly callableType: Extract<IrType, { readonly kind: "callable" }>;
  readonly numberType: Extract<IrType, { readonly kind: "val" }>;
  readonly fn: IrFunction;
  readonly allocated: WasmFunction;
  readonly candidate: PreparedCallableBoundaryCandidate;
}

function fixture(): Fixture {
  const sourceFile = ts.createSourceFile(
    "/repo/prepared-callable-boundary.ts",
    "export function apply(f: (v: number) => number, v: number): number { return f(v); }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("callable-boundary fixture lost its declaration");
  const unitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!unitId) throw new Error("callable-boundary fixture lost its UnitId");

  const allocatedSignature: FuncTypeDef = {
    kind: "func",
    params: [{ kind: "externref" }, { kind: "f64" }],
    results: [{ kind: "f64" }],
  };
  const allocated: WasmFunction = {
    name: "apply",
    typeIdx: 0,
    locals: [],
    body: [],
    exported: false,
  };
  const module = createEmptyModule();
  module.types.push(allocatedSignature);
  module.functions.push(allocated);
  const session = new ProgramAbiSession(inventory, module);
  const ctx = { mod: module, numImportFuncs: 0, programAbiSession: session } as unknown as CodegenContext;
  const registry = new ProgramAbiSourceCallableRegistry(ctx, session, identityContext);
  registry.observe(declaration, 0);

  const numberType = { kind: "val", val: { kind: "f64" } } as const;
  const callableType = {
    kind: "callable",
    signature: { params: [numberType], returnType: numberType },
  } as const;
  const candidateCallableType = {
    kind: "callable",
    signature: { params: [numberType], returnType: numberType },
  } as const;
  const call: IrInstr = {
    kind: "closure.call",
    result: 2,
    resultType: numberType,
    callee: 0,
    args: [1],
  };
  const fn: IrFunction = {
    unitId,
    name: "apply",
    params: [
      { value: 0, name: "f", type: callableType },
      { value: 1, name: "v", type: numberType },
    ],
    resultTypes: [numberType],
    blocks: [
      {
        id: "entry" as never,
        blockArgs: [],
        blockArgTypes: [],
        instrs: [call],
        terminator: { kind: "return", values: [2] },
      },
    ],
    exported: true,
    valueCount: 3,
  };
  const candidate = registry.issuePreparedCallableBoundary(unitId, {
    params: [candidateCallableType, numberType],
    returnType: numberType,
  });
  if (!candidate) throw new Error("callable-boundary fixture did not issue a candidate");
  return { ctx, registry, unitId, callableType, numberType, fn, allocated, candidate };
}

function projected(): IrLoweredSignature<ValType> {
  return {
    params: [
      { name: "f", slots: [{ kind: "externref" }] },
      { name: "v", slots: [{ kind: "f64" }] },
    ],
    results: [[{ kind: "f64" }]],
  };
}

function invokeRef(bindingId: IrBindingId): IrTypeRef {
  return {
    kind: "type",
    name: "prepared-callable-invoke",
    binding: { kind: "support", bindingId },
  };
}

function support(
  f: Fixture,
  invocationRefs: readonly IrTypeRef[] = [],
): {
  readonly typeRefs: Map<IrType, readonly IrTypeRef[]>;
  readonly instructionRefs: Map<IrInstr, readonly IrTypeRef[]>;
  readonly functionRefs: Map<IrFunction, readonly IrTypeRef[]>;
} {
  const refs = new Map<IrType, readonly IrTypeRef[]>([[f.callableType, Object.freeze([])]]);
  const instructionRefs = new Map<IrInstr, readonly IrTypeRef[]>();
  const call = f.fn.blocks[0]!.instrs[0]!;
  instructionRefs.set(call, invocationRefs);
  return { typeRefs: refs, instructionRefs, functionRefs: new Map() };
}

function scope(f: Fixture, allocator: object = f.allocated) {
  return {
    locatorObject: (id: IrBindingId) => (id === f.candidate.bindingId ? allocator : undefined),
    currentCallableContract: (id: IrBindingId) =>
      id === f.candidate.bindingId
        ? { params: [{ kind: "externref" }, { kind: "f64" }], results: [{ kind: "f64" }] }
        : undefined,
    resolveCurrentIndex: () => 0,
  };
}

function certify(f: Fixture, invocationRefs: readonly IrTypeRef[] = []) {
  return f.candidate.certify({
    fn: f.fn,
    projectedSignature: projected(),
    support: support(f, invocationRefs),
    scopeLookup: scope(f),
  });
}

describe("#3521 R2-B1 prepared callable boundary contract", () => {
  it("shares the lowerer projection and authenticates a real callable invocation", () => {
    const f = fixture();
    const resolver = {
      resolveFunc: () => 0,
      internFuncType: () => 0,
    } as never;
    expect(projectIrFunctionSignature(f.fn, resolver)).toEqual(projected());

    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    const contract = certify(f, [invocation]);
    expect(contract).toMatchObject({
      unitId: f.unitId,
      bindingId: f.candidate.bindingId,
      allocated: f.allocated,
      projectedSignature: { params: [{ kind: "externref" }, { kind: "f64" }], results: [{ kind: "f64" }] },
      supportBindingIds: [invocation.binding.bindingId],
    });
    f.candidate.assertCurrent();
    f.candidate.assertSupportCurrent(f.fn, support(f, [invocation]));
  });

  it("does not certify without producer evidence for callable invocation", () => {
    const f = fixture();
    expect(certify(f)).toBeUndefined();
    expect(f.candidate.contract).toBeUndefined();
  });

  it("rejects a changed semantic or projected physical signature before publication", () => {
    const f = fixture();
    const changedFn = {
      ...f.fn,
      params: [f.fn.params[0]!, { ...f.fn.params[1]!, type: { kind: "val", val: { kind: "i32" } } }],
    } as IrFunction;
    expect(
      f.candidate.certify({
        fn: changedFn,
        projectedSignature: projected(),
        support: support(f, [invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }))]),
        scopeLookup: scope(f),
      }),
    ).toBeUndefined();
    expect(
      f.candidate.certify({
        fn: f.fn,
        projectedSignature: {
          ...projected(),
          results: [[{ kind: "i32" }]],
        },
        support: support(f, [invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }))]),
        scopeLookup: scope(f),
      }),
    ).toBeUndefined();
    expect(f.candidate.contract).toBeUndefined();
  });

  it("rejects an in-place nested callable mutation after issuance", () => {
    const f = fixture();
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    const mutableCallable = f.callableType as unknown as {
      signature: { params: IrType[]; returnType: IrType | null };
    };
    mutableCallable.signature.params[0] = { kind: "val", val: { kind: "i32" } };

    expect(certify(f, [invocation])).toBeUndefined();
    expect(f.candidate.allocated).toBe(f.allocated);
    expect(
      (f.candidate.semanticSignature.params[0] as Extract<IrType, { kind: "callable" }>).signature.params[0],
    ).toEqual(f.numberType);
  });

  it.each(["boolean", "symbol"] as const)("rejects an in-place nested callable i32.%s mutation", (flag) => {
    const f = fixture();
    const mutableCallable = f.callableType as unknown as {
      signature: { params: IrType[]; returnType: IrType | null };
    };
    mutableCallable.signature.params[0] = { kind: "val", val: { kind: "i32" } };
    const candidate = f.registry.issuePreparedCallableBoundary(f.unitId, {
      params: [f.callableType, f.numberType],
      returnType: f.numberType,
    });
    if (!candidate) throw new Error("callable-boundary fixture did not issue the flagged candidate");

    const mutableParam = mutableCallable.signature.params[0] as unknown as {
      val: { kind: "i32"; boolean?: true; symbol?: true };
    };
    mutableParam.val[flag] = true;
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    expect(
      candidate.certify({
        fn: f.fn,
        projectedSignature: projected(),
        support: support(f, [invocation]),
        scopeLookup: scope(f),
      }),
    ).toBeUndefined();
    expect(candidate.contract).toBeUndefined();
  });

  it("rejects an in-place nested callable f64.undefSentinel mutation after certification", () => {
    const f = fixture();
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    const contract = certify(f, [invocation]);
    expect(contract).toBeDefined();

    const mutableNumber = f.numberType as unknown as {
      val: { kind: "f64"; undefSentinel?: true };
    };
    mutableNumber.val.undefSentinel = true;

    expect(() => f.candidate.assertCurrent(f.fn)).toThrow(/semantic signature changed/);
    expect(() => contract!.assertSupportCurrent(f.fn, support(f, [invocation]))).toThrow(/semantic signature changed/);
  });

  it("does not collapse a multi-result function into the void signature", () => {
    const f = fixture();
    const voidCandidate = f.registry.issuePreparedCallableBoundary(f.unitId, {
      params: [f.callableType, f.numberType],
      returnType: null,
    });
    if (!voidCandidate) throw new Error("callable-boundary fixture did not issue the void candidate");
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    expect(
      voidCandidate.certify({
        fn: { ...f.fn, resultTypes: [f.numberType, f.numberType] },
        projectedSignature: projected(),
        support: support(f, [invocation]),
        scopeLookup: scope(f),
      }),
    ).toBeUndefined();
    expect(voidCandidate.contract).toBeUndefined();
  });

  it("rechecks an in-place nested callable mutation after certification", () => {
    const f = fixture();
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    const contract = certify(f, [invocation]);
    expect(contract).toBeDefined();

    const mutableCallable = f.callableType as unknown as {
      signature: { params: IrType[]; returnType: IrType | null };
    };
    mutableCallable.signature.returnType = { kind: "val", val: { kind: "i32" } };

    expect(() => f.candidate.assertCurrent(f.fn)).toThrow(/semantic signature changed/);
    expect(() => contract!.assertSupportCurrent(f.fn, support(f, [invocation]))).toThrow(/semantic signature changed/);
    expect(f.candidate.allocated).toBe(f.allocated);
  });

  it("fails closed for a foreign scoped allocator and a changed allocator object", () => {
    const f = fixture();
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    expect(() =>
      f.candidate.certify({
        fn: f.fn,
        projectedSignature: projected(),
        support: support(f, [invocation]),
        scopeLookup: scope(f, {}),
      }),
    ).toThrow(/scoped allocator/);

    const replacement: WasmFunction = { ...f.allocated, name: "foreign" };
    f.ctx.mod.functions[0] = replacement;
    expect(() => f.candidate.assertCurrent()).toThrow(/exact allocator object/);
  });

  it("rejects changed support after certification and rejects forged receipts", () => {
    const f = fixture();
    const invocation = invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "invoke" }));
    expect(certify(f, [invocation])).toBeDefined();

    const changed = support(f, [invocation]);
    changed.typeRefs.set(f.callableType, [
      invokeRef(createIrBindingId({ ownerId: f.unitId, domain: "support", role: "other" })),
    ]);
    expect(() => f.candidate.assertSupportCurrent(f.fn, changed)).toThrow(/support evidence changed/);
    expect(() => assertPreparedCallableBoundaryCandidate({ ...f.candidate })).toThrow(/authenticated registry-issued/);
  });
});
