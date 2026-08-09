// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared types, values, and late-bound function registrations for the codegen
 * modules.  This module exists solely to break circular dependencies between
 * the main codegen modules (index.ts, expressions.ts, statements.ts) and the
 * feature-specific modules (closures.ts, etc.).
 *
 * Dependency direction:
 *   shared.ts (no deps on main modules)
 *     ↑
 *   registry/*.ts, context/*.ts (low-level)
 *     ↑
 *   index.ts (compiler driver — imports from shared, registry, context)
 *     ↑           ↑
 *   expressions.ts  statements.ts (import from shared and index)
 *
 * Convention: the *real* implementation lives in the feature module and calls
 * `registerXxx(impl)` at module scope.  Consumers import the delegate wrapper
 * from this file.
 */

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

// ── VOID_RESULT sentinel ──────────────────────────────────────────────

/** Sentinel: expression compiled successfully but produces no value (void) */
export const VOID_RESULT = Symbol("void");
export type InnerResult = ValType | null | typeof VOID_RESULT;

// ── packed-element helpers (#2648/#2934) ──────────────────────────────

/**
 * The unpacked VALUE type of a (possibly packed) array element. Packed i8/i16
 * (Uint8Array/Int8Array/Int16Array/… standalone storage, #2593) are STORAGE-only
 * types: `array.get_s`/`get_u` widen them to `i32` on the stack, and a
 * param/result/local/global/block declared with a packed kind is invalid Wasm
 * ("packed storage type is not valid in a value position"). Identity for
 * non-packed types.
 */
export function unpackedElemType(elemType: ValType): ValType {
  return elemType.kind === "i8" || elemType.kind === "i16" ? { kind: "i32" } : elemType;
}

/**
 * Pick the element-load op for a (possibly packed) typed-array element, driven
 * by the view-name signedness when available (`Int*` → `array.get_s`, `Uint*` →
 * `array.get_u`; the storage kind alone cannot distinguish them, #2648), else
 * the legacy storage-kind heuristic (i8→get_u, i16→get_s). i32/f64/ref elements
 * use plain `array.get`.
 */
export function elemGetOp(
  elemType: ValType,
  signedness: "s" | "u" | undefined,
): "array.get" | "array.get_s" | "array.get_u" {
  if (elemType.kind === "i8" || elemType.kind === "i16") {
    if (signedness === "s") return "array.get_s";
    if (signedness === "u") return "array.get_u";
    return elemType.kind === "i8" ? "array.get_u" : "array.get_s";
  }
  return "array.get";
}

// ── resolveThisStructName ─────────────────────────────────────────────

/**
 * When `this` is typed as `any` (e.g., in function constructors), resolve the
 * struct name from the local's ref type index. Used as a fallback when
 * resolveStructName returns undefined for `this`-property accesses/assignments.
 */
/**
 * Skip "transparent" wrapper expressions that have no runtime effect — parens,
 * `as`/`<T>` casts, `satisfies`, and non-null `!` — to reach the underlying
 * expression. The local stand-in for `ts.skipOuterExpressions` (not surfaced by
 * the project's ts-api shim). Used to let `(this as any).x` / `(B as any).c`
 * resolve to the same receiver as `this.x` / `B.c` (#2020/#2027).
 */
export function skipTransparentExpressions(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

export function resolveThisStructName(ctx: CodegenContext, fctx: FunctionContext): string | undefined {
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx === undefined) return undefined;
  const selfType =
    selfIdx < fctx.params.length ? fctx.params[selfIdx]!.type : fctx.locals[selfIdx - fctx.params.length]?.type;
  if (!selfType || (selfType.kind !== "ref" && selfType.kind !== "ref_null")) return undefined;
  const typeIdx = (selfType as { typeIdx: number }).typeIdx;
  return ctx.typeIdxToStructName.get(typeIdx);
}

// ── valTypesMatch ─────────────────────────────────────────────────────

/** Check if two ValTypes are structurally equal */
export function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

// ── getLine / getCol ──────────────────────────────────────────────────

export function getLine(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return line + 1;
  } catch {
    return 0;
  }
}

export function getCol(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
    return character + 1;
  } catch {
    return 0;
  }
}

