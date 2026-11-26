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
  evalBodyHasUseStrictDirective,
  foldedEvalStaticSyntaxError,
  parseEvalSource,
  sloppyScriptHasStaticSyntaxError,
  superIsSupplied,
} from "../frontend/eval/script.js";
import { fitsFunctionSourceText, functionSourceText } from "../interp/function-source-text.js";
import { identifierWritesOf } from "../shared/binding-writes.js";
import { planModuleInitChunks } from "../shared/module-init-chunk-plan.js";
import { resolvesToSourceBinding } from "./analysis/ast-scope.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";

export type LiteralDynamicCodeKind = "eval" | "function";

/** A qualifying site, its kind, and the program script that holds its text. */
export interface LiteralDynamicCodeSource {
  readonly site: ts.CallExpression | ts.NewExpression;
  readonly kind: LiteralDynamicCodeKind;
  readonly source: ts.SourceFile;
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

/** Pair the analyzed entry's qualifying sites with the `added` scripts the entry's texts became. */
export function pairLiteralDynamicCodeSources(
  entry: ts.SourceFile,
  sourceFiles: readonly ts.SourceFile[],
  added: number,
): readonly LiteralDynamicCodeSource[] {
  const invalid = (detail: string): never => {
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", `literal dynamic code pairing: ${detail}`);
  };
  const sites = qualifyingSites(entry);
  if (sites.length !== added) invalid(`the analyzed entry has ${sites.length} sites for ${added} added scripts`);
  const byName = new Map(sourceFiles.map((source) => [source.fileName, source]));
  return sites.map(({ site, kind, name }) => ({
    site,
    kind,
    source: byName.get(name) ?? invalid(`${name} is not a script of the analyzed program`),
  }));
}

/**
 * The receipt: each row's site is a qualifying site of its kind in the entry, its source is a script of the program
 * whose text is the site's, and no site or source occurs twice. Returns the related eval calls, every related source
 * and the called ones among them (an eval's: its call site runs it), and each source's dependency on the entry, which
 * holds its site: the inventory orders a source after its dependencies, so the entry is planned and lowered before the
 * texts it runs, whatever the names sort to.
 */
export function verifyLiteralDynamicCodeSources(
  rows: readonly LiteralDynamicCodeSource[] | undefined,
  sourceFiles: readonly ts.SourceFile[],
  entry: ts.SourceFile,
): {
  readonly evalCalls: ReadonlySet<ts.CallExpression>;
  readonly sources: ReadonlySet<ts.SourceFile>;
  readonly calledSources: ReadonlySet<ts.SourceFile>;
  readonly dependencies: ReadonlyMap<ts.SourceFile, readonly ts.SourceFile[]>;
} {
  const qualifying = new Map(qualifyingSites(entry).map((row) => [row.site, row]));
  const sites = new Set<ts.Node>();
  const evalCalls = new Set<ts.CallExpression>();
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
      evalCalls.add(site as ts.CallExpression);
      calledSources.add(source);
    }
  }
  return { evalCalls, sources, calledSources, dependencies: new Map([...sources].map((source) => [source, [entry]])) };
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
    call.questionDotToken ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "eval" ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteralLike(argument!) ||
    resolvesToSourceBinding(call.expression) ||
    !runsInSloppyGlobalCode(call)
  )
    return undefined;
  return textRunsAsScript(call, argument.text) ? argument.text : undefined;
}

/**
 * The source of the function a qualifying `Function` site creates, its declaration named `name`; undefined when the
 * site does not qualify. The callee is the global `Function` (no scope of the source and no `with` binds the name),
 * and every argument is a string literal.
 */
function literalFunctionText(site: ts.CallExpression | ts.NewExpression, name: string): string | undefined {
  const pieces = site.arguments ?? [];
  const texts = pieces.flatMap((piece) => (ts.isStringLiteralLike(piece) ? [piece.text] : []));
  if (
    (ts.isCallExpression(site) && site.questionDotToken) ||
    !ts.isIdentifier(site.expression) ||
    site.expression.text !== "Function" ||
    texts.length !== pieces.length ||
    resolvesToSourceBinding(site.expression) ||
    ts.findAncestor(site, ts.isWithStatement) !== undefined
  )
    return undefined;
  const parameters = texts.slice(0, -1).join(",");
  const text = functionSourceText(name, parameters, texts.at(-1) ?? "");
  return !texts.some(usesHtmlLikeComment) && functionTextIsValid(text, name, parameters) ? text : undefined;
}

