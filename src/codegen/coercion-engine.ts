// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 Step 1 — the single JS-semantic coercion engine (ToString first).
 *
 * Background: the §7.1.17 ToString matrix was hand-rolled across the WasmGC
 * backend — the host `+`-concat operand coercion, the host template span loop,
 * the standalone/native `+`-concat operand, the native template span loop, and
 * the `String(x)` lowering each re-implemented the same value→string cascade.
 * A fix to one copy was structurally invisible to the others (the June-2026
 * bug corpus: #2005/#2006/#1998/#2074 — all fixed per-copy, but the *next*
 * divergence had nowhere to be caught). This module is the §5 single home those
 * sites delegate to; the #2108 drift gate ratchets the per-file vocabulary
 * counts down as each site migrates. See
 * plan/log/analysis-2026-06/03-coercion-engine-spec.md and the Implementation
 * Plan in plan/issues/1917-single-coercion-engine.md.
 *
 * Scope of THIS module right now: `emitToString` for the **expression-based**
 * ToString sites (an operand already on the value stack, classified from its
 * compiled `ValType` + static TS type). It is a faithful, behaviour-neutral
 * consolidation of those copies — each caller keeps its exact hint, output
 * type, and dynamic tail; the engine just owns the one cascade they shared.
 *
 * Deliberately NOT in this module yet (later #1917 increments):
 *   - the array-`join` `elemToStr` builder (operates on a raw array *slot*, not
 *     a compiled expression, and is `$Hole`-aware) — folds in only once
 *     `emitToString` grows a slot-source variant;
 *   - `emitToNumber` / `emitToBoolean` / `emitToPrimitive` / equality (Steps
 *     2-5).
 *
 * Representation-level (ValType→ValType) conversions still go through Step 0's
 * `coercionPlan` (coercion-plan.ts); this module is the JS-semantic layer on
 * top and never re-hand-rolls a box/unbox row.
 */
import { isBooleanType, isStringType } from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { TypeFact } from "../checker/oracle.js";
import { ts } from "../ts-api.js";
import { ensureAnyFromExternHelper, ensureExternStrictEqHelper } from "./any-helpers.js";
import { boxToAny } from "./value-tags.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { noJsHost } from "./expressions/helpers.js";
import { addUnionImports, nativeStringType } from "./index.js";
import { ensureAnyToStringHelper, ensureStrTruthyHelper, stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getBoolToStringEmitter, getNativeStringRefFromExternrefEmitter } from "./string-emitter-registry.js";
import { buildClosureRefTestArms } from "./closure-classifier.js";
import {
  compileExpression,
  compileStringLiteral,
  ensureAnyHelpers,
  ensureLateImport,
  flushLateImportShifts,
  isAnyValue,
  registerEnsureExternrefToStringProvider,
} from "./shared.js";
import { coerceType, tryStructToString } from "./type-coercion.js";

/**
 * The three coercion modes the backend dispatches over. Derived once from the
 * three ad-hoc spellings that exist today so callers stop re-testing them.
 *
 *   - `"standalone"`        — `noJsHost(ctx)` (--target wasi / standalone): pure
 *     Wasm, native `$AnyString` strings, no JS host bridge.
 *   - `"native-strings-host"` — `ctx.nativeStrings` with a JS host present:
 *     native `$AnyString` strings but the host `__extern_*` bridge is available.
 *   - `"js-host"`           — classic externref `wasm:js-string` strings.
 */
export type CoercionMode = "js-host" | "native-strings-host" | "standalone";

export function coercionMode(ctx: CodegenContext): CoercionMode {
  if (noJsHost(ctx)) return "standalone";
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) return "native-strings-host";
  return "js-host";
}

/**
 * Build the shared runtime ToPrimitive call for a value already on the stack.
 * Raw runtime bodies do not have an AST expression for `emitToString`, so this
 * is their narrow entry point into the coercion engine instead of spelling the
 * helper lookup and hint ABI at each call site.
 */
export function runtimeToPrimitiveInstrs(ctx: CodegenContext, hint: "string" | "number" | "default"): Instr[] | null {
  const funcIdx = ctx.funcMap.get("__to_primitive");
  if (funcIdx === undefined) return null;
  if (hint === "default") {
    return [{ op: "ref.null.extern" }, { op: "call", funcIdx }];
  }
  addStringConstantGlobal(ctx, hint);
  return [...stringConstantExternrefInstrs(ctx, hint), { op: "call", funcIdx }];
}

/** True when the active mode represents strings as a native `$AnyString` GC ref. */
function isNativeStringMode(mode: CoercionMode): boolean {
  return mode === "standalone" || mode === "native-strings-host";
}

/**
 * Resolve the canonical runtime provider for ToString(externref).
 *
 * This stays in the coercion engine so nested control-flow builders that need
 * a raw function index do not reintroduce the sealed host-coercion vocabulary.
 * The shared delegate exposes it to type-coercion.ts without creating the
 * reverse static import cycle.
 */
