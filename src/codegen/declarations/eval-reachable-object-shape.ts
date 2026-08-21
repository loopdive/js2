// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4206) Object literals a DIRECT `eval` can mutate must use the open
// (`$Object`) representation, not a closed struct.
//
// The closed-struct representation fixes a literal's key set and each field's
// wasm storage type at compile time. That is sound only while every mutation is
// syntactically visible to the compiler — which is exactly what `eval` breaks:
//
//     var myObj = { p1: 'a' };
//     eval("with (myObj) { p1 = { b: 'hi' } }");   // test262 12.10_A4_T4
//     eval("with (myObj) { del = delete p1 }");    // test262 12.10_A5_T1
//
// Measured on `--target standalone` with the QuickJS eval provider built
// (2026-08-21): the write through the membrane is SILENTLY DROPPED whenever the
// new value does not fit the field's pinned storage type (`p1` stays `'a'`), and
// `delete` through the membrane returns `true` while deleting nothing (`'p1' in
// myObj` stays `true`). Forcing the same literal open — by adding a syntactic
// `delete myObj.p1` under an `if (false)` — makes both cases behave correctly,
// which is what isolates the representation as the cause rather than the
// membrane's set/delete traps.
//
// The trigger is deliberately narrow, because opening a literal costs the
// fixed-key `struct.get` fast path:
//
//   1. the call must be a direct, by-name `eval(…)`;
//   2. its argument must be a literal whose text is known at compile time (a
//      string literal, or a template with no substitutions) — a computed eval
//      source says nothing about which names it touches, and is left as a
//      documented residual rather than opening every literal in the module;
//   3. the text must MENTION the variable as an identifier token — scanned with
//      TypeScript's own scanner, so a name occurring inside a nested string or
//      comment in the eval source does not count; and
//   4. the text must be able to MUTATE something at all (an assignment,
//      `delete`, or `++`/`--`). A read-only eval observes the closed struct
//      correctly and keeps its fast path.
//
// The caller applies this alongside the syntactic `delete` / accessor-define
// markers, so it inherits their concrete-struct consumer guard: a var that also
// flows into a nominal-struct-typed position is left on the struct path.

import { ts } from "../../ts-api.js";

/** Does this token stream contain something that can mutate a binding? */
function tokenCanMutate(token: ts.SyntaxKind): boolean {
  return (
    token === ts.SyntaxKind.EqualsToken ||
    token === ts.SyntaxKind.PlusEqualsToken ||
    token === ts.SyntaxKind.MinusEqualsToken ||
    token === ts.SyntaxKind.AsteriskEqualsToken ||
    token === ts.SyntaxKind.SlashEqualsToken ||
    token === ts.SyntaxKind.PercentEqualsToken ||
    token === ts.SyntaxKind.AmpersandEqualsToken ||
    token === ts.SyntaxKind.BarEqualsToken ||
    token === ts.SyntaxKind.CaretEqualsToken ||
    token === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    token === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    token === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    token === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    token === ts.SyntaxKind.PlusPlusToken ||
    token === ts.SyntaxKind.MinusMinusToken ||
    token === ts.SyntaxKind.DeleteKeyword
  );
}

/** Identifier tokens in `source`, plus whether the source can mutate anything. */
function scanEvalSource(source: string): { names: Set<string>; mutates: boolean } {
  const names = new Set<string>();
  let mutates = false;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, source);
  for (;;) {
    let token: ts.SyntaxKind;
    try {
      token = scanner.scan();
    } catch {
      break;
    }
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    if (token === ts.SyntaxKind.Identifier) names.add(scanner.getTokenText());
    else if (tokenCanMutate(token)) mutates = true;
  }
  return { names, mutates };
}

/** The compile-time-known source text of a direct `eval(<literal>)` call. */
function directEvalLiteralSource(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "eval") return undefined;
  const arg = node.arguments[0];
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return undefined;
}

/**
 * Names that a direct `eval` of a compile-time-known source could mutate in
 * this module. A variable in this set must not be given the closed-struct
 * representation — see the file header for the measurement behind it.
 */
export function collectEvalMutableNames(sourceFile: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const source = directEvalLiteralSource(node);
    if (source !== undefined) {
      const scanned = scanEvalSource(source);
      if (scanned.mutates) for (const name of scanned.names) out.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}
