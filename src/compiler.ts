// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "./ts-api.js";
import {
  analyzeFiles,
  analyzeMultiSource,
  analyzeSource,
  IncrementalLanguageService,
  IncrementalProjectLanguageService,
  type TypedAST,
  type MultiTypedAST,
  type ProjectModuleResolutions,
} from "./checker/index.js";
import {
  collectDtsEntrypointSeeds,
  DTS_ENTRY_DECLS_NAME,
  resolveDtsEntryDeclarations,
} from "./checker/dts-entrypoint-seeds.js";
import { getNullablePrimitiveInfo } from "./checker/type-mapper.js";
import { WASI_NODE_FS_ALIAS_SENTINEL } from "./checker/node-capability-map.js";
import { generateLinearModule, generateLinearMultiModule } from "./codegen-linear/index.js";
import { resetCompileDepth } from "./codegen/expressions.js";
import { resetDerivationFlagCache } from "./derivation-flags.js";
import { generateModule, generateMultiModule } from "./codegen/index.js";
import type { CodegenOptions } from "./codegen/context/types.js";
import {
  emitIrCutoverAudit,
  finalizeSingleSourceIrTelemetry,
  isIrCutoverAuditRequested,
  readIrCompileRoute,
  withDefaultIrCompileRoute,
} from "./compiler/ir-cutover-invocation.js";
import { assertCodegenRegistrationsComplete } from "./codegen/shared.js";
import { isFatalCodegenDiagnostic } from "./codegen/context/errors.js";
import type { WasmModule } from "./ir/types.js";
import { buildHostImportInventory, summarizeHostImportInventory } from "./host-import-policy.js";
import { buildCapabilityRequirements, validatePlatformCapabilityRequirements } from "./capability-registry.js";
import { createJavaScriptAdapterManifest } from "./adapter-manifest.js";
import { buildExportBoundaryPolicies } from "./boundary-policy.js";
import { buildCompileExplanation } from "./compile-explain.js";
import {
  findSmallestNodeAtPosition,
  isBindingPatternFalsePositive,
  isJsDefaultInferredParamFalsePositive,
} from "./compiler/argument-diagnostics.js";
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
  rewriteEvalSuperCallWithMap,
  validateHardenedMode,
  validateSafeMode,
} from "./compiler/validation.js";
import { emitBinary, emitBinaryWithSourceMap, emitSourceMappingURLSection } from "./emit/binary.js";
import { WasmEncoder } from "./emit/encoder.js";
import { generateSourceMap } from "./emit/sourcemap.js";
import { emitWat } from "./emit/wat.js";
import { applyDefineSubstitutions, applyDefineSubstitutionsWithMap } from "./compiler/define-substitution.js";
import { collectGraphNodeBuiltinImports } from "./compiler/node-builtin-import-collector.js";
import { rewriteCjsRequire, rewriteCjsRequireWithMap } from "./cjs-rewrite.js";
import { preprocessImports } from "./import-resolver.js";
import { PositionMap } from "./position-map.js";
import { profileCount, profilePhase } from "./compile-profile.js";
import { resolveCompileTargetProfile } from "./target-profile.js";
import { injectProcessStdinPrelude } from "./process-stdin-prelude.js";
import { injectIteratorStaticsPrelude } from "./iterator-statics-prelude.js";
import { normalizeScriptHtmlLikeComments } from "./compiler/html-like-comments.js";
import * as irIds from "./compiler/ir-outcome-inventory.js";
import { buildLinearOptions } from "./compiler/linear-options.js";
import type { CompileError, CompileOptions, CompileResult } from "./index.js";
import { optimizeBinaryAsync, validateEmittedBinary } from "./optimize.js";
import { generateWit } from "./wit-generator.js";
import {
  foldGroundCallsInMultiFilesForCompile as foldGroundCallsInMulti,
  foldGroundExportCallsForCompile as foldGroundCalls,
} from "./compiler/ground-call-fold.js";
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
  return originalLineAndCharacter(originalSource, origOffset);
}

function originalLineAndCharacter(source: string, offset: number): { line: number; character: number } {
  // Resolve line/column from the original text. Counting newlines is O(offset)
  // but diagnostics are few; a shared line-start index would be premature here.
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  return { line, character: offset - lastNewline - 1 };
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

/**
 * (#2616) Detect a TS2322 raised on a trap value inside a `new Proxy(target,
 * handler)` handler object literal — e.g. `new Proxy({}, { get: {} })`, where
 * `{}` is rejected against `ProxyHandler<T>['get']`'s call signature.
 *
 * Per §10.5 / §7.3.10 (GetMethod), a present-but-non-callable trap is NOT a
 * static error: the program must compile and throw a **TypeError at operation
 * time** (when `p.attr` / `p(...)` runs). The runtime host bridge
 * (`_buildProxyBridgeHandler`) installs a throwing trap for exactly this case.
 * TypeScript's `ProxyHandler<T>` typing is stricter than the spec, so it
 * hard-errors before codegen and the runtime path is never reached. Downgrade
 * the 2322 so the program compiles and the runtime TypeError fires.
 *
 * Tightly scoped: only a 2322 whose node sits inside the SECOND argument
 * (handler) of a `new Proxy(...)` NewExpression qualifies. (The downstream
 * 2339/2349 "property/call on the target type" errors are already non-hard, so
 * they don't need suppression — they stem from the Proxy-no-brand typing.)
 */
function isProxyHandlerTrapDiagnostic(diag: ts.Diagnostic): boolean {
  if (diag.code !== 2322) return false;
  const file = diag.file;
  if (!file || diag.start === undefined) return false;
  let n = findSmallestNodeAtPosition(file, diag.start);
  // Walk up to the enclosing `new Proxy(...)` and confirm the node is within
  // its handler (2nd) argument.
  while (n) {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Proxy") {
      const handlerArg = n.arguments?.[1];
      if (handlerArg && diag.start >= handlerArg.getStart(file) && diag.start < handlerArg.getEnd()) {
        return true;
      }
      return false;
    }
    n = n.parent;
  }
  return false;
}

/**
 * (#2741) Detect a TS2322 raised on an operand of the `in` operator
 * (`RelationalExpression in ShiftExpression`, ES2023 §13.10.1). TypeScript
 * requires the RHS to be an object and the LHS to be a PropertyKey
 * (`string | number | symbol`), but `in` is a RUNTIME operation:
 * - a non-Object RHS is a runtime **TypeError** (§13.10.1 step 5), not a static
 *   error; and
 * - a non-PropertyKey LHS (e.g. `true`/`null`/`undefined`) is **ToPropertyKey**'d
 *   (ToString, step 6).
 *
 * `language/expressions/in/*` test262 cases have no `negative` phase — they must
 * compile and exhibit the runtime behaviour. Downgrade the 2322 so the program
 * compiles and the codegen (binary-ops.ts `InKeyword` arm) emits the correct
 * runtime semantics (throw on a primitive RHS, ToString the key, prototype-chain
 * `[[HasProperty]]`). Mirrors the #2616 Proxy-handler-trap downgrade.
 *
 * Tightly scoped: only a 2322 whose node sits inside the LHS or RHS operand of a
 * BinaryExpression whose operator is `InKeyword`.
 */
function isInOperatorOperandDiagnostic(diag: ts.Diagnostic): boolean {
  if (diag.code !== 2322) return false;
  const file = diag.file;
  if (!file || diag.start === undefined) return false;
  let n = findSmallestNodeAtPosition(file, diag.start);
  while (n) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      const inLeft = diag.start >= n.left.getStart(file) && diag.start < n.left.getEnd();
      const inRight = diag.start >= n.right.getStart(file) && diag.start < n.right.getEnd();
      return inLeft || inRight;
    }
    n = n.parent;
  }
  return false;
}

