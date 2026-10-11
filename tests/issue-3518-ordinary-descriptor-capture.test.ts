// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { isCapturedByOrdinaryDescriptor } from "../src/ir/closure-captures.js";

/** Return every declaration of the requested spelling: shadowed bindings stay distinct. */
function captures(source: string, name: string): boolean[] {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast.entryFile);
  expect(declarations.length).toBeGreaterThan(0);
  return declarations.map((declaration) => isCapturedByOrdinaryDescriptor(declaration, ast.checker));
}

describe("ordinary descriptor capture identity", () => {
  it("finds the exact preserved getter program's shared trace", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/issue-3518-ordinary-getter-program.json", import.meta.url), "utf8"),
    );
    expect(captures(fixture.files["./entry.ts"], "trace")).toEqual([true]);
  });
  it("finds a conditional getter capture before its creation branch executes", () => {
    expect(
      captures(
        `export function run(flag: boolean) {
      let trace = 0;
      if (flag) { const object = {get value() { return ++trace; }}; return object; }
      trace = 7;
      return trace;
    }`,
        "trace",
      ),
    ).toEqual([true]);
  });
  it("recognizes sibling getter reads and setter writes as one declaration", () => {
    expect(
      captures(
        `export function run() {
      let trace = 0;
      const reader = {get value() {return trace;}};
      const writer = {set value(next: number) {trace = next;}};
      return [reader, writer];
    }`,
        "trace",
      ),
    ).toEqual([true]);
  });
  it("does not confuse shadowed same-name variables with the captured binding", () => {
    expect(
      captures(
        `export function run() {
      let trace = 0;
      const object = {get value() {let trace = 1; return trace;}};
      return object;
    }`,
        "trace",
      ),
    ).toEqual([false, false]);
    expect(
      captures(
        `export function run() {
      let trace = 0;
      { let trace = 1; const object = {get value() {return trace;}}; }
      return trace;
    }`,
        "trace",
      ),
    ).toEqual([false, true]);
  });
  it("keeps an unrelated ordinary closure outside descriptor-specific allocation", () => {
    expect(
      captures(
        `export function run() {
      let trace = 0;
      const fn = () => ++trace;
      const object = {get value() {return 7;}};
      return fn;
    }`,
        "trace",
      ),
    ).toEqual([false]);
  });
  it("retains a getter-local binding captured by its returned function", () => {
    expect(
      captures(
        `export function run() {
      return {get value() {let trace = 0; return function () {return ++trace;};}};
    }`,
        "trace",
      ),
    ).toEqual([true]);
  });
  it("distinguishes property names from reads of the outer symbol", () => {
    expect(
      captures(
        `export function run() {
      let trace = 0;
      const object = {get trace() {return 7;}};
      return object;
    }`,
        "trace",
      ),
    ).toEqual([false]);
  });
});
