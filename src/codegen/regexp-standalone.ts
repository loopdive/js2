// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #682 / #1539 — Standalone RegExp engine (pure WasmGC, no JS host).
 *
 * #682 landed a reduced literal-substring `.test` (a `{pattern, flags}` struct
 * matched via `indexOf>=0`). #1539 Phase 2a replaces that with a real
 * backtracking VM: the pattern is compiled to flat `i32` bytecode at compile
 * time (`regex/{parse,compile}.ts`) and interpreted by `__regex_run`
 * (`native-regex.ts`). The literal-substring case is now the `CHAR`-only
 * degenerate path of the VM. See the issue's "Implementation Notes (sd-1539)".
 *
 * Current slice: `RegExp` literals / `new RegExp(staticPattern, staticFlags)`,
 * `RegExp.prototype.test`/non-global `.exec`, non-global
 * `String.prototype.match`, `String.prototype.search`, literal-string
 * `replace`/`replaceAll`, and non-capturing regex `split`. Dynamic patterns,
 * global/sticky capture-array methods, `matchAll`, replacement substitutions,
 * and fancy features stay narrowed refusals citing the later phase.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeStringHelpers, nativeStringType, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { coerceType } from "./type-coercion.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import {
  ensureRegexCaptureArray,
  ensureRegexFlagsStr,
  ensureRegexMatchAll,
  ensureRegexMatchAllArrays,
  ensureRegexMatchAllVecType,
  ensureRegexMatchVecType,
  ensureRegexReplace,
  ensureRegexSearch,
  ensureRegexSplit,
  i32ArrayLiteralInstrs,
  MATCH_VEC_FIELD_INDEX,
  MATCH_VEC_FIELD_INDICES,
  MATCH_VEC_FIELD_INPUT,
  MATCH_VEC_FIELD_GROUPS,
  REGEXP_MATCH_VEC_STRUCT,
  regexI32ArrayType,
} from "./native-regex.js";
import {
  type CompiledRegex,
  parseFlags,
  RegexUnsupportedError,
  RE_FLAG_D,
  RE_FLAG_G,
  RE_FLAG_I,
  RE_FLAG_M,
  RE_FLAG_S,
  RE_FLAG_U,
  RE_FLAG_V,
  RE_FLAG_Y,
} from "./regex/bytecode.js";
import { compilePattern, RepeatTooLargeError } from "./regex/compile.js";
import {
  emitBrandCheckTypeError,
  emitNativeProtoIdentityReturnUndefined,
  getBuiltinBrand,
  registerNativeProtoBuiltin,
  type NativeProtoBuiltinGlue,
} from "./native-proto.js";
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { nativeStringRepr } from "./builtin-scaffold.js";

export const STANDALONE_REGEXP_ABI_VERSION = 1;

export const STANDALONE_REGEXP_ENGINE_KIND = "quickjs-libregexp" as const;
export const STANDALONE_REGEXP_SUBSET_ENGINE_KIND = "native-literal-substring" as const;

export type StandaloneRegExpEngineKind =
  | typeof STANDALONE_REGEXP_ENGINE_KIND
  | typeof STANDALONE_REGEXP_SUBSET_ENGINE_KIND;

export interface StandaloneRegExpAbiFunction {
  /**
   * Function name expected in the generated module. These are in-module
   * symbols, not `env` JS-host imports.
   */
  name: string;
  params: readonly ValType[];
  results: readonly ValType[];
}

export interface StandaloneRegExpEngineConfig {
  kind: StandaloneRegExpEngineKind;
  abiVersion: typeof STANDALONE_REGEXP_ABI_VERSION;
  functions: typeof STANDALONE_REGEXP_ABI;
}

export interface StandaloneRegExpEngineState {
  standaloneRegExpEngine?: StandaloneRegExpEngineConfig | null;
}

const I32 = { kind: "i32" } as const satisfies ValType;

/**
 * Minimal ABI boundary for the first native engine slice. Lowering code should
 * only query this contract after #1474's refusal gate is opened.
 */
export const STANDALONE_REGEXP_ABI = {
  compile: {
    name: "__re_compile",
    params: [I32, I32, I32],
    results: [I32],
  },
  exec: {
    name: "__re_exec",
    params: [I32, I32, I32, I32],
    results: [I32],
  },
  free: {
    name: "__re_free",
    params: [I32],
    results: [],
  },
  groupStart: {
    name: "__re_group_start",
    params: [I32, I32],
    results: [I32],
  },
  groupEnd: {
    name: "__re_group_end",
    params: [I32, I32],
    results: [I32],
  },
} as const satisfies Record<string, StandaloneRegExpAbiFunction>;

export function quickJsLibRegexpEngineConfig(): StandaloneRegExpEngineConfig {
  return {
    kind: STANDALONE_REGEXP_ENGINE_KIND,
    abiVersion: STANDALONE_REGEXP_ABI_VERSION,
    functions: STANDALONE_REGEXP_ABI,
  };
}

export function nativeLiteralRegExpEngineConfig(): StandaloneRegExpEngineConfig {
  return {
    kind: STANDALONE_REGEXP_SUBSET_ENGINE_KIND,
    abiVersion: STANDALONE_REGEXP_ABI_VERSION,
    functions: STANDALONE_REGEXP_ABI,
  };
}

export function getStandaloneRegExpEngine(state: StandaloneRegExpEngineState): StandaloneRegExpEngineConfig | null {
  return state.standaloneRegExpEngine ?? null;
}

export function hasStandaloneRegExpEngine(state: StandaloneRegExpEngineState): boolean {
  return getStandaloneRegExpEngine(state) !== null;
}

const STANDALONE_REGEXP_STRUCT_NAME = "__StandaloneRegExp";
// g/i/y from Phase 2a, m/s from 2c, d/u/v from 2d (#1911 — `d` does not
// change MATCHING semantics; the `.indices` result surface is #1914's lane;
// u/v code-point atoms resolve via compile-time host enumeration, Slice B).
const SUPPORTED_STANDALONE_FLAGS =
  RE_FLAG_G | RE_FLAG_I | RE_FLAG_Y | RE_FLAG_M | RE_FLAG_S | RE_FLAG_D | RE_FLAG_U | RE_FLAG_V;

function reportStandaloneRegExpUnsupported(ctx: CodegenContext, node: ts.Node, detail: string): void {
  reportError(
    ctx,
    node,
    `Codegen error: standalone RegExp engine does not support ${detail} (#1539 Phase 2a). ` +
      "Use a supported pattern/flag set, or recompile without --target standalone.",
  );
}

function stripStaticWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticStandaloneRegExpCreation(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripStaticWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped)) {
    const callee = stripStaticWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && isGlobalRegExpIdentifier(ctx, callee);
  }
  if (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken) {
    const callee = stripStaticWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && isGlobalRegExpIdentifier(ctx, callee);
  }
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function isSameSymbolIdentifier(ctx: CodegenContext, expr: ts.Expression, sym: ts.Symbol): boolean {
  const unwrapped = stripStaticWrapper(expr);
  return ts.isIdentifier(unwrapped) && ctx.checker.getSymbolAtLocation(unwrapped) === sym;
}

function assignmentTargetContainsSymbol(ctx: CodegenContext, target: ts.Expression, sym: ts.Symbol): boolean {
  const unwrapped = stripStaticWrapper(target);
  if (ts.isIdentifier(unwrapped)) return ctx.checker.getSymbolAtLocation(unwrapped) === sym;
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.some((element) => {
      if (ts.isOmittedExpression(element)) return false;
      if (ts.isSpreadElement(element)) return assignmentTargetContainsSymbol(ctx, element.expression, sym);
      return assignmentTargetContainsSymbol(ctx, element, sym);
    });
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.some((prop) => {
      if (ts.isShorthandPropertyAssignment(prop)) return ctx.checker.getSymbolAtLocation(prop.name) === sym;
      if (ts.isPropertyAssignment(prop)) return assignmentTargetContainsSymbol(ctx, prop.initializer, sym);
      if (ts.isSpreadAssignment(prop)) return assignmentTargetContainsSymbol(ctx, prop.expression, sym);
      return false;
    });
  }
  return false;
}

function bindingHasWrites(ctx: CodegenContext, decl: ts.VariableDeclaration, sym: ts.Symbol): boolean {
  let hasWrite = false;
  const visit = (node: ts.Node): void => {
    if (hasWrite) return;

    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      assignmentTargetContainsSymbol(ctx, node.left, sym)
    ) {
      hasWrite = true;
      return;
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isSameSymbolIdentifier(ctx, node.operand, sym)
    ) {
      hasWrite = true;
      return;
    }

    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsSymbol(ctx, node.initializer, sym)
    ) {
      hasWrite = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(decl.getSourceFile(), visit);
  return hasWrite;
}

function isTrustedBackendCreatedRegExpBinding(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  sym: ts.Symbol,
): boolean {
  if (!decl.initializer || !isStaticStandaloneRegExpCreation(ctx, decl.initializer)) return false;
  if (!ts.isVariableDeclarationList(decl.parent)) return false;
  if ((decl.parent.flags & ts.NodeFlags.Const) !== 0) return true;
  return !bindingHasWrites(ctx, decl, sym);
}

function isKnownBackendCreatedRegExpReceiver(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripStaticWrapper(expr);
  if (isStaticStandaloneRegExpCreation(ctx, unwrapped)) return true;
  if (!ts.isIdentifier(unwrapped)) return false;

  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  if (!sym) return false;
  const decls = sym?.getDeclarations() ?? [];
  return decls.some((decl) => ts.isVariableDeclaration(decl) && isTrustedBackendCreatedRegExpBinding(ctx, decl, sym));
}

export function isGlobalRegExpIdentifier(ctx: CodegenContext, ident: ts.Identifier): boolean {
  if (ident.text !== "RegExp") return false;
  const sym = ctx.checker.getSymbolAtLocation(ident);
  return isDeclarationFileOnlySymbol(sym);
}

function isDeclarationFileOnlySymbol(sym: ts.Symbol | undefined): boolean {
  if (!sym) return true;
  const decls = sym.getDeclarations();
  if (!decls || decls.length === 0) return true;
  return decls.every((decl) => decl.getSourceFile().isDeclarationFile);
}

export function isGlobalRegExpType(type: ts.Type): boolean {
  const sym = type.getSymbol();
  return sym?.getName() === "RegExp" && isDeclarationFileOnlySymbol(sym);
}

/**
 * (#2161 B2) A syntactically-undefined expression — the `undefined` global
 * identifier or a `void 0`-style void expression. Used to apply the
 * §22.1.3.23 / §22.2.6.14 "if limit is undefined, lim = 2^32-1" (and "if
 * separator is undefined, return [S]") spec branches at compile time: these
 * arguments otherwise compile to f64 NaN, and ToUint32(NaN) = 0 silently
 * truncates the result to `[]` (`"a b".split(" ", undefined)` returned `[]`,
 * not `["a","b"]`). A RUNTIME-undefined value (a variable holding undefined)
 * is indistinguishable from a genuine NaN-coercing argument here and keeps
 * the ToUint32 lowering.
 */
export function isStaticallyUndefinedExpr(expr: ts.Expression): boolean {
  const e = stripStaticWrapper(expr);
  if (ts.isIdentifier(e) && e.text === "undefined") return true;
  if (ts.isVoidExpression(e)) {
    // Only side-effect-free operands (`void 0`, `void "x"`, `void id`) may be
    // folded away — `void f()` must still evaluate `f()`.
    const op = stripStaticWrapper(e.expression);
    return ts.isLiteralExpression(op) || ts.isIdentifier(op);
  }
  return false;
}

function staticStringValue(ctx: CodegenContext, expr: ts.Expression): string | null | undefined {
  const unwrapped = stripStaticWrapper(expr);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    const type = ctx.checker.getTypeAtLocation(unwrapped);
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
      return undefined;
    }
  }
  return null;
}

/**
 * #2161 — recover a **compile-time-constant** string from a `new RegExp(...)`
 * pattern / flags argument that `staticStringValue` is too narrow to fold.
 *
 * Returns the folded string, `undefined` for a statically-`undefined` operand
 * (so the caller can apply the spec default), or `null` when the operand is not
 * a constant we can resolve at compile time (genuinely dynamic — the caller
 * keeps the existing refusal, which lowers to a runtime path).
 *
 * Folds, recursively:
 *   - string literals / no-substitution templates (same as `staticStringValue`),
 *   - `const`-bound identifiers initialised to a foldable constant,
 *   - `a + b` string concatenation where both sides fold to strings, and
 *   - parenthesised / `as` / `!` wrappers (via `stripStaticWrapper`).
 *
 * It intentionally does NOT fold template literals with substitutions, numeric
 * coercions, or `let`/`var` / reassigned bindings — those stay dynamic. Bounded
 * + behaviour-preserving: a pattern this resolves was already statically known,
 * so routing it to the native engine cannot change a previously-correct result
 * (the only prior behaviour for these forms was a runtime trap).
 */
