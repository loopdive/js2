// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4016 — the §22.1.3 `String.prototype` SEARCH-VALUE subsystem (standalone).
 *
 * `match` / `matchAll` / `search` / `replace` / `replaceAll` / `split` all begin
 * identically (§22.1.3.11/.12/.13/.14/.19/.23, step 2 in each): *if the search
 * value is neither `undefined` nor `null`, `GetMethod(searchValue,
 * @@<protocol>)`, and if that is not `undefined`, call it.* Only when that
 * lookup comes back `undefined` does the method fall through to its own string
 * path:
 *
 *   | method                          | fall-through                              |
 *   | ------------------------------- | ----------------------------------------- |
 *   | `split`/`replace`/`replaceAll`  | `ToString(v)` — plain string, NO regex     |
 *   | `search`/`match`                | `RegExpCreate(ToString(v), undefined)`     |
 *   | `matchAll`                      | `RegExpCreate(ToString(v), "g")`           |
 *
 * The standalone lane used to refuse the whole call whenever the argument was
 * not a statically-known backend RegExp (#1474), which conflated **"not a
 * RegExp"** with **"needs a JS host"**. They are different questions:
 * `"a1b".split(123)` needs no regex engine at all, and `"abc".search("b")` needs
 * one built from a runtime string — which `regexp-standalone` has provided since
 * #2161 via `ensureDynamicStandaloneRegExpCompiler`.
 *
 * This module owns the DECISION (is the spec's plain-ToString path the whole of
 * the semantics here?) and the coercion lowering. `regexp-standalone.ts` keeps
 * the RegExp engine plumbing it calls into. Keeping them apart is also what
 * holds both of those god-files under the #3102 LOC ratchet.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { popBody, pushBody } from "./context/bodies.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  flatStringType,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
  nativeStringType,
} from "./native-strings.js";
import { regexI32ArrayType } from "./native-regex.js";
import {
  emitRegexExecArrayCall,
  emitRegexSearchCall,
  ensureDynamicStandaloneRegExpCompiler,
  ensureStandaloneRegExpStruct,
  hasStandaloneRegExpEngine,
  isStaticallyUndefinedExpr,
  stripStaticWrapper,
} from "./regexp-standalone.js";
import { coerceType } from "./type-coercion.js";
import {
  ensureBoundaryCallableKind,
  ensureObjectRuntime,
  ensureObjVecBuilders,
  reserveApplyClosure,
} from "./object-runtime.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";
import { emitStringSplitRequireObjectCoercible } from "./string-proto-split.js";
import {
  captureStagedSplitLimitProviders,
  emitStagedSplitLimitFromExternref,
  prepareStagedSplitLimitCoercion,
  type StagedSplitLimitProviders,
} from "./string-split-coercion.js";
import { emitArgAsNativeString } from "./string-ops.js";
import { isPlainToStringReplacement } from "./string-proto-replace.js";
import { tryCompileStandaloneStringSearchFunctionReplace } from "./regex-replace-fn.js";
import { getWellKnownSymbolId } from "./literals.js";
import { sourceWritesRegExpProtoSymbol } from "./regexp-proto-symbol-writes.js"; // (#6651 B9)
import { emitRegExpCreateInvoke, tryInvokeReplacedOnSearchValue } from "./regexp-proto-symbol-invoke.js"; // (#6651 B9)

/**
 * The well-known symbol each `String.prototype` search-value method consults
 * before falling back to plain string coercion.
 */
export type SearchValueProtocol = "match" | "matchAll" | "replace" | "search" | "split";

/**
 * The node a search value must be BOTH proven and emitted from.
 *
 * `String.prototype.split` is typed `(separator: string | RegExp, …)`, so a
 * TypeScript caller can only pass a number/object separator through a cast —
 * which means the analysis has to see through the assertion or this path is
 * unreachable from TypeScript entirely. A type assertion is erased at runtime,
 * so the operand's proven shape IS the value's shape.
 *
 * The reason this is one named function rather than a `stripStaticWrapper` call
 * at each site: proving on the operand while EMITTING from the assertion is a
 * silent wrong answer, not a missed optimisation. `"xtruey".search(true as any)`
 * proved admissible on the `true` literal but then handed `true as any` to the
 * ToString engine, which saw type `any` over a raw i32 and produced a value that
 * matched nothing (`-1` instead of `1`) — while the identical cast-free
 * JavaScript was correct all along. Route both through here.
 */
export function searchValueOperand(argExpr: ts.Expression): ts.Expression {
  return stripStaticWrapper(argExpr);
}

