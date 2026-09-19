// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Diagnostic only: the canonical full-AST fingerprint remains the acceptance oracle.
import { createSourceFile, forEachChild } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptKind, ScriptTarget, SyntaxKind } from "../.npm-upstream-suites/typescript/src/compiler/types.js";
import type {
  Identifier,
  LiteralLikeNode,
  Node,
  NodeArray,
} from "../.npm-upstream-suites/typescript/src/compiler/types.js";

const sourceText =
  'import {\r\n    Diagnostic,\r\n    WriteFileCallbackData,\r\n} from "./_namespaces/ts.js";\r\n\r\nexport interface EmitOutput {\r\n    outputFiles: OutputFile[];\r\n    emitSkipped: boolean;\r\n    diagnostics: readonly Diagnostic[];\r\n}\r\n\r\nexport interface OutputFile {\r\n    name: string;\r\n    writeByteOrderMark: boolean;\r\n    text: string;\r\n    /** @internal */ data?: WriteFileCallbackData;\r\n}\r\n';

export function fieldHash(field: number): number {
  const source = createSourceFile("input.ts", sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  };
  const mixText = (text: string): void => {
    mix(text.length);
    for (let index = 0; index < text.length; index++) mix(text.charCodeAt(index));
  };
  const visitArray = (nodes: NodeArray<Node>): void => {
    if (field === 4) {
      mix(nodes.pos);
      mix(nodes.end);
      mix(nodes.length);
    }
    if (field === 5) mix(nodes.hasTrailingComma ? 1 : 0);
    for (const node of nodes) visit(node);
  };
  const visit = (node: Node): void => {
    if (field === 0) mix(node.kind);
    if (field === 1) mix(node.pos);
    if (field === 2) mix(node.end);
    if (field === 3) mix(node.flags);
    if (field === 6) {
      if (node.kind === SyntaxKind.Identifier) mixText((node as Identifier).escapedText as string);
      if (node.kind === SyntaxKind.StringLiteral) mixText((node as LiteralLikeNode).text);
    }
    forEachChild(node, visit, visitArray);
  };
  visit(source);
  return hash;
}

export function nodeKinds(): number {
  return fieldHash(0);
}
export function nodePositions(): number {
  return fieldHash(1);
}
export function nodeEnds(): number {
  return fieldHash(2);
}
export function nodeFlags(): number {
  return fieldHash(3);
}
export function arrayMetadata(): number {
  return fieldHash(4);
}
export function trailingCommas(): number {
  return fieldHash(5);
}
export function texts(): number {
  return fieldHash(6);
}
