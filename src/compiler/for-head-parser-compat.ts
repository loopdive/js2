// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6836 / #6651 V9 — pre-parse compatibility for two valid `for`-head shapes the
// TypeScript parser (5.9) rejects or misparses.
//
// L  Sloppy `let` as an IdentifierReference at the start of an ordinary `for`
//    head. ES2015 §13.7.4 only forbids the lookahead `let [`, so `for (let; ;)`,
//    `for (let = 3; ;)` and `for (let.x = 1; ;)` are expressions, but
//    TypeScript's `parseForOrForInOrForOfStatement` treats every leading `let`
//    token as a declaration (silently empty for `let;`, an error for `let =`).
//    Rewrite: insert `0, ` before the `let` token, so the head is a comma
//    expression whose right operand is the original, untouched `let …` text.
//    Unlike `(let)`, the assignment target stays a bare IdentifierReference, so
//    NamedEvaluation (`let = function () {}` names the function "let") is kept;
//    the extra `0` operand has no observable effect and the head keeps its NoIn
//    restriction. Only applied in explicit Script-goal code that is not strict
//    (no `"use strict"` prologue on any enclosing function/script, not inside a
//    class), with an unescaped `let`, when the next token cannot continue a
//    LexicalDeclaration: `;` `,` `.` `?.` `(` `?` `instanceof`, an assignment
//    operator or a binary punctuator. `for (let in …)`, `for (let of …)` and
//    `let [` are never touched — their lookahead rules differ and the existing
//    parser/early-error paths own them.
//
// A  An `in` expression inside an array literal in a `for` head. Array elements
//    are AssignmentExpression[+In] (§12.2.5), but TypeScript keeps the head's
//    NoIn context inside array literals and reports TS1005 at the `in` token.
//    Rewrite: for an element of the exact shape `Identifier = RHS` whose RHS
//    holds such an `in` (nested only in array literals up to the head), wrap the
//    RHS in parentheses — `[x = ('x' in {})]`. The target, the element and the
//    head-level NoIn boundary are unchanged (wrapping the whole element would
//    turn it into an invalid destructuring target).
//
// Both rewrites are insertion-only and recorded as `SourceEdit`s so diagnostics
// map back to the user's original line/column. The leaf parses only when a
// cheap textual prefilter matches, and edits only where the parse shows the
// specific TypeScript failure: a `let`-flagged declaration list as a `for`
// initializer (L) or a TS1005 at an `in` token in the head (A). Every other
// program is returned byte-identical with the identity map.

import { ts } from "../ts-api.js";
import { PositionMap, type SourceEdit } from "../position-map.js";

interface Token {
  readonly kind: ts.SyntaxKind;
  readonly start: number;
  readonly end: number;
}

interface Insertion {
  readonly at: number;
  readonly text: string;
}

export interface ForHeadCompatOptions {
  /** The source is compiled as an ECMAScript Script (not a Module). Gates L. */
  readonly scriptGoal: boolean;
}

const K = ts.SyntaxKind;

/** Tokens after a leading `let` that make it an IdentifierReference. */
const LET_IDENTIFIER_FOLLOWERS: ReadonlySet<ts.SyntaxKind> = new Set([
  K.SemicolonToken,
  K.CommaToken,
  K.DotToken,
  K.QuestionDotToken,
  K.OpenParenToken,
  K.QuestionToken,
  K.InstanceOfKeyword,
  K.LessThanToken,
  K.GreaterThanToken,
  K.LessThanEqualsToken,
  K.GreaterThanEqualsToken,
  K.EqualsEqualsToken,
  K.ExclamationEqualsToken,
  K.EqualsEqualsEqualsToken,
  K.ExclamationEqualsEqualsToken,
  K.PlusToken,
  K.MinusToken,
  K.AsteriskToken,
  K.AsteriskAsteriskToken,
  K.SlashToken,
  K.PercentToken,
  K.LessThanLessThanToken,
  K.GreaterThanGreaterThanToken,
  K.GreaterThanGreaterThanGreaterThanToken,
  K.AmpersandToken,
  K.BarToken,
  K.CaretToken,
  K.AmpersandAmpersandToken,
  K.BarBarToken,
  K.QuestionQuestionToken,
]);

