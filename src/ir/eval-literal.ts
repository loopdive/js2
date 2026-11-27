// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7363 slice A) A top-level literal direct eval runs its text as a called script source of the program.
 *
 * A site qualifies when running its text as a separate sloppy Script, in the program's one global scope, is what
 * PerformEval does with it: the call sits in global code of a sloppy Script under no scope that binds names of its
 * own, and the text is a valid Script that declares nothing and writes no identifier. The Prepared entry adds each
 * qualifying text as the script `<eval:N>.js`; this module owns the site predicate and the receipt that a site and a
 * script belong together.
 */
import { ts } from "../ts-api.js";
import { foldedEvalDeclarationNames } from "../frontend/eval/declaration-names.js";
import {
  evalBodyHasUseStrictDirective,
  foldedEvalStaticSyntaxError,
  hasHtmlLikeComment,
  parseEvalSource,
} from "../frontend/eval/script.js";
import { identifierWritesOf, isCommaExpression } from "../shared/binding-writes.js";
import { planModuleInitChunks } from "../shared/module-init-chunk-plan.js";
import { resolvesToSourceBinding } from "./analysis/ast-scope.js";
import { MODULE_INIT_UNIT_NAME } from "./module-init.js";
import { IrUnsupportedError } from "./outcomes.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { ProgramDynamicContracts } from "./source-dynamic-contracts.js";

/** A qualifying site and the program script that holds its text. */
export interface LiteralEvalSource {
  readonly call: ts.CallExpression;
  readonly source: ts.SourceFile;
}

interface LiteralEvalSite {
  readonly call: ts.CallExpression;
  readonly text: string;
}

/** The script name of the entry's `index`-th qualifying site, in source order. */
export function literalEvalFileName(index: number): string {
  return `<eval:${index}>.js`;
}

/** The texts of the entry's qualifying sites, in source order, read from a parse of its text alone. */
export function literalEvalTexts(fileName: string, text: string): readonly string[] {
  if (!text.includes("eval")) return [];
  return literalEvalSites(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)).map((site) => site.text);
}

/** Pair the analyzed entry's qualifying sites with the `added` scripts the entry's texts became. */
export function pairLiteralEvalSources(
  entry: ts.SourceFile,
  sourceFiles: readonly ts.SourceFile[],
  added: number,
): readonly LiteralEvalSource[] {
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `literal eval pairing: ${detail}`);
  };
  const sites = literalEvalSites(entry);
  if (sites.length !== added) invalid(`the analyzed entry has ${sites.length} sites for ${added} added scripts`);
  const byName = new Map(sourceFiles.map((source) => [source.fileName, source]));
  return sites.map((site, index) => {
    const name = literalEvalFileName(index);
    return { call: site.call, source: byName.get(name) ?? invalid(`${name} is not a script of the analyzed program`) };
  });
}

/**
 * The receipt: each row's call is a qualifying site of the entry, its source is a script of the program whose text is
 * the literal's value, and no call or source occurs twice. Returns each related call's source, the related sources,
 * and each source's dependency on the entry, which holds its call: the inventory orders a source after its
 * dependencies, so the entry is planned and lowered before the texts it runs, whatever the names sort to.
 */
export function verifyLiteralEvalSources(
  rows: readonly LiteralEvalSource[],
  sourceFiles: readonly ts.SourceFile[],
  entry: ts.SourceFile,
): {
  readonly calls: ReadonlyMap<ts.CallExpression, ts.SourceFile>;
  readonly sources: ReadonlySet<ts.SourceFile>;
  readonly dependencies: ReadonlyMap<ts.SourceFile, readonly ts.SourceFile[]>;
} {
  const calls = new Map<ts.CallExpression, ts.SourceFile>();
  const sources = new Set<ts.SourceFile>();
  for (const { call, source } of rows) {
    const refused = (detail: string): never => {
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `literal eval ${source.fileName}: ${detail}`);
    };
    if (calls.has(call) || sources.has(source)) refused("a call or a source occurs in two rows");
    calls.set(call, source);
    sources.add(source);
    if (source === entry || !sourceFiles.includes(source) || ts.isExternalModule(source))
      refused("the source is not a script of the program");
    if (call.getSourceFile() !== entry) refused("the call is not in the entry");
    const text = literalEvalText(call);
    if (text === undefined) refused("the call is not a qualifying site");
    if (text !== source.text) refused("the source text is not the literal's value");
  }
  return { calls, sources, dependencies: new Map([...sources].map((source) => [source, [entry]])) };
}

/**
 * (#7363 A4) Admission of a related site, before any unit lowers: the select-time refusal of the program when the
 * global `eval` may not be the realm's %eval% there: a source rebinds it (`isPristineBuiltinGlobal`, absent off the
 * native lane), or a sloppy function lets its ambient `this`, the global object, escape and write it unseen. Otherwise
 * nothing, and lowering emits the site as the call of its text. The label keeps the text the lowering gave it, so
 * census rows compare across the move.
 */
export function literalEvalSiteRefusal(
  call: ts.CallExpression,
  contracts: Pick<ProgramDynamicContracts, "resolver" | "ambientThisMayBeGlobal">,
): IrUnsupportedError | undefined {
  return contracts.resolver.isPristineBuiltinGlobal?.(call.expression as ts.Identifier) === true &&
    !contracts.ambientThisMayBeGlobal
    ? undefined
    : new IrUnsupportedError(
        "literal-eval-site-unsupported",
        "select",
        `ir/from-ast: eval literal: the global eval is not pristine (#7363 A4) in ${MODULE_INIT_UNIT_NAME}`,
      );
}