function staticConstStringValue(
  ctx: CodegenContext,
  expr: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): string | null | undefined {
  const cur = stripStaticWrapper(expr);

  // Direct literal / undefined — defer to the narrow helper first.
  const direct = staticStringValue(ctx, cur);
  if (direct !== null) return direct;

  // (#2161 B4) `void 0`-style statically-undefined operands (side-effect-free
  // only) take the spec's undefined default — `new RegExp(/re/g, void 0)`.
  if (isStaticallyUndefinedExpr(cur)) return undefined;

  // `a + b` — fold when both operands fold to strings.
  if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticConstStringValue(ctx, cur.left, seen);
    if (typeof left !== "string") return null;
    const right = staticConstStringValue(ctx, cur.right, seen);
    if (typeof right !== "string") return null;
    return left + right;
  }

  // `const`-bound — or provably never-reassigned `var`/`let`-bound —
  // identifier → follow its initialiser once. (#2161 B4) The sputnik-era
  // test262 RegExp suites bind patterns/flags with `var` (`var __re = "d+";
  // RegExp(__re, "i")`), which the const-only fold refused, lowering the ctor
  // to the runtime-trap placeholder ("illegal cast"). `bindingHasWrites` (the
  // same whole-source write scan `isTrustedBackendCreatedRegExpBinding`
  // already relies on) proves the binding is assigned only at its declaration;
  // a multi-declaration `var` (re-declared with a second initialiser, which is
  // NOT an assignment expression) is refused via the single-declaration guard.
  if (ts.isIdentifier(cur)) {
    const sym = ctx.checker.getSymbolAtLocation(cur);
    const decl = sym?.valueDeclaration;
    if (!sym || !decl || !ts.isVariableDeclaration(decl)) return null;
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list)) return null;
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    if (!isConst) {
      const varDecls = (sym.getDeclarations() ?? []).filter((d) => ts.isVariableDeclaration(d));
      if (varDecls.length !== 1) return null;
      if (bindingHasWrites(ctx, decl, sym)) return null;
    }
    // A never-written binding with NO initialiser is always `undefined`
    // (`var x; new RegExp(/re/m, x)` — sputnik's hoisted-undefined flags form).
    if (!decl.initializer) return isConst ? null : undefined;
    if (seen.has(decl.initializer)) return null;
    // `seen` guards the ACTIVE resolution path (a self-referential cycle), so
    // unwind it after the recursive fold — a diamond (`a + "x" + a`, the same
    // binding referenced twice in one pattern) is legitimate and must fold
    // (#2161 B4: the REX XML-parser concat chains reuse fragments repeatedly).
    seen.add(decl.initializer);
    const folded = staticConstStringValue(ctx, decl.initializer, seen);
    seen.delete(decl.initializer);
    return folded;
  }

  return null;
}

/**
 * #2161 — recover pattern + flags from a regex-literal first argument to
 * `new RegExp(/…/f [, flags])` (the §22.2.3.1 copy-constructor form). When the
 * second `flags` argument is provided it OVERRIDES the literal's own flags
 * (step 4.b/7); when omitted (or statically `undefined`) the literal's flags
 * are inherited (step 4.a). `flagsArg` must itself fold to a constant (or be
 * absent/undefined); a dynamic flags argument returns `null` (stays refused).
 */
function staticRegExpLiteralCopy(
  ctx: CodegenContext,
  patternArg: ts.Expression,
  flagsArg: ts.Expression | undefined,
  depth = 0,
): StaticRegExpPatternFlags | null {
  // (#2161 B4) Depth guard: the copy form can delegate back to
  // `staticRegExpPatternFlags` (nested `new RegExp(new RegExp(...))` /
  // binding chains), and a pathological self-referential binding
  // (`var a = new RegExp(a)`) would otherwise recurse forever at COMPILE time.
  if (depth > 16) return null;
  let unwrapped = stripStaticWrapper(patternArg);
  // (#2161 B4) Follow a const / never-reassigned binding to its regex-literal
  // initialiser — the sputnik copy-ctor form (`var __pattern = /./i;
  // new RegExp(__pattern)`). Same never-reassigned proof as
  // `staticConstStringValue`'s identifier arm.
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    const decl = sym?.valueDeclaration;
    if (
      sym &&
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent)
    ) {
      const isConst = (decl.parent.flags & ts.NodeFlags.Const) !== 0;
      const varDecls = (sym.getDeclarations() ?? []).filter((d) => ts.isVariableDeclaration(d));
      if (isConst || (varDecls.length === 1 && !bindingHasWrites(ctx, decl, sym))) {
        unwrapped = stripStaticWrapper(decl.initializer);
      }
    }
  }
  let litPattern: string;
  let litFlags: string;
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    const text = (unwrapped as ts.RegularExpressionLiteral).text;
    const lastSlash = text.lastIndexOf("/");
    litPattern = lastSlash >= 0 ? text.slice(1, lastSlash) : text;
    litFlags = lastSlash >= 0 ? text.slice(lastSlash + 1) : "";
  } else if (ts.isNewExpression(unwrapped) || ts.isCallExpression(unwrapped)) {
    // (#2161 B4) The copy SOURCE can itself be a statically-recoverable
    // constructor form — `var p = new RegExp; new RegExp(p, "g")` (sputnik
    // 15.10.4.1-1 / A1_T4/T5). Delegate to the full recoverer, which handles
    // `new RegExp(...)` / `RegExp(...)` and trusted bindings.
    const base = staticRegExpPatternFlags(ctx, unwrapped, depth + 1);
    if (base === null) return null;
    litPattern = base.pattern;
    litFlags = base.flags;
  } else {
    return null;
  }

  if (flagsArg === undefined) return { pattern: litPattern, flags: litFlags };
  const overrideFlags = staticConstStringValue(ctx, flagsArg);
  if (overrideFlags === null) return null; // dynamic flags → stay refused
  // `undefined` flags argument inherits the literal's flags (§22.2.3.1 step 4.a).
  return { pattern: litPattern, flags: overrideFlags ?? litFlags };
}

interface StaticRegExpPatternFlags {
  pattern: string;
  flags: string;
}

/**
 * Recover the pattern+flags of a static / backend-created RegExp expression:
 * `/…/flags`, `new RegExp("…", "flags")`, `RegExp("…", "flags")`, or a
 * trusted binding initialized to one of those forms.
 */
function staticRegExpPatternFlags(
  ctx: CodegenContext,
  expr: ts.Expression,
  depth = 0,
): StaticRegExpPatternFlags | null {
  if (depth > 16) return null; // see staticRegExpLiteralCopy's depth guard
  const unwrapped = stripStaticWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    const text = (unwrapped as ts.RegularExpressionLiteral).text;
    const lastSlash = text.lastIndexOf("/");
    return {
      pattern: lastSlash >= 0 ? text.slice(1, lastSlash) : text,
      flags: lastSlash >= 0 ? text.slice(lastSlash + 1) : "",
    };
  }
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripStaticWrapper(unwrapped.expression);
    if (!ts.isIdentifier(callee) || !isGlobalRegExpIdentifier(ctx, callee)) return null;
    const patternArg = unwrapped.arguments?.[0];
    const flagsArg = unwrapped.arguments?.[1];
    // #2161 — a regex-literal first arg is the §22.2.3.1 copy form.
    if (patternArg !== undefined) {
      const copy = staticRegExpLiteralCopy(ctx, patternArg, flagsArg, depth + 1);
      if (copy !== null) return copy;
    }
    // #2161 — fold compile-time-constant pattern/flags (concat, const-bound)
    // so a `const re = new RegExp("a"+"b","g")` binding is recognised as a
    // backend-created receiver for downstream `re.test`/`re.exec`/etc.
    const pattern = patternArg === undefined ? "" : staticConstStringValue(ctx, patternArg);
    const flags = flagsArg === undefined ? "" : staticConstStringValue(ctx, flagsArg);
    if (pattern === null || flags === null) return null;
    return { pattern: pattern ?? "", flags: flags ?? "" };
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    if (!sym) return null;
    const decl = sym.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
    if (!decl?.initializer || !isTrustedBackendCreatedRegExpBinding(ctx, decl, sym)) return null;
    return staticRegExpPatternFlags(ctx, decl.initializer, depth + 1);
  }
  return null;
}

function compileStaticStandaloneRegExp(
  ctx: CodegenContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): CompiledRegex | null {
  let flagBits: number;
  try {
    flagBits = parseFlags(flags);
  } catch (e) {
    reportStandaloneRegExpUnsupported(ctx, node, describeRegexError(e, `flags ${JSON.stringify(flags)}`));
    return null;
  }

  const refusedFlags = flagBits & ~SUPPORTED_STANDALONE_FLAGS;
  if (refusedFlags !== 0) {
    reportStandaloneRegExpUnsupported(ctx, node, `flags ${JSON.stringify(flags)} (#1539 Phase 2d)`);
    return null;
  }

  // u/v mode is strict (no Annex B): pre-validate against the host so a
  // genuinely invalid LITERAL refuses at compile instead of silently riding a
  // lenient parser path (constructor sites already lowered host-invalid
  // patterns to a runtime SyntaxError before reaching here). #1911 Slice B.
  if ((flagBits & (RE_FLAG_U | RE_FLAG_V)) !== 0) {
    const syntaxMsg = hostRegExpSyntaxErrorMessage(pattern, flags);
    if (syntaxMsg !== null) {
      reportStandaloneRegExpUnsupported(ctx, node, `invalid u/v pattern: ${syntaxMsg}`);
      return null;
    }
  }

  try {
    return compilePattern(pattern, flagBits);
  } catch (e) {
    if (e instanceof RegexUnsupportedError || e instanceof RepeatTooLargeError) {
      reportStandaloneRegExpUnsupported(ctx, node, e.message);
      return null;
    }
    throw e;
  }
}

/**
 * NON-REPORTING metadata-only static-regex resolution (#2588/#2589). Returns
 * `{ groupNames, flags, nGroups }` for a static RegExp expression, or `null`
 * when the static form can't be recovered/compiled. Unlike
 * `compileStaticStandaloneRegExp`, this swallows every error (a genuinely
 * invalid pattern is reported by the PRIMARY lowering path — e.g. exec's
 * `emitRegexSearchCall`; re-reporting here would turn a deferred runtime
 * SyntaxError into a spurious compile error, see #1912 `[b-ac-e]`). Used only
 * to thread the named-group map + `d` flag into the result-shape builders.
 */
function staticRegExpGroupMeta(
  ctx: CodegenContext,
  expr: ts.Expression,
): { groupNames: ReadonlyMap<string, number>; flags: number; nGroups: number } | null {
  const meta = staticRegExpPatternFlags(ctx, expr);
  if (meta === null) return null;
  try {
    const flagBits = parseFlags(meta.flags);
    if ((flagBits & ~SUPPORTED_STANDALONE_FLAGS) !== 0) return null;
    const compiled = compilePattern(meta.pattern, flagBits);
    return { groupNames: compiled.groupNames, flags: compiled.flags, nGroups: compiled.nGroups };
  } catch {
    return null;
  }
}

/**
 * The `$NativeRegExp` struct (#1539). Holds the flags bitfield, the
 * capture-group count, the compiled bytecode program, the class table, and the
 * source pattern string. Field order is load-bearing — codegen reads by
 * `fieldIdx`.
 *
 * NOTE: field[1] must NOT be a ref-to-array. `getArrTypeIdxFromVec` (in
 * registry/types.ts) is a *structural* heuristic that classifies any struct
 * whose field[1] is a ref-to-array as a "vec struct", which makes
 * `coerceType` ref→externref attach `__make_iterable` (a JS host import). With
 * the array fields at slots 0/1 that misfires and breaks standalone purity
 * (#682's struct dodged this by having `flags:i32` at field[1]); putting the
 * i32 scalars first keeps the struct off that heuristic.
 */
const RE_FIELD_FLAGS = 0;
const RE_FIELD_NGROUPS = 1;
const RE_FIELD_PROG = 2;
const RE_FIELD_CLASS_TABLE = 3;
const RE_FIELD_SOURCE = 4;
const RE_FIELD_NSCRATCH = 5; // #1959 — scratch slots for PROGRESS guards
const RE_FIELD_LASTINDEX = 6;

/**
 * Push `2 * nGroups + nScratch` (the VM caps-array length) onto the stack,
 * reading both fields from a `$NativeRegExp` struct local (#1959). The caps
 * array carries the real capture slots plus the scratch slots that back
 * PROGRESS empty-loop guards.
 */
function pushNSlots(fctx: FunctionContext, regexpLocal: number, structTypeIdx: number): void {
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.mul" });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NSCRATCH });
  fctx.body.push({ op: "i32.add" });
}

/**
 * EscapeRegExpPattern (ECMA-262 §22.2.6.13.1), computed at compile time —
 * standalone patterns are always static. The escaped form must let
 * `"/" + escaped + "/" + flags` reparse as an equivalent
 * RegularExpressionLiteral:
 * - empty pattern → `"(?:)"` (a bare `//` would lex as a comment);
 * - unescaped `/` outside a class → `\/` (escaped or in-class occurrences
 *   already reparse);
 * - LineTerminators → their escape sequences (they can enter via
 *   `new RegExp("\n")` and would terminate the literal otherwise).
 */
export function escapeRegExpPattern(pattern: string): string {
  if (pattern === "") return "(?:)";
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = i + 1 < pattern.length ? pattern[i + 1]! : null;
      if (next === null) {
        // Trailing lone backslash (compilePattern rejects this earlier).
        out += ch;
        continue;
      }
      // Escaped pair passes through verbatim, unless the escaped char is a
      // LineTerminator (e.g. new RegExp("\\\n")), which still needs the
      // escape-sequence spelling to survive re-lexing.
      if (next === "\n") out += "\\n";
      else if (next === "\r") out += "\\r";
      else if (next === "\u2028") out += "\\u2028";
      else if (next === "\u2029") out += "\\u2029";
      else out += ch + next;
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    if (ch === "/" && !inClass) out += "\\/";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\u2028") out += "\\u2028";
    else if (ch === "\u2029") out += "\\u2029";
    else out += ch;
  }
  return out;
}

