// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The static half of a literal eval: parsing its Script and the SyntaxErrors PerformEval raises before running it.
 * Pure syntax over a foreign SourceFile; the legacy fold, the runtime-eval provider and the IR read it.
 */
import { ts } from "../typescript.js";
import { isUseStrictDirectiveExpression } from "../../shared/use-strict-directive.js";
import type { FoldedEvalDeclarationNames } from "./declaration-names.js";
import { identifierWritesOf } from "../../shared/binding-writes.js";
import { evalCallerCapabilities, SLOPPY_SCRIPT_GOAL, staticEarlyError } from "./early-errors.js";

/**
 * Synthetic file name for the foreign `SourceFile` an eval source is parsed into. Nodes in this file are absent from
 * the enclosing TypeScript Program, so checker queries that require bindings must not run on them.
 */
export const EVAL_SOURCE_FILENAME = "<eval>.ts";

/** A literal eval source parsed as PerformEval parses it (§19.2.1.1 steps 4–11). */
export interface ParsedEvalScript {
  /** Parent pointers are set: nested codegen paths walk upward via `node.parent`. */
  readonly sourceFile: ts.SourceFile;
  /** The Script's statements, without a directive injected for inherited strictness. */
  readonly statements: ts.NodeArray<ts.Statement>;
  readonly bodyIsStrict: boolean;
  /** A direct eval also inherits its caller's strictness; an indirect one does not. */
  readonly evalIsStrict: boolean;
}

/**
 * (#2923 park fix) Does the eval Script begin with a `"use strict"` directive
 * prologue? Per §11.2.1 a directive prologue is the leading run of
 * ExpressionStatements whose expression is a StringLiteral; `"use strict"`
 * anywhere in that run turns the body strict. A strict eval body carries
 * early-error + strict-name semantics (function `eval`/`arguments` params,
 * assignment to `eval`, …) the AST splice does not enforce, so we keep bailing
 * function declarations in such a body to the dynamic host-eval path.
 */
export function evalBodyHasUseStrictDirective(stmts: ts.NodeArray<ts.Statement>): boolean {
  for (const s of stmts) {
    if (!ts.isExpressionStatement(s)) break;
    // Only a plain StringLiteral counts as a directive (a template does not).
    if (!ts.isStringLiteral(s.expression)) break;
    // §11.2.2 matches the RAW token — see src/shared/use-strict-directive.ts.
    if (isUseStrictDirectiveExpression(s.expression)) return true;
    // Some other directive (e.g. "use asm") → keep scanning the prologue.
  }
  return false;
}

/**
 * Parse `source` as PerformEval does (§19.2.1.1 steps 4–11). `inheritedStrict`: the caller's strictness a direct eval
 * inherits, injected as a directive so nested nodes observe it; `callerStrict`: the caller's strictness as the eval's
 * own strictness reads it (legacy infers module strictness for it, not for the directive).
 */