// ── Late-bound delegates ──────────────────────────────────────────────
// Each delegate starts as a throwing stub and is replaced by the real
// implementation when the owning module is loaded.
//
// #2146 — these function-pointer slots are a deliberate cycle-breaker (this
// module is the acyclic sink that every codegen module may import), but their
// initialization order used to be a *runtime trap*: a stub threw a bare
// "X not yet registered" only when first *called*, deep inside codegen, with no
// hint of which registrar module failed to load. Two changes harden that:
//   1. each stub's throw now names the module that owns its registration, and
//   2. `assertCodegenRegistrationsComplete()` (called once at compile entry)
//      fails fast and lists every still-unwired delegate, turning an obscure
//      mid-codegen error into an actionable load-order diagnostic.
// Full removal of the slots is tracked by #1916 (symbolic func refs +
// module-graph restructuring); see that issue for the residual plan.

/** Names of delegates that have been wired by their owning module. */
const _registeredDelegates = new Set<string>();

/**
 * Required delegate → the codegen module whose module-scope `register*` call
 * wires it. Kept in sync with the `register*` functions below; used to produce
 * an actionable diagnostic when a delegate is invoked (or asserted) before its
 * owning module has been imported. Only delegates with a *throwing* stub are
 * listed — slots with a safe default (`materializeStructAsObject` → false,
 * `addStringImports` → no-op) are intentionally optional and omitted.
 */
const REQUIRED_DELEGATE_OWNERS: Readonly<Record<string, string>> = {
  compileExpression: "expressions.ts",
  compileArrowAsClosure: "closures.ts",
  emitBoundsCheckedArrayGet: "array-methods.ts",
  coerceType: "type-coercion.ts",
  ensureExternrefToStringProvider: "coercion-engine.ts",
  ensureLateImport: "expressions/late-imports.ts (registered by expressions.ts)",
  flushLateImportShifts: "expressions/late-imports.ts (registered by expressions.ts)",
  ensureAnyHelpers: "any-helpers.ts",
  addUnionImports: "index.ts",
  resolveComputedKeyExpression: "literals.ts",
  compileStatement: "statements.ts",
  ensureBindingLocals: "statements/destructuring.ts",
  hoistFunctionDeclarations: "statements/nested-declarations.ts",
  emitNestedBindingDefault: "statements/destructuring.ts",
  emitDefaultValueCheck: "statements/destructuring.ts",
  emitArgumentsObject: "statements/nested-declarations.ts",
  compileStringLiteral: "string-ops.ts",
  compileSuperPropertyAccess: "expressions/new-super.ts",
  compileSuperElementAccess: "expressions/new-super.ts",
};

function markRegistered(name: string): void {
  _registeredDelegates.add(name);
}

/**
 * Build the "X not yet registered" message for a delegate stub, naming the
 * module that should have wired it (#2146).
 */
function unregisteredDelegateError(name: string): Error {
  const owner = REQUIRED_DELEGATE_OWNERS[name];
  const where = owner ? ` — its owning module (${owner}) was not imported before this call` : "";
  return new Error(`codegen delegate "${name}" not yet registered${where}`);
}

/**
 * Fail fast at compile entry if any required codegen delegate is still its
 * throwing stub (#2146). Without this, a missing registration surfaces only
 * deep inside codegen — as an obscure "X not yet registered" — when (and if)
 * the relevant feature happens to be exercised by the input program.
 *
 * Call this once per top-level codegen entry (`generateModule` /
 * `generateMultiModule`). It is O(slots) and has no effect in the normal path
 * where `src/compiler.ts` eagerly imports the registrar modules.
 */
export function assertCodegenRegistrationsComplete(): void {
  const missing = Object.keys(REQUIRED_DELEGATE_OWNERS).filter((name) => !_registeredDelegates.has(name));
  if (missing.length === 0) return;
  const detail = missing.map((name) => `  - ${name} (owner: ${REQUIRED_DELEGATE_OWNERS[name]})`).join("\n");
  throw new Error(
    `codegen registration incomplete: ${missing.length} delegate(s) were never wired.\n` +
      `This means a registrar module was not imported before codegen ran ` +
      `(see src/compiler.ts and src/codegen/shared.ts #2146).\n${detail}`,
  );
}

type CompileExpressionFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
) => ValType | null;

