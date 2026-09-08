// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle, type TypeFact } from "../src/checker/oracle.js";
import { ts } from "../src/ts-api.js";
import { DifferentialOracle, DivergenceLedger } from "../src/checker/oracle-backend.js";

function returnFact(source: string): TypeFact {
  const ast = analyzeSource(source, "higher-order-signature.ts");
  const fn = ast.sourceFile.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "factory",
  );
  if (!fn) throw new Error("missing factory control");
  const signature = new TsCheckerOracle(ast.checker).signatureOf(fn);
  if (!signature) throw new Error("missing factory signature");
  return signature.returns;
}

it("retains the inferred callback boundary of a cached parenthesizer", () => {
  expect(
    returnFact(`
    interface Expression { kind: number; }
    let cache: Map<number, (node: Expression) => Expression> | undefined;
    function factory(operator: number) {
      cache ||= new Map();
      let rule = cache.get(operator);
      if (!rule) { rule = node => node; cache.set(operator, rule); }
      return rule;
    }
  `),
  ).toEqual({
    kind: "function",
    signature: {
      params: [{ kind: "class", name: "Expression" }],
      returns: { kind: "class", name: "Expression" },
      declaredArity: 1,
    },
  });
});

it("uses instantiated callback parameter symbols rather than generic declarations", () => {
  expect(
    returnFact(`
    interface Callback<T> { (value: T): T; }
    declare const callback: Callback<number>;
    function factory() { return callback; }
  `),
  ).toEqual({
    kind: "function",
    signature: { params: [{ kind: "number" }], returns: { kind: "number" }, declaredArity: 1 },
  });
});

it("retains multiple higher-order return levels", () => {
  expect(returnFact(`function factory() { return (n: number) => (b: boolean) => n > 0 && b; }`)).toEqual({
    kind: "function",
    signature: {
      params: [{ kind: "number" }],
      returns: {
        kind: "function",
        signature: { params: [{ kind: "boolean" }], returns: { kind: "boolean" }, declaredArity: 1 },
      },
      declaredArity: 1,
    },
  });
});

it.each([
  "interface Callback { (x: number): number; (x: string): string; }",
  "interface Callback { <T>(x: T): T; }",
  "interface Callback { (x?: number): number; }",
  "interface Callback { (...xs: number[]): number; }",
  "interface Callback { (this: { value: number }, x: number): number; }",
  "interface Callback { new (x: number): { value: number }; }",
])("does not invent a fixed-arity closure signature for %s", (declaration) => {
  expect(
    returnFact(`${declaration} declare const callback: Callback; function factory() { return callback; }`),
  ).toEqual({ kind: "function" });
});

it("bounds recursive callable facts without inventing a terminal result", () => {
  let fact = returnFact(
    `interface Callback { (): Callback; } declare const c: Callback; function factory() { return c; }`,
  );
  let levels = 0;
  while (fact.kind === "function" && fact.signature) {
    levels++;
    fact = fact.signature.returns;
  }
  expect(levels).toBeGreaterThan(0);
  expect(levels).toBeLessThanOrEqual(6);
  expect(fact).toEqual({ kind: "function" });
});

it("does not report agreement after erasing a returned callback signature", () => {
  const ast = analyzeSource("function factory() { return (x: number) => x; }", "signature-comparison.ts");
  const primary = new TsCheckerOracle(ast.checker);
  const candidate = new TsCheckerOracle(ast.checker);
  candidate.signatureOf = () => ({ params: [], returns: { kind: "function" }, declaredArity: 0 });
  const ledger = new DivergenceLedger();
  const oracle = new DifferentialOracle(primary, candidate, ledger);
  const fn = ast.sourceFile.statements[0]!;
  expect(oracle.signatureOf(fn)).toEqual(primary.signatureOf(fn));
  expect(ledger.agreements).toBe(0);
  expect(ledger.samples).toHaveLength(1);
  expect(ledger.samples[0]).toMatchObject({
    query: "signatureOf",
    checker: "()->function<(number)->number#1>#0",
    inhouse: "()->function#0",
  });
});

it("bounds branching callable expansion as well as recursion depth", () => {
  const declarations = ["type C0 = (value: number) => number;"];
  for (let level = 1; level <= 5; level++) {
    declarations.push(`type C${level} = (a: C${level - 1}, b: C${level - 1}, c: C${level - 1}) => C${level - 1};`);
  }
  const fact = returnFact(`${declarations.join("\n")} declare const c: C5; function factory() { return c; }`);
  function countSignatures(position: TypeFact): number {
    return position.kind === "function" && position.signature
      ? 1 +
          position.signature.params.reduce((sum, param) => sum + countSignatures(param), 0) +
          countSignatures(position.signature.returns)
      : 0;
  }
  expect(countSignatures(fact)).toBe(64);
  // Truncation must be explicit, not a fabricated zero-argument signature.
  expect(fact.kind === "function" && fact.signature?.returns).toEqual({ kind: "function" });
});