function isHardTypeScriptDiagnostic(diag: ts.Diagnostic, checker?: ts.TypeChecker): boolean {
  if (diag.category !== 1 || !HARD_TS_DIAG_CODES.has(diag.code)) return false;
  if (checker && isBindingPatternFalsePositive(diag, checker)) return false;
  if (checker && isJsDefaultInferredParamFalsePositive(diag, checker)) return false;
  if (checker && isGuardedNullablePrimitiveDiagnostic(diag, checker)) return false;
  if (isProxyHandlerTrapDiagnostic(diag)) return false;
  if (isInOperatorOperandDiagnostic(diag)) return false;
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
        if (clause?.isTypeOnly) continue;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            if (spec.isTypeOnly) continue;
            if (spec.propertyName && spec.propertyName.text !== spec.name.text) {
              result.add(WASI_NODE_FS_ALIAS_SENTINEL);
              continue;
            }
            result.add(spec.name.text);
          }
        }
      }
    }
  }
  return result;
}

/**
 * #2771 — does the entry source statically import (or `require`) a RELATIVE
 * module (`./x` / `../x`)? The single-source `compile()` path reads exactly one
 * file and strips every import in `preprocessImports`, so a relative import is
 * silently unresolved — its bindings lower to bogus `env.*` host imports (which
 * the WASI strict-no-host gate then rejects). The CLI uses this to route such an
 * entry to the multi-file bundler (`compileProject`), which resolves the
 * relative deps through the TS program. Package / `node:` / bare-specifier
 * imports are NOT relative and stay on the single-source path (byte-neutral).
 */
export function entryHasRelativeImports(source: string): boolean {
  const sf = ts.createSourceFile("__detect_rel__.ts", source, ts.ScriptTarget.Latest, true);
  const isRelativeSpec = (spec: string): boolean => spec.startsWith("./") || spec.startsWith("../");
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `import … from "./x"` / `import "./x"` and `export … from "./x"`.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRelativeSpec(node.moduleSpecifier.text)
    ) {
      found = true;
      return;
    }
    // `require("./x")` (CJS) and dynamic `import("./x")`.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (
        (isRequire || isDynImport) &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]) &&
        isRelativeSpec(node.arguments[0].text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * #2657 — the source-import module string for js2wasm's raw linear-memory access
 * intrinsics (`store32`/`load32`/`store8`/`load8`). These are NOT WASI host
 * functions — they lower to inline `i32.store`/`i32.load`/`i32.store8`/
 * `i32.load8_u` ops over the module's own exported `memory`. They are honestly
 * named under a `wasm:` intrinsic namespace (mirroring `wasm:js-string`) so the
 * source never mislabels a compiler intrinsic as a WASI host import: only
 * `fd_read`/`fd_write` come from `"wasi_snapshot_preview1"`, the real WASI core
 * module. (No host provides a `wasi_snapshot_preview1.store32`.)
 */
export const WASM_MEMORY_INTRINSIC_MODULE = "wasm:memory";

/**
 * #2657 — detect the LOCAL names of the raw-WASI source imports BEFORE import
 * preprocessing strips them (preprocessing rewrites them to bare `declare
 * function` stubs, losing the module origin). Two honestly-separated surfaces:
 *
 *  - `rawWasi`: named imports from `"wasi_snapshot_preview1"` — the real WASI
 *    Preview-1 fd syscalls (`fd_read`/`fd_write`). The most honest pure-WASI-P1
 *    path for fd-based IO, with no `node:fs` surface (loopdive/js2wasm#389). These
 *    bind directly to the WASI import funcs.
 *  - `memAccessors`: named imports from `"wasm:memory"` — js2wasm's inline
 *    linear-memory access intrinsics (`store32`/`load32`/`store8`/`load8`). These
 *    are NOT imports; they lower to a single WASM memory op.
 *
 * The returned LOCAL names (honoring `as` aliases) drive `tryCompileRawWasiCall`.
 * Both sets are empty for any program that doesn't import the respective module,
 * so the rest of the compiler is unaffected.
 */
function detectRawWasiImports(source: string): { rawWasi: Set<string>; memAccessors: Set<string> } {
  const rawWasi = new Set<string>();
  const memAccessors = new Set<string>();
  const sf = ts.createSourceFile("__detect_raw_wasi__.ts", source, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const mod = stmt.moduleSpecifier.text;
    const target =
      mod === "wasi_snapshot_preview1" ? rawWasi : mod === WASM_MEMORY_INTRINSIC_MODULE ? memAccessors : undefined;
    if (!target) continue;
    const clause = stmt.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      // `el.name` is the LOCAL binding (after any `as` alias) the call sites use.
      for (const el of clause.namedBindings.elements) target.add(el.name.text);
    }
  }
  return { rawWasi, memAccessors };
}

type FailureTelemetry = Pick<
  CompileResult,
  "fallbackCounts" | "irPostClaimErrors" | "irCompiledFuncs" | "irFirstSkipped" | "irOutcomes" | "irBodyRouteAudit"
>;

const EMPTY_FAILURE_TELEMETRY: Partial<FailureTelemetry> = Object.freeze({
  fallbackCounts: undefined,
  irPostClaimErrors: undefined,
  irCompiledFuncs: undefined,
  irFirstSkipped: undefined,
  irOutcomes: undefined,
  irBodyRouteAudit: undefined,
});

/** The canonical failure result, retaining any telemetry codegen already produced. */
function failResult(errors: CompileError[], telemetry: Partial<FailureTelemetry> = {}): CompileResult {
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
    ...telemetry,
  };
}

/**
 * #1927 — apply the optional Binaryen wasm-opt pass in place over an already
 * produced {@link CompileResult}. This is the ONLY async step in the pipeline;
 * the synchronous core ({@link runPipeline}) never runs it. The two async entry
 * points and {@link compileSource} all funnel through here so the optimize
 * behavior is defined once. A no-op when `options.optimize` is unset or the
 * compile already failed. `anchor` supplies the source file used to attribute a
 * wasm-opt warning diagnostic (single-source vs multi entry).
 */
async function applyOptimize(
  result: CompileResult,
  options: CompileOptions,
  anchor: ts.SourceFile,
): Promise<CompileResult> {
  if (!options.optimize || !result.success) return result;
  const level = typeof options.optimize === "number" ? options.optimize : 3;
  const optResult = await optimizeBinaryAsync(result.binary, {
    level,
    preserveNames: options.preserveDebugNames,
  });
  if (optResult.optimized) {
    result.binary = optResult.binary;
  }
  if (optResult.warning) {
    pushSourceAnchoredDiagnostic(result.errors, anchor, optResult.warning, "warning");
  }
  return result;
}

/**
 * #1927 — single resolver that maps {@link CompileOptions} → the backend
 * {@link CodegenOptions} bundle, so every driver (single / multi / files)
 * passes an IDENTICAL object to the generator. Before this, only the
 * single-source path forwarded `experimentalIR` / `nodeBuiltins` /
 * `wasiNodeFsFuncs` / `allowFs` / `jsxRuntime`, silently giving multi-file
 * users a weaker, different compiler with the IR overlay off.
 *
 * `prep` carries import preprocessing/collection results. Single-source uses
 * `preprocessImports`; multi-source separately collects graph-wide Node/WASI
 * metadata while retaining real module declarations.
 */
