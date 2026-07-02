// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1719 CPR — compiled prototype record) Write-arm: capture
 * `Array.prototype[Symbol.iterator] = fn` / `Array.prototype.values = fn` into
 * `ctx.protoOverrides` so array destructuring / for-of / spread can drive the
 * override at the observation boundary (§7.4.2 GetIterator, §8.5.2
 * IteratorBindingInitialization).
 *
 * The override has no compiled landing spot today (the LHS `Array.prototype` is a
 * builtin with no struct), so the assignment is silently dropped (#1719 root
 * cause). Here we instead lift the RHS closure, root it in a fresh `mut externref`
 * module global so DCE can't drop it (it is only referenced from the table, not
 * the wasm body), and record `{globalIdx}` keyed by proto-owner token (`"Array"`)
 * + well-known member key (`"@@iterator"` / `"values"`). The read-drive sites
 * (`destructuring.ts`, `loops.ts`, spread) `global.get` the closure and call it
 * with the array as `this` via `__call_fn_method_0`.
 *
 * Gated on the S1 brand `ctx.arrayIteratorMaybeOverridden` (set by the
 * `sourceOverridesArrayIterator` pre-scan) so a module without any
 * `Array.prototype` iterator override never enters this path — byte-identical.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { nextModuleGlobalIdx } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";
import { compileArrowAsClosure, resolveComputedKeyExpression } from "../shared.js";
import { definedFuncAt } from "../func-space.js"; // (#1916 S2) positional-read chokepoint

/** Canonical proto-owner token for `Array.prototype`. */
const ARRAY_PROTO_TOKEN = "Array";

/**
 * Map a `Array.prototype[<key>]` / `Array.prototype.<key>` assignment target to
 * the canonical CPR member key (`"@@iterator"` for `Symbol.iterator`, `"values"`
 * for `.values`), or `undefined` when it is not a recognised iterator override.
 */
function arrayProtoOverrideKey(ctx: CodegenContext, target: ts.Expression): string | undefined {
  // Element access: Array.prototype[Symbol.iterator]
  if (ts.isElementAccessExpression(target)) {
    if (!isArrayPrototype(target.expression)) return undefined;
    const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
    if (key === "@@iterator" || key === "Symbol(Symbol.iterator)") return "@@iterator";
    if (key === "values") return "values";
    return undefined;
  }
  // Property access: Array.prototype.values
  if (ts.isPropertyAccessExpression(target)) {
    if (!isArrayPrototype(target.expression)) return undefined;
    if (target.name.text === "values") return "values";
    return undefined;
  }
  return undefined;
}

/**
 * (#1719 CPR) AST-only predicate (no `ctx`) for the module-init statement filter:
 * true when `target` is `Array.prototype[Symbol.iterator]` / `Array.prototype.values`,
 * so the override assignment is kept in `__module_init` instead of being dropped.
 * Matches the LHS shape recognised by `sourceOverridesArrayIterator`.
 */
export function isArrayProtoIteratorAssignTarget(target: ts.Expression): boolean {
  if (ts.isElementAccessExpression(target)) {
    if (!isArrayPrototype(target.expression)) return false;
    const arg = target.argumentExpression;
    // `Array.prototype[Symbol.iterator]` — Symbol.iterator is a property access
    // `Symbol.iterator`; accept it structurally (the precise key resolves later).
    if (
      ts.isPropertyAccessExpression(arg) &&
      ts.isIdentifier(arg.expression) &&
      arg.expression.text === "Symbol" &&
      arg.name.text === "iterator"
    ) {
      return true;
    }
    // `Array.prototype["values"]`
    if (ts.isStringLiteral(arg) && arg.text === "values") return true;
    return false;
  }
  if (ts.isPropertyAccessExpression(target)) {
    return isArrayPrototype(target.expression) && target.name.text === "values";
  }
  return false;
}

/** True when `e` is exactly `Array.prototype`. */
function isArrayPrototype(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "prototype" &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "Array"
  );
}