function ensureStandaloneRegExpStruct(ctx: CodegenContext): number {
  const existing = ctx.structMap.get(STANDALONE_REGEXP_STRUCT_NAME);
  if (existing !== undefined) return existing;

  const i32ArrIdx = regexI32ArrayType(ctx);
  const i32ArrRef: ValType = { kind: "ref", typeIdx: i32ArrIdx };
  const typeIdx = ctx.mod.types.length;
  const fields = [
    { name: "flags", type: { kind: "i32" } as ValType, mutable: false },
    { name: "nGroups", type: { kind: "i32" } as ValType, mutable: false },
    { name: "prog", type: i32ArrRef, mutable: false },
    { name: "classTable", type: i32ArrRef, mutable: false },
    { name: "source", type: nativeStringType(ctx), mutable: false },
    // Scratch capture-slot count for PROGRESS empty-loop guards (#1959). The VM
    // caps array is sized `2*nGroups + nScratch`; scratch slots are never
    // reported as captures. Field added after source to keep lastIndex last.
    { name: "nScratch", type: { kind: "i32" } as ValType, mutable: false },
    // [[LastIndex]] (§22.2.7.1) — a plain writable number property on the
    // RegExp object. Stored as f64; exec applies ToLength at use time. Only
    // g/y exec mutates it (#1913); reads/writes route through the #1914
    // reflection path below.
    { name: "lastIndex", type: { kind: "f64" } as ValType, mutable: true },
  ];
  ctx.mod.types.push({
    kind: "struct",
    name: STANDALONE_REGEXP_STRUCT_NAME,
    fields,
  });
  ctx.structMap.set(STANDALONE_REGEXP_STRUCT_NAME, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, STANDALONE_REGEXP_STRUCT_NAME);
  ctx.structFields.set(STANDALONE_REGEXP_STRUCT_NAME, fields);
  return typeIdx;
}

/**
 * Compile a static pattern+flags to bytecode and emit a `$NativeRegExp` struct
 * on the stack. Out-of-subset patterns / flags surface as a clean
 * #1539-phased compile error (the narrowed refusal).
 */
function emitStandaloneRegExpStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): ValType | null {
  const compiled = compileStaticStandaloneRegExp(ctx, pattern, flags, node);
  if (compiled === null) return null;

  const typeIdx = ensureStandaloneRegExpStruct(ctx);
  // field 0: flags
  fctx.body.push({ op: "i32.const", value: compiled.flags });
  // field 1: nGroups
  fctx.body.push({ op: "i32.const", value: compiled.nGroups });
  // field 2: prog (ref array<i32>)
  for (const instr of i32ArrayLiteralInstrs(ctx, compiled.prog)) fctx.body.push(instr);
  // field 3: classTable (ref array<i32>)
  for (const instr of i32ArrayLiteralInstrs(ctx, compiled.classTable)) fctx.body.push(instr);
  // field 4: source string — stored in spec form (§22.2.6.13.1
  // EscapeRegExpPattern) so the `.source` getter is a plain field read.
  const srcType = compileStringLiteral(ctx, fctx, escapeRegExpPattern(pattern), node);
  if (!srcType) return null;
  // field 5: nScratch — PROGRESS empty-loop guard slots (#1959).
  fctx.body.push({ op: "i32.const", value: compiled.nScratch });
  // field 6: lastIndex — fresh RegExp objects start at 0 (§22.2.3.3).
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "struct.new", typeIdx });
  return { kind: "ref", typeIdx };
}

/** Extract a readable detail from a thrown regex error for diagnostics. */
function describeRegexError(e: unknown, fallback: string): string {
  if (e instanceof RegexUnsupportedError || e instanceof RepeatTooLargeError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

function compileStandaloneRegExpPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): ValType | null {
  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, node, "RegExp without an enabled standalone engine");
    return null;
  }
  return emitStandaloneRegExpStruct(ctx, fctx, pattern, flags, node);
}

export function compileStandaloneRegExpLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: string,
  flags: string,
  node: ts.Node,
): ValType | null {
  return compileStandaloneRegExpPattern(ctx, fctx, pattern, flags, node);
}

/**
 * Genuine (pattern, flags) SyntaxErrors vs. engine limitations (#1912).
 *
 * The compiler runs on a JS host whose `RegExp` constructor is a spec-exact
 * validity oracle: any pair the host rejects with a SyntaxError is invalid per
 * §22.2.3.2 and must throw a *runtime* SyntaxError when the compiled
 * `new RegExp(...)` evaluates — not fail the whole compile (test262's
 * S15.10.1/S15.10.2.15 families catch exactly this). Host-VALID patterns our
 * matcher can't handle stay compile-time narrowed refusals.
 */
function hostRegExpSyntaxErrorMessage(pattern: string, flags: string): string | null {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    if (e instanceof SyntaxError) return e.message;
    return e instanceof Error ? e.message : "Invalid regular expression";
  }
}

/**
 * Lower an invalid `new RegExp(...)` to a runtime `throw new SyntaxError(msg)`
 * (#1912). The trailing `unreachable` makes the post-throw stack polymorphic,
 * so the claimed `$NativeRegExp` result type validates without materializing a
 * struct — downstream creation-site codegen (e.g. an `.exec` chained on the
 * receiver) emits normally as dead code.
 */
function emitThrowRegExpSyntaxError(ctx: CodegenContext, fctx: FunctionContext, message: string): ValType {
  emitWasiErrorConstructor(ctx, "SyntaxError", 1);
  addStringConstantGlobal(ctx, message);
  const ctorIdx = ctx.funcMap.get("__new_SyntaxError")!;
  const tagIdx = ensureExnTag(ctx);
  for (const instr of stringConstantExternrefInstrs(ctx, message)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: ctorIdx });
  fctx.body.push({ op: "throw", tagIdx } as Instr);
  fctx.body.push({ op: "unreachable" } as Instr);
  return { kind: "ref", typeIdx: ensureStandaloneRegExpStruct(ctx) };
}

export function compileStandaloneRegExpConstructor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  node: ts.Node,
): ValType | null {
  const patternArg = args[0];
  const flagsArg = args[1];

  // #2161 — §22.2.3.1 copy-constructor: `new RegExp(/…/f [, flags])`. The first
  // argument is a regex literal; the pattern (and inherited-or-overridden flags)
  // are statically known, so route to the native engine instead of refusing.
  if (patternArg !== undefined) {
    const copy = staticRegExpLiteralCopy(ctx, patternArg, flagsArg);
    if (copy !== null) {
      const syntaxMsg = hostRegExpSyntaxErrorMessage(copy.pattern, copy.flags);
      if (syntaxMsg !== null && hasStandaloneRegExpEngine(ctx)) {
        return emitThrowRegExpSyntaxError(ctx, fctx, syntaxMsg);
      }
      return compileStandaloneRegExpPattern(ctx, fctx, copy.pattern, copy.flags, node);
    }
  }

  // #2161 — fold compile-time-constant patterns/flags (string-literal concat,
  // `const`-bound literals) that `staticStringValue` alone is too narrow for;
  // genuinely dynamic operands still resolve to `null` and keep the refusal.
  const pattern = patternArg === undefined ? "" : staticConstStringValue(ctx, patternArg);
  if (pattern === null) {
    reportStandaloneRegExpUnsupported(ctx, patternArg, "dynamic constructor patterns");
    return null;
  }

  const flags = flagsArg === undefined ? "" : staticConstStringValue(ctx, flagsArg);
  if (flags === null) {
    reportStandaloneRegExpUnsupported(ctx, flagsArg, "dynamic constructor flags");
    return null;
  }

  // §22.2.3.2: an invalid static pattern/flags pair throws SyntaxError when
  // the constructor call evaluates — emit the runtime throw, not a compile
  // refusal (#1912). Regex *literals* keep the compile-time diagnostic since
  // an invalid literal is an early error.
  const syntaxMsg = hostRegExpSyntaxErrorMessage(pattern ?? "", flags ?? "");
  if (syntaxMsg !== null && hasStandaloneRegExpEngine(ctx)) {
    return emitThrowRegExpSyntaxError(ctx, fctx, syntaxMsg);
  }

  return compileStandaloneRegExpPattern(ctx, fctx, pattern ?? "", flags ?? "", node);
}

function isStandaloneRegExpValue(
  ctx: CodegenContext,
  valueType: ValType | null,
): valueType is ValType & { typeIdx: number } {
  if (!valueType || (valueType.kind !== "ref" && valueType.kind !== "ref_null")) return false;
  return valueType.typeIdx === ctx.structMap.get(STANDALONE_REGEXP_STRUCT_NAME);
}

/**
 * Result of {@link emitRegexSearchCall}: locals holding the regex struct, the
 * capture-slots array, and the struct type index used to read its fields.
 */
interface RegexSearchEmission {
  /** Local holding the (non-null) `$NativeRegExp` struct ref. */
  regexpLocal: number;
  /** Local holding the flattened subject string. */
  inputLocal: number;
  /** Local holding the populated caps array (length `2 * nGroups`). */
  capsLocal: number;
  /** The `$NativeRegExp` struct type index (== `ctx.structMap` entry). */
  structTypeIdx: number;
}

/**
 * Lower a `$NativeRegExp` receiver expression onto the stack and into a local.
 *
 * Compiles `regexpExpr`, narrowing an externref (backend-created RegExp value)
 * back to the concrete `$NativeRegExp` struct, then stores it in a fresh local.
 * Returns the local index and struct type index, or `null` after reporting a
 * narrowed refusal when the value was not created by this backend.
 */
function loadStandaloneRegExpStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpExpr: ts.Expression,
): { regexpLocal: number; structTypeIdx: number } | null {
  const regexpType = compileExpression(ctx, fctx, regexpExpr);
  let storedRegexpType = regexpType;
  if (regexpType?.kind === "externref") {
    if (!isKnownBackendCreatedRegExpReceiver(ctx, regexpExpr)) {
      reportStandaloneRegExpUnsupported(ctx, regexpExpr, "RegExp values not created by this standalone backend");
      return null;
    }
    const typeIdx = ensureStandaloneRegExpStruct(ctx);
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx } as Instr);
    storedRegexpType = { kind: "ref", typeIdx };
  }
  if (!isStandaloneRegExpValue(ctx, storedRegexpType)) {
    reportStandaloneRegExpUnsupported(ctx, regexpExpr, "RegExp values not created by this standalone backend");
    return null;
  }

  const reStructType: ValType = { kind: "ref", typeIdx: storedRegexpType.typeIdx };
  const regexpLocal = allocLocal(fctx, `__re_${fctx.locals.length}`, reStructType);
  if (storedRegexpType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "local.set", index: regexpLocal });
  return { regexpLocal, structTypeIdx: storedRegexpType.typeIdx };
}

/**
 * (#2175 S1) Brand-recovery prologue for a *dynamic* (externref) RegExp `this`.
 *
 * The reflective forms — `RegExp.prototype.test.call(re, s)`,
 * `re[Symbol.match](s)`, the `flags`-getter via a property descriptor — receive
 * the receiver as an opaque externref through a closure call, so there is no
 * receiver *expression* to brand-narrow at a syntactic site. This helper does
 * the identical externref→`$NativeRegExp` narrowing that the static fast path's
 * `loadStandaloneRegExpStruct` performs on an expression (the
 * `any.convert_extern` + `ref.test` + `ref.cast` body), but driven from a local
 * holding the externref `this`. On a non-RegExp `this` it throws a **catchable
 * `TypeError`** (§22.2.6.4.1 RegExpHasFlag step 2) via the shared exception-tag
 * path — never a raw `ref.cast` trap (mirrors #2100 M2).
 *
 * Leaves nothing on the stack; returns the local holding the cast struct and the
 * struct type index for the caller's field reads / engine calls. Returns `null`
 * only if the standalone RegExp struct can't be registered (defensive — it
 * always can under standalone).
 */