function buildCodegenOptions(
  options: CompileOptions,
  emitSourceMap: boolean,
  prep?: {
    nodeBuiltins?: import("./import-resolver.js").NodeBuiltinImport[];
    wasiNodeFsFuncs?: Set<string>;
    wasiRawImports?: Set<string>;
    wasiMemAccessors?: Set<string>;
    jsxRuntime?: import("./import-resolver.js").JsxRuntimeImport;
    dtsEntrypointSeeds?: import("./checker/dts-entrypoint-seeds.js").DtsEntrypointSeeds;
  },
): CodegenOptions {
  // (#86) Measurement-integrity guard. The standalone / wasi codegen regime is
  // derived ONLY from `options.target` (below). There is NO `standalone` /
  // `wasi` boolean OPTION — a caller that passes `{ standalone: true }` (or
  // `{ wasi: true }`) to `compile()` intends a standalone/wasi run but silently
  // gets the default gc-host lane, i.e. VACUOUS standalone coverage (the entire
  // point of #86). TypeScript's excess-property check catches the direct-literal
  // form (the fields are typed `never` on CompileOptions), but callers that
  // widen options to `Record<string, unknown>` erase that — so fail LOUDLY here
  // too. Use `target: "standalone"` / `target: "wasi"`.
  const strayRegime = (options as Record<string, unknown>).standalone ?? (options as Record<string, unknown>).wasi;
  if (strayRegime !== undefined) {
    const key = (options as Record<string, unknown>).standalone !== undefined ? "standalone" : "wasi";
    throw new Error(
      `Unknown compile option '${key}' — the ${key} codegen regime is selected via ` +
        `target: "${key}", not a '${key}' boolean. Passing { ${key}: true } silently ran the ` +
        `default gc-host lane (vacuous ${key} coverage). Use { target: "${key}" }. (#86)`,
    );
  }
  if (options.directEval === "reified-host" && options.target !== undefined && options.target !== "gc") {
    throw new Error(
      `Compile option directEval: "reified-host" requires the WasmGC JavaScript-host target; ` +
        `target: "${options.target}" does not use that cell bridge.`,
    );
  }
  const targetProfile = resolveCompileTargetProfile(options);
  return {
    irCutoverRoute: readIrCompileRoute(options, "compileSourceSync"),
    sourceMap: emitSourceMap,
    fast: options.fast,
    nativeStrings: options.nativeStrings,
    hostBridge: options.hostBridge,
    semanticProviders: options.semanticProviders,
    utf8Storage: options.utf8Storage,
    testRuntime: options.testRuntime,
    wasi: targetProfile.target === "wasi",
    nodeGlobals: options.emulateNode === true || options.platform === "node",
    // #2783 — the dynamic-linking axis: namespaces to leave as link-time imports
    // (deduped). `link: ["node:fs"]` is the only spelling; the old `linkNodeShims`
    // boolean was removed.
    link: [...new Set(options.link ?? [])],
    standalone: targetProfile.target === "standalone",
    directEval: options.directEval,
    // (#2141 S1) honest any-boxing regime flag (default off = legacy tag-5 ABI).
    honestAnyBoxing: options.honestAnyBoxing,
    unionAnyRep: options.unionAnyRep,
    // (#684) usage-based any-local f64 inference (default on; see CodegenOptions).
    useUsageInfer: options.useUsageInfer,
    // (#4218) oracle backend selection (default: the TS5 checker).
    oracleBackend: options.oracleBackend,
    // (#2141 S2/S3, #2626) tag-5 boxed-VALUE eq classifier flag (default off).
    tag5ValueEqClassifier: options.tag5ValueEqClassifier,
    // (#4173) fast tag-pair dispatch in the dynamic-eq helpers (default on).
    fastStrictEq: options.fastStrictEq,
    // (#2106 S1) standalone $undefined tag-1 singleton regime flag (default off).
    undefinedSingleton: options.undefinedSingleton,
    // (#2796) Diff-test-harness fidelity — defer top-level init to an export so
    // the host runs it after setExports (symmetric with standalone `_start`).
    deferTopLevelInit: options.deferTopLevelInit,
    strictNoHostImports: targetProfile.strictEnvImportGate,
    // (#2119) thread module-strictness inference uniformly across all drivers.
    inferModuleStrictArguments: options.inferModuleStrictArguments,
    // Phase 2 (#1131): default experimentalIR to on so recursive numeric
    // kernels (fib, factorial, etc.) compile without the boxing roundtrip the
    // legacy path emits for untyped JS parameters. Pass `experimentalIR: false`
    // to force the legacy path for bit-by-bit divergence tests or emergency
    // revert. Forwarded to ALL drivers now (#1927); `generateMultiModule`
    // ignores it until #2138 wires the IR overlay into the multi generator.
    experimentalIR: options.experimentalIR !== false,
    // #3519 — opt-in typed terminal ledger; routing remains hybrid.
    trackIrOutcomes: options.trackIrOutcomes === true || isIrCutoverAuditRequested(),
    // (#2973) Forward the IR-first opt-out. The eval / new Function host shims
    // set this so a post-claim IR-first hard error in a sub-compile is not
    // swallowed by the shim's fallback catch into a silent wrong answer.
    disableIrFirst: options.disableIrFirst === true,
    // Import preprocessing/collection results. JSX remains single-source-only;
    // Node/WASI metadata is also collected graph-wide in compileMultiSource.
    nodeBuiltins: prep?.nodeBuiltins,
    wasiNodeFsFuncs: prep?.wasiNodeFsFuncs,
    wasiRawImports: prep?.wasiRawImports,
    wasiMemAccessors: prep?.wasiMemAccessors,
    allowFs: options.allowFs ?? false,
    // (#4238 slice 1) internal provider-build enablers — all default-off, so a
    // compile that does not set them is byte-identical.
    externNativeTypes: options.externNativeTypes === true,
    externImportModule: options.externImportModule,
    importMemory: options.importMemory,
    jsxRuntime: prep?.jsxRuntime,
    dtsEntrypointSeeds: prep?.dtsEntrypointSeeds,
  };
}

/** #1927 — the shared pipeline core. See {@link runPipeline}. */
interface PipelineInput {
  /** Per-file user sources for early-error / safe / hardened passes. */
  userSourceFiles: ts.SourceFile[];
  /** The AST surface codegen + dts/wit consume (single = the file; multi = entry). */
  entryAst: TypedAST;
  /** Multi-file AST when present; null for single-source. Selects the generator. */
  multiAst: MultiTypedAST | null;
  /** Pre-collected error/warning diagnostics (TS + JS-coverage warnings). */
  errors: CompileError[];
  /** Resolved codegen option bundle (see buildCodegenOptions). */
  codegenOptions: CodegenOptions;
  irInventoryOptions?: irIds.IrInventoryOptions;
  /** For source-map sourcesContent: original-name → original text. */
  sourcesContent: Map<string, string>;
  /** Anchor file for pushSourceAnchoredDiagnostic on codegen/emit throws. */
  diagnosticAnchor: ts.SourceFile;
  /**
   * Run ES early-error detection even when `options.allowJs` is set (#1958).
   * The single-source path sets this `true`: its lone `userSourceFiles` entry is
   * the *entry* source, and the legacy `compileSourceSync` ran `detectEarlyErrors`
   * on it UNCONDITIONALLY — load-bearing for the `eval` host shim, which always
   * compiles with `allowJs: true` and relies on early errors (e.g. `export` in
   * eval code, strict-eval-in-params) failing the compile so it can throw a
   * SyntaxError. The multi paths leave this `false`/undefined so their
   * `userSourceFiles` allowJs *dependency* files (whose JS we can't control) keep
   * being skipped — the original divergence between the single and multi drivers.
   */
  runEarlyErrorsOnAllowJs?: boolean;
  options: CompileOptions;
}

function isWasmException(e: unknown): boolean {
  return (
    typeof WebAssembly !== "undefined" &&
    !!(WebAssembly as unknown as { Exception?: Function }).Exception &&
    e instanceof (WebAssembly as unknown as { Exception: Function }).Exception
  );
}

const STANDALONE_DYNAMIC_IMPORT_ERROR =
  "Standalone dynamic import is unsupported until compileMulti provides internal module records and namespace objects";

