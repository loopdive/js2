// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4247) §10.4.2.2 — an element key on an ARRAY is an *array index* only when
// `ToString(ToUint32(P)) === P` and `ToUint32(P) !== 2^32 − 1`. Every other key
// — `4294967295`, `4294967296`, `-1`, `1.1`, `NaN`, `Infinity`, `true` — is an
// ordinary NAMED property: it must round-trip under its canonical name, must
// not create an element, and must leave `length` completely alone.
//
// The typed vec lane did not know that, and failed it two different ways.
//
//  - NUMERIC spelling: `compileElementAssignment`'s vec arm compiles the key
//    with an `{kind:"i32"}` hint, so `4294967295` saturates to `i32.max` and
//    the grow sequence tries to allocate a 2-billion-element backing array —
//    the module TRAPS ("array element access out of bounds") before any
//    assertion runs. #4222 measured all six `built-ins/Array` OOB failures as
//    exactly this and deferred it as a contained follow-up.
//  - STRING spelling: `(a as any)["4294967295"] = v` reaches `__extern_set`,
//    whose `$__vec_base` prologue runs `__unbox_number(key)` and, when that is
//    not NaN, handles the key TERMINALLY as an element — in-bounds `array.set`,
//    otherwise a silent no-op. Standalone's `__unbox_number` parses NATIVE
//    STRINGS, so the string spelling is eaten there too. It looked like it
//    worked only because the write and the read agreed on the same wrong
//    element (both saturate to the same index).
//
// This module owns the §10.4.2.2 classification and routes the non-index case
// to the array's NAMED store: the #3537 expando bag in standalone, the host
// `__extern_*` bridge in gc. Both spellings route, so they cannot disagree.
//
// Scope discipline — COMPILE-TIME CONSTANT keys only, and among those:
//   * A numeric constant, a boolean literal, or a string constant whose
//     `String(Number(s))` round-trips. That last condition is what keeps the
//     reserved names out: `arr["length"]`, `arr["push"]`, `arr["constructor"]`
//     are not array indices either, and routing them to the bag would answer
//     `undefined` for the real length and every borrowed prototype method.
//   * `[Symbol.iterator]` never reaches here — the key resolvers below refuse
//     non-literal shapes rather than calling `resolveComputedKeyExpression`,
//     which maps it to the `@@iterator` reserved name.
//   * A key that IS an array index (including `-0`, whose ToString is `"0"`)
//     returns `undefined` and falls through to the untouched vec path, so a
//     module with only ordinary indices is byte-identical.
//   * A non-constant key (`a[i]`, `x[object]` with a user `valueOf`) is
//     untouched. Deciding index-ness at runtime needs the dispatch inside the
//     element helper itself; the measured cluster is constant-keyed. Named in
//     the issue as a known leftover.
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import {
  coerceType,
  compileExpression,
  ensureLateImport,
  flushLateImportShifts,
  skipTransparentExpressions,
} from "./shared.js";
import { resolveConstantExpression } from "./literals.js";
import { tryEmitStaticI32Expression } from "./i32-static-range-expr.js";
import { highArrayIndexLiteralI32 } from "./vec-sparse-index.js";
import { TYPED_ARRAY_NAMES } from "./index.js";
import { VEC_PROP_GET, VEC_PROP_SET } from "./vec-props.js";

const EXTERNREF: ValType = { kind: "externref" };

/** 2^32 − 1 — the exclusive upper bound on array indices (§10.4.2.2). */
const MAX_ARRAY_INDEX_EXCLUSIVE = 4294967295;

/**
 * `true` when `n`'s property key (`ToString(n)`) is an array index.
 *
 * `-0` counts: `ToString(-0)` is `"0"`, and `0` is an index. `Number.isInteger`
 * accepts `-0` and `-0 >= 0` holds, so the plain arithmetic is already right.
 */
function isArrayIndexNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n < MAX_ARRAY_INDEX_EXCLUSIVE;
}

/**
 * (#2593, relocated verbatim from `expressions/assignment.ts` by #4247)
 * Recover the typed-array VIEW NAME of an element-access receiver from its TS
 * type. Returns undefined when the receiver is not a recognised typed-array
 * view.
 *
 * It moved here because BOTH the element-write site (assignment.ts, which
 * needs it for the `Uint8ClampedArray` clamp) and the element-READ site
 * (property-access.ts, which had no equivalent) must answer the same "is this
 * receiver an array exotic?" question before the §10.4.2.2 named-key routing
 * below may fire. Duplicating it would have added a second raw-checker site;
 * relocating keeps the project-wide count net-zero.
 */