let _compileExpression: CompileExpressionFn = () => {
  throw unregisteredDelegateError("compileExpression");
};

export function registerCompileExpression(fn: CompileExpressionFn): void {
  _compileExpression = fn;
  markRegistered("compileExpression");
}

export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  return _compileExpression(ctx, fctx, expr, expectedType);
}

// ── compileArrowAsClosure ─────────────────────────────────────────────

type CompileArrowAsClosureFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
) => ValType | null;

let _compileArrowAsClosure: CompileArrowAsClosureFn = () => {
  throw unregisteredDelegateError("compileArrowAsClosure");
};

export function registerCompileArrowAsClosure(fn: CompileArrowAsClosureFn): void {
  _compileArrowAsClosure = fn;
  markRegistered("compileArrowAsClosure");
}

export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  return _compileArrowAsClosure(ctx, fctx, arrow);
}

// ── emitBoundsCheckedArrayGet ─────────────────────────────────────────

type EmitBoundsCheckedArrayGetFn = (
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  ctx?: CodegenContext,
  useUndefinedSentinel?: boolean,
) => void;

let _emitBoundsCheckedArrayGet: EmitBoundsCheckedArrayGetFn = () => {
  throw unregisteredDelegateError("emitBoundsCheckedArrayGet");
};

export function registerEmitBoundsCheckedArrayGet(fn: EmitBoundsCheckedArrayGetFn): void {
  _emitBoundsCheckedArrayGet = fn;
  markRegistered("emitBoundsCheckedArrayGet");
}

export function emitBoundsCheckedArrayGet(
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  ctx?: CodegenContext,
  useUndefinedSentinel?: boolean,
): void {
  _emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType, ctx, useUndefinedSentinel);
}

// ── resolveEnclosingClassName ─────────────────────────────────────────
// #2146: this helper has NO module dependencies (it reads only `fctx`), so it
// lives directly in `shared.ts` (the acyclic sink) instead of behind a DI
// slot. Consumers already import it from here; the previous delegate +
// `registerResolveEnclosingClassName` indirection has been retired.

/**
 * Best-effort name of the class lexically enclosing `fctx`. Prefers the
 * explicit `enclosingClassName` carried on the context; otherwise falls back to
 * the `${Class}_${method}` naming convention baked into compiled method names.
 */
export function resolveEnclosingClassName(fctx: FunctionContext): string | undefined {
  if (fctx.enclosingClassName) return fctx.enclosingClassName;
  const underscoreIdx = fctx.name.indexOf("_");
  if (underscoreIdx > 0) return fctx.name.substring(0, underscoreIdx);
  return undefined;
}

// ── coerceType ────────────────────────────────────────────────────────

type CoerceTypeFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
) => void;

let _coerceType: CoerceTypeFn = () => {
  throw unregisteredDelegateError("coerceType");
};

export function registerCoerceType(fn: CoerceTypeFn): void {
  _coerceType = fn;
  markRegistered("coerceType");
}

export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
): void {
  _coerceType(ctx, fctx, from, to, toPrimitiveHint);
}

// ── externref ToString provider ──────────────────────────────────────
//
// The implementation belongs to coercion-engine.ts, the single owner of the
// runtime ToString vocabulary. type-coercion.ts needs its function index for a
// nested OrdinaryToPrimitive branch while the engine already imports
// coerceType/tryStructToString from type-coercion.ts, so this registered
// delegate preserves the acyclic dependency boundary.

type EnsureExternrefToStringProviderFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: "string" | "default",
) => number | undefined;

let _ensureExternrefToStringProvider: EnsureExternrefToStringProviderFn = () => {
  throw unregisteredDelegateError("ensureExternrefToStringProvider");
};

export function registerEnsureExternrefToStringProvider(fn: EnsureExternrefToStringProviderFn): void {
  _ensureExternrefToStringProvider = fn;
  markRegistered("ensureExternrefToStringProvider");
}

export function ensureExternrefToStringProvider(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: "string" | "default",
): number | undefined {
  return _ensureExternrefToStringProvider(ctx, fctx, hint);
}