function ensureExternrefToStringProviderImpl(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: ToStringHint,
): number | undefined {
  const native = isNativeStringMode(coercionMode(ctx));
  const importName = !native && hint === "default" ? "__extern_to_string_default" : "__extern_toString";
  const provisionalIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  return ctx.funcMap.get(importName) ?? provisionalIdx;
}

/**
 * The ToString hint, distinguishing the genuinely-different per-context spec
 * operations the matrices encode for a struct/ref operand:
 *   - `"string"`  — ToString proper (§7.1.17): a template span (`` `${obj}` ``)
 *     and `String(obj)` walk @@toPrimitive("string")/toString.
 *   - `"default"` — the `+` operator's ToPrimitive(default) (valueOf-first,
 *     §7.1.1.1 / #2022): `obj + ""` must use `valueOf`. Only differs from
 *     `"string"` on the struct/ref arm.
 */
export type ToStringHint = "string" | "default";

type ToStringStaticType = ts.Type | TypeFact;

function isCheckerType(type: ToStringStaticType): type is ts.Type {
  return typeof (type as ts.Type).flags === "number";
}

function isStaticStringType(type: ToStringStaticType): boolean {
  if (isCheckerType(type)) return isStringType(type);
  return type.kind === "string" || (type.kind === "builtin" && type.name === "String");
}

function isStaticBooleanType(type: ToStringStaticType): boolean {
  return isCheckerType(type) ? isBooleanType(type) : type.kind === "boolean";
}

function isStaticNullType(type: ToStringStaticType): boolean {
  return isCheckerType(type) ? (type.flags & ts.TypeFlags.Null) !== 0 : type.kind === "null";
}

function isStaticUndefinedType(type: ToStringStaticType): boolean {
  return isCheckerType(type)
    ? (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
    : type.kind === "undefined" || type.kind === "void";
}

/**
 * #3540 — Give compiled closures the NativeFunction source facade in the
 * standalone ToString native after closure shapes have been finalized.
 *
 * The runtime helper is registered before every closure wrapper exists, so its
 * closure classifier arm must be installed during the same finalization pass
 * that seals `typeof`. The coercion engine owns the string result and dispatch;
 * the closure finalizer only decides when the complete classifier is available.
 */
export function installCompiledClosureToStringArm(ctx: CodegenContext): void {
  const toStringFn = ctx.mod.functions.find((fn) => (fn as { name?: string }).name === "__extern_toString") as
    | WasmFunction
    | undefined;
  if (!toStringFn) return;

  const anyLocalIdx = 1 + toStringFn.locals.length;
  toStringFn.locals.push({ name: "$closure_tostring_any", type: { kind: "anyref" } });
  toStringFn.body = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocalIdx },
    ...buildClosureRefTestArms(ctx, anyLocalIdx, [
      ...stringConstantExternrefInstrs(ctx, "function () { [native code] }"),
      { op: "return" },
    ]),
    ...toStringFn.body,
  ];
}

/**
 * Emit `ToString(operand)` for an operand that has ALREADY been compiled to the
 * top of the value stack with ValType `valType` and static checker/oracle type
 * fact `staticType`.
 *
 * This is the consolidated cascade the expression-based ToString copies shared:
 *   void            → "undefined"
 *   i32 boolean     → "true"/"false"          (emitBoolToString)
 *   f64/i32/i64     → number_toString          (numeric stringify)
 *   externref null  → "null"
 *   externref undef → "undefined"
 *   externref str   → passthrough (already a string)
 *   externref other → __extern_toString / __extern_to_string_default (by hint)
 *   ref/ref_null    → tryStructToString → $__any_to_string  (native)
 *                     coerceType(hint) / __extern_to_string_default (host)
 *
 * Returns the ValType left on the stack (externref in js-host mode, a native
 * `ref $AnyString` in native/standalone mode), or `null` for the void arm where
 * a string literal was pushed (callers treat both as "a string is on the stack").
 *
 * Each caller passes its own `hint` so the per-context policy (template "string"
 * vs `+` "default") is preserved byte-for-byte.
 *
 * NOTE on Symbol: §7.1.17 ToString(Symbol) throws TypeError. The callers guard
 * that BEFORE compiling the operand (`tryThrowOnSymbolStringCoercion`), because
 * the throw must short-circuit operand evaluation; the engine assumes a
 * non-symbol operand on the stack.
 */