export function elementAccessTypedArrayName(ctx: CodegenContext, receiver: ts.Expression): string | undefined {
  const t = ctx.checker.getTypeAtLocation(receiver);
  let name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
  if ((!name || !TYPED_ARRAY_NAMES.has(name)) && ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)) {
    name = receiver.expression.text;
  }
  return name && TYPED_ARRAY_NAMES.has(name) ? name : undefined;
}

/** Is `name` an unshadowed reference to the global of that name? */
function isUnshadowedGlobal(fctx: FunctionContext, name: string): boolean {
  return !fctx.localMap.has(name) && !(fctx.boxedCaptures?.has(name) ?? false);
}

/**
 * Resolve a compile-time-constant NUMERIC element key.
 *
 * Covers the literal forms the cluster actually uses, plus the two non-finite
 * spellings `property-cast-nan-infinity.js` exercises (`NaN`,
 * `Number.POSITIVE_INFINITY`/`NEGATIVE_INFINITY`) — neither of which
 * `resolveConstantExpression` knows, since both are global *identifiers*, not
 * literals. Anything else defers to `resolveConstantExpression` and is
 * accepted only if it came back as a `number`, so a boolean key (which that
 * helper reports as `1`/`0`, not `"true"`/`"false"`) can never be mistaken for
 * a numeric one.
 */
function resolveNumericKey(ctx: CodegenContext, fctx: FunctionContext, raw: ts.Expression): number | undefined {
  const key = skipTransparentExpressions(raw);

  if (ts.isNumericLiteral(key)) return Number(key.text);

  if (ts.isPrefixUnaryExpression(key)) {
    const inner = resolveNumericKey(ctx, fctx, key.operand);
    if (inner === undefined) return undefined;
    if (key.operator === ts.SyntaxKind.MinusToken) return -inner;
    if (key.operator === ts.SyntaxKind.PlusToken) return inner;
    return undefined;
  }

  if (ts.isIdentifier(key) && isUnshadowedGlobal(fctx, key.text)) {
    if (key.text === "NaN") return NaN;
    if (key.text === "Infinity") return Infinity;
  }

  if (
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Number" &&
    isUnshadowedGlobal(fctx, "Number")
  ) {
    if (key.name.text === "POSITIVE_INFINITY") return Infinity;
    if (key.name.text === "NEGATIVE_INFINITY") return -Infinity;
    if (key.name.text === "NaN") return NaN;
  }

  // `new Number(<const>)` as an element key. ToPropertyKey runs ToPrimitive on
  // the wrapper first (§7.1.19 → §7.1.1), which yields its [[NumberData]], so
  // the key is `ToString(n)` — identical to writing `n` directly. Recognising
  // it keeps the constant-keyed READ and this WRITE on the SAME store: without
  // it `z[new Number(1.1)] = 1` stores element 1 while `z["1.1"]` reads the
  // named store, and the two disagree (`S15.4_A1.1_T7`/`_T8`).
  if (
    ts.isNewExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Number" &&
    isUnshadowedGlobal(fctx, "Number") &&
    key.arguments?.length === 1
  ) {
    return resolveNumericKey(ctx, fctx, key.arguments[0]!);
  }

  const constVal = resolveConstantExpression(ctx, key);
  return typeof constVal === "number" ? constVal : undefined;
}

/**
 * `true` when the STRING key `k` is an array index — i.e.
 * `ToString(ToUint32(k)) === k` and `ToUint32(k) !== 2^32 − 1`, verbatim
 * §10.4.2.2. `>>> 0` is ToUint32, and it makes every near-miss spelling fall
 * out correctly: `"00"` → `"0" !== "00"`, `"4294967296"` → `"0"`, `"-1"` →
 * `"4294967295"`, `"1.1"` → `"1"`, `""` → `"0"`.
 */
function isArrayIndexString(k: string): boolean {
  const u = Number(k) >>> 0;
  return String(u) === k && u !== MAX_ARRAY_INDEX_EXCLUSIVE;
}