/**
 * Is this argument the `undefined` value with certainty — either syntactically
 * ({@link isStaticallyUndefinedExpr}) or because its type is exactly
 * `undefined`/`void` (e.g. `function(){}()`, test262's favourite way of writing
 * `undefined`)?
 *
 * Every search-value method special-cases undefined differently from the plain
 * `ToString` path — `split(undefined)` returns `[S]` **without splitting**,
 * while `search(undefined)` builds the EMPTY pattern rather than matching the
 * literal text `"undefined"`. Getting this wrong is a silent wrong answer, so it
 * is a separate, deliberately narrow predicate: a merely NULLABLE type
 * (`string | undefined`) is not definitely undefined and answers `false`.
 */
export function isDefinitelyUndefinedExpr(ctx: CodegenContext, argExpr: ts.Expression): boolean {
  if (isStaticallyUndefinedExpr(argExpr)) return true;
  const kind = ctx.oracle.typeFactOf(searchValueOperand(argExpr)).kind;
  return kind === "undefined" || kind === "void";
}

/**
 * Is `argExpr` a search value the spec resolves by plain **`ToString`**, with no
 * `@@<protocol>` dispatch and no RegExp involved?
 *
 * Answers `true` only when the argument's type **provably** cannot carry the
 * protocol method — exactly the condition under which the spec's
 * plain-`ToString` path is the whole of the semantics.
 *
 * Deliberately conservative in three places:
 *   - `undefined`/`void` is NOT admitted here; {@link isDefinitelyUndefinedExpr}
 *     routes it, because each method special-cases it differently and silently
 *     folding it in would be a spec bug rather than a widening.
 *   - a `symbol`-typed argument stays refused: §7.1.17 `ToString(symbol)`
 *     THROWS, and this lane has no way to raise that (same carve-out as #3724).
 *   - `any`/`unknown` stay refused, because `wellKnownSymbolMemberOf` cannot
 *     prove absence there. The one exception is a SYNTACTIC `null` literal,
 *     which is `any` under `strictNullChecks: false` yet is unambiguously the
 *     null value — and `null` skips the protocol lookup by inspection.
 */
export function isPlainToStringSearchValue(
  ctx: CodegenContext,
  argExpr: ts.Expression,
  protocol: SearchValueProtocol,
): boolean {
  if (isDefinitelyUndefinedExpr(ctx, argExpr)) return false;
  const value = searchValueOperand(argExpr);
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  const fact = ctx.oracle.typeFactOf(value);
  // ToString(symbol) throws (§7.1.17) — keep the loud refusal rather than
  // silently stringifying. A union is rejected if ANY part could be a symbol.
  if (fact.kind === "symbol") return false;
  if (fact.kind === "union" && fact.parts.some((part) => part.kind === "symbol")) return false;
  return ctx.oracle.wellKnownSymbolMemberOf(value, protocol) === false;
}

/**
 * `RegExpCreate(P, F)` (§22.2.3.3) for a NON-RegExp search value, through the
 * runtime pattern compiler `new RegExp(dynamicPattern)` already uses. `P` is
 * `""` when the argument is absent/undefined and `ToString(arg)` otherwise
 * (RegExpInitialize step 1); `F` is a compile-time constant from the caller
 * (`""` for `match`/`search`).
 *
 * Leaves nothing on the stack — the compiled struct lands in the returned local,
 * so the CALLER controls evaluation order, which is the whole point: the spec
 * runs `ToString(this)` before `RegExpCreate` evaluates the argument's
 * `toString`, and both are observable.
 */
function emitCoercedRegExpToLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression | undefined,
  flags: string,
): { regexpLocal: number; structTypeIdx: number } | null {
  if (!hasStandaloneRegExpEngine(ctx)) return null;
  ensureNativeStringHelpers(ctx);
  const strType = nativeStringType(ctx);

  const patternLocal = allocLocal(fctx, `__re_coerced_pattern_${fctx.locals.length}`, strType);
  if (argExpr === undefined) {
    for (const instr of nativeStringLiteralInstrs(ctx, "")) fctx.body.push(instr);
  } else {
    // Emit from the same node the gate proved on — see `searchValueOperand`.
    emitArgAsNativeString(ctx, fctx, searchValueOperand(argExpr));
  }
  fctx.body.push({ op: "local.set", index: patternLocal });

  const flagsLocal = allocLocal(fctx, `__re_coerced_flags_${fctx.locals.length}`, strType);
  for (const instr of nativeStringLiteralInstrs(ctx, flags)) fctx.body.push(instr);
  fctx.body.push({ op: "local.set", index: flagsLocal });

  const structTypeIdx = ensureStandaloneRegExpStruct(ctx);
  const dynamicCompilerIdx = ensureDynamicStandaloneRegExpCompiler(ctx);
  fctx.body.push({ op: "local.get", index: patternLocal });
  fctx.body.push({ op: "local.get", index: flagsLocal });
  fctx.body.push({ op: "call", funcIdx: dynamicCompilerIdx });
  const regexpLocal = allocLocal(fctx, `__re_coerced_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: regexpLocal });
  return { regexpLocal, structTypeIdx };
}

/**
 * `ToString(this)` into a `ref $AnyString` local. Runs FIRST so the receiver's
 * coercion is observable before the search value's (§22.1.3.12 step 3 precedes
 * step 4's `RegExpCreate`, where the argument's `toString` runs).
 */
function emitSubjectToLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  subjExpr: ts.Expression,
  subjectOverride?: () => ValType | null,
): number {
  const local = allocLocal(fctx, `__re_subject_${fctx.locals.length}`, nativeStringType(ctx));
  if (subjectOverride) {
    // The override's contract is "leave a `$AnyString`", but a guarded-dispatch
    // receiver may still be typed nullable — narrow before the non-null local.
    if (subjectOverride()?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
  } else {
    emitArgAsNativeString(ctx, fctx, subjExpr);
  }
  fctx.body.push({ op: "local.set", index: local });
  return local;
}

/** Shared staging for the two regex-building methods: subject, then regex. */
function stageCoercedOperands(
  ctx: CodegenContext,
  fctx: FunctionContext,
  subjExpr: ts.Expression,
  argExpr: ts.Expression | undefined,
  subjectOverride: (() => ValType | null) | undefined,
  flags: string,
): { regexpOverride: { regexpLocal: number; structTypeIdx: number }; inputOverride: () => ValType | null } | null {
  const patternArg = argExpr === undefined || isDefinitelyUndefinedExpr(ctx, argExpr) ? undefined : argExpr;
  const subjectLocal = emitSubjectToLocal(ctx, fctx, subjExpr, subjectOverride);
  const regexpOverride = emitCoercedRegExpToLocal(ctx, fctx, patternArg, flags);
  if (regexpOverride === null) return null;
  return {
    regexpOverride,
    inputOverride: () => {
      fctx.body.push({ op: "local.get", index: subjectLocal });
      return nativeStringType(ctx);
    },
  };
}

/**
 * (#6651 B9) §22.1.3.11/.17 step 5 is `Invoke(rx, @@<m>, «S»)`. When the program
 * replaces `RegExp.prototype[Symbol.<m>]`, the inline builtin body below is not
 * that Invoke, so run it through a real [[Get]] (`regexp-proto-symbol-invoke.ts`).
 * `undefined` = not replaced; the caller keeps the inline lowering.
 */
function tryInvokeReplacedProtocol(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  protocol: "match" | "search",
  staged: NonNullable<ReturnType<typeof stageCoercedOperands>>,
): ValType | null | undefined {
  const symbolId = getWellKnownSymbolId(protocol);
  if (symbolId === undefined || !sourceWritesRegExpProtoSymbol(expr, protocol)) return undefined;
  return emitRegExpCreateInvoke(ctx, fctx, staged.regexpOverride.regexpLocal, symbolId, protocol, () => {
    if (staged.inputOverride() === null) return false;
    fctx.body.push({ op: "extern.convert_any" });
    return true;
  });
}

/**
 * Does this call take the plain-ToString path at all? Absent / definitely-
 * undefined arguments do (they build the EMPTY pattern per RegExpInitialize
 * step 1 — `"".search()` is 0, not a search for the text `"undefined"`); so does
 * any argument that provably cannot carry the protocol method. Everything else
 * belongs to the caller's existing RegExp dispatch or its #1474 refusal.
 */
function takesCoercedPath(
  ctx: CodegenContext,
  argExpr: ts.Expression | undefined,
  protocol: SearchValueProtocol,
): boolean {
  if (argExpr === undefined) return true;
  return isDefinitelyUndefinedExpr(ctx, argExpr) || isPlainToStringSearchValue(ctx, argExpr, protocol);
}

/**
 * `String.prototype.search(v)` on the plain-ToString path (§22.1.3.12 steps
 * 2-4). Returns f64: the match index, or -1. `undefined` when this is not the
 * right arm, so the caller falls through to its existing dispatch.
 */
export function tryCompileCoercedStringSearch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  argExpr: ts.Expression | undefined,
  subjectOverride?: () => ValType | null,
): ValType | null | undefined {
  // (#6651 B9) Step 2 on a RegExp argument whose @@search the program replaced.
  const viaGet = tryInvokeReplacedOnSearchValue(ctx, fctx, subjExpr, argExpr, "search", subjectOverride);
  if (viaGet !== undefined) return viaGet;
  if (!takesCoercedPath(ctx, argExpr, "search")) return undefined;
  const staged = stageCoercedOperands(ctx, fctx, subjExpr, argExpr, subjectOverride, "");
  if (staged === null) return null;
  const invoked = tryInvokeReplacedProtocol(ctx, fctx, expr, "search", staged);
  if (invoked !== undefined) return invoked;
  const emitted = emitRegexSearchCall(ctx, fctx, argExpr ?? expr, subjExpr, staged);
  if (emitted === null) return null;
  const i32Arr = regexI32ArrayType(ctx);
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
  });
  return { kind: "f64" };
}

/**
 * `String.prototype.match(v)` on the plain-ToString path (§22.1.3.11 steps 3-5).
 * A coerced regex is NON-GLOBAL by construction, so this is always the
 * `.exec`-shaped arm — the global all-matches walk cannot be reached from here.
 */
export function tryCompileCoercedStringMatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  subjExpr: ts.Expression,
  argExpr: ts.Expression | undefined,
  subjectOverride?: () => ValType | null,
): ValType | null | undefined {
  const viaGet = tryInvokeReplacedOnSearchValue(ctx, fctx, subjExpr, argExpr, "match", subjectOverride);
  if (viaGet !== undefined) return viaGet;
  if (!takesCoercedPath(ctx, argExpr, "match")) return undefined;
  const staged = stageCoercedOperands(ctx, fctx, subjExpr, argExpr, subjectOverride, "");
  if (staged === null) return null;
  const invoked = tryInvokeReplacedProtocol(ctx, fctx, expr, "match", staged);
  if (invoked !== undefined) return invoked;
  return emitRegexExecArrayCall(ctx, fctx, argExpr ?? expr, subjExpr, staged);
}

type StagedSplitValue = { readonly local: number; readonly type: ValType };

/** Every native/no-host direct-arm dependency captured before user operand evaluation. */
type NativeStagedDirectSplitProviders = {
  readonly kind: "native";
  readonly anyToStringIdx: number;
  readonly flattenIdx: number;
  readonly splitIdx: number;
  readonly vecTypeIdx: number;
  readonly arrTypeIdx: number;
  readonly limit: StagedSplitLimitProviders;
};

type StagedDirectSplitProviders = NativeStagedDirectSplitProviders;

/** Type-layout reservations that stay stable across staged expressions. */
type NativeStagedDirectSplitReservation = {
  readonly kind: "native";
  readonly vecTypeIdx: number;
  readonly arrTypeIdx: number;
};

type StagedDirectSplitReservation = NativeStagedDirectSplitReservation;

/** Evaluate one call operand once and retain its raw value without coercing it. */
function stageSplitValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  emit: () => ValType | null,
  stem: string,
): StagedSplitValue | undefined {
  const type = emit();
  // A void-returning expression has already performed its effects and denotes
  // `undefined` for the later value operation. Its canonical external form is
  // materialized only after every call operand has been evaluated.
  if (type === null) return undefined;
  const local = allocLocal(fctx, `${stem}_${fctx.locals.length}`, type);
  fctx.body.push({ op: "local.set", index: local });
  return { local, type };
}

/** Convert a staged raw value to an external slot without evaluating it again. */
function externalizeStagedSplitValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  staged: StagedSplitValue | undefined,
  stem: string,
): number {
  const external = allocLocal(fctx, `${stem}_${fctx.locals.length}`, { kind: "externref" });
  if (staged === undefined) {
    fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
  } else {
    fctx.body.push({ op: "local.get", index: staged.local });
    if (staged.type.kind !== "externref" && staged.type.kind !== "ref_extern") {
      coerceType(ctx, fctx, staged.type, { kind: "externref" });
    }
  }
  fctx.body.push({ op: "local.set", index: external });
  return external;
}

/**
 * Install every provider before the direct arm emits user code. A missing
 * provider can therefore decline safely instead of re-running operands through
 * a fallback after observable evaluation.
 */
function prepareStagedDirectSplit(
  ctx: CodegenContext,
  fctx: FunctionContext,
  directMember: boolean,
): StagedDirectSplitReservation | undefined {
  ensureNativeStringHelpers(ctx);

  ensureObjectRuntime(ctx);
  if (!prepareStagedSplitLimitCoercion(ctx, fctx)) return undefined;
  if (directMember) {
    ensureObjVecBuilders(ctx);
    ensureBoundaryCallableKind(ctx);
    reserveApplyClosure(ctx);
    addStringConstantGlobal(ctx, "split");
    ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__is_callable", [{ kind: "externref" }], [{ kind: "i32" }]);
    // Reserve the real error constructor and message before any user operand;
    // rebuild its instructions after argument staging so no stale indices escape.
    buildThrowJsErrorInstrs(ctx, "TypeError", "called split value is not a function", { flush: fctx });
    flushLateImportShifts(ctx, fctx);
    if (
      !ctx.funcMap.has("__extern_get") ||
      !ctx.funcMap.has("__is_callable") ||
      !ctx.funcMap.has("__objvec_new") ||
      !ctx.funcMap.has("__objvec_push") ||
      !ctx.funcMap.has("__apply_closure")
    )
      return undefined;
  }

  // `emitStringProtoToStringFlat` materializes the `"string"` hint.  Like the
  // `"number"` hint prepared above, register it before user code so a late
  // host-mode constant import cannot repair indices after operand staging.
  addStringConstantGlobal(ctx, "string");
  ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const splitIdx = ctx.nativeStrHelpers.get("__str_split");
  const elemType: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const vecTypeIdx = getOrRegisterVecType(ctx, `ref_${ctx.anyStrTypeIdx}`, elemType);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const limit = captureStagedSplitLimitProviders(ctx, true);
  if (flattenIdx === undefined || splitIdx === undefined || arrTypeIdx < 0 || limit === undefined) return undefined;
  return { kind: "native", vecTypeIdx, arrTypeIdx };
}

/**
 * Resolve mutable function indices only after arbitrary staged expressions and
 * the direct receiver's ROC boundary have finished provisioning imports. Types
 * were reserved before staging, but defined-function indices may have shifted.
 */
function resolveStagedDirectSplitProviders(
  ctx: CodegenContext,
  reservation: StagedDirectSplitReservation,
): StagedDirectSplitProviders {
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) {
    throw new Error("direct split lost a preflighted provider after staging");
  }
  const anyToStringIdx = ensureAnyToStringHelper(ctx);
  const splitIdx = ctx.nativeStrHelpers.get("__str_split");
  const limit = captureStagedSplitLimitProviders(ctx, true);
  if (splitIdx === undefined || limit === undefined) {
    throw new Error("direct split lost a preflighted provider after staging");
  }
  return { anyToStringIdx, flattenIdx, splitIdx, ...reservation, limit };
}

/** Strict `ToString` of an already staged external value, retained as a flat string. */
function emitStagedSplitToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  externalLocal: number,
  stem: string,
  providers: NativeStagedDirectSplitProviders,
): number {
  emitStringProtoToStringFlat(ctx, fctx, externalLocal, providers.anyToStringIdx, providers.flattenIdx, {
    rejectPostPrimitiveSymbol: true,
  });
  const local = allocLocal(fctx, `${stem}_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: local });
  return local;
}

