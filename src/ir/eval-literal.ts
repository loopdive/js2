// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7363 slice A) A top-level literal direct eval runs its text as a called script source of the program.
 *
 * A site qualifies when running its text as a separate sloppy Script, in the program's one global scope, is what
 * PerformEval does with it: the call sits in global code of a sloppy Script under no scope that binds names of its
 * own, and the text is a valid Script that declares nothing. The Prepared entry adds each qualifying text as the
 * script `<eval:N>.js`; this module owns the site predicate and the receipt that a site and a script belong together.
 */
import { ts } from "../ts-api.js";
import { foldedEvalDeclarationNames } from "../frontend/eval/declaration-names.js";
import {
  evalBodyHasUseStrictDirective,
  foldedEvalStaticSyntaxError,
  parseEvalSource,
} from "../frontend/eval/script.js";
import { planModuleInitChunks } from "../shared/module-init-chunk-plan.js";
import { resolvesToSourceBinding } from "./analysis/ast-scope.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";

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
 * the literal's value, and no call or source occurs twice. Returns the related calls and sources, and each source's
 * dependency on the entry, which holds its call: the inventory orders a source after its dependencies, so the entry
 * is planned and lowered before the texts it runs, whatever the names sort to.
 */
export function verifyLiteralEvalSources(
  rows: readonly LiteralEvalSource[],
  sourceFiles: readonly ts.SourceFile[],
  entry: ts.SourceFile,
): {
  readonly calls: ReadonlySet<ts.CallExpression>;
  readonly sources: ReadonlySet<ts.SourceFile>;
  readonly dependencies: ReadonlyMap<ts.SourceFile, readonly ts.SourceFile[]>;
} {
  const calls = new Set<ts.CallExpression>();
  const sources = new Set<ts.SourceFile>();
  for (const { call, source } of rows) {
    const refused = (detail: string): never => {
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `literal eval ${source.fileName}: ${detail}`);
    };
    if (calls.has(call) || sources.has(source)) refused("a call or a source occurs in two rows");
    calls.add(call);
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
    !runsInSloppyGlobalCode(call)
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
 * The text is a Script, not a Module, that PerformEval runs without a SyntaxError, declares nothing, holds no nested
 * eval, and lowers as one init chunk.
 */
function textRunsAsScript(call: ts.CallExpression, text: string): boolean {
  const script = parseEvalSource(text, false, false);
  const names = foldedEvalDeclarationNames(script.sourceFile);
  return (
    !ts.isExternalModule(script.sourceFile) &&
    foldedEvalStaticSyntaxError(call, true, script, names, undefined) === undefined &&
    !returnsOutsideFunction(script.sourceFile) &&
    names.varNames.size === 0 &&
    names.blockFunctionNames.size === 0 &&
    !declaresOrEvaluates(script.sourceFile) &&
    planModuleInitChunks(script.statements.map((node) => ({ node }))).length <= 1
  );
}

/**
 * A `return` outside every function of the text: a Script early error. The shared check does not report it yet:
 * adding the rule there changes the legacy fold's output for `eval("return;")` (parse-failure-5.js).
 */
function returnsOutsideFunction(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  return !ts.isFunctionLike(node) && ts.forEachChild(node, returnsOutsideFunction) === true;
}

/** A `var`/`let`/`const` list or a class anywhere in the text, or the name `eval`. */
function declaresOrEvaluates(node: ts.Node): boolean {
  if (
    ts.isVariableDeclarationList(node) ||
    ts.isClassDeclaration(node) ||
    (ts.isIdentifier(node) && node.text === "eval")
  )
    return true;
  return ts.forEachChild(node, declaresOrEvaluates) === true;
}