export function recoverRegExpStructFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisExternLocal: number,
): { regexpLocal: number; structTypeIdx: number } | null {
  const structTypeIdx = ensureStandaloneRegExpStruct(ctx);
  const anyLocal = allocLocal(fctx, `__re_this_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  // any.convert_extern(this) → anyref, kept in a local for the ref.test guard.
  fctx.body.push({ op: "local.get", index: thisExternLocal });
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "local.set", index: anyLocal });

  // Brand check: ref.test $NativeRegExp. On failure throw a catchable TypeError
  // (the wrong-`this` brand-check the 31 reflective brand-check tests gate on).
  fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
  fctx.body.push({ op: "i32.eqz" } as Instr);
  const throwBody: Instr[] = [];
  emitBrandCheckTypeError(ctx, throwBody, "Method called on incompatible receiver (RegExp brand check failed)");
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: [] } as Instr);

  // ref.cast to the concrete struct and stash in a typed local.
  const reStructType: ValType = { kind: "ref", typeIdx: structTypeIdx };
  const regexpLocal = allocLocal(fctx, `__re_recovered_${fctx.locals.length}`, reStructType);
  fctx.body.push({ op: "local.get", index: anyLocal } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: regexpLocal });
  return { regexpLocal, structTypeIdx };
}

/**
 * Emit the shared `__regex_search(...)` call sequence used by `.test`,
 * `String.prototype.search`, and (later) the capture-array methods.
 *
 * `regexpExpr` is the `$NativeRegExp` source; `inputExpr` is the subject string.
 * The search always starts at index 0 (`search`/`test` ignore `lastIndex` for
 * the non-global/non-sticky case; sticky-at-0 is honored). On return the i32
 * match flag (1/0) is left on the stack and the populated caps array is
 * available via the returned `capsLocal`. Returns `null` after reporting a
 * narrowed refusal if the regex value was not backend-created.
 */
function emitRegexSearchCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpExpr: ts.Expression,
  inputExpr: ts.Expression,
  options?: {
    /**
     * §22.2.7.2 RegExpBuiltinExec [[LastIndex]] semantics for g/y regexps
     * (#1913): start the scan at ToLength(lastIndex) (i32.trunc_sat maps
     * NaN→0 and the search loop rejects starts past the subject, matching
     * the lastIndex>length null result), then on return set lastIndex to
     * the match end (or 0 on failure). Only passed when the flags are
     * STATICALLY known to include g or y — non-g/y exec neither reads nor
     * writes lastIndex.
     */
    gyLastIndex?: boolean;
  },
): RegexSearchEmission | null {
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) {
    reportError(ctx, regexpExpr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
    return null;
  }
  const searchIdx = ensureRegexSearch(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // --- the compiled $NativeRegExp struct ---
  const loaded = loadStandaloneRegExpStruct(ctx, fctx, regexpExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  // --- input: flatten the subject string ---
  const inputType = compileExpression(ctx, fctx, inputExpr, nativeStringType(ctx));
  if (inputType?.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const inputLocal = allocLocal(fctx, `__re_input_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: strTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: inputLocal });

  // caps = array.new_default(2 * nGroups + nScratch) — scratch slots back the
  // PROGRESS empty-loop guards (#1959); they ride along in the caps array.
  const capsLocal = allocLocal(fctx, `__re_caps_${fctx.locals.length}`, { kind: "ref", typeIdx: i32Arr });
  pushNSlots(fctx, regexpLocal, structTypeIdx);
  fctx.body.push({ op: "array.new_default", typeIdx: i32Arr } as Instr);
  fctx.body.push({ op: "local.set", index: capsLocal });

  // sticky = (flags & RE_FLAG_Y) != 0
  const stickyLocal = allocLocal(fctx, `__re_sticky_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS });
  fctx.body.push({ op: "i32.const", value: RE_FLAG_Y });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });
  fctx.body.push({ op: "local.set", index: stickyLocal });

  // __regex_search(prog, classTable, 2*nGroups, inData, inOff, inLen, start, sticky, caps)
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
  // nSlots = 2 * nGroups + nScratch
  pushNSlots(fctx, regexpLocal, structTypeIdx);
  // input data / off / len
  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
  fctx.body.push({ op: "local.get", index: inputLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
  // startIdx: 0 for the lastIndex-free methods (search; non-g/y exec/test/
  // match), or ToLength(lastIndex) for g/y exec semantics (#1913).
  if (options?.gyLastIndex) {
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX });
    // trunc_sat: NaN→0 (= ToLength(NaN)); huge values saturate and the search
    // loop's `start > slen` check yields the spec's no-match result. Negative
    // values clamp to 0 inside __regex_search, matching ToLength.
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: stickyLocal });
  fctx.body.push({ op: "local.get", index: capsLocal });
  fctx.body.push({ op: "call", funcIdx: searchIdx });
  if (options?.gyLastIndex) {
    // matched on stack → lastIndex = matched ? caps[1] : 0 (§22.2.7.2 steps
    // 9.e / 15), then restore the match flag for the caller.
    const matchedTmp = allocLocal(fctx, `__re_matched_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: matchedTmp });
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "local.get", index: matchedTmp });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: capsLocal },
        { op: "i32.const", value: 1 },
        { op: "array.get", typeIdx: i32Arr },
        { op: "f64.convert_i32_s" },
      ],
      else: [{ op: "f64.const", value: 0 }],
    } as Instr);
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX } as Instr);
    fctx.body.push({ op: "local.get", index: matchedTmp });
  }
  return { regexpLocal, inputLocal, capsLocal, structTypeIdx };
}

/** True when `argExpr`'s static type is string-like (or a String wrapper). */
function isStringLikeArg(ctx: CodegenContext, argExpr: ts.Expression): boolean {
  const argType = ctx.checker.getTypeAtLocation(argExpr);
  return (
    (argType.flags & ts.TypeFlags.StringLike) !== 0 ||
    ((argType.flags & ts.TypeFlags.Object) !== 0 && argType.getSymbol()?.getName() === "String")
  );
}

export function tryCompileStandaloneRegExpTest(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (!ctx.standalone || propAccess.name.text !== "test") return undefined;

  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (!isGlobalRegExpType(receiverType)) return undefined;

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "RegExp.prototype.test without an enabled standalone engine");
    return null;
  }
  if (expr.arguments.length !== 1) {
    reportStandaloneRegExpUnsupported(ctx, expr, "RegExp.prototype.test arities other than one string argument");
    return null;
  }

  if (!isStringLikeArg(ctx, expr.arguments[0]!)) {
    reportStandaloneRegExpUnsupported(ctx, expr.arguments[0]!, "RegExp.prototype.test argument coercion");
    return null;
  }

  // __regex_search leaves the i32 match flag (1/0) on the stack — exactly the
  // boolean `.test` returns; the caps array is discarded. `.test` is
  // RegExpExec (§22.2.6.17), so g/y receivers read AND advance [[LastIndex]]
  // (#1913) — applied only when the flags are statically recoverable; the
  // legacy start-at-0 behaviour is kept for backend receivers whose flags
  // are not (provenance makes that case rare).
  const testFlags = staticRegExpFlags(ctx, propAccess.expression);
  const emitted = emitRegexSearchCall(ctx, fctx, propAccess.expression, expr.arguments[0]!, {
    gyLastIndex: testFlags !== null && flagsHaveGlobalOrSticky(testFlags),
  });
  if (emitted === null) return null;
  return { kind: "i32" };
}

function flagsHaveGlobalOrSticky(flags: string): boolean {
  return flags.includes("g") || flags.includes("y");
}

/**
 * Push one capture-slot's value (`caps[2*idx]` / `caps[2*idx+1]`) onto the
 * stack as an **externref** (#2588): the substring of the subject, or a null
 * externref (≙ `undefined`) when the slot is unmatched (`caps[2*idx] < 0`).
 * `subjectLocal` is the flattened `$NativeString`, `capsLocal` the i32 caps.
 */
function pushCaptureValueExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  idx: number,
  subjectLocal: number,
  capsLocal: number,
  strTypeIdx: number,
  i32Arr: number,
): void {
  const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
  const nstr = nativeStringType(ctx);
  // caps[2*idx] < 0 ? undefined : substring(subject, caps[2*idx], caps[2*idx+1])
  fctx.body.push({ op: "local.get", index: capsLocal });
  fctx.body.push({ op: "i32.const", value: 2 * idx });
  fctx.body.push({ op: "array.get", typeIdx: i32Arr });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [{ op: "ref.null.extern" } as Instr],
    else: [
      { op: "local.get", index: subjectLocal } as Instr,
      { op: "local.get", index: capsLocal } as Instr,
      { op: "i32.const", value: 2 * idx } as Instr,
      { op: "array.get", typeIdx: i32Arr } as Instr,
      { op: "local.get", index: capsLocal } as Instr,
      { op: "i32.const", value: 2 * idx + 1 } as Instr,
      { op: "array.get", typeIdx: i32Arr } as Instr,
      { op: "call", funcIdx: substringIdx } as Instr,
      // native string ref → externref
      ...coercedNstrToExternref(ctx, fctx, nstr),
    ],
  } as Instr);
}

/** Produce the instrs that coerce a native-string ref already on the stack to
 *  externref. Uses `coerceType` against a scratch (it appends to fctx.body), so
 *  we splice via a temporary body swap to keep the if-arm self-contained. */
function coercedNstrToExternref(ctx: CodegenContext, fctx: FunctionContext, nstr: ValType): Instr[] {
  const saved = fctx.body;
  const buf: Instr[] = [];
  fctx.body = buf;
  coerceType(ctx, fctx, nstr, { kind: "externref" });
  fctx.body = saved;
  return buf;
}

/**
 * #2588 — build the named-groups result object (`m.groups`) and leave it on the
 * stack as an **externref** (`$Object`), or a null externref when `groupNames`
 * is empty. The object is built INLINE via `__new_plain_object` +
 * `__extern_set` (the same path object literals use), so `m.groups.<name>`
 * reads flow through the existing standalone `$Object` property read (no new
 * dispatch).
 */
function emitRegexGroupsObjectExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  groupNames: ReadonlyMap<string, number>,
  subjectLocal: number,
  capsLocal: number,
  strTypeIdx: number,
  i32Arr: number,
): void {
  if (groupNames.size === 0) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined || setIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }
  const objLocal = allocLocal(fctx, `__re_groups_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  fctx.body.push({ op: "local.set", index: objLocal });
  // Insert in source (capture-index) order so OrdinaryOwnPropertyKeys mirrors
  // the spec's named-group declaration order.
  const ordered = [...groupNames.entries()].sort((a, b) => a[1] - b[1]);
  for (const [name, idx] of ordered) {
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, name);
    for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
    pushCaptureValueExternref(ctx, fctx, idx, subjectLocal, capsLocal, strTypeIdx, i32Arr);
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }
  fctx.body.push({ op: "local.get", index: objLocal });
}

/**
 * #2589 — build the `d`-flag match-indices array (`m.indices`) and leave it on
 * the stack as an **externref** (`$ObjVec`), or a null externref when `hasD` is
 * false. Each element is `[start, end]` (a 2-element number array) for a matched
 * group or `undefined` (null) for an unmatched one. Built INLINE with
 * `__objvec_new` / `__objvec_push` so `m.indices[i]` and `m.indices[i][j]` are
 * native `$ObjVec` index reads (no `env::__extern_get`).
 */
function emitRegexIndicesArrayExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hasD: boolean,
  nGroups: number,
  capsLocal: number,
  i32Arr: number,
): void {
  if (!hasD) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const outerLocal = allocLocal(fctx, `__re_indices_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: newIdx });
  fctx.body.push({ op: "local.set", index: outerLocal });
  for (let g = 0; g < nGroups; g++) {
    // __objvec_push(outer, caps[2*g] < 0 ? undefined : [caps[2*g], caps[2*g+1]])
    fctx.body.push({ op: "local.get", index: outerLocal });
    fctx.body.push({ op: "local.get", index: capsLocal });
    fctx.body.push({ op: "i32.const", value: 2 * g });
    fctx.body.push({ op: "array.get", typeIdx: i32Arr });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "ref.null.extern" } as Instr],
      else: [...buildIndexPairExternref(ctx, fctx, g, capsLocal, i32Arr, newIdx, pushIdx)],
    } as Instr);
    fctx.body.push({ op: "call", funcIdx: pushIdx });
  }
  fctx.body.push({ op: "local.get", index: outerLocal });
}

/** Build the `[start, end]` 2-element number array (externref) for group `g`. */
function buildIndexPairExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  g: number,
  capsLocal: number,
  i32Arr: number,
  newIdx: number,
  pushIdx: number,
): Instr[] {
  const f64 = { kind: "f64" } as ValType;
  const boxF64 = (slot: number): Instr[] => {
    const buf: Instr[] = [
      { op: "local.get", index: capsLocal },
      { op: "i32.const", value: slot },
      { op: "array.get", typeIdx: i32Arr },
      { op: "f64.convert_i32_s" },
    ];
    const saved = fctx.body;
    const tail: Instr[] = [];
    fctx.body = tail;
    coerceType(ctx, fctx, f64, { kind: "externref" }); // f64 → __box_number
    fctx.body = saved;
    return [...buf, ...tail];
  };
  const pairLocal = allocLocal(fctx, `__re_pair_${fctx.locals.length}`, { kind: "externref" });
  return [
    { op: "call", funcIdx: newIdx },
    { op: "local.set", index: pairLocal },
    // push start
    { op: "local.get", index: pairLocal },
    ...boxF64(2 * g),
    { op: "call", funcIdx: pushIdx },
    // push end
    { op: "local.get", index: pairLocal },
    ...boxF64(2 * g + 1),
    { op: "call", funcIdx: pushIdx },
    { op: "local.get", index: pairLocal },
  ];
}

/**
 * Emit a call to `__regex_exec_array`, returning a nullable native string vec:
 * `null` on no match, otherwise `[fullMatch, cap1, cap2, ...]` with unmatched
 * captures represented as null native strings (the compiler's `undefined` for
 * nullable native string slots).
 */
function emitRegexExecArrayCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpExpr: ts.Expression,
  inputExpr: ts.Expression,
  options?: { gyLastIndex?: boolean },
): ValType | null {
  const emitted = emitRegexSearchCall(ctx, fctx, regexpExpr, inputExpr, options);
  if (emitted === null) return null;

  const captureArrayIdx = ensureRegexCaptureArray(ctx);
  // The result is the match-vec SUBTYPE of the nstr vec (#1914): same
  // {length, data} prefix every vec consumer reads, plus index/input fields
  // for the spec result shape.
  const nstrVecTypeIdx = ensureRegexMatchVecType(ctx);

  // #2588/#2589 — resolve the STATIC pattern to recover the named-group map and
  // the `d` flag. Both are compile-time-known for a backend-created RegExp, so
  // the `groups` object and `d`-flag `indices` array can be materialised from
  // the same `caps` slots `__regex_capture_array` consumes. When the static
  // pattern can't be recovered (rare non-literal provenance) both stay null.
  const i32Arr = regexI32ArrayType(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;
  let groupNames: ReadonlyMap<string, number> = new Map();
  let hasD = false;
  let nGroups = 0;
  const meta = staticRegExpGroupMeta(ctx, regexpExpr);
  if (meta !== null) {
    groupNames = meta.groupNames;
    hasD = (meta.flags & RE_FLAG_D) !== 0;
    nGroups = meta.nGroups;
  }
  const needsExtras = groupNames.size > 0 || hasD;

  // Build the matched-branch body into a temporary buffer so the groups/indices
  // builders (which allocate locals + emit `if`s) stay scoped to the then-arm.
  const savedBody = fctx.body;
  const thenBody: Instr[] = [];
  fctx.body = thenBody;

  let groupsLocal = -1;
  let indicesLocal = -1;
  if (needsExtras) {
    groupsLocal = allocLocal(fctx, `__re_groups_x_${fctx.locals.length}`, { kind: "externref" });
    indicesLocal = allocLocal(fctx, `__re_indices_x_${fctx.locals.length}`, { kind: "externref" });
    emitRegexGroupsObjectExternref(ctx, fctx, groupNames, emitted.inputLocal, emitted.capsLocal, strTypeIdx, i32Arr);
    fctx.body.push({ op: "local.set", index: groupsLocal });
    emitRegexIndicesArrayExternref(ctx, fctx, hasD, nGroups, emitted.capsLocal, i32Arr);
    fctx.body.push({ op: "local.set", index: indicesLocal });
  }

  fctx.body.push({ op: "local.get", index: emitted.regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: emitted.structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "local.get", index: emitted.inputLocal });
  fctx.body.push({ op: "local.get", index: emitted.capsLocal });
  if (needsExtras) {
    fctx.body.push({ op: "local.get", index: groupsLocal });
    fctx.body.push({ op: "local.get", index: indicesLocal });
  } else {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: captureArrayIdx });

  fctx.body = savedBody;
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: nstrVecTypeIdx } },
    then: thenBody,
    else: [{ op: "ref.null", typeIdx: nstrVecTypeIdx } as Instr],
  } as Instr);
  return { kind: "ref_null", typeIdx: nstrVecTypeIdx };
}