/** Positive physical string-carrier proof; a checker return annotation is not one. */
function stagedReceiverIsNativeString(ctx: CodegenContext, value: StagedSplitValue | undefined): boolean {
  if (!value || (value.type.kind !== "ref" && value.type.kind !== "ref_null")) return false;
  let index: number | undefined = value.type.typeIdx;
  const seen = new Set<number>();
  while (index !== undefined && !seen.has(index)) {
    if (index === ctx.anyStrTypeIdx) return true;
    seen.add(index);
    const type: (typeof ctx.mod.types)[number] | undefined = ctx.mod.types[index];
    index = type?.kind === "struct" ? type.superTypeIdx : undefined;
  }
  return false;
}

/** Invoke the actual property value after all argument effects, through the existing native callable ABI. */
function emitStagedSplitMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  calleeLocal: number,
  receiverLocal: number,
  argumentsList: readonly (StagedSplitValue | undefined)[],
): void {
  // The native apply bridge deliberately returns undefined for non-callables.
  // EvaluateCall requires a real TypeError here, after every argument effect.
  const notCallable = buildThrowJsErrorInstrs(ctx, "TypeError", "called split value is not a function", {
    flush: fctx,
  });
  const isCallableIdx = ctx.funcMap.get("__is_callable");
  if (isCallableIdx === undefined) throw new Error("split member call lost its prepared callable predicate");
  fctx.body.push(
    { op: "local.get", index: calleeLocal },
    { op: "call", funcIdx: isCallableIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: notCallable },
  );
  const newIdx = ctx.funcMap.get("__objvec_new");
  if (newIdx === undefined) throw new Error("split member call lost its prepared argument builder");
  fctx.body.push({ op: "call", funcIdx: newIdx });
  const argsLocal = allocLocal(fctx, `__split_method_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const argument of argumentsList) {
    const valueLocal = externalizeStagedSplitValue(ctx, fctx, argument, "__split_method_arg");
    const pushIdx = ctx.funcMap.get("__objvec_push");
    if (pushIdx === undefined) throw new Error("split member call lost its prepared argument writer");
    fctx.body.push(
      { op: "local.get", index: argsLocal },
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: pushIdx },
    );
  }
  const applyIdx = ctx.funcMap.get("__apply_closure");
  if (applyIdx === undefined) throw new Error("split member call lost its prepared callable provider");
  fctx.body.push(
    { op: "local.get", index: calleeLocal },
    { op: "local.get", index: receiverLocal },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyIdx },
  );
}

/**
 * §22.1.3.23 step 2 — the whole "what does `split` do with THIS separator?"
 * decision, for the two arms the native lane owns:
 *
 *  - **undefined separator** (#2161 B2) — `s.split()`, `s.split(void 0)`,
 *    `s.split(undefined, lim)`. Steps 5-8: an undefined separator never splits,
 *    so the result is `[S]`, or `[]` when `ToUint32(limit) === 0`. Built
 *    directly as a one-element vec — no engine call. These forms used to fall
 *    through to the host marshal path, which has no standalone `string_split`
 *    and null-deref'd.
 *  - **plain-`ToString` separator** (#4016) — `s.split(123)`, `s.split(null)`,
 *    `s.split(objWithToString)`. Step 5's `R = ToString(separator)` is the whole
 *    of the semantics; routes to the same native `__str_split` the string-
 *    separator arm uses, with no regex engine involved at all.
 *
 * Returns `undefined` for a string-like separator so the caller's existing
 * (byte-identical) arm still handles it.
 *
 * This direct arm first stages receiver, separator, limit, and every trailing
 * argument in source evaluation order. It then follows the builtin's observable
 * coercion order: `ToString(this)`, `ToUint32(limit)`, and
 * `ToString(separator)`. The existing string-like arm remains byte-identical.
 */
export function tryCompileStandaloneSplitSeparator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  emitRawReceiver: () => ValType | null,
  firstArgIsStringLike: boolean,
  directMember = true,
): ValType | null | undefined {
  const sepExpr = expr.arguments[0];
  const limitExpr = expr.arguments[1];
  // Type assertions are erased at runtime. The same unwrapped node must drive
  // both the admissibility proof and raw staging, or an `as any` would select a
  // different carrier route from the value the gate analyzed.
  const separatorValueExpr = sepExpr === undefined ? undefined : searchValueOperand(sepExpr);
  const limitValueExpr = limitExpr === undefined ? undefined : searchValueOperand(limitExpr);
  const undefinedSeparator = sepExpr === undefined || isDefinitelyUndefinedExpr(ctx, sepExpr);
  const plainSeparator =
    !firstArgIsStringLike &&
    noJsHost(ctx) &&
    sepExpr !== undefined &&
    isPlainToStringSearchValue(ctx, sepExpr, "split");
  if (!(ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && (undefinedSeparator || plainSeparator))) return undefined;

  // Provision before evaluating operands. A later failure must not fall back
  // and observe the receiver or an argument for a second time.
  const reservation = prepareStagedDirectSplit(ctx, fctx, directMember);
  if (reservation === undefined) return undefined;

  // Evaluate the receiver first. A nullish member base throws before argument
  // evaluation, but receiver conversion itself remains deferred until every
  // argument has been evaluated below.
  const rawReceiver = stageSplitValue(ctx, fctx, emitRawReceiver, "__split_raw_receiver");
  const receiverExtern = externalizeStagedSplitValue(ctx, fctx, rawReceiver, "__split_receiver_extern");
  emitStringSplitRequireObjectCoercible(ctx, fctx, receiverExtern);
  const needsLookup = directMember && !stagedReceiverIsNativeString(ctx, rawReceiver);
  let isNativeStringLocal: number | undefined;
  let calleeLocal: number | undefined;
  if (needsLookup) {
    isNativeStringLocal = allocLocal(fctx, `__split_is_native_string_${fctx.locals.length}`, { kind: "i32" });
    calleeLocal = allocLocal(fctx, `__split_actual_method_${fctx.locals.length}`, { kind: "externref" });
    const getIdx = ctx.funcMap.get("__extern_get");
    if (getIdx === undefined) throw new Error("split member call lost its prepared Get provider");
    fctx.body.push(
      { op: "local.get", index: receiverExtern },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
      { op: "local.tee", index: isNativeStringLocal },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: receiverExtern },
          ...stringConstantExternrefInstrs(ctx, "split"),
          { op: "call", funcIdx: getIdx },
          { op: "local.set", index: calleeLocal },
        ],
      },
    );
  }

  // JavaScript call evaluation continues with separator, limit, then every
  // trailing argument. Every local below preserves its raw value until coercion.
  const rawSeparator =
    separatorValueExpr === undefined
      ? undefined
      : stageSplitValue(ctx, fctx, () => compileExpression(ctx, fctx, separatorValueExpr), "__split_raw_separator");
  const rawLimit =
    limitValueExpr === undefined
      ? undefined
      : stageSplitValue(ctx, fctx, () => compileExpression(ctx, fctx, limitValueExpr), "__split_raw_limit");
  const extraValues: (StagedSplitValue | undefined)[] = [];
  for (let i = 2; i < expr.arguments.length; i++) {
    extraValues.push(
      stageSplitValue(ctx, fctx, () => compileExpression(ctx, fctx, expr.arguments[i]!), `__split_raw_extra_${i}`),
    );
  }

  const emitBuiltin = (): ValType | null => {
    // Externalization is representation-only; it gives the shared strict
    // coercion routines a stable, already-evaluated value slot.
    const separatorExtern = externalizeStagedSplitValue(ctx, fctx, rawSeparator, "__split_separator_extern");
    const limitExtern = externalizeStagedSplitValue(ctx, fctx, rawLimit, "__split_limit_extern");

    const providers = resolveStagedDirectSplitProviders(ctx, reservation);

    // Native semantic providers own all currently accepted WasmGC profiles.
    // All operands above retain their original raw values and evaluation order.
    // Builtin conversion remains receiver ToString, limit ToUint32, separator ToString.
    const receiverLocal = emitStagedSplitToString(ctx, fctx, receiverExtern, "__split_receiver", providers);
    const emittedLimit = emitStagedSplitLimitFromExternref(
      ctx,
      fctx,
      limitExtern,
      "__split",
      providers.limit,
      "raw-value",
    );
    if (emittedLimit === undefined) return null;
    const limitLocal = emittedLimit;
    const separatorLocal = emitStagedSplitToString(ctx, fctx, separatorExtern, "__split_separator", providers);

    if (undefinedSeparator) {
      // The proven undefined value has no user conversion effects; keep the
      // existing native value conversion before the zero-limit result.
      fctx.body.push({ op: "local.get", index: separatorLocal }, { op: "drop" });
      fctx.body.push({ op: "local.get", index: limitLocal }, { op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref", typeIdx: providers.vecTypeIdx } as ValType },
        then: [
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: providers.arrTypeIdx },
          { op: "struct.new", typeIdx: providers.vecTypeIdx },
        ],
        else: [
          { op: "i32.const", value: 1 },
          { op: "local.get", index: receiverLocal },
          { op: "array.new_fixed", typeIdx: providers.arrTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: providers.vecTypeIdx },
        ],
      });
      return { kind: "ref", typeIdx: providers.vecTypeIdx };
    }

    fctx.body.push(
      { op: "local.get", index: receiverLocal },
      { op: "local.get", index: separatorLocal },
      { op: "local.get", index: limitLocal },
      { op: "call", funcIdx: providers.splitIdx },
    );
    return { kind: "ref", typeIdx: providers.vecTypeIdx };
  };
  if (!needsLookup) return emitBuiltin();
  if (isNativeStringLocal === undefined || calleeLocal === undefined)
    throw new Error("split member plan lost its locals");
  // Attach the branch before emitting either arm: the first arm must remain
  // reachable from the saved parent when the second arm registers providers.
  const branch: Instr = {
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [],
    else: [],
  };
  fctx.body.push({ op: "local.get", index: isNativeStringLocal }, branch);
  const savedBody = pushBody(fctx);
  const builtinType = emitBuiltin();
  if (builtinType === null) throw new Error("split member call lost its prepared builtin branch");
  fctx.body.push({ op: "extern.convert_any" });
  branch.then = fctx.body;
  popBody(fctx, savedBody);
  const genericSavedBody = pushBody(fctx);
  const actualArguments = [
    ...(expr.arguments.length > 0 ? [rawSeparator] : []),
    ...(expr.arguments.length > 1 ? [rawLimit] : []),
    ...extraValues,
  ];
  emitStagedSplitMemberCall(ctx, fctx, calleeLocal, receiverExtern, actualArguments);
  branch.else = fctx.body;
  popBody(fctx, genericSavedBody);
  return { kind: "externref" };
}

/**
 * §22.1.3.19 / §22.1.3.20 steps 3-5 — `String.prototype.replace` /
 * `replaceAll` with a STRING (or plain-`ToString`) search value, standalone.
 *
 * The native arms in `string-ops.ts` assume BOTH operands are already native
 * strings and compile them straight into `ref $AnyString` slots. That is a
 * silent wrong answer for everything else, and it had no gate at all: a
 * function replacer trapped with `illegal cast` at runtime and a numeric one
 * produced a module that failed `WebAssembly.compile` — both after a GREEN
 * compile (#4224).
 *
 * Returns `undefined` for the string-search + string-replacement pair so the
 * caller's byte-identical arm still owns it, and for any value whose shape
 * cannot be PROVEN (`any`/`unknown`), which keeps the existing #1474 refusal
 * rather than guessing.
 */
export function tryCompileStandaloneStringValueReplace(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: "replace" | "replaceAll",
  emitReceiver: () => ValType | null,
  firstArgIsStringLike: boolean,
): ValType | null | undefined {
  if (!noJsHost(ctx) || expr.arguments.length !== 2) return undefined;
  const searchExpr = expr.arguments[0]!;
  const replExpr = expr.arguments[1]!;

  // The search value must provably reach step 3's `ToString` — i.e. it cannot
  // carry `@@replace`. `undefined` joins the ToString path here (unlike
  // `split`, where it is a distinct no-split case): `"x".replace(undefined, …)`
  // searches for the literal text "undefined".
  const searchTakesToString =
    firstArgIsStringLike ||
    isDefinitelyUndefinedExpr(ctx, searchExpr) ||
    isPlainToStringSearchValue(ctx, searchExpr, "replace");
  if (!searchTakesToString) return undefined;
  // A string search + string replacement IS the caller's existing arm.
  if (firstArgIsStringLike && ctx.oracle.typeFactOf(replExpr).kind === "string") return undefined;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) return undefined;
  const emitSubject = (): void => {
    emitReceiver();
    fctx.body.push({ op: "call", funcIdx: flattenIdx });
  };
  // (#4639 C6) §22.1.3.19 step 3 is `ToString(searchValue)`, and for the two
  // nullish values that is the LITERAL TEXT "null"/"undefined" — the string a
  // conforming `"gnulluna".replace(null, …)` searches for. `emitArgAsNativeString`
  // does not answer that: a `null` literal compiles to `ref.null.extern`, and the
  // dynamic `$__any_to_string` tail leaves the needle empty/absent, so
  // `__str_indexOf` reported -1 and the subject came back UNCHANGED
  // (`built-ins/String/prototype/replace/S15.5.4.11_A1_T5`, measured "gnulluna"
  // for an expected "gundefineduna"). The value is fixed at compile time here, so
  // emit the literal rather than routing a known constant through the engine.
  const nullishSearchText =
    searchValueOperand(searchExpr).kind === ts.SyntaxKind.NullKeyword
      ? "null"
      : isDefinitelyUndefinedExpr(ctx, searchExpr)
        ? "undefined"
        : undefined;
  const emitSearch = (): void => {
    if (nullishSearchText !== undefined) {
      for (const instr of nativeStringLiteralInstrs(ctx, nullishSearchText)) fctx.body.push(instr);
      fctx.body.push({ op: "call", funcIdx: flattenIdx });
      return;
    }
    // Emit from the same node the gate proved on — see `searchValueOperand`.
    emitArgAsNativeString(ctx, fctx, searchValueOperand(searchExpr));
    fctx.body.push({ op: "call", funcIdx: flattenIdx });
  };

  const fnArm = tryCompileStandaloneStringSearchFunctionReplace(
    ctx,
    fctx,
    replExpr,
    method === "replaceAll",
    emitSubject,
    emitSearch,
  );
  if (fnArm !== undefined) return fnArm;

  // Non-callable: step 5 stringifies the replacement, then the native helper
  // does the rest.
  if (!isPlainToStringReplacement(ctx, replExpr)) return undefined;
  const helper = ctx.nativeStrHelpers.get(method === "replaceAll" ? "__str_replaceAll" : "__str_replace");
  if (helper === undefined) return undefined;
  emitSubject();
  emitSearch();
  emitArgAsNativeString(ctx, fctx, replExpr);
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  fctx.body.push({ op: "call", funcIdx: helper });
  return nativeStringType(ctx);
}