// ── materializeStructAsObject (#2358) ─────────────────────────────────
//
// Reify a nominal object struct (whose ref is on the Wasm stack) into a
// dynamic `$Object` externref, copying each field as an own-property — so the
// native `__to_primitive` helper (which only recognises `$Object`) can reduce
// it across the externref boundary. Implemented in `literals.ts` (needs the
// per-function emission helpers); registered here to break the
// type-coercion → literals import cycle. Returns true if it emitted the
// materialization (struct consumed, `$Object` externref left on the stack),
// false if it declined (caller falls back to `extern.convert_any`).

type MaterializeStructAsObjectOpts = { skipInternalFields?: boolean };
type MaterializeStructAsObjectFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  structTypeIdx: number,
  opts?: MaterializeStructAsObjectOpts,
) => boolean;

let _materializeStructAsObject: MaterializeStructAsObjectFn = () => false;

export function registerMaterializeStructAsObject(fn: MaterializeStructAsObjectFn): void {
  _materializeStructAsObject = fn;
  markRegistered("materializeStructAsObject");
}

export function materializeStructAsObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structTypeIdx: number,
  opts?: MaterializeStructAsObjectOpts,
): boolean {
  return _materializeStructAsObject(ctx, fctx, structTypeIdx, opts);
}

// ── ensureLateImport / flushLateImportShifts delegates ───────────────

type EnsureLateImportFn = (
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  module?: string,
) => number | undefined;

type FlushLateImportShiftsFn = (ctx: CodegenContext, fctx: FunctionContext | null) => void;

let _ensureLateImport: EnsureLateImportFn = () => {
  throw unregisteredDelegateError("ensureLateImport");
};

let _flushLateImportShifts: FlushLateImportShiftsFn = () => {
  throw unregisteredDelegateError("flushLateImportShifts");
};

export function registerEnsureLateImport(fn: EnsureLateImportFn): void {
  _ensureLateImport = fn;
  markRegistered("ensureLateImport");
}

export function registerFlushLateImportShifts(fn: FlushLateImportShiftsFn): void {
  _flushLateImportShifts = fn;
  markRegistered("flushLateImportShifts");
}

export function ensureLateImport(
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  module?: string,
): number | undefined {
  return _ensureLateImport(ctx, name, paramTypes, resultTypes, module);
}

export function flushLateImportShifts(ctx: CodegenContext, fctx: FunctionContext | null): void {
  _flushLateImportShifts(ctx, fctx);
}

// ── reserveMemberGetDispatch delegate (#3178) ────────────────────────
// destructuring-params.ts routes `done`/`value` property reads through the
// finalize-filled `__get_member_<name>` dispatcher (#2674), but a STATIC
// import of member-get-dispatch.ts from destructuring-params.ts closes an
// eval-time module cycle (ReferenceError: `COLLECTION_KIND` before
// initialization in collections-brand.ts). Late-bound like the delegates
// above; SOFT (returns undefined when unregistered) so the destructure path
// degrades to its raw `__extern_get` read instead of throwing.

type ReserveMemberGetDispatchFn = (ctx: CodegenContext, propName: string, fctx?: FunctionContext) => number | undefined;

let _reserveMemberGetDispatch: ReserveMemberGetDispatchFn | undefined;

export function registerReserveMemberGetDispatch(fn: ReserveMemberGetDispatchFn): void {
  _reserveMemberGetDispatch = fn;
}

/** Late-bound `reserveMemberGetDispatch` (see the delegate note above). */
export function reserveMemberGetDispatchLate(
  ctx: CodegenContext,
  propName: string,
  fctx?: FunctionContext,
): number | undefined {
  return _reserveMemberGetDispatch?.(ctx, propName, fctx);
}

// ── reserveTypedMemberGetF64Dispatch delegate (#3673) ─────────────────
// type-coercion.ts rewrites `call __get_member_<p>` + ToNumber into the typed
// `__get_member_<p>__f64` dispatcher, but member-get-dispatch.ts statically
// imports `coercionInstrs` FROM type-coercion.ts — the reverse static import
// would close that cycle at eval time. Same late-bound/SOFT shape as the
// generic reserve delegate above: unregistered → the coercion site keeps its
// `__to_primitive` + `__unbox_number` path.

let _reserveTypedMemberGetF64Dispatch: ReserveMemberGetDispatchFn | undefined;