/**
 * `RegExp.prototype.exec(str)` in standalone mode (#1539 Phase 2b).
 *
 * This slice materializes the capture array for backend-created static RegExp
 * values with non-global/non-sticky flags. `g`/`y` require observable
 * `lastIndex` mutation and stay refused until the dedicated lastIndex slice.
 */
export function tryCompileStandaloneRegExpExec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (!ctx.standalone || propAccess.name.text !== "exec") return undefined;

  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (!isGlobalRegExpType(receiverType)) return undefined;

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "RegExp.prototype.exec without an enabled standalone engine");
    return null;
  }
  if (expr.arguments.length !== 1) {
    reportStandaloneRegExpUnsupported(ctx, expr, "RegExp.prototype.exec arities other than one string argument");
    return null;
  }
  if (!isStringLikeArg(ctx, expr.arguments[0]!)) {
    reportStandaloneRegExpUnsupported(ctx, expr.arguments[0]!, "RegExp.prototype.exec argument coercion");
    return null;
  }

  const flags = staticRegExpFlags(ctx, propAccess.expression);
  if (flags === null) {
    reportStandaloneRegExpUnsupported(ctx, propAccess.expression, "RegExp.prototype.exec with dynamic flags");
    return null;
  }

  // §22.2.7.2 — g/y exec starts at [[LastIndex]] and writes back the match
  // end (or 0 on failure); non-g/y exec ignores lastIndex entirely (#1913).
  return emitRegexExecArrayCall(ctx, fctx, propAccess.expression, expr.arguments[0]!, {
    gyLastIndex: flagsHaveGlobalOrSticky(flags),
  });
}

/**
 * `String.prototype.search(regexp)` in standalone mode (#1539 Phase 2b).
 *
 * Per ECMA-262 §22.1.3.13 + §22.2.6.13 (`RegExp.prototype[@@search]`): search
 * sets `lastIndex` to 0, runs `RegExpExec`, then restores `lastIndex`, returning
 * the match's `.index` or `-1` on no match. It is unaffected by the `g` flag and
 * never advances. Here the subject (string) is the receiver and the RegExp is
 * the argument: `"abc".search(/b/)`. The argument must be a backend-created
 * static RegExp; a string argument (which the spec coerces to `new RegExp(arg)`)
 * stays a narrowed refusal in standalone for this slice.
 *
 * Returns f64 (the index, or -1). `caps[0]` holds the whole-match start.
 * Never returns `VOID_RESULT`, so the type stays `ValType | null | undefined`
 * to match the `compileNativeStringMethodCall` caller contract.
 */
export function tryCompileStandaloneStringSearch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || propAccess.name.text !== "search") return undefined;

  // Receiver must be string-like; argument must be a static RegExp value.
  if (!isStringLikeArg(ctx, propAccess.expression)) return undefined;
  if (expr.arguments.length !== 1) return undefined;
  const argExpr = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(argExpr);
  if (!isGlobalRegExpType(argType) && !isKnownBackendCreatedRegExpReceiver(ctx, argExpr)) {
    // Not a RegExp argument — let the generic string-method path handle the
    // string-coercion case (it refuses in standalone, citing #1474).
    return undefined;
  }

  // String-method operand order: subject = receiver, regex = arg.
  return emitStandaloneRegExpSearchCore(ctx, fctx, expr, propAccess.expression, argExpr);
}

/**
 * Operand-explicit core for `@@search` semantics (§22.2.6.13): returns the
 * match index (f64) or -1. Shared by `String.prototype.search` (subject is the
 * receiver) and the `re[Symbol.search](str)` protocol form (subject is the
 * argument) — only the operand wiring differs.
 */
function emitStandaloneRegExpSearchCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  regexExpr: ts.Expression,
): ValType | null {
  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "String.prototype.search without an enabled standalone engine");
    return null;
  }

  const i32Arr = regexI32ArrayType(ctx);

  // emit __regex_search(...) — leaves the i32 match flag on the stack.
  const emitted = emitRegexSearchCall(ctx, fctx, regexExpr, subjExpr);
  if (emitted === null) return null;

  // matched ? f64(caps[0]) : -1
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: [
      { op: "local.get", index: emitted.capsLocal },
      { op: "i32.const", value: 0 },
      { op: "array.get", typeIdx: i32Arr },
      { op: "f64.convert_i32_s" },
    ],
    else: [{ op: "f64.const", value: -1 }],
  } as Instr);
  return { kind: "f64" };
}

/**
 * Recover the flags string of a static / backend-created RegExp expression
 * (`/…/flags`, `new RegExp(p, "flags")`, or a `const re = /…/flags` binding).
 * Returns `null` when the flags can't be statically determined.
 */
function staticRegExpFlags(ctx: CodegenContext, expr: ts.Expression): string | null {
  return staticRegExpPatternFlags(ctx, expr)?.flags ?? null;
}

/**
 * `String.prototype.match(regexp)` in standalone mode (#1539 Phase 2b).
 *
 * Non-global static RegExp arguments share the same result shape as `.exec`.
 * Global `match` returns an all-matches array and sticky/global lastIndex
 * details are intentionally left to the next capture-array slice.
 */
export function tryCompileStandaloneStringMatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || propAccess.name.text !== "match") return undefined;

  if (!isStringLikeArg(ctx, propAccess.expression)) return undefined;
  if (expr.arguments.length !== 1) return undefined;
  const argExpr = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(argExpr);
  if (!isGlobalRegExpType(argType) && !isKnownBackendCreatedRegExpReceiver(ctx, argExpr)) {
    return undefined;
  }

  // String-method operand order: subject = receiver, regex = arg.
  return emitStandaloneRegExpMatchCore(ctx, fctx, expr, propAccess.expression, argExpr);
}

/**
 * Operand-explicit core for `@@match` semantics (§22.2.6.8). Shared by
 * `String.prototype.match` (subject is the receiver, regex is the argument) and
 * the `re[Symbol.match](str)` protocol form (regex is the receiver, subject is
 * the argument). Global match collects every [0] substring into a match-vec;
 * non-global returns the single capture array (`.exec`-shaped).
 */
function emitStandaloneRegExpMatchCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  regexExpr: ts.Expression,
): ValType | null {
  const flags = staticRegExpFlags(ctx, regexExpr);
  if (flags === null) {
    reportStandaloneRegExpUnsupported(ctx, regexExpr, "String.prototype.match with dynamic RegExp flags");
    return null;
  }

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "String.prototype.match without an enabled standalone engine");
    return null;
  }

  // §22.2.6.8 step 6 — GLOBAL match collects every [0] substring (#1913):
  // SetLastIndex(0), loop RegExpExec with AdvanceStringIndex, lastIndex ends
  // at 0. The eager walk lives in __regex_match_all; lastIndex is reset on
  // the struct afterwards (net spec effect of the loop).
  if (flags.includes("g")) {
    ensureNativeStringHelpers(ctx);
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
    if (flattenIdx === undefined) {
      reportError(ctx, expr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
      return null;
    }
    const matchAllIdx = ensureRegexMatchAll(ctx);
    const matchVecTypeIdx = ensureRegexMatchVecType(ctx);
    const strTypeIdx = ctx.nativeStrTypeIdx;

    const loaded = loadStandaloneRegExpStruct(ctx, fctx, regexExpr);
    if (loaded === null) return null;
    const { regexpLocal, structTypeIdx } = loaded;

    const subjType = compileExpression(ctx, fctx, subjExpr, nativeStringType(ctx));
    if (subjType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
    fctx.body.push({ op: "call", funcIdx: flattenIdx });
    const subjLocal = allocLocal(fctx, `__re_gm_subj_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
    fctx.body.push({ op: "local.set", index: subjLocal });

    // __regex_match_all(prog, classTable, nGroups, subjData, subjOff, subjLen, subject)
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
    fctx.body.push({ op: "local.get", index: subjLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
    fctx.body.push({ op: "local.get", index: subjLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
    fctx.body.push({ op: "local.get", index: subjLocal });
    fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
    fctx.body.push({ op: "local.get", index: subjLocal });
    // nScratch (#1959) — PROGRESS empty-loop guard slots, last arg.
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NSCRATCH });
    fctx.body.push({ op: "call", funcIdx: matchAllIdx });
    // lastIndex = 0 (net effect of the spec's exec loop on a global regex).
    fctx.body.push({ op: "local.get", index: regexpLocal });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX } as Instr);
    return { kind: "ref_null", typeIdx: matchVecTypeIdx };
  }

  // Non-global match = RegExpExec (§22.2.6.8 step 5) — sticky regexps read
  // and advance lastIndex through the shared exec path.
  return emitRegexExecArrayCall(ctx, fctx, regexExpr, subjExpr, {
    gyLastIndex: flagsHaveGlobalOrSticky(flags),
  });
}

/**
 * `String.prototype.matchAll(/re/g)` in standalone mode (#2161).
 *
 * §22.1.3.13 / §22.2.6.9: returns a RegExpStringIterator yielding the **full
 * match array** (with capture groups, `.index`, `.input`) for every match. The
 * native engine already builds per-match arrays via `__regex_capture_array`
 * (used by `exec` / non-global `match`); `__regex_match_all_arrays` drives the
 * eager AdvanceStringIndex loop collecting those capture-arrays into a vec. The
 * vec is iterable by the native-vec for-of / spread consumers (#2169), so
 * `for (const m of s.matchAll(re))` and `[...s.matchAll(re)]` both work without
 * a JS host.
 *
 * Narrowed slice: requires a static global (`g`) RegExp value. matchAll on a
 * non-global regex is a runtime TypeError (§22.1.3.13 step 4.a) — left to the
 * host/refusal path rather than mis-modelled. String-arg coercion
 * (`s.matchAll("x")` → `new RegExp("x","g")`) and dynamic flags fall through.
 */
export function tryCompileStandaloneStringMatchAll(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || propAccess.name.text !== "matchAll") return undefined;

  if (!isStringLikeArg(ctx, propAccess.expression)) return undefined;
  if (expr.arguments.length !== 1) return undefined;
  const argExpr = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(argExpr);
  if (!isGlobalRegExpType(argType) && !isKnownBackendCreatedRegExpReceiver(ctx, argExpr)) {
    return undefined; // string-arg / non-RegExp form → generic / refusal path
  }

  // String-method operand order: subject = receiver, regex = arg.
  return emitStandaloneRegExpMatchAllCore(ctx, fctx, expr, propAccess.expression, argExpr);
}

/**
 * Operand-explicit core for `@@matchAll` semantics (§22.2.6.9). Shared by
 * `String.prototype.matchAll` and the `re[Symbol.matchAll](str)` protocol form.
 * Requires a static global (`g`) RegExp — non-global matchAll is a runtime
 * TypeError, left to the refusal path. Returns an iterable vec-of-capture-arrays
 * (`undefined` when the form falls through, e.g. non-global, dynamic flags).
 */
function emitStandaloneRegExpMatchAllCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  regexExpr: ts.Expression,
): ValType | null | undefined {
  const flags = staticRegExpFlags(ctx, regexExpr);
  if (flags === null) {
    reportStandaloneRegExpUnsupported(ctx, regexExpr, "String.prototype.matchAll with dynamic RegExp flags");
    return null;
  }
  // matchAll REQUIRES a global regex (non-global throws TypeError); only the
  // well-formed `/…/g` form is handled here — others fall through to refusal.
  if (!flags.includes("g")) return undefined;

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, "String.prototype.matchAll without an enabled standalone engine");
    return null;
  }

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) {
    reportError(ctx, expr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
    return null;
  }
  const matchAllArraysIdx = ensureRegexMatchAllArrays(ctx);
  const outerVecTypeIdx = ensureRegexMatchAllVecType(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, regexExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  const subjType = compileExpression(ctx, fctx, subjExpr, nativeStringType(ctx));
  if (subjType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const subjLocal = allocLocal(fctx, `__re_gma_subj_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  fctx.body.push({ op: "local.set", index: subjLocal });

  // __regex_match_all_arrays(prog, classTable, nGroups, subjData, subjOff, subjLen, subject, nScratch)
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NSCRATCH });
  fctx.body.push({ op: "call", funcIdx: matchAllArraysIdx });
  // matchAll spawns a fresh iterator; the regex's own lastIndex is unaffected
  // by the eager walk (the iterator holds its own cursor). Reset to 0 to match
  // the global-match net effect and keep a subsequent reuse well-defined.
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX } as Instr);
  return { kind: "ref", typeIdx: outerVecTypeIdx };
}