export function parseEvalSource(source: string, inheritedStrict: boolean, callerStrict: boolean): ParsedEvalScript {
  // Foreign eval nodes have no parent chain back to the caller. A directive is
  // equivalent to inherited strictness and lets every nested emitter observe it.
  const text = inheritedStrict ? `"use strict";\n${source}` : source;
  const sourceFile = ts.createSourceFile(EVAL_SOURCE_FILENAME, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // The synthetic directive is not source text and cannot become a completion value.
  const statements = inheritedStrict
    ? ts.factory.createNodeArray(sourceFile.statements.slice(1))
    : sourceFile.statements;
  const bodyIsStrict = evalBodyHasUseStrictDirective(statements);
  return { sourceFile, statements, bodyIsStrict, evalIsStrict: bodyIsStrict || callerStrict };
}

// A line that may begin, after white space and comments, with Annex B's `-->`. The optional prefix up to a comment's
// end lets a comment opened on an earlier line count as well.
const HTML_CLOSE_COMMENT_LINE = /^(?:.*\*\/)?(?:\s|\/\*.*?\*\/)*-->/;

/**
 * The text may hold an Annex B (B.1.1) HTML-like comment: `<!--` anywhere, or `-->` at the start of a line. TypeScript
 * does not implement them, so it parses `a <!--b` as `a < !(--b)`. A consumer that runs such a text from its parse
 * refuses it. Conservative: an occurrence in a string or a comment counts too, which only refuses.
 */
export function hasHtmlLikeComment(text: string): boolean {
  return (
    text.includes("<!--") || text.split(/\r\n?|[\n\u2028\u2029]/).some((line) => HTML_CLOSE_COMMENT_LINE.test(line))
  );
}

/**
 * (#7487) Whether a sloppy global Script text, such as a dynamic function's assembled declaration, has a static
 * SyntaxError: a parse failure or an early error of the shared check.
 */
export function sloppyScriptHasStaticSyntaxError(sourceFile: ts.SourceFile): boolean {
  return hasParseDiagnostics(sourceFile) || staticEarlyError(sourceFile, SLOPPY_SCRIPT_GOAL) !== undefined;
}

/**
 * A `return` outside every function of the text, or an `await` outside every async one: Script early errors the
 * shared check does not report. TypeScript parses both and reports them only as semantic diagnostics, which no
 * compile gate refuses. Adding the `return` rule to the shared check would change the legacy fold's output for
 * `eval("return;")` (parse-failure-5.js).
 */
export function hasScriptOnlyEarlyError(sourceFile: ts.SourceFile): boolean {
  return scriptOnlyEarlyError(sourceFile, undefined);
}

/** `async`: undefined at the top level, else whether the nearest enclosing function is async. */
function scriptOnlyEarlyError(node: ts.Node, async: boolean | undefined): boolean {
  if ((ts.isReturnStatement(node) && async === undefined) || (ts.isAwaitExpression(node) && async !== true))
    return true;
  const inner = ts.isFunctionLike(node)
    ? (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0
    : async;
  return ts.forEachChild(node, (child) => scriptOnlyEarlyError(child, inner)) === true;
}

/**
 * A `var`/`let`/`const` list or a class anywhere under `node`, a store into an identifier, or the name `eval`. A text
 * run as a separate script of the program may hold none (#7363 RV7432 B2 fix (b)): a store could rewrite a binding of
 * its caller, and the proofs over a script binding see only the writes in its own file. A store into the text's own
 * parameter or local counts too: no scope walk tells it from a caller binding.
 */
export function bindsOrEvaluates(node: ts.Node): boolean {
  if (
    ts.isVariableDeclarationList(node) ||
    ts.isClassDeclaration(node) ||
    (ts.isIdentifier(node) && node.text === "eval") ||
    identifierWritesOf(node).length > 0
  )
    return true;
  return ts.forEachChild(node, bindsOrEvaluates) === true;
}

/** Whether the parser reported a syntax error in a foreign Script. */
function hasParseDiagnostics(sourceFile: ts.SourceFile): boolean {
  // `parseDiagnostics` is an internal field on SourceFile.
  const parseDiag = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return parseDiag !== undefined && parseDiag.length > 0;
}

/**
 * The SyntaxError message PerformEval raises before running the Script, in
 * spec order: a parse failure, a Script early error, then (§19.2.1.3 step 5.a)
 * a VarDeclaredName that collides with a global lexical binding. The last
 * applies only when the eval's VariableEnvironment is the global one, which the
 * caller signals by passing `globalLexicals`. Annex B.3.3 block functions are
 * excluded: a colliding lexical binding cancels their outer var, never throws.
 */
export function foldedEvalStaticSyntaxError(
  call: ts.CallExpression,
  directEval: boolean,
  script: ParsedEvalScript,
  declarationNames: FoldedEvalDeclarationNames,
  globalLexicals: ReadonlySet<string> | undefined,
): string | undefined {
  if (hasParseDiagnostics(script.sourceFile)) return "Invalid eval source";
  // (#5157) §15.1.1 NewTarget / SuperProperty / SuperCall admissibility is a
  // property of the CALL SITE, not of the eval source.
  const earlyError = staticEarlyError(script.sourceFile, {
    strict: script.evalIsStrict,
    caller: evalCallerCapabilities(call, directEval),
  });
  if (earlyError !== undefined || script.evalIsStrict || globalLexicals === undefined) return earlyError;
  for (const name of declarationNames.varNames) {
    if (globalLexicals.has(name)) return `Identifier '${name}' has already been declared`;
  }
  return undefined;
}