export function registerReserveTypedMemberGetF64Dispatch(fn: ReserveMemberGetDispatchFn): void {
  _reserveTypedMemberGetF64Dispatch = fn;
}

/** Late-bound `reserveTypedMemberGetF64Dispatch` (see the delegate note above). */
export function reserveTypedMemberGetF64DispatchLate(
  ctx: CodegenContext,
  propName: string,
  fctx?: FunctionContext,
): number | undefined {
  return _reserveTypedMemberGetF64Dispatch?.(ctx, propName, fctx);
}

// ── isAnyValue ────────────────────────────────────────────────────────
// Moved here from index.ts so expressions.ts and typeof-delete.ts can import
// it without depending on index.ts (which depends on expressions.ts).

/**
 * Check if a ValType is the any-value boxed type used for TS `any`.
 */
export function isAnyValue(type: ValType, ctx: CodegenContext): boolean {
  return (
    (type.kind === "ref" || type.kind === "ref_null") &&
    (type as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx &&
    ctx.anyValueTypeIdx >= 0
  );
}

/**
 * True only when a declared TS return type is *exactly* `boolean` (or a boolean
 * literal `true`/`false`). Strict by design (#2770): a `boolean | undefined`
 * union, `number`, etc. carry the outer `Union`/`Number` flag — NOT the
 * `Boolean` flag — so they are rejected. This gates the boolean-result branding
 * below so only genuine boolean returns are re-tagged.
 *
 * (#1930 Slice 3 — Q-TAG, checker lane.) This flag test is EXACTLY the
 * oracle's boolean fact (`typeFactOf(...).kind === "boolean"`, including the
 * strict union rejection — verdict V7). It cannot delegate yet because its
 * callers hold a raw `ts.Type` (not a node) from signature plumbing; the
 * migration is the Slice-4 `signatureOf` bucket
 * (`oracle.signatureOf(callNode).returns.kind === "boolean"` at the six
 * `brandExternMethodResult` call sites). Keep semantics locked to the
 * oracle's boolean arm until then.
 */
function isStrictBooleanReturnType(t: ts.Type): boolean {
  return (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0;
}

/**
 * (#2770, S5b of #2773) Brand an extern-method result ValType as a *boolean*
 * when the method's declared TS return type is exactly `boolean`, so the
 * `any`/return coercion boxes it via `__box_boolean` (→ `true`/`false`) instead
 * of `__box_number` (→ `1`/`0`).
 *
 * Why a per-call-site wrap (not just registration): a boolean extern method's
 * func type carries an `i32` result, and `funcTypeKey` (registry/types.ts) keys
 * results on `.kind` only — so a branded `{i32,boolean:true}` result func type
 * dedups to a pre-existing *unbranded* `…->i32` type. `getWasmFuncReturnType`
 * then reads back the deduped unbranded i32 and the brand is lost at every
 * `getWasmFuncReturnType(ctx, idx) ?? resolveWasmType(ctx, retType)` dispatch
 * site. Re-branding from the call's TS return type here recovers it regardless
 * of dedup. (Registration is also branded so the direct `methodInfo.results[0]`
 * path in extern.ts is honest at source.)
 *
 * Over-boxing guards — idempotent, never widens:
 *  - only a *bare* `i32` is touched (f64/externref/ref/ref_null pass through);
 *  - an already `{i32,boolean:true}` value short-circuits (idempotent);
 *  - only an *exactly*-`boolean` declared return is branded (numbers, unions,
 *    `void`, etc. pass through unchanged — `map.get`/`indexOf`/`.size` stay
 *    numbers).
 */
export function brandExternMethodResult(
  _ctx: CodegenContext,
  tsReturnType: ts.Type | undefined,
  valType: ValType,
): ValType {
  if (!tsReturnType) return valType;
  if (valType.kind !== "i32" || (valType as { boolean?: boolean }).boolean) return valType;
  if (!isStrictBooleanReturnType(tsReturnType)) return valType;
  return { kind: "i32", boolean: true };
}

// ── ensureAnyHelpers ──────────────────────────────────────────────────

type EnsureAnyHelpersFn = (ctx: CodegenContext) => void;

let _ensureAnyHelpers: EnsureAnyHelpersFn = () => {
  throw unregisteredDelegateError("ensureAnyHelpers");
};

export function registerEnsureAnyHelpers(fn: EnsureAnyHelpersFn): void {
  _ensureAnyHelpers = fn;
  markRegistered("ensureAnyHelpers");
}

// ── addUnionImports (lazy binding to avoid index.ts ↔ late-imports.ts cycle) ──
// #1471: late-imports.ts needs to route box/unbox/typeof/is_truthy helper
// names to the in-module native funcs under no-JS-host mode, but
// addUnionImports lives in index.ts which already imports ensureLateImport.
// Break the cycle the same way ensureAnyHelpers does.

type AddUnionImportsFn = (ctx: CodegenContext) => void;

let _addUnionImports: AddUnionImportsFn = () => {
  throw unregisteredDelegateError("addUnionImports");
};

export function registerAddUnionImports(fn: AddUnionImportsFn): void {
  _addUnionImports = fn;
  markRegistered("addUnionImports");
}

export function addUnionImportsViaRegistry(ctx: CodegenContext): void {
  _addUnionImports(ctx);
}

export function ensureAnyHelpers(ctx: CodegenContext): void {
  _ensureAnyHelpers(ctx);
}

// ── resolveComputedKeyExpression ──────────────────────────────────────

type ResolveComputedKeyExpressionFn = (ctx: CodegenContext, expr: ts.Expression) => string | undefined;

let _resolveComputedKeyExpression: ResolveComputedKeyExpressionFn = () => {
  throw unregisteredDelegateError("resolveComputedKeyExpression");
};

export function registerResolveComputedKeyExpression(fn: ResolveComputedKeyExpressionFn): void {
  _resolveComputedKeyExpression = fn;
  markRegistered("resolveComputedKeyExpression");
}

export function resolveComputedKeyExpression(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  return _resolveComputedKeyExpression(ctx, expr);
}

// ── compileStatement ──────────────────────────────────────────────────

type CompileStatementFn = (ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement) => void;

let _compileStatement: CompileStatementFn = () => {
  throw unregisteredDelegateError("compileStatement");
};

export function registerCompileStatement(fn: CompileStatementFn): void {
  _compileStatement = fn;
  markRegistered("compileStatement");
}

export function compileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  _compileStatement(ctx, fctx, stmt);
}

// ── ensureBindingLocals ───────────────────────────────────────────────

type EnsureBindingLocalsFn = (ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern) => void;

let _ensureBindingLocals: EnsureBindingLocalsFn = () => {
  throw unregisteredDelegateError("ensureBindingLocals");
};

export function registerEnsureBindingLocals(fn: EnsureBindingLocalsFn): void {
  _ensureBindingLocals = fn;
  markRegistered("ensureBindingLocals");
}

export function ensureBindingLocals(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  _ensureBindingLocals(ctx, fctx, pattern);
}

// ── hoistFunctionDeclarations ─────────────────────────────────────────

type HoistFunctionDeclarationsFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
) => void;