export function emitToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  valType: ValType | null,
  staticType: ToStringStaticType,
  hint: ToStringHint,
): ValType {
  const mode = coercionMode(ctx);
  const native = isNativeStringMode(mode);

  // ── void → "undefined" ──
  if (!valType) {
    pushStringLiteral(ctx, fctx, "undefined");
    return native ? nativeStringType(ctx) : { kind: "externref" };
  }

  // ── string-typed ref passthrough (native modes only — a native string-typed
  //    substitution is already an $AnyString/NativeString ref) ──
  if (native && (valType.kind === "ref" || valType.kind === "ref_null") && isStaticStringType(staticType)) {
    return valType;
  }

  // ── i32 boolean → "true"/"false" ──
  // Honour the boolean brand on the ValType (#2016/#2030: i32 predicates carry
  // `boolean: true`) as well as the static TS type.
  if (valType.kind === "i32" && (isStaticBooleanType(staticType) || (valType as { boolean?: true }).boolean)) {
    emitBoolToString(ctx, fctx);
    return native ? nativeStringType(ctx) : { kind: "externref" };
  }

  // ── f64 / i32 / i64 → number_toString ──
  if (valType.kind === "f64" || valType.kind === "i32" || valType.kind === "i64") {
    // Defensive (#1960): in native/standalone mode the f64→native-string bridge
    // REQUIRES `number_toString` — its externref result is what
    // `emitNativeStringRefFromExternref` (`any.convert_extern; ref.cast`)
    // consumes. If it is not registered, emitting `any.convert_extern` on the
    // bare scalar is INVALID Wasm; return the scalar UNCHANGED instead so the
    // caller can fall back. (The standalone `+`-concat site is NOT migrated to
    // this engine precisely because it must DECLINE rather than mid-body-register
    // `number_toString` — see `compileNativeConcatOperand`; this guard only
    // protects any future native caller.)
    const toStrIdx = ctx.funcMap.get("number_toString");
    if (native && toStrIdx === undefined) {
      return valType;
    }
    if (valType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    else if (valType.kind === "i64") fctx.body.push({ op: "f64.convert_i64_s" });
    if (toStrIdx !== undefined) fctx.body.push({ op: "call", funcIdx: toStrIdx });
    if (native) {
      // number_toString returns an externref wrapping a native string; convert
      // it back to a native `ref $AnyString`.
      emitNativeStringRefFromExternref(ctx, fctx);
      return nativeStringType(ctx);
    }
    return { kind: "externref" };
  }

  // ── externref ──
  if (valType.kind === "externref") {
    const isNull = isStaticNullType(staticType);
    const isUndef = isStaticUndefinedType(staticType);
    if (isNull) {
      fctx.body.push({ op: "drop" });
      pushStringLiteral(ctx, fctx, "null");
      return native ? nativeStringType(ctx) : { kind: "externref" };
    }
    if (isUndef) {
      fctx.body.push({ op: "drop" });
      pushStringLiteral(ctx, fctx, "undefined");
      return native ? nativeStringType(ctx) : { kind: "externref" };
    }
    if (isStaticStringType(staticType)) {
      // A standalone dynamic call boxes its native string result as externref
      // while crossing the generic callable bridge. Native-string consumers
      // (notably the linked Function constructor) need the internal
      // `$AnyString` again before concatenation or a later extern.convert_any.
      // The value was produced in-module, so the externref wraps that native
      // GC reference and the conversion/cast is exact. Keep the host-backed
      // native-strings lane unchanged because its externref may be a JS string.
      if (mode === "standalone") {
        emitNativeStringRefFromExternref(ctx, fctx);
        return nativeStringType(ctx);
      }
      // A real host string externref is already concat-ready.
      return { kind: "externref" };
    }
    // Dynamic externref (boxed string / any / $Object) → runtime ToString.
    // The default-hint host tail (`__extern_to_string_default`, the #2022
    // valueOf-first `+` policy) applies ONLY in js-host mode. In native modes
    // the dynamic-externref operand always routes through `__extern_toString`
    // (the native `+`-concat and template callers both used the string-hint
    // tail there regardless of `+` vs template), then back to a native ref.
    const finalIdx = ensureExternrefToStringProviderImpl(ctx, fctx, hint);
    if (finalIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalIdx });
    if (native) {
      emitNativeStringRefFromExternref(ctx, fctx);
      return nativeStringType(ctx);
    }
    return { kind: "externref" };
  }

  // ── struct / ref / ref_null ──
  if (valType.kind === "ref" || valType.kind === "ref_null") {
    if (native) {
      // #2007 — a compile-time-resolvable object struct with its own
      // @@toPrimitive/toString dispatches that (OrdinaryToPrimitive, hint
      // "string"); otherwise the $__any_to_string tag dispatcher.
      if (tryStructToString(ctx, fctx, valType)) {
        return nativeStringType(ctx);
      }
      const anyToStrIdx = ensureAnyToStringHelper(ctx);
      fctx.body.push({ op: "call", funcIdx: anyToStrIdx });
      return nativeStringType(ctx);
    }
    // js-host: hint decides ToString(string) vs ToPrimitive(default). The `+`
    // path (#2022) converts via the default-hint host helper; templates /
    // String() walk @@toPrimitive("string")/toString through coerceType.
    if (hint === "default") {
      // (#2795) Start-function safety: the `__extern_to_string_default` host
      // helper runs OrdinaryToPrimitive on the WasmGC struct via the host's
      // `getExports()` — but TOP-LEVEL code (`"" + new C()` at module scope)
      // executes inside the wasm START section, BEFORE the host wires
      // `setExports`. With exports unavailable the helper cannot dispatch
      // `__call_toString`, so it falls back to "[object Object]" (verified:
      // `console.log("" + new Money(42))` printed "[object Object]" while the
      // template-literal form, which dispatches toString IN-WASM, printed "$42").
      //
      // For a statically-known nominal struct whose ONLY user ToPrimitive method
      // is `toString` (no `valueOf`, no `@@toPrimitive`), §7.1.1.1 makes the
      // DEFAULT hint behave identically to the STRING hint (valueOf is absent →
      // toString runs either way). So dispatch toString IN-WASM via the string-
      // hint coerceType path, which works during START. Classes that DO carry
      // `valueOf`/`@@toPrimitive` keep the host default-hint helper (it honours
      // the valueOf-first ordering #2022 requires); they hit the start-timing gap
      // only at module scope, which is rarer than a plain custom `toString`.
      const refTypeIdx = (valType as { typeIdx?: number }).typeIdx;
      const structName = refTypeIdx !== undefined ? ctx.typeIdxToStructName.get(refTypeIdx) : undefined;
      if (
        structName !== undefined &&
        ctx.funcMap.get(`${structName}_toString`) !== undefined &&
        ctx.funcMap.get(`${structName}_valueOf`) === undefined &&
        ctx.funcMap.get(`${structName}_@@toPrimitive`) === undefined
      ) {
        coerceType(ctx, fctx, valType, { kind: "externref" }, "string");
        return { kind: "externref" };
      }
      coerceType(ctx, fctx, valType, { kind: "externref" });
      const toStrIdx = ensureLateImport(
        ctx,
        "__extern_to_string_default",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalIdx = ctx.funcMap.get("__extern_to_string_default") ?? toStrIdx;
      if (finalIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalIdx });
      return { kind: "externref" };
    }
    coerceType(ctx, fctx, valType, { kind: "externref" }, "string");
    return { kind: "externref" };
  }

  // Unknown kind — leave on stack (should not happen for a string context).
  return valType;
}

