// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { makeIrLocalClassExpressionResolver } from "../src/ir/module-bindings.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import { ts } from "../src/ts-api.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";
import { createTestIrClassId } from "./helpers/ir-identities.js";

function projected(name: string): IrClassShape {
  return {
    classId: createTestIrClassId(`issue-3529-class-integration/${name}`),
    className: name,
    fields: [],
    methods: [],
    constructorParams: [],
  };
}

function findNode<T extends ts.Node>(
  source: string,
  predicate: (node: ts.Node) => node is T,
): { readonly ast: ReturnType<typeof analyzeSource>; readonly node: T } {
  const ast = analyzeSource(source, "class-expression-evidence.ts");
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(ast.sourceFile);
  expect(found).toBeDefined();
  return { ast, node: found! };
}

describe("#3529 exact local-class integration", () => {
  it("resolves only provenance-safe projected class instances", () => {
    const conditional = findNode(
      `class Value { n: number; constructor(n: number) { this.n = n; } }
       export function read(flag: boolean): number {
         const value = flag ? new Value(1) : new Value(2);
         return value.n;
       }`,
      ts.isConditionalExpression,
    );
    const resolveConditional = makeIrLocalClassExpressionResolver(
      conditional.ast.checker,
      conditional.ast.sourceFile,
      new Map([["Value", projected("Value")]]),
    );
    expect(resolveConditional(conditional.node)).toBe("Value");

    const parameter = findNode(
      `class Value { n: number; }
       export function read(value: Value): number { return value.n; }`,
      (candidate): candidate is ts.Identifier =>
        ts.isIdentifier(candidate) &&
        candidate.text === "value" &&
        ts.isPropertyAccessExpression(candidate.parent) &&
        candidate.parent.expression === candidate,
    );
    const resolveParameter = makeIrLocalClassExpressionResolver(
      parameter.ast.checker,
      parameter.ast.sourceFile,
      new Map([["Value", projected("Value")]]),
    );
    expect(resolveParameter(parameter.node)).toBe("Value");

    for (const source of [
      `class Value { n: number; }
       type Alias = Value;
       export function read(value: Alias): number { return value.n; }`,
      `class Value { n: number; }
       const fake: Value = 1 as any;
       export function read(): number { return fake.n; }`,
    ]) {
      const { ast, node } = findNode(
        source,
        (candidate): candidate is ts.Identifier =>
          ts.isIdentifier(candidate) &&
          (candidate.text === "value" || candidate.text === "fake") &&
          ts.isPropertyAccessExpression(candidate.parent) &&
          candidate.parent.expression === candidate,
      );
      const resolve = makeIrLocalClassExpressionResolver(
        ast.checker,
        ast.sourceFile,
        new Map([["Value", projected("Value")]]),
      );
      expect(resolve(node)).toBeUndefined();
    }

    const constructorIdentifier = findNode(
      `class Value { n: number; constructor(n: number) { this.n = n; } }
       export function read(): number { return new Value(1).n; }`,
      (candidate): candidate is ts.Identifier =>
        ts.isIdentifier(candidate) &&
        candidate.text === "Value" &&
        ts.isNewExpression(candidate.parent) &&
        candidate.parent.expression === candidate,
    );
    const resolveConstructor = makeIrLocalClassExpressionResolver(
      constructorIdentifier.ast.checker,
      constructorIdentifier.ast.sourceFile,
      new Map([["Value", projected("Value")]]),
    );
    expect(resolveConstructor(constructorIdentifier.node)).toBeUndefined();

    const constructorObject = findNode(
      `class Value { n: number; }
       const constructor = Value;
       export function read(): number { return 1; }`,
      (candidate): candidate is ts.Identifier =>
        ts.isIdentifier(candidate) &&
        candidate.text === "Value" &&
        ts.isVariableDeclaration(candidate.parent) &&
        candidate.parent.initializer === candidate,
    );
    const resolveConstructorObject = makeIrLocalClassExpressionResolver(
      constructorObject.ast.checker,
      constructorObject.ast.sourceFile,
      new Map([["Value", projected("Value")]]),
    );
    expect(resolveConstructorObject(constructorObject.node)).toBeUndefined();
  });

  it("lowers exact class-typed constructor and method signatures", async () => {
    const result = await compile(
      `class Value {
         n: number;
         constructor(n: number) { this.n = n; }
       }
       class Picker {
         constructor(seed: Value) {}
         choose(value: Value): Value { return value; }
       }
       export function run(): number {
         const picker = new Picker(new Value(1));
         return picker.choose(new Value(42)).n;
       }`,
      { fileName: "class-signature-overrides.ts", experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const displayName of ["Picker_new", "Picker_choose"]) {
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === displayName)).toMatchObject({
        kind: "emitted",
        stage: "patch",
        irBodyEmitted: true,
      });
    }
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(42);
  });

  it("lowers exact class-typed getter and setter signatures", async () => {
    const result = await compile(
      `class Value {
         n: number;
         constructor(n: number) { this.n = n; }
       }
       class Holder {
         get value(): Value { return new Value(42); }
         set value(next: Value) { return; }
       }
       export function run(): number {
         const holder = new Holder();
         holder.value = new Value(1);
         return holder.value.n;
       }`,
      { fileName: "class-accessor-overrides.ts", experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const displayName of ["Holder_get_value", "Holder_set_value"]) {
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === displayName)).toMatchObject({
        kind: "emitted",
        stage: "patch",
        irBodyEmitted: true,
      });
    }
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.run as () => number)()).toBe(42);
  });
});
