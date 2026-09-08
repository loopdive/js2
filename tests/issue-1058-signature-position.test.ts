// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle, type SignaturePositionPath } from "../src/checker/oracle.js";
import { InHouseOracle } from "../src/checker/inhouse-oracle.js";
import { DifferentialOracle, DivergenceLedger } from "../src/checker/oracle-backend.js";
import { ts } from "../src/ts-api.js";

function fixture(source: string) {
  const ast = analyzeSource(source, "signature-position.ts");
  const oracle = new TsCheckerOracle(ast.checker);
  const functions = new Map<string, ts.FunctionDeclaration>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, visit);
  }
  visit(ast.sourceFile);
  function fn(name: string) {
    const declaration = functions.get(name);
    if (!declaration) throw new Error(`missing ${name}`);
    return declaration;
  }
  return { ...ast, oracle, fn };
}

it("finds exact annotations inside an inferred cached callback return", () => {
  const f = fixture(`
    interface Expression { kind: number; parent?: Expression; }
    let cache: Map<number, (node: Expression) => Expression> | undefined;
    function factory(operator: number) {
      cache ||= new Map();
      let rule = cache.get(operator);
      if (!rule) { rule = node => node; cache.set(operator, rule); }
      return rule;
    }
  `);
  const callback = f.oracle.signaturePositionOf(f.fn("factory"), ["return"]);
  expect(callback?.fact.kind).toBe("function");
  expect(callback?.annotation).toBeUndefined(); // The factory has no annotation.
  const param = f.oracle.signaturePositionOf(f.fn("factory"), ["return", 0]);
  const result = f.oracle.signaturePositionOf(f.fn("factory"), ["return", "return"]);
  expect(param?.fact).toEqual({ kind: "class", name: "Expression" });
  expect(param?.annotation?.getText()).toBe("Expression");
  expect(result?.annotation?.getText()).toBe("Expression");
  expect(result?.typeKey).toBe(param?.typeKey);
  expect(param?.annotation && f.oracle.typeKeyOf(param.annotation)).toBe(param?.typeKey);
  expect(f.oracle.signaturePositionOf(f.fn("factory"), ["return", 0])?.typeKey).toBe(param?.typeKey);
});

it("does not use a generic source annotation as an instantiated type witness", () => {
  const f = fixture(`
    interface Callback<T> { (value: T): T; }
    declare const c: Callback<number>;
    function factory() { return c; }
    function scalar(value: number): number { return value; }
  `);
  for (const path of [
    ["return", 0],
    ["return", "return"],
  ] as const) {
    const position = f.oracle.signaturePositionOf(f.fn("factory"), path);
    expect(position?.fact).toEqual({ kind: "number" });
    expect(position?.annotation).toBeUndefined();
    expect(position?.typeKey).toBe(f.oracle.signaturePositionOf(f.fn("scalar"), [0])?.typeKey);
  }
});

it("distinguishes same-named source types in different lexical scopes", () => {
  const f = fixture(`
    namespace A { interface Node { a: number } export function left(value: Node): Node { return value; } }
    namespace B { interface Node { b: string } export function right(value: Node): Node { return value; } }
  `);
  const left = f.oracle.signaturePositionOf(f.fn("left"), [0]);
  const right = f.oracle.signaturePositionOf(f.fn("right"), [0]);
  expect(left?.fact).toEqual(right?.fact);
  expect(left?.annotation?.getText()).toBe("Node");
  expect(right?.annotation?.getText()).toBe("Node");
  expect(left?.typeKey).toBeDefined();
  expect(left?.typeKey).not.toBe(right?.typeKey);
  expect(left?.annotation).not.toBe(right?.annotation);
});

it.each(
  [[], [-1], [0.5], [1], ["return", 0], Array(13).fill("return")].map((path) => ({
    path: path as SignaturePositionPath,
  })),
)("declines an invalid or non-callable position path %j", ({ path }) => {
  const f = fixture("function scalar(value: number): number { return value; }");
  expect(f.oracle.signaturePositionOf(f.fn("scalar"), path)).toBeUndefined();
});

it("does not select the first overload as an exact source boundary", () => {
  const f = fixture(`
    function overloaded(value: number): number;
    function overloaded(value: string): string;
    function overloaded(value: any): any { return value; }
    function generic<T>(value: T): T { return value; }
  `);
  expect(f.oracle.signaturePositionOf(f.fn("overloaded"), [0])).toBeUndefined();
  expect(f.oracle.signaturePositionOf(f.fn("generic"), [0])).toBeUndefined();
});

it("preserves primary identity while recording in-house abstention", () => {
  const f = fixture("function scalar(value: number): number { return value; }");
  const ledger = new DivergenceLedger();
  const candidate = new InHouseOracle();
  const oracle = new DifferentialOracle(f.oracle, candidate, ledger);
  expect(candidate.signaturePositionOf(f.fn("scalar"), [0])).toBeUndefined();
  expect(oracle.signaturePositionOf(f.fn("scalar"), [0])).toEqual(f.oracle.signaturePositionOf(f.fn("scalar"), [0]));
  expect(ledger.weakened).toBe(1);
  expect(ledger.agreements).toBe(0);
});
