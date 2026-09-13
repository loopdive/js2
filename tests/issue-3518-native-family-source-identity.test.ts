// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildIrProgramCallableBindingGraph } from "../src/ir/program-callable-bindings.js";
import { makeIrPromiseDelayResolver } from "../src/ir/promise-delay.js";
import {
  collectIrPromiseDelayOwners,
  buildIrPromiseDelayLoweringPlans,
  validateNativePromiseDelaySupportByIdentity,
  type IrPromiseDelayLoweringPlan,
} from "../src/ir/promise-delay-lowering.js";
import { prepareNativeAsyncSourceFamilies } from "../src/ir/program-native-async-source.js";
import { buildNativeFamilyLogicalVectors } from "../src/ir/program-logical-types.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import * as lowerer from "../src/ir/from-ast.js";

const ORIGINAL = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
afterEach(() => vi.restoreAllMocks());

function fixture(text = ORIGINAL, reverse = false, other?: string) {
  const input = sourceInput(other ? { "./entry.ts": text, "./other.ts": other } : { "./entry.ts": text }, reverse);
  const inventory = buildIrUnitInventory(input.sourceFiles, { checker: input.checker, entrySource: input.entrySource });
  const identity = buildIrPlanningIdentityContext(inventory);
  const callGraph = buildIrProgramCallableBindingGraph({
    checker: input.checker,
    sourceFiles: input.sourceFiles,
    identityContext: identity,
  });
  const certifiedDelays = new Map<IrUnitId, IrPromiseDelayLoweringPlan>();
  const resolver = makeIrPromiseDelayResolver(input.checker);
  const support: IrUnitId[] = [];
  for (const source of input.sourceFiles) {
    const selected = new Set(
      inventory.terminalUnits
        .filter((unit) => unit.sourceId === identity.sourceIdBySourceFile.get(source) && unit.kind !== "module-init")
        .map((unit) => unit.id),
    );
    const owners = collectIrPromiseDelayOwners(source, selected, resolver, identity);
    const plans = buildIrPromiseDelayLoweringPlans(owners, selected, identity, "standalone-native");
    support.push(...validateNativePromiseDelaySupportByIdentity(source, identity, plans).map((unit) => unit.id));
    for (const plan of plans.constructions.values()) certifiedDelays.set(plan.ownerUnitId, plan);
  }
  const diagnostic: { active: IrUnitId | undefined } = { active: undefined };
  const familyInput = { checker: input.checker, identity, callGraph, certifiedDelays, diagnostic };
  const family = prepareNativeAsyncSourceFamilies(familyInput);
  return { input, inventory, identity, familyInput, family, support };
}
function owned(f: ReturnType<typeof fixture>, name: string) {
  const plan = [...f.family.functions.values()].find((entry) => entry.declaration.name?.text === name);
  expect(plan, name).toBeDefined();
  return plan!;
}
function failure(text: string) {
  const input = {
    ...sourceInput({ "./entry.ts": text }),
    promiseDelayProjection: "standalone-native" as const,
    asyncFamilyProjection: "standalone-native" as const,
  };
  const lower = vi.spyOn(lowerer, "lowerFunctionAstToIr");
  const result = prepareIrProgramSources(input);
  expect(result.kind, JSON.stringify(result)).not.toBe("prepared");
  if (result.kind === "prepared") throw new Error("foreign source was certified");
  expect(result.unitId).toBeTruthy();
  expect(result.sourceFile).toBeTruthy();
  expect(result.location.declarationEnd).toBeGreaterThan(result.location.declarationStart);
  expect(result.detail.length).toBeGreaterThan(0);
  expect(lower).not.toHaveBeenCalled();
  return result;
}