/**
 * Compile `operand` then emit `ToString(operand)`. The expression-based
 * convenience wrapper for the `+`-concat / String() callers. Symbol guarding is
 * the caller's responsibility (must short-circuit before operand evaluation).
 */
export function compileAndEmitToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  tsType: ts.Type,
  hint: ToStringHint,
): ValType {
  const valType = compileExpression(ctx, fctx, operand);
  return emitToString(ctx, fctx, valType, tsType, hint);
}

/**
 * Emit `ToNumber(operand)` (→ f64) for an operand ALREADY compiled to the top of
 * the value stack with ValType `valType`. The consolidation of the `Number(x)`
 * matrix (N2) and the unary `+`/`-`/`~` coercion arms (N1):
 *
 *   i64 (BigInt)         → f64.convert_i64_s
 *   externref            → __unbox_number (js-host) | coerceType(f64,"number") (standalone)
 *   ref/ref_null         → coerceType(f64,"number")  (object @@toPrimitive("number")/valueOf)
 *   i32 (number/bool)    → f64.convert_i32_s
 *   f64                  → no-op
 *
 * Returns the ValType left on the stack (`{kind:"f64"}` for every coercing arm;
 * the original `valType` for the already-f64 no-op).
 *
 * NOTE — what stays in the caller (NOT folded here, because each is a *source*
 * special-case that must run BEFORE the operand is on the stack as a plain
 * value, or is policy that differs per caller):
 *   - ToNumber(Symbol) throws TypeError (§7.1.4) — guarded before operand eval.
 *   - the #2160 `Number(arr)` array→ToString→StringToNumber pre-check.
 *   - the native-string-ref (`$AnyString`/`$NativeString`) → `__str_to_number`
 *     (§7.1.4.1) arm — it dispatches on the ref's *typeIdx* (string-struct vs a
 *     generic object struct), which the caller already resolves; a generic ref
 *     falls to `coerceType(f64,"number")` here.
 * The caller handles those, then calls `emitToNumber` for the remaining cascade.
 */