/**
 * The assembled text is what CreateDynamicFunction's separate parses accept (`fitsFunctionSourceText`), has no early
 * error, and keeps every rule the eval texts keep: it stores into no identifier and names neither `eval` nor the
 * reserved prefix. Only the assembled declaration is checked for early errors, never a wrapper of the parameters
 * alone: an arrow wrapper would reject sloppy duplicate parameters (`Function("a,a", "return a")` is valid).
 */
function functionTextIsValid(text: string, name: string, parameters: string): boolean {
  const { sourceFile } = parseEvalSource(text, false, false);
  const declaration = sourceFile.statements[0];
  return (
    !sloppyScriptHasStaticSyntaxError(sourceFile) &&
    declaration !== undefined &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.body !== undefined &&
    fitsFunctionSourceText(
      text,
      name,
      parameters,
      sourceFile.statements.length,
      declaration.body.getStart(sourceFile),
      declaration.body.end,
    ) &&
    !scriptEarlyError(sourceFile, undefined) &&
    uncoveredEarlyErrorRule(sourceFile, false, new Set()) === undefined &&
    !bindsOrEvaluates(declaration) &&
    !reservedPrefixIdentifier(declaration, declaration.name)
  );
}

/**
 * An Annex B.1.1 HTML-like comment: `<!--`, or `-->` that only whitespace and block comments precede on its line.
 * TypeScript's parser does not implement them, so such a piece is no site.
 */
function usesHtmlLikeComment(piece: string): boolean {
  return /<!--|(?:^|[\n\r\u2028\u2029])\s*(?:\/\*[\s\S]*?\*\/\s*)*-->/.test(piece);
}

/**
 * The first early error of CreateDynamicFunction that neither the shared check nor the parse reports
 * (`sloppyScriptHasStaticSyntaxError`): a function with a `"use strict"` body and non-simple parameters, a label
 * nested in a label of the same name, `with` in strict code, or `super` outside a method (`superIsSupplied`). A text
 * with one is no site; the rule is the name its site refuses by (#7487 item 3).
 */
function uncoveredEarlyErrorRule(
  node: ts.Node,
  strict: boolean,
  labels: ReadonlySet<string>,
): "use-strict-non-simple-params" | "duplicate-label" | "strict-with" | "super-outside-method" | undefined {
  let inner = labels;
  if (ts.isFunctionLike(node)) {
    const body = (node as ts.FunctionLikeDeclaration).body;
    const directive = body !== undefined && ts.isBlock(body) && evalBodyHasUseStrictDirective(body.statements);
    const simple = node.parameters.every(
      (parameter) => ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken,
    );
    if (directive && !simple) return "use-strict-non-simple-params";
    strict ||= directive;
    inner = new Set();
  } else if (ts.isClassLike(node)) strict = true;
  else if (ts.isWithStatement(node) && strict) return "strict-with";
  else if (node.kind === ts.SyntaxKind.SuperKeyword && !superIsSupplied(node)) return "super-outside-method";
  else if (ts.isLabeledStatement(node)) {
    if (labels.has(node.label.text)) return "duplicate-label";
    inner = new Set([...labels, node.label.text]);
  }
  return ts.forEachChild(node, (child) => uncoveredEarlyErrorRule(child, strict, inner));
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
 * The text is a Script, not a Module, that PerformEval runs without a SyntaxError, declares nothing, stores into no
 * identifier, holds no nested eval, names no reserved identifier, and lowers as one init chunk. The static check here
 * is the spec's; the Prepared entry also keeps a text only when the compile's gates pass it as they pass an entry
 * (`test262-prepared-entry.ts`).
 */
function textRunsAsScript(call: ts.CallExpression, text: string): boolean {
  const script = parseEvalSource(text, false, false);
  const names = foldedEvalDeclarationNames(script.sourceFile);
  return (
    !ts.isExternalModule(script.sourceFile) &&
    foldedEvalStaticSyntaxError(call, true, script, names, undefined) === undefined &&
    !scriptEarlyError(script.sourceFile, undefined) &&
    names.varNames.size === 0 &&
    names.blockFunctionNames.size === 0 &&
    !bindsOrEvaluates(script.sourceFile) &&
    !reservedPrefixIdentifier(script.sourceFile, undefined) &&
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
 * (`preparedBindingRewritten`). A store into the text's own parameter or local refuses too: no scope walk tells it
 * from a caller binding (RV7432 B2 fix (b), which both kinds take).
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
