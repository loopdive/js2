// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Typed-operand binary dispatch — extracted verbatim from compileBinaryExpression
 * in binary-ops.ts (#3280, WAVE C decomposition). Once both operands have been
 * compiled to concrete Wasm value types (leftType/rightType, values already on
 * the stack), this handles the entire type-directed tail dispatch: struct-ref
 * valueOf coercion, strict/loose equality (ref identity, native-string content,
 * $AnyValue tag-aware, the externref abstract-equality cascade), i32/i64/numeric
 * arithmetic, and the f64 coercion fallback. Byte-identical lift — no behavioural
 * change (prove-emit-identity IDENTICAL across gc/standalone/wasi).
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isNumberType, isStringType, isWrapperObjectType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyFromExternHelper, undefinedSingletonActive } from "./any-helpers.js";
import { reportError } from "./context/errors.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { moduleGlobalIsDynamicButStaticallyPrimitive } from "./declarations/heterogeneous-scalar-var-widening.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { redundantFlattenCall } from "./lazy-str-flatten.js"; // (#4157) caller-side flatten elision
import { emitNativeParseNumber } from "./parse-number-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringImports, addUnionImports } from "./index.js";
import type { InnerResult } from "./shared.js";
import { coerceType, ensureAnyHelpers, flushLateImportShifts } from "./shared.js";
import { emitAnyEqFromExternTemps, emitHostEqualityFromStack } from "./coercion-engine.js";
import {
  compileBooleanBinaryOp,
  compileI32BinaryOp,
  compileI64BinaryOp,
  compileNumericBinaryOp,
} from "./binary-ops.js";

function equalityOperandHasStaleStaticType(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  return (
    ts.isIdentifier(expr) &&
    (fctx.forInIdentifierVars?.has(expr.text) === true || moduleGlobalIsDynamicButStaticallyPrimitive(ctx, expr))
  );
}

/**
 * Type-directed dispatch for a binary expression whose operands have already
 * been compiled onto the stack as leftType/rightType. Always returns (never
 * falls through). See module header for scope.
 */