export function emitToNumber(ctx: CodegenContext, fctx: FunctionContext, valType: ValType | null): ValType {
  if (!valType) {
    // void result in a number context → NaN (ToNumber(undefined) = NaN).
    fctx.body.push({ op: "f64.const", value: Number.NaN });
    return { kind: "f64" };
  }

  // BigInt → number.
  if (valType.kind === "i64") {
    fctx.body.push({ op: "f64.convert_i64_s" });
    return { kind: "f64" };
  }

  // externref → number. js-host calls `Number(v)` via `__unbox_number`
  // (ToNumber semantics: Number(null)=0, Number("")=0, Number("0x1F")=31 — NOT
  // parseFloat). `--target standalone` has no host import, so coerceType does the
  // ToPrimitive("number") walk in pure Wasm. NOTE: gated on `ctx.standalone`
  // EXACTLY (not `noJsHost`) to match the migrated `Number(x)` site byte-for-byte
  // — under `--target wasi` (wasi && !standalone) the original took the
  // `__unbox_number` host path, and this preserves that (any WASI-specific
  // correction is a separate, non-neutral change).
  if (valType.kind === "externref") {
    if (ctx.standalone) {
      coerceType(ctx, fctx, valType, { kind: "f64" }, "number");
      return { kind: "f64" };
    }
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    }
    return { kind: "f64" };
  }

  // Object/struct ref → number via @@toPrimitive("number")/valueOf.
  if (valType.kind === "ref" || valType.kind === "ref_null") {
    coerceType(ctx, fctx, valType, { kind: "f64" }, "number");
    return { kind: "f64" };
  }

  // i32 (number or boolean) → f64.
  if (valType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }

  // Already f64 — no-op.
  return valType;
}

/**
 * Reserve the canonical externref→number provider for detached/late-built
 * instruction sequences. Callers that cannot emit ToNumber immediately use
 * the returned stable index after this helper flushes late-import shifts.
 */
export function ensureExternrefToNumberProvider(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  return unboxIdx;
}

/** Look up the canonical ToPrimitive provider after its owning runtime is ready. */
export function getToPrimitiveProvider(ctx: CodegenContext): number | undefined {
  return ctx.funcMap.get("__to_primitive");
}

/** Look up the canonical runtime ToString provider after its owner is ready. */
export function getExternrefToStringProvider(ctx: CodegenContext): number | undefined {
  return ctx.funcMap.get("__extern_toString");
}

/** Look up the canonical StringToNumber provider after its owner is ready. */
export function getStringToNumberProvider(ctx: CodegenContext): number | undefined {
  return ctx.funcMap.get("__str_to_number");
}

/**
 * Append `ToBoolean(value)` (§7.1.2 → i32, 1 = truthy) for a value of ValType
 * `valType` already on the stack into `sink`. The consolidation of the two
 * hand-rolled truthiness sites that #2085 already aligned:
 *   - `ensureI32Condition` (index.ts, B1 — the canonical, pushes to `fctx.body`)
 *   - `buildToBooleanInstrs` (array-methods.ts, B2 — returns an `Instr[]`)
 *
 * The `sink` parameter unifies those two emission styles: B1 passes `fctx.body`,
 * B2 passes a fresh array it then returns. Both produce the SAME sequence — this
 * is behaviour-neutral (the #2085 fix already made B2 use `|x|>0` like B1, so
 * there is no longer a NaN-truthy divergence to surface).
 *
 *   null valType → i32.const 0  (compile failed upstream → keep Wasm valid: falsy)
 *   f64          → |x| > 0       (NaN, +0, -0 all falsy)
 *   externref    → __is_truthy   (0/NaN/null/undefined/"" → falsy); ref.is_null fallback
 *   any-boxed ref→ __any_unbox_bool (proper JS truthiness on the boxed value)
 *   native str ref→ flatten → len > 0 (empty string falsy)
 *   other ref    → non-null (ref.is_null; i32.eqz)
 *   i64          → nonzero
 *   i32          → as-is (already 0/1-valued)
 */