/**
 * Resolve a compile-time-constant STRING element key.
 *
 * Only the literal spellings — a string literal or a `const` bound to one.
 * `resolveConstantExpression` is deliberately not consulted here: it maps
 * `true`/`false` to `1`/`0` (handled separately below) and `null` to
 * `"null"`, and `resolveComputedKeyExpression` above it maps
 * `[Symbol.iterator]` to `"@@iterator"` — none of which may be mistaken for a
 * user-written string key at this site.
 */
function resolveStringKey(ctx: CodegenContext, fctx: FunctionContext, raw: ts.Expression): string | undefined {
  const key = skipTransparentExpressions(raw);
  if (ts.isStringLiteral(key)) return key.text;
  if (ts.isIdentifier(key)) {
    const constVal = resolveConstantExpression(ctx, key);
    return typeof constVal === "string" ? constVal : undefined;
  }
  // `new String(<const>)` — the wrapper twin of the `new Number(<const>)` arm
  // above, and for the same reason: ToPropertyKey runs ToPrimitive first, so
  // the key is the wrapped string (`S15.4_A1.1_T8`).
  if (
    ts.isNewExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "String" &&
    isUnshadowedGlobal(fctx, "String") &&
    key.arguments?.length === 1
  ) {
    return resolveStringKey(ctx, fctx, key.arguments[0]!);
  }
  return undefined;
}

/**
 * The canonical property-key string for an element key that is a
 * compile-time constant and NOT an array index — `undefined` when the key is
 * dynamic or a genuine index, both of which keep the existing vec lowering.
 *
 * Three constant families, each for its own reason:
 *
 *  - **number** (`4294967295`, `-1`, `1.1`, `NaN`, `Infinity`): the vec lane
 *    compiles the key with an i32 hint and TRAPS on the grow.
 *  - **string** (`"4294967296"`, `"1.1"`, `""`), but only when
 *    `Number(k)` is not NaN: those are the spellings the runtime's
 *    `__unbox_number(key)` prologue parses and then handles terminally as an
 *    element, so the write is silently dropped and the read misses. An
 *    ordinary name like `"foo"` is already correct and is left alone, so this
 *    stays a strict repair of the broken subset.
 *  - **boolean** (`x[true]`): the key is `"true"`/`"false"`, but the vec lane
 *    coerces it to index `1`/`0` and writes a real element.
 */
