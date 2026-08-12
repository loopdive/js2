// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import type { IrHostVoidCallbackLoweringPlan } from "../src/ir/ast-lowering-plans.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/planning-identity.js";
import type { IrPromiseDelayLoweringPlan, IrPromiseDelayLoweringPlans } from "../src/ir/promise-delay-lowering.js";
import { ts } from "../src/ts-api.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import {
  applyIrFinalContextFunctionRetention,
  closeIrBlockedComponentByIdentity,
  prepareHostDateSnapshotLoweringByIdentity,
  prepareHostVoidCallbackLoweringByIdentity,
  preparePromiseDelayLoweringByIdentity,
  type IrHostDateSnapshotImportPlan,
} from "../src/codegen/ir-overlay-finalize.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function contextFor(sourceFiles: readonly ts.SourceFile[], entrySource = sourceFiles[0]!): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(sourceFiles, { entrySource }));
}

function functions(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined,
  );
}

function unitId(context: IrPlanningIdentityContext, declaration: ts.FunctionDeclaration): IrUnitId {
  const id = context.unitIdByDeclaration.get(declaration);
  if (!id) throw new Error("missing function unit identity");
  return id;
}

function collectNodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const nodes: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
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

function emptyContext(): CodegenContext {
  return {
    funcMap: new Map(),
    numImportFuncs: 0,
    mod: { imports: [], types: [], functions: [] },
  } as unknown as CodegenContext;
}

function withProgramAbiSession(ctx: CodegenContext, identityContext: IrPlanningIdentityContext): CodegenContext {
  ctx.programAbiSession = new ProgramAbiSession(identityContext.inventory, ctx.mod);
  return ctx;
}

function exactHostVoidCallbackContext(): CodegenContext {
  return {
    funcMap: new Map([["__make_callback", 0]]),
    numImportFuncs: 1,
    mod: {
      imports: [{ module: "env", name: "__make_callback", desc: { kind: "func", typeIdx: 0 } }],
      types: [
        {
          kind: "func",
          params: [{ kind: "i32" }, { kind: "externref" }],
          results: [{ kind: "externref" }],
        },
      ],
      functions: [],
    },
  } as unknown as CodegenContext;
}

function callbackPlan(ownerUnitId: IrUnitId, ownerName: string, liftedOrdinal = 0): IrHostVoidCallbackLoweringPlan {
  return {
    ownerUnitId,
    ownerName,
    signature: { params: [], returnType: null },
    captureNames: new Set(),
    liftedOrdinal,
  };
}

function datePlan(ownerUnitId: IrUnitId, ownerName: string, ...importNames: string[]): IrHostDateSnapshotImportPlan {
  return { ownerUnitId, ownerName, importNames: new Set(importNames) };
}

function occupiedDateContext(name = "Date_new"): CodegenContext {
  const ctx = emptyContext();
  ctx.funcMap.set(name, 0);
  return ctx;
}

function promisePlan(owner: ts.FunctionDeclaration, ownerUnitId: IrUnitId): IrPromiseDelayLoweringPlan {
  const construction = collectNodes(owner, ts.isNewExpression)[0]!;
  const executor = construction.arguments?.[0];
  if (!executor || !ts.isArrowFunction(executor) || !ts.isBlock(executor.body)) {
    throw new Error("missing Promise executor fixture");
  }
  const calls = collectNodes(executor.body, ts.isCallExpression);
  const timerCall = calls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "setTimeout")!;
  const timerCallback = timerCall.arguments[0];
  if (!timerCallback || !ts.isArrowFunction(timerCallback)) throw new Error("missing timer callback fixture");
  const resolveCall = calls.find((call) => ts.isIdentifier(call.expression) && call.expression.text === "resolve")!;
  return {
    ownerUnitId,
    ownerName: owner.name!.text,
    construction,
    executor: executor as ts.ArrowFunction & { readonly body: ts.Block },
    timerCall,
    timerCallback,
    resolveCall,
    executorSignature: { params: [{ kind: "extern", className: "Function" }], returnType: null },
    timerSignature: { params: [], returnType: null },
    executorCaptureNames: [],
    timerCaptureNames: [],
    executorLiftedName: `${owner.name!.text}__closure_0`,
    timerLiftedName: `${owner.name!.text}__closure_0__closure_1`,
  };
}