describe("checker-bound native family source facts", () => {
  it("constructs the exact nonempty per-function vector-map denominator", () => {
    const f = fixture();
    expect(f.support).toHaveLength(2);
    expect(f.family.functions.size).toBe(5);
    expect(
      [...f.family.functions.values()].map((plan) => [plan.declaration.name!.text, plan.logicalVectorTypes.size]),
    ).toEqual([
      ["delay", 0],
      ["fetchUser", 0],
      ["fetchAllSequential", 3],
      ["fetchAllParallel", 11],
      ["main", 4],
    ]);
    let parameters = 0,
      variables = 0,
      literals = 0,
      awaits = 0,
      reads = 0;
    for (const plan of f.family.functions.values())
      for (const [node, type] of plan.logicalVectorTypes) {
        expect(node.getSourceFile()).toBe(plan.declaration.getSourceFile());
        expect(Object.keys(type).sort()).toEqual(["elementType", "kind", "nullable"]);
        expect(type.elementType.kind).toBe("val");
        if (ts.isParameter(node)) {
          parameters++;
          expect(type.nullable).toBe(true);
        } else if (ts.isVariableDeclaration(node)) {
          variables++;
          expect(type.nullable).toBe(true);
        } else if (ts.isArrayLiteralExpression(node)) {
          literals++;
          expect(type.nullable).toBe(false);
        } else if (ts.isAwaitExpression(node)) {
          awaits++;
          expect(type.nullable).toBe(true);
        } else {
          expect(ts.isIdentifier(node)).toBe(true);
          reads++;
        }
      }
    expect({ parameters, variables, literals, awaits, reads }).toEqual({
      parameters: 2,
      variables: 3,
      literals: 2,
      awaits: 1,
      reads: 10,
    });
    expect(() => f.family.assertCurrent()).not.toThrow();
  });

  it("separates nullable declarations, non-null literal reads, await vectors and Promise carriers", () => {
    const f = fixture();
    const parallel = owned(f, "fetchAllParallel");
    const pending = [...parallel.logicalVectorTypes].filter(
      ([node]) => ts.isIdentifier(node) && node.text === "pending",
    );
    expect(pending).toHaveLength(2);
    expect(
      pending.every(
        ([, type]) => !type.nullable && type.elementType.kind === "val" && type.elementType.val.kind === "externref",
      ),
    ).toBe(true);
    const awaitEntry = [...parallel.awaitSites][0]!;
    expect(awaitEntry[1]).toEqual({
      operandType: { kind: "val", val: { kind: "externref" } },
      resultType: { kind: "vec", elementType: { kind: "val", val: { kind: "f64" } }, nullable: true },
    });
    expect(parallel.logicalVectorTypes.has(awaitEntry[0])).toBe(true);
    expect(parallel.logicalVectorTypes.has(awaitEntry[0].expression)).toBe(false);
    const fetch = owned(f, "fetchUser");
    expect([...fetch.awaitSites.values()]).toEqual([
      { operandType: { kind: "extern", className: "Promise" }, resultType: { kind: "val", val: { kind: "f64" } } },
    ]);
    const main = owned(f, "main");
    expect(main.result).toBeNull();
    expect(main.params).toEqual([]);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isIdentifier(node) &&
          (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent)) &&
          node.parent.name === node) ||
        ts.isTypeNode(node) ||
        (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      )
        expect(main.logicalVectorTypes.has(node as ts.Expression)).toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(main.declaration);
  });

  it("indexes admitted parenthesized vector reads alongside their original inner nodes", () => {
    const source = ORIGINAL.replaceAll("ids.length", "(ids).length")
      .replace("pending.push", "(pending).push")
      .replace("Promise.all(pending)", "Promise.all((pending))");
    const f = fixture(source);
    const wrappers = [...f.family.functions.values()].flatMap((plan) =>
      [...plan.logicalVectorTypes].filter(([node]) => ts.isParenthesizedExpression(node)),
    );
    expect(wrappers).toHaveLength(4);
    for (const [node, type] of wrappers) {
      if (!ts.isParenthesizedExpression(node)) throw new Error("missing wrapper");
      const plan = [...f.family.functions.values()].find((entry) => entry.logicalVectorTypes.has(node))!;
      expect(plan.logicalVectorTypes.get(node.expression)).toBe(type);
    }
  });

  it("uses checker dependency edges even when every family function is renamed", () => {
    const renamed = ORIGINAL.replace(
      /\b(delay|fetchUser|fetchAllSequential|fetchAllParallel|main)\b/g,
      (name) =>
        ({
          delay: "pause",
          fetchUser: "lookup",
          fetchAllSequential: "series",
          fetchAllParallel: "batch",
          main: "entry",
        })[name]!,
    );
    const f = fixture(renamed);
    expect([...f.family.functions.values()].map((plan) => plan.declaration.name!.text)).toEqual([
      "pause",
      "lookup",
      "series",
      "batch",
      "entry",
    ]);
    expect([...f.family.functions.values()].reduce((n, plan) => n + plan.awaitSites.size, 0)).toBe(5);
  });

  it("keeps same-name families in separate sources disjoint under source-order reversal", () => {
    const forward = fixture(ORIGINAL, false, ORIGINAL);
    const reverse = fixture(ORIGINAL, true, ORIGINAL);
    expect(forward.family.functions.size).toBe(10);
    expect(forward.support).toHaveLength(4);
    expect([...forward.family.functions.keys()].sort()).toEqual([...reverse.family.functions.keys()].sort());
    for (const plan of forward.family.functions.values()) {
      const sourceId = forward.identity.sourceIdBySourceFile.get(plan.declaration.getSourceFile());
      for (const node of plan.logicalVectorTypes.keys())
        expect(forward.identity.sourceIdBySourceFile.get(node.getSourceFile())).toBe(sourceId);
    }
    const a = prepareIrProgramSources({
      ...forward.input,
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    });
    const b = prepareIrProgramSources({
      ...reverse.input,
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    });
    expect(a.kind, JSON.stringify(a)).toBe("prepared");
    expect(b.kind, JSON.stringify(b)).toBe("prepared");
    if (a.kind !== "prepared" || b.kind !== "prepared") throw new Error("source-order control failed");
    expect(captureTypedIrProgramInput(a)).toEqual(captureTypedIrProgramInput(b));
  });

  it.each(["return;", "return undefined;", "return ((undefined));", "if (seq > 0) { return undefined; }"])(
    "preserves main's zero-result contract with %s",
    (statement) => {
      const text = ORIGINAL.replace('console.log("done");', `console.log("done"); ${statement}`);
      expect(text).not.toBe(ORIGINAL);
      const f = fixture(text);
      expect(owned(f, "main").result).toBeNull();
      expect(() => f.family.assertCurrent()).not.toThrow();
      const result = prepareIrProgramSources({
        ...f.input,
        promiseDelayProjection: "standalone-native",
        asyncFamilyProjection: "standalone-native",
      });
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw new Error(result.detail);
      expect(result.ir.functions.find((fn) => fn.name === "main")!.resultTypes).toEqual([]);
    },
  );

  it.each([
    "export function f(): void { const undefined = 42; return undefined; }",
    "export function f(undefined: number): void { return undefined; }",
    "const undefined = 42; export function f(): void { return undefined; }",
  ])("does not certify a shadowed undefined read in direct lowering: %s", (text) => {
    const input = sourceInput({ "./entry.ts": text });
    const inventory = buildIrUnitInventory(input.sourceFiles, {
      checker: input.checker,
      entrySource: input.entrySource,
    });
    const identity = buildIrPlanningIdentityContext(inventory);
    const owner = inventory.terminalUnits.find((unit) => unit.displayName === "f")!;
    const declaration = identity.declarationByUnitId.get(owner.id)!;
    if (!ts.isFunctionDeclaration(declaration)) throw new Error("missing actual function");
    const lower = () =>
      lowerer.lowerFunctionAstToIr(declaration, {
        ownerUnitId: owner.id,
        funcName: "f",
        identityContext: identity,
        checker: input.checker,
        returnTypeOverride: null,
      });
    if (text.startsWith("const")) {
      // Without a module-binding resolver, the historical unresolved read must
      // remain a failure instead of disappearing as a fabricated global value.
      expect(lower).toThrow('identifier "undefined" is not in scope');
    } else {
      // Local and parameter bindings must bypass the new ambient query entirely.
      const originalResolve = input.checker.resolveName.bind(input.checker);
      vi.spyOn(input.checker, "resolveName").mockImplementation((name, location, meaning, excludeGlobals) => {
        if (name === "undefined" && location === undefined) throw new Error("shadowed read reached ambient guard");
        return originalResolve(name, location, meaning, excludeGlobals);
      });
      expect(lower).not.toThrow();
    }
  });

  it("retains the unsupported undefined read when the lowerer has no checker", () => {
    const text = ORIGINAL.replace('console.log("done");', 'console.log("done"); return undefined;');
    const input = sourceInput({ "./entry.ts": text });
    const originalLower = lowerer.lowerFunctionAstToIr;
    vi.spyOn(lowerer, "lowerFunctionAstToIr").mockImplementation((node, options) =>
      originalLower(node, { ...options, checker: undefined }),
    );
    const result = prepareIrProgramSources({
      ...input,
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    });
    expect(result).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", stage: "build" });
    if (result.kind === "prepared") throw new Error("unchecked undefined was discarded");
    expect(result.detail).toContain('identifier "undefined" is not in scope in main');
  });

  it.each([
    "return void Date.now();",
    "return (Date.now(), undefined);",
    "const undefined: undefined = globalThis.undefined; return undefined;",
  ])("rejects an unproven zero-result return without discarding expression effects: %s", (statement) => {
    const text = ORIGINAL.replace('console.log("done");', `console.log("done"); ${statement}`);
    expect(text).not.toBe(ORIGINAL);
    expect(failure(text).detail).toContain("effect-free bare or ambient undefined return");
  });

  it.each([
    ["valued void return", ORIGINAL.replace('console.log("done");', 'console.log("done"); return 42;')],
    ["bare numeric return", ORIGINAL.replace("return v;", "return;")],
    [
      "shadowed Date",
      ORIGINAL.replace(
        "export async function main(): Promise<void> {",
        "export async function main(): Promise<void> { const Date = globalThis.Date;",
      ),
    ],
    [
      "shadowed console",
      ORIGINAL.replace(
        "export async function main(): Promise<void> {",
        "export async function main(): Promise<void> { const console = globalThis.console;",
      ),
    ],
    [
      "aliased Promise.all receiver",
      ORIGINAL.replace(
        "const results = await Promise.all(pending);",
        "const replacement = Promise; const results = await replacement.all(pending);",
      ),
    ],
    ["wrong vector element", ORIGINAL.replaceAll("ids: number[]", "ids: string[]")],
    ["unknown vector element", ORIGINAL.replaceAll("ids: number[]", "ids: unknown[]")],
    ["wrong pending element", ORIGINAL.replace("pending: Promise<number>[]", "pending: Promise<string>[]")],
    [
      "wrong fulfillment",
      ORIGINAL.replace("fetchUser(id: number): Promise<number>", "fetchUser(id: number): Promise<string>"),
    ],
    ["mismatched await operand", ORIGINAL.replace("await delay(30, id * 10)", "await (id * 10)")],
    ["missing await owner", ORIGINAL.replace("const seq = await fetchAllSequential(ids)", "const seq = 150")],
    [
      "missing five-part concat",
      ORIGINAL.replace(
        '"sequential sum = " + seq.toString() + " (took ~" + (t1 - t0).toString() + "ms)"',
        '"sequential sum"',
      ),
    ],
    [
      "shadowed Promise constructor",
      ORIGINAL.replace(
        "function delay(ms: number, value: number): Promise<number> {",
        "function delay(ms: number, value: number): Promise<number> { const Promise = globalThis.Promise;",
      ),
    ],
    ["removed timer support", ORIGINAL.replace("setTimeout(() => resolve(value), ms);", "setTimeout(resolve, ms);")],
  ])("rejects %s as located source evidence before lowering", (_name, text) => {
    failure(text);
  });

  it.each([
    "clear owner map",
    "remove vector entry",
    "replace vector map",
    "clear awaits",
    "wrong await operand",
    "physical vector layout",
    "changed source",
    "detached site",
  ] as const)("rejects stale %s without trusting unchanged counts or printed names", (mode) => {
    const f = fixture();
    const plan = owned(f, "fetchAllParallel");
    if (mode === "clear owner map") {
      expect(f.family.functions).toBeInstanceOf(Map);
      (f.family.functions as Map<unknown, unknown>).clear();
    } else if (mode === "remove vector entry") {
      expect(plan.logicalVectorTypes).toBeInstanceOf(Map);
      (plan.logicalVectorTypes as Map<unknown, unknown>).delete([...plan.logicalVectorTypes.keys()][0]);
    } else if (mode === "replace vector map")
      expect(Reflect.set(plan, "logicalVectorTypes", new Map(plan.logicalVectorTypes))).toBe(true);
    else if (mode === "clear awaits") {
      expect(plan.awaitSites).toBeInstanceOf(Map);
      (plan.awaitSites as Map<unknown, unknown>).clear();
    } else if (mode === "wrong await operand")
      expect(Reflect.set([...plan.awaitSites.values()][0]!, "operandType", { kind: "val", val: { kind: "f64" } })).toBe(
        true,
      );
    else if (mode === "physical vector layout")
      expect(Reflect.set([...plan.logicalVectorTypes.values()][0]!, "layout", { carrierType: 12 })).toBe(true);
    else if (mode === "changed source")
      expect(Reflect.set(plan.declaration.getSourceFile(), "text", ORIGINAL + "\n")).toBe(true);
    else {
      const node = [...plan.awaitSites.keys()][0]!;
      const parent = node.parent;
      expect(ts.isVariableDeclaration(parent)).toBe(true);
      expect(Reflect.set(parent, "initializer", ts.factory.createNumericLiteral(0))).toBe(true);
    }
    expect(() => f.family.assertCurrent()).toThrow();
  });

  it("prevents changing frozen owner spans or replacing immutable identity views", () => {
    const f = fixture();
    const plan = owned(f, "fetchAllParallel");
    const record = f.identity.terminalByUnitId.get(plan.unitId)!;
    const start = record.declarationStart;
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(f.identity)).toBe(true);
    expect(Object.isFrozen(f.identity.terminalByUnitId)).toBe(true);
    expect(f.identity.terminalByUnitId).not.toBeInstanceOf(Map);
    expect(Reflect.has(f.identity.terminalByUnitId, "set")).toBe(false);
    expect(Reflect.set(record, "declarationStart", start + 1)).toBe(false);
    expect(Reflect.set(f.identity, "terminalByUnitId", new Map(f.identity.terminalByUnitId))).toBe(false);
    expect(Reflect.set(f.identity, "unitByUnitId", new Map(f.identity.unitByUnitId))).toBe(false);
    expect(f.identity.terminalByUnitId.get(plan.unitId)).toBe(record);
    expect(record.declarationStart).toBe(start);
    expect(() => f.family.assertCurrent()).not.toThrow();
  });

  it("rejects replacing a resolver with the same original methods", () => {
    const f = fixture();
    const plan = owned(f, "fetchAllParallel");
    const resolver = plan.resolver;
    expect(Reflect.set(plan, "resolver", { ...resolver })).toBe(true);
    expect(plan.resolver).not.toBe(resolver);
    expect(() => f.family.assertCurrent()).toThrow("source plan field or callable identity changed");
  });

  it.each([
    "preparedAsyncAwaitSite",
    "preparedAsyncPromiseAllPlan",
    "preparedAsyncThenableResultType",
    "preparedAsyncDateNowTarget",
    "preparedAsyncNumberToStringTarget",
    "preparedAsyncConsoleTarget",
    "preparedAsyncConcatFiveTarget",
  ] as const)("rejects replacing resolver method %s independently", (method) => {
    const f = fixture();
    const plan = owned(f, "fetchAllParallel");
    const original = plan.resolver[method];
    expect(typeof original).toBe("function");
    expect(Reflect.set(plan.resolver, method, () => null)).toBe(true);
    expect(plan.resolver[method]).not.toBe(original);
    expect(() => f.family.assertCurrent()).toThrow("source plan field or callable identity changed");
  });

  it.each(["__ir_async_promise_all_native", "__ir_async_promise_all_foreign"])(
    "rejects replacing Promise.all's target with another canonical ref %s",
    (symbol) => {
      const f = fixture();
      const plan = owned(f, "fetchAllParallel");
      const call = [...plan.awaitSites.keys()][0]!.expression;
      if (!ts.isCallExpression(call)) throw new Error("missing original Promise.all call");
      const all = plan.resolver.preparedAsyncPromiseAllPlan!(call)!;
      expect(all).toBeDefined();
      const target = all.target;
      expect(Reflect.set(all, "target", irRuntimeFuncRef(symbol))).toBe(true);
      expect(all.target).not.toBe(target);
      expect(() => f.family.assertCurrent()).toThrow("source plan field or callable identity changed");
    },
  );

  it.each(["callee", "member", "argument", "argument array", "identifier text"] as const)(
    "rejects a same-object call with changed certified %s",
    (mode) => {
      const f = fixture();
      const plan = owned(f, "fetchAllParallel");
      const awaitNode = [...plan.awaitSites.keys()][0]!;
      const call = awaitNode.expression;
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression))
        throw new Error("missing original Promise.all call");
      const printed = call.getText();
      if (mode === "callee")
        expect(Reflect.set(call, "expression", ts.factory.createPropertyAccessExpression("Promise", "race"))).toBe(
          true,
        );
      else if (mode === "member")
        expect(Reflect.set(call.expression, "name", ts.factory.createIdentifier("race"))).toBe(true);
      else if (mode === "argument")
        expect(Reflect.set(call.arguments, "0", ts.factory.createIdentifier("other"))).toBe(true);
      else if (mode === "argument array")
        expect(Reflect.set(call, "arguments", ts.factory.createNodeArray([...call.arguments]))).toBe(true);
      else expect(Reflect.set(call.expression.name, "escapedText", "race")).toBe(true);
      expect(awaitNode.expression).toBe(call);
      expect(call.getText()).toBe(printed);
      expect(() => f.family.assertCurrent()).toThrow("certified source syntax, operand or target changed");
    },
  );

  it("will not fabricate logical vector entries for a foreign function's await", () => {
    const f = fixture();
    const parallel = owned(f, "fetchAllParallel");
    const main = owned(f, "main");
    expect(() => buildNativeFamilyLogicalVectors(f.input.checker, main.declaration, parallel.awaitSites)).toThrow();
  });
});
