// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  collectIrDirectCallLoweringPlans,
  collectIrDirectCallLoweringPlansByIdentity,
  irDirectCallLoweringPlanEquals,
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
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import { makeIrIdentityImportedFunctionResolver } from "../src/ir/imported-functions.js";
import { irVal, type IrClosureSignature, type IrType } from "../src/ir/nodes.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "../src/ir/planning-identity.js";
import { mergePreparedIrDirectCallLoweringPlans } from "../src/codegen/ir-prepared-free-functions.js";
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

function checkedIdentityFixture(files: Readonly<Record<string, string>>, entryName = Object.keys(files)[0]!) {
  const textByName = new Map(Object.entries(files));
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => textByName.has(fileName),
    readFile: (fileName) => textByName.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = textByName.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (directoryName) => directoryName === "/repo",
    realpath: (path) => path,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const rootNames = Object.keys(files);
  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();
  const sourceFiles = rootNames.map((fileName) => program.getSourceFile(fileName)!);
  const byName = new Map(sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile] as const));
  const entrySource = byName.get(entryName)!;
  const identityContext = buildIrPlanningIdentityContext(buildIrUnitInventory(sourceFiles, { checker, entrySource }));
  return {
    checker,
    sourceFiles,
    byName,
    identityContext,
    resolver: makeIrIdentityImportedFunctionResolver(checker, sourceFiles, identityContext),
  };
}

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing function ${name}`);
  return declaration;
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
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
    export function owner(target: HTMLElement): void {
      target.addEventListener("tick", () => { return; });
      return;
    }
  `);
  const call = firstDescendant(declaration, ts.isCallExpression);
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) throw new Error("expected a property call");
  const callback = firstDescendant(declaration, ts.isArrowFunction);
  const externref = { kind: "externref" } as const;
  const eventTarget: IrExternClassMeta = {
    className: "HTMLElement",
    importPrefix: "HTMLElement",
    constructorParams: [],
    methods: new Map([["addEventListener", { params: [externref, externref, externref, externref], results: [] }]]),
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
        paramTypeOverrides: [{ kind: "extern", className: "HTMLElement" }],
        returnTypeOverride: null,
        resolver: {
          getExternClassInfo: (className) => (className === "HTMLElement" ? eventTarget : undefined),
          standaloneDomOperation: (node) =>
            node === call
              ? {
                  kind: "member-call",
                  importName: "HTMLElement_addEventListener",
                  call,
                  access,
                  receiverClass: "HTMLElement",
                  resultClass: null,
                  argumentBoundaries: ["native-string", "native-callback-zero-void", "nullish"],
                }
              : undefined,
        },
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

  it("collects source calls only for their exact active terminal owner", () => {
    const graph = checkedIdentityFixture({
      "/repo/entry.ts": `
        function target(value: number): number { return value + 1; }
        export function outer(): number {
          function nested(): number { return target(1); }
          class Explicit {
            constructor() { target(2); }
            method(): number { return target(3); }
          }
          class Implicit { method(): number { return 0; } }
          target(4);
          return nested() + new Explicit().method() + new Implicit().method();
        }
      `,
    });
    const sourceFile = graph.byName.get("/repo/entry.ts")!;
    const target = namedFunction(sourceFile, "target");
    const outer = namedFunction(sourceFile, "outer");
    const targetUnitId = graph.identityContext.unitIdByDeclaration.get(target)!;
    const outerUnitId = graph.identityContext.unitIdByDeclaration.get(outer)!;
    const classes = [...outer.body!.statements].filter(ts.isClassDeclaration);
    const explicit = classes.find((candidate) => candidate.name?.text === "Explicit")!;
    const implicit = classes.find((candidate) => candidate.name?.text === "Implicit")!;
    const constructorDeclaration = explicit.members.find(ts.isConstructorDeclaration)!;
    const method = explicit.members.find(ts.isMethodDeclaration)!;
    const constructorUnitId = graph.identityContext.unitIdByDeclaration.get(constructorDeclaration)!;
    const methodUnitId = graph.identityContext.unitIdByDeclaration.get(method)!;
    const implicitConstructorUnitId = graph.identityContext.unitIdByDeclaration.get(implicit)!;
    const activeOwnerUnitIds = new Set(graph.identityContext.terminalByUnitId.keys());
    const targetsByLegacyName = new Map<string, IrDirectCallTarget>([
      ["target", { target: irUnitFuncRef({ unitId: targetUnitId, name: "target" }), signature: NUMBER_SIGNATURE }],
    ]);
    const options = {
      identityContext: graph.identityContext,
      resolver: graph.resolver,
      activeOwnerUnitIds,
      signaturesByUnitId: new Map([[targetUnitId, NUMBER_SIGNATURE]]),
      targetsByLegacyName,
    };

    const outerPlans = collectIrDirectCallLoweringPlansByIdentity(outer, outerUnitId, options);
    expect([...outerPlans.keys()].map((call) => call.arguments[0]?.getText(sourceFile))).toEqual(["1", "4"]);
    expect([...outerPlans.values()].every((plan) => plan.ownerUnitId === outerUnitId)).toBe(true);

    const constructorPlans = collectIrDirectCallLoweringPlansByIdentity(
      constructorDeclaration,
      constructorUnitId,
      options,
    );
    expect([...constructorPlans.keys()].map((call) => call.arguments[0]?.getText(sourceFile))).toEqual(["2"]);
    const methodPlans = collectIrDirectCallLoweringPlansByIdentity(method, methodUnitId, options);
    expect([...methodPlans.keys()].map((call) => call.arguments[0]?.getText(sourceFile))).toEqual(["3"]);

    expect(() => collectIrDirectCallLoweringPlansByIdentity(method, implicitConstructorUnitId, options)).toThrow(
      "is not an exact active self-owned terminal",
    );
    expect(requireIrPlanningOwnerUnitId(graph.identityContext, constructorPlans.keys().next().value!)).toBe(
      constructorUnitId,
    );
  });

  it("rejects stale source and mutated target evidence before retaining a source call", () => {
    const sourceText = `
      function target(value: number): number { return value + 1; }
      export function owner(): number { return target(1); }
    `;
    const graph = checkedIdentityFixture({ "/repo/entry.ts": sourceText });
    const sourceFile = graph.byName.get("/repo/entry.ts")!;
    const target = namedFunction(sourceFile, "target");
    const owner = namedFunction(sourceFile, "owner");
    const targetUnitId = graph.identityContext.unitIdByDeclaration.get(target)!;
    const ownerUnitId = graph.identityContext.unitIdByDeclaration.get(owner)!;
    const activeOwnerUnitIds = new Set(graph.identityContext.terminalByUnitId.keys());
    const signaturesByUnitId = new Map([[targetUnitId, NUMBER_SIGNATURE]]);
    const exactTarget: IrDirectCallTarget = {
      target: irUnitFuncRef({ unitId: targetUnitId, name: "target" }),
      signature: NUMBER_SIGNATURE,
    };
    const collect = (retained: IrDirectCallTarget, signatures = signaturesByUnitId) =>
      collectIrDirectCallLoweringPlansByIdentity(owner, ownerUnitId, {
        identityContext: graph.identityContext,
        resolver: graph.resolver,
        activeOwnerUnitIds,
        signaturesByUnitId: signatures,
        targetsByLegacyName: new Map([["target", retained]]),
      });

    expect(collect(exactTarget).size).toBe(1);
    expect(() => collect({ ...exactTarget, target: irUnitFuncRef({ unitId: ownerUnitId, name: "target" }) })).toThrow(
      "disagrees with its retained source identity",
    );
    expect(() => collect({ ...exactTarget, target: irUnitFuncRef({ unitId: targetUnitId, name: "renamed" }) })).toThrow(
      "disagrees with its retained source identity",
    );
    expect(() => collect({ ...exactTarget, signature: VOID_SIGNATURE })).toThrow(
      "disagrees with its retained source identity",
    );
    expect(() => collect(exactTarget, new Map([[targetUnitId, VOID_SIGNATURE]]))).toThrow(
      "disagrees with its retained source identity",
    );

    const copiedSource = ts.createSourceFile(
      sourceFile.fileName,
      sourceText,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const copiedOwner = namedFunction(copiedSource, "owner");
    expect(() =>
      collectIrDirectCallLoweringPlansByIdentity(copiedOwner, ownerUnitId, {
        identityContext: graph.identityContext,
        resolver: graph.resolver,
        activeOwnerUnitIds,
        signaturesByUnitId,
        targetsByLegacyName: new Map([["target", exactTarget]]),
      }),
    ).toThrow("detached from exact source");
    (copiedOwner as ts.FunctionDeclaration & { parent: ts.Node }).parent = sourceFile;
    expect(() =>
      collectIrDirectCallLoweringPlansByIdentity(copiedOwner, ownerUnitId, {
        identityContext: graph.identityContext,
        resolver: graph.resolver,
        activeOwnerUnitIds,
        signaturesByUnitId,
        targetsByLegacyName: new Map([["target", exactTarget]]),
      }),
    ).toThrow("copied or stale AST node");

    const duplicate = checkedIdentityFixture(
      {
        "/repo/a.ts": `export function target(value: number): number { return value + 1; } export function owner(): number { return target(1); }`,
        "/repo/b.ts": `export function target(value: number): number { return value + 2; }`,
      },
      "/repo/a.ts",
    );
    const a = duplicate.byName.get("/repo/a.ts")!;
    const b = duplicate.byName.get("/repo/b.ts")!;
    const duplicateOwner = namedFunction(a, "owner");
    const duplicateOwnerId = duplicate.identityContext.unitIdByDeclaration.get(duplicateOwner)!;
    const localTarget = namedFunction(a, "target");
    const localTargetId = duplicate.identityContext.unitIdByDeclaration.get(localTarget)!;
    const foreignTarget = namedFunction(b, "target");
    const foreignTargetId = duplicate.identityContext.unitIdByDeclaration.get(foreignTarget)!;
    const duplicateCall = firstDescendant(duplicateOwner, ts.isCallExpression);
    if (!ts.isIdentifier(duplicateCall.expression)) throw new Error("expected an identifier call");
    expect(duplicate.resolver.resolveTopLevelFunctionValueTarget(duplicateCall.expression)).toMatchObject({
      targetUnitId: localTargetId,
      legacyProjection: "ambiguous",
    });
    const localPlans = collectIrDirectCallLoweringPlansByIdentity(duplicateOwner, duplicateOwnerId, {
      identityContext: duplicate.identityContext,
      resolver: duplicate.resolver,
      activeOwnerUnitIds: new Set(duplicate.identityContext.terminalByUnitId.keys()),
      signaturesByUnitId: new Map([[localTargetId, NUMBER_SIGNATURE]]),
      targetsByLegacyName: new Map([
        [
          "target",
          {
            target: irUnitFuncRef({ unitId: localTargetId, name: "target" }),
            signature: NUMBER_SIGNATURE,
          },
        ],
      ]),
    });
    expect(localPlans.size).toBe(1);
    expect([...localPlans.values()][0]).toMatchObject({
      target: { binding: { kind: "unit", unitId: localTargetId }, name: "target" },
    });
    expect(() =>
      collectIrDirectCallLoweringPlansByIdentity(duplicateOwner, duplicateOwnerId, {
        identityContext: duplicate.identityContext,
        resolver: duplicate.resolver,
        activeOwnerUnitIds: new Set(duplicate.identityContext.terminalByUnitId.keys()),
        signaturesByUnitId: new Map([[foreignTargetId, NUMBER_SIGNATURE]]),
        targetsByLegacyName: new Map([
          [
            "target",
            {
              target: irUnitFuncRef({ unitId: foreignTargetId, name: "target" }),
              signature: NUMBER_SIGNATURE,
            },
          ],
        ]),
      }),
    ).toThrow("disagrees with its retained source identity");

    const imported = checkedIdentityFixture(
      {
        "/repo/entry.ts": `import { target } from "./lib"; export function owner(): number { return target(1); }`,
        "/repo/lib.ts": `export function target(value: number): number { return value + 1; }`,
      },
      "/repo/entry.ts",
    );
    const importedEntry = imported.byName.get("/repo/entry.ts")!;
    const importedTarget = namedFunction(imported.byName.get("/repo/lib.ts")!, "target");
    const importedOwner = namedFunction(importedEntry, "owner");
    const importedTargetId = imported.identityContext.unitIdByDeclaration.get(importedTarget)!;
    expect(
      collectIrDirectCallLoweringPlansByIdentity(
        importedOwner,
        imported.identityContext.unitIdByDeclaration.get(importedOwner)!,
        {
          identityContext: imported.identityContext,
          resolver: imported.resolver,
          activeOwnerUnitIds: new Set(imported.identityContext.terminalByUnitId.keys()),
          signaturesByUnitId: new Map([[importedTargetId, NUMBER_SIGNATURE]]),
          targetsByLegacyName: new Map([
            [
              "target",
              {
                target: irUnitFuncRef({ unitId: importedTargetId, name: "target" }),
                signature: NUMBER_SIGNATURE,
              },
            ],
          ]),
        },
      ).size,
    ).toBe(0);

    for (const shadowingSource of [
      `function target(): number { return 1; } export function owner(): number { const target = () => 2; return target(); }`,
      `function target(): number { return 1; } target = function (): number { return 2; }; export function owner(): number { return target(); }`,
    ]) {
      const shadowed = checkedIdentityFixture({ "/repo/entry.ts": shadowingSource });
      const shadowedSource = shadowed.byName.get("/repo/entry.ts")!;
      const shadowedOwner = namedFunction(shadowedSource, "owner");
      const shadowedTarget = namedFunction(shadowedSource, "target");
      const shadowedOwnerId = shadowed.identityContext.unitIdByDeclaration.get(shadowedOwner)!;
      const shadowedTargetId = shadowed.identityContext.unitIdByDeclaration.get(shadowedTarget)!;
      expect(
        collectIrDirectCallLoweringPlansByIdentity(shadowedOwner, shadowedOwnerId, {
          identityContext: shadowed.identityContext,
          resolver: shadowed.resolver,
          activeOwnerUnitIds: new Set(shadowed.identityContext.terminalByUnitId.keys()),
          signaturesByUnitId: new Map([[shadowedTargetId, NUMBER_SIGNATURE]]),
          targetsByLegacyName: new Map([
            [
              "target",
              {
                target: irUnitFuncRef({ unitId: shadowedTargetId, name: "target" }),
                signature: NUMBER_SIGNATURE,
              },
            ],
          ]),
        }).size,
      ).toBe(0);
    }
  });

  it("reuses only an identical authenticated row from a second producer", () => {
    const plan: IrDirectCallLoweringPlan = {
      ownerUnitId: OWNER_ID,
      target: irUnitFuncRef({ unitId: TARGET_ID, name: "target" }),
      signature: NUMBER_SIGNATURE,
    };
    expect(irDirectCallLoweringPlanEquals(plan, { ...plan })).toBe(true);
    expect(irDirectCallLoweringPlanEquals(plan, { ...plan, ownerUnitId: STALE_OWNER_ID })).toBe(false);
    expect(
      irDirectCallLoweringPlanEquals(plan, {
        ...plan,
        target: irUnitFuncRef({ unitId: STALE_OWNER_ID, name: "target" }),
      }),
    ).toBe(false);
    expect(
      irDirectCallLoweringPlanEquals(plan, {
        ...plan,
        target: irUnitFuncRef({ unitId: TARGET_ID, name: "renamed" }),
      }),
    ).toBe(false);
    expect(irDirectCallLoweringPlanEquals(plan, { ...plan, signature: VOID_SIGNATURE })).toBe(false);
  });

  it("fails closed when full and remaining prepared projections disagree for one AST call", () => {
    const declaration = sourceFunction(`export function owner(): number { return target(); }`);
    const call = firstDescendant(declaration, ts.isCallExpression);
    const plan: IrDirectCallLoweringPlan = {
      ownerUnitId: OWNER_ID,
      target: irUnitFuncRef({ unitId: TARGET_ID, name: "target" }),
      signature: NUMBER_SIGNATURE,
    };
    expect(
      mergePreparedIrDirectCallLoweringPlans(new Map([[call, plan]]), new Map([[call, { ...plan }]])).get(call),
    ).toBe(plan);

    for (const divergent of [
      { ...plan, ownerUnitId: STALE_OWNER_ID },
      { ...plan, target: irUnitFuncRef({ unitId: STALE_OWNER_ID, name: "target" }) },
      { ...plan, target: irUnitFuncRef({ unitId: TARGET_ID, name: "renamed" }) },
      { ...plan, signature: VOID_SIGNATURE },
    ]) {
      expect(() =>
        mergePreparedIrDirectCallLoweringPlans(new Map([[call, plan]]), new Map([[call, divergent]])),
      ).toThrow(/prepared IR direct-call projections disagree/);
    }
  });
});