/**
 * If `target = value` is an `Array.prototype` iterator override, capture the
 * lifted RHS closure into `ctx.protoOverrides` (rooted in a module global) and
 * return `true` (the caller must NOT fall through to the normal element/property
 * assignment). Returns `false` (no-op) for every other assignment — byte-identical.
 *
 * Leaves the override closure externref on the stack as the assignment's value
 * (an assignment expression evaluates to its RHS).
 */
export function maybeCaptureArrayProtoOverride(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  value: ts.Expression,
): boolean {
  if (!ctx.arrayIteratorMaybeOverridden) return false;
  const memberKey = arrayProtoOverrideKey(ctx, target);
  if (memberKey === undefined) return false;
  // Only a function/arrow RHS is a drivable override (a non-callable value would
  // make GetIterator throw "not a function" — out of scope for the fast path).
  if (!ts.isFunctionExpression(value) && !ts.isArrowFunction(value)) return false;

  // Lift the RHS closure (handles `function*` generators). Leaves the closure
  // value (a ref to the closure struct) on the stack.
  const closureType = compileArrowAsClosure(ctx, fctx, value);
  if (!closureType) return false;

  // Reuse the already-rooted global when this `(token, memberKey)` was captured
  // on an earlier pass. `compileModuleInitBody()` compiles the module-init
  // statements TWICE (declarations.ts: early-discovery + final), so without this
  // guard a second override global would be pushed (orphaned, null-initialised).
  // We still emit the `global.set`/`global.get` into THIS body so the live
  // `__module_init` actually stores the freshly-lifted closure into the slot.
  const existing = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN)?.get(memberKey);
  const globalIdx = existing?.globalIdx ?? nextModuleGlobalIdx(ctx);
  if (existing === undefined) {
    // Root the closure in a fresh `mut externref` module global so it survives DCE
    // and the read-drive can `global.get` it. Convert the closure ref → externref.
    ctx.mod.globals.push({
      name: `__array_proto_${memberKey === "@@iterator" ? "iterator" : memberKey}_override`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" } as Instr],
    });
  }
  // Stack: [closure-ref]. Convert to externref (if not already) and tee into the
  // global, leaving the externref on the stack as the assignment value.
  if (closureType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }
  fctx.body.push({ op: "global.set", index: globalIdx } as Instr);
  fctx.body.push({ op: "global.get", index: globalIdx } as Instr);

  // Record into protoOverrides (funcIdx/funcTypeIdx unused by the global-driven
  // path; kept 0/-1 placeholders for the table shape).
  let inner = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN);
  if (!inner) {
    inner = new Map();
    ctx.protoOverrides.set(ARRAY_PROTO_TOKEN, inner);
  }
  inner.set(memberKey, { funcIdx: 0, funcTypeIdx: -1, globalIdx });
  return true;
}

/**
 * Returns the rooted override-closure global index for the Array `@@iterator`
 * override (the CPR drive consults this), or `undefined` when no override was
 * captured. `values` is treated as an alias for `@@iterator` per §23.1.3.36
 * (`Array.prototype.values` IS `Array.prototype[@@iterator]`), so either capture
 * drives array iteration.
 */
export function arrayIteratorOverrideGlobalIdx(ctx: CodegenContext): number | undefined {
  const inner = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN);
  if (!inner) return undefined;
  const entry = inner.get("@@iterator") ?? inner.get("values");
  return entry?.globalIdx;
}

/** funcMap key for the in-Wasm proto-iterator driver (option (a), #1719 CPR). */
const DRIVE_PROTO_ITERATOR = "__drive_proto_iterator";

/**
 * (#1719 CPR read-drive — option (a)) Reserve the `__drive_proto_iterator`
 * driver's funcIdx by pushing a placeholder function during body compilation,
 * BEFORE the post-processing phase that can resolve `__call_fn_method_0` (which
 * needs the fully-populated `closureInfoByTypeIdx`). The body is left empty and
 * filled by `fillProtoIteratorDriver` in post-processing. Returns the reserved
 * funcIdx (also stored in `funcMap[DRIVE_PROTO_ITERATOR]` so a late-import shift
 * patches it + the emitted read-drive `call` together).
 *
 * Idempotent: subsequent read-drive sites reuse the same reserved funcIdx.
 */