/**
 * `String.prototype.replace(re, "str")` / `String.prototype.replaceAll(re,
 * "str")` in standalone mode (#1539 Phase 2c) — **literal replacement string
 * only**.
 *
 * Per ECMA-262 §22.1.3.19 / §22.2.6.11 (`RegExp.prototype[@@replace]`): walk
 * the subject, replacing each match (all matches when the regex has the `g`
 * flag or the method is `replaceAll`; otherwise just the first) with the
 * replacement string, returning the rebuilt string. The result is a
 * `$NativeString` — no array boundary, no host import.
 *
 * Refused (left to the narrowed gate): `$n`/`$&`/`$\``/`$'`/`$<name>`
 * substitution patterns and function replacers (Phase 2c follow-up — they need
 * capture-group materialization / closure dispatch), and `replaceAll` with a
 * non-global regex (which is a runtime `TypeError` per spec; let the host path
 * handle that diagnostic rather than mis-modelling it here).
 */
export function tryCompileStandaloneStringReplace(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone) return undefined;
  const method = propAccess.name.text;
  if (method !== "replace" && method !== "replaceAll") return undefined;

  // Receiver string-like; args = (regexp, replacement).
  if (!isStringLikeArg(ctx, propAccess.expression)) return undefined;
  if (expr.arguments.length !== 2) return undefined;
  const reExpr = expr.arguments[0]!;
  const replExpr = expr.arguments[1]!;

  const reType = ctx.checker.getTypeAtLocation(reExpr);
  if (!isGlobalRegExpType(reType) && !isKnownBackendCreatedRegExpReceiver(ctx, reExpr)) {
    return undefined; // not a RegExp arg → generic string path
  }

  const flags = staticRegExpFlags(ctx, reExpr);
  if (flags === null) return undefined;
  const reHasGlobal = flags.includes("g");
  // `replaceAll` requires a global regex (spec §22.1.3.20 step 4 throws
  // TypeError otherwise). Leave that error to the host path; only handle the
  // well-formed `replaceAll(/…/g, …)` here.
  if (method === "replaceAll" && !reHasGlobal) return undefined;
  // For `replace`, global is honored (replace-all when `g`, first-only else).
  const globalReplace = method === "replaceAll" || reHasGlobal;

  // String-method operand order: subject = receiver, regex = arg[0].
  return emitStandaloneRegExpReplaceCore(
    ctx,
    fctx,
    expr,
    propAccess.expression,
    reExpr,
    replExpr,
    globalReplace,
    method,
  );
}

/**
 * Operand-explicit core for `@@replace` semantics (§22.2.6.11). Shared by
 * `String.prototype.replace`/`replaceAll` (subject is the receiver, regex is
 * arg[0]) and the `re[Symbol.replace](str, replacement)` protocol form (regex is
 * the receiver, subject is arg[0]). `globalReplace` is resolved by the caller
 * from the method (`replaceAll`) and/or the regex `g` flag. `diag` names the
 * surface (`replace`/`replaceAll`/`@@replace`) for refusal messages.
 *
 * Returns a `$NativeString` (no array boundary, no host import). A non-string
 * replacement (function replacer) stays a narrowed refusal.
 */
function emitStandaloneRegExpReplaceCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  reExpr: ts.Expression,
  replExpr: ts.Expression,
  globalReplace: boolean,
  diag: string,
): ValType | null {
  // Replacement must be a STRING (any string expression — `$`-substitution
  // patterns are expanded at runtime by __regex_get_substitution per
  // §22.2.6.11, #1913). Function replacers need closure dispatch with
  // capture-arg marshalling and stay a narrowed refusal.
  if (!isStringLikeArg(ctx, replExpr)) {
    reportStandaloneRegExpUnsupported(
      ctx,
      replExpr,
      `${diag} with a function (or non-string) replacer (#1913 follow-up)`,
    );
    return null;
  }

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, `${diag} without an enabled standalone engine`);
    return null;
  }

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) {
    reportError(ctx, expr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
    return null;
  }
  const replaceIdx = ensureRegexReplace(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // --- the compiled $NativeRegExp struct ---
  const loaded = loadStandaloneRegExpStruct(ctx, fctx, reExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  // --- subject: flatten the subject string ---
  const subjType = compileExpression(ctx, fctx, subjExpr, nativeStringType(ctx));
  if (subjType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const subjLocal = allocLocal(fctx, `__re_subj_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  fctx.body.push({ op: "local.set", index: subjLocal });

  // --- replacement: flatten ---
  const replType = compileExpression(ctx, fctx, replExpr, nativeStringType(ctx));
  if (replType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const replLocal = allocLocal(fctx, `__re_repl_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  fctx.body.push({ op: "local.set", index: replLocal });

  // __regex_replace(prog, classTable, nGroups, subjData, subjOff, subjLen, subject, replacement, global)
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "local.get", index: replLocal });
  fctx.body.push({ op: "i32.const", value: globalReplace ? 1 : 0 });
  // nScratch (#1959) — PROGRESS empty-loop guard slots.
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NSCRATCH });
  // #2588 — names table for `$<name>` substitution: [count, (idx,len,ch...)*].
  // Empty (count=0) when the pattern has no named groups → `$<…>` stays literal.
  for (const instr of buildRegexNamesTableInstrs(ctx, reExpr)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: replaceIdx });
  return nativeStringType(ctx);
}

/**
 * Build the `$<name>` names-table i32 array (#2588) for a static RegExp:
 * `[count, (capIdx, nameLen, ch0, ch1, …)*]`. Empty (`[0]` → count 0) when the
 * pattern has no named groups or its static form can't be recovered.
 */
function buildRegexNamesTableInstrs(ctx: CodegenContext, reExpr: ts.Expression): Instr[] {
  const values: number[] = [];
  const meta = staticRegExpGroupMeta(ctx, reExpr);
  const entries: Array<[string, number]> = meta !== null ? [...meta.groupNames.entries()] : [];
  values.push(entries.length); // count
  for (const [name, idx] of entries) {
    values.push(idx); // 1-based capture index
    values.push(name.length); // name length (UTF-16 code units)
    for (let k = 0; k < name.length; k++) values.push(name.charCodeAt(k));
  }
  return i32ArrayLiteralInstrs(ctx, values);
}

/**
 * `String.prototype.split(re)` in standalone mode (#1539 Phase 2c) —
 * non-capturing, non-nullable static RegExp separator only.
 *
 * Capturing-group split has extra result interleaving semantics, and nullable
 * separators need the full SplitMatch/AdvanceStringIndex edge-case handling.
 * Both stay narrowed refusals until the capture-array/string-method follow-up.
 */
export function tryCompileStandaloneStringSplit(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || propAccess.name.text !== "split") return undefined;

  if (!isStringLikeArg(ctx, propAccess.expression)) return undefined;
  if (expr.arguments.length === 0) return undefined;
  const reExpr = expr.arguments[0]!;
  const reType = ctx.checker.getTypeAtLocation(reExpr);
  if (!isGlobalRegExpType(reType) && !isKnownBackendCreatedRegExpReceiver(ctx, reExpr)) {
    return undefined; // not a RegExp arg -> native string split / generic path
  }

  if (expr.arguments.length > 2) {
    reportStandaloneRegExpUnsupported(ctx, expr.arguments[2] ?? expr, "String.prototype.split arities above two");
    return null;
  }
  const limitExpr = expr.arguments[1];

  // String-method operand order: subject = receiver, regex = arg[0].
  return emitStandaloneRegExpSplitCore(
    ctx,
    fctx,
    expr,
    propAccess.expression,
    reExpr,
    limitExpr,
    "String.prototype.split",
  );
}

/**
 * Operand-explicit core for `@@split` semantics (§22.2.6.14). Shared by
 * `String.prototype.split` (subject is the receiver, separator regex is arg[0],
 * limit is arg[1]) and the `re[Symbol.split](str, limit)` protocol form (regex
 * is the receiver, subject is arg[0], limit is arg[1]). `diag` names the surface
 * for refusal messages. Returns a native-string vec.
 */
function emitStandaloneRegExpSplitCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  reExpr: ts.Expression,
  limitExpr: ts.Expression | undefined,
  diag: string,
): ValType | null {
  const meta = staticRegExpPatternFlags(ctx, reExpr);
  if (meta === null) {
    reportStandaloneRegExpUnsupported(ctx, reExpr, `${diag} with dynamic RegExp separators`);
    return null;
  }

  // Compile-time validity gate only — unsupported patterns/flags surface the
  // narrowed refusal here instead of mid-emission.
  if (compileStaticStandaloneRegExp(ctx, meta.pattern, meta.flags, reExpr) === null) return null;

  if (!hasStandaloneRegExpEngine(ctx)) {
    reportStandaloneRegExpUnsupported(ctx, expr, `${diag} without an enabled standalone engine`);
    return null;
  }

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) {
    reportError(ctx, expr, "Codegen error: standalone RegExp backend missing native string helpers (#682).");
    return null;
  }
  const splitIdx = ensureRegexSplit(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, reExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  const subjType = compileExpression(ctx, fctx, subjExpr, nativeStringType(ctx));
  if (subjType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const subjLocal = allocLocal(fctx, `__re_split_subj_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  fctx.body.push({ op: "local.set", index: subjLocal });

  // __regex_split(prog, classTable, nGroups, subjData, subjOff, subjLen, subject)
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS });
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
  fctx.body.push({ op: "local.get", index: subjLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
  fctx.body.push({ op: "local.get", index: subjLocal });
  // lim (§22.2.6.14 step 12: undefined → 2^32-1, else ToUint32(limit)).
  // -1 reinterprets as 0xFFFFFFFF under the helper's unsigned compares.
  // (#2161 B2) A statically-`undefined` limit (`s.split(re, undefined)`)
  // takes the same unbounded branch — compiling it lowered to f64 NaN and
  // ToUint32(NaN) = 0, truncating every such split to `[]`.
  if (limitExpr === undefined || isStaticallyUndefinedExpr(limitExpr)) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    const limType = compileExpression(ctx, fctx, limitExpr, { kind: "f64" });
    if (!limType) return null;
    if (limType.kind === "f64") {
      // ToUint32: trunc-sat then wrap — saturating trunc + i32 reinterpret
      // matches ToUint32 for the integer limits tests exercise.
      fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
    } else if (limType.kind !== "i32") {
      reportStandaloneRegExpUnsupported(ctx, limitExpr, `${diag} with non-numeric limits`);
      return null;
    }
  }
  // nScratch (#1959) — PROGRESS empty-loop guard slots, last arg.
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NSCRATCH });
  fctx.body.push({ op: "call", funcIdx: splitIdx });

  const nstrVecTypeIdx = ctx.vecTypeMap.get(`ref_${ctx.anyStrTypeIdx}`);
  if (nstrVecTypeIdx === undefined) {
    reportError(ctx, expr, "Codegen error: standalone RegExp split missing native string vec type (#1539).");
    return null;
  }
  return { kind: "ref", typeIdx: nstrVecTypeIdx };
}

/**
 * `re[Symbol.match](str)` / `re[Symbol.matchAll](str)` / `re[Symbol.search](str)`
 * — the explicit well-known-symbol protocol forms (§22.2.6) — in standalone
 * mode (#2161).
 *
 * These are the operand-swapped duals of `String.prototype.match/matchAll/
 * search`: the RegExp is the **receiver** and the string is the **argument**.
 * The native engine is operand-order agnostic (the lower-level emitters take an
 * explicit regex expression + subject expression), so each method reuses the
 * exact same core that backs the corresponding String.prototype method — there
 * is no separate engine path and no host import.
 *
 * Gating mirrors the String.prototype path: the receiver must be a static /
 * backend-created RegExp value (so the pattern + flags are known at compile
 * time) and the (first) argument must be string-like. Dynamic-flag receivers
 * and string-coercion arguments return `undefined`, so the caller falls through
 * to the existing `__regex_symbol_call` host import (JS-host mode) or the
 * standalone refusal.
 *
 * `@@replace` / `@@split` carry a second operand (replacement / limit). They
 * reuse the same operand-explicit cores as `String.prototype.replace`/`split`
 * with the operands swapped (regex = receiver, subject = arg[0]).
 *
 * `methodName` is the `@@<id>` sentinel the element-access dispatcher resolved
 * for the computed Symbol key (e.g. `"@@match"`).
 */
export function tryCompileStandaloneRegExpSymbolCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  regexExpr: ts.Expression,
  methodName: string,
): ValType | null | undefined {
  if (!ctx.standalone) return undefined;

  const symbolMethod =
    methodName === "@@match"
      ? "match"
      : methodName === "@@matchAll"
        ? "matchAll"
        : methodName === "@@search"
          ? "search"
          : methodName === "@@replace"
            ? "replace"
            : methodName === "@@split"
              ? "split"
              : undefined;
  if (symbolMethod === undefined) return undefined;

  // Receiver must be a static / backend-created RegExp (pattern + flags known
  // at compile time); a dynamic / `any`-typed receiver falls through so the
  // host import can do the fully-dynamic dispatch.
  const recvType = ctx.checker.getTypeAtLocation(regexExpr);
  if (!isGlobalRegExpType(recvType) && !isKnownBackendCreatedRegExpReceiver(ctx, regexExpr)) {
    return undefined;
  }

  // arg[0] is the subject string in every form; string-coercion
  // (`re[Symbol.match](42)`) falls through to the host path which does ToString.
  if (expr.arguments.length < 1) return undefined;
  const strExpr = expr.arguments[0]!;
  if (!isStringLikeArg(ctx, strExpr)) return undefined;

  // Operand order: subject = the string ARGUMENT (arg[0]), regex = the RECEIVER.
  switch (symbolMethod) {
    case "search":
      if (expr.arguments.length !== 1) return undefined;
      return emitStandaloneRegExpSearchCore(ctx, fctx, expr, strExpr, regexExpr);
    case "match":
      if (expr.arguments.length !== 1) return undefined;
      return emitStandaloneRegExpMatchCore(ctx, fctx, expr, strExpr, regexExpr);
    case "matchAll":
      if (expr.arguments.length !== 1) return undefined;
      return emitStandaloneRegExpMatchAllCore(ctx, fctx, expr, strExpr, regexExpr);
    case "replace": {
      // `re[Symbol.replace](str, replacement)` — §22.2.6.11. Requires exactly
      // the (subject, replacement) pair; the replacement string-likeness is
      // checked inside the core (function replacers stay a narrowed refusal).
      if (expr.arguments.length !== 2) return undefined;
      const replExpr = expr.arguments[1]!;
      // @@replace honors the regex's own `g` flag (replace-all when global,
      // first-only otherwise); there is no replaceAll distinction here.
      const flags = staticRegExpFlags(ctx, regexExpr);
      if (flags === null) return undefined;
      const globalReplace = flags.includes("g");
      return emitStandaloneRegExpReplaceCore(ctx, fctx, expr, strExpr, regexExpr, replExpr, globalReplace, "@@replace");
    }
    case "split": {
      // `re[Symbol.split](str[, limit])` — §22.2.6.14. limit is optional.
      if (expr.arguments.length > 2) return undefined;
      const limitExpr = expr.arguments[1];
      return emitStandaloneRegExpSplitCore(ctx, fctx, expr, strExpr, regexExpr, limitExpr, "@@split");
    }
  }
}

// ── #1914: RegExp reflection + match-result shape ─────────────────────

/** Flag-boolean getter → bitfield bit (§22.2.6.5–.12, §22.2.6.18/.19). */
const REGEXP_FLAG_BOOL_PROPS: Record<string, number> = {
  hasIndices: RE_FLAG_D,
  global: RE_FLAG_G,
  ignoreCase: RE_FLAG_I,
  multiline: RE_FLAG_M,
  dotAll: RE_FLAG_S,
  unicode: RE_FLAG_U,
  unicodeSets: RE_FLAG_V,
  sticky: RE_FLAG_Y,
};

/**
 * The property names the standalone backend answers natively on RegExp
 * receivers. The import scan in index.ts consults this set so it never
 * registers an `env.RegExp_get_*` host import for these reads under
 * `--target standalone` (the acceptance criterion of #1914: no `env.RegExp_*`
 * leaks). Keep in sync with {@link tryCompileStandaloneRegExpPropertyRead}.
 */
export const STANDALONE_REGEXP_REFLECTION_PROPS: ReadonlySet<string> = new Set([
  "source",
  "flags",
  "lastIndex",
  ...Object.keys(REGEXP_FLAG_BOOL_PROPS),
]);

/**
 * Property READS on standalone RegExp receivers (#1914).
 *
 * - `.source` → struct field 4 (stored pre-escaped per §22.2.6.13.1).
 * - `.flags` → `__regex_flags_str(flags)` building the d-g-i-m-s-u-v-y string
 *   from the bitfield (§22.2.6.4).
 * - flag booleans (`.global`, `.ignoreCase`, …) → `(flags & bit) != 0`
 *   (§22.2.6.5–.12 RegExpHasFlag).
 * - `.lastIndex` → struct field 5 (f64).
 *
 * Returns `undefined` when the receiver/property is not a standalone RegExp
 * reflection read (caller falls through), `null` after reporting a narrowed
 * refusal, or the result ValType.
 */
export function tryCompileStandaloneRegExpPropertyRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || ts.isPrivateIdentifier(expr.name)) return undefined;
  const propName = expr.name.text;
  if (!STANDALONE_REGEXP_REFLECTION_PROPS.has(propName)) return undefined;
  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const nonNull = objType.getNonNullableType?.() ?? objType;
  if (!isGlobalRegExpType(nonNull)) return undefined;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, expr.expression);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  return emitRegExpReflectionFieldRead(ctx, fctx, propName, regexpLocal, structTypeIdx);
}

/**
 * Shared core for §22.2.6.14 `RegExp.prototype.toString()` rendering of a
 * static / backend-created RegExp *receiver expression* — `"/" + source + "/" +
 * flags` — emitting a native string with ZERO host imports.
 *
 * The spec result is `"/" + R.[[OriginalSource]] + "/" + R.[[OriginalFlags]]`,
 * both of which the native backend already produces (the struct's `source`
 * field is stored in the spec-escaped §22.2.6.13.1 form, and `__regex_flags_str`
 * builds the d-g-i-m-s-u-v-y flag string). In standalone / nativeStrings mode
 * there is no JS host, so the generic ref→string coercion path leaked
 * `env::Object_toString` (or null-deref'd). This composes the two native field
 * reads with `__str_concat`.
 *
 * Used by the `re.toString()` method dispatch (`tryCompileStandaloneRegExpToString`)
 * AND by the value→string coercion paths (`String(re)`, `` `${re}` ``) which
 * would otherwise null-deref or yield `"[object Object]"` (#2161).
 *
 * Returns the emitted native-string `ValType`, `null` after a reported refusal
 * (e.g. a non-backend RegExp), or `undefined` when the expression is not a
 * static / backend-created RegExp the caller should keep falling through for.
 */
export function emitStandaloneRegExpToStringFromExpr(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpExpr: ts.Expression,
): ValType | null | undefined {
  if (!ctx.standalone) return undefined;
  const objType = ctx.checker.getTypeAtLocation(regexpExpr);
  const nonNull = objType.getNonNullableType?.() ?? objType;
  if (!isGlobalRegExpType(nonNull)) return undefined;
  // Only static / backend-created receivers route to the native struct; a
  // dynamic externref RegExp falls through to the host/refusal path.
  if (!isStaticStandaloneRegExpCreation(ctx, regexpExpr) && !isKnownBackendCreatedRegExpReceiver(ctx, regexpExpr)) {
    return undefined;
  }

  const repr = nativeStringRepr(ctx);
  if (repr === undefined) return undefined;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, regexpExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  // result = "/" ++ source ++ "/" ++ flags  (left-folded via __str_concat).
  // source: struct field read ($AnyString). flags: __regex_flags_str(flags).
  ensureNativeStringHelpers(ctx);
  const flagsStrIdx = ensureRegexFlagsStr(ctx);
  const srcInstrs: Instr[] = [
    { op: "local.get", index: regexpLocal } as Instr,
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_SOURCE } as Instr,
  ];
  const flagsInstrs: Instr[] = [
    { op: "local.get", index: regexpLocal } as Instr,
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS } as Instr,
    { op: "call", funcIdx: flagsStrIdx } as Instr,
  ];
  // (("/" ++ source) ++ "/") ++ flags
  let acc = repr.concat(repr.literal("/"), srcInstrs);
  acc = repr.concat(acc, repr.literal("/"));
  acc = repr.concat(acc, flagsInstrs);
  for (const instr of acc) fctx.body.push(instr);
  return repr.resultType;
}

export function tryCompileStandaloneRegExpToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || propAccess.name.text !== "toString" || expr.arguments.length !== 0) return undefined;
  return emitStandaloneRegExpToStringFromExpr(ctx, fctx, propAccess.expression);
}

/**
 * (#2175 S1) Shared RegExp reflection field-read sequence, factored out of
 * `tryCompileStandaloneRegExpPropertyRead` so the native-method-getter closures
 * (#2175) emit the *identical* getter body off a recovered struct local. The
 * caller has already pushed nothing on the stack; this helper pushes the
 * `local.get regexpLocal` itself and the field read, returning the getter's
 * result ValType. Static path callers route through here byte-for-byte.
 */
export function emitRegExpReflectionFieldRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propName: string,
  regexpLocal: number,
  structTypeIdx: number,
): ValType {
  fctx.body.push({ op: "local.get", index: regexpLocal });
  if (propName === "source") {
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_SOURCE });
    return nativeStringType(ctx);
  }
  if (propName === "flags") {
    ensureNativeStringHelpers(ctx);
    const flagsStrIdx = ensureRegexFlagsStr(ctx);
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS });
    fctx.body.push({ op: "call", funcIdx: flagsStrIdx });
    return nativeStringType(ctx);
  }
  if (propName === "lastIndex") {
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX });
    return { kind: "f64" };
  }
  // Flag boolean getter: (flags & bit) != 0.
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS });
  fctx.body.push({ op: "i32.const", value: REGEXP_FLAG_BOOL_PROPS[propName]! });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });
  return { kind: "i32" };
}

/**
 * (#2175 S1) RegExp `.test` driven by a recovered struct local + a subject
 * string local, for the native-method-closure body where there is no receiver
 * *expression* (the reflective `RegExp.prototype.test.call(re, s)` /
 * `re[Symbol.match]`-adjacent forms). Self-contained — does NOT route through
 * `emitRegexSearchCall` (which is expression-driven) so the static fast path
 * stays byte-identical. Returns the i32 match flag (1/0) on the stack.
 *
 * `subjStrLocal` holds a flattened native-string struct ref (the closure body
 * flattens its externref arg before calling). The search starts at index 0 and
 * honours stickiness like the non-g/y `.test` static path; lastIndex mutation
 * for g/y reflective receivers is deferred (the dynamic receiver makes the
 * static flag analysis unavailable — a conservative, spec-observable subset).
 */
export function emitRegExpTestFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpLocal: number,
  structTypeIdx: number,
  subjStrLocal: number,
): void {
  const searchIdx = ensureRegexSearch(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;

  // caps = array.new_default(2 * nGroups + nScratch)
  const capsLocal = allocLocal(fctx, `__re_tcaps_${fctx.locals.length}`, { kind: "ref", typeIdx: i32Arr });
  pushNSlots(fctx, regexpLocal, structTypeIdx);
  fctx.body.push({ op: "array.new_default", typeIdx: i32Arr } as Instr);
  fctx.body.push({ op: "local.set", index: capsLocal });

  // sticky = (flags & RE_FLAG_Y) != 0
  const stickyLocal = allocLocal(fctx, `__re_tsticky_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS });
  fctx.body.push({ op: "i32.const", value: RE_FLAG_Y });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ne" });
  fctx.body.push({ op: "local.set", index: stickyLocal });

  // __regex_search(prog, classTable, nSlots, inData, inOff, inLen, start=0, sticky, caps)
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE });
  pushNSlots(fctx, regexpLocal, structTypeIdx);
  fctx.body.push({ op: "local.get", index: subjStrLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // data
  fctx.body.push({ op: "local.get", index: subjStrLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // off
  fctx.body.push({ op: "local.get", index: subjStrLocal });
  fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }); // len
  fctx.body.push({ op: "i32.const", value: 0 }); // startIdx
  fctx.body.push({ op: "local.get", index: stickyLocal });
  fctx.body.push({ op: "local.get", index: capsLocal });
  fctx.body.push({ op: "call", funcIdx: searchIdx });
}

// ── #2175 S1: RegExp builtin-prototype glue ───────────────────────────────────
//
// The contract `native-proto.ts` consumes for RegExp: a brand, a member CSV (the
// proto's own-key set, with `@@<id>` sentinels for the well-known-symbol
// members), per-member kinds/arities, and an `emitMemberBody` that runs the
// brand-recovery prologue and the member body off a recovered struct local.

/** RegExp.prototype string-named member set (the reflection-visible own keys). */
const REGEXP_PROTO_STRING_MEMBERS: readonly string[] = [
  "exec",
  "test",
  "toString",
  "compile",
  "source",
  "flags",
  "global",
  "ignoreCase",
  "multiline",
  "dotAll",
  "unicode",
  "unicodeSets",
  "sticky",
  "hasIndices",
  "lastIndex",
];

/** Well-known-symbol members on RegExp.prototype, as `@@<id>` CSV sentinels
 *  (id from WELL_KNOWN_SYMBOLS: match=7, replace=8, search=9, split=10,
 *  matchAll wired separately as it has no fixed low id here). */
const REGEXP_PROTO_SYMBOL_MEMBERS: readonly string[] = ["@@7", "@@8", "@@9", "@@10"];

/** Which RegExp.prototype members are accessor getters (§22.2.6). */
const REGEXP_GETTER_MEMBERS = new Set<string>([
  "source",
  "flags",
  "global",
  "ignoreCase",
  "multiline",
  "dotAll",
  "unicode",
  "unicodeSets",
  "sticky",
  "hasIndices",
]);

/** Static arity (`fn.length`) of RegExp.prototype methods (§22.2.6). */
const REGEXP_METHOD_LENGTH: Readonly<Record<string, number>> = {
  exec: 1,
  test: 1,
  toString: 0,
  compile: 2,
};

/**
 * (#2175 S1) Register the RegExp builtin-prototype glue with the shared
 * `native-proto` core. Idempotent — safe to call from every reflective entry.
 * Returns the RegExp brand, or `undefined` if the brand band isn't available
 * (defensive — it always is).
 */
export function ensureRegExpNativeProtoGlue(ctx: CodegenContext): number | undefined {
  const brand = getBuiltinBrand(ctx, "RegExp");
  if (brand === undefined) return undefined;

  const memberCsv = [...REGEXP_PROTO_STRING_MEMBERS, ...REGEXP_PROTO_SYMBOL_MEMBERS].join(",");
  const glue: NativeProtoBuiltinGlue = {
    brand,
    name: "RegExp",
    memberCsv,
    memberKind: (member) => (REGEXP_GETTER_MEMBERS.has(member) ? "getter" : "method"),
    memberLength: (member) => REGEXP_METHOD_LENGTH[member] ?? 1,
    emitMemberBody: (c, fctx, member, kind) => emitRegExpProtoMemberBody(c, fctx, member, kind),
  };
  registerNativeProtoBuiltin(ctx, glue);
  return brand;
}

/**
 * Emit a RegExp.prototype method/getter closure body. The closure params are:
 *   index 0: the `__fn_wrap` self struct,
 *   index 1: the externref `this` receiver,
 *   index 2..: externref args (for methods).
 * Runs the brand-recovery prologue (externref `this` → `$NativeRegExp`, or a
 * catchable TypeError on a wrong `this`), then the member body, leaving the
 * member result on the stack. Returns the result ValType, or `null` on refusal.
 */
function emitRegExpProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
  kind: "getter" | "method",
): ValType | null {
  if (kind === "getter") {
    // (#2885 Site 1) The proto-identity arm MUST run BEFORE brand recovery:
    // reading an intrinsic getter with `this === RegExp.prototype` returns
    // `undefined` per §22.2.6 ("If SameValue(R, %RegExp.prototype%) return
    // undefined"), NOT the brand-check TypeError. The getter-closure result is
    // unified to externref (the undefined sentinel + every boxed field value
    // share one type). Most getters yield `undefined` (`ref.null.extern`) on the
    // proto, but per §22.2.6.13 the `source` getter returns `"(?:)"` and per
    // §22.2.6.4 the `flags` getter returns `""` when `R === %RegExp.prototype%`
    // (#2876) — so pass a member-specific proto result.
    const brand = getBuiltinBrand(ctx, "RegExp");
    if (brand !== undefined) {
      let protoResult: Instr[];
      if (member === "source") {
        addStringConstantGlobal(ctx, "(?:)");
        protoResult = stringConstantExternrefInstrs(ctx, "(?:)");
      } else if (member === "flags") {
        addStringConstantGlobal(ctx, "");
        protoResult = stringConstantExternrefInstrs(ctx, "");
      } else {
        protoResult = [{ op: "ref.null.extern" } as Instr];
      }
      emitNativeProtoIdentityReturnUndefined(ctx, fctx, brand, 1, protoResult);
    }

    // Brand-recovery prologue: `this` is closure param index 1 (externref). On a
    // genuine non-RegExp `this` (e.g. `get.call({})`) this throws a catchable
    // TypeError (§22.2.6 step 2) — unchanged.
    const recovered = recoverRegExpStructFromExternref(ctx, fctx, 1);
    if (recovered === null) return null;
    const { regexpLocal, structTypeIdx } = recovered;

    // Reuse the exact static-path field-read sequence, then unify the result to
    // externref so the closure-call ABI and the descriptor `.get` both see one
    // type: native-string refs (`.flags`/`.source`) box via `extern.convert_any`,
    // i32 flag booleans via `__box_boolean` (a JS boolean, not the number 0/1),
    // and the defensive f64 (lastIndex is a method-kind member, never a getter)
    // via `__box_number`.
    const fieldType = emitRegExpReflectionFieldRead(ctx, fctx, member, regexpLocal, structTypeIdx);
    if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
      return { kind: "externref" };
    }
    if (fieldType.kind === "i32") {
      const boxBoolIdx = ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (boxBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxBoolIdx } as Instr);
      return { kind: "externref" };
    }
    if (fieldType.kind === "f64") {
      coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
      return { kind: "externref" };
    }
    return fieldType;
  }

  // Method bodies. Brand-recovery prologue: `this` is closure param index 1
  // (externref) → `$NativeRegExp` or a catchable TypeError on a wrong `this`.
  const recovered = recoverRegExpStructFromExternref(ctx, fctx, 1);
  if (recovered === null) return null;
  const { regexpLocal, structTypeIdx } = recovered;

  if (member === "test" || member === "@@9") {
    // `.test(s)` and `[Symbol.search]`-adjacent forms both run the search and
    // return an i32-ish result; here we return the i32 match flag for `.test`.
    // (Full `[Symbol.search]` index semantics are a later refinement; the
    // dispatch path + brand recovery are what S1 proves.)
    const subjLocal = flattenExternrefArgToString(ctx, fctx, 2);
    emitRegExpTestFromLocals(ctx, fctx, regexpLocal, structTypeIdx, subjLocal);
    return { kind: "i32" };
  }

  if (member === "source" || member === "flags") {
    // Defensive: these are getters, but if reached as a "method" form, fall to
    // the field read.
    return emitRegExpReflectionFieldRead(ctx, fctx, member, regexpLocal, structTypeIdx);
  }

  // exec / toString / compile / @@match / @@replace / @@split and remaining
  // members are dispatch-registered (the closure value materializes and brand
  // recovery runs) but their full native bodies are staged in as follow-ups —
  // emit a spec-shaped placeholder result so the closure type is well-formed and
  // the reflective READ + brand recovery compile cleanly. These return an
  // externref (null) until their engine body lands.
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  return { kind: "externref" };
}