export function compileTypedBinaryDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  leftType: ValType,
  rightType: ValType,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
  wrapperEquality: boolean,
  isNumericOp: boolean,
  bothNativeI32: boolean,
  hasI32LocalOperand: boolean,
  isLooseEq: boolean,
  isLooseNeq: boolean,
  isEqOp: boolean,
  isNeqOp: boolean,
  arithI32WithToInt32Wrap: boolean,
  bitwiseI32: boolean,
): InnerResult {
  // ── Struct ref valueOf coercion (#138/#139) ──
  // When operands are struct refs (objects with valueOf), coerce them to f64
  // before performing numeric/comparison/equality operations.
  // For strict equality (===, !==): compare struct refs by reference identity.
  {
    const leftIsRef = leftType.kind === "ref" || leftType.kind === "ref_null";
    const rightIsRef = rightType.kind === "ref" || rightType.kind === "ref_null";
    if (leftIsRef || rightIsRef) {
      // Strict equality: reference identity comparison (no valueOf coercion)
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (isStrictEq || isStrictNeq) {
        if (leftIsRef && rightIsRef) {
          // (#2742) Native strings are structs, but JS String strict equality
          // compares values. Dynamic String methods can retain a native-string
          // ValType while the checker calls the expression `any`, bypassing the
          // syntax-directed string path and reaching this ref dispatch. Compare
          // the physical native-string pair by content, with null refs retaining
          // their undefined-sentinel identity semantics.
          const isNativeStringRef = (type: ValType): boolean =>
            (type.kind === "ref" || type.kind === "ref_null") &&
            (type.typeIdx === ctx.anyStrTypeIdx || type.typeIdx === ctx.nativeStrTypeIdx);
          if (
            ctx.nativeStrings &&
            ctx.anyStrTypeIdx >= 0 &&
            isNativeStringRef(leftType) &&
            isNativeStringRef(rightType)
          ) {
            ensureNativeStringHelpers(ctx);
            const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
            if (strEqIdx !== undefined) {
              const nullableString: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
              const tmpRightString = allocTempLocal(fctx, nullableString);
              const tmpLeftString = allocTempLocal(fctx, nullableString);
              fctx.body.push({ op: "local.set", index: tmpRightString });
              fctx.body.push({ op: "local.set", index: tmpLeftString });
              fctx.body.push({ op: "local.get", index: tmpLeftString });
              fctx.body.push({ op: "ref.is_null" });
              fctx.body.push({ op: "local.get", index: tmpRightString });
              fctx.body.push({ op: "ref.is_null" });
              fctx.body.push({ op: "i32.or" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: tmpLeftString },
                  { op: "local.get", index: tmpRightString },
                  { op: "ref.eq" },
                ],
                else: [
                  { op: "local.get", index: tmpLeftString },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: tmpRightString },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: strEqIdx },
                ],
              });
              releaseTempLocal(fctx, tmpLeftString);
              releaseTempLocal(fctx, tmpRightString);
              if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
              return { kind: "i32" };
            }
          }

          // (#2742) Dynamic `+` returns `$AnyValue`, so compare a mixed
          // `$AnyValue`/native-string pair through the canonical tag-aware
          // engine used by IR `dyn.eq`, never through carrier identity.
          const isAnyValueRef = (type: ValType): boolean =>
            (type.kind === "ref" || type.kind === "ref_null") &&
            ctx.anyValueTypeIdx >= 0 &&
            type.typeIdx === ctx.anyValueTypeIdx;
          const leftIsAnyValue = isAnyValueRef(leftType);
          const rightIsAnyValue = isAnyValueRef(rightType);
          const mixedAnyValueNativeString =
            (ctx.standalone === true || ctx.wasi === true) &&
            ctx.nativeStrings &&
            leftIsAnyValue !== rightIsAnyValue &&
            ((leftIsAnyValue && isNativeStringRef(rightType)) || (rightIsAnyValue && isNativeStringRef(leftType)));
          if (mixedAnyValueNativeString) {
            const honestFromExternIdx = ensureAnyFromExternHelper(ctx, { forceHonest: true });
            ensureAnyHelpers(ctx);
            const strictEqIdx = ctx.funcMap.get("__any_strict_eq");
            if (honestFromExternIdx !== undefined && strictEqIdx !== undefined) {
              if (leftIsAnyValue) {
                coerceType(ctx, fctx, rightType, { kind: "externref" });
                fctx.body.push({ op: "call", funcIdx: honestFromExternIdx });
              } else {
                const tmpRightAnyValue = allocTempLocal(fctx, rightType);
                fctx.body.push({ op: "local.set", index: tmpRightAnyValue });
                coerceType(ctx, fctx, leftType, { kind: "externref" });
                fctx.body.push({ op: "call", funcIdx: honestFromExternIdx });
                fctx.body.push({ op: "local.get", index: tmpRightAnyValue });
                releaseTempLocal(fctx, tmpRightAnyValue);
              }
              fctx.body.push({ op: "call", funcIdx: strictEqIdx });
              if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
              return { kind: "i32" };
            }
          }
          // (#3037 CS1b(ii)) When BOTH operands are the tagged `$AnyValue` box (in
          // standalone), raw `ref.eq` is the WRONG strict-eq: `$AnyValue` is a
          // discriminated union, so two boxes of the same logical value have
          // distinct struct identity but must compare by TAG (a tag-3 number by
          // value, a tag-5 string by content, a tag-6 object by `refval` identity).
          // This pair reaches here only when binary-ops' line-1086 any-dispatch was
          // skipped because `anyValueTypeIdx` was still unregistered at the binary
          // expression's entry, yet an operand later became `$AnyValue` (the CS1b
          // element/member-read carrier registers the type lazily). Route to the
          // tag-aware `__any_strict_eq` so `const a: any = [5,5]; a[0] === a[1]`
          // (and the string analogue) stay correct. Non-`$AnyValue` ref pairs
          // (class instances, nominal structs) keep genuine `ref.eq` identity.
          const bothAnyValue =
            ctx.standalone &&
            ctx.anyValueTypeIdx >= 0 &&
            leftType.kind === "ref" &&
            rightType.kind === "ref" &&
            leftType.typeIdx === ctx.anyValueTypeIdx &&
            rightType.typeIdx === ctx.anyValueTypeIdx;
          if (bothAnyValue) {
            ensureAnyHelpers(ctx);
            const strictEqIdx = ctx.funcMap.get("__any_strict_eq");
            if (strictEqIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: strictEqIdx });
              if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
              return { kind: "i32" };
            }
          }
          fctx.body.push({ op: "ref.eq" });
          if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // (#1395) Mixed ref + externref strict equality: bridge via anyref so
        // identity is preserved. This fires for cases like a static method
        // that returns `this` (typed as `(ref null $C)`) compared against the
        // bare class identifier (typed as externref of the `__class_<Name>`
        // singleton). Both reference the SAME underlying struct allocation,
        // so `ref.eq` produces the right answer once we get both sides into
        // eqref. Without this bridge, the catch-all below dropped both
        // operands and emitted `i32.const 0`, breaking
        // `static m() { return this; } … C.m() === C` and similar
        // `this`-returns-class-object tests.
        //
        // Uses the same `EQ_HEAP_TYPE = -19` constant + ref.test guard as the
        // externref-vs-externref identity fast-path further down (see comment
        // at line ~1517). When the externref isn't eqref-shaped (e.g. a host
        // string, a number externref), we conservatively return 0 for === or
        // 1 for !== — those cases shouldn't conflate identity anyway.
        const otherType = leftIsRef ? rightType : leftType;
        // (#1914) Mixed externref + native-string-ref strict equality compares
        // string CONTENT (§7.2.16 "If x is a String"), not identity. This is
        // the shape of `anyParam === "literal"` (e.g. the test262 runner's
        // `assert_sameValue_str(actual: any, expected: string)`): the `any`
        // side is externref, the string side is a `(ref $AnyString)` struct.
        // The identity bridge below returns false for equal strings from
        // distinct allocations — every string literal materializes a fresh
        // struct, so even `"a" === "a"` failed through this path.
        if (
          otherType.kind === "externref" &&
          ctx.nativeStrings &&
          ctx.anyStrTypeIdx >= 0 &&
          ((leftIsRef && isStringType(leftTsType)) || (rightIsRef && isStringType(rightTsType)))
        ) {
          ensureNativeStringHelpers(ctx);
          const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
          const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
          if (flattenIdx !== undefined && strEqIdx !== undefined) {
            // Stack: [left, right] → anyref temps.
            const tmpRightAny = allocTempLocal(fctx, { kind: "anyref" });
            if (!rightIsRef) fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "local.set", index: tmpRightAny });
            if (!leftIsRef) fctx.body.push({ op: "any.convert_extern" });
            const tmpLeftAny = allocTempLocal(fctx, { kind: "anyref" });
            fctx.body.push({ op: "local.set", index: tmpLeftAny });
            // Both sides strings → content equality; otherwise strict
            // string-vs-non-string is definitively unequal — EXCEPT when both
            // sides are null. (#2161 B0) A null native-string ref is the
            // in-band `undefined` sentinel (a `(string|undefined)[]` element,
            // an unmatched capture group), and a null externref is standalone
            // `undefined` — so `undefined === undefined` must be TRUE through
            // this mixed shape (the test262 harness's
            // `assert_sameValue_str(m[i], expected[i])` with both `undefined`).
            // `ref.test` is false for null, so the old blanket `0` else-arm
            // reported unequal. One-null-one-value stays unequal.
            fctx.body.push({ op: "local.get", index: tmpLeftAny });
            fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
            fctx.body.push({ op: "local.get", index: tmpRightAny });
            fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
            fctx.body.push({ op: "i32.and" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: tmpLeftAny },
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                ...redundantFlattenCall(flattenIdx), // (#4157) callee self-flattens
                { op: "local.get", index: tmpRightAny },
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                ...redundantFlattenCall(flattenIdx), // (#4157) callee self-flattens
                { op: "call", funcIdx: strEqIdx },
              ],
              else: [
                { op: "local.get", index: tmpLeftAny },
                { op: "ref.is_null" },
                { op: "local.get", index: tmpRightAny },
                { op: "ref.is_null" },
                { op: "i32.and" },
              ],
            });
            releaseTempLocal(fctx, tmpLeftAny);
            releaseTempLocal(fctx, tmpRightAny);
            if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
        }
        // (#3154 / task #90) Mixed `(ref $AnyValue)` vs externref/primitive
        // strict equality — VALUE-compare via the tag-aware engine, not box
        // identity. A dynamic element/member read in standalone lowers to
        // `__any_from_extern_honest` → `(ref $AnyValue)` (the #3037 CS1b reader
        // carrier); compared against an `any` PARAM (still a raw externref) or
        // a static primitive, the identity bridge below `ref.eq`'d the CARRIER
        // BOX against the raw value — unconditionally false, so
        // `a[0] === s` failed for the SAME interned symbol, equal strings,
        // etc. (probe-pinned: WAT shows `ref.eq($AnyValue, $Symbol)`). Route
        // instead through the SAME pair the both-$AnyValue arm above uses:
        // classify the non-carrier side honestly (`__any_from_extern_honest` —
        // the classifier the reader itself used, so tags agree) and call the
        // keystone `__any_strict_eq` (§7.2.16: numbers by f64.eq — NaN≠NaN,
        // +0===-0 —, strings by content, objects/symbols by refval identity,
        // cross-tag identity reconciliation for same-ref different-rep).
        // A primitive non-ref side is first boxed to externref by its STATIC
        // brand (symbol → `__box_symbol` interned carrier, boolean →
        // `__box_boolean`, number → `__box_number`) so the classifier sees an
        // honest box. Gated on standalone/wasi + a statically-`$AnyValue`
        // non-null ref side; every other pairing keeps the legacy bridge
        // byte-identical.
        if (ctx.standalone === true || ctx.wasi === true) {
          const refSideType = leftIsRef ? leftType : rightType;
          const refSideIsAnyValue =
            ctx.anyValueTypeIdx >= 0 && refSideType.kind === "ref" && refSideType.typeIdx === ctx.anyValueTypeIdx;
          const otherTsTypeAV = leftIsRef ? rightTsType : leftTsType;
          const otherBoxableAV = otherType.kind === "externref" || otherType.kind === "i32" || otherType.kind === "f64";
          if (refSideIsAnyValue && otherBoxableAV) {
            const honestFromExternIdx = ensureAnyFromExternHelper(ctx, { forceHonest: true });
            ensureAnyHelpers(ctx);
            const strictEqIdxAV = ctx.funcMap.get("__any_strict_eq");
            if (honestFromExternIdx !== undefined && strictEqIdxAV !== undefined) {
              // Brand a primitive other-side by its static TS type so the box
              // preserves the JS tag (the #2785 type-aware-box rule).
              const brandedOther: ValType =
                otherType.kind === "i32" && (otherTsTypeAV.flags & ts.TypeFlags.ESSymbolLike) !== 0
                  ? { kind: "i32", symbol: true }
                  : otherType.kind === "i32" && isBooleanType(otherTsTypeAV)
                    ? { kind: "i32", boolean: true }
                    : otherType;
              // Stack: [left, right] (right on top).
              if (leftIsRef) {
                // Right is the non-carrier side: box (if primitive) + classify in place.
                if (otherType.kind !== "externref") {
                  coerceType(ctx, fctx, brandedOther, { kind: "externref" });
                }
                fctx.body.push({ op: "call", funcIdx: honestFromExternIdx });
              } else {
                // Left is the non-carrier side: save right ($AnyValue), box+classify left, restore.
                const tmpRightAV = allocTempLocal(fctx, rightType);
                fctx.body.push({ op: "local.set", index: tmpRightAV });
                if (otherType.kind !== "externref") {
                  coerceType(ctx, fctx, brandedOther, { kind: "externref" });
                }
                fctx.body.push({ op: "call", funcIdx: honestFromExternIdx });
                fctx.body.push({ op: "local.get", index: tmpRightAV });
                releaseTempLocal(fctx, tmpRightAV);
              }
              fctx.body.push({ op: "call", funcIdx: strictEqIdxAV });
              if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
              return { kind: "i32" };
            }
          }
        }
        if (otherType.kind === "externref") {
          const EQ_HEAP_TYPE_BR = -19;
          // Stack: [left, right]. Save right (as anyref), then handle left.
          const tmpRightAny = allocTempLocal(fctx, { kind: "anyref" });
          if (rightIsRef) {
            fctx.body.push({ op: "local.set", index: tmpRightAny });
          } else {
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "local.set", index: tmpRightAny });
          }
          // Now stack: [left]. Convert left to anyref.
          if (leftIsRef) {
            // left is (ref T) — already anyref-compatible by subtyping.
          } else {
            fctx.body.push({ op: "any.convert_extern" });
          }
          // Stack: [leftAnyref]. Save and probe.
          const tmpLeftAny = allocTempLocal(fctx, { kind: "anyref" });
          fctx.body.push({ op: "local.tee", index: tmpLeftAny });
          fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE_BR });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: tmpRightAny },
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE_BR },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: tmpLeftAny },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE_BR },
                  { op: "local.get", index: tmpRightAny },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE_BR },
                  { op: "ref.eq" },
                ],
                else: [{ op: "i32.const", value: 0 }],
              },
            ],
            else: [{ op: "i32.const", value: 0 }],
          });
          releaseTempLocal(fctx, tmpLeftAny);
          releaseTempLocal(fctx, tmpRightAny);
          if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // Strict equality with one ref and one primitive → always false (===) or true (!==)
        // since objects and primitives are different types in JS strict equality
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // (#2503b) Loose equality `==`/`!=` between a native-string ref and an
      // externref (`any`/object) operand: do NOT ToNumber-coerce the string (the
      // `isNumericOp || isEqOp || isNeqOp` block below would, turning a
      // non-numeric string into NaN → `any == "ab"` wrongly false). The strict
      // `===`/`!==` counterpart is already handled above by the #1914 mixed
      // externref+native-string arm; loose equality has no such arm and fell
      // straight into the numeric coercion. Box the string ref to externref so
      // BOTH operands are externref, then fall through to the standalone
      // abstract-equality cascade (~line 1990), which dispatches on the runtime
      // tag: string⇄string content compare, string⇄number ToNumber (§7.2.15
      // steps 4-7), nullish guard (`null == "ab"` → false), Object→ToPrimitive.
      // This is what makes `any == "lit"` order-independent with the working
      // `"lit" == any` (left-string arm) WITHOUT the over-broad static routing
      // that regressed number-holding `any` (the −3, #2503b first attempt).
      const isLooseEqNeq = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      const otherEqType = leftIsRef ? rightType : leftType;
      // (#2503) The OTHER operand may arrive as an `externref` (an `any`-typed
      // parameter that lost its typeIdx) OR as a nominal STRUCT ref (the static
      // `"x" == (obj as any)` shape, where the AsExpression keeps the concrete
      // `(ref $T)`). Both must be boxed to externref so the abstract-equality
      // cascade can reduce an Object operand via `__to_primitive`. For the
      // struct-ref case the box goes through `coerceType(structRef→externref)`,
      // which materializes a user-ToPrimitive struct as a `$Object` (#2358) so
      // the native helper recognises it. Plain data structs are boxed by plain
      // `extern.convert_any` and the cascade's identity arm handles them.
      const otherIsBoxableRef =
        otherEqType.kind === "externref" || otherEqType.kind === "ref" || otherEqType.kind === "ref_null";
      // (#2503) A wrapper object (`new Boolean`/`new Number`/`new String`) on the
      // OTHER side: with compatibility semantics it keeps its dedicated
      // `__host_loose_eq` routing (the wrapper arm ~line 2483). With the native
      // semantic provider, the wrapper must instead use the native equality
      // a `string == wrapper` must instead go through the native abstract-equality
      // cascade, whose `__to_primitive` already reduces a wrapper via its
      // WRAPPER_PRIMITIVE_KEY slot short-circuit (this is what makes `"1" == new
      // Boolean(true)` / `"-1" == new Number(-1)` work). Without taking THIS arm
      // for the wrapper case, `wrapperEquality` falls to the `else if (isEqOp)`
      // f64 path below, which `__str_to_number`s the string operand → NaN →
      // wrong `false` (the `"x" == new String("x")` residual). So permit a
      // string-ref-vs-wrapper pairing through the externref box.
      const nativeEqualityProvider = ctx.targetProfile.semanticProviders === "native-first";
      const wrapperOverStringAllowed = nativeEqualityProvider && wrapperEquality;
      if (
        isLooseEqNeq &&
        (!wrapperEquality || wrapperOverStringAllowed) &&
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        otherIsBoxableRef &&
        ((leftIsRef && isStringType(leftTsType)) || (rightIsRef && isStringType(rightTsType)))
      ) {
        // Box the native-string ref operand → externref (extern.convert_any).
        // Stack is [left, right]; right is on top.
        if (rightIsRef) {
          coerceType(ctx, fctx, rightType, { kind: "externref" });
          rightType = { kind: "externref" };
        }
        if (leftIsRef) {
          const tmpR = allocTempLocal(fctx, rightType);
          fctx.body.push({ op: "local.set", index: tmpR });
          coerceType(ctx, fctx, leftType, { kind: "externref" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "externref" };
        }
        // Both operands are now externref — fall through to the externref
        // equality cascade below (does NOT re-enter this struct-ref block).
      } else if (isNumericOp || isEqOp || isNeqOp) {
        // For numeric, comparison, and loose equality ops: coerce struct refs → f64 via valueOf
        // Per JS spec, binary + uses ToPrimitive with hint "default",
        // while other numeric/comparison ops use hint "number".
        const hint: "number" | "default" = op === ts.SyntaxKind.PlusToken ? "default" : "number";
        // Coerce right operand (top of stack) first
        if (rightIsRef) {
          coerceType(ctx, fctx, rightType, { kind: "f64" }, hint);
          rightType = { kind: "f64" };
        }
        // Coerce left operand (below right on stack) — save right to local
        if (leftIsRef) {
          const tmpR = allocTempLocal(fctx, rightType);
          fctx.body.push({ op: "local.set", index: tmpR });
          coerceType(ctx, fctx, leftType, { kind: "f64" }, hint);
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        }
        // After valueOf coercion, one side may be f64 (from ref) and the other
        // may still be i32 (boolean/integer). Promote i32 → f64 to avoid type mismatch. (#433)
        if (leftType.kind === "i32" && rightType.kind === "f64") {
          const tmpR = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: tmpR });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        } else if (leftType.kind === "f64" && rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          rightType = { kind: "f64" };
        }
        // Now both operands are f64 — fall through to numeric dispatch below
      }
    }
  }

  // i32 numeric operations: fast mode, native type annotations, known i32 local
  // comparison, — #1120 — arithmetic of two i32 locals whose result is
  // ToInt32-coerced by an enclosing `| 0`, or — #1179 — a bitwise op with
  // i32-pure operands (skip the f64 round-trip entirely).
  if (
    leftType.kind === "i32" &&
    rightType.kind === "i32" &&
    ((ctx.fast && isNumberType(leftTsType)) ||
      bothNativeI32 ||
      hasI32LocalOperand ||
      arithI32WithToInt32Wrap ||
      bitwiseI32)
  ) {
    return compileI32BinaryOp(ctx, fctx, op, expr);
  }

  // i64 operations (bigint detected by compiled type, e.g. from variables)
  if (leftType.kind === "i64" && rightType.kind === "i64") {
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  // Mixed i64/f64 (BigInt vs Number detected by compiled type) — convert i64 to f64 (#227, #228)
  if ((leftType.kind === "i64" && rightType.kind === "f64") || (leftType.kind === "f64" && rightType.kind === "i64")) {
    const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (isStrictEq || isStrictNeq) {
      // Different types → always false (===) or true (!==)
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
      return { kind: "i32" };
    }
    // Convert i64 operand to f64 — right is on top of stack
    if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else {
      // left is i64, need to swap: save right, convert left, restore right
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    // Now both are f64 — use numeric comparison
    const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
    const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isLooseEq) {
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    }
    if (isLooseNeq) {
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  if (
    (isNumberType(leftTsType) || leftType.kind === "f64") &&
    leftType.kind !== "externref" &&
    rightType.kind !== "externref"
  ) {
    // (#1558) Both operands need to be f64 for compileNumericBinaryOp, which
    // emits f64.eq/f64.add/etc. The left operand can be i32 even when the TS
    // type is `number` — e.g. `string.length` returns i32 directly via the
    // wasm:js-string `length` import. Without this coercion, `f64.eq[0]`
    // (operand 0) fails Wasm validation with "expected f64, found i32".
    //
    // The no-cast comparison `a.length === b.length` happens to take the IR
    // path (which already coerces both sides to the f64 hint), but
    // `a.length === (b as string).length` and similar AsExpression / non-null
    // assertion forms fall back to this legacy path. (#1558 was reported on
    // ESLint `Linter.verifyAndFix` for `currentText.length ===
    // secondPreviousText.length` after the latter went through narrowing.)
    if (leftType.kind === "i32" && rightType.kind === "i32") {
      // Both i32 — convert each to f64 in-place. Right is on top of stack.
      fctx.body.push({ op: "f64.convert_i32_s" });
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (leftType.kind === "i32") {
      // Only left is i32 — convert via temp. Right is already f64-ish.
      const tmpR = allocTempLocal(fctx, rightType);
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (rightType.kind === "i32") {
      // Only right is i32 — convert in place (top of stack).
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if (
    (isBooleanType(leftTsType) || leftType.kind === "i32") &&
    leftType.kind !== "externref" &&
    rightType.kind !== "externref"
  ) {
    // Ensure both operands are i32; if right is f64, promote left to f64 and use numeric path
    if (rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      return compileNumericBinaryOp(ctx, fctx, op, expr);
    }
    // For arithmetic / bitwise ops on two i32 operands, use compileI32BinaryOp
    // which emits the matching i32 instruction (i32.add, i32.sub, …).
    // compileBooleanBinaryOp only handles comparison/equality — its `default:`
    // arm falls through silently on `+ - * %` etc., leaving both operands on
    // the stack with no combining op (#1211: caused recursive `f(n - 1)` in
    // any-typed fast-mode functions to be miscompiled into `f(1)` because the
    // TS-checker types the recursive param as `any`, so the i32-arith guard at
    // line ~1202 above (which requires `isNumberType(leftTsType)`) doesn't
    // fire and the dispatch falls into this branch instead).
    if (leftType.kind === "i32" && rightType.kind === "i32" && isNumericOp) {
      return compileI32BinaryOp(ctx, fctx, op, expr);
    }
    return compileBooleanBinaryOp(ctx, fctx, op);
  }

  // Externref in numeric context: unbox externref operands to f64
  if ((leftType.kind === "externref" || rightType.kind === "externref") && isNumericOp) {
    if (rightType.kind === "externref") {
      coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
    }
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Externref equality: when either operand is a known string type, use
  // string content comparison instead of numeric unboxing (#225).
  // For strict equality (===, !==), cross-type comparisons always return false/true (#296).
  if ((leftType.kind === "externref" || rightType.kind === "externref") && (isEqOp || isNeqOp)) {
    const isStrict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    // A for-in target and a representation-widened module binding both carry
    // runtime tags that can disagree with TypeScript's initializer-derived
    // type. Do not constant-fold equality from that stale type; compare the
    // actual boxed value.
    const leftHasStaleType = equalityOperandHasStaleStaticType(ctx, fctx, expr.left);
    const rightHasStaleType = equalityOperandHasStaleStaticType(ctx, fctx, expr.right);
    const leftIsString = !leftHasStaleType && isStringType(leftTsType);
    const rightIsString = !rightHasStaleType && isStringType(rightTsType);
    const leftIsNumber = !leftHasStaleType && isNumberType(leftTsType);
    const rightIsNumber = !rightHasStaleType && isNumberType(rightTsType);
    const leftIsBool = !leftHasStaleType && isBooleanType(leftTsType);
    const rightIsBool = !rightHasStaleType && isBooleanType(rightTsType);

    // #1776: Wasm-native dynamic equality.
    //
    // The JS-host equality fallbacks below import `__host_eq` / `__host_loose_eq`
    // and delegate to JS `===` / `==`. The native-first semantic profile must
    // not emit them even when a JS host exists: the host is an interop boundary,
    // not the language-semantics provider. This path was originally introduced
    // for standalone/WASI, where such imports are unsatisfiable. It also fixed the
    // test262 harness helper `isSameValue` for ~1,436 standalone tests (#1776):
    // `isSameValue(a: any, b: any)` compiles both params to `externref`, so its
    // `a === b` / `a !== a` comparisons all reach this externref-equality path.
    //
    // We replace the host delegation with a Wasm-native tag dispatch on the two
    // boxed operands (left in $l, right in $r):
    //   1. both typeof number  → unbox to f64, compare (f64.eq / f64.ne).
    //      Recovers equal numbers boxed in DISTINCT structs (ref.eq is identity,
    //      not value) AND makes NaN self-comparison work (`a !== a`).
    //   2. both typeof boolean → unbox to i32, compare.
    //   3. otherwise           → reference identity via any.convert_extern +
    //      ref.test/ref.eq on the WasmGC eq heap type; non-eqref or mismatched
    //      tags compare unequal. Per §7.2.16 two distinct non-primitive
    //      references that are not identical are not `===`.
    // This needs no host import and never feeds an externref into an f64/i32
    // helper (acceptance criteria #1776).
    const nativeEqualityProvider = ctx.targetProfile.semanticProviders === "native-first";
    if (nativeEqualityProvider && (leftType.kind === "externref" || rightType.kind === "externref")) {
      const EQ_HEAP = -19; // WasmGC `eq` abstract heap type (signed LEB 0x6d)
      // (#1910 R1) §7.2.13 IsLooselyEqual steps 11-12 — the Object↔primitive arm
      // is LOOSE-only (strict `===` never coerces, §7.2.16). Register the native
      // ToPrimitive engine BEFORE `addUnionImports` / the typeof funcIdx reads so
      // any late imports it adds can't desync the in-progress body — this is the
      // #1890 finalization-shift class, and doing it after the funcIdx reads
      // corrupted the strict `===` path (#1776 isSameValue regressed). Gated on
      // `isLoose` so the strict path is byte-identical to before.
      const isLoose =
        !isStrict && (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken);
      // (#2106 S1) The singleton-regime nullish guard below needs the
      // `__extern_is_nullish` / `__extern_is_undefined` natives for BOTH
      // strict and loose, so pull in the object runtime under the flag too
      // (flag-off: the legacy `isLoose`-only pull, byte-identical).
      const s1Regime = undefinedSingletonActive(ctx);
      if (isLoose || s1Regime) ensureObjectRuntime(ctx);
      addUnionImports(ctx);
      const s1IsNullishIdx = s1Regime ? ctx.funcMap.get("__extern_is_nullish") : undefined;
      const s1IsUndefIdx = s1Regime ? ctx.funcMap.get("__extern_is_undefined") : undefined;
      const typeofNum = ctx.funcMap.get("__typeof_number")!;
      const typeofBool = ctx.funcMap.get("__typeof_boolean")!;
      const typeofBigint = ctx.funcMap.get("__typeof_bigint")!;
      const unboxNum = ctx.funcMap.get("__unbox_number")!;
      const unboxBool = ctx.funcMap.get("__unbox_boolean")!;
      const toBigint = ctx.funcMap.get("__to_bigint")!;

      // (#2605) Box an operand to externref for the tag-dispatch below. A
      // **boolean** i32 MUST be boxed via `__box_boolean` so its runtime tag is
      // `boolean`, not `number`: the default `coerceType` i32→externref path uses
      // `f64.convert_i32_s` + `__box_number`, which turns `true` into the number
      // `1`. The other operand (e.g. an `any`-typed boxed boolean `true`, tag
      // `boolean`) would then mismatch on tag and fall through to reference
      // identity → wrong `false`. This is the dominant cause of standalone
      // `assert.sameValue(x instanceof Set, true)`-style rows failing: the harness
      // passes a boolean into an `any` param and compares it with `===`/`!==`
      // against a `boolean` literal (#2605). Boxing booleans as booleans makes the
      // "both typeof boolean → unbox i32, compare" arm fire correctly.
      const boxOperandToExternref = (operandType: ValType, isBoolOperand: boolean, isSymbolOperand: boolean): void => {
        if (operandType.kind === "externref") return;
        if (operandType.kind === "i32" && isBoolOperand) {
          // addUnionImports (already called above) installs __box_boolean.
          const boxBoolIdx = ctx.funcMap.get("__box_boolean");
          if (boxBoolIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
            return;
          }
        }
        // (#3154 / task #90) A SYMBOL operand is an i32 HANDLE, not a number —
        // the brand-blind fallthrough boxed it via `f64.convert_i32_s` +
        // `__box_number`, so `boxedSymbolElem === symIdentifier` compared a
        // `$Symbol` carrier against a boxed NUMBER (the id) and returned
        // false. Route through the branded i32→externref arm, which resolves
        // `__box_symbol` (the id-interned `$Symbol` carrier in standalone/
        // WASI — #2866 slice 3 — so `ref.eq` in the identity arm holds for
        // same-id boxings).
        if (operandType.kind === "i32" && isSymbolOperand) {
          coerceType(ctx, fctx, { kind: "i32", symbol: true }, { kind: "externref" });
          return;
        }
        coerceType(ctx, fctx, operandType, { kind: "externref" });
      };

      // Coerce both operands to externref temps (right is on top of stack).
      const leftIsSymbolStatic = (leftTsType.flags & ts.TypeFlags.ESSymbolLike) !== 0;
      const rightIsSymbolStatic = (rightTsType.flags & ts.TypeFlags.ESSymbolLike) !== 0;
      const rTmp = allocTempLocal(fctx, { kind: "externref" });
      boxOperandToExternref(rightType, rightIsBool, rightIsSymbolStatic);
      fctx.body.push({ op: "local.set", index: rTmp });
      const lTmp = allocTempLocal(fctx, { kind: "externref" });
      boxOperandToExternref(leftType, leftIsBool, leftIsSymbolStatic);
      fctx.body.push({ op: "local.set", index: lTmp });

      // (#1910 R1) §7.2.13 steps 11-12 — reduce an Object operand to a primitive
      // for LOOSE equality. We overwrite lTmp/rTmp in place with
      // ToPrimitive(operand, default) when EXACTLY ONE side is an Object:
      //   - both Objects → SameType(x,y) (step 1) → IsStrictlyEqual = reference
      //     identity, NEVER ToPrimitive (so we must NOT reduce — the eqref arm at
      //     the bottom of the cascade handles it). The XOR gate preserves this.
      //   - neither Object → no reduction (the `if` is false), primitives flow on.
      // `__to_primitive` is the identity on a primitive (its leading
      // returnIfPrimitive guard returns null/number/boolean/string unchanged), so
      // reducing BOTH operands inside the one-object branch only transforms the
      // object side; the primitive side is untouched. The single ToPrimitive call
      // matches the spec's single recursion: after it both operands are primitive
      // and the recursion bottoms out in the number/string/bigint/boolean arms.
      const toPrimIdx = ctx.funcMap.get("__to_primitive");
      const typeofObject = ctx.funcMap.get("__typeof_object");
      if (isLoose && toPrimIdx !== undefined && typeofObject !== undefined) {
        const reduceOperand = (externLocal: number): Instr[] => [
          { op: "local.get", index: externLocal },
          { op: "ref.null.extern" }, // default hint
          { op: "call", funcIdx: toPrimIdx },
          { op: "local.set", index: externLocal },
        ];
        fctx.body.push(
          // lIsObj XOR rIsObj  ≡  lIsObj !== rIsObj
          { op: "local.get", index: lTmp },
          { op: "call", funcIdx: typeofObject },
          { op: "local.get", index: rTmp },
          { op: "call", funcIdx: typeofObject },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...reduceOperand(lTmp), ...reduceOperand(rTmp)],
          },
        );
      }

      // (#2081) LOOSE null/undefined arm (§7.2.15 steps 2-3): `null == undefined`
      // (and null==null / undefined==undefined) ⇒ true; a nullish vs a
      // non-nullish ⇒ false (never coerces — `null == 0` is false). Under this
      // representation both null and undefined are `ref.null extern`, so a
      // both-nullish test captures all three nullish pairings. LOOSE only — strict
      // `null === undefined` is handled by the type-aware path and must stay
      // false; gate on `!isStrict`. The numeric/bool/string/identity cascade
      // below is the `else`.
      const looseNullish =
        !isStrict && (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken);
      // (#2081) ToNumber for the LOOSE numeric arm: a boxed boolean coerces to
      // 0/1 (§7.2.15 step 8 / §7.1.4 ToNumber(Boolean)), a number unboxes. Used
      // only when the arm has already established the operand is number-or-bool.
      const looseToNum = (externLocal: number): Instr[] => [
        { op: "local.get", index: externLocal },
        { op: "call", funcIdx: typeofBool },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            { op: "local.get", index: externLocal },
            { op: "call", funcIdx: unboxBool },
            { op: "f64.convert_i32_s" },
          ],
          else: [
            { op: "local.get", index: externLocal },
            { op: "call", funcIdx: unboxNum },
          ],
        },
      ];
      const coreEqInstrs: Instr[] = [
        // ── number (loose: number-or-boolean — §7.2.15 step 8 Boolean→ToNumber,
        //    so `true == 1`, `false == 0` compare numerically; strict keeps
        //    number-only since `true === 1` is false by type)? ──
        { op: "local.get", index: lTmp },
        { op: "call", funcIdx: typeofNum },
        ...(looseNullish
          ? ([
              { op: "local.get", index: lTmp },
              { op: "call", funcIdx: typeofBool },
              { op: "i32.or" },
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: rTmp },
        { op: "call", funcIdx: typeofNum },
        ...(looseNullish
          ? ([
              { op: "local.get", index: rTmp },
              { op: "call", funcIdx: typeofBool },
              { op: "i32.or" },
            ] satisfies Instr[])
          : []),
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: looseNullish
            ? [...looseToNum(lTmp), ...looseToNum(rTmp), { op: "f64.eq" }]
            : [
                { op: "local.get", index: lTmp },
                { op: "call", funcIdx: unboxNum },
                { op: "local.get", index: rTmp },
                { op: "call", funcIdx: unboxNum },
                { op: "f64.eq" },
              ],
          else: [
            // ── boolean? ──
            { op: "local.get", index: lTmp },
            { op: "call", funcIdx: typeofBool },
            { op: "local.get", index: rTmp },
            { op: "call", funcIdx: typeofBool },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: lTmp },
                { op: "call", funcIdx: unboxBool },
                { op: "local.get", index: rTmp },
                { op: "call", funcIdx: unboxBool },
                { op: "i32.eq" },
              ],
              else: [
                // ── bigint? ──
                { op: "local.get", index: lTmp },
                { op: "call", funcIdx: typeofBigint },
                { op: "local.get", index: rTmp },
                { op: "call", funcIdx: typeofBigint },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: lTmp },
                    { op: "call", funcIdx: toBigint },
                    { op: "local.get", index: rTmp },
                    { op: "call", funcIdx: toBigint },
                    { op: "i64.eq" },
                  ],
                  else: [
                    // ── reference identity ──
                    // Both must be WasmGC eqref for ref.eq; otherwise unequal.
                    { op: "local.get", index: lTmp },
                    { op: "any.convert_extern" },
                    { op: "local.get", index: rTmp },
                    { op: "any.convert_extern" },
                    ...(() => {
                      const lAny = allocTempLocal(fctx, { kind: "anyref" });
                      const rAny = allocTempLocal(fctx, { kind: "anyref" });
                      // ── eqref identity ── (the final fallback arm)
                      const identityArm: Instr[] = [
                        { op: "local.get", index: lAny },
                        { op: "ref.test", typeIdx: EQ_HEAP },
                        { op: "local.get", index: rAny },
                        { op: "ref.test", typeIdx: EQ_HEAP },
                        { op: "i32.and" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "i32" } },
                          then: [
                            { op: "local.get", index: lAny },
                            { op: "ref.cast", typeIdx: EQ_HEAP },
                            { op: "local.get", index: rAny },
                            { op: "ref.cast", typeIdx: EQ_HEAP },
                            { op: "ref.eq" },
                          ],
                          // (#2161 B0) `ref.test` is FALSE for null, so two
                          // nullish operands (both `ref.null` — the standalone
                          // undefined/null representation, e.g. two `undefined`
                          // array elements in the test262 compareArray harness)
                          // used to land here and report UNEQUAL. Both-null ⇒
                          // equal (`undefined === undefined` / `null === null`);
                          // one-null-one-value stays 0 via the i32.and.
                          else: [
                            { op: "local.get", index: lAny },
                            { op: "ref.is_null" },
                            { op: "local.get", index: rAny },
                            { op: "ref.is_null" },
                            { op: "i32.and" },
                          ],
                        },
                      ];
                      // ── string? ── (#1914) Native strings are VALUE-compared
                      // (§7.2.16 "If x is a String"). Without this, `a === b` over
                      // `any`-typed string operands (e.g. the test262 harness's
                      // `isSameValue`) fell to ref.eq identity and returned false
                      // for equal strings from distinct allocations. Falls back to
                      // the eqref identity arm when not both strings.
                      const stringAndIdentityArm = (): Instr[] => {
                        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
                          ensureNativeStringHelpers(ctx);
                          const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
                          const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
                          if (flattenIdx !== undefined && strEqIdx !== undefined) {
                            return [
                              { op: "local.get", index: lAny },
                              { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
                              { op: "local.get", index: rAny },
                              { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
                              { op: "i32.and" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                then: [
                                  { op: "local.get", index: lAny },
                                  { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                                  ...redundantFlattenCall(flattenIdx), // (#4157)
                                  { op: "local.get", index: rAny },
                                  { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                                  ...redundantFlattenCall(flattenIdx), // (#4157)
                                  { op: "call", funcIdx: strEqIdx },
                                ],
                                else: identityArm,
                              },
                            ];
                          }
                        }
                        return identityArm;
                      };
                      const seq: Instr[] = [
                        { op: "local.set", index: rAny },
                        { op: "local.set", index: lAny },
                      ];
                      // ── (#2081) LOOSE String ⇄ Number arm (§7.2.15 steps 4-7) ──
                      // For `==`/`!=` only (NOT strict — `"1" === 1` is false by
                      // type), when EXACTLY one operand is a native string and the
                      // other is a number, compare ToNumber(both): ToNumber(string)
                      // via the §7.1.4.1 `__str_to_number` scanner (NaN for
                      // unparseable, 0 for empty, hex/inf), `__unbox_number` for the
                      // numeric side, then `f64.eq`. Without this, `"1" == 1` fell
                      // through the string==string arm (right isn't a string) to
                      // ref.eq identity → wrong `false`. The boolean side is already
                      // covered by the typeof-boolean arm above (`true == 1`).
                      // `parseFloat` is deliberately NOT used (Number("0xff")=255 vs
                      // parseFloat("0xff")=NaN — §7.1.4.1).
                      let looseStrNumEmitted = false;
                      if (
                        !isStrict &&
                        ctx.nativeStrings &&
                        ctx.anyStrTypeIdx >= 0 &&
                        (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)
                      ) {
                        if (!ctx.funcMap.has("__str_to_number")) {
                          emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
                        }
                        const strToNumIdx = ctx.funcMap.get("__str_to_number");
                        if (strToNumIdx !== undefined) {
                          looseStrNumEmitted = true;
                          // ToNumber(side): native string → __str_to_number(extern);
                          // a boxed boolean → §7.1.4 ToNumber(Boolean) = 0/1; else
                          // (a boxed number) → __unbox_number.
                          // (#2503) The boolean arm matters once an Object operand
                          // reduces to a boolean via ToPrimitive (e.g. `"1" == new
                          // Boolean(true)` → §7.2.15 step 8 String⇄Boolean: compare
                          // ToNumber both → `1 == 1`). Before this, the reduced
                          // boolean fell to the identity arm → spurious `false`.
                          const toNumberOf = (anyLocal: number, externLocal: number): Instr[] => [
                            { op: "local.get", index: anyLocal },
                            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "f64" } },
                              then: [
                                { op: "local.get", index: externLocal },
                                { op: "call", funcIdx: strToNumIdx },
                              ],
                              else: [
                                // boolean → 0/1, else unbox the number.
                                { op: "local.get", index: externLocal },
                                { op: "call", funcIdx: typeofBool },
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: { kind: "f64" } },
                                  then: [
                                    { op: "local.get", index: externLocal },
                                    { op: "call", funcIdx: unboxBool },
                                    { op: "f64.convert_i32_s" },
                                  ],
                                  else: [
                                    { op: "local.get", index: externLocal },
                                    { op: "call", funcIdx: unboxNum },
                                  ],
                                },
                              ],
                            },
                          ];
                          // §7.2.15: String⇄Number (steps 4-7) and String⇄Boolean
                          // (step 8 — ToNumber the boolean) both ToNumber-compare.
                          // Fire when exactly one side is a native string and the
                          // OTHER is a number or a boolean.
                          const isNumOrBool = (externLocal: number): Instr[] => [
                            { op: "local.get", index: externLocal },
                            { op: "call", funcIdx: typeofNum },
                            { op: "local.get", index: externLocal },
                            { op: "call", funcIdx: typeofBool },
                            { op: "i32.or" },
                          ];
                          // (lIsStr && rIsNumOrBool) || (rIsStr && lIsNumOrBool)
                          seq.push(
                            { op: "local.get", index: lAny },
                            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
                            ...isNumOrBool(rTmp),
                            { op: "i32.and" },
                            { op: "local.get", index: rAny },
                            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
                            ...isNumOrBool(lTmp),
                            { op: "i32.and" },
                            { op: "i32.or" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "i32" } },
                              then: [...toNumberOf(lAny, lTmp), ...toNumberOf(rAny, rTmp), { op: "f64.eq" }],
                              else: stringAndIdentityArm(),
                            },
                          );
                        }
                      }
                      if (!looseStrNumEmitted) seq.push(...stringAndIdentityArm());
                      releaseTempLocal(fctx, lAny);
                      releaseTempLocal(fctx, rAny);
                      return seq;
                    })(),
                  ],
                },
              ],
            },
          ],
        },
      ];
      // For loose equality, wrap the core cascade in the nullish guard
      // (§7.2.15 steps 2-3): both nullish ⇒ true; nullish-vs-non-nullish ⇒ false.
      //
      // (#2106 S1) Under the `undefinedSingleton` regime the guard applies to
      // BOTH strict and loose — and is keyed on the regime predicates, not bare
      // `ref.is_null` (which no longer catches the non-null singleton):
      //   loose:  both nullish (`__extern_is_nullish`) ⇒ true.
      //   strict (§7.2.16 via SameType, null and undefined now DISTINCT):
      //     (both null) ∨ (both undefined) ⇒ true; any other nullish pairing ⇒
      //     false. This is the #1961 `bothNullishGuard` re-keyed on the
      //     singleton, exactly as the S1 spec prescribed — it fixes dynamic
      //     `undefined === undefined` / `null === null` (the legacy identity
      //     arm answers 0 for null refs) while keeping `null === undefined`
      //     false.
      const s1NullishGuard = s1Regime && s1IsNullishIdx !== undefined && s1IsUndefIdx !== undefined;
      const eqInstrs: Instr[] = s1NullishGuard
        ? [
            { op: "local.get", index: lTmp },
            { op: "call", funcIdx: s1IsNullishIdx! },
            { op: "local.get", index: rTmp },
            { op: "call", funcIdx: s1IsNullishIdx! },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: isStrict
                ? [
                    { op: "local.get", index: lTmp },
                    { op: "ref.is_null" },
                    { op: "local.get", index: rTmp },
                    { op: "ref.is_null" },
                    { op: "i32.and" },
                    { op: "local.get", index: lTmp },
                    { op: "call", funcIdx: s1IsUndefIdx! },
                    { op: "local.get", index: rTmp },
                    { op: "call", funcIdx: s1IsUndefIdx! },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]
                : [
                    { op: "local.get", index: lTmp },
                    { op: "call", funcIdx: s1IsNullishIdx! },
                    { op: "local.get", index: rTmp },
                    { op: "call", funcIdx: s1IsNullishIdx! },
                    { op: "i32.and" },
                  ],
              else: coreEqInstrs,
            },
          ]
        : looseNullish
          ? [
              { op: "local.get", index: lTmp },
              { op: "ref.is_null" },
              { op: "local.get", index: rTmp },
              { op: "ref.is_null" },
              // (lNull || rNull): if EITHER is nullish, the result is whether BOTH
              // are nullish (true) or not (false) — never coerce against a nullish.
              { op: "i32.or" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: lTmp },
                  { op: "ref.is_null" },
                  { op: "local.get", index: rTmp },
                  { op: "ref.is_null" },
                  { op: "i32.and" },
                ],
                else: coreEqInstrs,
              },
            ]
          : coreEqInstrs;
      for (const ins of eqInstrs) fctx.body.push(ins);
      if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
      releaseTempLocal(fctx, rTmp);
      releaseTempLocal(fctx, lTmp);
      return { kind: "i32" };
    }

    if (!nativeEqualityProvider && (leftHasStaleType || rightHasStaleType)) {
      return emitHostEqualityFromStack(ctx, fctx, leftType, rightType, isStrict, isNeqOp);
    }

    // Wrapper object semantics (#1111): `new Number(n)`, `new String(s)`,
    // `new Boolean(b)` are OBJECTS (typeof x === "object"), not primitives.
    // Strict equality between a wrapper and any primitive is always false.
    // Equality between two wrappers is reference identity.
    // Route through JS host == / === with NO numeric fallback so the answer
    // matches JS spec exactly (the numeric fallback below is only safe when
    // both operands are boxed primitives, not when either is a real JS object).
    const leftIsWrapper = isWrapperObjectType(leftTsType);
    const rightIsWrapper = isWrapperObjectType(rightTsType);
    if (leftIsWrapper || rightIsWrapper) {
      // Coerce operands to externref (right is on top of stack).
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostFn = isStrict ? "__host_eq" : "__host_loose_eq";
      const hostIdx = ensureLateImport(ctx, hostFn, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get(hostFn) ?? hostIdx;
      if (finalHostIdx === undefined) throw new Error(`Missing import after ensureLateImport: ${hostFn}`);
      fctx.body.push({ op: "call", funcIdx: finalHostIdx });
      if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
      return { kind: "i32" };
    }

    // Strict equality: different JS types → always false (===) or true (!==)
    if (isStrict) {
      const leftJsKind = leftIsString ? "string" : leftIsNumber ? "number" : leftIsBool ? "boolean" : "other";
      const rightJsKind = rightIsString ? "string" : rightIsNumber ? "number" : rightIsBool ? "boolean" : "other";
      if (leftJsKind !== "other" && rightJsKind !== "other" && leftJsKind !== rightJsKind) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }
    }

    // (#1986/#1987) Strict equality where exactly one side is an `any`-typed
    // externref and the other is a known primitive (number / boolean) — or both
    // sides are externref `any`. The numeric fallback further down unboxes the
    // externref to f64 via ToNumber (null→0, false→0, "1"→1) and emits f64.eq,
    // which makes `===` behave LOOSER than `==` (`null === 0` → true). Per §7.2.16
    // IsStrictlyEqual must short-circuit to false on a type mismatch with no
    // coercion. Route through `__host_eq` (JS `===`) instead — it gets the spec
    // exactly right, including +0 === -0 (true) and NaN !== NaN. JS-host only; the
    // native-first path is handled above by the tag-dispatch block.
    // Strings keep their dedicated `wasm:js-string equals` path below. A
    // boolean-typed side is also excluded: `coerceType(i32 → externref)` boxes
    // it as a JS *number* (`__box_number`), so `__host_eq(true, 1)` would be
    // false — boolean operands keep the existing (correct) lowering, and a
    // boolean `any` compared to a boolean falls through to it.
    if (isStrict && !nativeEqualityProvider && !leftIsString && !rightIsString && !leftIsBool && !rightIsBool) {
      // (#3154 / task #90) Brand a statically-SYMBOL i32 operand so the
      // externref box preserves the JS tag: the brand-blind
      // `coerceType(i32 → externref)` fallthrough boxed a symbol HANDLE via
      // `__box_number`, so the host strict-eq compared a real symbol against a
      // boxed number id and was always false (`anyElem === moduleScopedSymbol`
      // failed). With the brand, `coerceType` routes through `__box_symbol`
      // (host symbol cache → identity-stable JS symbol), and JS `===` answers
      // symbol identity.
      const brandSymbolIfStatic = (t: ValType, tsType: ts.Type): ValType =>
        t.kind === "i32" && (tsType.flags & ts.TypeFlags.ESSymbolLike) !== 0 ? { kind: "i32", symbol: true } : t;
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, brandSymbolIfStatic(rightType, rightTsType), { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, brandSymbolIfStatic(leftType, leftTsType), { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostIdx = ensureLateImport(
        ctx,
        "__host_eq",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get("__host_eq") ?? hostIdx;
      if (finalHostIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalHostIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }

    const eitherIsString = leftIsString || rightIsString;
    const bothAreStrings = leftIsString && rightIsString;
    // (#1134) For LOOSE equality where exactly ONE side is a string and the
    // other is a primitive, route through `__host_loose_eq` instead of
    // `wasm:js-string equals`. The wasm equals does strict string===string
    // and never coerces — it silently returns false for `1 == "1"`,
    // `255 == "0xff"`, `0 == ""`, etc.
    if (eitherIsString && !isStrict && !bothAreStrings) {
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostIdx = ensureLateImport(
        ctx,
        "__host_loose_eq",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get("__host_loose_eq") ?? hostIdx;
      if (finalHostIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: finalHostIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }
    if (eitherIsString) {
      // Both strings (or strict equality where one is string): use
      // `wasm:js-string equals` — fast string-string compare.
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      addStringImports(ctx);
      const equalsIdx = ctx.jsStringImports.get("equals");
      if (equalsIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: equalsIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }

    // Reference identity fast-path for externref equality.
    // When both operands are externref (e.g. objects stored as any), check if they
    // are the same GC reference before falling back to numeric unboxing.
    // This fixes `var a = {}; var b = a; a === b` which was incorrectly returning false
    // because numeric unboxing of objects produces NaN, and NaN !== NaN.
    // Uses any.convert_extern to get anyref, then ref.test/ref.cast to eqref for ref.eq.
    // The eq abstract heap type is encoded as -19 in signed LEB128 (= 0x6d).
    const EQ_HEAP_TYPE = -19;
    if (
      leftType.kind === "externref" &&
      rightType.kind === "externref" &&
      !leftIsString &&
      !rightIsString &&
      !leftIsNumber &&
      !rightIsNumber &&
      !leftIsBool &&
      !rightIsBool
    ) {
      // Save both externrefs to temp locals for potential reuse in numeric fallback
      const tmpRight = allocTempLocal(fctx, { kind: "externref" });
      const tmpLeft = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: tmpRight });
      fctx.body.push({ op: "local.set", index: tmpLeft });

      // Convert left to anyref and test if it's an eqref (GC ref)
      fctx.body.push({ op: "local.get", index: tmpLeft });
      fctx.body.push({ op: "any.convert_extern" });
      const tmpAnyLeft = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.tee", index: tmpAnyLeft });
      fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Left is eqref-compatible — check right too
          { op: "local.get", index: tmpRight },
          { op: "any.convert_extern" },
          ...(() => {
            const tmpAnyRight = allocTempLocal(fctx, { kind: "anyref" });
            const instrs: Instr[] = [
              { op: "local.tee", index: tmpAnyRight },
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // Both are eqref — cast and compare with ref.eq
                  { op: "local.get", index: tmpAnyLeft },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "local.get", index: tmpAnyRight },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "ref.eq" },
                ],
                else: [
                  // Right is not eqref. For STRICT equality (===), a GC eqref
                  // and a non-eqref host externref cannot be ===, so 0 is
                  // definitive. For LOOSE equality (==), JS coercion may still
                  // make them equal — e.g. `0 == -0` where the i31ref +0 is
                  // eqref and the HeapNumber -0 is not. Push -1 sentinel so
                  // the outer `if (i32.ne result -1)` branches into the host
                  // fallback (`__host_loose_eq`) which calls JS `==`. (#1134)
                  { op: "i32.const", value: isStrict ? 0 : -1 },
                ],
              },
            ];
            releaseTempLocal(fctx, tmpAnyRight);
            return instrs;
          })(),
        ],
        else: [
          // Left is not eqref — fall through to numeric / host comparison
          // by pushing -1 as sentinel to indicate "not handled"
          { op: "i32.const", value: -1 },
        ],
      });
      releaseTempLocal(fctx, tmpAnyLeft);

      // Check if the identity comparison produced a definitive result (0 or 1)
      // vs the sentinel -1 (meaning we need numeric fallback)
      const identityResult = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: identityResult });
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Identity check produced 0 or 1 — use it directly
          // For != / !==, negate
          { op: "local.get", index: identityResult },
          ...(isNeqOp ? ([{ op: "i32.eqz" }] satisfies Instr[]) : []),
        ],
        else: ((): Instr[] => {
          // Host equality fallback — two host externrefs (e.g. functions
          // like `Array === Array`) are not WasmGC eqrefs, so ref.eq cannot
          // compare them. For strict equality, `__host_eq` calls JS `===`.
          // For loose equality, `__host_loose_eq` calls JS `==` which
          // handles null==undefined and type coercion per §7.2.15. (#1065, #1134)
          addUnionImports(ctx);
          if (isStrict) {
            // Strict equality: __host_eq (JS ===) for reference identity.
            // If that returns false, fall through to numeric unboxing for
            // boxed numbers that differ in identity but have the same value. (#1065)
            //
            // (#1383) Gate the numeric-unbox fallback on a runtime typeof
            // check — only fire it when BOTH operands are typeof === "number".
            // The fallback was load-bearing for genuinely-different-identity
            // boxed numbers (V8 sometimes returns different externref ids for
            // numerically-equal JS numbers), but it incorrectly succeeded for
            // cross-type strict comparisons too: `null === 0` produced
            // `__unbox_number(null) === 0`, `__unbox_number(0) === 0`, true.
            // Spec §7.2.16 says strict equality between values of different
            // types is always false.
            //
            // Earlier PR #272 tried to drop the fallback entirely and caused
            // -12 net test262 — the fallback was masking unrelated mismatches
            // (boolean / undefined externrefs that also happen to land in
            // the externref-vs-externref path). Gating with a typeof check
            // preserves the load-bearing same-type case AND fixes the
            // cross-type leak.
            const hostEqIdx = ensureLateImport(
              ctx,
              "__host_eq",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            const finalHostEqIdx = ctx.funcMap.get("__host_eq") ?? hostEqIdx;
            const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
            const unboxIdx = ctx.funcMap.get("__unbox_number")!;
            return [
              { op: "local.get", index: tmpLeft },
              { op: "local.get", index: tmpRight },
              { op: "call", funcIdx: finalHostEqIdx! },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: isNeqOp ? 0 : 1 }],
                else: [
                  // Both operands must be JS numbers for the numeric-unbox
                  // fallback to be sound. Otherwise host_eq's `false` is
                  // definitive (cross-type strict equality is always false).
                  { op: "local.get", index: tmpLeft },
                  { op: "call", funcIdx: typeofNumIdx },
                  { op: "local.get", index: tmpRight },
                  { op: "call", funcIdx: typeofNumIdx },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      // Both numbers: numeric-unbox compare is safe and
                      // recovers same-value-different-identity cases.
                      { op: "local.get", index: tmpLeft },
                      { op: "call", funcIdx: unboxIdx },
                      { op: "local.get", index: tmpRight },
                      { op: "call", funcIdx: unboxIdx },
                      { op: isEqOp ? "f64.eq" : "f64.ne" },
                    ],
                    else: [
                      // Cross-type or non-number: host_eq's false is final.
                      { op: "i32.const", value: isNeqOp ? 1 : 0 },
                    ],
                  },
                ],
              },
            ];
          } else {
            // Loose equality fallback for two externref `any` operands that are
            // not eqref-identical.
            //
            // (#2081) The native semantic provider must not use
            // `__host_loose_eq`; in standalone/WASI it is also unsatisfiable. It
            // previously leaked into the module and made
            // `("1" as any) == (1 as any)` either fail instantiation or return a
            // wrong `false` (ref-identity never coerces string⇄number). Route
            // through the NATIVE IsLooselyEqual instead: box both externrefs to
            // `$AnyValue` (`__any_from_extern` → tag5 string / tag3 number / tag4
            // bool / tag1 null) and call `__any_eq`, whose §7.2.15 arms
            // (incl. the String⇄Number arm added in this PR) implement the spec
            // coercion natively. Compatibility mode keeps `__host_loose_eq`
            // (JS `==`) unchanged.
            // (#1917 E6) The standalone native IsLooselyEqual tail — box both
            // externrefs to `$AnyValue` and call the keystone `__any_eq` — is the
            // same tag-5-sensitive dispatch the coercion engine owns for E3, so it
            // lives in `emitAnyEqFromExternTemps`. `null` ⇒ helpers unavailable
            // (should not happen) → fall through to the host import below.
            const nativeEqualityProvider = ctx.targetProfile.semanticProviders === "native-first";
            if (nativeEqualityProvider) {
              const nativeLooseEq = emitAnyEqFromExternTemps(ctx, tmpLeft, tmpRight, isNeqOp);
              if (nativeLooseEq !== null) {
                return nativeLooseEq;
              }
            }
            // Loose equality: __host_loose_eq (JS ==) handles all coercion
            // rules including null==undefined per §7.2.15. The result is
            // definitive — no numeric fallback needed. (#1134)
            const hostLooseEqIdx = ensureLateImport(
              ctx,
              "__host_loose_eq",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            const finalHostLooseEqIdx = ctx.funcMap.get("__host_loose_eq") ?? hostLooseEqIdx;
            return [
              { op: "local.get", index: tmpLeft },
              { op: "local.get", index: tmpRight },
              { op: "call", funcIdx: finalHostLooseEqIdx! },
              ...(isNeqOp ? ([{ op: "i32.eqz" }] satisfies Instr[]) : []),
            ];
          }
        })(),
      });
      releaseTempLocal(fctx, identityResult);
      releaseTempLocal(fctx, tmpRight);
      releaseTempLocal(fctx, tmpLeft);
      return { kind: "i32" };
    }

    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    // Coerce/unbox right side (top of stack) to f64
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    // Coerce/unbox left side (below right on stack) to f64
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (leftType.kind === "i32") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    fctx.body.push({ op: isEqOp ? "f64.eq" : "f64.ne" });
    return { kind: "i32" };
  }

  // ── Fallback: coerce remaining type mismatches to f64 for numeric ops ──
  // When operand types don't match any specific path above (e.g. ref + externref,
  // i64 + externref, or other ambiguous combos), try to coerce both to f64.
  if (isNumericOp) {
    // Coerce right operand (top of stack) to f64
    if (rightType.kind === "externref") {
      coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else if (rightType.kind === "ref" || rightType.kind === "ref_null") {
      coerceType(ctx, fctx, rightType, { kind: "f64" });
    }
    // Coerce left operand (below right on stack) — save right to local
    if (
      leftType.kind === "externref" ||
      leftType.kind === "i32" ||
      leftType.kind === "i64" ||
      leftType.kind === "ref" ||
      leftType.kind === "ref_null"
    ) {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      if (leftType.kind === "externref") {
        coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      } else if (leftType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      } else if (leftType.kind === "i64") {
        fctx.body.push({ op: "f64.convert_i64_s" });
      } else if (leftType.kind === "ref" || leftType.kind === "ref_null") {
        coerceType(ctx, fctx, leftType, { kind: "f64" });
      }
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  reportError(ctx, expr, `Unsupported binary operator for type`);
  return null;
}
