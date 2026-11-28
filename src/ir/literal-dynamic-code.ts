// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Dynamic code with a literal text becomes a script source of the program: one relation of sites and sources, with
 * a kind per row.
 *
 * - `eval` (#7363 slice A): a top-level literal direct eval runs its text as a called script source. A site qualifies
 *   when running its text as a separate sloppy Script, in the program's one global scope, is what PerformEval does
 *   with it: the call sits in global code of a sloppy Script under no scope that binds names of its own, and the
 *   text is a valid Script that declares nothing and writes no identifier.
 * - `function` (#7487): a call or `new` of the global `Function` whose arguments are all string literals. Its source
 *   is the one function declaration CreateDynamicFunction parses (§20.2.1.1.1), named
 *   `__js2wasm_dynamic_function_<N>` so that it binds no name user code can see; it is declaration-only, so startup
 *   runs nothing of it.
 *
 * The Prepared entry adds each qualifying text as the script `<eval:N>.js` or `<function:N>.js`; this module owns the
 * site predicate and the receipt that a site and a script belong together.
 */
import { ts } from "../ts-api.js";
import { foldedEvalDeclarationNames } from "../frontend/eval/declaration-names.js";
import {
  bindsOrEvaluates,
  evalBodyHasUseStrictDirective,
  foldedEvalStaticSyntaxError,
  hasHtmlLikeComment,
  hasScriptOnlyEarlyError,
  parseEvalSource,
  sloppyScriptHasStaticSyntaxError,
  type ParsedEvalScript,
} from "../frontend/eval/script.js";
import { fitsFunctionSourceText, functionSourceText } from "../interp/function-source-text.js";
import { isCommaExpression } from "../shared/binding-writes.js";
import { planModuleInitChunks } from "../shared/module-init-chunk-plan.js";
import { resolvesToSourceBinding } from "./analysis/ast-scope.js";
import { MODULE_INIT_UNIT_NAME } from "./module-init.js";
import { IrUnsupportedError } from "./outcomes.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { ProgramDynamicContracts } from "./source-dynamic-contracts.js";

export type LiteralDynamicCodeKind = "eval" | "function";

/** A qualifying site, its kind, and the program script that holds its text. */
export interface LiteralDynamicCodeSource {
  readonly site: ts.CallExpression | ts.NewExpression;
  readonly kind: LiteralDynamicCodeKind;
  readonly source: ts.SourceFile;
}

/** What the receipt proves of a program's relation, by site and by source. */
export interface LiteralDynamicCodeReceipt {
  readonly evalCalls: ReadonlyMap<ts.CallExpression, ts.SourceFile>;
  readonly functionSites: ReadonlyMap<ts.CallExpression | ts.NewExpression, ts.SourceFile>;
  readonly sources: ReadonlySet<ts.SourceFile>;
  readonly calledSources: ReadonlySet<ts.SourceFile>;
  readonly dependencies: ReadonlyMap<ts.SourceFile, readonly ts.SourceFile[]>;
}

/** The script a qualifying site's text becomes: its name and its text. */
export interface LiteralDynamicCodeText {
  readonly kind: LiteralDynamicCodeKind;
  readonly name: string;
  readonly text: string;
}

interface QualifyingSite extends LiteralDynamicCodeText {
  readonly site: ts.CallExpression | ts.NewExpression;
}

/** The prefix of a dynamic function's synthesized name; no other identifier of a program may use it. */
const DYNAMIC_FUNCTION_PREFIX = "__js2wasm_dynamic_function_";

/** The script name of the entry's `index`-th qualifying site of `kind`, in source order. */
export function literalDynamicCodeFileName(kind: LiteralDynamicCodeKind, index: number): string {
  return `<${kind}:${index}>.js`;
}

/** The scripts of the entry's qualifying sites, in source order, read from a parse of its text alone. */
export function literalDynamicCodeTexts(fileName: string, text: string): readonly LiteralDynamicCodeText[] {
  if (!text.includes("eval") && !text.includes("Function")) return [];
  return qualifyingSites(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)).map(
    ({ kind, name, text }) => ({ kind, name, text }),
  );
}

/**
 * Pair the analyzed entry's qualifying sites with the `added` scripts, some of the entry's texts: a site whose text
 * did not join has no row.
 */
export function pairLiteralDynamicCodeSources(
  entry: ts.SourceFile,
  sourceFiles: readonly ts.SourceFile[],
  added: readonly LiteralDynamicCodeText[],
): readonly LiteralDynamicCodeSource[] {
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `literal dynamic code pairing: ${detail}`);
  };
  const sites = new Map(qualifyingSites(entry).map((site) => [site.name, site]));
  const byName = new Map(sourceFiles.map((source) => [source.fileName, source]));
  return added.map(({ name }) => {
    const { site, kind } = sites.get(name) ?? invalid(`the analyzed entry has no site for ${name}`);
    return { site, kind, source: byName.get(name) ?? invalid(`${name} is not a script of the analyzed program`) };
  });
}