/**
 * The expression's value is discarded: through parentheses, it is the expression of an expression statement, the
 * operand of `void`, the left operand of a comma, or the right operand of a comma or an arm of a conditional whose own
 * value is discarded. from-ast lowers each of these in statement position (`lowerDiscardedExpression`), which a site
 * needs: its call returns nothing (A5 gives it a value). A for head's expressions are values, and so is each clause of
 * an incrementor's comma list (`lowerForUpdateExpr` splits it before `lowerDiscardedExpression` could see the comma).
 */
function discardsValue(expression: ts.Expression): boolean {
  let node = expression;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return true;
  if (ts.isBinaryExpression(parent) && isCommaExpression(parent))
    return !incrementorClause(parent) && (parent.left === node || discardsValue(parent));
  return ts.isConditionalExpression(parent) && parent.condition !== node && discardsValue(parent);
}

/** The comma is the for incrementor or, through unparenthesized commas, one of its clauses. */
function incrementorClause(comma: ts.BinaryExpression): boolean {
  let node: ts.Expression = comma;
  while (ts.isBinaryExpression(node.parent) && isCommaExpression(node.parent)) node = node.parent;
  return ts.isForStatement(node.parent) && node.parent.incrementor === node;
}

function literalEvalSites(file: ts.SourceFile): readonly LiteralEvalSite[] {
  const sites: LiteralEvalSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const text = literalEvalText(node);
      if (text !== undefined) sites.push({ call: node, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

/** The text a qualifying site runs; undefined when the site does not qualify. */
function literalEvalText(call: ts.CallExpression): string | undefined {
  const [argument] = call.arguments;
  if (
    call.questionDotToken ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "eval" ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteralLike(argument!) ||
    resolvesToSourceBinding(call.expression) ||
    !runsInSloppyGlobalCode(call) ||
    !discardsValue(call)
  )
    return undefined;
  return textRunsAsScript(call, argument.text) ? argument.text : undefined;
}

/** Sloppy Script global code under no scope that binds names of its own: the eval's environments are the global ones. */
function runsInSloppyGlobalCode(call: ts.CallExpression): boolean {
  let node: ts.Node = call.parent;
  for (; !ts.isSourceFile(node); node = node.parent) {
    if (
      ts.isFunctionLike(node) ||
      ts.isClassLike(node) ||
      ts.isCatchClause(node) ||
      ts.isWithStatement(node) ||
      (ts.isBlock(node) && node.statements.some(isLexicalDeclaration)) ||
      (ts.isCaseBlock(node) && node.clauses.some((clause) => clause.statements.some(isLexicalDeclaration))) ||
      ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        node.initializer !== undefined &&
        isLexicalList(node.initializer))
    )
      return false;
  }
  return !ts.isExternalModule(node) && !evalBodyHasUseStrictDirective(node.statements);
}

function isLexicalDeclaration(statement: ts.Statement): boolean {
  return (
    (ts.isVariableStatement(statement) && isLexicalList(statement.declarationList)) ||
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement)
  );
}

function isLexicalList(node: ts.Node): boolean {
  return ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
}

/**
 * The text is a Script, not a Module, that PerformEval runs without a SyntaxError, declares nothing, stores into no
 * identifier, holds no nested eval, and lowers as one init chunk. A text that may hold an HTML-like comment is none:
 * its TypeScript parse is not the Script PerformEval runs. The static check here is the spec's; the Prepared
 * entry also keeps a text only when the compile's gates pass it as they pass an entry (`test262-prepared-entry.ts`).
 */
function textRunsAsScript(call: ts.CallExpression, text: string): boolean {
  if (hasHtmlLikeComment(text)) return false;
  const script = parseEvalSource(text, false, false);
  const names = foldedEvalDeclarationNames(script.sourceFile);
  return (
    !ts.isExternalModule(script.sourceFile) &&
    foldedEvalStaticSyntaxError(call, true, script, names, undefined) === undefined &&
    !scriptEarlyError(script.sourceFile, undefined) &&
    names.varNames.size === 0 &&
    names.blockFunctionNames.size === 0 &&
    !bindsOrEvaluates(script.sourceFile) &&
    planModuleInitChunks(script.statements.map((node) => ({ node }))).length <= 1
  );
}

/**
 * A `return` outside every function of the text, or an `await` outside every async one (`async`: undefined at the
 * top level, else whether the nearest enclosing function is async): Script early errors the shared check does not
 * report. TypeScript parses both and reports them only as semantic diagnostics, which no compile gate refuses. Adding
 * the `return` rule to the shared check would change the legacy fold's output for `eval("return;")`
 * (parse-failure-5.js).
 */
function scriptEarlyError(node: ts.Node, async: boolean | undefined): boolean {
  if ((ts.isReturnStatement(node) && async === undefined) || (ts.isAwaitExpression(node) && async !== true))
    return true;
  const inner = ts.isFunctionLike(node)
    ? (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) !== 0
    : async;
  return ts.forEachChild(node, (child) => scriptEarlyError(child, inner)) === true;
}

/**
 * A `var`/`let`/`const` list or a class anywhere in the text, a store into an identifier, or the name `eval`. A store
 * could rewrite a binding of the caller, and the proofs over a script binding see only the writes in its own file
 * (`preparedBindingRewritten`). A store into the text's own parameter refuses too: no scope walk tells the two apart.
 */
function bindsOrEvaluates(node: ts.Node): boolean {
  if (
    ts.isVariableDeclarationList(node) ||
    ts.isClassDeclaration(node) ||
    (ts.isIdentifier(node) && node.text === "eval") ||
    identifierWritesOf(node).length > 0
  )
    return true;
  return ts.forEachChild(node, bindsOrEvaluates) === true;
}
