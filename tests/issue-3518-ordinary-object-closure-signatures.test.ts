// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  resolveOrdinaryObjectClosureSignature,
  type OrdinaryObjectClosureDeclaration,
} from "../src/ir/ordinary-object-closure-signatures.js";

function signatures(source: string) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const declarations: OrdinaryObjectClosureDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    )
      declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast.entryFile);
  expect(declarations.length).toBeGreaterThan(0);
  return declarations.map((node) => resolveOrdinaryObjectClosureSignature(ast.checker, node));
}
const number = { kind: "val", val: { kind: "f64" } };
describe("ordinary object inferred closure signatures", () => {
  it("retains the unannotated getter, returned capturing function and throwing getter", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/issue-3518-ordinary-getter-program.json", import.meta.url), "utf8"),
    );
    expect(typeof fixture.files["./entry.ts"]).toBe("string");
    const rows = signatures(fixture.files["./entry.ts"]);
    expect(rows).toEqual([
      {
        kind: "supported",
        signature: { params: [], returnType: { kind: "callable", signature: { params: [], returnType: number } } },
      },
      { kind: "supported", signature: { params: [], returnType: number } },
      { kind: "supported", signature: { params: [], returnType: null } },
    ]);
  });
  it("uses checker contextual parameter inference and setter void completion", () => {
    expect(
      signatures(
        `const fn: (n: number) => number = n => n + 1; const o = {set x(n: number) {}, method(s: string, b: boolean) {return s;}};`,
      ),
    ).toEqual([
      { kind: "supported", signature: { params: [number], returnType: number } },
      { kind: "supported", signature: { params: [number], returnType: null } },
      {
        kind: "supported",
        signature: {
          params: [{ kind: "string" }, { kind: "val", val: { kind: "i32", boolean: true } }],
          returnType: { kind: "string" },
        },
      },
    ]);
  });
  it.each([
    ["any", "const fn = (x: any) => x;"],
    ["unknown", "const fn = (x: unknown) => x;"],
    ["mixed union", "const fn = (x: number | string) => x;"],
    ["generic", "const fn = <T>(x: T) => x;"],
    ["optional", "const fn = (x?: number) => 1;"],
    ["default", "const fn = (x = 1) => x;"],
    ["rest", "const fn = (...x: number[]) => 1;"],
    ["destructured", "const fn = ({x}: {x:number}) => x;"],
    ["async", "const fn = async () => 1;"],
    ["generator", "const fn = function* () {yield 1;};"],
    ["recursive", "interface Recursive {(): Recursive} const fn = (x: Recursive) => x;"],
    ["overload", "interface Overload {(x:number):number; (x:string):string} const fn = (x: Overload) => x;"],
    ["explicit this", "const fn = function(this: number) {return 1;};"],
  ])("refuses %s instead of fabricating a signature", (_label, source) => {
    expect(signatures(source)[0]).toMatchObject({ kind: "unsupported", detail: expect.any(String) });
  });
});