export function emitToBoolean(ctx: CodegenContext, valType: ValType | null, sink: Instr[]): Instr[] {
  if (!valType) {
    // Upstream compile failed — push false to keep the module valid.
    sink.push({ op: "i32.const", value: 0 });
    return sink;
  }
  const kind = valType.kind;
  if (kind === "f64") {
    // |x| > 0 so NaN, +0, -0 are all falsy (f64.ne 0 would make NaN truthy).
    sink.push({ op: "f64.abs" }, { op: "f64.const", value: 0 }, { op: "f64.gt" });
    return sink;
  }
  if (kind === "externref") {
    addUnionImports(ctx);
    const isTruthyIdx = ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (isTruthyIdx !== undefined) {
      // Registering a late helper can shift every subsequent function index.
      // Always re-read the canonical map entry before emitting the call; using
      // the provisional index is observably wrong in large standalone graphs
      // such as Acorn, where TokenType.keyword is an externref union.
      sink.push({ op: "call", funcIdx: ctx.funcMap.get("__is_truthy") ?? isTruthyIdx });
      return sink;
    }
    // Fallback: non-null → true.
    sink.push({ op: "ref.is_null" }, { op: "i32.eqz" });
    return sink;
  }
  if (kind === "ref" || kind === "ref_null") {
    // Boxed `any` value — proper JS truthiness (false/0/NaN/""/null → falsy).
    if (isAnyValue(valType, ctx)) {
      ensureAnyHelpers(ctx);
      const unboxBoolIdx = ctx.funcMap.get("__any_unbox_bool");
      if (unboxBoolIdx !== undefined) {
        sink.push({ op: "call", funcIdx: unboxBoolIdx });
        return sink;
      }
    }
    // Native string ref — empty string is falsy (check len > 0 after flatten).
    if (valType.typeIdx === ctx.anyStrTypeIdx && ctx.anyStrTypeIdx >= 0) {
      // (#3548) NULLABLE string: `__str_flatten(null)` traps — a nullable
      // string param (an under-applied call site's `undefined`, now inferred
      // `ref_null` by inferParamTypeFromCallSites) must be FALSY when null.
      // Route through the null-guarded `__str_truthy` helper. The non-null
      // `ref` arm below keeps its historical flatten path byte-identical.
      if (kind === "ref_null") {
        const truthyIdx = ensureStrTruthyHelper(ctx);
        if (truthyIdx !== undefined) {
          sink.push({ op: "call", funcIdx: truthyIdx });
          return sink;
        }
      }
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (flattenIdx !== undefined && ctx.nativeStrTypeIdx >= 0) {
        sink.push(
          { op: "call", funcIdx: flattenIdx },
          { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.gt_s" },
        );
        return sink;
      }
    }
    // Opaque struct ref — non-null is truthy.
    sink.push({ op: "ref.is_null" }, { op: "i32.eqz" });
    return sink;
  }
  if (kind === "i64") {
    // nonzero → true.
    sink.push({ op: "i64.eqz" }, { op: "i32.eqz" });
    return sink;
  }
  // i32 is already a valid 0/1 condition — no-op.
  return sink;
}

/**
 * Compile both operands of an `any`-typed equality expression, boxing each side
 * that did not naturally produce a `$AnyValue` to `(ref null $AnyValue)` — the
 * shared parameter shape of the `__any_eq` / `__any_strict_eq` helpers. Returns
 * `false` (no instructions appended) if either operand fails to compile, so the
 * caller can fall back exactly as it did before.
 *
 * This is the operand-marshalling half of the §7.2.13/§7.2.15 equality dispatch,
 * lifted verbatim from `compileAnyBinaryDispatch` (binary-ops.ts) — same
 * `compileExpression` → `isAnyValue` guard → `coerceType(ref_null $AnyValue)`
 * sequence (#1211), so the emitted bytes are identical.
 */
function emitAnyEqOperands(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): boolean {
  const anyValueTarget: ValType = { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  // (#3055) An `externref` operand is a boxed value whose runtime tag must be
  // RECOVERED, not assumed. `coerceType(externref → $AnyValue)` boxes it via the
  // `__any_box_string` DEFAULT (value-tags.ts) — the #1888 tag-5 "string" lie —
  // so two boxed NUMBERS (`$BoxedNumber` externrefs from `__box_number`) become
  // two tag-5 boxes and `__any_strict_eq`'s string-content arm answers
  // equal-for-unequal (`1 === 2` → true). That silently vacuified every numeric
  // `assert.sameValue` in the standalone harness (isSameValue rides this exact
  // path). `__any_from_extern` classifies by tag instead — `$BoxedNumber` → tag-3
  // (numeric `f64.eq`), `$BoxedBoolean` → tag-4, and (in its non-honest default
  // instance) strings/objects keep the SAME tag-5 fallback byte-for-byte — so the
  // fix repairs numbers/bools without perturbing string/object equality or the
  // #3037 tag-6 identity carrier. `emitAnyEqFromExternTemps` (the loose-eq
  // externref tail) already marshals through this helper; this makes the
  // freshly-compiled-operand path consistent. Only reachable in standalone/wasi
  // (the helper is undefined otherwise → host lane keeps `coerceType`).
  const fromExternIdx = ensureAnyFromExternHelper(ctx);
  const marshal = (t: ValType, node?: ts.Expression): void => {
    if (isAnyValue(t, ctx)) return;
    if (fromExternIdx !== undefined && t.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: fromExternIdx });
      return;
    }
    // (#745 S3, flag-gated) A statically-BOOLEAN i32 operand must box tag-4
    // (`__any_box_bool`), not the kind-keyed tag-2 number the generic
    // `coerceType` arm produces — `__any_strict_eq` classifies tag-2 vs
    // tag-4 as different JS types, so `unionLocal === true` compared a
    // tag-4 carrier against a tag-2 box and answered false. `boxToAny`
    // already owns the type-aware hint; thread it only under `unionAnyRep`
    // so flag-off (and the whole any-lane today) stays byte-identical.
    if (ctx.unionAnyRep && node !== undefined && t.kind === "i32" && ctx.oracle.isBooleanProducing(node)) {
      if (boxToAny(ctx, fctx, t, "boolean")) return;
    }
    coerceType(ctx, fctx, t, anyValueTarget);
  };
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return false;
  marshal(leftType, expr.left);
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (!rightType) return false;
  marshal(rightType, expr.right);
  return true;
}

