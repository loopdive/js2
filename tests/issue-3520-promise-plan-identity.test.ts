// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";

import { buildIrUnitInventory, createDerivedIrUnitId, type IrUnitId } from "../src/ir/identity.js";
import { irVal, type IrFuncRef, type IrType, type IrValueId } from "../src/ir/nodes.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import {
  buildIrPromiseDelayLoweringPlans,
  collectIrPromiseDelayOwners,
  tryLowerPromiseDelayCall,
  tryLowerPromiseDelayConstruction,
  type IrPromiseDelayLoweringHost,
  type IrPromiseDelayLoweringPlans,
} from "../src/ir/promise-delay-lowering.js";
import type { IrPromiseDelayCertification, IrPromiseDelayResolver } from "../src/ir/promise-delay.js";
import { ts } from "../src/ts-api.js";

function source(fileName: string, ownerNames: readonly string[]): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    ownerNames
      .map(
        (ownerName) => `
          export function ${ownerName}(ms: number, value: number): Promise<number> {
            return new Promise<number>((resolve) => {
              setTimeout(() => resolve(value), ms);
            });
          }
        `,
      )
      .join("\n"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}

function functions(sourceFile: ts.SourceFile): readonly ts.FunctionDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && !!statement.body,
  );
}

function certification(owner: ts.FunctionDeclaration): IrPromiseDelayCertification {
  if (!owner.name || !owner.body) throw new Error("expected an exact named owner");
  const returned = owner.body.statements[0];
  if (
    !returned ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isNewExpression(returned.expression)
  ) {
    throw new Error("expected Promise construction");
  }
  const construction = returned.expression;
  const executor = construction.arguments?.[0];
  if (!executor || !ts.isArrowFunction(executor) || !ts.isBlock(executor.body)) {
    throw new Error("expected block-bodied executor");
  }
  const timerStatement = executor.body.statements[0];
  if (!timerStatement || !ts.isExpressionStatement(timerStatement) || !ts.isCallExpression(timerStatement.expression)) {
    throw new Error("expected timer call");
  }
  const timerCall = timerStatement.expression;
  const timerCallback = timerCall.arguments[0];
  if (!timerCallback || !ts.isArrowFunction(timerCallback) || !ts.isCallExpression(timerCallback.body)) {
    throw new Error("expected concise timer callback");
  }
  return {
    owner: owner as ts.FunctionDeclaration & { readonly name: ts.Identifier; readonly body: ts.Block },
    construction,
    executor: executor as ts.ArrowFunction & { readonly body: ts.Block },
    timerCall,
    timerCallback,
    resolveCall: timerCallback.body,
    executorCaptureNames: ["ms", "value"],
    timerCaptureNames: ["resolve", "value"],
    executorOrdinal: 0,
    timerOrdinal: 1,
  };
}

function resolver(certifications: readonly IrPromiseDelayCertification[]): IrPromiseDelayResolver {
  const byOwner = new Map(certifications.map((entry) => [entry.owner, entry] as const));
  const byConstruction = new Map(certifications.map((entry) => [entry.construction, entry] as const));
  return {
    resolve: (construction) => byConstruction.get(construction),
    resolveOwner: (owner) => byOwner.get(owner),
  };
}

function context(sourceFiles: readonly ts.SourceFile[], entrySource = sourceFiles[0]!): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(sourceFiles, { entrySource }));
}

function ownerId(identityContext: IrPlanningIdentityContext, owner: ts.FunctionDeclaration): IrUnitId {
  const unitId = identityContext.unitIdByDeclaration.get(owner);
  if (!unitId) throw new Error("fixture owner has no structural unit ID");
  return unitId;
}

function expectPlanningError(run: () => unknown, code: IrPlanningIdentityInvariantCode): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrPlanningIdentityInvariantError);
  expect(caught).toMatchObject({ code });
}

