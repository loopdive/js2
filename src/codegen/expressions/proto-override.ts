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
import {
  compileArrowAsClosure,
  ensureLateImport,
  flushLateImportShifts,
  resolveComputedKeyExpression,
} from "../shared.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
import {
  arrayProtoIteratorDeleteKey,
  arrayProtoIteratorOverrideKeyFromTarget,
} from "../array-proto-iterator-override-ast.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";

export { isArrayProtoIteratorAssignTarget } from "../array-proto-iterator-override-ast.js";

/** Canonical proto-owner token for `Array.prototype`. */
const ARRAY_PROTO_TOKEN = "Array";

/**
 * Map a `Array.prototype[<key>]` / `Array.prototype.<key>` assignment target to
 * the canonical CPR member key (`"@@iterator"` for `Symbol.iterator`, `"values"`
 * for `.values`), or `undefined` when it is not a recognised iterator override.
 */
function arrayProtoOverrideKey(ctx: CodegenContext, target: ts.Expression): string | undefined {
  const exactKey = arrayProtoIteratorOverrideKeyFromTarget(target);
  if (exactKey !== undefined) return exactKey;
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
  const globalIdx = rootArrayProtoOverrideGlobal(ctx, memberKey);
  // Stack: [closure-ref]. Convert to externref (if not already) and tee into the
  // global, leaving the externref on the stack as the assignment value.
  if (closureType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  fctx.body.push({ op: "global.set", index: globalIdx });
  fctx.body.push({ op: "global.get", index: globalIdx });

  return true;
}

/**
 * Root (once) the `mut externref` module global that holds the captured
 * `Array.prototype[<memberKey>]` override closure, and record it in
 * `ctx.protoOverrides`. Idempotent: the second call for the same key returns the
 * existing index without pushing another global.
 */
function rootArrayProtoOverrideGlobal(ctx: CodegenContext, memberKey: string): number {
  let inner = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN);
  if (!inner) {
    inner = new Map();
    ctx.protoOverrides.set(ARRAY_PROTO_TOKEN, inner);
  }
  const existing = inner.get(memberKey);
  if (existing !== undefined) return existing.globalIdx;
  const globalIdx = nextModuleGlobalIdx(ctx);
  const deleted = memberKey === ITERATOR_DELETED_KEY;
  ctx.mod.globals.push(
    deleted
      ? {
          name: "__array_proto_iterator_deleted",
          type: { kind: "i32" },
          mutable: true,
          init: [{ op: "i32.const", value: 0 }],
        }
      : {
          name: `__array_proto_${memberKey === "@@iterator" ? "iterator" : memberKey}_override`,
          type: { kind: "externref" },
          mutable: true,
          init: [{ op: "ref.null.extern" }],
        },
  );
  inner.set(memberKey, { funcIdx: 0, funcTypeIdx: -1, globalIdx });
  return globalIdx;
}

/**
 * (#5139) Pre-root the override globals for every `Array.prototype[@@iterator] =
 * <function|arrow>` / `Array.prototype.values = <function|arrow>` assignment the
 * source contains, BEFORE any user function body is compiled.
 *
 * The capture (`maybeCaptureArrayProtoOverride`) only runs when the module-init
 * statement itself is compiled, but a function body that destructures a
 * parameter array can be compiled FIRST — and its read-drive gate
 * (`arrayIteratorOverrideGlobalIdx(ctx) !== undefined`) then reads `undefined`
 * and silently takes the backing-store fast lane, ignoring the override. That is
 * exactly the class-method parameter case (`*-iter-val-array-prototype.js`):
 * the override is honored in a top-level `for`-of but not in a method's
 * parameter pattern. Rooting the slot up front makes the gate order-independent;
 * the slot is still WRITTEN by the capture at module-init time.
 *
 * Only function/arrow right-hand sides are pre-rooted, matching the capture's
 * own gate — otherwise the slot would stay null forever and the drive would
 * degrade a working fast path.
 */
export function reserveArrayProtoIteratorOverrideGlobals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (
      ctx.arrayIteratorMaybeOverridden &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))
    ) {
      const key = arrayProtoOverrideKey(ctx, node.left);
      if (key !== undefined) rootArrayProtoOverrideGlobal(ctx, key);
    }
    // (#5139) `delete Array.prototype[Symbol.iterator]` needs its own flag slot,
    // independent of the override brand (a source that only deletes never trips
    // `sourceOverridesArrayIterator`).
    if (arrayProtoIteratorDeleteKey(node) !== undefined) rootArrayProtoOverrideGlobal(ctx, ITERATOR_DELETED_KEY);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