let _hoistFunctionDeclarations: HoistFunctionDeclarationsFn = () => {
  throw unregisteredDelegateError("hoistFunctionDeclarations");
};

export function registerHoistFunctionDeclarations(fn: HoistFunctionDeclarationsFn): void {
  _hoistFunctionDeclarations = fn;
  markRegistered("hoistFunctionDeclarations");
}

export function hoistFunctionDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  _hoistFunctionDeclarations(ctx, fctx, stmts);
}

// ── emitNestedBindingDefault ──────────────────────────────────────────

type EmitNestedBindingDefaultFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  nestedLocal: number,
  valueType: ValType,
  initializer: ts.Expression,
) => void;

let _emitNestedBindingDefault: EmitNestedBindingDefaultFn = () => {
  throw unregisteredDelegateError("emitNestedBindingDefault");
};

export function registerEmitNestedBindingDefault(fn: EmitNestedBindingDefaultFn): void {
  _emitNestedBindingDefault = fn;
  markRegistered("emitNestedBindingDefault");
}

export function emitNestedBindingDefault(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nestedLocal: number,
  valueType: ValType,
  initializer: ts.Expression,
): void {
  _emitNestedBindingDefault(ctx, fctx, nestedLocal, valueType, initializer);
}

// ── emitDefaultValueCheck ─────────────────────────────────────────────

type EmitDefaultValueCheckFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  localIdx: number,
  initializer: ts.Expression,
  targetType?: ValType,
  objectPropertySemantics?: boolean,
) => void;

let _emitDefaultValueCheck: EmitDefaultValueCheckFn = () => {
  throw unregisteredDelegateError("emitDefaultValueCheck");
};

export function registerEmitDefaultValueCheck(fn: EmitDefaultValueCheckFn): void {
  _emitDefaultValueCheck = fn;
  markRegistered("emitDefaultValueCheck");
}

export function emitDefaultValueCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  localIdx: number,
  initializer: ts.Expression,
  targetType?: ValType,
  objectPropertySemantics?: boolean,
): void {
  _emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, initializer, targetType, objectPropertySemantics);
}

// ── emitArgumentsObject ───────────────────────────────────────────────

type EmitArgumentsObjectFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
  unmapped?: boolean,
) => void;

let _emitArgumentsObject: EmitArgumentsObjectFn = () => {
  throw unregisteredDelegateError("emitArgumentsObject");
};

export function registerEmitArgumentsObject(fn: EmitArgumentsObjectFn): void {
  _emitArgumentsObject = fn;
  markRegistered("emitArgumentsObject");
}

/**
 * `unmapped`: when true (strict-mode functions, §10.4.4) the param↔arguments
 * sync is suppressed so writes to `arguments[i]` do not flow back into the
 * named parameter (#779e). Defaults to false (sloppy, mapped).
 */
export function emitArgumentsObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
  unmapped = false,
): void {
  _emitArgumentsObject(ctx, fctx, paramTypes, paramOffset, unmapped);
}

// ── compileStringLiteral ──────────────────────────────────────────────

type CompileStringLiteralFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
) => ValType | null;

let _compileStringLiteral: CompileStringLiteralFn = () => {
  throw unregisteredDelegateError("compileStringLiteral");
};

export function registerCompileStringLiteral(fn: CompileStringLiteralFn): void {
  _compileStringLiteral = fn;
  markRegistered("compileStringLiteral");
}

export function compileStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
): ValType | null {
  return _compileStringLiteral(ctx, fctx, value, node);
}

// ── compileSuperPropertyAccess ────────────────────────────────────────

type CompileSuperPropertyAccessFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
) => ValType | null;

let _compileSuperPropertyAccess: CompileSuperPropertyAccessFn = () => {
  throw unregisteredDelegateError("compileSuperPropertyAccess");
};

export function registerCompileSuperPropertyAccess(fn: CompileSuperPropertyAccessFn): void {
  _compileSuperPropertyAccess = fn;
  markRegistered("compileSuperPropertyAccess");
}

export function compileSuperPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null {
  return _compileSuperPropertyAccess(ctx, fctx, expr, propName);
}

// ── compileSuperElementAccess ─────────────────────────────────────────

type CompileSuperElementAccessFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
) => ValType | null;

let _compileSuperElementAccess: CompileSuperElementAccessFn = () => {
  throw unregisteredDelegateError("compileSuperElementAccess");
};

export function registerCompileSuperElementAccess(fn: CompileSuperElementAccessFn): void {
  _compileSuperElementAccess = fn;
  markRegistered("compileSuperElementAccess");
}

export function compileSuperElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  return _compileSuperElementAccess(ctx, fctx, expr);
}

// ── emitBoundsCheckedArrayGet registration ────────────────────────────
// (delegate stub already existed but was never registered — fixed here)

// ── resolveEnclosingClassName registration ────────────────────────────
// (delegate stub already existed but was never registered — fixed here)

// ── addStringImports ─────────────────────────────────────────────────
// Delegate to break circular dependency: any-helpers.ts needs string
// imports but addStringImports lives in index.ts which imports any-helpers.

type AddStringImportsFn = (ctx: CodegenContext) => void;

let _addStringImports: AddStringImportsFn = () => {
  // No-op before registration — standalone mode may not have string imports
};

export function registerAddStringImports(fn: AddStringImportsFn): void {
  _addStringImports = fn;
  markRegistered("addStringImports");
}

export function addStringImportsDelegate(ctx: CodegenContext): void {
  _addStringImports(ctx);
}