/**
 * The receipt: each row's site is a qualifying site of its kind in the entry, its source is a script of the program
 * whose text is the site's, and no site or source occurs twice. Returns each related eval call's and function site's
 * source, every related source and the called ones among them (an eval's: its call site runs it), and each source's
 * dependency on the entry, which holds its site: the inventory orders a source after its dependencies, so the entry
 * is planned and lowered before the texts it runs, whatever the names sort to.
 */
export function verifyLiteralDynamicCodeSources(
  rows: readonly LiteralDynamicCodeSource[] | undefined,
  sourceFiles: readonly ts.SourceFile[],
  entry: ts.SourceFile,
): LiteralDynamicCodeReceipt {
  const qualifying = new Map(qualifyingSites(entry).map((row) => [row.site, row]));
  const sites = new Set<ts.Node>();
  const evalCalls = new Map<ts.CallExpression, ts.SourceFile>();
  const functionSites = new Map<ts.CallExpression | ts.NewExpression, ts.SourceFile>();
  const sources = new Set<ts.SourceFile>();
  const calledSources = new Set<ts.SourceFile>();
  for (const { site, kind, source } of rows ?? []) {
    const refused = (detail: string): never => {
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `literal ${kind} ${source.fileName}: ${detail}`,
      );
    };
    if (sites.has(site) || sources.has(source)) refused("a site or a source occurs in two rows");
    sites.add(site);
    sources.add(source);
    if (source === entry || !sourceFiles.includes(source) || ts.isExternalModule(source))
      refused("the source is not a script of the program");
    if (site.getSourceFile() !== entry) refused("the site is not in the entry");
    const expected = qualifying.get(site);
    if (expected?.kind !== kind) refused(`the site is not a qualifying ${kind} site`);
    if (expected!.text !== source.text) refused("the source text is not the site's text");
    if (kind === "eval") {
      evalCalls.set(site as ts.CallExpression, source);
      calledSources.add(source);
    } else functionSites.set(site, source);
  }
  return {
    evalCalls,
    functionSites,
    sources,
    calledSources,
    dependencies: new Map([...sources].map((source) => [source, [entry]])),
  };
}

/** Each kind's refusal when the global its sites name may not be the realm's built-in. */
const NOT_PRISTINE: Readonly<Record<LiteralDynamicCodeKind, string>> = {
  eval: "eval literal: the global eval is not pristine (#7363 A4)",
  function: "Function literal: the global Function is not pristine (#7487)",
};

/**
 * (#7363 A4; #7487) Admission of the related sites, before any unit lowers: the select-time refusal of the program
 * when the global a site names, `eval` or `Function`, may not be the realm's built-in there. Otherwise undefined, and
 * lowering emits each site as the call of its text or a fresh function object. The label keeps the text the lowering
 * gave it, so census rows compare across the move.
 */