/**
 * (#5139) Pseudo member key under which the `Array.prototype[@@iterator]`
 * DELETED flag (a `mut i32` module global, 0/1) is registered. It shares
 * `ctx.protoOverrides` with the closure slots purely to inherit their
 * late-import global-index shifting (`registry/imports.ts`); the readers of the
 * real keys (`@@iterator` / `values`) never see it.
 */
const ITERATOR_DELETED_KEY = "@@iterator:deleted";

/**
 * The `mut i32` flag global recording that the program executed `delete
 * Array.prototype[Symbol.iterator]`, or `undefined` when the source contains no
 * such delete. When set at runtime, GetIterator on an array must throw a
 * TypeError (§7.4.2 step 3: the `@@iterator` method is `undefined`).
 */
export function arrayIteratorDeletedGlobalIdx(ctx: CodegenContext): number | undefined {
  return ctx.protoOverrides.get(ARRAY_PROTO_TOKEN)?.get(ITERATOR_DELETED_KEY)?.globalIdx;
}

/**
 * Compile `delete Array.prototype[Symbol.iterator]` / `delete
 * Array.prototype.values`: raise the flag global and answer `true` (the property
 * is configurable, so the delete succeeds). Returns `false` when `node` is not
 * such a delete, or when the pre-scan rooted no slot for it.
 */
export function tryEmitArrayProtoIteratorDelete(ctx: CodegenContext, fctx: FunctionContext, node: ts.Node): boolean {
  if (arrayProtoIteratorDeleteKey(node) === undefined) return false;
  const globalIdx = arrayIteratorDeletedGlobalIdx(ctx);
  if (globalIdx === undefined) return false;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "global.set", index: globalIdx });
  fctx.body.push({ op: "i32.const", value: 1 });
  return true;
}

/**
 * (#5154 cluster A) `delete Array.prototype[Symbol.iterator]` — record the
 * override slot as a TOMBSTONE: root the same module global the assignment arm
 * uses, but never store a closure into it, so it stays `ref.null.extern`.
 *
 * The read-drive then reads a null override slot, which is exactly §7.4.2's
 * "GetMethod(obj, @@iterator) is undefined" ⇒ `Call` of a non-callable ⇒
 * TypeError. Without this the delete left no trace at all and the typed-vec
 * fast path bound `1, 2, 3` where the spec requires a throw
 * (the `ary-init-iter-get-err-array-prototype` family).
 *
 * Returns `true` when the target was a recognised Array-prototype iterator
 * member (the caller still lowers the delete normally — this only registers
 * the compile-time fact).
 */