export function nonArrayIndexNumericKey(
  ctx: CodegenContext,
  fctx: FunctionContext,
  key: ts.Expression,
): string | undefined {
  // `skipTransparentExpressions` unwraps parens AND the type-only wrappers
  // (`x as any`, `<any>x`, `!`), which carry no runtime meaning — the key
  // `true as any` must decide identically to the bare `true` the equivalent JS
  // writes.
  const inner = skipTransparentExpressions(key);
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return "false";
  // (#4556) `null` / `undefined` element keys. ToPropertyKey(null) is the
  // STRING `"null"`, not index 0 — but the vec lane coerced them to i32 and
  // wrote element 0 (`x[null] = 0` made `x[0]` 0 and `x["null"]` undefined;
  // test262 `built-ins/Array/S15.4_A1.1_T5`). Same failure shape as the
  // boolean-literal arm directly above, same fix.
  if (inner.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (
    inner.kind === ts.SyntaxKind.UndefinedKeyword ||
    ts.isVoidExpression(inner) ||
    (ts.isIdentifier(inner) && inner.text === "undefined" && isUnshadowedGlobal(fctx, "undefined"))
  ) {
    return "undefined";
  }
  // (#4556) `new Boolean(<const>)` — the wrapper twin of the `new Number` /
  // `new String` arms in the key resolvers: ToPropertyKey runs ToPrimitive
  // first, so the key is `"true"` / `"false"` (`S15.4_A1.1_T6`).
  if (
    ts.isNewExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Boolean" &&
    isUnshadowedGlobal(fctx, "Boolean")
  ) {
    const args = inner.arguments;
    if (args === undefined || args.length === 0) return "false";
    if (args.length === 1) {
      // LITERAL argument only — `resolveConstantExpression` would fold a
      // MUTABLE `let`/`var` binding to its initializer (see the note in
      // `arrayIndexConstantKey`), so a later reassignment would silently give
      // the wrong key.
      const a = skipTransparentExpressions(args[0]!);
      if (a.kind === ts.SyntaxKind.TrueKeyword) return "true";
      if (a.kind === ts.SyntaxKind.FalseKeyword) return "false";
      if (ts.isNumericLiteral(a)) {
        const c = Number(a.text);
        return c !== 0 && !Number.isNaN(c) ? "true" : "false";
      }
      if (ts.isStringLiteral(a)) return a.text.length > 0 ? "true" : "false";
    }
    return undefined;
  }

  const n = resolveNumericKey(ctx, fctx, key);
  if (n !== undefined) {
    if (isArrayIndexNumber(n)) return undefined;
    // `String(n)` IS ECMAScript `ToString(Number)` for every finite and
    // non-finite double, including `"1e+21"` and `"-Infinity"`.
    return String(n);
  }

  const s = resolveStringKey(ctx, fctx, key);
  if (s === undefined || isArrayIndexString(s) || !isNamedNumericOrBooleanSpelling(s)) return undefined;
  return s;
}

/**
 * (#4556) The reverse of {@link nonArrayIndexNumericKey}: a compile-time
 * constant element key whose `ToString` **IS** an array index, spelled as
 * something other than a plain number.
 *
 * `#4247` routed the constant NON-index keys to the named store and let every
 * index key "fall through to the untouched vec path". For a numeric literal
 * that is right. For the other constant spellings of an index it is not: the
 * vec path compiles the key with an `{kind:"i32"}` hint, and a string / wrapper
 * expression has no i32 lowering, so it silently produced **0**. Measured
 * standalone, all four of these hit element 0:
 *
 * ```js
 * var a = [10, 20, 30];
 * a["1"]                 // 10, expected 20
 * a[new Number(2)]       // 10, expected 30
 * a[new String("2")]     // 10, expected 30
 * var b = []; b["1"] = 1 // b.length 1, b[1] undefined
 * ```
 *
 * (test262 `built-ins/Array/S15.4_A1.1_T{4,7,8}`.) ToPropertyKey runs
 * ToString/ToPrimitive on the key, so all three spellings denote the SAME
 * index as the numeric literal and must reach the same element.
 *
 * Returns the index, or `undefined` when the key is dynamic, is not an index,
 * or is already a plain numeric spelling — the last case deliberately, so a
 * module using only ordinary `a[1]` indices is byte-identical.
 */
export function arrayIndexConstantKey(
  ctx: CodegenContext,
  fctx: FunctionContext,
  key: ts.Expression,
): number | undefined {
  const inner = skipTransparentExpressions(key);
  // A numeric spelling already lowers correctly through the i32 hint — leave it
  // on the untouched path. Booleans are NOT indices (`x[true]` is `"true"`) and
  // are owned by `nonArrayIndexNumericKey`.
  if (ts.isNumericLiteral(inner)) return undefined;
  if (ts.isPrefixUnaryExpression(inner) && ts.isNumericLiteral(inner.operand)) return undefined;
  if (inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) return undefined;

  // LITERAL ARGUMENTS ONLY — never an identifier, at this level or inside the
  // wrapper. `resolveConstantExpression` (literals.ts) folds a `let`/`var`
  // binding to its INITIALIZER, mutability be damned, and returns it as a
  // STRING even for a numeric one. So `for (var i = 0; …) nums[i]` resolved `i`
  // to `"0"`, which IS an array index, and every iteration read `nums[0]`:
  // `[1,2,3]` summed to 3 instead of 6. That fold is harmless to
  // `nonArrayIndexNumericKey` — an index-looking result makes it decline — but
  // here it is the ANSWER, so the same input becomes a silent wrong read.
  // Every measured win (`S15.4_A1.1_T{4,7,8}`) spells the key as a literal or a
  // wrapper around one, so nothing is lost by refusing identifiers outright.
  const wrapperArg =
    ts.isNewExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    (inner.expression.text === "Number" || inner.expression.text === "String") &&
    isUnshadowedGlobal(fctx, inner.expression.text) &&
    inner.arguments?.length === 1
      ? skipTransparentExpressions(inner.arguments[0]!)
      : undefined;
  const isWrapper = wrapperArg !== undefined && (ts.isStringLiteral(wrapperArg) || ts.isNumericLiteral(wrapperArg));
  if (!ts.isStringLiteral(inner) && !isWrapper) return undefined;

  if (ts.isStringLiteral(inner)) return isArrayIndexString(inner.text) ? Number(inner.text) : undefined;
  // `new String("2")` is a string key; `new Number(2)` a numeric one.
  if (ts.isStringLiteral(wrapperArg!)) {
    return isArrayIndexString(wrapperArg!.text) ? Number(wrapperArg!.text) : undefined;
  }
  const n = Number((wrapperArg as ts.NumericLiteral).text);
  return isArrayIndexNumber(n) ? n : undefined;
}

/**
 * (#4556) Compile an element-access key into an i32 index. The single entry
 * point for BOTH the read site (property-access.ts) and the write site
 * (assignment.ts), relocated here so the two cannot drift apart.
 *
 * Order matters. {@link arrayIndexConstantKey} runs FIRST because the generic
 * `compileExpression(key, {kind:"i32"})` at the bottom has no lowering for a
 * string / wrapper spelling of an index and silently produced `0` — every
 * `a["1"]`, `a[new Number(2)]`, `a[new String("2")]` read element 0 and
 * `b["1"] = 1` wrote element 0. A plain numeric spelling is declined by the
 * resolver and keeps the untouched range-proven / generic path.
 */
export function compileElementIndexI32(ctx: CodegenContext, fctx: FunctionContext, key: ts.Expression): ValType | null {
  const idx = arrayIndexConstantKey(ctx, fctx, key);
  if (idx !== undefined) {
    fctx.body.push({ op: "i32.const", value: idx });
    return { kind: "i32" };
  }
  // (#4491 lane J) A numeric-literal index above `i32.MAX` — `x[2147483648]`,
  // `x[4294967294]`. Both the range-proven emitter and the generic f64
  // fallback SATURATE it to 2147483647, silently renaming the index. Emit the
  // u32 bit pattern instead; every index comparison on the vec paths is
  // unsigned. See vec-sparse-index.ts.
  const highIdx = highArrayIndexLiteralI32(key);
  if (highIdx !== undefined) {
    fctx.body.push({ op: "i32.const", value: highIdx });
    return { kind: "i32" };
  }
  if (tryEmitStaticI32Expression(ctx, fctx, key)) return { kind: "i32" };
  return compileExpression(ctx, fctx, key, { kind: "i32" });
}

/**
 * Accept a STRING key only when it is the canonical spelling of a value this
 * change can also produce from the non-string side — i.e. `String(Number(s))`
 * round-trips (`"4294967296"`, `"1.1"`, `"-1"`, `"NaN"`, `"Infinity"`,
 * `"-Infinity"`, `"1e+21"`), or it is `"true"`/`"false"`.
 *
 * The round-trip is what keeps this SAFE rather than a broad "any non-index
 * string" rule. A vec receiver reaches this site for `arr["length"]`,
 * `arr["push"]`, `arr["constructor"]` too, and none of those are array indices
 * either — routing them to the expando bag would answer `undefined` for the
 * real length and for every borrowed prototype method. `Number("length")` is
 * NaN, whose ToString is `"NaN"`, which does not equal `"length"`, so the
 * round-trip rejects the whole family of names by construction instead of by
 * an enumerated deny-list that a new builtin could outgrow.
 *
 * `"true"`/`"false"` are admitted explicitly because the boolean-key arm above
 * now writes under exactly those names; leaving the string spelling on the old
 * element lowering would make `x[true] = 1; x["true"]` disagree, which is the
 * precise shape `property-cast-boolean-primitive.js` asserts.
 *
 * KNOWN GAP (unchanged from before, not introduced here): non-canonical
 * numeric spellings — `""`, `"00"`, `"0x10"`, `" 1"` — are not array indices
 * and are not canonical either, so they keep the old element lowering and stay
 * wrong. Repairing them needs the broad rule plus a real answer for the
 * `length`/method-name family; see the issue's Leftovers.
 */
function isNamedNumericOrBooleanSpelling(s: string): boolean {
  if (s === "true" || s === "false") return true;
  // (#4556) `"null"` / `"undefined"` join `"true"`/`"false"` for the identical
  // reason: the key arms above now WRITE under exactly those names, so the
  // string spelling of the read has to reach the same bag entry or `x[null] =
  // 0; x["null"]` would disagree. Neither is an `Array.prototype` member name,
  // so admitting them does not weaken the round-trip guard's real job (keeping
  // `length` / `push` / `constructor` off the bag).
  if (s === "null" || s === "undefined") return true;
  return String(Number(s)) === s;
}

/**
 * Resolve the helper that reaches the array's NAMED-property store.
 *
 * Standalone/wasi: the #3537 expando bag accessors (`__vec_prop_get` /
 * `__vec_prop_set`) directly. `__extern_get`/`__extern_set` cannot be used
 * here — their `$__vec_base` prologue treats any key whose `__unbox_number` is
 * not NaN as a vec ELEMENT and returns terminally, and standalone's
 * `__unbox_number` parses native strings, so a numeric-looking key never
 * reaches the bag through them (see the exported-name note in vec-props.ts).
 *
 * Host/gc: `__extern_*` is the host import and JS already implements
 * §10.4.2.2 exactly — `arr[4294967295] = v` creates a named property and
 * leaves `length` alone — so the plain dynamic call is both correct and the
 * only thing available (the bag is standalone-only).
 */
function resolveNamedPropHelper(ctx: CodegenContext, fctx: FunctionContext, kind: "get" | "set"): number | undefined {
  // Ask for the dynamic accessor FIRST in both lanes. In host mode that IS the
  // answer; in standalone it is what arms the object runtime, and the #3537 bag
  // helpers are reserved as part of that arming — so the `funcMap` lookup below
  // is empty until this call has happened.
  const dynamicIdx =
    kind === "get"
      ? ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF])
      : ensureLateImport(ctx, "__extern_set", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  flushLateImportShifts(ctx, fctx);
  if (!ctx.standalone && !ctx.wasi) return dynamicIdx;
  // Standalone: the bag accessor, or nothing. Falling back to `__extern_*` here
  // would be worse than not firing at all — its vec prologue would swallow the
  // key as an element and silently drop the write.
  return ctx.funcMap.get(kind === "get" ? VEC_PROP_GET : VEC_PROP_SET);
}

