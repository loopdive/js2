// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Tracked entry wrapper for the pinned TypeScript upstream-source checkout.
import { createSourceFile, forEachChild } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptKind, ScriptTarget, SyntaxKind } from "../.npm-upstream-suites/typescript/src/compiler/types.js";
import type {
  Identifier,
  LiteralLikeNode,
  Node,
  NodeArray,
} from "../.npm-upstream-suites/typescript/src/compiler/types.js";

export function runCase(sourceText: string): number {
  const source = createSourceFile("input.ts", sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
  let hash = 0x811c9dc5;
  let nodeCount = 0;

  const mix = (value: number): void => {
    hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  };
  const mixText = (text: string): void => {
    mix(0x9e3779b9);
    mix(text.length);
    for (let index = 0; index < text.length; index++) mix(text.charCodeAt(index));
  };
  const visitArray = (nodes: NodeArray<Node>): void => {
    mix(0xa119f1a1);
    mix(nodes.pos);
    mix(nodes.end);
    mix(nodes.length);
    mix(nodes.hasTrailingComma ? 1 : 0);
    for (const node of nodes) visit(node);
  };
  const visit = (node: Node): void => {
    nodeCount++;
    mix(node.kind);
    mix(node.pos);
    mix(node.end);
    mix(node.flags);
    switch (node.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.PrivateIdentifier:
        mixText((node as Identifier).escapedText as string);
        break;
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateHead:
      case SyntaxKind.TemplateMiddle:
      case SyntaxKind.TemplateTail:
      case SyntaxKind.RegularExpressionLiteral:
      case SyntaxKind.JsxText:
        mixText((node as LiteralLikeNode).text);
        break;
    }
    forEachChild(node, visit, visitArray);
  };

  visit(source);
  if (source.parseDiagnostics.length !== 0) return -source.parseDiagnostics.length;
  if (nodeCount >= 1024 || source.statements.length >= 2048) {
    throw new Error("AST fingerprint packing overflow");
  }
  return hash + nodeCount * 4_294_967_296 + source.statements.length * 4_398_046_511_104;
}