/**
 * #1917 Step E3 — `emitStrictEq` / `emitLooseEq`: the **dispatch layer** for
 * `any`-operand equality. These decide WHICH helper to call (`__any_strict_eq`
 * for `===`/`!==`; `__any_eq` for `==`/`!=`), marshal both operands into the
 * boxed `$AnyValue` shape, emit the `call`, and apply the `!=`/`!==` negation.
 *
 * They are a WRAPPER, not a re-derivation: the tag-5 field-4 3-way classifier
 * (boxed-number vs proto-identity vs content equality, #2040/#2585 — the
 * `tag5StringEqThen` machinery) lives in the `__any_eq`/`__any_strict_eq` helper
 * *bodies* in any-helpers.ts. The engine never copies that logic; it only
 * selects the helper and boxes the operands. This is a byte-neutral extraction
 * of the equality arms of `compileAnyBinaryDispatch`.
 *
 * @param negate when true, the loose/strict-equal result is i32.eqz'd (the
 *   `!=` / `!==` half). The helper itself always computes `==`/`===`.
 * @returns the i32 result ValType, or `null` if the helper is unavailable or an
 *   operand failed to compile (caller falls back).
 */
export function emitStrictEq(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  negate: boolean,
): ValType | null {
  return emitAnyEquality(ctx, fctx, expr, "__any_strict_eq", negate);
}

export function emitLooseEq(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  negate: boolean,
): ValType | null {
  return emitAnyEquality(ctx, fctx, expr, "__any_eq", negate);
}

/**
 * Emit host strict/loose equality for two values already present on the stack.
 * Typed binary dispatch reaches this seam after compiling both operands, so it
 * cannot use emitStrictEq/emitLooseEq without evaluating them twice.
 */
export function emitHostEqualityFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  leftType: ValType,
  rightType: ValType,
  strict: boolean,
  negate: boolean,
): ValType {
  if (rightType.kind !== "externref") {
    coerceType(ctx, fctx, rightType, { kind: "externref" });
  }
  if (leftType.kind !== "externref") {
    const tmpRight = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: tmpRight });
    coerceType(ctx, fctx, leftType, { kind: "externref" });
    fctx.body.push({ op: "local.get", index: tmpRight });
    releaseTempLocal(fctx, tmpRight);
  }

  const hostFn = strict ? "__host_eq" : "__host_loose_eq";
  const provisionalIdx = ensureLateImport(
    ctx,
    hostFn,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const finalIdx = ctx.funcMap.get(hostFn) ?? provisionalIdx;
  if (finalIdx === undefined) throw new Error(`Missing import after ensureLateImport: ${hostFn}`);
  fctx.body.push({ op: "call", funcIdx: finalIdx });
  if (negate) fctx.body.push({ op: "i32.eqz" });
  return { kind: "i32" };
}

/**
 * (#3236 S2) True when an operand's static type is a REFERENCE-like value that
 * `===` must compare by object identity (or a dynamic `any` that could be one) —
 * so the standalone `ref.eq` object-identity fast path (`__extern_strict_eq`) is
 * safe to apply. Excludes number/boolean/bigint/symbol value types, which must
 * keep their existing tag-3/tag-4 numeric/boolean comparison path. Strings are
 * excluded too (content equality already works via the tag-5 arm and needs no
 * identity fast path). Unions qualify only when EVERY constituent qualifies, so
 * a `number | object` operand conservatively stays on the legacy path.
 *
 * Classifies via `ctx.oracle` (#1930 type-query boundary), not the raw checker.
 */
function isReferenceLikeEqFact(fact: TypeFact): boolean {
  switch (fact.kind) {
    case "array":
    case "tuple":
    case "function":
    case "class":
    case "builtin":
    case "object":
    case "any":
    case "unknown":
      return true;
    case "union":
      return fact.parts.every(isReferenceLikeEqFact);
    default:
      // number / boolean / string / bigint / symbol / undefined / null / void /
      // unresolvable → keep the existing tag-3/tag-4/tag-5 path.
      return false;
  }
}

function emitAnyEquality(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  helperName: "__any_eq" | "__any_strict_eq",
  negate: boolean,
): ValType | null {
  ensureAnyHelpers(ctx);
  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // (#3236 S2) Native object-identity for standalone `===`/`!==`. Two native
  // `$Object` externrefs (e.g. `getPrototypeOf(g()) === genFn.prototype`,
  // default-proto.js §27.5.1) otherwise fold to the tag-5 (string) fallback in
  // `__any_from_extern` and get string-CONTENT compared — a layout-dependent
  // result that made object `===` unreliable (and left Slice-1's
  // prototype-relation flip passing only coincidentally). `__extern_strict_eq`
  // (#2734) prepends the `ref.eq` reference-identity fast path (both operands
  // internalized; identical `eq` ref → 1) then falls through to the SAME
  // `__any_from_extern` + `__any_strict_eq` primitive comparison, so it never
  // false-positives a primitive. Scoped to OBJECT/`any` operands only (via
  // `isReferenceLikeEqFact`): number/boolean/bigint/symbol comparisons keep
  // their exact existing tag-3/tag-4 path untouched. Standalone/WASI only — the
  // host lane emits nothing new (byte-identical).
  if (helperName === "__any_strict_eq" && (ctx.standalone || ctx.wasi)) {
    if (
      isReferenceLikeEqFact(ctx.oracle.typeFactOf(expr.left)) &&
      isReferenceLikeEqFact(ctx.oracle.typeFactOf(expr.right))
    ) {
      const externEqIdx = ensureExternStrictEqHelper(ctx);
      if (externEqIdx !== undefined) {
        const lt = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
        if (!lt) return null;
        if (lt.kind !== "externref") coerceType(ctx, fctx, lt, { kind: "externref" });
        const rt = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
        if (!rt) return null;
        if (rt.kind !== "externref") coerceType(ctx, fctx, rt, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx: externEqIdx });
        if (negate) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }
  }

  if (!emitAnyEqOperands(ctx, fctx, expr)) return null;

  fctx.body.push({ op: "call", funcIdx });

  if (negate) {
    fctx.body.push({ op: "i32.eqz" });
  }

  return { kind: "i32" };
}

