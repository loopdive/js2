// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { orderTailFunctionDeclarations } from "../src/ir/tail-function-declarations.js";

it("erases local type declarations without binding or reordering runtime values", async () => {
  const result = await compile(
    `
    export function run(input: number): number {
      interface BinaryPlusExpression { cachedLiteralKind: number; }
      const offset = 2;
      if (input > 0) { type offset = number; interface Local { value: number; } }
      return add(input);
      type Later = BinaryPlusExpression;
      function add(value: number): number { return value + offset; }
      interface Tail { value: number; }
    }
  `,
    { target: "standalone", experimentalIR: true, trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect((new WebAssembly.Instance(module, {}).exports.run as (value: number) => number)(40)).toBe(42);
  expect(
    result.irOutcomes?.find((row) => row.displayName === "run"),
    JSON.stringify(result.irOutcomes),
  ).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
});

it("retains source identities and never moves executable trailing statements", () => {
  const parse = (source: string) => ts.createSourceFile("case.ts", source, ts.ScriptTarget.Latest, true).statements;
  const statements = parse("const x = 2; return add(x); function add(n: number): number { return n; }");
  const ordered = orderTailFunctionDeclarations(statements);
  expect(ordered).toEqual([statements[0], statements[2], statements[1]]);
  expect(ordered[1]).toBe(statements[2]);
  expect(orderTailFunctionDeclarations(ordered)).toBe(ordered);
  const executable = parse("return add(); function add(): number { return 1; } sideEffect();");
  expect(orderTailFunctionDeclarations(executable)).toBe(executable);
  const typed = parse("interface A {} return add(); type B = A; function add(): number { return 1; } interface C {}");
  const erased = orderTailFunctionDeclarations(typed);
  expect(erased).toEqual([typed[3], typed[1]]);
  expect(erased[0]).toBe(typed[3]);
  expect(orderTailFunctionDeclarations(erased)).toBe(erased);
  const runtimeDeclaration = parse("return add(); function add(): number { return 1; } enum E { A }");
  expect(orderTailFunctionDeclarations(runtimeDeclaration)).toBe(runtimeDeclaration);
});

it.each([false, true])("preserves captures in declarations after return (mutable=%s)", async (mutable) => {
  const source = `
    export function run(input: number): number {
      ${mutable ? "let offset = 1; offset++;" : "const offset = 2;"}
      return add(input);
      function add(value: number): number { return value + offset; }
    }
  `;
  const result = await compile(source, { target: "standalone", experimentalIR: true, trackIrOutcomes: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as (value: number) => number)(40)).toBe(42);
  const outcome = result.irOutcomes?.find((row) => row.displayName === "run");
  expect(outcome, JSON.stringify(result.irOutcomes)).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
  });
});

it.each([
  [
    "siblings",
    `let offset = 1;
    function inc(): number { offset++; return offset; }
    function read(): number { return offset; }
    const first = inc(); offset += 3; return first * 100 + read();`,
    205,
  ],
  [
    "escaped read",
    `let offset = 1;
    const read = (): number => offset;
    offset++; return read();`,
    2,
  ],
  [
    "loop writes",
    `let offset = 1;
    const read = (): number => offset;
    for (let i = 0; i < 3; i++) { offset++; }
    return read();`,
    4,
  ],
] as const)("keeps a shared mutable cell across %s", async (_name, body, expected) => {
  const result = await compile(`export function run(): number { ${body} }`, {
    target: "standalone",
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(expected);
  expect(
    result.irOutcomes?.find((row) => row.displayName === "run"),
    JSON.stringify(result.irOutcomes),
  ).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
  });
});