/**
 * #3494 — catch eager import() before codegen, including top-level await paths
 * that the flattened module initializer may not lower through
 * compileCallExpression. A standalone binary cannot satisfy the host loader,
 * and compileMulti has no honest internal module-record substitute yet.
 *
 * #3509 — ordinary arrow/function-expression bodies are runtime-trap eligible:
 * creating one needs no loader, and calls.ts emits a host-free TypeError if its
 * import executes. Async/generator functions stay fatal here because a direct
 * synchronous throw would not preserve their rejection/lazy-throw semantics.
 */
function detectStandaloneDynamicImports(sourceFile: ts.SourceFile): CompileError[] {
  const errors: CompileError[] = [];
  const canTrapAtRuntime = (call: ts.CallExpression): boolean => {
    for (let parent: ts.Node | undefined = call.parent; parent; parent = parent.parent) {
      if (!ts.isFunctionLike(parent)) continue;
      if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) return false;
      const isAsync = parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      const isGenerator = ts.isFunctionExpression(parent) && parent.asteriskToken !== undefined;
      return !isAsync && !isGenerator;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (canTrapAtRuntime(node)) return;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      errors.push({
        message: STANDALONE_DYNAMIC_IMPORT_ERROR,
        line: line + 1,
        column: character + 1,
        severity: "error",
        file: sourceFile.fileName,
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

/**
 * #1927 — the single, shared front-end pipeline core. Owns everything from ES
 * early-error detection down through binary/WAT/dts/WIT emit. It is SYNCHRONOUS
 * and STOPS before the optional wasm-opt pass — the async entry points apply
 * {@link applyOptimize} over its result. This preserves the asymmetry that
 * `compileSourceSync` (the `eval` host shim's entry) must stay synchronous and
 * ignore `optimize`, while the multi entry points are async.
 *
 * The three entry adapters differ ONLY in how they build the AST(s) and collect
 * the leading TS-diagnostic `errors` (region A); everything below the
 * parse/check split is identical and lives here.
 */
function runPipeline(input: PipelineInput): CompileResult {
  const { errors, options, entryAst, multiAst, diagnosticAnchor, userSourceFiles } = input;
  const targetProfile = resolveCompileTargetProfile(options);
  const targetEnvironment = targetProfile.environment;
  const emitWatOutput = options.emitWat !== false;

  // Each validation pass below gates on the errors IT produced, NOT on the whole
  // accumulated `errors` array. This is load-bearing (#1927 regression fix): the
  // pre-collected `errors` may already hold non-fatal TS diagnostics of severity
  // "error" — e.g. TS2678 "Type '2' is not comparable to type '1'" on a switch
  // case — which the single-source path has always TOLERATED (it compiles and
  // succeeds, leaving the diagnostic in `errors`). The legacy single-source
  // driver gated each pass only on that pass's fresh output; gating on the whole
  // array here would turn every tolerated non-hard TS error into a hard failure.
  const hasNewError = (added: { severity: string }[]) => added.some((e) => e.severity !== "warning");

  // Step 1a: ES early-error detection — catch spec syntax errors TS misses, on
  // EVERY user source file (#1931). allowJs dependency files are skipped (their
  // JS may use patterns we cannot control) — same scoping as the diagnostic
  // loop in the adapters. #1958 — EXCEPT the single-source path
  // (`runEarlyErrorsOnAllowJs`), whose lone source IS the entry: the legacy
  // `compileSourceSync` ran this pass unconditionally, and the `eval` host shim
  // (always `allowJs: true`) depends on it to reject e.g. `export` in eval code.
  if (!options.allowJs || input.runEarlyErrorsOnAllowJs) {
    const earlyErrors: CompileError[] = [];
    // #3419 — module-goal signal for rules where Script vs Module top level
    // genuinely differ (duplicate top-level function declarations). The test262
    // runner passes `inferModuleStrictArguments` as an EXPLICIT boolean — `true`
    // exactly for `flags: [module]` tests (whose sources often carry no
    // syntactic import/export the checker could infer module-ness from), `false`
    // for script tests. Product compiles leave it undefined and are covered by
    // the real `ts.isExternalModule` indicator inside the rule.
    const moduleGoal = options.inferModuleStrictArguments === true;
    for (const sf of userSourceFiles) {
      earlyErrors.push(...detectEarlyErrors(sf, { moduleGoal }));
    }
    errors.push(...earlyErrors);
    if (hasNewError(earlyErrors)) {
      return failResult(errors);
    }
  }

  // Step 1a-ii: target-capability validation. This is deliberately independent
  // of allowJs: Test262 module fixtures use JavaScript source, and silently
  // skipping this gate there produced a success result with no runnable import
  // semantics for top-level `await import(...)`.
  if (targetProfile.target === "standalone") {
    const dynamicImportErrors = userSourceFiles.flatMap(detectStandaloneDynamicImports);
    errors.push(...dynamicImportErrors);
    if (dynamicImportErrors.length > 0) return failResult(errors);
  }

  // Step 1b: Safe mode validation for all user source files.
  if (options.safe) {
    const safeErrors: CompileError[] = [];
    for (const sf of userSourceFiles) {
      safeErrors.push(...validateSafeMode(sf, entryAst.checker, options));
    }
    errors.push(...safeErrors);
    if (hasNewError(safeErrors)) {
      return failResult(errors);
    }
  }

  // Step 1c: Hardened mode validation for all user source files. #1927 — moving
  // this into the shared core gives the multi paths hardened-mode parity (they
  // previously skipped it entirely).
  if (options.hardened) {
    const hardenedErrors: CompileError[] = [];
    for (const sf of userSourceFiles) {
      hardenedErrors.push(...validateHardenedMode(sf));
    }
    errors.push(...hardenedErrors);
    if (hasNewError(hardenedErrors)) {
      return failResult(errors);
    }
  }

  const emitSourceMap = options.sourceMap === true;
  const useLinear = targetProfile.backend === "linear";

  // Step 2: Generate the module (IR/codegen).
  let mod;
  let telemetry: Partial<FailureTelemetry> = EMPTY_FAILURE_TELEMETRY;
  try {
    if (useLinear) {
      mod = multiAst
        ? generateLinearMultiModule(multiAst, { exposeArenaReset: options.allocator === "arena-reset" })
        : generateLinearModule(entryAst, buildLinearOptions(options, input.irInventoryOptions));
      // Fail the compile on unsupported linear-backend constructs instead of
      // emitting a structurally invalid binary (#1868).
      if (collectLinearCodegenErrors(mod, errors)) {
        return failResult(errors);
      }
    } else {
      const result = profilePhase("codegen", () =>
        multiAst
          ? generateMultiModule(multiAst, input.codegenOptions)
          : generateModule(entryAst, input.codegenOptions, input.irInventoryOptions),
      );
      mod = result.module;
      telemetry = {
        fallbackCounts: result.fallbackCounts,
        irPostClaimErrors: result.irPostClaimErrors,
        irCompiledFuncs: result.irCompiledFuncs,
        irFirstSkipped: multiAst ? undefined : (result as ReturnType<typeof generateModule>).irFirstSkipped,
        irOutcomes: result.irOutcomes,
        irBodyRouteAudit: result.irBodyRouteAudit,
      };
      // (#3153) Post-claim demotion telemetry sink. When
      // `JS2WASM_IR_POSTCLAIM_LOG=<path>` is set, append one JSONL record per
      // post-claim demotion (selector claimed, from-ast/resolve/lower threw —
      // exactly the #3143 IR-first divergence population) so a whole test-suite
      // run doubles as an empirical throw-site meter. Same env-gated telemetry
      // pattern as JS2WASM_LOG_IR_FALLBACKS; inert (no fs touch) when unset.
      if (process.env.JS2WASM_IR_POSTCLAIM_LOG && result.irPostClaimErrors?.length) {
        try {
          // Dynamic import kept out of the module graph on purpose: this is
          // node-only telemetry and `compiler.ts` is also bundled for the
          // browser playground, where `node:fs` must not be a static dep.
          // `createRequire` via process.getBuiltinModule (node >= 20.16) or a
          // guarded globalThis require both work; simplest portable form:
          const fs = (
            globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }
          ).process?.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
          if (!fs) throw new Error("node:fs unavailable");
          const { appendFileSync } = fs;
          const file = options.fileName ?? "<source>";
          const lines = result.irPostClaimErrors
            .map((e) => JSON.stringify({ file, func: e.func, kind: e.kind, message: e.message }))
            .join("\n");
          appendFileSync(process.env.JS2WASM_IR_POSTCLAIM_LOG, lines + "\n");
        } catch {
          // Telemetry must never fail a compile.
        }
      }
      // Propagate codegen errors with source locations. #1921 — a deliberate
      // "degrade" diagnostic is surfaced as a non-fatal "warning"; the fatal
      // decision is made by isFatalCodegenDiagnostic on the raw severity.
      for (const err of result.errors) {
        errors.push({
          message: err.message,
          line: err.line,
          column: err.column,
          severity: isFatalCodegenDiagnostic(err) ? "error" : "warning",
          ...(err.file ? { file: err.file } : {}),
        });
      }
      // #1921 — gate on severity, not a "Codegen error:" message prefix.
      if (result.errors.some(isFatalCodegenDiagnostic)) {
        return failResult(errors, telemetry);
      }
    }
  } catch (e) {
    // Let host WebAssembly exceptions propagate instead of swallowing them as a
    // "Codegen error:" (so e.g. an `eval` host shim throw surfaces to the host).
    if (isWasmException(e)) throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      diagnosticAnchor,
      `Codegen error: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
    return failResult(errors, telemetry);
  }

  // Step 2b: Apply C ABI transformations if requested (linear target only).
  let cHeader: string | undefined;
  if (options.abi === "c" && options.target === "linear") {
    const cabiResult = applyCabiTransform(mod, options.moduleName ?? "module", entryAst);
    cHeader = cabiResult.cHeader;
  }

  // Step 2c: Widen non-defaultable ref types to ref_null in locals, params, and
  // results. Avoids "uninitialized non-defaultable local" and struct.get/set
  // type errors.
  widenNonDefaultableTypes(mod);

  // #4401 — An explicitly selected native-first profile is a
  // semantic-provider contract, not a best-effort hint. Never publish a module
  // that silently recovered an implicit JS semantic fallback (or an
  // unclassified import) after a native lowering declined. Value adapters,
  // lifecycle hooks, explicit platform capabilities, and named accelerators
  // remain valid imports; only the two policy classes that cannot justify
  // publication are rejected here.
  //
  // Run this before binary/WAT/helper emission so an unsupported construct
  // fails as a compile diagnostic rather than becoming a valid-looking module
  // that depends on the compatibility runtime. Target-derived standalone/WASI
  // profiles keep their established fallback/refusal behavior: standalone's
  // warning-first compatibility lanes (#2961/#2980/#3164) are not an explicit
  // native-first opt-in, while WASI's strict import gate remains authoritative.
  const imports = buildImportManifest(mod);
  const hostImportInventory = buildHostImportInventory(mod, imports, input.codegenOptions.link, targetEnvironment);
  if (options.semanticProviders === "native-first") {
    const forbidden = hostImportInventory.filter(
      (entry) => entry.classification === "legacy-semantic" || entry.classification === "unknown",
    );
    if (forbidden.length > 0) {
      const details = forbidden
        .map((entry) => `${entry.module}::${entry.name} (${entry.classification}, owner #${entry.ownerIssue})`)
        .join(", ");
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `Native-first semantic-provider policy rejected implicit or unclassified host imports: ${details}. ` +
          `Use the host-assisted compatibility profile for this source until its native provider is implemented.`,
        "error",
      );
      return failResult(errors, telemetry);
    }
  }

  // Step 3: Emit binary (with source map collection if enabled).
  let binary: Uint8Array;
  let sourceMapJson: string | undefined;
  try {
    if (emitSourceMap) {
      const emitResult = emitBinaryWithSourceMap(mod);
      const sourceMap = generateSourceMap(emitResult.sourceMapEntries, input.sourcesContent);
      sourceMapJson = JSON.stringify(sourceMap);
      // Append sourceMappingURL custom section to the binary.
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
    if (isWasmException(e)) throw e;
    pushSourceAnchoredDiagnostic(
      errors,
      diagnosticAnchor,
      `Binary emit error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      "error",
    );
    return failResult(errors, telemetry);
  }

  // Step 3b: Optimize — applied by the async entry adapters via applyOptimize,
  // not here. This synchronous core ignores options.optimize.

  // Step 4: Emit WAT (optional, non-fatal on failure).
  let wat = "";
  if (emitWatOutput) {
    try {
      wat = emitWat(
        mod,
        options.emitWatOnlyFunctions ? { onlyFunctions: new Set(options.emitWatOnlyFunctions) } : undefined,
      );
    } catch (e) {
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `WAT emit warning: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  // Step 5: Generate .d.ts.
  const dts = generateDts(entryAst, mod);

  const hostImportSummary = summarizeHostImportInventory(hostImportInventory);
  const capabilityRequirements = buildCapabilityRequirements(mod, hostImportInventory, targetEnvironment);
  const capabilityProviderDiagnostics = validatePlatformCapabilityRequirements(
    capabilityRequirements,
    targetEnvironment,
  );
  const exportBoundaryPolicies = buildExportBoundaryPolicies(mod.exportSignatures, targetProfile);
  // Step 6: Generate WIT from the same frozen capability requirements used by
  // explain output and adapter validation, never from a parallel authority map.
  let witOutput: string | undefined;
  if (options.wit) {
    const witOpts = typeof options.wit === "object" ? options.wit : undefined;
    witOutput = generateWit(entryAst, {
      ...witOpts,
      imports: mod.imports,
      types: mod.types,
      capabilities: capabilityRequirements,
    });
  }
  const adapterManifest = createJavaScriptAdapterManifest({
    targetProfile,
    imports,
    stringPool: mod.stringPool,
    capabilities: capabilityRequirements,
    exportSignatures: mod.exportSignatures,
    exportBoundaries: exportBoundaryPolicies,
  });
  // Step 7: Generate the helper from the same frozen adapter plan returned to
  // API callers. The serialized helper therefore cannot silently recover the
  // low-level buildImports compatibility defaults.
  const importsHelper = generateImportsHelper(adapterManifest);

  // Step 8 (#4420): opt-in engine validation. `success: true` above only says
  // codegen finished — it is NOT a claim that the bytes form a module, and a
  // miscompile therefore escaped as a green result (`compileFiles` on
  // `src/emit/binary.ts` returned success with 268 KB the engine rejected).
  // Wired HERE, at the one exit every driver funnels through (compileSourceSync
  // / compileSource / compileMultiSource / compileFilesSource all return
  // runPipeline's result), so no caller can be validated while another is not.
  // Runs BEFORE the async wasm-opt pass, which is deliberate: the optimizer
  // validates its own output already (#1941, and it refuses to ship bytes it
  // broke), so this gate answers for what CODEGEN produced. The binary is
  // still returned on failure — a caller that just learned its module is
  // invalid needs the bytes to dump or diff.
  let emittedBinaryAccepted = true;
  if (options.validate === true && binary.length > 0) {
    const validation = validateEmittedBinary(binary);
    if (!validation.valid) {
      emittedBinaryAccepted = false;
      pushSourceAnchoredDiagnostic(
        errors,
        diagnosticAnchor,
        `emitted WebAssembly failed validation${validation.detail ? ` — ${validation.detail}` : ""}`,
        "error",
      );
    }
  }

  return {
    binary,
    wat,
    dts,
    importsHelper,
    success: emittedBinaryAccepted,
    errors,
    stringPool: mod.stringPool,
    sourceMap: sourceMapJson,
    imports,
    targetProfile,
    hostImportInventory,
    hostImportSummary,
    capabilityRequirements,
    capabilityProviderDiagnostics,
    cHeader,
    wit: witOutput,
    hasMain: mod.exports.some((e) => e.name === "main" && e.desc.kind === "func"),
    hasTopLevelStatements: mod.hasTopLevelStatements === true,
    exportSignatures: mod.exportSignatures,
    exportBoundaryPolicies,
    adapterManifest,
    explanation: buildCompileExplanation({
      target: targetProfile,
      hostImports: hostImportSummary,
      capabilities: capabilityRequirements,
      capabilityDiagnostics: capabilityProviderDiagnostics,
      exportBoundaries: exportBoundaryPolicies,
    }),
    ...telemetry,
  };
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
  const result = compileSourceSync(source, withDefaultIrCompileRoute(options, "compile"), languageService);

  if (options.optimize && result.success) {
    const level = typeof options.optimize === "number" ? options.optimize : 3;
    const optResult = await optimizeBinaryAsync(result.binary, {
      level,
      preserveNames: options.preserveDebugNames,
    });
    if (optResult.optimized) {
      result.binary = optResult.binary;
    }
    if (optResult.warning) {
      result.errors.push({ message: optResult.warning, line: 0, column: 0, severity: "warning" });
    }
  }

  return result;
}

/** Make Annex B HTML-like comments lexable before an explicit Script-goal compile. */
function lexScriptSource(source: string, options: CompileOptions): string {
  return options.inferModuleStrictArguments === false ? normalizeScriptHtmlLikeComments(source) : source;
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

  // (#4415) Re-read the derivation flags once for this compile instead of on
  // every predicate call. `process.env` is ~85x slower than a cached boolean
  // and these predicates run in the hot lowering path. Resetting HERE — the one
  // choke point every compile passes through, including the re-entrant
  // runtime-eval path — is what keeps the ~244 test sites that set and delete
  // these variables between compiles working.
  resetDerivationFlagCache();

  // #2146 — fail fast if any codegen delegate was never wired, instead of
  // throwing an obscure error only when the relevant feature is exercised. This entry pulls
  // in every registrar module statically (via the codegen imports above), so the
  // assertion always passes on the production path; it only fires if a future
  // refactor breaks the registrar-import chain.
  assertCodegenRegistrationsComplete();

  const errors: CompileError[] = [];
  const targetProfile = resolveCompileTargetProfile(options);

  // Step 0a: Apply compile-time define substitutions (#1043)
  // #1928 — each pre-parse rewrite returns a PositionMap (output → its input);
  // we compose them so diagnostics computed against `processedSource` can be
  // reported at the user's ORIGINAL line/column instead of the rewritten one.
  const defineResult = options.define
    ? applyDefineSubstitutionsWithMap(lexScriptSource(source, options), options.define)
    : { source: lexScriptSource(source, options), positionMap: PositionMap.identity() };
  const definedSource = defineResult.source;

  // Step 0a.4: #2632 Phase 3 — inject the faithful `process.stdin` Node `Readable`
  // source-prelude (string/Buffer chunks over the fd0 reactor substrate) and
  // rewrite `process.stdin` references to the `__js2wasm_stdin()` singleton.
  // Import-scoped + WASI-only: fires ONLY when the program references
  // `process.stdin` under `--target wasi`, and is byte-identical (identity map,
  // unchanged source) otherwise. The prelude is ordinary TS riding on the Phase-2
  // intrinsics, so it flows through CJS-rewrite / preprocessImports / codegen with
  // no special-casing (mirrors the #1501 timer-shim prepend).
  const stdinResult =
    targetProfile.target === "wasi"
      ? injectProcessStdinPrelude(definedSource)
      : { source: definedSource, positionMap: PositionMap.identity(), injected: false };
  const stdinInjectedSource = stdinResult.source;

  // Step 0a.45: #3146 — inject the standalone `Iterator.zip / zipKeyed /
  // concat / from` source prelude and rewrite `Iterator.<helper>` references
  // to the prelude functions (which ride on the native iterator runtime via
  // the `__j2w_iter_*` intrinsics, see codegen/expressions/calls.ts).
  // Host-free targets only — JS-host mode keeps the runtime.ts polyfills
  // (#1464). Byte-identical (identity map, unchanged source) when the program
  // never references an Iterator static helper.
  const iterStaticsResult =
    targetProfile.environment === "none" || targetProfile.environment === "wasi"
      ? injectIteratorStaticsPrelude(stdinInjectedSource)
      : { source: stdinInjectedSource, positionMap: PositionMap.identity(), injected: false };
  const iterStaticsSource = iterStaticsResult.source;

  // Step 0a.5: Rewrite CommonJS `const X = require('Y')` patterns to ESM `import`
  // declarations (#1279). This must run before preprocessImports so the resulting
  // import statements get the same declare-stub treatment as user-written imports,
  // and before `detectNodeFsImports` so `const fs = require('node:fs')` is picked
  // up as a node:fs import for WASI mode.
  const cjsResult = rewriteCjsRequireWithMap(iterStaticsSource);
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
  // #1928/#1054 — same-line eval/super rewrites still contribute structural provenance.
  const evalResult = rewriteEvalSuperCallWithMap(cjsRewritten);
  const cjsRewritten2 = evalResult.source;
  const wasiNodeFsFuncs = detectNodeFsImports(cjsRewritten);
  // #2657 — raw `wasi_snapshot_preview1` fd_read/fd_write imports + the
  // `wasm:memory` inline linear-memory accessors (detected pre-preprocessing,
  // like node:fs above). Both empty for every program that doesn't import the
  // respective module, so it's byte-neutral elsewhere.
  const { rawWasi: wasiRawImports, memAccessors: wasiMemAccessors } = detectRawWasiImports(cjsRewritten);
  const preprocessed = preprocessImports(cjsRewritten2, { wasi: targetProfile.target === "wasi" });
  let processedSource = preprocessed.source;
  // Compose imports → eval/super → CJS → Iterator → stdin → define back to the original source.
  const positionMap = preprocessed.positionMap
    .compose(evalResult.positionMap)
    .compose(cjsResult.positionMap)
    .compose(iterStaticsResult.positionMap)
    .compose(stdinResult.positionMap)
    .compose(defineResult.positionMap);

  // Step 1: Parse and type-check
  let isJsMode = options.allowJs === true || (options.fileName?.endsWith(".js") ?? false);
  const defaultFileName = options.fileName ?? (isJsMode ? "input.js" : "input.ts");
  const effectiveFileName = options.moduleName ?? defaultFileName;
  let irInventory = irIds.maybe(
    positionMap,
    options.trackIrOutcomes || isIrCutoverAuditRequested() || targetProfile.backend === "linear",
  );
  // #2645/#2736 — `--target node`/`deno` (formerly `--platform node`) implies
  // node-style emulation so the ambient surface and the importable `node:<mod>`
  // capability gate share one target model. This EFFECTIVE flag drives the
  // TS2580 message gate below too (so the node/deno host doesn't get pointed at
  // `--emulate node` it already has via `--target`).
  const effectiveEmulateNode =
    options.emulateNode === true || options.platform === "node" || options.platform === "deno";
  // #2752 — when the `process.stdin` Readable prelude (or any future TS source
  // prelude) was injected ahead of a `.js`-named user file, parse the combined
  // unit under the TS grammar so the prelude's TS syntax (type annotations,
  // `private`, signature declarations) isn't hard-rejected with TS8009/8010/8017.
  // ScriptKind-only override; `.js`-derived lenient checking stays intact.
  const forceTsGrammar = stdinResult.injected || iterStaticsResult.injected || preprocessed.requiresTsGrammar;

  processedSource = foldGroundCalls(processedSource, effectiveFileName, options.optimize, isJsMode && !forceTsGrammar);

  // Step 1a: #3418 — host-free targets elide dead pure top-level bindings before
  // parsing so unreachable bodies do not register host imports.
  if (targetProfile.environment === "none" || targetProfile.environment === "wasi") {
    const scriptKind = isJsMode && !forceTsGrammar ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const elision = irIds.elideWithIrIds(processedSource, effectiveFileName, scriptKind, irInventory);
    processedSource = elision.source;
    irInventory = elision.inventoryOptions;
  }

  // (#743) Flag-gated (`JS2WASM_DTS_ENTRYPOINT_SEEDS`, **ON by default since
  // 2026-08-08**; `=0` disables): resolve the entry's shipped sibling `.d.ts`
  // (explicit option or on-disk sibling). `undefined` — which is still the
  // common case, since most entries have no sibling declaration file — leaves
  // every path below byte-identical.
  const dtsEntryDecls = resolveDtsEntryDeclarations(options.fileName, options.entryDeclarations);

  let ast: TypedAST;
  if (languageService && dtsEntryDecls === undefined) {
    // Incremental path: reuse cached lib files via the language service
    languageService.updateSource(processedSource, effectiveFileName, forceTsGrammar);
    ast = languageService.analyze({
      // A `.js` unit may be parsed with TS grammar after preprocessing injects
      // typed declarations (timers/import stubs). Keep its JS environment and
      // lib-global resolution explicit: the language service otherwise infers
      // allowJs from the forced ScriptKind.TS and drops ambient DOM bindings.
      allowJs: isJsMode,
      skipSemanticDiagnostics: options.skipSemanticDiagnostics,
      ...(options.platform ? { platform: options.platform } : {}),
    });
  } else {
    ast = analyzeSource(processedSource, effectiveFileName, {
      allowJs: options.allowJs,
      skipSemanticDiagnostics: options.skipSemanticDiagnostics,
      emulateNode: options.emulateNode,
      forceTsGrammar,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(dtsEntryDecls !== undefined ? { entryDeclarationsText: dtsEntryDecls } : {}),
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
        ast = analyzeSource(processedSource, jsFileName, {
          allowJs: true,
          emulateNode: options.emulateNode,
          ...(options.platform ? { platform: options.platform } : {}),
        });
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
      // #1929 — flatten the full DiagnosticMessageChain (keeps the "because…"
      // elaboration) instead of only the head .messageText.
      let message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      // #2603 — TS2580 ("Cannot find name 'X'. Do you need to install type
      // definitions for node?") flags a Node global. When node-emulation is off,
      // point the user at `--emulate node` (which turns it on and silences this)
      // rather than at @types/node.
      if (!effectiveEmulateNode && diag.code === 2580) {
        const name = message.match(/Cannot find name '([^']+)'/)?.[1] ?? "process";
        message = `Cannot find name '${name}'. Add \`--emulate node\` to enable Node API emulation (or install @types/node).`;
      }
      errors.push({
        message,
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
    // #2708 — legacy string-literal escapes (Annex B §12.9.4) are valid in sloppy
    // mode. Don't let the TS scanner errors block compilation; node-checks.ts
    // re-raises them as a hard early error in strict mode (mirrors 1121/1489).
    1487, // "Octal escape sequences are not allowed." — sloppy-mode legacy octal in string
    1488, // "Escape sequence '\\8'/'\\9' is not allowed." — sloppy-mode NonOctalDecimalEscape
    // #2631/#1768 — "Signature declarations can only be used in TypeScript files."
    // Fires under checkJs at the import site when a `.js` file imports a value
    // whose synthetic `.d.ts` typing is a callable/overloaded declaration (e.g.
    // `import { readSync, writeSync } from "node:fs"` resolving to the node-emu
    // typings). Benign for codegen — the import resolves and lowers regardless.
    // Scoped to this exact code so it does NOT relax the gate for genuine
    // strict-mode SyntaxErrors (e.g. duplicate params), which the eval shim
    // (src/runtime-eval.ts) relies on `compileSourceSync(...).success === false`
    // to surface as a thrown SyntaxError (the 17 strict-eval test262 cases).
    8017,
  ]);
  const hasSyntaxErrors = ast.syntacticDiagnostics.some(
    (d) => d.category === 1 && d.file === ast.sourceFile && !TOLERATED_SYNTAX_CODES.has(d.code),
  );
  const hasHardTypeErrors = ast.diagnostics.some((d) => isHardTypeScriptDiagnostic(d, ast.checker));

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return failResult(errors);
  }

  // (#743) Seed map consumed verbatim by BOTH inference lanes (IR fixpoint and
  // legacy call-site scan) — one shared object, so the lanes cannot see
  // different seeds. Undefined whenever the flag is off or nothing is seedable.
  const dtsSeeds =
    dtsEntryDecls !== undefined
      ? collectDtsEntrypointSeeds(ast.program.getSourceFile(DTS_ENTRY_DECLS_NAME), ast.sourceFile)
      : undefined;

  // #1927 — everything from ES early-error detection through emit is shared.
  // This single-source path runs the full rewrite prologue and threads its data
  // into codegen; the synchronous eval contract stops before wasm-opt.
  const emitSourceMap = options.sourceMap === true;
  const sourcesContent = new Map<string, string>();
  sourcesContent.set(effectiveFileName, source);
  const result = runPipeline({
    userSourceFiles: [ast.sourceFile],
    entryAst: ast,
    multiAst: null,
    errors,
    codegenOptions: buildCodegenOptions(options, emitSourceMap, {
      nodeBuiltins: preprocessed.nodeBuiltins,
      wasiNodeFsFuncs,
      wasiRawImports,
      wasiMemAccessors,
      jsxRuntime: preprocessed.jsxRuntime,
      ...(dtsSeeds ? { dtsEntrypointSeeds: dtsSeeds } : {}),
    }),
    ...(irInventory ? { irInventoryOptions: irInventory } : {}),
    sourcesContent,
    diagnosticAnchor: ast.sourceFile,
    // #1958 — single-source: the lone source is the entry, so always run ES
    // early-error detection (the `eval` host shim compiles with allowJs:true and
    // relies on it). The multi paths keep the allowJs-dependency skip.
    runEarlyErrorsOnAllowJs: true,
    options,
  });
  return finalizeSingleSourceIrTelemetry(result, ast.sourceFile, source, positionMap);
}

/**
 * Compile multiple TypeScript source files into a single Wasm module.
 * Supports cross-file imports: `import { foo } from "./bar"`.
 */
export async function compileMultiSource(
  files: Record<string, string>,
  entryFile: string,
  options: CompileOptions = {},
  projectService?: IncrementalProjectLanguageService,
  projectResolutions?: ProjectModuleResolutions,
): Promise<CompileResult> {
  const errors: CompileError[] = [];

  // Apply define substitutions to all source files (#1043)
  const definedFiles = options.define
    ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, applyDefineSubstitutions(v, options.define!)]))
    : files;

  // Rewrite CJS `const X = require('Y')` to ESM `import X from 'Y'` (#1279) across
  // every input file. This runs before TypeScript's analyzer so the require() calls
  // are seen as proper module imports during cross-file resolution.
  const rewrittenFiles = profilePhase("cjs-rewrite", () =>
    Object.fromEntries(Object.entries(definedFiles).map(([k, v]) => [k, rewriteCjsRequire(v)])),
  );
  const processedFiles = profilePhase("ground-call-fold", () =>
    foldGroundCallsInMulti(rewrittenFiles, entryFile, options.optimize),
  );
  profileCount("input-files", Object.keys(processedFiles).length);

  const analyzeOptions = {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    // #2528 — propagate the ambient-platform selection into multi-file analysis.
    ...(options.platform ? { platform: options.platform } : {}),
  };
  let multiAst: MultiTypedAST;
  if (projectService && projectResolutions === undefined) {
    profilePhase("analyze/update-project", () => projectService.updateProject(processedFiles, entryFile));
    multiAst = profilePhase("analyze/checker", () => projectService.analyze(analyzeOptions));
  } else {
    multiAst = profilePhase("analyze", () =>
      analyzeMultiSource(processedFiles, entryFile, undefined, analyzeOptions, projectResolutions),
    );
  }
  profileCount("source-files", multiAst.sourceFiles.length);
  profileCount("program-files", multiAst.program.getSourceFiles().length);

  // When allowJs is set (e.g. compiling npm packages like lodash-es), only report
  // diagnostics from the entry file — dependency files may have TS errors we can't
  // control (missing globals, JSDoc param issues, etc.). strictJsSyntax is the
  // explicit exception for syntax-test graphs whose complete literal JavaScript
  // input is owned by the caller (#3506).
  const isEntryDiag = (diag: { file?: { fileName: string } }) =>
    !options.allowJs || options.strictJsSyntax === true || !diag.file || diag.file === multiAst.entryFile;

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
  // TS2322 type mismatches, TS8017 signature-in-JS, etc.). Codegen handles it
  // fine. strictJsSyntax restores only the syntactic rejection gate; semantic
  // JavaScript diagnostics retain the existing allowJs policy.
  const hasSyntaxErrors =
    (!options.allowJs || options.strictJsSyntax === true) &&
    multiAst.syntacticDiagnostics.some(
      (d) => d.category === 1 && isEntryDiag(d) && multiAst.sourceFiles.some((sf) => d.file === sf),
    );
  const hasHardTypeErrors =
    !options.allowJs &&
    multiAst.diagnostics.some((d) => isHardTypeScriptDiagnostic(d, multiAst.checker) && isEntryDiag(d));

  if ((hasSyntaxErrors || hasHardTypeErrors) && errors.length > 0) {
    return failResult(errors);
  }

  // #1927 — early-errors / safe / hardened validation + codegen + emit are the
  // shared pipeline core (runPipeline). The multi path runs hardened mode now
  // too (parity gain). `nodeBuiltins`/`wasiNodeFsFuncs`/`jsxRuntime` stay
  // undefined for multi mode — imports resolve through the TS program, not
  // `preprocessImports` (a separate change, tracked alongside #2138). Multi
  // diagnostics use direct `getLineAndCharacterOfPosition` (no PositionMap
  // remap), so the diagnostic loop stays in this adapter.
  const emitSourceMap = options.sourceMap === true;
  // The AST surface codegen/dts/wit consume — the synthesized entry TypedAST.
  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const sourcesContent = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    sourcesContent.set(name, content);
  }
  // #2771 — detect WASI fd-IO surfaces across EVERY bundled file (entry + its
  // relative `./*.ts` deps), not just the entry. The multi path resolves cross-
  // file imports through the TS program and never runs `preprocessImports`, so
  // before this it left `wasiNodeFsFuncs`/`wasiRawImports`/`wasiMemAccessors`
  // undefined — a `node:fs` `readSync`/`writeSync` (or a raw
  // `wasi_snapshot_preview1` fd call) living in a SHARED helper file silently
  // lowered to a host `env.*` import (rejected by the WASI strict-no-host gate)
  // instead of a WASI `fd_read`/`fd_write`. We union the same string scanners the
  // single-source path uses (`detectNodeFsImports` / `detectRawWasiImports`) over
  // the CJS-rewritten file map so codegen lowers those calls module-wide. The
  // unions are empty for any program that imports none of these modules, so
  // existing multi-file compiles stay byte-identical. JSX runtime collection
  // remains a separate preprocessImports-parity change.
  const wasiNodeFsFuncs = new Set<string>();
  const wasiRawImports = new Set<string>();
  const wasiMemAccessors = new Set<string>();
  const nodeBuiltins = collectGraphNodeBuiltinImports(Object.values(processedFiles));
  for (const content of Object.values(processedFiles)) {
    for (const name of detectNodeFsImports(content)) wasiNodeFsFuncs.add(name);
    const { rawWasi, memAccessors } = detectRawWasiImports(content);
    for (const name of rawWasi) wasiRawImports.add(name);
    for (const name of memAccessors) wasiMemAccessors.add(name);
  }
  return applyOptimize(
    emitIrCutoverAudit(
      runPipeline({
        userSourceFiles: multiAst.sourceFiles,
        entryAst,
        multiAst,
        errors,
        codegenOptions: buildCodegenOptions(withDefaultIrCompileRoute(options, "compileMulti"), emitSourceMap, {
          nodeBuiltins,
          wasiNodeFsFuncs,
          wasiRawImports,
          wasiMemAccessors,
        }),
        sourcesContent,
        diagnosticAnchor: multiAst.entryFile,
        // #3506 — retain real `.js` roots (`allowJs`) while allowing a syntax
        // oracle to opt back into the ECMAScript early-error pass. Kept separate
        // from strictJsSyntax because resolution-phase tests must observe the
        // linked graph without manufacturing a parse rejection.
        runEarlyErrorsOnAllowJs: options.enforceJsEarlyErrors === true,
        options,
      }),
    ),
    options,
    multiAst.entryFile,
  );
}

/**
 * Compile a TypeScript project from an entry file on disk.
 * Uses ts.createProgram with real filesystem access -- TypeScript resolves
 * all imports automatically via standard module resolution.
 */
export async function compileFilesSource(entryPath: string, options: CompileOptions = {}): Promise<CompileResult> {
  const errors: CompileError[] = [];

  // #1927 — NOTE: unlike compileMultiSource, this path does NOT apply
  // define-substitution or the CJS `require` rewrite. analyzeFiles() builds the
  // TS program directly from disk via ts.createProgram (no in-memory source
  // map to rewrite), so wiring those in requires a rewriting CompilerHost — a
  // separate, larger change deferred to a follow-up rather than risk a behavior
  // leak in this structural refactor. The shared core (runPipeline) still gives
  // this path early-errors / hardened-mode / IR-option parity with the others.
  const multiAst = analyzeFiles(entryPath, {
    allowJs: options.allowJs,
    skipSemanticDiagnostics: options.skipSemanticDiagnostics,
    // #4452 — tsconfig discovery / opt-out. Omitted when unset so the
    // default (search upward from the entry) stays the analyzer's own.
    ...(options.tsconfig !== undefined ? { tsconfig: options.tsconfig } : {}),
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
    return failResult(errors);
  }

  // #1927 — early-errors / safe / hardened validation + codegen + emit are the
  // shared pipeline core (runPipeline). This path gains hardened-mode parity
  // too. The source-map sourcesContent comes from the on-disk source files.
  const emitSourceMap = options.sourceMap === true;
  const entryAst: TypedAST = {
    sourceFile: multiAst.entryFile,
    checker: multiAst.checker,
    program: multiAst.program,
    diagnostics: multiAst.diagnostics,
    syntacticDiagnostics: multiAst.syntacticDiagnostics,
  };
  const sourcesContent = new Map<string, string>();
  for (const sf of multiAst.sourceFiles) {
    sourcesContent.set(sf.fileName, sf.getFullText());
  }
  return applyOptimize(
    emitIrCutoverAudit(
      runPipeline({
        userSourceFiles: multiAst.sourceFiles,
        entryAst,
        multiAst,
        errors,
        codegenOptions: buildCodegenOptions(withDefaultIrCompileRoute(options, "compileFiles"), emitSourceMap),
        sourcesContent,
        diagnosticAnchor: multiAst.entryFile,
        options,
      }),
    ),
    options,
    multiAst.entryFile,
  );
}
