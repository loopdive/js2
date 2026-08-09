// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  collectIrDirectCallLoweringPlans,
  type IrDirectCallTarget,
  type IrDirectCallLoweringPlan,
  type IrHostVoidCallbackLoweringPlan,
  type IrImportedCallLoweringPlan,
  type IrTopLevelFunctionValueLoweringPlan,
} from "../src/ir/ast-lowering-plans.js";
import { irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import {
  irImportFuncRef,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irSupportFuncRef,
  irUnitFuncRef,
} from "../src/ir/callable-bindings.js";
import { lowerFunctionAstToIr, type IrExternClassMeta, type LoweredFunctionResult } from "../src/ir/from-ast.js";
import type { IrUnitId } from "../src/ir/identity.js";
import { irVal, type IrClosureSignature, type IrType } from "../src/ir/nodes.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-3520-lowering-plan");
const OWNER_ID = irIdentities.unit(0);
const STALE_OWNER_ID = irIdentities.unit(1);
const TARGET_ID = irIdentities.unit(2);

const F64: IrType = irVal({ kind: "f64" });
const NUMBER_SIGNATURE: IrClosureSignature = { params: [], returnType: F64 };
const VOID_SIGNATURE: IrClosureSignature = { params: [], returnType: null };
const CALLABLE_NUMBER: IrType = { kind: "callable", signature: NUMBER_SIGNATURE };

function sourceFunction(source: string): ts.FunctionDeclaration {
  const sourceFile = ts.createSourceFile("issue-3520-lowering-plan.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("expected a function declaration");
  return declaration;
}

function firstDescendant<T extends ts.Node>(node: ts.Node, predicate: (candidate: ts.Node) => candidate is T): T {
  let match: T | undefined;
  const visit = (candidate: ts.Node): void => {
    if (match) return;
    if (predicate(candidate)) {
      match = candidate;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  if (!match) throw new Error("expected matching descendant");
  return match;
}

function planOwnerEvidence(ownerUnitId: IrUnitId | undefined): { readonly ownerUnitId?: IrUnitId } {
  return ownerUnitId === undefined ? {} : { ownerUnitId };
}

function importedCallFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined): IrImportedCallLoweringPlan;
} {
  const declaration = sourceFunction(`export function owner(): number { return importedTarget(); }`);
  const call = firstDescendant(declaration, ts.isCallExpression);
  const plan = (ownerUnitId: IrUnitId | undefined): IrImportedCallLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      ownerName: "owner",
      target: irUnitFuncRef({ unitId: TARGET_ID, name: "importedTarget" }),
      params: [],
      returnType: F64,
      optionalParams: new Map(),
      needsArgc: false,
    }) as IrImportedCallLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        importedCalls: new Map([[call, plan(planOwnerUnitId)]]),
      }),
  };
}

function functionValueFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined): IrTopLevelFunctionValueLoweringPlan;
} {
  const declaration = sourceFunction(`export function owner() { return target; }`);
  const target = firstDescendant(
    declaration,
    (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "target",
  );
  const plan = (ownerUnitId: IrUnitId | undefined): IrTopLevelFunctionValueLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      ownerName: "owner",
      target: irUnitFuncRef({ unitId: TARGET_ID, name: "target" }),
      signature: NUMBER_SIGNATURE,
      trampoline: irSupportFuncRef(OWNER_ID, "function-value-trampoline", "__fn_tramp_target_cached"),
      cacheGlobal: irSupportGlobalRef(TARGET_ID, "function-value-cache", "__fn_closure_target"),
      cacheGlobalName: "__fn_closure_target",
    }) as IrTopLevelFunctionValueLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        returnTypeOverride: CALLABLE_NUMBER,
        topLevelFunctionValues: new Map([[target, plan(planOwnerUnitId)]]),
      }),
  };
}

function directCallFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined, target?: IrDirectCallLoweringPlan["target"]): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined, target?: IrDirectCallLoweringPlan["target"]): IrDirectCallLoweringPlan;
} {
  const declaration = sourceFunction(`export function owner(): number { return target(); }`);
  const call = firstDescendant(declaration, ts.isCallExpression);
  const plan = (
    ownerUnitId: IrUnitId | undefined,
    target = irUnitFuncRef({ unitId: TARGET_ID, name: "target" }),
  ): IrDirectCallLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      target,
      signature: NUMBER_SIGNATURE,
    }) as IrDirectCallLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId, target) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        directCalls: new Map([[call, plan(planOwnerUnitId, target)]]),
      }),
  };
}

function callbackFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined): IrHostVoidCallbackLoweringPlan;
} {
  const declaration = sourceFunction(`
    export function owner(target: EventTarget): void {
      target.addEventListener("tick", () => { return; });
      return;
    }
  `);
  const callback = firstDescendant(declaration, ts.isArrowFunction);
  const externref = { kind: "externref" } as const;
  const eventTarget: IrExternClassMeta = {
    className: "EventTarget",
    importPrefix: "EventTarget",
    constructorParams: [],
    methods: new Map([["addEventListener", { params: [externref, externref, externref], results: [] }]]),
    properties: new Map(),
  };
  const plan = (ownerUnitId: IrUnitId | undefined): IrHostVoidCallbackLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      ownerName: "owner",
      signature: VOID_SIGNATURE,
      captureNames: new Set(),
      liftedOrdinal: 0,
    }) as IrHostVoidCallbackLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        paramTypeOverrides: [{ kind: "extern", className: "EventTarget" }],
        returnTypeOverride: null,
        resolver: { getExternClassInfo: (className) => (className === "EventTarget" ? eventTarget : undefined) },
        hostVoidCallbacks: new Map([[callback, plan(planOwnerUnitId)]]),
      }),
  };
}

