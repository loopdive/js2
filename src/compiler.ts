// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "./ts-api.js";
import {
  analyzeFiles,
  analyzeMultiSource,
  analyzeSource,
  IncrementalLanguageService,
  type TypedAST,
} from "./checker/index.js";
import { getNullablePrimitiveInfo } from "./checker/type-mapper.js";
import { generateLinearModule, generateLinearMultiModule } from "./codegen-linear/index.js";
import { resetCompileDepth } from "./codegen/expressions.js";
import { generateModule, generateMultiModule } from "./codegen/index.js";
import { isFatalCodegenDiagnostic } from "./codegen/context/errors.js";
import type { WasmModule } from "./ir/types.js";
import {
  buildImportManifest,
  checkJsTypeCoverage,
  DOWNGRADE_DIAG_CODES,
  looksLikeTsSyntaxOnJs,
} from "./compiler/import-manifest.js";
import { applyCabiTransform, generateDts, generateImportsHelper, widenNonDefaultableTypes } from "./compiler/output.js";
import {
  detectEarlyErrors,
  pushSourceAnchoredDiagnostic,
  rewriteEvalSuperCall,
  validateHardenedMode,
  validateSafeMode,
} from "./compiler/validation.js";
import { emitBinary, emitBinaryWithSourceMap, emitSourceMappingURLSection } from "./emit/binary.js";
import { WasmEncoder } from "./emit/encoder.js";
import { generateSourceMap } from "./emit/sourcemap.js";
import { emitWat } from "./emit/wat.js";
import { applyDefineSubstitutions, applyDefineSubstitutionsWithMap } from "./compiler/define-substitution.js";
import { rewriteCjsRequire, rewriteCjsRequireWithMap } from "./cjs-rewrite.js";
import { preprocessImports } from "./import-resolver.js";
import { PositionMap } from "./position-map.js";
import type { CompileError, CompileOptions, CompileResult } from "./index.js";
import { optimizeBinaryAsync } from "./optimize.js";
import { generateWit } from "./wit-generator.js";
export { compileToObjectSource } from "./compiler/output.js";
export type { ObjectCompileResult } from "./compiler/output.js";

/**
 * Propagate codegen diagnostics raised by the linear-memory backend (#1868).
 *
 * The WasmGC backend returns `{ module, errors }` and the caller fails the
 * compile when any `Codegen error:` is present. The linear-memory backend
 * historically only returned a `WasmModule` and accumulated its
 * unsupported-construct diagnostics into `ctx.errors`, which the compiler
 * never read — so an unhandled construct (e.g. `String.prototype.repeat`)
 * silently produced a structurally invalid binary (a stack-underflowing
 * `local.set`/`local.tee`) while reporting `success: true`. That invalid
 * wasm then crashed downstream consumers (the benchmark harness, #1868).
 *
 * `mod.codegenErrors` now surfaces those diagnostics. Returns `true` when the
 * linear backend reported at least one error (after copying them into
 * `errors`), telling the caller to bail with `success: false` instead of
 * emitting the invalid binary.
 */
const CODEGEN_ERROR_PREFIX = "Codegen error:";

/**
 * Cosmetic-only: prefix a linear-backend diagnostic with `"Codegen error:"`
 * for human readability when it isn't already so prefixed. The compile-failure
 * gate keys on severity (#1921), not on this prefix.
 */
function withCodegenPrefix(message: string): string {
  return message.startsWith(CODEGEN_ERROR_PREFIX) ? message : `${CODEGEN_ERROR_PREFIX} ${message}`;
}

function collectLinearCodegenErrors(mod: WasmModule, errors: CompileError[]): boolean {
  let fatal = false;
  const diags = mod.codegenErrors;
  if (!diags || diags.length === 0) return false;
  for (const err of diags) {
    if (isFatalCodegenDiagnostic(err)) fatal = true;
    errors.push({
      message: withCodegenPrefix(err.message),
      line: err.line,
      column: err.column,
      severity: isFatalCodegenDiagnostic(err) ? "error" : "warning",
    });
  }
  return fatal;
}

const HARD_TS_DIAG_CODES = new Set([
  2322, // "Type 'X' is not assignable to type 'Y'"
  2345, // "Argument of type 'X' is not assignable to parameter of type 'Y'"
  // ── ECMA-262 §12.6.1 Early Errors: reserved word in auto-strict context ──
  // TS1213/1214 fire when a strict-mode-reserved word (let/static/yield/…)
  // is used as a class name or as a module-level binding. Per spec these
  // are always parse-time SyntaxErrors regardless of an explicit `"use strict"`
  // directive, because ClassDefinition/ModuleBody are strict mode code
  // (ES2024 §10.2.1). TypeScript classifies these as semantic diagnostics,
  // not syntactic, so they previously slipped past the syntactic-only gate
  // and let `class let {}` / module-level `let` compile and instantiate.
  // Treating them as hard errors aligns with test262 `negative.phase: parse`
  // (#1435).
  1213, // "Identifier expected. 'X' is a reserved word in strict mode. Class definitions are automatically in strict mode."
  1214, // "Identifier expected. 'X' is a reserved word in strict mode. Modules are automatically in strict mode."
]);

/**
 * #862: TypeScript infers `function f([,])` as `function f([,]: [any?])` — a tuple type.
 * A call site like `f(generator)` then trips TS2345 even though, in JS/TS at runtime,
 * a binding-pattern parameter destructures any iterable per ECMA-262 §13.3.3.6
 * (IteratorBindingInitialization). Suppress 2345 when the target parameter uses an
 * array/object binding pattern and lacks an explicit type annotation — the inferred
 * tuple type is a TypeScript fiction that does not reflect runtime semantics.
 */
