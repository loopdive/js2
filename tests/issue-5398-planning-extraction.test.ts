// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { irClosureSignatureFromFunctionTypeNode as compatibility } from "../src/ir/select.js";
import { irClosureSignatureFromFunctionTypeNode as canonical } from "../src/ir/selection-return-types.js";

// Captured from the CURRENT semantic repair before relocation, not from main.
// The three callable write/flow/resolver fingerprints were subsequently updated
// for the reviewed loop-target and async-wrapper correctness repair. The other
// seven retain the original relocation snapshot; behavioral tests cover the fix.
// Hashes cover parsed declarations (including bodies, parameters and types),
// excluding only export modifiers, comments and formatter whitespace.
const declarations = [
  ["propagation-callables", "PropagationFunction", "40c745308d8feba0a95a567868a5c8eed83a908fe39d6cf8456ed15dc833b086"],
  ["propagation-callables", "CallTargetResolver", "279fc0ebee4e9a1c25610ba65328ce811a94758ded0e37211326ec3d4272bdfc"],
  [
    "propagation-callables",
    "collectIndexedFunctionDeclarations",
    "5c91190d2cac923fc6491b0e9f49d1724f6c95c9b7e646c5618691fc00fa7b50",
  ],
  [
    "propagation-callables",
    "collectReassignedCallables",
    "67d8eb3ada9ded1ea487a7c1b20f72f8c88cc06ecaff891ec4bc8a3d5ec942dc",
  ],
  [
    "propagation-callables",
    "hasStableGeneratorReturnFlow",
    "ee0cbe7ef57489be5216fb772ba1af9d22e91de68c3a73f2e869dbd1bb56c89b",
  ],
  [
    "propagation-callables",
    "makeCallTargetResolver",
    "a611196b06fe297c9952e2607f033650e85afaf7c37667feb844c52df81aea3d",
  ],
  [
    "selection-return-types",
    "primitiveClosureTypeFromTypeNode",
    "193bbc22dd8bd7458e6e3f699fc558875f0d8e74bb37d1e76dd2fe6ae3ed1e90",
  ],
  [
    "selection-return-types",
    "irClosureSignatureFromFunctionTypeNode",
    "412d867b5759b8f47cd3762c5770e833b53fdf92a3b0cfce17770abd9ea7b6f3",
  ],
  [
    "selection-return-types",
    "resolveReturnTypeNode",
    "42cb2ee1a0c05cbd9e66093df5d726384d120acfcd38204f12921b63d3e3cb46",
  ],
  ["selection-return-types", "ResolvedKind", "ca31f60acf404a01606d34af01bce482c15221b2cdee9bb3eed5a914a7c29f58"],
] as const;
const printer = ts.createPrinter({ removeComments: true });
function source(owner: string) {
  const file = new URL(`../src/ir/${owner}.ts`, import.meta.url);
  return ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}
describe("planning extraction equivalence", () => {
  it.each(declarations)("preserves %s::%s", (owner, name, digest) => {
    const file = source(owner);
    const nodes = file.statements.filter(
      (node) =>
        (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name?.text === name,
    );
    expect(nodes).toHaveLength(1);
    const printed = printer.printNode(ts.EmitHint.Unspecified, nodes[0]!, file).replace(/^export /, "");
    expect(createHash("sha256").update(printed).digest("hex")).toBe(digest);
    const former = source(owner === "propagation-callables" ? "propagate" : "select");
    expect(
      former.statements.some(
        (node) =>
          (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
          node.name?.text === name,
      ),
    ).toBe(false);
  });
  it("preserves compatibility export identity", () => {
    expect(compatibility).toBe(canonical);
  });
  it.each(["propagation-callables", "selection-return-types"])(
    "has no driver backedge or eager call in %s",
    (owner) => {
      for (const node of source(owner).statements) {
        if (ts.isImportDeclaration(node)) {
          expect((node.moduleSpecifier as ts.StringLiteral).text).not.toMatch(/\/(select|propagate)\.js$/);
        } else {
          expect(
            ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
          ).toBe(true);
        }
      }
    },
  );
});