function isLetIdentifierFollower(kind: ts.SyntaxKind): boolean {
  return LET_IDENTIFIER_FOLLOWERS.has(kind) || (kind >= K.FirstAssignment && kind <= K.LastAssignment);
}

/** Tokens after which a `/` is a division operator rather than a regex start. */
const OPERAND_END: ReadonlySet<ts.SyntaxKind> = new Set([
  K.Identifier,
  K.NumericLiteral,
  K.BigIntLiteral,
  K.StringLiteral,
  K.RegularExpressionLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateTail,
  K.CloseParenToken,
  K.CloseBracketToken,
  K.CloseBraceToken,
  K.ThisKeyword,
  K.SuperKeyword,
  K.NullKeyword,
  K.TrueKeyword,
  K.FalseKeyword,
  K.LetKeyword,
]);

const OPENERS: ReadonlySet<ts.SyntaxKind> = new Set([
  K.OpenBracketToken,
  K.OpenParenToken,
  K.OpenBraceToken,
  K.TemplateHead,
]);
const CLOSERS: ReadonlySet<ts.SyntaxKind> = new Set([
  K.CloseBracketToken,
  K.CloseParenToken,
  K.CloseBraceToken,
  K.TemplateTail,
]);

function newScanner(source: string, from: number): ts.Scanner {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  scanner.resetTokenState(from);
  return scanner;
}

/**
 * Tokenize a `for` head from just after its `(` up to (excluding) the matching
 * `)`. Comments are trivia; `/` is re-scanned as a regex after a non-operand;
 * a `}` closing a template substitution is re-scanned as the template
 * continuation. Returns `undefined` on unbalanced or unterminated input.
 */
function scanHead(source: string, from: number): Token[] | undefined {
  const scanner = newScanner(source, from);
  const tokens: Token[] = [];
  const stack: ts.SyntaxKind[] = [];
  let prev: ts.SyntaxKind = K.OpenParenToken;
  for (;;) {
    let kind = scanner.scan();
    if (kind === K.EndOfFileToken) return undefined;
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !OPERAND_END.has(prev)) {
      kind = scanner.reScanSlashToken();
    } else if (kind === K.CloseBraceToken && stack[stack.length - 1] === K.TemplateHead) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === K.TemplateTail) stack.pop();
    } else if (OPENERS.has(kind)) {
      stack.push(kind);
    } else if (CLOSERS.has(kind)) {
      if (stack.length === 0) return kind === K.CloseParenToken ? tokens : undefined;
      const open = stack.pop();
      const expected =
        kind === K.CloseParenToken
          ? K.OpenParenToken
          : kind === K.CloseBracketToken
            ? K.OpenBracketToken
            : K.OpenBraceToken;
      if (open !== expected) return undefined;
    }
    tokens.push({ kind, start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
    prev = kind;
  }
}

/** Offset just after the `(` of a plain `for (` head. */
function headOpenParenEnd(source: string, node: ts.Node, sf: ts.SourceFile): number | undefined {
  const scanner = newScanner(source, node.getStart(sf));
  if (scanner.scan() !== K.ForKeyword) return undefined;
  if (scanner.scan() !== K.OpenParenToken) return undefined;
  return scanner.getTokenEnd();
}

function hasUseStrictDirective(statements: readonly ts.Statement[], source: string, sf: ts.SourceFile): boolean {
  for (const stmt of statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) return false;
    const raw = source.slice(stmt.expression.getStart(sf), stmt.expression.end);
    if (raw === '"use strict"' || raw === "'use strict'") return true;
  }
  return false;
}