export function literalDynamicCodeSiteRefusal(
  code: Pick<LiteralDynamicCodeReceipt, "evalCalls" | "functionSites">,
  contracts: Pick<ProgramDynamicContracts, "resolver" | "ambientThisMayBeGlobal">,
): IrUnsupportedError | undefined {
  const kinds = [
    ["eval", code.evalCalls.keys()],
    ["function", code.functionSites.keys()],
  ] as const;
  for (const [kind, sites] of kinds)
    for (const site of sites)
      if (!builtinIsPristine(site.expression as ts.Identifier, contracts)) return siteRefusal(NOT_PRISTINE[kind]);
  return undefined;
}

/**
 * The global the site names is the realm's built-in at every site: no source rebinds it (`isPristineBuiltinGlobal`,
 * absent off the native lane), and no sloppy function lets its ambient `this`, the global object, escape and write it
 * unseen.
 */
function builtinIsPristine(
  name: ts.Identifier,
  contracts: Pick<ProgramDynamicContracts, "resolver" | "ambientThisMayBeGlobal">,
): boolean {
  return contracts.resolver.isPristineBuiltinGlobal?.(name) === true && !contracts.ambientThisMayBeGlobal;
}

function siteRefusal(gap: string): IrUnsupportedError {
  return new IrUnsupportedError(
    "literal-eval-site-unsupported",
    "select",
    `ir/from-ast: ${gap} in ${MODULE_INIT_UNIT_NAME}`,
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

/** The one declaration a `function` source holds: the receipt matched its text with a qualifying site's. */
export function literalFunctionDeclaration(source: ts.SourceFile): ts.FunctionDeclaration {
  return source.statements[0] as ts.FunctionDeclaration;
}

/** Whether an identifier of `sourceFile` uses the prefix the dynamic functions' synthesized names are made of. */
export function usesReservedDynamicFunctionPrefix(sourceFile: ts.SourceFile): boolean {
  return sourceFile.text.includes(DYNAMIC_FUNCTION_PREFIX) && reservedPrefixIdentifier(sourceFile, undefined);
}

function qualifyingSites(file: ts.SourceFile): readonly QualifyingSite[] {
  const sites: QualifyingSite[] = [];
  const counts = { eval: 0, function: 0 };
  const add = (site: QualifyingSite["site"], kind: LiteralDynamicCodeKind, text: string | undefined) => {
    if (text !== undefined) sites.push({ site, kind, name: literalDynamicCodeFileName(kind, counts[kind]++), text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) add(node, "eval", literalEvalText(node));
    if (ts.isCallExpression(node) || ts.isNewExpression(node))
      add(node, "function", literalFunctionText(node, `${DYNAMIC_FUNCTION_PREFIX}${counts.function}`));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return sites;
}

/** The text a qualifying eval site runs; undefined when the site does not qualify. */
function literalEvalText(call: ts.CallExpression): string | undefined {
  const [argument] = call.arguments;
  if (
    !calleeIsUnshadowedGlobal(call, "eval") ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteralLike(argument!) ||
    !runsInSloppyGlobalCode(call) ||
    !discardsValue(call)
  )
    return undefined;
  return textRunsAsScript(call, argument.text) ? argument.text : undefined;
}

/**
 * The source of the function a qualifying `Function` site creates, its declaration named `name`; undefined when the
 * site does not qualify: every argument is a string literal.
 */
function literalFunctionText(site: ts.CallExpression | ts.NewExpression, name: string): string | undefined {
  const pieces = site.arguments ?? [];
  const texts = pieces.flatMap((piece) => (ts.isStringLiteralLike(piece) ? [piece.text] : []));
  if (!calleeIsUnshadowedGlobal(site, "Function") || texts.length !== pieces.length) return undefined;
  const parameters = texts.slice(0, -1).join(",");
  const text = functionSourceText(name, parameters, texts.at(-1) ?? "");
  return functionTextIsValid(texts, text, name, parameters) ? text : undefined;
}

/** The site calls (or constructs) the global `name`, unshadowed: no scope of its source and no `with` binds it. */
function calleeIsUnshadowedGlobal(site: ts.CallExpression | ts.NewExpression, name: string): boolean {
  return (
    !(ts.isCallExpression(site) && site.questionDotToken) &&
    ts.isIdentifier(site.expression) &&
    site.expression.text === name &&
    !resolvesToSourceBinding(site.expression) &&
    ts.findAncestor(site, ts.isWithStatement) === undefined
  );
}

/**
 * The rules every literal text keeps to run as a separate script of the program, whatever its kind; undefined when it
 * breaks one. No piece of it may hold an HTML-like comment: its TypeScript parse is not the Script the spec runs. Its
 * parse has no static SyntaxError (`staticSyntaxError`, the kind's own check) and no Script-only early error. It
 * stores into no identifier and binds no `var`, `let`, `const` or class (`bindsOrEvaluates`): the proofs over a
 * script binding see only the writes in its own file. It names neither `eval` nor, other than as its kind's `own`
 * name, the reserved prefix. The Prepared entry also keeps a text only when the compile's gates pass it as they pass
 * an entry (`test262-prepared-entry.ts`).
 */
function separateScript(
  pieces: readonly string[],
  text: string,
  staticSyntaxError: (script: ParsedEvalScript) => boolean,
  own: (sourceFile: ts.SourceFile) => ts.Identifier | undefined,
): ParsedEvalScript | undefined {
  if (pieces.some(hasHtmlLikeComment)) return undefined;
  const script = parseEvalSource(text, false, false);
  const { sourceFile } = script;
  return staticSyntaxError(script) ||
    hasScriptOnlyEarlyError(sourceFile) ||
    bindsOrEvaluates(sourceFile) ||
    reservedPrefixIdentifier(sourceFile, own(sourceFile))
    ? undefined
    : script;
}

/**
 * A separate script that is also what CreateDynamicFunction's separate parses accept (`fitsFunctionSourceText`). Only
 * the assembled declaration is checked for early errors, never a wrapper of the parameters alone: an arrow wrapper
 * would reject sloppy duplicate parameters (`Function("a,a", "return a")` is valid). An early error the shared checks
 * miss fails the compile's own gates on the joined source, as an eval text's does.
 */
function functionTextIsValid(pieces: readonly string[], text: string, name: string, parameters: string): boolean {
  const script = separateScript(
    pieces,
    text,
    ({ sourceFile }) => sloppyScriptHasStaticSyntaxError(sourceFile),
    (sourceFile) => literalFunctionDeclaration(sourceFile).name,
  );
  if (script === undefined) return false;
  const { sourceFile } = script;
  // A parse without errors of a text that starts `function <name>(` holds that declaration first; only one with
  // more statements than it, which the span check refuses, may hold it without a body.
  const { body } = literalFunctionDeclaration(sourceFile);
  return fitsFunctionSourceText(
    text,
    name,
    parameters,
    sourceFile.statements.length,
    body?.getStart(sourceFile) ?? -1,
    body?.end ?? -1,
  );
}

/** Whether an identifier under `node`, other than `own`, starts with the dynamic functions' prefix. */
function reservedPrefixIdentifier(node: ts.Node, own: ts.Identifier | undefined): boolean {
  if (ts.isIdentifier(node) && node !== own && node.text.startsWith(DYNAMIC_FUNCTION_PREFIX)) return true;
  return ts.forEachChild(node, (child) => reservedPrefixIdentifier(child, own)) === true;
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
 * A separate script that is also a Script, not a Module, that PerformEval runs without a SyntaxError, declares
 * nothing, and lowers as one init chunk.
 */
function textRunsAsScript(call: ts.CallExpression, text: string): boolean {
  const script = separateScript(
    [text],
    text,
    (parsed) =>
      foldedEvalStaticSyntaxError(call, true, parsed, foldedEvalDeclarationNames(parsed.sourceFile), undefined) !==
      undefined,
    () => undefined,
  );
  if (script === undefined) return false;
  const names = foldedEvalDeclarationNames(script.sourceFile);
  return (
    !ts.isExternalModule(script.sourceFile) &&
    names.varNames.size === 0 &&
    names.blockFunctionNames.size === 0 &&
    planModuleInitChunks(script.statements.map((node) => ({ node }))).length <= 1
  );
}