function isBindingPatternFalsePositive(diag: ts.Diagnostic, checker: ts.TypeChecker): boolean {
  if (diag.code !== 2345) return false;
  const file = diag.file;
  if (!file || diag.start === undefined) return false;
  const pos = diag.start;
  function findNode(node: ts.Node): ts.Node | undefined {
    if (pos < node.getStart(file) || pos >= node.getEnd()) return undefined;
    let found: ts.Node = node;
    node.forEachChild((child) => {
      const inner = findNode(child);
      if (inner) found = inner;
    });
    return found;
  }
  let n: ts.Node | undefined = findNode(file);
  while (n && !ts.isCallExpression(n) && !ts.isNewExpression(n)) {
    n = n.parent;
  }
  if (!n || !(ts.isCallExpression(n) || ts.isNewExpression(n))) return false;
  const args = n.arguments;
  if (!args) return false;
  let argIdx = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (pos >= a.getStart(file) && pos < a.getEnd()) {
      argIdx = i;
      break;
    }
  }
  if (argIdx < 0) return false;
  const sig = checker.getResolvedSignature(n);
  if (!sig) return false;
  const paramDecl = sig.getDeclaration()?.parameters?.[argIdx];
  if (!paramDecl) return false;
  if (paramDecl.type) return false; // explicit annotation — respect it
  return ts.isArrayBindingPattern(paramDecl.name) || ts.isObjectBindingPattern(paramDecl.name);
}

function findSmallestNodeAtPosition(file: ts.SourceFile, pos: number): ts.Node | undefined {
  function visit(node: ts.Node): ts.Node | undefined {
    if (pos < node.getStart(file) || pos >= node.getEnd()) return undefined;
    let found: ts.Node = node;
    node.forEachChild((child) => {
      const inner = visit(child);
      if (inner) found = inner;
    });
    return found;
  }
  return visit(file);
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

type NullishExclusion = "null" | "undefined" | "nullish";

interface NullGuardFact {
  varName: string;
  narrowedBranch: "then" | "else";
  excludes: NullishExclusion;
  provesNonNull: boolean;
}

function nullishLiteralKind(expr: ts.Expression): "null" | "undefined" | null {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  return null;
}

function nullishPresenceOfType(type: ts.Type): { hasNull: boolean; hasUndefined: boolean } {
  let hasNull = false;
  let hasUndefined = false;
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & ts.TypeFlags.Null) hasNull = true;
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) hasUndefined = true;
  }
  return { hasNull, hasUndefined };
}

function excludesAllNullish(type: ts.Type, excludes: NullishExclusion): boolean {
  const presence = nullishPresenceOfType(type);
  if (!presence.hasNull && !presence.hasUndefined) return false;
  if (presence.hasNull && excludes === "undefined") return false;
  if (presence.hasUndefined && excludes === "null") return false;
  return true;
}

function detectNullGuardForVar(checker: ts.TypeChecker, expr: ts.Expression, varName: string): NullGuardFact | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = isStrictNeq || isLooseNeq;
  const isEq = isStrictEq || isLooseEq;
  if (!isNeq && !isEq) return null;

  const rightNullish = nullishLiteralKind(expr.right);
  const leftNullish = nullishLiteralKind(expr.left);
  if (!rightNullish && !leftNullish) return null;

  const comparedNullish = rightNullish ?? leftNullish;
  const nonNullSide = rightNullish ? expr.left : expr.right;
  if (!ts.isIdentifier(nonNullSide) || nonNullSide.text !== varName) return null;
  const excludes: NullishExclusion = isLooseEq || isLooseNeq ? "nullish" : comparedNullish!;
  return {
    varName,
    narrowedBranch: isNeq ? "then" : "else",
    excludes,
    provesNonNull: excludesAllNullish(checker.getTypeAtLocation(nonNullSide), excludes),
  };
}

function detectConditionNullGuard(
  checker: ts.TypeChecker,
  condition: ts.Expression,
  varName: string,
): NullGuardFact | null {
  const direct = detectNullGuardForVar(checker, condition, varName);
  if (direct) return direct;
  if (ts.isIdentifier(condition)) {
    const symbol = checker.getSymbolAtLocation(condition);
    const decl = symbol?.valueDeclaration;
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return detectNullGuardForVar(checker, decl.initializer, varName);
    }
  }
  if (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(condition.operand)
  ) {
    const alias = detectConditionNullGuard(checker, condition.operand, varName);
    if (!alias) return null;
    return { ...alias, narrowedBranch: alias.narrowedBranch === "then" ? "else" : "then" };
  }
  return null;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let inner = expr;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = ts.isParenthesizedExpression(inner)
      ? inner.expression
      : ts.isAsExpression(inner)
        ? inner.expression
        : ts.isNonNullExpression(inner)
          ? inner.expression
          : (inner as ts.TypeAssertion).expression;
  }
  return inner;
}

function findNullablePrimitiveIdentifier(node: ts.Node, checker: ts.TypeChecker): ts.Identifier | null {
  if (ts.isIdentifier(node) && getNullablePrimitiveInfo(checker.getTypeAtLocation(node))) return node;
  let found: ts.Identifier | null = null;
  node.forEachChild((child) => {
    if (!found) found = findNullablePrimitiveIdentifier(child, checker);
  });
  return found;
}

