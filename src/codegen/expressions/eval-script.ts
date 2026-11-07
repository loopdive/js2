// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 A2c) The static half of a literal eval: parsing its Script, the
 * SyntaxErrors a fold throws without running it, and whether the runtime-eval
 * provider owns its declarations. The legacy fold (`tryStaticEvalInline`) and
 * the IR's global-eval arm (`runtimeEvalOwnsGlobalEval`) both read these, so
 * the IR lowers a global eval statement only when legacy routes it to the
 * provider. Legacy also routes some the IR does not admit (Annex B collisions,
 * strict scoped declarations, caller lexical collisions, const-resolved direct
 * sources).
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { isUseStrictDirectiveExpression } from "../helpers/use-strict-directive.js";
import { foldedEvalDeclarationNames } from "../registry/expression-helper-delegates.js";
import { evalCallerCapabilities, foldedEvalEarlyError } from "./eval-early-errors.js";
import { EVAL_SOURCE_FILENAME } from "./eval-source.js";

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

export type EvalDeclarationNames = ReturnType<typeof foldedEvalDeclarationNames>;

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
    // §11.2.2 matches the RAW token — see helpers/use-strict-directive.ts.
    if (isUseStrictDirectiveExpression(s.expression)) return true;
    // Some other directive (e.g. "use asm") → keep scanning the prologue.
  }
  return false;
}

export function parseEvalScript(
  ctx: CodegenContext,
  call: ts.CallExpression,
  directEval: boolean,
  source: string,
): ParsedEvalScript {
  // Foreign eval nodes have no parent chain back to the caller. A directive is
  // equivalent to inherited strictness and lets every nested emitter observe it.
  const injected = directEval && isStrictContext(call, false);
  const text = injected ? `"use strict";\n${source}` : source;
  const sourceFile = ts.createSourceFile(EVAL_SOURCE_FILENAME, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // The synthetic directive is not source text and cannot become a completion value.
  const statements = injected ? ts.factory.createNodeArray(sourceFile.statements.slice(1)) : sourceFile.statements;
  const bodyIsStrict = evalBodyHasUseStrictDirective(statements);
  const evalIsStrict = bodyIsStrict || (directEval && isStrictContext(call, ctx.inferModuleStrictArguments));
  return { sourceFile, statements, bodyIsStrict, evalIsStrict };
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
  declarationNames: EvalDeclarationNames,
  globalLexicals: ReadonlySet<string> | undefined,
): string | undefined {
  // `parseDiagnostics` is an internal field on SourceFile.
  const parseDiag = (script.sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiag && parseDiag.length > 0) return "Invalid eval source";
  // (#5157) §15.1.1 NewTarget / SuperProperty / SuperCall admissibility is a
  // property of the CALL SITE, not of the eval source.
  const earlyError = foldedEvalEarlyError(
    script.sourceFile,
    script.evalIsStrict,
    evalCallerCapabilities(call, directEval),
  );
  if (earlyError !== undefined || script.evalIsStrict || globalLexicals === undefined) return earlyError;
  for (const name of declarationNames.varNames) {
    if (globalLexicals.has(name)) return `Identifier '${name}' has already been declared`;
  }
  return undefined;
}

/**
 * EvalDeclarationInstantiation §19.2.1.3 step 16 / CanDeclareGlobal*: when a
 * sloppy eval's VariableEnvironment is the GlobalEnvironmentRecord, its var and
 * function declarations become own configurable properties of the realm's
 * global object, gated by IsExtensible — runtime state a fold cannot know. The
 * interpreter implements all of it (`prepareGlobalDeclarations`,
 * `src/interp/eval-environment.ts`), so the provider owns such a Script.
 * `varNames` covers top-level FunctionDeclarations too; Annex B block functions
 * keep their own rule in the fold.
 */
export function providerOwnsEvalDeclarations(
  script: ParsedEvalScript,
  declarationNames: EvalDeclarationNames,
  varEnvIsGlobal: boolean,
): boolean {
  return varEnvIsGlobal && !script.evalIsStrict && declarationNames.varNames.size > 0;
}
