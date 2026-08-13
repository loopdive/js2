// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Annex B.1.3 HTML-like comments are part of the Script lexical grammar, but
// TypeScript does not recognize them while parsing JavaScript. Normalize those
// comments before parsing so the remaining program can follow the ordinary AST
// -> IR -> codegen pipeline. The rewrite is deliberately length-preserving:
// diagnostics and source maps keep the identity position map.

import { ts } from "../ts-api.js";

interface ProtectedSpan {
  readonly start: number;
  readonly end: number;
}

function collectLiteralSpans(source: string): ProtectedSpan[] {
  const sourceFile = ts.createSourceFile(
    "html-like-comments.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const spans: ProtectedSpan[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      spans.push({ start: node.getStart(sourceFile), end: node.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return spans.sort((left, right) => left.start - right.start || left.end - right.end);
}

function isLineTerminator(char: string): boolean {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}

function isWhiteSpace(char: string): boolean {
  return !isLineTerminator(char) && /\s/u.test(char);
}

function lineEnd(source: string, start: number): number {
  let end = start;
  while (end < source.length && !isLineTerminator(source[end]!)) end++;
  return end;
}

/**
 * Rewrite Annex B HTML-like comments in Script-goal source.
 *
 * `<!--` starts a single-line comment at any input-element boundary. `-->`
 * does so only at the beginning of a logical line (including the first line),
 * after optional whitespace and block comments. Markers in strings, template
 * raw segments, regular-expression literals, and ordinary comments are left
 * untouched. Every rewritten code unit becomes one ASCII space and every line
 * terminator is preserved.
 */
export function normalizeScriptHtmlLikeComments(source: string): string {
  if (!source.includes("<!--") && !source.includes("-->")) return source;

  const literalSpans = collectLiteralSpans(source);
  let spanIndex = 0;
  let output: string[] | undefined;
  let atHtmlClosePrefix = true;
  let index = 0;

  const maskToLineEnd = (start: number): number => {
    const end = lineEnd(source, start);
    output ??= [...source];
    for (let cursor = start; cursor < end; cursor++) output[cursor] = " ";
    return end;
  };

  while (index < source.length) {
    while (spanIndex < literalSpans.length && literalSpans[spanIndex]!.end <= index) spanIndex++;
    const literal = literalSpans[spanIndex];
    if (literal && literal.start === index) {
      // A literal is a real token on the line where it ends, even when a
      // template raw segment contains earlier line terminators.
      atHtmlClosePrefix = false;
      index = literal.end;
      spanIndex++;
      continue;
    }

    const char = source[index]!;
    if (isLineTerminator(char)) {
      atHtmlClosePrefix = true;
      index++;
      continue;
    }

    if (isWhiteSpace(char)) {
      index++;
      continue;
    }

    if (source.startsWith("//", index)) {
      index = lineEnd(source, index);
      continue;
    }

    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? source.length : close + 2;
      for (let cursor = index + 2; cursor < end; cursor++) {
        if (isLineTerminator(source[cursor]!)) atHtmlClosePrefix = true;
      }
      index = end;
      continue;
    }

    if (source.startsWith("<!--", index)) {
      index = maskToLineEnd(index);
      continue;
    }

    if (atHtmlClosePrefix && source.startsWith("-->", index)) {
      index = maskToLineEnd(index);
      continue;
    }

    atHtmlClosePrefix = false;
    index++;
  }

  return output?.join("") ?? source;
}