/**
 * #1917 equality finale, slice E6 — the standalone externref-vs-externref
 * loose-equality tail.
 *
 * For two opaque `any` externref operands that were NOT eqref-identical, the
 * standalone/WASI lane (no JS host) routes through the NATIVE §7.2.15
 * IsLooselyEqual instead of the unsatisfiable `__host_loose_eq` import (#2081):
 * box both externrefs to `$AnyValue` via `__any_from_extern` (tag5 string / tag3
 * number / tag4 bool / tag1 null) and call the keystone `__any_eq` helper (whose
 * tag-5 field-4 classifier owns the String⇄Number / proto-identity arms). This
 * is the SAME tag-5-sensitive boxing E3 does for the any/any case, just sourced
 * from two pre-computed externref temps instead of freshly-compiled operands.
 *
 * Returns the instruction SEQUENCE (this caller builds an `Instr[]` for an
 * `if`-arm, it does not emit live), or `null` when the helpers are unavailable so
 * the caller can fall through to its host-import path exactly as before. WRAPPER,
 * not a re-derivation: the classifier stays in `__any_eq`'s body (any-helpers.ts).
 *
 * @param tmpLeft  local index holding the left externref operand.
 * @param tmpRight local index holding the right externref operand.
 * @param negate   append `i32.eqz` for the `!=` form.
 */
export function emitAnyEqFromExternTemps(
  ctx: CodegenContext,
  tmpLeft: number,
  tmpRight: number,
  negate: boolean,
): Instr[] | null {
  ensureAnyHelpers(ctx);
  const fromExternIdx = ensureAnyFromExternHelper(ctx);
  const anyEqIdx = ctx.funcMap.get("__any_eq");
  if (fromExternIdx === undefined || anyEqIdx === undefined) return null;
  return [
    { op: "local.get", index: tmpLeft },
    { op: "call", funcIdx: fromExternIdx },
    { op: "local.get", index: tmpRight },
    { op: "call", funcIdx: fromExternIdx },
    { op: "call", funcIdx: anyEqIdx },
    ...(negate ? ([{ op: "i32.eqz" }] satisfies Instr[]) : []),
  ];
}

/**
 * Emit a string literal in the active mode. `compileStringLiteral` is already
 * mode-agnostic (a native `$AnyString` constant in native/standalone mode, an
 * externref string-constant in js-host mode) — exactly what every migrated
 * caller used via its own `pushStringConstant`/`compileStringLiteral` call.
 */
function pushStringLiteral(ctx: CodegenContext, fctx: FunctionContext, value: string): void {
  compileStringLiteral(ctx, fctx, value);
}

// emitBoolToString and emitNativeStringRefFromExternref live in string-ops.ts
// and are not exported (string-ops.ts imports this module, so a direct import
// here would be a cycle). They are bound by string-ops.ts at module load into
// the runtime-import-free string-emitter-registry leaf (#3324) — NOT into
// module-level `let` slots here: string-ops.ts's top-level register call can
// run while THIS module is still mid-initialization (entry paths that reach
// coercion-engine before string-ops, e.g. via any-helpers), and assigning a
// TDZ'd `let` crashed with "Cannot access 'boolToStringEmitter' before
// initialization". The leaf registry has no imports, so it is always fully
// initialized whenever either side touches it.

function emitBoolToString(ctx: CodegenContext, fctx: FunctionContext): void {
  const emitter = getBoolToStringEmitter();
  if (!emitter) throw new Error("coercion-engine: bool-to-string emitter not registered");
  emitter(ctx, fctx);
}

function emitNativeStringRefFromExternref(ctx: CodegenContext, fctx: FunctionContext): void {
  const emitter = getNativeStringRefFromExternrefEmitter();
  if (!emitter) {
    throw new Error("coercion-engine: native-string-ref emitter not registered");
  }
  emitter(ctx, fctx);
}

registerEnsureExternrefToStringProvider(ensureExternrefToStringProviderImpl);
