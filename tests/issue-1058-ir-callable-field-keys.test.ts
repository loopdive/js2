// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { irClosureSignatureFromFunctionTypeNode } from "../src/ir/select.js";
import { objectFieldsHashKey, primitiveSourceMethodSignature } from "../src/ir/object-method-key.js";
import { irTypeEquals, irVal, type IrObjectShape } from "../src/ir/nodes.js";
import { irTypeKey } from "../src/ir/type-key.js";
import { canonicalProgramAbiObjectShapeKey } from "../src/codegen/program-abi-type-planning.js";

const numeric = { params: [irVal({ kind: "f64" })], returnType: irVal({ kind: "f64" }) };
const shape: IrObjectShape = {
  fields: [
    {
      name: "a",
      type: { kind: "callable", signature: { params: [], returnType: null } },
      sourceMethodSignature: "0->void",
    },
    { name: "z", type: { kind: "callable", signature: numeric }, sourceMethodSignature: "1->number" },
  ],
  fieldOrder: ["z", "a"],
};
const fields = ["z", "a"].map((name) => ({ name, type: { kind: "externref" as const }, mutable: true }));

it("uses source order and arity/return metadata for anonymous method tables", () => {
  expect(objectFieldsHashKey(shape, fields)).toBe("z:externref|a:externref||z#1->number,a#0->void");
});

it("keeps declared and anonymous allocation contracts distinct in every key", () => {
  const declared = { ...shape, allocationKind: "declared" as const };
  const a = { kind: "object" as const, shape };
  const b = { kind: "object" as const, shape: declared };
  expect(objectFieldsHashKey(declared, fields)).toBe("z:externref|a:externref");
  expect(irTypeEquals(a, b)).toBe(false);
  expect(irTypeKey(a)).not.toBe(irTypeKey(b));
  expect(canonicalProgramAbiObjectShapeKey(a)).not.toBe(canonicalProgramAbiObjectShapeKey(b));
});

it("rejects a source signature suffix that disagrees with the typed callable", () => {
  const invalid = { fields: [{ ...shape.fields[1]!, sourceMethodSignature: "1->string" }] };
  expect(() => objectFieldsHashKey(invalid, fields.slice(0, 1))).toThrow(/source method signature does not match/);
});

it.each([
  "(x?: number) => number",
  "(...x: number[]) => number",
  "<T>(x: T) => T",
  "(this: number, x: number) => number",
  "(x: Node) => Node",
  "() => 42",
])("does not invent a primitive source signature for %s", (source) => {
  const file = ts.createSourceFile("signature.ts", `type Fn = ${source};`, ts.ScriptTarget.Latest, true);
  const declaration = file.statements[0];
  if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isFunctionTypeNode(declaration.type)) {
    throw new Error("fixture did not produce a function type");
  }
  expect(irClosureSignatureFromFunctionTypeNode(declaration.type)).toBeNull();
});

it("reads a primitive method signature without manufacturing a function-type AST", () => {
  const file = ts.createSourceFile(
    "signature.ts",
    "interface Rules { test(x: number): boolean; }",
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = file.statements[0];
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) throw new Error("missing interface");
  const method = declaration.members[0];
  if (!method || !ts.isMethodSignature(method)) throw new Error("missing method");
  const signature = irClosureSignatureFromFunctionTypeNode(method);
  expect(signature).not.toBeNull();
  expect(primitiveSourceMethodSignature(signature!)).toBe("1->boolean");
});