describe("#3520 lowering-plan owner identity", () => {
  it("keeps a canonical extern brand separate from its lookup spelling and import prefix", () => {
    const declaration = sourceFunction(`export function owner() { return new Alias(); }`);
    const canonicalType: IrType = { kind: "extern", className: "Canonical" };
    const metadata: IrExternClassMeta = {
      className: "Canonical",
      importPrefix: "Namespace_Canonical",
      constructorParams: [],
      methods: new Map(),
      properties: new Map(),
    };

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: OWNER_ID,
      exported: true,
      returnTypeOverride: canonicalType,
      resolver: {
        getExternClassInfo: (name) => (name === "Alias" ? metadata : undefined),
      },
    });

    expect(lowered.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({
        kind: "extern.new",
        className: "Canonical",
        importPrefix: "Namespace_Canonical",
        resultType: canonicalType,
      }),
    );
  });

  it.each([
    ["imported call", importedCallFixture, 0],
    ["direct call", directCallFixture, 0],
    ["top-level function value", functionValueFixture, 0],
    ["host void callback", callbackFixture, 1],
  ] as const)(
    "fails closed for missing and stale %s owners, then accepts the exact owner",
    (kind, makeFixture, lifts) => {
      const fixture = makeFixture();

      expect(() => fixture.lower(undefined)).toThrow(`stale ${kind} plan owner undefined`);
      expect(() => fixture.lower(STALE_OWNER_ID)).toThrow(`stale ${kind} plan owner`);

      const lowered = fixture.lower(OWNER_ID);
      expect(lowered.main.name).toBe("owner");
      expect(lowered.lifted).toHaveLength(lifts);
    },
  );

  it("retains structural target IDs while emitting legacy backend names", () => {
    const imported = importedCallFixture();
    const importedPlan = imported.plan(OWNER_ID);
    expect(importedPlan.target.binding).toEqual({ kind: "unit", unitId: TARGET_ID });
    const importedIr = imported.lower(OWNER_ID);
    expect(importedIr.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({ kind: "call", target: importedPlan.target }),
    );

    const functionValue = functionValueFixture();
    const functionValuePlan = functionValue.plan(OWNER_ID);
    expect(functionValuePlan.target.binding).toEqual({ kind: "unit", unitId: TARGET_ID });
    const functionValueIr = functionValue.lower(OWNER_ID);
    expect(functionValueIr.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({
        kind: "global.get",
        target: functionValuePlan.cacheGlobal,
        resultType: CALLABLE_NUMBER,
      }),
    );

    const direct = directCallFixture();
    const directPlan = direct.plan(OWNER_ID);
    const directIr = direct.lower(OWNER_ID);
    expect(directIr.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({ kind: "call", target: directPlan.target }),
    );
  });

  it("rejects label-compatible imported-source targets without a unit binding", () => {
    const imported = importedCallFixture();
    const malformedImported = {
      ...imported.plan(OWNER_ID),
      target: irImportFuncRef("env", "importedTarget"),
    };
    expect(() => {
      const declaration = sourceFunction(`export function owner(): number { return importedTarget(); }`);
      const call = firstDescendant(declaration, ts.isCallExpression);
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        importedCalls: new Map([[call, malformedImported]]),
      });
    }).toThrow("is not backed by an exact unit");
  });

  it("retains exact provider bindings for compiler-helper call plans", () => {
    const direct = directCallFixture();
    const providers = [
      irRuntimeFuncRef("target"),
      irIntrinsicFuncRef("target"),
      irImportFuncRef("env", "target"),
      irSupportFuncRef(OWNER_ID, "direct-call-provider", "target"),
    ];
    for (const provider of providers) {
      const lowered = direct.lower(OWNER_ID, provider);
      expect(lowered.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
        expect.objectContaining({ kind: "call", target: provider }),
      );
    }
  });

  it("collects direct calls in nested bodies from validated targets without deriving a label identity", () => {
    const declaration = sourceFunction(`
      export function owner(): number {
        function nested(): number { return target(); }
        return target() + nested();
      }
    `);
    const exactTarget: IrDirectCallTarget = {
      target: irUnitFuncRef({ unitId: TARGET_ID, name: "target" }),
      signature: NUMBER_SIGNATURE,
    };
    const plans = collectIrDirectCallLoweringPlans(declaration, OWNER_ID, new Map([["target", exactTarget]]));
    expect(plans.size).toBe(2);
    expect([...plans.values()].map((plan) => plan.target)).toEqual([exactTarget.target, exactTarget.target]);

    const nestedOnly = sourceFunction(`
      export function owner(): number {
        function nested(): number { return target(); }
        return nested();
      }
    `);
    const nestedPlans = collectIrDirectCallLoweringPlans(nestedOnly, OWNER_ID, new Map([["target", exactTarget]]));
    const lowered = lowerFunctionAstToIr(nestedOnly, {
      ownerUnitId: OWNER_ID,
      exported: true,
      directCalls: nestedPlans,
    });
    expect(lowered.lifted).toHaveLength(1);
    expect(lowered.lifted[0]!.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({ kind: "call", target: exactTarget.target }),
    );

    const provider = irIntrinsicFuncRef("target");
    const providerPlans = collectIrDirectCallLoweringPlans(
      declaration,
      OWNER_ID,
      new Map([["target", { target: provider, signature: NUMBER_SIGNATURE } satisfies IrDirectCallTarget]]),
    );
    expect([...providerPlans.values()].map((plan) => plan.target)).toEqual([provider, provider]);
  });
});