function loweringHost(ownerUnitId: IrUnitId | undefined, calls?: IrFuncRef[]): IrPromiseDelayLoweringHost {
  let nextValue = 0;
  const types = new Map<IrValueId, IrType>();
  const value = (type: IrType): IrValueId => {
    const id = nextValue++ as IrValueId;
    types.set(id, type);
    return id;
  };
  const builder: IrPromiseDelayLoweringHost["builder"] = {
    emitCall: (target, _args, resultType) => {
      calls?.push(target);
      return resultType === null ? null : value(resultType);
    },
    emitCallablePack: () => value(irVal({ kind: "externref" })),
    typeOf: (id) => {
      const type = types.get(id);
      if (!type) throw new Error(`fixture value ${id} has no type`);
      return type;
    },
  };
  return {
    builder,
    funcName: "delay",
    ownerUnitId,
    lowerExpr: (_expr, expected) => value(expected),
    lowerClosure: (_expr, signature) => value({ kind: "callable", signature }),
  };
}

describe("#3520 Promise-delay plan identity", () => {
  it("keeps same-named owners source-qualified and stable across source input order", () => {
    const a = source("/repo/a.ts", ["delay"]);
    const b = source("/repo/b.ts", ["delay"]);
    const ownerA = functions(a)[0]!;
    const ownerB = functions(b)[0]!;
    const certifiedA = certification(ownerA);
    const certifiedB = certification(ownerB);
    const forward = context([a, b], a);
    const reversed = context([b, a], a);
    const idA = ownerId(forward, ownerA);
    const idB = ownerId(forward, ownerB);

    expect(idA).not.toBe(idB);
    expect([ownerId(reversed, ownerA), ownerId(reversed, ownerB)]).toEqual([idA, idB]);

    const delayResolver = resolver([certifiedA, certifiedB]);
    const collectedA = collectIrPromiseDelayOwners(a, new Set([idA]), delayResolver, forward);
    const collectedB = collectIrPromiseDelayOwners(b, new Set([idB]), delayResolver, forward);
    const plans = buildIrPromiseDelayLoweringPlans(
      new Map([...collectedB, ...collectedA]),
      new Set([idB, idA]),
      forward,
    );
    const planA = plans.constructions.get(certifiedA.construction)!;
    const planB = plans.constructions.get(certifiedB.construction)!;

    expect([planA.ownerUnitId, planB.ownerUnitId]).toEqual([idA, idB]);
    expect([planA.ownerName, planB.ownerName]).toEqual(["delay", "delay"]);
    expect([planA.executorLiftedName, planB.executorLiftedName]).toEqual(["delay__closure_0", "delay__closure_0"]);
    expect(planA.executorTarget.binding).toEqual({
      kind: "unit",
      unitId: createDerivedIrUnitId({ parentId: idA, role: "lifted-closure", ordinal: 0 }),
    });
    expect(planB.executorTarget.binding).toEqual({
      kind: "unit",
      unitId: createDerivedIrUnitId({ parentId: idB, role: "lifted-closure", ordinal: 0 }),
    });
    expect(planB.executorTarget.binding).not.toEqual(planA.executorTarget.binding);
  });

  it("filters certification and plan construction by exact selected IDs, never owner labels", () => {
    const fixture = source("/repo/duplicates.ts", ["same", "same"]);
    const [firstOwner, secondOwner] = functions(fixture);
    const first = certification(firstOwner!);
    const second = certification(secondOwner!);
    const identityContext = context([fixture]);
    const firstId = ownerId(identityContext, firstOwner!);
    const secondId = ownerId(identityContext, secondOwner!);
    const baseResolver = resolver([first, second]);
    const resolveOwner = vi.fn(baseResolver.resolveOwner);

    const collected = collectIrPromiseDelayOwners(
      fixture,
      new Set([secondId]),
      { ...baseResolver, resolveOwner },
      identityContext,
    );
    expect([...collected.keys()]).toEqual([secondId]);
    expect(resolveOwner).toHaveBeenCalledTimes(1);
    expect(resolveOwner).toHaveBeenCalledWith(secondOwner);

    const plans = buildIrPromiseDelayLoweringPlans(
      new Map([
        [firstId, first],
        [secondId, second],
      ]),
      new Set([secondId]),
      identityContext,
    );
    expect(plans.constructions.has(first.construction)).toBe(false);
    expect(plans.constructions.get(second.construction)?.ownerUnitId).toBe(secondId);
  });

  it("rejects cloned sources, cloned declarations, and stale certifications with typed invariants", () => {
    const original = source("/repo/original.ts", ["delay"]);
    const originalOwner = functions(original)[0]!;
    const identityContext = context([original]);
    const unitId = ownerId(identityContext, originalOwner);
    const clonedSource = source(original.fileName, ["delay"]);

    expectPlanningError(
      () => collectIrPromiseDelayOwners(clonedSource, new Set([unitId]), resolver([]), identityContext),
      "source-record-mismatch",
    );
    expectPlanningError(
      () =>
        buildIrPromiseDelayLoweringPlans(
          new Map([[unitId, certification(functions(clonedSource)[0]!)]]),
          new Set([unitId]),
          identityContext,
        ),
      "unit-record-mismatch",
    );

    const stale = source("/repo/stale.ts", ["delay"]);
    const staleContext = context([stale]);
    const staleId = ownerId(staleContext, functions(stale)[0]!);
    const replacement = source(stale.fileName, ["delay"]);
    (stale as unknown as { statements: ts.NodeArray<ts.Statement> }).statements = replacement.statements;
    expectPlanningError(
      () => collectIrPromiseDelayOwners(stale, new Set([staleId]), resolver([]), staleContext),
      "missing-unit-declaration",
    );
  });

  it("fails closed for missing or mismatched construction, timer, and resolve owners", () => {
    const fixture = source("/repo/consume.ts", ["delay", "other"]);
    const [delayOwner, otherOwner] = functions(fixture);
    const certified = certification(delayOwner!);
    const identityContext = context([fixture]);
    const delayId = ownerId(identityContext, delayOwner!);
    const otherId = ownerId(identityContext, otherOwner!);
    const plans: IrPromiseDelayLoweringPlans = buildIrPromiseDelayLoweringPlans(
      new Map([[delayId, certified]]),
      new Set([delayId]),
      identityContext,
    );
    const consumers = [
      () => tryLowerPromiseDelayConstruction(certified.construction, plans, () => loweringHost(undefined)),
      () => tryLowerPromiseDelayCall(certified.timerCall, true, plans, () => loweringHost(undefined)),
      () => tryLowerPromiseDelayCall(certified.resolveCall, true, plans, () => loweringHost(undefined)),
    ];
    const staleConsumers = [
      () => tryLowerPromiseDelayConstruction(certified.construction, plans, () => loweringHost(otherId)),
      () => tryLowerPromiseDelayCall(certified.timerCall, true, plans, () => loweringHost(otherId)),
      () => tryLowerPromiseDelayCall(certified.resolveCall, true, plans, () => loweringHost(otherId)),
    ];
    const matchingConsumers = [
      () => tryLowerPromiseDelayConstruction(certified.construction, plans, () => loweringHost(delayId)),
      () => tryLowerPromiseDelayCall(certified.timerCall, true, plans, () => loweringHost(delayId)),
      () => tryLowerPromiseDelayCall(certified.resolveCall, true, plans, () => loweringHost(delayId)),
    ];

    for (const consume of consumers) {
      expect(consume).toThrow("Promise delay plan cannot be consumed without an authoritative ownerUnitId");
    }
    for (const consume of staleConsumers) expect(consume).toThrow("stale Promise delay plan owner");
    for (const consume of matchingConsumers) expect(consume()).toEqual(expect.any(Number));

    const calls: IrFuncRef[] = [];
    expect(tryLowerPromiseDelayConstruction(certified.construction, plans, () => loweringHost(delayId, calls))).toEqual(
      expect.any(Number),
    );
    expect(tryLowerPromiseDelayCall(certified.timerCall, true, plans, () => loweringHost(delayId, calls))).toEqual(
      expect.any(Number),
    );
    expect(tryLowerPromiseDelayCall(certified.resolveCall, true, plans, () => loweringHost(delayId, calls))).toEqual(
      expect.any(Number),
    );
    expect(calls.map((target) => target.binding)).toEqual([
      { kind: "import", module: "env", field: "Promise_new" },
      { kind: "import", module: "env", field: "__box_number" },
      { kind: "import", module: "env", field: "__timer_set_timeout" },
      { kind: "import", module: "env", field: "__call_1_f64" },
    ]);
  });
});