/** True only when `node` is affirmatively in non-strict code of the Script. */
function isSloppy(node: ts.Node, source: string, sf: ts.SourceFile): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isClassLike(cur)) return false;
    if (ts.isSourceFile(cur)) return !hasUseStrictDirective(cur.statements, source, sf);
    if (ts.isFunctionLike(cur)) {
      const body = (cur as ts.FunctionLikeDeclaration).body;
      if (body && ts.isBlock(body) && hasUseStrictDirective(body.statements, source, sf)) return false;
    }
  }
  return false;
}

/** L: the insertion for a sloppy identifier `let` heading an ordinary `for`. */
function letIdentifierInsertion(source: string, tokens: readonly Token[]): Insertion | undefined {
  const [first, second] = tokens;
  if (!first || !second || first.kind !== K.LetKeyword) return undefined;
  if (source.slice(first.start, first.end) !== "let") return undefined; // escaped spellings are declined
  if (!isLetIdentifierFollower(second.kind)) return undefined;
  return { at: first.start, text: "0, " };
}

/** Index of the token that ends the head's LHS/initializer (top-level `;`, `in`, `of`). */
function headLhsEnd(source: string, tokens: readonly Token[]): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (OPENERS.has(t.kind)) depth++;
    else if (CLOSERS.has(t.kind)) depth--;
    else if (depth === 0) {
      if (t.kind === K.SemicolonToken || t.kind === K.InKeyword) return i;
      if (i > 0 && t.kind === K.Identifier && source.slice(t.start, t.end) === "of") return i;
    }
  }
  return tokens.length;
}

/**
 * The array element around `tokens[inIndex]` (which sits directly at that
 * element's nesting level), when it has the exact shape `Identifier = RHS`:
 * returns the RHS token range.
 */
function identifierDefaultRhs(
  tokens: readonly Token[],
  inIndex: number,
  limit: number,
): { first: number; last: number } | undefined {
  let depth = 0;
  let start = -1;
  for (let i = inIndex - 1; i >= 0 && start < 0; i--) {
    const k = tokens[i]!.kind;
    if (CLOSERS.has(k)) depth++;
    else if (OPENERS.has(k)) {
      if (depth === 0) {
        if (k !== K.OpenBracketToken) return undefined;
        start = i + 1;
      } else depth--;
    } else if (k === K.CommaToken && depth === 0) start = i + 1;
  }
  if (start < 0) return undefined;
  if (tokens[start]?.kind !== K.Identifier || tokens[start + 1]?.kind !== K.EqualsToken) return undefined;
  const first = start + 2;
  if (first >= inIndex) return undefined; // the RHS must have an operand before `in`
  depth = 0;
  for (let i = inIndex + 1; i < limit; i++) {
    const k = tokens[i]!.kind;
    if (OPENERS.has(k)) depth++;
    else if (CLOSERS.has(k)) {
      if (depth > 0) depth--;
      else return k === K.CloseBracketToken && i - 1 > inIndex ? { first, last: i - 1 } : undefined;
    } else if (k === K.CommaToken && depth === 0) {
      return i - 1 > inIndex ? { first, last: i - 1 } : undefined;
    }
  }
  return undefined;
}

/** A: parenthesise each `Identifier = RHS` element RHS holding a misparsed `in`. */
function arrayDefaultInInsertions(
  source: string,
  tokens: readonly Token[],
  inDiagnostics: ReadonlySet<number>,
): Insertion[] {
  const limit = headLhsEnd(source, tokens);
  const candidates: number[] = [];
  let sawDiagnostic = false;
  // true for `[`, false for `(` `{` and template substitutions (which re-enable In).
  const arrays: boolean[] = [];
  for (let i = 0; i < limit; i++) {
    const t = tokens[i]!;
    if (OPENERS.has(t.kind)) arrays.push(t.kind === K.OpenBracketToken);
    else if (CLOSERS.has(t.kind)) arrays.pop();
    else if (t.kind === K.InKeyword && arrays.length > 0 && arrays.every(Boolean)) {
      candidates.push(i);
      if (inDiagnostics.has(t.start)) sawDiagnostic = true;
    }
  }
  if (!sawDiagnostic) return [];
  const out: Insertion[] = [];
  const seen = new Set<number>();
  for (const inIndex of candidates) {
    const rhs = identifierDefaultRhs(tokens, inIndex, limit);
    if (!rhs || seen.has(rhs.first)) continue;
    seen.add(rhs.first);
    out.push({ at: tokens[rhs.first]!.start, text: "(" }, { at: tokens[rhs.last]!.end, text: ")" });
  }
  return out;
}