function promisePlans(plan: IrPromiseDelayLoweringPlan): IrPromiseDelayLoweringPlans {
  return {
    constructions: new Map([[plan.construction, plan]]),
    timers: new Map([[plan.timerCall, plan]]),
    resolves: new Map([[plan.resolveCall, plan]]),
  };
}

function exactPromiseContext(): CodegenContext {
  const signatures = [
    { params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
    {
      params: [{ kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "externref" }],
    },
    { params: [{ kind: "f64" }], results: [{ kind: "externref" }] },
    { params: [{ kind: "externref" }, { kind: "f64" }], results: [{ kind: "f64" }] },
  ];
  const names = ["Promise_new", "__timer_set_timeout", "__box_number", "__call_1_f64"];
  return {
    funcMap: new Map(names.map((name, index) => [name, index])),
    numImportFuncs: names.length,
    mod: {
      imports: names.map((name, index) => ({ module: "env", name, desc: { kind: "func", typeIdx: index } })),
      types: signatures.map((signature) => ({ kind: "func", ...signature })),
      functions: [],
    },
  } as unknown as CodegenContext;
}

describe("#3520 structural overlay finalization", () => {
  it("closes blocked call components by unit ID without resurrecting dropped functions", () => {
    const fixture = source(
      "/repo/closure.ts",
      `
        function leaf(): number { return 1; }
        function middle(): number { return leaf(); }
        function root(): number { return middle(); }
        function independent(): number { return 2; }
      `,
    );
    const context = contextFor([fixture]);
    const leaf = unitId(context, functions(fixture, "leaf")[0]!);
    const middle = unitId(context, functions(fixture, "middle")[0]!);
    const root = unitId(context, functions(fixture, "root")[0]!);
    const independent = unitId(context, functions(fixture, "independent")[0]!);

    const retained = closeIrBlockedComponentByIdentity(
      fixture,
      context,
      new Set([leaf, middle, root, independent]),
      new Set([middle]),
    );
    expect([...retained]).toEqual([independent]);

    // `leaf` was already absent from the retained post-type population. The
    // closure can remove more IDs, but can never re-add it from raw AST edges.
    expect(
      closeIrBlockedComponentByIdentity(fixture, context, new Set([root, independent]), new Set([middle])),
    ).toEqual(new Set([independent]));

    const missing = "ir-unit:missing" as IrUnitId;
    expectPlanningError(
      () => closeIrBlockedComponentByIdentity(fixture, context, new Set([independent]), new Set([missing])),
      "missing-planning-owner",
    );
    const clone = source(fixture.fileName, fixture.text);
    expectPlanningError(
      () => closeIrBlockedComponentByIdentity(clone, context, new Set([independent]), new Set()),
      "source-record-mismatch",
    );
  });

  it("closes a blocked exact module initializer over its retained local callee", () => {
    const fixture = source(
      "/repo/module-owner.ts",
      `
        function initialized(): number { return 1; }
        function independent(): number { return 2; }
        const boot: number = initialized();
      `,
    );
    const foreign = source(
      "/repo/foreign-module-owner.ts",
      `function foreignTarget(): number { return 3; } const foreignBoot = foreignTarget();`,
    );
    const context = contextFor([fixture, foreign], fixture);
    const initialized = unitId(context, functions(fixture, "initialized")[0]!);
    const independent = unitId(context, functions(fixture, "independent")[0]!);
    const moduleInit = context.moduleInitUnitIdBySourceFile.get(fixture)!;
    const foreignModuleInit = context.moduleInitUnitIdBySourceFile.get(foreign)!;

    expect(
      closeIrBlockedComponentByIdentity(fixture, context, new Set([initialized, independent]), new Set([moduleInit])),
    ).toEqual(new Set([independent]));
    expectPlanningError(
      () =>
        closeIrBlockedComponentByIdentity(
          fixture,
          context,
          new Set([initialized, independent]),
          new Set([foreignModuleInit]),
        ),
      "source-record-mismatch",
    );
  });

  it("prepares host-Date owners by exact ID when separate sources reuse the same legacy label", () => {
    const local = source("/repo/local-date.ts", `function same(): number { return new Date().getDate(); }`);
    const foreign = source("/repo/foreign-date.ts", `function same(): number { return new Date().getDate(); }`);
    const context = contextFor([local, foreign], local);
    const localId = unitId(context, functions(local, "same")[0]!);
    const foreignId = unitId(context, functions(foreign, "same")[0]!);

    const retained = prepareHostDateSnapshotLoweringByIdentity(
      occupiedDateContext(),
      local,
      new Map([[localId, datePlan(localId, "same", "Date_new")]]),
      new Set([localId]),
      undefined,
      context,
    );
    expect(retained.retainedFunctionUnitIds).toEqual(new Set());
    expect(retained.retainedModuleInitUnitId).toBeUndefined();

    // A same-spelled owner from another source is foreign even when inactive;
    // a legacy-name filter would incorrectly accept or ignore this plan.
    expectPlanningError(
      () =>
        prepareHostDateSnapshotLoweringByIdentity(
          occupiedDateContext(),
          local,
          new Map([[foreignId, datePlan(foreignId, "same", "Date_new")]]),
          new Set([localId]),
          undefined,
          context,
        ),
      "source-record-mismatch",
    );
    expectPlanningError(
      () =>
        prepareHostDateSnapshotLoweringByIdentity(
          occupiedDateContext(),
          local,
          new Map([[localId, datePlan(localId, "foreign-label", "Date_new")]]),
          new Set([localId]),
          undefined,
          context,
        ),
      "unit-record-mismatch",
    );
    const missing = "ir-unit:missing-host-date" as IrUnitId;
    expectPlanningError(
      () =>
        prepareHostDateSnapshotLoweringByIdentity(
          occupiedDateContext(),
          local,
          new Map([[missing, datePlan(missing, "same", "Date_new")]]),
          new Set([localId]),
          undefined,
          context,
        ),
      "missing-planning-owner",
    );
  });

  it("closes exact host-Date module-init ownership without resurrecting dropped functions", () => {
    const fixture = source(
      "/repo/date-module-init.ts",
      `
        function initialized(): number { return 1; }
        function alreadyDropped(): number { return 2; }
        function independent(): number { return 3; }
        const boot: number = new Date().getFullYear() + initialized() + alreadyDropped();
      `,
    );
    const context = contextFor([fixture]);
    const initialized = unitId(context, functions(fixture, "initialized")[0]!);
    const independent = unitId(context, functions(fixture, "independent")[0]!);
    const moduleInit = context.moduleInitUnitIdBySourceFile.get(fixture)!;
    const moduleName = context.terminalByUnitId.get(moduleInit)!.legacyMatchName;

    const retained = prepareHostDateSnapshotLoweringByIdentity(
      occupiedDateContext(),
      fixture,
      new Map([[moduleInit, datePlan(moduleInit, moduleName, "Date_new")]]),
      // `alreadyDropped` is deliberately absent: closure may only subtract
      // from this post-type population, never repopulate raw AST callees.
      new Set([initialized, independent]),
      moduleInit,
      context,
    );
    expect(retained.retainedFunctionUnitIds).toEqual(new Set([independent]));
    expect(retained.retainedModuleInitUnitId).toBeUndefined();
  });

  it("propagates a blocked host-Date function through its exact module-init caller", () => {
    const fixture = source(
      "/repo/date-function-module-caller.ts",
      `
        function snap(): number { return new Date().getDate(); }
        function sibling(): number { return 2; }
        function independent(): number { return 3; }
        const boot: number = snap() + sibling();
      `,
    );
    const context = contextFor([fixture]);
    const snap = unitId(context, functions(fixture, "snap")[0]!);
    const sibling = unitId(context, functions(fixture, "sibling")[0]!);
    const independent = unitId(context, functions(fixture, "independent")[0]!);
    const moduleInit = context.moduleInitUnitIdBySourceFile.get(fixture)!;

    const retained = prepareHostDateSnapshotLoweringByIdentity(
      occupiedDateContext(),
      fixture,
      new Map([[snap, datePlan(snap, "snap", "Date_new")]]),
      new Set([snap, sibling, independent]),
      moduleInit,
      context,
    );
    expect(retained.retainedFunctionUnitIds).toEqual(new Set([independent]));
    expect(retained.retainedModuleInitUnitId).toBeUndefined();
  });

  it("preserves legacy broad demotion for coexisting class and module owners", () => {
    const moduleInit = { stmtCount: 1, reason: null } as const;
    const selection = {
      funcs: new Set(["blocked", "retained"]),
      classMembers: new Set(["Calendar_render"]),
      moduleInit,
    };

    expect(applyIrFinalContextFunctionRetention(selection, new Set(["retained"]), true)).toEqual({
      funcs: new Set(["retained"]),
      classMembers: new Set(),
      classMemberUnitIds: new Set(),
      moduleInit: undefined,
    });
    expect(applyIrFinalContextFunctionRetention(selection, new Set(selection.funcs), false)).toEqual(selection);
  });

  it("filters callback plans by owner ID even when retained and inactive owners share a label", () => {
    const fixture = source(
      "/repo/callback.ts",
      `
        function same(): number { consume(() => {}); return 1; }
        function same(): number { consume(() => {}); return 2; }
      `,
    );
    const context = contextFor([fixture]);
    const declarations = functions(fixture, "same");
    const firstId = unitId(context, declarations[0]!);
    const secondId = unitId(context, declarations[1]!);
    const [firstCallback] = collectNodes(declarations[0]!, ts.isArrowFunction);
    const [secondCallback] = collectNodes(declarations[1]!, ts.isArrowFunction);
    const inactiveSameLabel = new Map([[secondCallback!, callbackPlan(secondId, "same")]]);

    expect(
      prepareHostVoidCallbackLoweringByIdentity(
        emptyContext(),
        fixture,
        inactiveSameLabel,
        new Set([firstId]),
        context,
      ),
    ).toEqual(new Set([firstId]));
    expect(
      prepareHostVoidCallbackLoweringByIdentity(
        emptyContext(),
        fixture,
        new Map([[firstCallback!, callbackPlan(firstId, "same")]]),
        new Set([firstId]),
        context,
      ),
    ).toEqual(new Set());

    const missing = "ir-unit:missing-callback" as IrUnitId;
    expectPlanningError(
      () =>
        prepareHostVoidCallbackLoweringByIdentity(
          emptyContext(),
          fixture,
          new Map([[firstCallback!, callbackPlan(missing, "same")]]),
          new Set(),
          context,
        ),
      "missing-planning-owner",
    );
    expectPlanningError(
      () =>
        prepareHostVoidCallbackLoweringByIdentity(
          emptyContext(),
          fixture,
          new Map([[secondCallback!, callbackPlan(firstId, "same")]]),
          new Set(),
          context,
        ),
      "terminal-record-mismatch",
    );
  });

  it("rejects a callback plan site removed from its exact current owner body", () => {
    const fixture = source("/repo/stale-callback.ts", `function owner(): number { consume(() => {}); return 1; }`);
    const context = contextFor([fixture]);
    const owner = functions(fixture, "owner")[0]!;
    const ownerId = unitId(context, owner);
    const callback = collectNodes(owner, ts.isArrowFunction)[0]!;
    Reflect.set(owner.body!, "statements", ts.factory.createNodeArray());

    expectPlanningError(
      () =>
        prepareHostVoidCallbackLoweringByIdentity(
          emptyContext(),
          fixture,
          new Map([[callback, callbackPlan(ownerId, "owner")]]),
          new Set([ownerId]),
          context,
        ),
      "unit-record-mismatch",
    );
  });

  it("lets Program ABI own callback slots when a source function reuses the synthesized display name", () => {
    const fixture = source(
      "/repo/callback-synthetic-name.ts",
      `
        function owner__closure_0(): number { return 0; }
        function owner(): number { consume(() => {}); return 1; }
      `,
    );
    const context = contextFor([fixture]);
    const owner = functions(fixture, "owner")[0]!;
    const ownerId = unitId(context, owner);
    const callback = collectNodes(owner, ts.isArrowFunction)[0]!;
    const callbacks = new Map([[callback, callbackPlan(ownerId, "owner")]]);

    const compatibilityContext = exactHostVoidCallbackContext();
    compatibilityContext.funcMap.set("owner__closure_0", compatibilityContext.numImportFuncs);
    expect(
      prepareHostVoidCallbackLoweringByIdentity(compatibilityContext, fixture, callbacks, new Set([ownerId]), context),
    ).toEqual(new Set());

    const programAbiContext = withProgramAbiSession(exactHostVoidCallbackContext(), context);
    programAbiContext.funcMap.set("owner__closure_0", programAbiContext.numImportFuncs);
    expect(
      prepareHostVoidCallbackLoweringByIdentity(programAbiContext, fixture, callbacks, new Set([ownerId]), context),
    ).toEqual(new Set([ownerId]));
  });

  it("filters and records Promise preparation by exact owner ID and rejects stale plans", () => {
    const fixture = source(
      "/repo/promise.ts",
      `
        function same(): number { return 1; }
        function same(): number {
          new Promise((resolve) => { setTimeout(() => resolve(1), 1); });
          return 2;
        }
      `,
    );
    const context = contextFor([fixture]);
    const declarations = functions(fixture, "same");
    const firstId = unitId(context, declarations[0]!);
    const secondId = unitId(context, declarations[1]!);
    const plan = promisePlan(declarations[1]!, secondId);
    const plans = promisePlans(plan);

    expect(preparePromiseDelayLoweringByIdentity(emptyContext(), fixture, plans, new Set([firstId]), context)).toEqual(
      new Set([firstId]),
    );
    expect(preparePromiseDelayLoweringByIdentity(emptyContext(), fixture, plans, new Set([secondId]), context)).toEqual(
      new Set(),
    );

    const failures = new Map();
    const priorInjection = process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW = "1";
    try {
      expect(
        preparePromiseDelayLoweringByIdentity(
          exactPromiseContext(),
          fixture,
          plans,
          new Set([secondId]),
          context,
          failures,
        ),
      ).toEqual(new Set());
    } finally {
      if (priorInjection === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW");
      } else process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW = priorInjection;
    }
    expect([...failures.keys()]).toEqual([secondId]);

    const missing = "ir-unit:missing-promise" as IrUnitId;
    expectPlanningError(
      () =>
        preparePromiseDelayLoweringByIdentity(
          emptyContext(),
          fixture,
          promisePlans({ ...plan, ownerUnitId: missing }),
          new Set(),
          context,
        ),
      "missing-planning-owner",
    );
    expectPlanningError(
      () =>
        preparePromiseDelayLoweringByIdentity(
          emptyContext(),
          fixture,
          promisePlans({ ...plan, ownerUnitId: firstId }),
          new Set(),
          context,
        ),
      "terminal-record-mismatch",
    );
  });

  it("lets Program ABI own Promise lifted slots when source functions reuse their display names", () => {
    const fixture = source(
      "/repo/promise-synthetic-names.ts",
      `
        function owner__closure_0(): number { return 0; }
        function owner__closure_0__closure_1(): number { return 0; }
        function owner(): number {
          new Promise((resolve) => { setTimeout(() => resolve(1), 1); });
          return 1;
        }
      `,
    );
    const context = contextFor([fixture]);
    const owner = functions(fixture, "owner")[0]!;
    const ownerId = unitId(context, owner);
    const plan = promisePlan(owner, ownerId);
    const plans = promisePlans(plan);

    const compatibilityContext = exactPromiseContext();
    compatibilityContext.funcMap.set(plan.executorLiftedName, compatibilityContext.numImportFuncs);
    compatibilityContext.funcMap.set(plan.timerLiftedName, compatibilityContext.numImportFuncs + 1);
    expect(
      preparePromiseDelayLoweringByIdentity(compatibilityContext, fixture, plans, new Set([ownerId]), context),
    ).toEqual(new Set());

    const programAbiContext = withProgramAbiSession(exactPromiseContext(), context);
    programAbiContext.funcMap.set(plan.executorLiftedName, programAbiContext.numImportFuncs);
    programAbiContext.funcMap.set(plan.timerLiftedName, programAbiContext.numImportFuncs + 1);
    expect(
      preparePromiseDelayLoweringByIdentity(programAbiContext, fixture, plans, new Set([ownerId]), context),
    ).toEqual(new Set([ownerId]));
  });

  it("rejects Promise plan sites removed from their exact current owner body", () => {
    const fixture = source(
      "/repo/stale-promise.ts",
      `function owner(): number {
        new Promise((resolve) => { setTimeout(() => resolve(1), 1); });
        return 1;
      }`,
    );
    const context = contextFor([fixture]);
    const owner = functions(fixture, "owner")[0]!;
    const ownerId = unitId(context, owner);
    const plans = promisePlans(promisePlan(owner, ownerId));
    Reflect.set(owner.body!, "statements", ts.factory.createNodeArray());

    expectPlanningError(
      () => preparePromiseDelayLoweringByIdentity(emptyContext(), fixture, plans, new Set([ownerId]), context),
      "unit-record-mismatch",
    );
  });
});