/**
 * Narrow an externref closure-arg (a boxed native string) at `paramIdx` to a
 * flattened native-string struct local. Mirrors how the static RegExp paths
 * flatten a subject string, but starting from an opaque externref.
 */
function flattenExternrefArgToString(ctx: CodegenContext, fctx: FunctionContext, paramIdx: number): number {
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const subjLocal = allocLocal(fctx, `__re_arg_subj_${fctx.locals.length}`, { kind: "ref", typeIdx: strTypeIdx });
  // externref arg → anyref → ref $AnyString → __str_flatten → ref $NativeString.
  fctx.body.push({ op: "local.get", index: paramIdx } as Instr);
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
  if (flattenIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: flattenIdx } as Instr);
  }
  fctx.body.push({ op: "local.set", index: subjLocal });
  return subjLocal;
}

/**
 * `re.lastIndex = value` on a standalone RegExp receiver (#1914).
 *
 * [[LastIndex]] is a plain writable data property (§22.2.7.1); the struct
 * stores it as f64. The spec defers coercion to exec's ToLength, so only
 * numeric writes are accepted here — non-numeric RHS values are a narrowed
 * refusal rather than a silently mis-modelled store. Leaves the RHS f64 on
 * the stack (assignment-expression value).
 */
export function tryCompileStandaloneRegExpLastIndexWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): ValType | null | undefined {
  if (!ctx.standalone || ts.isPrivateIdentifier(target.name) || target.name.text !== "lastIndex") {
    return undefined;
  }
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const nonNull = objType.getNonNullableType?.() ?? objType;
  if (!isGlobalRegExpType(nonNull)) return undefined;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, target.expression);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;

  fctx.body.push({ op: "local.get", index: regexpLocal });
  const valType = compileExpression(ctx, fctx, value, { kind: "f64" });
  if (!valType) return null;
  if (valType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (valType.kind !== "f64") {
    reportStandaloneRegExpUnsupported(ctx, value, "non-numeric lastIndex writes");
    return null;
  }
  const tmp = allocLocal(fctx, `__re_lastindex_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX } as Instr);
  fctx.body.push({ op: "local.get", index: tmp });
  return { kind: "f64" };
}

/**
 * `.index` / `.input` reads on standalone exec/match results (#1914).
 *
 * The receiver's static TS type (`RegExpExecArray` / `RegExpMatchArray`) is
 * the routing signal; the runtime value is the `$__regexp_match_vec` subtype
 * every standalone exec/match constructs (`__regex_capture_array`). Receivers
 * statically typed as the base nstr vec are `ref.cast` down — construction
 * provenance guarantees the cast succeeds; a null result traps, matching the
 * TypeError a member read on `null` must produce.
 */
export function tryCompileStandaloneRegExpMatchResultRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!ctx.standalone || ts.isPrivateIdentifier(expr.name)) return undefined;
  const propName = expr.name.text;
  if (propName !== "index" && propName !== "input" && propName !== "groups" && propName !== "indices") {
    return undefined;
  }
  const objType = ctx.checker.getTypeAtLocation(expr.expression);
  const nonNull = objType.getNonNullableType?.() ?? objType;
  const symName = nonNull.getSymbol()?.name;
  if (symName !== "RegExpExecArray" && symName !== "RegExpMatchArray") return undefined;

  const recvType = compileExpression(ctx, fctx, expr.expression);
  if (recvType === null) return null;
  // The exec/match lowering above registered the struct while compiling the
  // receiver; absence means the value cannot be a backend match result.
  const matchVecIdx = ctx.structMap.get(REGEXP_MATCH_VEC_STRUCT);
  if (matchVecIdx === undefined) {
    reportStandaloneRegExpUnsupported(
      ctx,
      expr.expression,
      "match-result property reads on values not produced by this standalone backend",
    );
    return null;
  }
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: matchVecIdx } as Instr);
  } else if (recvType.kind === "ref" || recvType.kind === "ref_null") {
    if (recvType.typeIdx !== matchVecIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: matchVecIdx } as Instr);
    } else if (recvType.kind === "ref_null") {
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
    }
  } else {
    reportStandaloneRegExpUnsupported(
      ctx,
      expr.expression,
      "match-result property reads on values not produced by this standalone backend",
    );
    return null;
  }

  if (propName === "index") {
    fctx.body.push({ op: "struct.get", typeIdx: matchVecIdx, fieldIdx: MATCH_VEC_FIELD_INDEX });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }
  if (propName === "groups") {
    // #2588 — the named-groups result object (externref $Object). Null (≙
    // `undefined`) for a pattern with no named captures; otherwise `<name>`
    // reads flow through the standalone open-object property path.
    fctx.body.push({ op: "struct.get", typeIdx: matchVecIdx, fieldIdx: MATCH_VEC_FIELD_GROUPS });
    return { kind: "externref" };
  }
  if (propName === "indices") {
    // #2589 — the `d`-flag match-indices array (externref $ObjVec). Null (≙
    // `undefined`) when the pattern lacks the `d` flag; otherwise `[i]`/`[i][j]`
    // reads are native (no `env::__extern_get`).
    fctx.body.push({ op: "struct.get", typeIdx: matchVecIdx, fieldIdx: MATCH_VEC_FIELD_INDICES });
    return { kind: "externref" };
  }
  fctx.body.push({ op: "struct.get", typeIdx: matchVecIdx, fieldIdx: MATCH_VEC_FIELD_INPUT });
  return nativeStringType(ctx);
}

/**
 * True when `expr` is a standalone backend exec/match call producing a
 * `$__regexp_match_vec` (`re.exec(s)` / `s.match(re)` with a backend-created
 * static RegExp). Mirrors the lowering gates in
 * {@link tryCompileStandaloneRegExpExec} / {@link tryCompileStandaloneStringMatch}.
 */
function isStandaloneMatchResultCall(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripStaticWrapper(expr);
  if (!ts.isCallExpression(unwrapped)) return false;
  if (ts.isPropertyAccessExpression(unwrapped.expression)) {
    const method = unwrapped.expression.name.text;
    if (method === "exec") {
      return isKnownBackendCreatedRegExpReceiver(ctx, unwrapped.expression.expression);
    }
    if (method === "match" && unwrapped.arguments.length === 1) {
      return isKnownBackendCreatedRegExpReceiver(ctx, unwrapped.arguments[0]!);
    }
    return false;
  }
  // `re[Symbol.match](s)` (#2161) — the symbol-protocol dual of `s.match(re)`:
  // a non-global match yields the same `$__regexp_match_vec` ref result, so the
  // declared local must carry that type too (else indexed reads route through
  // __extern_get_idx and trap). Receiver is the static/backend RegExp.
  if (ts.isElementAccessExpression(unwrapped.expression)) {
    const elem = unwrapped.expression;
    if (isSymbolMatchKey(elem.argumentExpression) && unwrapped.arguments.length === 1) {
      return isKnownBackendCreatedRegExpReceiver(ctx, elem.expression);
    }
  }
  return false;
}

/** True for the computed key `Symbol.match` (the @@match well-known symbol). */
function isSymbolMatchKey(arg: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(arg) &&
    ts.isIdentifier(arg.expression) &&
    arg.expression.text === "Symbol" &&
    arg.name.text === "match"
  );
}

/** Is `expr` the `null` / `undefined` literal (fine for a ref_null global)? */
function isNullishLiteral(expr: ts.Expression): boolean {
  const unwrapped = stripStaticWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return true;
  return ts.isIdentifier(unwrapped) && unwrapped.text === "undefined";
}

/**
 * Module-global type inference for `var m = re.exec(s)` under standalone
 * (#1914). Without this the global widens to externref and indexed reads
 * route through the native `__extern_get_idx`, which only recognises the
 * open-object `$ObjVec` — a typed match-vec read back from externref returns
 * null and the comparison traps in `__str_flatten` (the
 * `null_deref __str_flatten` test262 bucket).
 *
 * Returns `ref_null $__regexp_match_vec` only when the initializer is a
 * backend exec/match call AND every other write to the var in the file is
 * also one (or null/undefined) — any foreign write keeps the externref
 * widening so the precise global type can never reject a store.
 */
export function inferStandaloneRegExpMatchGlobalType(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
): ValType | null {
  if (!ctx.standalone || !ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  if (!decl.initializer || !ts.isIdentifier(decl.name)) return null;
  if (!isStandaloneMatchResultCall(ctx, decl.initializer)) return null;
  const sym = ctx.checker.getSymbolAtLocation(decl.name);
  if (!sym) return null;

  let foreignWrite = false;
  const visit = (node: ts.Node): void => {
    if (foreignWrite) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (assignmentTargetContainsSymbol(ctx, node.left, sym)) {
        const isPlainIdentTarget = isSameSymbolIdentifier(ctx, node.left, sym);
        const rhsOk =
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (isStandaloneMatchResultCall(ctx, node.right) || isNullishLiteral(node.right));
        if (!isPlainIdentTarget || !rhsOk) foreignWrite = true;
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isSameSymbolIdentifier(ctx, node.operand, sym)
    ) {
      foreignWrite = true;
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      assignmentTargetContainsSymbol(ctx, node.initializer, sym)
    ) {
      foreignWrite = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(decl.getSourceFile(), visit);
  if (foreignWrite) return null;

  return { kind: "ref_null", typeIdx: ensureRegexMatchVecType(ctx) };
}