function findIdentifierUseAtDiagnostic(
  file: ts.SourceFile,
  pos: number,
  checker: ts.TypeChecker,
): ts.Identifier | null {
  let node = findSmallestNodeAtPosition(file, pos);
  let direct: ts.Node | undefined = node;
  while (direct && !ts.isIdentifier(direct)) direct = direct.parent;
  if (direct && ts.isIdentifier(direct) && getNullablePrimitiveInfo(checker.getTypeAtLocation(direct))) return direct;

  while (node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const rhs = unwrapExpression(node.right);
      if (ts.isIdentifier(rhs) && getNullablePrimitiveInfo(checker.getTypeAtLocation(rhs))) return rhs;
      return findNullablePrimitiveIdentifier(node.right, checker);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      return findNullablePrimitiveIdentifier(node.expression, checker);
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      for (const arg of node.arguments) {
        const found = findNullablePrimitiveIdentifier(arg, checker);
        if (found) return found;
      }
    }
    node = node.parent;
  }
  return null;
}

function containingFunctionLike(node: ts.Node): ts.SignatureDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function targetTypeForIdentifierUse(id: ts.Identifier, checker: ts.TypeChecker): ts.Type | null {
  let current: ts.Node | undefined = id;
  while (current) {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isDescendantOf(id, current.right)) return checker.getTypeAtLocation(current.left);
    }
    if (ts.isVariableDeclaration(current) && current.initializer && isDescendantOf(id, current.initializer)) {
      return checker.getTypeAtLocation(current.name);
    }
    if (ts.isReturnStatement(current) && current.expression && isDescendantOf(id, current.expression)) {
      const fn = containingFunctionLike(current);
      const sig = fn ? checker.getSignatureFromDeclaration(fn) : undefined;
      return sig ? checker.getReturnTypeOfSignature(sig) : null;
    }
    if ((ts.isCallExpression(current) || ts.isNewExpression(current)) && current.arguments) {
      const args = current.arguments;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!isDescendantOf(id, arg)) continue;
        const sig = checker.getResolvedSignature(current);
        const param = sig?.parameters[i];
        return param ? checker.getTypeOfSymbol(param) : null;
      }
    }
    current = current.parent;
  }
  return null;
}