function collectInsertions(source: string, sf: ts.SourceFile, maybeLet: boolean, inDiagnostics: ReadonlySet<number>) {
  const insertions: Insertion[] = [];
  const visit = (node: ts.Node): void => {
    const isFor = ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node);
    const awaitHead = ts.isForOfStatement(node) && node.awaitModifier !== undefined;
    const open = isFor && !awaitHead ? headOpenParenEnd(source, node, sf) : undefined;
    const tokens = open === undefined ? undefined : scanHead(source, open);
    if (tokens && isFor) {
      const init = node.initializer;
      const misparsedLet =
        maybeLet && init !== undefined && ts.isVariableDeclarationList(init) && (init.flags & ts.NodeFlags.Let) !== 0;
      const letInsertion =
        misparsedLet && isSloppy(node, source, sf) ? letIdentifierInsertion(source, tokens) : undefined;
      if (letInsertion) insertions.push(letInsertion);
      if (inDiagnostics.size > 0) insertions.push(...arrayDefaultInInsertions(source, tokens, inDiagnostics));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return insertions;
}

const TRIVIA = String.raw`(?:\s|/\*(?:[^*]|\*(?!/))*\*/|//[^\n]*\n)*`;
const FOR_PAREN_LET = new RegExp(String.raw`\bfor${TRIVIA}\(${TRIVIA}let\b`);
const FOR_PAREN = new RegExp(String.raw`\bfor${TRIVIA}\(`);

/**
 * Apply the L/A for-head compatibility insertions. Returns the input unchanged
 * (identity map) unless the original parse shows one of the two TypeScript
 * failures at a site the recognizer proves.
 */
export function normalizeForHeadParserCompat(
  source: string,
  options: ForHeadCompatOptions,
): { source: string; positionMap: PositionMap } {
  const identity = { source, positionMap: PositionMap.identity() };
  // Cheap prefilters (trivia may sit around `(`); the parse decides.
  const maybeLet = options.scriptGoal && FOR_PAREN_LET.test(source);
  const maybeIn = FOR_PAREN.test(source) && source.includes("[") && /\bin\b/.test(source);
  if (!maybeLet && !maybeIn) return identity;

  const sf = ts.createSourceFile("for-head-compat.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const inDiagnostics = new Set<number>();
  for (const d of parseDiagnostics) {
    if (d.code === 1005 && d.start !== undefined && /^in\b/.test(source.slice(d.start, d.start + 3))) {
      inDiagnostics.add(d.start);
    }
  }
  if (!maybeLet && inDiagnostics.size === 0) return identity;

  // One insertion text per offset; a `)` closing an earlier RHS precedes a `(`.
  const byOffset = new Map<number, string>();
  const unique = new Map<string, Insertion>();
  for (const ins of collectInsertions(source, sf, maybeLet, inDiagnostics)) unique.set(`${ins.at}:${ins.text}`, ins);
  for (const ins of [...unique.values()].sort((a, b) => (a.text === ")" ? 0 : 1) - (b.text === ")" ? 0 : 1))) {
    byOffset.set(ins.at, (byOffset.get(ins.at) ?? "") + ins.text);
  }
  if (byOffset.size === 0) return identity;
  const edits: SourceEdit[] = [];
  let out = "";
  let last = 0;
  for (const [at, text] of [...byOffset.entries()].sort((a, b) => a[0] - b[0])) {
    out += source.slice(last, at) + text;
    last = at;
    edits.push({ origStart: at, origEnd: at, newLength: text.length });
  }
  out += source.slice(last);
  return { source: out, positionMap: new PositionMap(edits) };
}