/** Push the key as an `externref` native/host string constant. */
function pushKeyString(ctx: CodegenContext, fctx: FunctionContext, key: string): void {
  addStringConstantGlobal(ctx, key);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, key));
}

/**
 * `arr[<non-index number>]` READ. The receiver vec ref is already on the
 * stack. Emits `__extern_get(externref(vec), "<key>")`, which reaches the
 * #3537 expando bag for a vec carrier and answers `undefined` for an absent
 * key — exactly what §10.4.2.2 wants and what the string-key spelling already
 * does. Returns the result ValType, or `null` when the runtime helper is
 * unavailable (caller then keeps the legacy path).
 */
export function emitNonIndexVecElementGet(ctx: CodegenContext, fctx: FunctionContext, key: string): ValType | null {
  const funcIdx = resolveNamedPropHelper(ctx, fctx, "get");
  if (funcIdx === undefined) return null;
  fctx.body.push({ op: "extern.convert_any" });
  pushKeyString(ctx, fctx, key);
  fctx.body.push({ op: "call", funcIdx });
  return EXTERNREF;
}

/**
 * `arr[<non-index number>] = v` WRITE. The receiver vec ref is already on the
 * stack; `recvType` is its ValType so it can be stashed in a local of the
 * right shape. Emits `__extern_set(externref(vec), "<key>", box(v))` and
 * leaves the assigned value as the expression result.
 *
 * Evaluation order is preserved: the receiver was evaluated by the caller, the
 * key is a compile-time constant (no observable evaluation), and the RHS is
 * compiled here — i.e. receiver-then-RHS, the same order the vec path uses.
 */
export function emitNonIndexVecElementSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvType: ValType,
  key: string,
  value: ts.Expression,
  compile: (expr: ts.Expression, hint?: ValType) => ValType | null,
): ValType | null {
  const funcIdx = resolveNamedPropHelper(ctx, fctx, "set");
  if (funcIdx === undefined) return null;

  const recvLocal = allocLocal(fctx, `__nonidx_recv_${fctx.locals.length}`, recvType);
  fctx.body.push({ op: "local.set", index: recvLocal });

  const valResult = compile(value, EXTERNREF);
  if (!valResult) return null;
  if (valResult.kind !== "externref") coerceType(ctx, fctx, valResult, EXTERNREF);
  const valLocal = allocLocal(fctx, `__nonidx_val_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: valLocal });

  const call: Instr[] = [{ op: "local.get", index: recvLocal }, { op: "extern.convert_any" }];
  for (const instr of call) fctx.body.push(instr);
  pushKeyString(ctx, fctx, key);
  fctx.body.push({ op: "local.get", index: valLocal });
  fctx.body.push({ op: "call", funcIdx });

  // The assignment expression evaluates to the assigned value.
  fctx.body.push({ op: "local.get", index: valLocal });
  return EXTERNREF;
}