function identifierHasNonNullProofInAncestor(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  let current: ts.Node | undefined = id.parent;
  while (current) {
    if (ts.isIfStatement(current)) {
      const guard = detectConditionNullGuard(checker, current.expression, id.text);
      if (guard?.provesNonNull) {
        if (guard.narrowedBranch === "then" && isDescendantOf(id, current.thenStatement)) return true;
        if (guard.narrowedBranch === "else" && current.elseStatement && isDescendantOf(id, current.elseStatement)) {
          return true;
        }
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * #1928 — compute a diagnostic's `(line, character)` in the USER's original
 * source. `diag.start` is an offset in the rewritten `processedSource`; map it
 * back through the composed pre-parse `PositionMap`, then resolve the line and
 * column from the original `source` text. When the map is identity (no rewrite
 * fired) this is equivalent to the old direct
 * `diag.file.getLineAndCharacterOfPosition` lookup. Falls back to the processed
 * position if `diag.file` is somehow absent.
 */
function remapDiagnosticPosition(
  diag: ts.Diagnostic,
  originalSource: string,
  positionMap: PositionMap,
): { line: number; character: number } {
  if (!diag.file) return { line: 0, character: 0 };
  const processedStart = diag.start ?? 0;
  if (positionMap.isIdentity) {
    return diag.file.getLineAndCharacterOfPosition(processedStart);
  }
  const origOffset = Math.min(Math.max(0, positionMap.toInputOffset(processedStart)), originalSource.length);
  // Resolve line/column from the original text. Counting newlines is O(offset)
  // but diagnostics are few; a shared line-start index would be premature here.
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < origOffset; i++) {
    if (originalSource.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  return { line, character: origOffset - lastNewline - 1 };
}

function isGuardedNullablePrimitiveDiagnostic(diag: ts.Diagnostic, checker: ts.TypeChecker): boolean {
  if (diag.code !== 2322 && diag.code !== 2345) return false;
  const file = diag.file;
  if (!file || diag.start === undefined) return false;
  const id = findIdentifierUseAtDiagnostic(file, diag.start, checker);
  if (!id) return false;
  const idType = checker.getTypeAtLocation(id);
  if (!getNullablePrimitiveInfo(idType)) return false;
  if (!identifierHasNonNullProofInAncestor(id, checker)) return false;
  const targetType = targetTypeForIdentifierUse(id, checker);
  if (!targetType) return false;
  const nonNullType = checker.getNonNullableType(idType);
  const assignable = (
    checker as ts.TypeChecker & { isTypeAssignableTo?: (source: ts.Type, target: ts.Type) => boolean }
  ).isTypeAssignableTo;
  return assignable ? assignable.call(checker, nonNullType, targetType) : false;
}

function isHardTypeScriptDiagnostic(diag: ts.Diagnostic, checker?: ts.TypeChecker): boolean {
  if (diag.category !== 1 || !HARD_TS_DIAG_CODES.has(diag.code)) return false;
  if (checker && isBindingPatternFalsePositive(diag, checker)) return false;
  if (checker && isGuardedNullablePrimitiveDiagnostic(diag, checker)) return false;
  return true;
}

/**
 * Detect named imports from node:fs / fs before import preprocessing strips them.
 * Returns a Set of function names imported from the fs module.
 */
function detectNodeFsImports(source: string): Set<string> {
  const result = new Set<string>();
  const sf = ts.createSourceFile("__detect_fs__.ts", source, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const mod = stmt.moduleSpecifier.text;
      if (mod === "node:fs" || mod === "fs") {
        const clause = stmt.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            result.add(spec.name.text);
          }
        }
      }
    }
  }
  return result;
}

/**
 * Orchestrates the full compilation pipeline:
 * TS Source → tsc Parser+Checker → Codegen → Binary + WAT
 *
 * Async because the optional Binaryen optimizer is lazy-loaded only when
 * wasm-opt is requested (#1757 / GH #986), so normal compilation and
 * standalone bundles do not need to embed Binaryen.
 */
export async function compileSource(
  source: string,
  options: CompileOptions = {},
  /** Optional persistent language service for incremental compilation */
  languageService?: IncrementalLanguageService,
): Promise<CompileResult> {
  // The whole codegen pipeline is synchronous; the ONLY async step is the
  // optional Binaryen wasm-opt pass. Run the synchronous core, then apply
  // optimization (when requested) over the produced binary. A synchronous
  // entry point (compileSourceSync) is preserved for callers that cannot be
  // async — notably the JS `eval` host shim in runtime-eval.ts, which never
  // optimizes.
  const result = compileSourceSync(source, options, languageService);

  if (options.optimize && result.success) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = await optimizeBinaryAsync(result.binary, { level });
    if (optResult.optimized) {
      result.binary = optResult.binary;
    }
    if (optResult.warning) {
      result.errors.push({ message: optResult.warning, line: 0, column: 0, severity: "warning" });
    }
  }

  return result;
}

/**
 * Synchronous compilation core (no Binaryen optimization).
 *
 * Identical to {@link compileSource} but never runs the async wasm-opt pass —
 * the `optimize` option is ignored here. Use this only from synchronous
 * contexts that cannot await (the `eval` host shim). All other callers should
 * use the async {@link compileSource}.
 */
export function compileSourceSync(
  source: string,
  options: CompileOptions = {},
  /** Optional persistent language service for incremental compilation */
  languageService?: IncrementalLanguageService,
): CompileResult {
  // Reset compile-expression recursion depth counter for this compilation unit.
  // Without this, the depth accumulates across compilations in the same process
  // (e.g., test262 worker pool), causing false "depth exceeded" errors.
  resetCompileDepth();

  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  // Step 0a: Apply compile-time define substitutions (#1043)
  // #1928 — each pre-parse rewrite returns a PositionMap (output → its input);
  // we compose them so diagnostics computed against `processedSource` can be
  // reported at the user's ORIGINAL line/column instead of the rewritten one.
  const defineResult = options.define
    ? applyDefineSubstitutionsWithMap(source, options.define)
    : { source, positionMap: PositionMap.identity() };
  const definedSource = defineResult.source;

  // Step 0a.5: Rewrite CommonJS `const X = require('Y')` patterns to ESM `import`
  // declarations (#1279). This must run before preprocessImports so the resulting
  // import statements get the same declare-stub treatment as user-written imports,
  // and before `detectNodeFsImports` so `const fs = require('node:fs')` is picked
  // up as a node:fs import for WASI mode.
  const cjsResult = rewriteCjsRequireWithMap(definedSource);
  const cjsRewritten = cjsResult.source;

  // Step 0b: Pre-process imports (replace import * as X with declare namespace)
  // #1054: rewrite eval("...super()...") to a throwing IIFE so early-error
  // rules for PerformEval fire at runtime.
  //
  // Before preprocessing strips import declarations, detect node:fs imports
  // for WASI mode (preprocessing replaces them with declare stubs).
  // #1491 — detect named fs imports for both WASI (#1035 syscall path) and the
  // new JS-host imports (non-WASI). Detection is identical; the codegen branch
  // is selected based on `ctx.wasi` + `ctx.allowFs`.
  // #1928 — `rewriteEvalSuperCall` only rewrites `eval("…super()…")` to a
  // same-line throwing IIFE (a rare early-error edge); it never shifts lines, so
  // it contributes an identity map and is omitted from the composition.
  const cjsRewritten2 = rewriteEvalSuperCall(cjsRewritten);
  const wasiNodeFsFuncs = detectNodeFsImports(cjsRewritten);
  const preprocessed = preprocessImports(cjsRewritten2);
  const processedSource = preprocessed.source;
  // Composed map: processedSource → original source. Pipeline output order is
  // define → cjs → (eval/super, identity) → imports, so compose outermost-first.
  const positionMap = preprocessed.positionMap.compose(cjsResult.positionMap).compose(defineResult.positionMap);

  // Step 1: Parse and type-check
  let isJsMode = options.allowJs === true || (options.fileName?.endsWith(".js") ?? false);
  const defaultFileName = options.fileName ?? (isJsMode ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  let ast: TypedAST;
  if (languageService) {
    // Incremental path: reuse cached lib files via the language service
    languageService.updateSource(processedSource, effectiveFileName);
    ast = languageService.analyze({
      allowJs: options.allowJs,
      skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    });
  } else {
    ast = analyzeSource(processedSource, effectiveFileName, {
      allowJs: options.allowJs,
      skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    });
  }

  // Auto-detect: if parsing as TS fails with syntax errors that look like
  // the source is plain JS, retry with allowJs mode enabled.
  if (!isJsMode) {
    const syntaxErrors = ast.syntacticDiagnostics.filter((d) => d.category === 1 && d.file === ast.sourceFile);
    if (syntaxErrors.length > 0 && looksLikeTsSyntaxOnJs(syntaxErrors)) {
      // Retry as JS
      isJsMode = true;
      const jsFileName = effectiveFileName.replace(/\.ts$/, ".js");
      if (languageService) {
        languageService.updateSource(processedSource, jsFileName);
        ast = languageService.analyze({ allowJs: true });
      } else {
        ast = analyzeSource(processedSource, jsFileName, { allowJs: true });
      }
    }
  }

  // In JS mode, check for untyped parameters and add helpful warnings
  if (isJsMode) {
    const typeWarnings = checkJsTypeCoverage(ast);
    errors.push(...typeWarnings);
  }

  // TS diagnostics that the wasm codegen can handle gracefully —
  // downgrade from error to warning so they don't block compilation.
  // (Uses module-level DOWNGRADE_DIAG_CODES set defined above)

  // Collect TS diagnostics as errors (or warnings for handled cases)
  for (const diag of ast.diagnostics) {
    if (diag.category === 1) {
      // Error
      // #1928 — `diag.start` is an offset in `processedSource`. Map it back to
      // the user's original source (through the composed pre-parse rewrite map)
      // and compute the line/column there, so reported positions match what the
      // user wrote rather than the rewritten text. A no-op when no rewrite fired
      // (identity map) — same result as the old direct lookup.
      const pos = remapDiagnosticPosition(diag, source, positionMap);
      const severity =
        DOWNGRADE_DIAG_CODES.has(diag.code) || isGuardedNullablePrimitiveDiagnostic(diag, ast.checker)
          ? "warning"
          : "error";
      errors.push({
        // #1929 — flatten the full DiagnosticMessageChain (keeps the "because…"
        // elaboration) instead of only the head .messageText.
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        line: pos.line + 1,
        column: pos.character + 1,
        severity: severity as "error" | "warning",
        code: diag.code,
        ...(diag.file ? { file: diag.file.fileName } : {}),
      });
    }
  }

  // Don't stop on type errors – the compiler can still generate code for many cases
  // Only stop on syntax errors (parsing failures), except tolerated ones
  const TOLERATED_SYNTAX_CODES = new Set([
    1156, // "'let' declarations can only be declared inside a block"
    1313, // "The body of an 'if' statement cannot be the empty statement"
    1344, // "A label is not allowed here"
    1182, // "A destructuring declaration must have an initializer"
    1228, // "A type predicate is only allowed in return type position"
    1163, // "A 'yield' expression is only allowed in a generator body" — syntactic diagnostic (#267)
    1206, // "Decorators are not valid here" — decorator syntax tolerated, decorators ignored (#376)
    1207, // "Decorators cannot be applied to multiple get/set accessors" (#376)
    1436, // "Decorators must precede the name and all keywords of property declarations" (#376)
    1486, // "Decorator used before 'export' here" (#376)
    1497, // "Expression must be enclosed in parentheses to be used as a decorator" (#376)
    1498, // "Invalid syntax in decorator" (#376)
    8038, // "Decorators may not appear after 'export' or 'export default'" (#376)
    1184, // "Modifiers cannot appear here" — valid JS patterns in test262 (#537)
    1109, // "Expression expected" — valid JS patterns in test262 (#537)
    1135, // "Argument expression expected" — valid JS patterns in test262 (#537)
    1262, // "Identifier expected. 'X' is a reserved word at the top-level of a module" — await as identifier (#537)
    1435, // "Unknown keyword or identifier. Did you mean 'X'?" — yield in nested generator contexts (#521)
    1503, // "This regular expression flag is only available when targeting 'es2024'" (#654)
    1232, // "An import declaration can only be used at the top level of a namespace or module" (#654)
    1102, // "'delete' cannot be called on an identifier in strict mode" — valid sloppy-mode JS (#535)
    1100, // "Invalid use of 'X' in strict mode" — sloppy-mode JS allows eval/arguments (#331)
    1121, // "Octal literals are not allowed in strict mode" — valid sloppy-mode JS
    1489, // "Decimals with leading zeros are not allowed" — valid sloppy-mode JS octal literals
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );
  const hasHardTypeErrors = ast.diagnostics.some((d) => isHardTypeScriptDiagnostic(d, ast.checker));

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 1a: Early error detection — catch ES-spec syntax errors that TypeScript misses
  const earlyErrors = detectEarlyErrors(ast.sourceFile);
  errors.push(...earlyErrors);
  const hasHardEarlyErrors = earlyErrors.some((e) => e.severity !== "warning");
  if (hasHardEarlyErrors) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 1b: Safe mode validation
  if (options.safe) {
    const safeErrors = validateSafeMode(ast.sourceFile, ast.checker, options);
    errors.push(...safeErrors);
    if (safeErrors.length > 0) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  // Step 1c: Hardened mode validation
  if (options.hardened) {
    const hardenedErrors = validateHardenedMode(ast.sourceFile);
    errors.push(...hardenedErrors);
    if (hardenedErrors.length > 0) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  // Step 2: Generate IR
  let mod;
  let capturedFallbackCounts: import("./index.js").CompileResult["fallbackCounts"];
  let capturedIrPostClaimErrors: import("./index.js").CompileResult["irPostClaimErrors"];
  try {
    if (useLinear) {
      mod = generateLinearModule(ast, { exposeArenaReset: options.allocator === "arena-reset" });
      // Fail the compile on unsupported linear-backend constructs instead of
      // emitting a structurally invalid binary (#1868).
      if (collectLinearCodegenErrors(mod, errors)) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    } else {
      const result = generateModule(ast, {
        sourceMap: emitSourceMap,
        fast: options.fast,
        nativeStrings: options.nativeStrings,
        utf8Storage: options.utf8Storage,
        testRuntime: options.testRuntime,
        wasi: options.target === "wasi",
        standalone: options.target === "standalone",
        // Phase 2 (#1131): default experimentalIR to on so recursive
        // numeric kernels (fib, factorial, etc.) compile without the
        // boxing roundtrip the legacy path emits for untyped JS
        // parameters. Pass `experimentalIR: false` to force legacy path
        // for bit-by-bit divergence tests or emergency revert.
        experimentalIR: options.experimentalIR !== false,
        nodeBuiltins: preprocessed.nodeBuiltins,
        wasiNodeFsFuncs,
        allowFs: options.allowFs ?? false,
        strictNoHostImports: options.strictNoHostImports,
        jsxRuntime: preprocessed.jsxRuntime,
      });
      mod = result.module;
      capturedFallbackCounts = result.fallbackCounts;
      capturedIrPostClaimErrors = result.irPostClaimErrors;
      // Propagate codegen errors with source locations. #1921 — a deliberate
      // "degrade" diagnostic is surfaced as a non-fatal "warning"; the fatal
      // decision is made by isFatalCodegenDiagnostic on the raw severity.
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: isFatalCodegenDiagnostic(err) ? "error" : "warning",
        });
      }
      // #1921 — gate on severity, not a "Codegen error:" message prefix.
      if (result.errors.some(isFatalCodegenDiagnostic)) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    }
  } catch (e) {
    if (
      typeof WebAssembly !== "undefined" &&
      (WebAssembly as unknown as { Exception?: Function }).Exception &&
      e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
    )
      throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      ast.sourceFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 2b: Apply C ABI transformations if requested
  let cHeader: string | undefined;
  if (options.abi === "c" && options.target === "linear") {
    const cabiResult = applyCabiTransform(mod, options.moduleName ?? "module", ast);
    cHeader = cabiResult.cHeader;
  }

  // Step 2c: Widen non-defaultable ref types to ref_null in locals, params, and results.
  // This avoids "uninitialized non-defaultable local" and struct.get/set type errors.
  widenNonDefaultableTypes(mod);

  // Step 3: Emit binary (with source map collection if enabled)
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Generate source map JSON
      const sourcesContent = new Map<string, string>();
      sourcesContent.set(effectiveFileName, source);
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section to the binary
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      // Concatenate the binary with the sourceMappingURL section
      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    if (
      typeof WebAssembly !== "undefined" &&
      (WebAssembly as unknown as { Exception?: Function }).Exception &&
      e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
    )
      throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      ast.sourceFile,
      `Binary emit error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Step 3b: Optimize binary with Binaryen (optional) — applied by the async
  // compileSource wrapper, not here (the optimizer is lazy-loaded only when
  // wasm-opt is requested, #1757). This synchronous core ignores
  // options.optimize.

  // Step 4: Emit WAT (optional)
  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      // WAT emit failure is non-fatal
      pushSourceAnchoredDiagnostic(
        errors,
        ast.sourceFile,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  // Step 5: Generate .d.ts
  const dts = generateDts(ast, mod);

  // Step 6: Generate imports helper
  const importsHelper = generateImportsHelper(mod);

  // Step 7: Generate WIT interface (optional)
  let witOutput: string | undefined;
  if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(ast, { ...witOpts, imports: mod.imports, types: mod.types });
  }

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    cHeader,
    wit: witOutput,
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
    exportSignatures: mod.exportSignatures,
    fallbackCounts: capturedFallbackCounts,
    irPostClaimErrors: capturedIrPostClaimErrors,
  };
}

/**
 * Compile multiple TypeScript source files into a single Wasm module.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export async function compileMultiSource(
  files: Record<string, string>,
  entryFile: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  // Apply define substitutions to all source files (#1043)
  const definedFiles = options.define
    ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, applyDefineSubstitutions(v, options.define!)]))
    : files;

  // Rewrite CJS `const X = require('Y')` to ESM `import X from 'Y'` (#1279) across
  // every input file. This runs before TypeScript's analyzer so the require() calls
  // are seen as proper module imports during cross-file resolution.
  const processedFiles = Object.fromEntries(Object.entries(definedFiles).map(([k, v]) => [k, rewriteCjsRequire(v)]));

  const multiAst = analyzeMultiSource(processedFiles, entryFile, undefined, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
  });

  // When allowJs is set (e.g. compiling npm packages like lodash-es), only report
  // diagnostics from the entry file — dependency files may have TS errors we can't
  // control (missing globals, JSDoc param issues, etc.).
  const isEntryDiag = (diag: { file?: { fileName: string } }) =>
    !options.allowJs || !diag.file || diag.file === multiAst.entryFile;

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1 && isEntryDiag(diag)) {
      const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0) : { line: 0, character: 0 };
      const severity =
        DOWNGRADE_DIAG_CODES.has(diag.code) || isGuardedNullablePrimitiveDiagnostic(diag, multiAst.checker)
          ? "warning"
          : "error";
      errors.push({
        // #1929 — flatten the full DiagnosticMessageChain (keeps the "because…"
        // elaboration) and attribute the source file for multi-file compiles.
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        line: pos.line + 1,
        column: pos.character + 1,
        severity,
        code: diag.code,
        ...(diag.file ? { file: diag.file.fileName } : {}),
      });
    }
  }

  // When allowJs is set, don't bail on TS diagnostics — JS packages with JSDoc
  // annotations produce many false-positive errors (TS1016 optional params,
  // TS2322 type mismatches, TS8017 signature-in-JS, etc.). Codegen handles it fine.
  const hasSyntaxErrors =
    !options.allowJs &&
    multiAst.syntacticDiagnostics.some(
      (d) => d.category === 1 && isEntryDiag(d) && multiAst.sourceFiles.some((sf) => d.file === sf),
    );
  const hasHardTypeErrors =
    !options.allowJs &&
    multiAst.diagnostics.some((d) => isHardTypeScriptDiagnostic(d, multiAst.checker) && isEntryDiag(d));

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Early error detection — catch ES-spec syntax errors that TypeScript misses,
  // on every user source file (#1931). Previously the multi-source path skipped
  // ES early errors entirely; now compileSource and compileMultiSource share the
  // same detectEarlyErrors pass so e.g. a duplicate-`let` is rejected in a
  // multi-file compile too. allowJs dependency files are skipped (their JS may
  // use patterns we cannot control) — same scoping as the diagnostic loop above.
  if (!options.allowJs) {
    for (const sf of multiAst.sourceFiles) {
      errors.push(...detectEarlyErrors(sf));
    }
    if (errors.some((e) => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some((e) => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  let mod;
  let capturedFallbackCounts: import("./index.js").CompileResult["fallbackCounts"];
  let capturedIrPostClaimErrors: import("./index.js").CompileResult["irPostClaimErrors"];
  try {
    if (useLinear) {
      mod = generateLinearMultiModule(multiAst, { exposeArenaReset: options.allocator === "arena-reset" });
      // Fail the compile on unsupported linear-backend constructs instead of
      // emitting a structurally invalid binary (#1868).
      if (collectLinearCodegenErrors(mod, errors)) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    } else {
      const result = generateMultiModule(multiAst, {
        sourceMap: emitSourceMap,
        fast: options.fast,
        nativeStrings: options.nativeStrings,
        utf8Storage: options.utf8Storage,
        testRuntime: options.testRuntime,
        wasi: options.target === "wasi",
        strictNoHostImports: options.strictNoHostImports,
        standalone: options.target === "standalone",
      });
      mod = result.module;
      capturedFallbackCounts = result.fallbackCounts;
      capturedIrPostClaimErrors = result.irPostClaimErrors;
      // Propagate codegen errors with source locations. #1921 — a deliberate
      // "degrade" diagnostic is surfaced as a non-fatal "warning"; the fatal
      // decision is made by isFatalCodegenDiagnostic on the raw severity.
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: isFatalCodegenDiagnostic(err) ? "error" : "warning",
        });
      }
      // #1921 — gate on severity, not a "Codegen error:" message prefix.
      if (result.errors.some(isFatalCodegenDiagnostic)) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    }
  } catch (e) {
    if (
      typeof WebAssembly !== "undefined" &&
      (WebAssembly as unknown as { Exception?: Function }).Exception &&
      e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
    )
      throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Widen non-defaultable ref types to ref_null in locals, params, and results
  widenNonDefaultableTypes(mod);

  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);

      // Build sources content from input files
      const sourcesContent = new Map<string, string>();
      for (const [name, content] of Object.entries(files)) {
        sourcesContent.set(name, content);
      }
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);

      // Append sourceMappingURL custom section
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();

      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    if (
      typeof WebAssembly !== "undefined" &&
      (WebAssembly as unknown as { Exception?: Function }).Exception &&
      e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
    )
      throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Binary emit error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Optimize binary with Binaryen (optional)
  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = await optimizeBinaryAsync(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      pushSourceAnchoredDiagnostic(errors, multiAst.entryFile, optResult.warning, "warning");
    }
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      pushSourceAnchoredDiagnostic(
        errors,
        multiAst.entryFile,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const dts = generateDts(entryAst, mod);
  const importsHelper = generateImportsHelper(mod);
  let witOutput: string | undefined;
  if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(entryAst, { ...witOpts, imports: mod.imports, types: mod.types });
  }

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    wit: witOutput,
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
    exportSignatures: mod.exportSignatures,
    fallbackCounts: capturedFallbackCounts,
    irPostClaimErrors: capturedIrPostClaimErrors,
  };
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports automatically via standard module resolution.
 */
export async function compileFilesSource(entryPath: string, options: CompileOptions = {}): Promise<CompileResult> {
  const errors: CompileError[] = [];
  const emitWatOutput = options.emitWat !== false;

  const multiAst = analyzeFiles(entryPath, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
  });

  for (const diag of multiAst.diagnostics) {
    if (diag.category === 1) {
      const pos = diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start ?? 0) : { line: 0, character: 0 };
      const severity =
        DOWNGRADE_DIAG_CODES.has(diag.code) || isGuardedNullablePrimitiveDiagnostic(diag, multiAst.checker)
          ? "warning"
          : "error";
      errors.push({
        // #1929 — flatten the full DiagnosticMessageChain (keeps the "because…"
        // elaboration) and attribute the source file for multi-file compiles.
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        line: pos.line + 1,
        column: pos.character + 1,
        severity,
        code: diag.code,
        ...(diag.file ? { file: diag.file.fileName } : {}),
      });
    }
  }

  const hasSyntaxErrors = multiAst.syntacticDiagnostics.some(
    (d) => d.category === 1 && multiAst.sourceFiles.some((sf) => d.file === sf),
  );
  const hasHardTypeErrors = multiAst.diagnostics.some((d) => isHardTypeScriptDiagnostic(d, multiAst.checker));

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  // Early error detection — catch ES-spec syntax errors that TypeScript misses,
  // on every user source file (#1931). compileFilesSource previously skipped ES
  // early errors; wire the same detectEarlyErrors pass here too.
  if (!options.allowJs) {
    for (const sf of multiAst.sourceFiles) {
      errors.push(...detectEarlyErrors(sf));
    }
    if (errors.some((e) => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  // Safe mode validation for all source files
  if (options.safe) {
    for (const sf of multiAst.sourceFiles) {
      const safeErrors = validateSafeMode(sf, multiAst.checker, options);
      errors.push(...safeErrors);
    }
    if (errors.some((e) => e.severity === "error")) {
      return {
        binary: new Uint8Array(0),
        wat: "",
        dts: "",
        importsHelper: "",
        success: false,
        errors,
        stringPool: [],
        imports: [],
        hasMain: false,
        hasTopLevelStatements: false,
      };
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = options.target === "linear";

  let mod;
  let capturedFallbackCounts: import("./index.js").CompileResult["fallbackCounts"];
  let capturedIrPostClaimErrors: import("./index.js").CompileResult["irPostClaimErrors"];
  try {
    if (useLinear) {
      mod = generateLinearMultiModule(multiAst, { exposeArenaReset: options.allocator === "arena-reset" });
      // Fail the compile on unsupported linear-backend constructs instead of
      // emitting a structurally invalid binary (#1868).
      if (collectLinearCodegenErrors(mod, errors)) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    } else {
      const result = generateMultiModule(multiAst, {
        sourceMap: emitSourceMap,
        fast: options.fast,
        nativeStrings: options.nativeStrings,
        utf8Storage: options.utf8Storage,
        testRuntime: options.testRuntime,
        wasi: options.target === "wasi",
        strictNoHostImports: options.strictNoHostImports,
        standalone: options.target === "standalone",
      });
      mod = result.module;
      capturedFallbackCounts = result.fallbackCounts;
      capturedIrPostClaimErrors = result.irPostClaimErrors;
      // #1921 — a deliberate "degrade" diagnostic is surfaced as a non-fatal
      // "warning"; the fatal decision is made by isFatalCodegenDiagnostic.
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: isFatalCodegenDiagnostic(err) ? "error" : "warning",
        });
      }
      // #1921 — gate on severity, not a "Codegen error:" message prefix.
      if (result.errors.some(isFatalCodegenDiagnostic)) {
        return {
          binary: new Uint8Array(0),
          wat: "",
          dts: "",
          importsHelper: "",
          success: false,
          errors,
          stringPool: [],
          imports: [],
          hasMain: false,
          hasTopLevelStatements: false,
        };
      }
    }
  } catch (e) {
    if (
      typeof WebAssembly !== "undefined" &&
      (WebAssembly as unknown as { Exception?: Function }).Exception &&
      e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
    )
      throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  widenNonDefaultableTypes(mod);

  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);
      const sourcesContent = new Map<string, string>();
      for (const sf of multiAst.sourceFiles) {
        sourcesContent.set(sf.fileName, sf.getFullText());
      }
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);
      const sourceMapUrl = options.sourceMapUrl ?? "module.wasm.map";
      const urlSection = new WasmEncoder();
      emitSourceMappingURLSection(urlSection, sourceMapUrl);
      const urlSectionBytes = urlSection.finish();
      const combined = new Uint8Array(emitResult.binary.length + urlSectionBytes.length);
      combined.set(emitResult.binary);
      combined.set(urlSectionBytes, emitResult.binary.length);
      binary = combined;
    } else {
      binary = emitBinary(mod);
    }
  } catch (e) {
    if (
      typeof WebAssembly !== "undefined" &&
      (WebAssembly as unknown as { Exception?: Function }).Exception &&
      e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
    )
      throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      multiAst.entryFile,
      `Binary emit error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      "error",
    );
    return {
      binary: new Uint8Array(0),
      wat: "",
      dts: "",
      importsHelper: "",
      success: false,
      errors,
      stringPool: [],
      imports: [],
      hasMain: false,
      hasTopLevelStatements: false,
    };
  }

  if (options.optimize) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = await optimizeBinaryAsync(binary, { level });
    if (optResult.optimized) {
      binary = optResult.binary;
    }
    if (optResult.warning) {
      pushSourceAnchoredDiagnostic(errors, multiAst.entryFile, optResult.warning, "warning");
    }
  }

  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(mod);
    } catch (e) {
      pushSourceAnchoredDiagnostic(
        errors,
        multiAst.entryFile,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const dts = generateDts(entryAst, mod);
  const importsHelper = generateImportsHelper(mod);
  let witOutput: string | undefined;
  if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(entryAst, { ...witOpts, imports: mod.imports, types: mod.types });
  }

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: true,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports: buildImportManifest(mod),
    wit: witOutput,
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
    exportSignatures: mod.exportSignatures,
    fallbackCounts: capturedFallbackCounts,
    irPostClaimErrors: capturedIrPostClaimErrors,
  };
}