function reserveProtoIteratorDriver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(DRIVE_PROTO_ITERATOR);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$drive_proto_iterator_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const placeholder: WasmFunction = {
    name: DRIVE_PROTO_ITERATOR,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillProtoIteratorDriver in post-processing. A bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (no arity-0 closure ⇒ driver unreferenced anyway).
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);
  ctx.funcMap.set(DRIVE_PROTO_ITERATOR, funcIdx);
  ctx.protoIteratorDriverReserved = true;
  return funcIdx;
}

/**
 * (#1719 CPR read-drive — option (a)) Fill the reserved `__drive_proto_iterator`
 * driver body in post-processing, AFTER `emitClosureMethodCallExportN(0)` has
 * registered `__call_fn_method_0` in `funcMap`. The driver is a thin wrapper:
 *
 *   __drive_proto_iterator(thisVal, closure) =
 *     return __call_fn_method_0(thisVal, closure)
 *
 * reusing the proven re-entrancy-safe `__current_this` install/restore dispatch
 * (#1636-S1) instead of duplicating funcref-type dispatch at each read site. The
 * override closure is arity-0 (`Array.prototype[@@iterator]()` takes no args), so
 * arity-0 `__call_fn_method_0` is the exact driver. No-op when the driver was
 * never reserved (brand clear / no read-drive site).
 */
export function fillProtoIteratorDriver(ctx: CodegenContext): void {
  if (!ctx.protoIteratorDriverReserved) return;
  const driverIdx = ctx.funcMap.get(DRIVE_PROTO_ITERATOR);
  if (driverIdx === undefined) return;
  const driverFn = definedFuncAt(ctx, driverIdx);
  if (!driverFn) return;

  const callMethod0 = ctx.funcMap.get("__call_fn_method_0");
  if (callMethod0 === undefined) {
    // No arity-0 closure dispatcher emitted (no qualifying closure) — the driver
    // is unreachable from any live read-drive in that case, but keep a valid
    // body so the module verifies: return undefined (null externref).
    driverFn.body = [{ op: "ref.null.extern" } as Instr];
    return;
  }
  driverFn.body = [
    { op: "local.get", index: 0 } as Instr, // thisVal (array-as-this)
    { op: "local.get", index: 1 } as Instr, // override closure
    { op: "call", funcIdx: callMethod0 } as Instr,
    // result (iterator externref) stays on the stack as the return value
  ];
}

/**
 * (#1719 CPR read-drive) Emit the override drive at an array-destructuring /
 * for-of / spread observation site. PRECONDITION: the RHS vec ref is on the
 * stack and the caller has already gated on
 * `arrayIteratorMaybeOverridden && arrayIteratorOverrideGlobalIdx(ctx)!==undefined`.
 *
 * Lowers (§7.4.2 GetIterator + §8.5.2 IteratorBindingInitialization):
 *   1. `extern.convert_any` the vec → the array-as-`this` externref;
 *   2. `global.get` the captured override closure;
 *   3. `call __drive_proto_iterator(array, closure)` → the override-produced
 *      iterator externref, stashed in `iterLocal`.
 *
 * Returns the local holding the iterator externref. The caller drains it via
 * `__iterator_next` into the binding elements. Standalone-clean: the drive runs
 * in-Wasm (no host import, no host-Array reflection); only the per-element drain
 * uses the existing `__iterator_next` host import (dual-mode boundary, same as
 * for-of). The brand only fires here at the observation boundary, so internal
 * array iterations inside the override body stay on the typed-vec fast path —
 * no re-entrancy.
 */
export function emitArrayProtoIteratorDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  overrideGlobalIdx: number,
): number {
  const driverIdx = reserveProtoIteratorDriver(ctx);
  // Stack: [vec-ref]. Convert to the array-as-`this` externref.
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  // Push the override closure.
  fctx.body.push({ op: "global.get", index: overrideGlobalIdx } as Instr);
  // Drive: __drive_proto_iterator(array, closure) -> iterator externref.
  fctx.body.push({ op: "call", funcIdx: driverIdx } as Instr);
  const iterLocal = allocLocal(fctx, `__cpr_iter_${fctx.locals.length}`, { kind: "externref" } as ValType);
  fctx.body.push({ op: "local.set", index: iterLocal } as Instr);
  return iterLocal;
}