export function maybeRecordArrayProtoIteratorTombstone(ctx: CodegenContext, target: ts.Expression): boolean {
  if (!ctx.arrayIteratorMaybeOverridden) return false;
  const memberKey = arrayProtoOverrideKey(ctx, target);
  if (memberKey === undefined) return false;
  let inner = ctx.protoOverrides.get(ARRAY_PROTO_TOKEN);
  if (!inner) {
    inner = new Map();
    ctx.protoOverrides.set(ARRAY_PROTO_TOKEN, inner);
  }
  if (inner.has(memberKey)) return true; // already rooted (assignment or a prior pass)
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: `__array_proto_${memberKey === "@@iterator" ? "iterator" : memberKey}_override`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
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
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name: DRIVE_PROTO_ITERATOR,
    typeIdx: sigIdx,
    locals: [],
    // Placeholder; filled by fillProtoIteratorDriver in post-processing. A bare
    // `unreachable` keeps the stub valid (externref result) if the fill is ever
    // skipped (no arity-0 closure ⇒ driver unreferenced anyway).
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
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
  if (driverIdx === undefined) {
    if (ctx.standalone) throw new Error("#1719 standalone CPR driver identity could not be resolved at fill");
    return;
  }
  const driverFn = definedFuncAt(ctx, driverIdx);
  if (!driverFn) {
    if (ctx.standalone) throw new Error("#1719 standalone CPR driver body could not be resolved at fill");
    return;
  }

  const callMethod0 = ctx.funcMap.get("__call_fn_method_0");
  if (callMethod0 === undefined) {
    if (ctx.standalone) {
      throw new Error("#1719 standalone CPR driver dispatcher could not be resolved at fill");
    }
    // No arity-0 closure dispatcher emitted (no qualifying closure) — the driver
    // is unreachable from any live read-drive in that case, but keep a valid
    // body so the module verifies: return undefined (null externref).
    driverFn.body = [{ op: "ref.null.extern" }];
    return;
  }
  driverFn.body = [
    { op: "local.get", index: 0 }, // thisVal (array-as-this)
    { op: "local.get", index: 1 }, // override closure
    { op: "call", funcIdx: callMethod0 },
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
 *   1. in standalone, reserve/settle the canonical `__iterator` normalizer;
 *   2. re-resolve the override global + driver after that settlement;
 *   3. `extern.convert_any` the vec → the array-as-`this` externref;
 *   4. `global.get` the captured override closure;
 *   5. `call __drive_proto_iterator(array, closure)` → the override-produced
 *      raw iterator externref;
 *   6. in standalone, call `__iterator(raw)` exactly once and stash the
 *      resulting `$IterRec` externref in `iterLocal`.
 *
 * Returns the local holding the consumer-ready iterator externref. The caller
 * drains it via `__iterator_next` into the binding elements. In GC/host this is
 * the legacy raw iterator contract. In standalone it is the native `$IterRec`
 * contract established by `__iterator`; both calls remain in-Wasm and add no
 * host import. WASI deliberately retains its previous bytes in this checkpoint.
 * The brand only fires here at the observation boundary, so internal array
 * iterations inside the override body stay on the typed-vec fast path — no
 * re-entrancy.
 */
export function emitArrayProtoIteratorDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  overrideGlobalIdxBeforeSettlement: number,
): number {
  let iteratorIdx: number | undefined;
  let overrideGlobalIdx = overrideGlobalIdxBeforeSettlement;
  let driverIdx: number;
  if (ctx.standalone) {
    // #1719 standalone contract: `__iterator_next` accepts only a canonical
    // `$IterRec`, while the captured generator override returns a raw
    // `$GenState_*`. Reserve the shared normalizer BEFORE retaining any
    // shiftable global/function index, then settle the late-import batch and
    // resolve every identity again from its authoritative registry.
    ensureLateImport(ctx, "__iterator", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    iteratorIdx = ctx.funcMap.get("__iterator");
    if (iteratorIdx === undefined) {
      throw new Error("#1719 standalone CPR normalizer '__iterator' could not be resolved");
    }
    const settledOverrideGlobalIdx = arrayIteratorOverrideGlobalIdx(ctx);
    if (settledOverrideGlobalIdx === undefined) {
      throw new Error("#1719 CPR override global could not be resolved after iterator settlement");
    }
    overrideGlobalIdx = settledOverrideGlobalIdx;
    reserveProtoIteratorDriver(ctx);
    const settledDriverIdx = ctx.funcMap.get(DRIVE_PROTO_ITERATOR);
    if (settledDriverIdx === undefined) {
      throw new Error("#1719 CPR driver could not be resolved after iterator settlement");
    }
    driverIdx = settledDriverIdx;
  } else {
    // Preserve the established GC/WASI path literally: its caller-resolved
    // global and the direct reserve result remain authoritative.
    driverIdx = reserveProtoIteratorDriver(ctx);
  }
  // (#5154 cluster A) §7.4.2 GetIterator: an EMPTY override slot means the
  // program removed `Array.prototype[@@iterator]` (`delete …`), so the method
  // is `undefined` and calling it is a TypeError. Check before the drive so the
  // throw happens at the observation boundary, not as a null-funcref trap. A
  // module that only ASSIGNS an override has stored its closure by the time any
  // consumer runs, so this branch is dead there.
  fctx.body.push({ op: "global.get", index: overrideGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, "TypeError", "TypeError: Array.prototype[Symbol.iterator] is not a function", {
      flush: fctx,
    }),
    else: [],
  });
  // Stack: [vec-ref]. Convert to the array-as-`this` externref.
  fctx.body.push({ op: "extern.convert_any" });
  // Push the override closure.
  fctx.body.push({ op: "global.get", index: overrideGlobalIdx });
  // Drive: __drive_proto_iterator(array, closure) -> raw iterator externref.
  fctx.body.push({ op: "call", funcIdx: driverIdx });
  if (iteratorIdx !== undefined) {
    // Standalone only: normalize the raw `$GenState_*` exactly once. Every
    // existing declaration/parameter/for-of-head/assignment/spread consumer
    // can keep its proven `__iterator_next($IterRec)` ABI unchanged.
    fctx.body.push({ op: "call", funcIdx: iteratorIdx });
  }
  const iterLocal = allocLocal(fctx, `__cpr_iter_${fctx.locals.length}`, { kind: "externref" } as ValType);
  fctx.body.push({ op: "local.set", index: iterLocal });
  return iterLocal;
}
