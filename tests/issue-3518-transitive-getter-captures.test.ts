// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { collectTransitiveClosureCaptures } from "../src/ir/closure-captures.js";
import { sourcePacket } from "./helpers/typed-program-fixtures.js";

function captures(body: string) {
  const ast = analyzeMultiSource(
    {
      "./entry.ts": `export function run() {
    let captured=7; const object={get value(){ ${body} }}; return 0;
  }`,
    },
    "./entry.ts",
  );
  let getter: ts.GetAccessorDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isGetAccessorDeclaration(node)) getter = node;
    ts.forEachChild(node, visit);
  };
  visit(ast.entryFile);
  expect(getter).toBeDefined();
  const result = collectTransitiveClosureCaptures(getter!.body!, getter!, ast.checker);
  return { referenced: [...result.referenced], written: [...result.written] };
}

describe("transitive getter environment bindings", () => {
  it.each([
    "return function(){return captured;};",
    "return ()=>()=>captured;",
    "return function(x=captured){return x;};",
    "return ()=>({captured});",
  ])("transports the actual outer lexical through %s", (body) => {
    expect(captures(body)).toEqual({ referenced: ["captured"], written: [] });
  });
  it.each([
    "return function(captured:number){return captured;};",
    "const captured=9; return ()=>captured;",
    "return function(){let captured=9;return captured;};",
    "return function(){try{throw 1;}catch(captured){return captured;}};",
    "return function(){const x={captured:9};return x.captured;};",
  ])("does not capture an unrelated same-name symbol in %s", (body) => {
    expect(captures(body)).toEqual({ referenced: [], written: [] });
  });
  it.each(["captured++", "++captured", "captured+=2", "captured=9"])(
    "preserves descendant write authority for %s",
    (write) => {
      expect(captures(`return function(){${write};return captured;};`)).toEqual({
        referenced: ["captured"],
        written: ["captured"],
      });
    },
  );
  it.each([
    "[captured]=[9]",
    "({value:captured}={value:9})",
    "({captured}={captured:9})",
    "captured ||= 9",
    "captured &&= 9",
    "captured ??= 9",
    "for(captured of [9]){}",
    "for(captured in {value:9}){}",
  ])("keeps a shared binding for descendant assignment pattern %s", (write) => {
    expect(captures(`return function(){${write};return captured;};`)).toEqual({
      referenced: ["captured"],
      written: ["captured"],
    });
  });
  it("does not classify a computed-key read as a lexical write", () => {
    expect(captures("return function(){const obj={};obj[captured]=9;return captured;};")).toEqual({
      referenced: ["captured"],
      written: [],
    });
  });
  it("lifts a returned closure with its outer environment through a real getter", () => {
    const { source } = sourcePacket({
      "./entry.ts": `export function run() {
      const captured=7;
      const object={get valueOf(){return function(){return captured;};}};
      return Number(object);
    }`,
    });
    const functions = source.ir.functions;
    expect(functions).toHaveLength(3);
    const instructions = functions.flatMap((fn) => fn.blocks.flatMap((block) => block.instrs));
    expect(instructions.filter((row) => row.kind === "closure.new")).toHaveLength(2);
    // The middle getter and returned function must both read actual environments.
    expect(
      functions.filter((fn) => fn.blocks.some((block) => block.instrs.some((row) => row.kind === "closure.cap"))),
    ).toHaveLength(2);
  });
});
