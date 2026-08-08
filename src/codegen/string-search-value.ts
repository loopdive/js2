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
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { noJsHost } from "./js-errors.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { compileExpression } from "./shared.js";
import { ensureNativeStringHelpers, nativeStringLiteralInstrs, nativeStringType } from "./native-strings.js";
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
import { compileStringIntegerArg, emitArgAsNativeString } from "./string-ops.js";
import { isPlainToStringReplacement } from "./string-proto-replace.js";
import { tryCompileStandaloneStringSearchFunctionReplace } from "./regex-replace-fn.js";

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
  if (!takesCoercedPath(ctx, argExpr, "search")) return undefined;
  const staged = stageCoercedOperands(ctx, fctx, subjExpr, argExpr, subjectOverride, "");
  if (staged === null) return null;
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
  if (!takesCoercedPath(ctx, argExpr, "match")) return undefined;
  const staged = stageCoercedOperands(ctx, fctx, subjExpr, argExpr, subjectOverride, "");
  if (staged === null) return null;
  return emitRegexExecArrayCall(ctx, fctx, argExpr ?? expr, subjExpr, staged);
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
 * Operands are emitted receiver → separator → limit, matching that arm, so
 * ARGUMENT evaluation stays left-to-right as at any call site. The spec coerces
 * `ToUint32(limit)` (step 4) before `ToString(separator)` (step 5), which is the
 * reverse; reordering the two coercions would require holding an un-coerced
 * arbitrary value across the limit coercion and, worse, would invert argument
 * evaluation for `s.split(f(), g())` — trading a non-observable deviation for an
 * observable one. The string-separator arm already ships this order, so this
 * introduces no new deviation.
 */
export function tryCompileStandaloneSplitSeparator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  emitReceiver: () => ValType | null,
  firstArgIsStringLike: boolean,
): ValType | null | undefined {
  const sepExpr = expr.arguments[0];
  const limitExpr = expr.arguments[1];
  const emitLimit = (): void => {
    // Absent / statically-undefined limit → unbounded, encoded as -1 (#2125).
    if (limitExpr !== undefined && !isStaticallyUndefinedExpr(limitExpr)) {
      compileStringIntegerArg(ctx, fctx, limitExpr);
    } else {
      fctx.body.push({ op: "i32.const", value: -1 });
    }
  };

  if (
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    (sepExpr === undefined || isDefinitelyUndefinedExpr(ctx, sepExpr))
  ) {
    const elemType: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
    const vecTypeIdx = getOrRegisterVecType(ctx, `ref_${ctx.anyStrTypeIdx}`, elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    // Receiver → native-string local (kept nullable; a null receiver would have
    // thrown at the property access already).
    const recvLocal = allocLocal(fctx, `__split_recv_${fctx.locals.length}`, nativeStringType(ctx));
    emitReceiver();
    fctx.body.push({ op: "local.set", index: recvLocal });
    // (#4016) The separator's VALUE is unused, but its EXPRESSION is still
    // evaluated at the call site — a type-level `void` one (`f()`) is not
    // side-effect-free like the syntactic forms, so discard rather than delete.
    if (sepExpr !== undefined && !isStaticallyUndefinedExpr(sepExpr)) {
      const sepType = compileExpression(ctx, fctx, sepExpr);
      if (sepType) fctx.body.push({ op: "drop" });
    }
    const limLocal = allocLocal(fctx, `__split_lim_${fctx.locals.length}`, { kind: "i32" });
    emitLimit();
    fctx.body.push({ op: "local.set", index: limLocal });
    // lim === 0 ? { length: 0, data: [] } : { length: 1, data: [S] }
    fctx.body.push({ op: "local.get", index: limLocal });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: vecTypeIdx } as ValType },
      then: [
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 0 },
        { op: "array.new_default", typeIdx: arrTypeIdx },
        { op: "struct.new", typeIdx: vecTypeIdx },
      ],
      else: [
        { op: "i32.const", value: 1 },
        { op: "local.get", index: recvLocal },
        { op: "array.new_fixed", typeIdx: arrTypeIdx, length: 1 },
        { op: "struct.new", typeIdx: vecTypeIdx },
      ],
    });
    return { kind: "ref", typeIdx: vecTypeIdx };
  }

  if (firstArgIsStringLike || !noJsHost(ctx)) return undefined;
  if (sepExpr === undefined || !isPlainToStringSearchValue(ctx, sepExpr, "split")) return undefined;
  const splitIdx = ctx.nativeStrHelpers.get("__str_split");
  const nstrVecTypeIdx = ctx.vecTypeMap.get(`ref_${ctx.anyStrTypeIdx}`);
  if (splitIdx === undefined || nstrVecTypeIdx === undefined) return undefined;

  emitReceiver();
  // Emit from the same node the gate proved on — see `searchValueOperand`.
  emitArgAsNativeString(ctx, fctx, searchValueOperand(sepExpr));
  emitLimit();
  fctx.body.push({ op: "call", funcIdx: splitIdx });
  return { kind: "ref", typeIdx: nstrVecTypeIdx };
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
  const emitSearch = (): void => {
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
