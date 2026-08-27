// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Destructuring declaration lowering.
 * Handles object destructuring, array destructuring, and string destructuring patterns.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { reportError } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { snapshotSpeculative, rollbackSpeculative, type SpeculativeSnapshot } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "../expressions/late-imports.js";
import {
  addIteratorImports,
  ensureLetConstBindingPatternTdzFlags,
  ensureNativeStringHelpers,
  ensureStructForType,
  nativeStringType,
  resolveWasmType,
} from "../index.js";
import { isUndefWidenedBindingElement, resolveBindingElementType } from "../../checker/type-mapper.js";
// (#3100 S4) The string-rest lowering builds the rest `string[]` natively from
// the #1470 per-code-point char vec instead of the host `__extern_slice`.
import { ensureStrToCharVecHelper } from "../native-strings.js";
import {
  type BindingKind,
  buildDestructureNullThrow,
  coerceArrayBindingExternrefToAnyValue,
  destructureParamArray,
  destructureParamObject,
  emitExternrefDestructureGuard,
} from "../destructuring-params.js";
import { addImport, addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "../registry/imports.js";
import { emitWasiErrorConstructor } from "../registry/error-types.js";
import { usesNativeJsErrors } from "../js-errors.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "../registry/types.js";
import { getVecInfo } from "../type-coercion.js";
import {
  coerceType,
  compileExpression,
  emitBoundsCheckedArrayGet,
  materializeStructAsObject,
  registerEmitDefaultValueCheck,
  registerEmitNestedBindingDefault,
  registerEnsureBindingLocals,
  valTypesMatch,
} from "../shared.js";
import { collectInstrs } from "./shared.js";
import { emitLocalTdzInit } from "./tdz.js";
import { arrayIteratorOverrideGlobalIdx, emitArrayProtoIteratorDrive } from "../expressions/proto-override.js";
import { ensureNativeIteratorRuntime } from "../iterator-native.js";
import { emitDrainCustomIterableToVec, isCustomIterable } from "../custom-iterable.js";
import { emitNativeGeneratorToVec, nativeGeneratorInfoForForOfSubject } from "../generators-native.js";

/**
 * (#1719 S1) Gate predicate for the array object-value representation track.
 *
 * Returns true iff array destructuring of a **typed vec / tuple RHS** must
 * route through the host-Array reflection + host `GetIterator` lane instead of
 * the backing-store fast path — i.e. when the program's `ITER_OVERRIDDEN`
 * whole-program brand (`ctx.arrayIteratorMaybeOverridden`, set by
 * `sourceOverridesArrayIterator`) is set AND the RHS is not a string.
 *
 * The string exclusion is load-bearing: a string is not an Array, so a
 * monkeypatched `Array.prototype[@@iterator]` cannot affect string
 * destructuring, and routing a string through the array iterator lane would
 * regress string dstr (per the architecture spec).
 *
 * **S1 status (this PR):** this predicate establishes the *placement and
 * string guard* the architecture spec mandates keeping from dev-a's
 * scaffolding, but the routing target it gates is supplied by **S2** (the
 * host-Array reflection helper + host `GetIterator`). Until S2 lands, callers
 * evaluate this predicate but fall through to the existing fast path — so the
 * predicate is correct and unit-tested while the codegen is behaviorally a
 * no-op (zero test delta, the spec's S1 requirement). When
 * `ctx.arrayIteratorMaybeOverridden` is false (the common case) this is always
 * false, guaranteeing byte-identical output.
 *
 * Spec: §7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization.
 */
export function arrayDstrNeedsIdentity(ctx: CodegenContext, isStringRHS: boolean): boolean {
  return ctx.arrayIteratorMaybeOverridden && !isStringRHS;
}

/**
 * (#1719 CPR read-drive) Drive a captured `Array.prototype[@@iterator]` override
 * for a typed-vec/tuple array-destructuring RHS, so the override's custom
 * iterator (not the backing store) supplies the binding values
 * (§8.5.2 IteratorBindingInitialization). PRECONDITION: the vec ref is on the
 * stack and the caller gated on `arrayDstrNeedsIdentity && override-captured`.
 *
 * Scope (CPR-1): the binding pattern is all **identifier** elements (with optional
 * `= default`) and elisions, **no rest / no nested** pattern — exactly the shape
 * of the 71 `*-iter-val-array-prototype.js` tests. Returns `false` (caller falls
 * through to the backing-store fast path) for rest/nested patterns so those are
 * not regressed; CPR-2 widens the shape.
 *
 * Lowering: drive override → iterator (in-Wasm, `__drive_proto_iterator`), then
 * per element `__iterator_next` → `(i32 done, externref value)`; on `done` the
 * element takes its default (or `undefined`), else `value` coerced to the binding
 * local's type. The brand only fires at this observation boundary, so internal
 * array iterations inside the override body stay on the typed-vec fast path — no
 * re-entrancy / no infinite loop.
 */
export function tryEmitArrayProtoIteratorReadDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayBindingPattern,
  resultType: ValType,
  /**
   * (#1719 CPR-2) When provided, the array value is read from this local instead
   * of consumed from the stack — lets the for-of-head / parameter dstr sites
   * (whose value lives in a local) reuse this exact drive+drain. `undefined` ⇒
   * the decl-dstr caller's convention (vec ref already on the stack).
   */
  srcLocal?: number,
): boolean {
  const overrideGlobalIdx = arrayIteratorOverrideGlobalIdx(ctx);
  if (overrideGlobalIdx === undefined) return false;

  // CPR shape gate: only plain identifiers (+ optional default) and elisions.
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (el.dotDotDotToken) return false; // rest → follow-up
    if (!ts.isIdentifier(el.name)) return false; // nested → follow-up
  }

  // Pre-register __iterator_next (the for-of multi-value drain shape) BEFORE
  // emitting any drive instructions, so a missing import bails cleanly (returns
  // false → caller uses the fast path) without leaving half-emitted bytes.
  const nextIdx = ensureLateImport(
    ctx,
    "__iterator_next",
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (nextIdx === undefined) return false;

  // Put the array value on the stack: from `srcLocal` (for-of / param convention)
  // or from a fresh stash of the already-on-stack vec ref (decl convention). The
  // value may be a vec ref OR an externref (for-of elements are often externref);
  // `emitArrayProtoIteratorDrive` does `extern.convert_any`, which only accepts
  // an anyref/(ref any) — so an externref source must be converted first.
  if (srcLocal !== undefined) {
    const srcType = getLocalType(fctx, srcLocal) ?? ({ kind: "externref" } as ValType);
    fctx.body.push({ op: "local.get", index: srcLocal });
    if (srcType.kind === "externref") {
      // externref → anyref so the drive's `extern.convert_any` (any→extern) is
      // the right direction. (#1719 CPR-2)
      fctx.body.push({ op: "any.convert_extern" });
    }
  } else {
    const vecLocal = allocLocal(fctx, `__cpr_vec_${fctx.locals.length}`, resultType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    fctx.body.push({ op: "local.get", index: vecLocal });
  }
  const iterLocal = emitArrayProtoIteratorDrive(ctx, fctx, overrideGlobalIdx);
  const doneLocal = allocLocal(fctx, `__cpr_done_${fctx.locals.length}`, { kind: "i32" });
  const valLocal = allocLocal(fctx, `__cpr_val_${fctx.locals.length}`, { kind: "externref" });

  // Build the per-element drain into a buffer, then guard it on a non-null
  // iterator. If the override drive returns null (e.g. the closure dispatch
  // couldn't resolve the override — a TS-cast `(Array.prototype as any)[…]`
  // generator whose compiled shape the arity-0 dispatcher doesn't match), the
  // bindings stay at their TDZ/zero defaults rather than trapping on
  // `__iterator_next(null)`. The 71 `.js` test262 cases resolve a real iterator;
  // this guard only makes the unresolved-override edge degrade gracefully.
  const drainInstrs: Instr[] = collectInstrs(fctx, () => {
    for (const el of pattern.elements) {
      // Advance the iterator: (done, value) = __iterator_next(iter).
      fctx.body.push({ op: "local.get", index: iterLocal });
      fctx.body.push({ op: "call", funcIdx: nextIdx });
      fctx.body.push({ op: "local.set", index: valLocal }); // value (top)
      fctx.body.push({ op: "local.set", index: doneLocal }); // done (below)

      if (ts.isOmittedExpression(el) || !ts.isIdentifier(el.name)) continue; // elision: just advance

      const name = el.name.text;
      const localIdx = fctx.localMap.get(name);
      if (localIdx === undefined) continue;
      const localType = getLocalType(fctx, localIdx) ?? ({ kind: "externref" } as ValType);

      // value-present arm: coerce `value` externref → the binding's local type.
      const assignFromValue: Instr[] = collectInstrs(fctx, () => {
        fctx.body.push({ op: "local.get", index: valLocal });
        coerceType(ctx, fctx, { kind: "externref" }, localType);
        fctx.body.push({ op: "local.set", index: localIdx });
      });

      // done / default arm: if the element has `= init`, evaluate it; else leave
      // the local at its zero/undefined default (already TDZ-initialised upstream).
      let defaultArm: Instr[] = [];
      if (el.initializer) {
        defaultArm = collectInstrs(fctx, () => {
          const initType = compileExpression(ctx, fctx, el.initializer!);
          if (initType) {
            if (!valTypesMatch(initType, localType)) coerceType(ctx, fctx, initType, localType);
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        });
      }
      // ECMA-262 §8.5.2: when the iterator step is done, the value is `undefined`
      // and the binding takes its default if present. We model that with the
      // `done` flag: done ⇒ default arm, else ⇒ assign drained value. (A
      // present-but-`undefined` value also triggers the default per dstr-binding
      // semantics; CPR-2 folds that in — the 71 tests yield concrete values.)
      fctx.body.push({ op: "local.get", index: doneLocal });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultArm,
        else: assignFromValue,
      });
    }
  });

  // if (iter !== null) { drain }
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: drainInstrs,
    else: [],
  });
  return true;
}

export function ensureBindingLocals(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      // Always create a shadow local, even for module globals.
      // syncDestructuredLocalsToGlobals will copy the local to the global afterwards.
      // Without a local, nested binding pattern destructuring silently skips the
      // assignment because fctx.localMap.get(name) returns undefined (#794).
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveBindingElementType(element, elemType, (t) => resolveWasmType(ctx, t));
      allocLocal(fctx, name, wasmType);
      // (#3315) Widened parameter array-pattern binding — mark it so
      // identifier reads skip the checker-type unbox narrowing (which would
      // degrade a runtime `undefined` to NaN before it can be observed).
      if (isUndefWidenedBindingElement(element, resolveWasmType(ctx, elemType))) {
        (fctx.undefWidenedLocals ??= new Set()).add(name);
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      ensureBindingLocals(ctx, fctx, element.name);
    }
  }
}

/**
 * True when the binding pattern is declared at module top level — i.e. its
 * nearest function-like ancestor is the SourceFile, not a nested function.
 *
 * #1690b: only module-level destructuring bindings genuinely back a module
 * global and need the local→global writeback. A `var [a] = ...` / `var {a} =
 * ...` declared inside a function body introduces a function-local that
 * shadows any same-named module global, so its destructured value must NOT be
 * synced to the global (doing so corrupted the module binding).
 */
function isModuleLevelBindingPattern(pattern: ts.BindingPattern): boolean {
  let n: ts.Node | undefined = pattern;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      return false;
    }
    if (ts.isSourceFile(n)) return true;
    n = n.parent;
  }
  return false;
}

/**
 * After destructuring, sync any bound locals that have corresponding module
 * globals. Destructuring stores values into locals, but module-level variables
 * need to also be written via global.set so other functions can read them.
 */
export function syncDestructuredLocalsToGlobals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  // #1690b: a destructuring declaration inside a function body binds
  // function-locals that shadow module globals — never write them back.
  const isModuleLevel = isModuleLevelBindingPattern(pattern);
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        // #1452 — every binding-pattern element that successfully ran
        // through destructuring needs its TDZ flag flipped to
        // "initialized". The struct-path object form already calls
        // `emitLocalTdzInit` inline (destructuring.ts:677), but the
        // externref array fallback, vec/tuple-struct array forms, and
        // rest-element branches do not. Doing it here piggybacks on
        // the central "destructure complete" callsite — and is a
        // no-op for non-let/const bindings, which have no TDZ flag.
        emitLocalTdzInit(fctx, name);
        const moduleGlobalIdx = isModuleLevel ? ctx.moduleGlobals.get(name) : undefined;
        const localIdx = fctx.localMap.get(name);
        if (moduleGlobalIdx !== undefined && localIdx !== undefined) {
          const localType = getLocalType(fctx, localIdx);
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
          const globalType = globalDef?.type;
          fctx.body.push({ op: "local.get", index: localIdx });
          // Coerce local type to global type if they differ
          if (localType && globalType && !valTypesMatch(localType, globalType)) {
            coerceType(ctx, fctx, localType, globalType);
          }
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        syncDestructuredLocalsToGlobals(ctx, fctx, element.name);
      }
    }
  }
}

/**
 * Wrap a set of destructuring instructions in a null guard.
 *
 * For `ref_null` source types the instructions are only executed when the
 * reference is non-null:
 *
 *   local.get $srcLocal
 *   ref.is_null
 *   if (then: [] else: <instrs>)
 *
 * For non-nullable refs the instructions are emitted directly.
 *
 * `emitFn` should populate `fctx.body` with the instructions to guard.
 * The helper temporarily swaps `fctx.body` so the caller's body is not
 * modified by `emitFn`.
 */
export function emitNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  srcLocal: number,
  isNullable: boolean,
  emitFn: () => void,
  srcKind?: ValType["kind"],
): void {
  // Pre-register late imports BEFORE collecting guardInstrs. collectInstrs
  // pops savedBodies on return, leaving guardInstrs orphaned — any late-import
  // shift fired after that (e.g. from buildDestructureNullThrow /
  // ensureExternIsUndefined) would miss funcIdx values inside guardInstrs,
  // corrupting nested default-initializer calls.
  const throwInstrs = isNullable ? buildDestructureNullThrow(ctx, fctx) : null;
  const undefIdx = isNullable && srcKind === "externref" ? ensureExternIsUndefined(ctx, fctx) : undefined;
  const guardInstrs = collectInstrs(fctx, emitFn);
  // Per spec §14.3.3.1/§8.4.2: destructuring null/undefined must throw TypeError.
  // Skip guard for empty patterns (#225) — only fire when there are real property accesses.
  if (isNullable && guardInstrs.length > 0 && throwInstrs) {
    // For externref sources we also need to catch JS undefined (non-null externref
    // wrapping the undefined value). Emit a unified boolean: ref.is_null || __extern_is_undefined
    if (srcKind === "externref") {
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "ref.is_null" });
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "call", funcIdx: undefIdx });
        fctx.body.push({ op: "i32.or" });
      }
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: guardInstrs });
    } else {
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: guardInstrs });
    }
  } else {
    fctx.body.push(...guardInstrs);
  }
}

/**
 * Ensure __async_iterator is available; return its function index.
 *
 * JS-host mode: register `env.__async_iterator`
 *   (obj) => obj[Symbol.asyncIterator]?.() ?? obj[Symbol.iterator]()
 *
 * (#2038) Standalone / WASI: there is no JS host to satisfy that import, and
 * feeding the host carrier to the native `__iterator_next` traps `illegal cast`.
 * Per §7.4.3 GetIterator(async) + §27.1.4.1 CreateAsyncFromSyncIterator, for a
 * **sync-backed** async iterable (the dominant test262 shape — `for await (x of
 * [literals])` and `for await (x of syncIterable)`) the async iterator is the
 * sync iterator with each value `Await`-ed; for an already-settled value
 * `Await(v) = v`, so the async wrapper degenerates to the *identity* native
 * iterator. So in standalone we return the SAME native `__iterator` the sync
 * for-of consumer uses (now USER-`{next()}`-carrier aware). The per-element
 * `Await` is layered by the for-await CPS lowering around the loop body and is a
 * no-op for settled values — no `env.__async_iterator` / `env.Promise_resolve`
 * leak. Genuinely-pending-Promise async iterables stay deferred to the standalone
 * Promise runtime (PR-C).
 */
export function ensureAsyncIterator(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  if (ctx.standalone || ctx.wasi) {
    ensureNativeIteratorRuntime(ctx);
    return ctx.funcMap.get("__iterator");
  }
  const idx = ctx.funcMap.get("__async_iterator");
  if (idx !== undefined) return idx;
  const importsBefore = ctx.numImportFuncs;
  const fnType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__async_iterator", { kind: "func", typeIdx: fnType });
  shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
  return ctx.funcMap.get("__async_iterator");
}

/**
 * Ensure __extern_is_undefined import is available.
 * Returns the function index, or undefined if registration failed.
 * JS impl: (v: unknown) => v === undefined ? 1 : 0
 */
export function ensureExternIsUndefined(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  return idx;
}

/**
 * Emit a check for whether an externref value should trigger a default value.
 * Per JS spec, destructuring defaults apply when the value is `undefined`.
 * We check both ref.is_null (wasm null, e.g. uninitialized array slots) and
 * JS undefined (non-null externref wrapping the JS undefined value).
 *
 * Precondition: externref value on the stack and saved in tmpLocal.
 * Postcondition: i32 on the stack (1 = use default, 0 = has value).
 */
export function emitExternrefDefaultCheck(ctx: CodegenContext, fctx: FunctionContext, tmpLocal: number): void {
  const isUndefIdx = ensureExternIsUndefined(ctx, fctx);
  if (isUndefIdx !== undefined) {
    // JS destructuring defaults apply only when value === undefined, NOT for null.
    // In the WebAssembly JS API, JS null maps to ref.null extern, so ref.is_null
    // would incorrectly trigger defaults for null values. Only use __extern_is_undefined.
    // The stack already has the externref from local.tee — call directly.
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
  } else {
    // Fallback: just ref.is_null (imprecise — treats null as undefined)
    fctx.body.push({ op: "ref.is_null" });
  }
}

/**
 * Emit a default-value check for a nested binding pattern in array destructuring.
 *
 * When an array element is a nested binding pattern with a default initializer
 * (e.g. `[{ x, y } = defaults]`), we need to check if the extracted value is
 * null/undefined and if so, compile the initializer and store it as the value
 * before the nested destructuring runs.
 */
export function emitNestedBindingDefault(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nestedLocal: number,
  valueType: ValType,
  initializer: ts.Expression,
): void {
  // For ref/ref_null types, check ref.is_null
  if (valueType.kind === "ref" || valueType.kind === "ref_null") {
    fctx.body.push({ op: "local.get", index: nestedLocal });
    fctx.body.push({ op: "ref.is_null" });
    const defaultInstrs = collectInstrs(fctx, () => {
      const initType = compileExpression(ctx, fctx, initializer, valueType);
      if (initType && !valTypesMatch(initType, valueType)) {
        coerceType(ctx, fctx, initType, valueType);
      }
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultInstrs,
        else: [],
      });
    }
  } else if (valueType.kind === "externref") {
    fctx.body.push({ op: "local.get", index: nestedLocal });
    emitExternrefDefaultCheck(ctx, fctx, nestedLocal);
    const defaultInstrs = collectInstrs(fctx, () => {
      const initType = compileExpression(ctx, fctx, initializer, valueType);
      if (initType && initType.kind !== "externref") {
        if (initType.kind === "ref" || initType.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else if (initType.kind === "f64") {
          const bIdx = ctx.funcMap.get("__box_number");
          if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
        } else if (initType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          const bIdx = ctx.funcMap.get("__box_number");
          if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
        }
      }
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultInstrs,
        else: [],
      });
    }
  } else if (valueType.kind === "f64") {
    // Check for sNaN sentinel (0x7FF00000DEADC0DE) — NOT generic NaN.
    // This distinguishes missing/undefined from explicit NaN arguments (#866).
    fctx.body.push({ op: "local.get", index: nestedLocal });
    fctx.body.push({ op: "i64.reinterpret_f64" });
    fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
    fctx.body.push({ op: "i64.eq" });
    const defaultInstrs = collectInstrs(fctx, () => {
      compileExpression(ctx, fctx, initializer, valueType);
      fctx.body.push({ op: "local.set", index: nestedLocal });
    });
    if (defaultInstrs.length > 0) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: defaultInstrs,
        else: [],
      });
    }
  }
  // For i32 there's no reliable sentinel — skip default check
}

/**
 * Emit a default-value check for a destructured binding.
 *
 * The stack must contain the extracted field/element value.  For externref
 * types we check `ref.is_null || __extern_is_undefined` — JS destructuring
 * defaults apply when the value is `undefined`.  For f64 we check for NaN
 * (the "undefined" sentinel).  For i32 there is no reliable sentinel so we
 * just assign directly.
 *
 * @param fieldType - the Wasm type of the value currently on the stack
 * @param localIdx  - destination local for the bound variable
 * @param initializer - the TS default-value expression
 * @param targetType  - optional override for the type hint passed to compileExpression
 * @param objectPropertySemantics - when true, the value originates from an
 *   object property read (KeyedBindingInitialization §13.3.3.7), where every
 *   declared field exists and a `null` value is a genuine JS `null` — NOT a
 *   "missing" hole. Per spec the default fires only on `undefined`, so JS
 *   `null` (encoded as wasm-null / ref.null.extern) must NOT trigger it. For
 *   `ref`/`ref_null` fields we therefore convert to externref and use the
 *   strict `__extern_is_undefined` predicate instead of `ref.is_null` (which
 *   would wrongly fire for `null`). Array/iterator binding (§13.3.3.6) leaves
 *   this false: a wasm-null element there can mean "iterator exhausted /
 *   missing", which DOES fire the default.
 */
export function emitDefaultValueCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  localIdx: number,
  initializer: ts.Expression,
  targetType?: ValType,
  objectPropertySemantics?: boolean,
): void {
  const hintType = targetType ?? fieldType;

  // Compile the default initializer and store it into localIdx, coercing the
  // initializer's actual result type to the local's declared type. Without this
  // coercion the then-branch can push a value whose Wasm type differs from the
  // local (e.g. a void `counter()` call yields externref while the local is
  // f64), making the *whole* if/else fail to validate even when the default
  // never fires at runtime (#1593).
  const emitDefaultIntoLocal = (): void => {
    const initType = compileExpression(ctx, fctx, initializer, hintType);
    const localType = getLocalType(fctx, localIdx);
    if (initType && localType && !valTypesMatch(initType, localType)) {
      coerceType(ctx, fctx, initType, localType);
    }
    fctx.body.push({ op: "local.set", index: localIdx });
  };

  // Object-property semantics: a `ref`/`ref_null` field holding wasm-null is a
  // genuine JS `null` (the struct always has the declared field), so the
  // default must NOT fire. Route through externref + __extern_is_undefined so
  // only `undefined` triggers the initializer. (#1550)
  if (objectPropertySemantics && (fieldType.kind === "ref" || fieldType.kind === "ref_null")) {
    const extTmp = allocLocal(fctx, `__dflt_ext_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.tee", index: extTmp });
    emitExternrefDefaultCheck(ctx, fctx, extTmp);
    const thenInstrs = collectInstrs(fctx, emitDefaultIntoLocal);
    const elseInstrs = collectInstrs(fctx, () => {
      // Convert the externref back to the field's any-ref type for the local.
      fctx.body.push({ op: "local.get", index: extTmp });
      fctx.body.push({ op: "any.convert_extern" });
      if (fieldType.kind === "ref") {
        fctx.body.push({ op: "ref.cast", typeIdx: (fieldType as { typeIdx: number }).typeIdx });
      } else if ((fieldType as { typeIdx?: number }).typeIdx !== undefined) {
        fctx.body.push({ op: "ref.cast_null", typeIdx: (fieldType as { typeIdx: number }).typeIdx });
      }
      // (#2878 Class A) Coerce to the binding local's actual type, not targetType.
      const localType = getLocalType(fctx, localIdx);
      const coerceTo = localType ?? targetType;
      if (coerceTo && !valTypesMatch(fieldType, coerceTo)) {
        coerceType(ctx, fctx, fieldType, coerceTo);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: elseInstrs,
    });
    return;
  }

  // Build the else branch (value is NOT undefined — use it as-is, with coercion).
  //
  // (#2878 Class A) Coerce to the BINDING LOCAL's actual declared type
  // (`getLocalType(localIdx)`), NOT to `targetType`. The `local.set` below must
  // match the local's Wasm type, and `targetType` can be absent or diverge from
  // it (e.g. a heterogeneous object literal boxes every field to externref, so
  // `fieldType` is externref while the binding local is f64 for a `number`
  // binding). Coercing externref→f64 here unboxes the boxed number correctly;
  // the old `targetType`-only path skipped coercion and stored an externref into
  // an f64 local → "local.set expected f64, found externref" invalid Wasm. This
  // mirrors `emitDefaultIntoLocal` above, which already keys off `getLocalType`.
  const buildElseBranch = (tmpField: number): Instr[] => {
    const localType = getLocalType(fctx, localIdx);
    const coerceTo = localType ?? targetType;
    if (coerceTo && !valTypesMatch(fieldType, coerceTo)) {
      return collectInstrs(fctx, () => {
        fctx.body.push({ op: "local.get", index: tmpField });
        if (!coerceArrayBindingExternrefToAnyValue(ctx, fctx, fieldType, coerceTo)) {
          coerceType(ctx, fctx, fieldType, coerceTo);
        }
        fctx.body.push({ op: "local.set", index: localIdx });
      });
    }
    return [
      { op: "local.get", index: tmpField },
      { op: "local.set", index: localIdx },
    ];
  };

  if (fieldType.kind === "externref") {
    const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.tee", index: tmpField });
    emitExternrefDefaultCheck(ctx, fctx, tmpField);
    const thenInstrs = collectInstrs(fctx, emitDefaultIntoLocal);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: buildElseBranch(tmpField),
    });
  } else if (fieldType.kind === "f64") {
    const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.tee", index: tmpField });
    // Check for sNaN sentinel (0x7FF00000DEADC0DE) — NOT generic NaN.
    // This distinguishes missing/undefined from explicit NaN arguments (#866).
    fctx.body.push({ op: "i64.reinterpret_f64" });
    fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
    fctx.body.push({ op: "i64.eq" });
    const thenInstrs = collectInstrs(fctx, emitDefaultIntoLocal);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: buildElseBranch(tmpField),
    });
  } else if (fieldType.kind === "ref_null" || fieldType.kind === "ref") {
    // Nullable ref types: check ref.is_null for default value
    const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.tee", index: tmpField });
    fctx.body.push({ op: "ref.is_null" });
    const thenInstrs = collectInstrs(fctx, emitDefaultIntoLocal);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: buildElseBranch(tmpField),
    });
  } else {
    // i32 and other types — no reliable undefined sentinel, just assign.
    // (#2878 Class A) Coerce to the binding local's actual type, not targetType.
    const localType = getLocalType(fctx, localIdx);
    const coerceTo = localType ?? targetType;
    if (coerceTo && !valTypesMatch(fieldType, coerceTo)) {
      coerceType(ctx, fctx, fieldType, coerceTo);
    }
    fctx.body.push({ op: "local.set", index: localIdx });
  }
}

export function compileObjectDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (!decl.initializer) return;

  const pattern = decl.name as ts.ObjectBindingPattern;

  // #1128: for let/const destructuring, (re-)allocate TDZ flags per binding.
  // The function-level pre-pass (walkStmtForLetConst) may have allocated these,
  // but block-scope shadowing wipes them when we enter an inner block.
  const isLetConst = (decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
  if (isLetConst) {
    ensureLetConstBindingPatternTdzFlags(ctx, fctx, pattern);
  }

  // #1919 — snapshot the speculative state so a failed struct lookup rolls back
  // the compiled initializer value AND any locals / late imports / errors it
  // leaked, not just the body length.
  const snap = snapshotSpeculative(ctx, fctx);

  // Compile the initializer — result is a struct ref on the stack
  const resultType = compileExpression(ctx, fctx, decl.initializer);
  if (!resultType) return;

  // If the result is already externref (or a scalar), use the externref fallback directly
  if (resultType.kind === "externref") {
    compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, resultType);
    return;
  }
  if (resultType.kind === "f64" || resultType.kind === "i32") {
    // Box scalar to externref and use externref fallback
    if (resultType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
      return;
    }
    // No __box_number available — fall through to error
  }

  // Determine struct type — prefer the actual Wasm type from compileExpression
  // over the TS checker, because anonymous object literals may register different
  // ts.Type objects for the initializer vs the destructuring pattern, leading to
  // mismatched struct type indices.
  let structTypeIdx: number | undefined;
  let fields: { name: string; type: ValType; mutable: boolean }[] | undefined;
  let typeName: string | undefined;

  if (resultType.kind === "ref" || resultType.kind === "ref_null") {
    const actualTypeIdx = (resultType as { typeIdx: number }).typeIdx;
    // Look up the struct name by its type index
    typeName = ctx.typeIdxToStructName.get(actualTypeIdx);
    if (typeName !== undefined) {
      structTypeIdx = actualTypeIdx;
      fields = ctx.structFields.get(typeName);
    }
  }

  // Fallback to TS checker resolution if resultType didn't give us a struct
  if (structTypeIdx === undefined || !fields) {
    const initType = ctx.checker.getTypeAtLocation(decl.initializer);
    const symName = initType.symbol?.name;
    typeName =
      symName && symName !== "__type" && symName !== "__object" && ctx.structMap.has(symName)
        ? symName
        : (ctx.anonTypeMap.get(initType) ?? symName);

    // Auto-register anonymous object types (same as expression-level destructuring)
    if (
      (!typeName || typeName === "__type" || typeName === "__object") &&
      !ctx.anonTypeMap.has(initType) &&
      initType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, initType);
      typeName = ctx.anonTypeMap.get(initType) ?? typeName;
    }

    if (!typeName) {
      // Type is unknown — fall back to externref property access
      if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        return;
      }
      rollbackSpeculative(ctx, fctx, snap); // value would otherwise leak on stack
      ensureBindingLocals(ctx, fctx, pattern);
      reportError(ctx, decl, "Cannot destructure: unknown type");
      return;
    }

    structTypeIdx = ctx.structMap.get(typeName);
    fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) {
      // Known type name but no struct — fall back to externref
      if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        return;
      }
      rollbackSpeculative(ctx, fctx, snap); // value would otherwise leak on stack
      ensureBindingLocals(ctx, fctx, pattern);
      reportError(ctx, decl, `Cannot destructure: not a known struct type: ${typeName}`);
      return;
    }
  }

  // #1553b — delegate the typed-struct destructuring body to the shared
  // helper used for function parameters / catch clauses. The helper handles:
  //   - null guard with TypeError (buildDestructureNullThrow)
  //   - per-binding default-value checks (emitDefaultValueCheck) — fixes Bug 3
  //   - nested patterns with their own defaults (emitNestedBindingDefault)
  //   - decl-mode TDZ flag init (emitLocalTdzInit) when `mode:'decl'`
  //   - let/const pre-pass via ensureLetConstBindingPatternTdzFlags when
  //     `bindingKind` is "let"/"const"
  // The helper does NOT support a rest binding on the typed-struct fast path
  // (struct.get cannot enumerate own properties). When the pattern carries
  // `...rest`, fall through to the externref path which collects via
  // __extern_rest_object — that is spec-correct and matches prior behaviour.
  const hasRestElement = pattern.elements.some((e) => ts.isBindingElement(e) && !!e.dotDotDotToken);
  if (hasRestElement) {
    if (resultType.kind === "ref" || resultType.kind === "ref_null") {
      // (#3222 C1/#4397) With native semantic providers, the externref rest path collects the rest
      // binding via `__extern_rest_object` → `__object_keys`, which walks only
      // the open-`$Object` hash. A CLOSED-shape struct source (`{a,...rest} =
      // {a:1,b:2,c:3}`) reinterpreted as externref via `extern.convert_any` is
      // invisible to that enumeration, so `rest` came out EMPTY. Instead
      // materialize the struct into a real open `$Object` first (own-enumerable
      // fields only) so both the named-binding `__extern_get`s and the
      // `__extern_rest_object` collection see every property. Host-assisted
      // compatibility mode keeps its existing host reflection path.
      if (ctx.targetProfile.semanticProviders === "native-first" && structTypeIdx !== undefined) {
        // Match the materialize helper's local type (ref_null <structTypeIdx>);
        // an anonymous-literal source may have a different resultType.typeIdx.
        if ((resultType as { typeIdx?: number }).typeIdx !== structTypeIdx) {
          fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
        }
        if (materializeStructAsObject(ctx, fctx, structTypeIdx, { skipInternalFields: true })) {
          compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
          return;
        }
        // materialize declined — fall back to the plain externref reinterpret.
        // The struct ref is still on the stack (ref.cast, if any, is a no-op for
        // enumeration purposes here); convert and route through the host path.
      }
      fctx.body.push({ op: "extern.convert_any" });
      compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
      return;
    }
    rollbackSpeculative(ctx, fctx, snap);
    ensureBindingLocals(ctx, fctx, pattern);
    reportError(ctx, decl, "Cannot destructure: rest element on non-ref typed value");
    return;
  }

  // Pre-trigger the function-index resolution for the throw that the helper's
  // buildDestructureNullThrow will emit. If we don't, the helper builds its
  // else-branch (destructInstrs) BEFORE the function index is finalized, and
  // those instructions retain stale funcIdx values that a later shift can't
  // reach (destructInstrs is not yet attached to fctx.body when the shift fires).
  //
  // #1473 — in no-JS-host mode the helper uses the in-module `__new_TypeError`
  // constructor instead of the `__throw_type_error` host import. Register that
  // constructor now (it lands in funcMap as an internal function, after all
  // current imports, so it introduces no late-import index shift).
  if (usesNativeJsErrors(ctx)) {
    emitWasiErrorConstructor(ctx, "TypeError", 1);
  } else {
    ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
  }

  // Stash RHS in a temp local matching the resolved struct type so the helper
  // can use struct.get directly. Use the resolved structTypeIdx (which may have
  // come from the TS checker fallback) rather than resultType's typeIdx,
  // which can differ for anonymous object literals.
  const paramType: ValType =
    resultType.kind === "ref_null"
      ? { kind: "ref_null", typeIdx: structTypeIdx }
      : { kind: "ref", typeIdx: structTypeIdx };
  const tmpLocal = allocLocal(fctx, `__destruct_${fctx.locals.length}`, paramType);
  // Cast / convert the stack value to the resolved struct type if needed.
  // When resultType.typeIdx === structTypeIdx the cast is a no-op shape-wise
  // but Wasm requires nominal type match for the local.set, so we only emit
  // ref.cast when the two type indices differ.
  if ((resultType as { typeIdx?: number }).typeIdx !== structTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Determine binding kind for TDZ + const tracking inside the helper.
  const bindingKind: BindingKind =
    decl.parent.flags & ts.NodeFlags.Const ? "const" : decl.parent.flags & ts.NodeFlags.Let ? "let" : "var";

  // (#3024) Keep the RHS-materialization buffer reachable for the field-pad
  // patch that fires while the nested pattern's DEFAULT object literal is
  // compiled. `destructureParamObject` compiles nested defaults into DETACHED
  // branch buffers (plain JS-local swaps, tracked in `ctx.liveBodies` only for
  // the immediate inner branch), so the OUTER body holding the initializer's
  // `struct.new` is orphaned once we descend. When a nested default literal
  // (e.g. `{ w: { x, y, z } = { x, y, z } } = { w: { x, z } }`) SHARES the same
  // anonymous struct as the initializer's sub-object but carries MORE fields, it
  // grows that struct via `ensureComputedPropertyFields`; the resulting
  // `patchStructNewForAddedField` walks `fctx.body` + `savedBodies` +
  // `liveBodies` and previously could NOT reach the already-emitted initializer
  // `struct.new` sitting in this orphaned outer body — leaving it one operand
  // short of the grown field count ("struct.new need 3, got 2" invalid Wasm).
  // Registering the buffer here (same mechanism as the destructuring-PARAM
  // #2503/#2158 fixes) makes it reachable; removed after so it does not leak.
  const rhsBody = fctx.body;
  const rhsAlreadyLive = ctx.liveBodies.has(rhsBody);
  if (!rhsAlreadyLive) ctx.liveBodies.add(rhsBody);
  destructureParamObject(ctx, fctx, tmpLocal, pattern, paramType, {
    mode: "decl",
    bindingKind,
  });
  if (!rhsAlreadyLive) ctx.liveBodies.delete(rhsBody);

  // Module-global sync stays in the caller — the helper only writes to locals.
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

/**
 * Recover the binding kind (`let`/`const`/`var`) of a binding pattern by
 * walking its `parent` chain for the enclosing `VariableDeclarationList`.
 *
 * Works for top-level decl patterns, nested binding patterns (parent pointers
 * stay intact through ObjectBindingPattern/BindingElement up to the
 * VariableDeclarationList), and for-of/for-in heads (whose initializer is a
 * VariableDeclarationList). Returns `undefined` for assignment patterns
 * (`({x} = obj)`) which have no VariableDeclarationList ancestor — callers
 * default to `"var"`, a safe no-op for TDZ init.
 */
function recoverBindingKind(pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern): BindingKind | undefined {
  let n: ts.Node | undefined = pattern;
  while (n) {
    if (ts.isVariableDeclarationList(n)) {
      if (n.flags & ts.NodeFlags.Const) return "const";
      if (n.flags & ts.NodeFlags.Let) return "let";
      return "var";
    }
    n = n.parent;
  }
  return undefined;
}

/**
 * Destructure an externref value using the shared param-destructure helper
 * (`destructureParamObject` in decl mode).
 *
 * Fallback for when the source type is unknown/any/externref (no struct info
 * available). The externref on the WasmGC stack is stashed into a temp local
 * and handed to `destructureParamObject`, which routes through its externref
 * branch — including the `ref.test`/`struct.get` fast path for known struct
 * types, per-element null/undefined guards, NamedEvaluation of function/class
 * defaults, and enumerable-correct rest collection. This replaces the legacy
 * twin that had drifted from the param path (#1553c — root causes 1, 2, 4, 8).
 *
 * @deprecated Internal callers (nested patterns, for-of/for-in heads) still
 * reach this shim; the export is retained for compile compatibility until
 * #1553d removes it. New code should call `destructureParamObject` directly.
 */
export function compileExternrefObjectDestructuringDecl(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectBindingPattern,
  resultType: ValType,
): void {
  // Stash the externref off the WasmGC stack into a temp local for the helper.
  const tmpLocal = allocLocal(fctx, `__ext_obj_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Per ECMA-262 8.6.2 BindingInitialization, the production
  // `BindingPattern : ObjectBindingPattern` runs `Perform ?
  // RequireObjectCoercible(value)` as step 1 — BEFORE the inner
  // `ObjectBindingPattern : { }` rule (which returns unused). So `const {} =
  // null` / `const {} = undefined` MUST throw a TypeError, while `const {} = 5`
  // must NOT (a number is object-coercible). The earlier blanket short-circuit
  // (#846) skipped the coercibility check for empty patterns, silently
  // accepting null/undefined — observably wrong (test262
  // dstr-binding/obj-init-null + for-of/dstr/const-obj-init-*). Emit the same
  // null/undefined RequireObjectCoercible guard that the parameter path
  // (`destructureParamObject`) and assignment path
  // (`emitExternrefAssignDestructureGuard`) already use, then short-circuit the
  // no-property-access empty body. The guard only fires for null/undefined, so
  // primitive sources still pass through unchanged. (#846)
  if (pattern.elements.length === 0) {
    emitExternrefDestructureGuard(ctx, fctx, tmpLocal);
    ensureBindingLocals(ctx, fctx, pattern);
    return;
  }

  // Recover the binding kind from the enclosing VariableDeclarationList so the
  // helper emits correct TDZ init for let/const. Assignment patterns and any
  // unforeseen caller default to "var" (TDZ init is a no-op for var).
  const bindingKind = recoverBindingKind(pattern) ?? "var";

  // Decl-mode delegation. The helper's externref branch handles the struct
  // fast path, per-element guards, defaults, and rest collection.
  destructureParamObject(ctx, fctx, tmpLocal, pattern, resultType, {
    mode: "decl",
    bindingKind,
  });

  // Module-global sync stays in the caller — the helper only writes to locals.
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

/**
 * Destructure an externref value using __extern_get(obj, boxed_index) for each element.
 * Handles cases where the RHS is dynamically typed (e.g. arguments, iterators, function returns).
 */
export function compileExternrefArrayDestructuringDecl(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayBindingPattern,
  resultType: ValType,
): void {
  // Stash the externref/ref off the WasmGC stack into a temp local for the helper.
  const tmpLocal = allocLocal(fctx, `__ext_arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Recover the binding kind from the enclosing VariableDeclarationList so the
  // helper emits correct TDZ init for let/const. Assignment patterns and any
  // unforeseen caller default to "var" (TDZ init is a no-op for var).
  const bindingKind = recoverBindingKind(pattern) ?? "var";

  // Decl-mode delegation. The helper's externref branch performs GetIterator
  // (RequireObjectCoercible + @@iterator + .next()) with throw propagation
  // (#1454), the tuple-struct fast path, per-element defaults, nested patterns,
  // and rest collection through a single localMap lookup (no double-slot
  // collision — root-cause 6).
  destructureParamArray(ctx, fctx, tmpLocal, pattern, resultType, {
    mode: "decl",
    bindingKind,
  });

  // Module-global sync stays in the caller — the helper only writes to locals.
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

export function compileArrayDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
): void {
  if (!decl.initializer) return;

  const pattern = decl.name as ts.ArrayBindingPattern;

  // #1128: for let/const destructuring, (re-)allocate TDZ flags per binding.
  // The function-level pre-pass (walkStmtForLetConst) may have allocated these,
  // but block-scope shadowing wipes them when we enter an inner block.
  const isLetConst = (decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
  if (isLetConst) {
    ensureLetConstBindingPatternTdzFlags(ctx, fctx, pattern);
  }

  // #1919 — snapshot so a non-array initializer rolls back its compiled value
  // plus any locals / late imports / errors, not just the body length.
  const snap = snapshotSpeculative(ctx, fctx);

  // When the pattern has rest elements, force vec mode for the initializer so
  // array literals produce a full vec (not a truncated tuple matching the binding pattern type)
  const patternHasRest = pattern.elements.some((el) => ts.isBindingElement(el) && el.dotDotDotToken);
  if (patternHasRest) (ctx as any)._arrayLiteralForceVec = true;
  const resultType = compileExpression(ctx, fctx, decl.initializer);
  if (patternHasRest) (ctx as any)._arrayLiteralForceVec = false;
  if (!resultType) return;

  if (resultType.kind !== "ref" && resultType.kind !== "ref_null") {
    if (resultType.kind === "externref") {
      compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, resultType);
      syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
      return;
    }
    // For f64/i32 — box to externref and use externref fallback
    if (resultType.kind === "f64" || resultType.kind === "i32") {
      if (resultType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
    }
    rollbackSpeculative(ctx, fctx, snap);
    ensureBindingLocals(ctx, fctx, pattern);
    reportError(ctx, decl, "Cannot destructure: not an array type");
    return;
  }

  const typeIdx = (resultType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle vec struct (array wrapped in {length, data})
  if (!typeDef || typeDef.kind !== "struct") {
    // Non-struct ref: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" });
    compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  const isVecArray = arrDef && arrDef.kind === "array";

  // (#2169) Array-destructuring a Wasm-native generator (`const [a,b]=g()`).
  // The initializer lowered to a ref to the generator state struct
  // (`$__gen_state_*`), NOT a __vec — without this it fell through to the
  // unknown-struct externref fallback (`extern.convert_any` →
  // `__array_from_iter_n` host import), which doesn't exist standalone, so the
  // module failed zero-import instantiation. Spec §8.5.2
  // IteratorBindingInitialization: array destructuring is a GetIterator
  // consumer, exactly like for-of / spread / Array.from. Drain the generator
  // into an f64 vec via the shared `emitNativeGeneratorToVec` resume loop (the
  // same helper the spread + Array.from consumers use), then destructure that
  // vec through the proven typed-vec path. This is the SF-2 destructure
  // consumer carried forward from the spread/Array.from slices.
  if (!isVecArray) {
    const genInfo = nativeGeneratorInfoForForOfSubject(ctx, resultType);
    if (genInfo) {
      // (#2864 F1) Drain into a vec whose element type matches the generator's
      // carrier: f64 for numeric (unchanged) or externref for the boxed-any
      // carrier (object / mixed yields), so the destructured bindings receive a
      // faithful `any` value rather than a mis-typed f64.
      const genElemKind = genInfo.elemValType.kind === "externref" ? "externref" : "f64";
      const genVecTypeIdx = getOrRegisterVecType(ctx, genElemKind);
      const genArrTypeIdx = getArrTypeIdxFromVec(ctx, genVecTypeIdx);
      // genState ref is currently on the stack; emitNativeGeneratorToVec
      // consumes it and leaves (ref $vec_f64). trimToLength=true: the
      // destructure path bounds-checks against `array.len(data)`, so the
      // backing array must be sized to exactly the logical length for
      // out-of-length binding defaults (`const [a,b=9]=g()`) to fire.
      emitNativeGeneratorToVec(ctx, fctx, genInfo, resultType, genVecTypeIdx, genArrTypeIdx, true);
      // struct.new yields a non-null ref; type the local `ref` (not `ref_null`)
      // so the typed-vec destructure's OOB→default logic matches the
      // literal-array path (mirrors the custom-iterable drain below).
      const vecLocal = allocLocal(fctx, `__destr_gen_vec_${fctx.locals.length}`, {
        kind: "ref",
        typeIdx: genVecTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: vecLocal });
      destructureParamArray(
        ctx,
        fctx,
        vecLocal,
        pattern,
        { kind: "ref", typeIdx: genVecTypeIdx },
        {
          mode: "decl",
          bindingKind: recoverBindingKind(pattern) ?? "var",
        },
      );
      syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
      return;
    }
  }

  // (#2033) Array-destructuring a user-defined iterable — an object literal /
  // class instance whose struct carries `[Symbol.iterator]()`. Without this it
  // fell through to the vec/tuple field reads below and pulled non-existent
  // numeric fields → NaN. Spec §8.5.2 IteratorBindingInitialization: array
  // destructuring is a GetIterator consumer, exactly like for-of and spread.
  // Coerce to externref and delegate to the externref decl path, whose helper
  // runs the full GetIterator (@@iterator + .next()) protocol.
  // (#2033) Array-destructuring a user-defined iterable — an object literal /
  // class instance whose struct carries `[Symbol.iterator]()`. Without this it
  // fell through to the vec/tuple field reads below (or the externref
  // __extern_get fallback) and pulled non-existent numeric fields → NaN. Spec
  // §8.5.2 IteratorBindingInitialization: array destructuring is a GetIterator
  // consumer, exactly like for-of and spread (#2033 spread fix). Drain the
  // iterator protocol into a vec (reusing the spread drain), then destructure
  // that vec through the proven typed-vec path.
  if (!isVecArray && isCustomIterable(ctx, resultType)) {
    const drainVecTypeIdx = getOrRegisterVecType(ctx, "f64");
    const drainVecInfo = getVecInfo(ctx, drainVecTypeIdx);
    if (drainVecInfo) {
      const iterableLocal = allocLocal(fctx, `__destr_citer_src_${fctx.locals.length}`, resultType);
      fctx.body.push({ op: "local.set", index: iterableLocal });
      if (emitDrainCustomIterableToVec(ctx, fctx, iterableLocal, resultType, drainVecTypeIdx)) {
        // `struct.new` yields a non-null ref; type the local `ref` (not
        // `ref_null`) so the typed-vec destructure's OOB→default logic matches
        // the literal-array path (a `ref_null` source takes a different branch
        // that mis-handles the binding default).
        const vecLocal = allocLocal(fctx, `__destr_citer_vec_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: drainVecTypeIdx,
        });
        fctx.body.push({ op: "local.set", index: vecLocal });
        destructureParamArray(
          ctx,
          fctx,
          vecLocal,
          pattern,
          { kind: "ref", typeIdx: drainVecTypeIdx },
          {
            mode: "decl",
            bindingKind: recoverBindingKind(pattern) ?? "var",
          },
        );
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // Drain unavailable — value already consumed into iterableLocal; fall
      // back to the externref path on a fresh extern view is not possible here
      // (value gone), so emit binding locals + a structured error.
      ensureBindingLocals(ctx, fctx, pattern);
      reportError(ctx, decl, "Cannot destructure custom iterable: iterator imports unavailable");
      return;
    }
  }

  // Check if this is a tuple struct (fields named _0, _1, etc.)
  // Note: 0-field structs are treated as empty tuples so that defaults apply correctly
  // when the pattern has more elements than the tuple (e.g. `var [{x}={x:1}] = []`)
  const isTupleStruct =
    !isVecArray &&
    typeDef.kind === "struct" &&
    (typeDef.fields.length === 0 || typeDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`));

  // Check if this is a string type (AnyString, NativeString, ConsString)
  const isStringStruct =
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0 &&
    (typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx || typeIdx === ctx.consStrTypeIdx);

  // #1719 CPR read-drive — gate-site for the array object-value representation
  // track. When the program overrode Array.prototype's @@iterator/values (the
  // ITER_OVERRIDDEN brand) AND captured that override (CPR write-arm), and the
  // RHS is a real array (not a string), the backing-store fast path below
  // silently ignores the override (§7.4.2 GetIterator / §8.5.2
  // IteratorBindingInitialization). Drive the captured override here instead.
  // Strictly gated behind `arrayDstrNeedsIdentity && override-captured`, both
  // false in the common case ⇒ override-free modules stay byte-identical.
  if (
    arrayDstrNeedsIdentity(ctx, isStringStruct) &&
    arrayIteratorOverrideGlobalIdx(ctx) !== undefined &&
    (isVecArray || isTupleStruct) &&
    tryEmitArrayProtoIteratorReadDrive(ctx, fctx, pattern, resultType)
  ) {
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  if (!isVecArray && !isTupleStruct && !isStringStruct) {
    // Unknown struct: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" });
    compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }

  // String destructuring: use __str_charAt to extract individual characters
  if (isStringStruct) {
    compileStringDestructuring(ctx, fctx, pattern, resultType, snap);
    return;
  }

  // At this point resultType is a ref to a known vec or tuple struct (string
  // and externref/non-ref/non-struct/unknown-struct/tuple+rest cases all
  // returned above). Stash the struct ref and delegate to the shared helper,
  // which handles vec arrays, tuple structs, rest collection (single-slot, no
  // double-allocation — root-cause 6), nested patterns, element defaults, and
  // OOB/null guards uniformly with the parameter-destructure lane.
  const tmpLocal = allocLocal(fctx, `__destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  const bindingKind = recoverBindingKind(pattern) ?? "var";

  destructureParamArray(ctx, fctx, tmpLocal, pattern, resultType, {
    mode: "decl",
    bindingKind,
  });

  // Module-global sync stays in the caller — the helper only writes to locals.
  syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
}

/**
 * Compile array destructuring of a string value.
 * Each binding variable gets a single-character string via __str_charAt.
 * e.g. `const [a, b, c] = "abc"` -> a = charAt(str, 0), b = charAt(str, 1), c = charAt(str, 2)
 */
function compileStringDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayBindingPattern,
  resultType: ValType,
  snap: SpeculativeSnapshot,
): void {
  // Ensure __str_charAt is available
  ensureNativeStringHelpers(ctx);
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (charAtIdx === undefined) {
    rollbackSpeculative(ctx, fctx, snap);
    ensureBindingLocals(ctx, fctx, pattern);
    reportError(ctx, pattern, "Cannot destructure string: __str_charAt helper not available");
    return;
  }

  const strType = nativeStringType(ctx);

  // Store string ref in temp local
  const tmpLocal = allocLocal(fctx, `__destruct_str_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullable = resultType.kind === "ref_null";
  const savedBody = fctx.body;
  const destructInstrs: Instr[] = [];
  fctx.body = destructInstrs;

  // Pre-allocate all binding locals
  ensureBindingLocals(ctx, fctx, pattern);

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Rest element: const [a, ...rest] = "hello". (#3100 S4) Build the rest
    // NATIVELY as a `string[]` nstrVec: `__str_to_char_vec` (#1470, per code
    // point §22.1.5.1) then `array.copy` the tail from index `i`. The previous
    // lowering converted the native-string STRUCT to externref and called the
    // host `__extern_slice` — which (a) leaked an `env::` import standalone
    // (zero-import instantiation failure) and (b) was broken in BOTH modes for
    // the pre-declared `string[]` rest local: the host slice can't slice an
    // opaque WasmGC struct, and the externref result can never satisfy the
    // typed local's `ref.cast $nstrVec` (illegal cast). The native tail-copy is
    // the same pattern as the vec rest in loops.ts (#2602).
    if (ts.isBindingElement(element) && element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        const restName = element.name.text;
        const { funcIdx: toCharVecIdx, vecTypeIdx: nstrVecTypeIdx } = ensureStrToCharVecHelper(ctx);
        const nstrArrTypeIdx = getArrTypeIdxFromVec(ctx, nstrVecTypeIdx);
        let restIdx = fctx.localMap.get(restName);
        if (restIdx === undefined) {
          restIdx = allocLocal(fctx, restName, { kind: "ref_null", typeIdx: nstrVecTypeIdx });
        }
        if (nstrArrTypeIdx >= 0) {
          const cvLocal = allocLocal(fctx, `__sdstr_cv_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: nstrVecTypeIdx,
          });
          const restLenLocal = allocLocal(fctx, `__sdstr_rlen_${fctx.locals.length}`, { kind: "i32" });
          const srcOffLocal = allocLocal(fctx, `__sdstr_off_${fctx.locals.length}`, { kind: "i32" });
          const outArrLocal = allocLocal(fctx, `__sdstr_out_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: nstrArrTypeIdx,
          });
          // cv = __str_to_char_vec(str)
          fctx.body.push({ op: "local.get", index: tmpLocal });
          if (resultType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "call", funcIdx: toCharVecIdx });
          fctx.body.push({ op: "local.set", index: cvLocal });
          // restLen = max(0, cv.len - i)
          fctx.body.push({ op: "local.get", index: cvLocal });
          fctx.body.push({ op: "struct.get", typeIdx: nstrVecTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" });
          fctx.body.push({ op: "local.tee", index: restLenLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0 },
              { op: "local.set", index: restLenLocal },
            ],
            else: [],
          });
          // srcOff = min(i, cv.len) — array.copy traps on srcOff > len even at
          // count 0 (a short source string with a long fixed prefix).
          fctx.body.push({ op: "local.get", index: cvLocal });
          fctx.body.push({ op: "struct.get", typeIdx: nstrVecTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: cvLocal },
              { op: "struct.get", typeIdx: nstrVecTypeIdx, fieldIdx: 0 },
            ],
            else: [{ op: "i32.const", value: i }],
          });
          fctx.body.push({ op: "local.set", index: srcOffLocal });
          // out = array.new_default(restLen); array.copy out[0..] = cvData[srcOff..]
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: nstrArrTypeIdx });
          fctx.body.push({ op: "local.set", index: outArrLocal });
          fctx.body.push({ op: "local.get", index: outArrLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: cvLocal });
          fctx.body.push({ op: "struct.get", typeIdx: nstrVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "local.get", index: srcOffLocal });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "array.copy", dstTypeIdx: nstrArrTypeIdx, srcTypeIdx: nstrArrTypeIdx });
          // rest = $nstrVec{restLen, out}, coerced to the (possibly externref /
          // pre-declared) rest local's type.
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: outArrLocal });
          fctx.body.push({ op: "struct.new", typeIdx: nstrVecTypeIdx });
          const restLocalType = getLocalType(fctx, restIdx);
          if (restLocalType && !valTypesMatch({ kind: "ref", typeIdx: nstrVecTypeIdx }, restLocalType)) {
            coerceType(ctx, fctx, { kind: "ref", typeIdx: nstrVecTypeIdx }, restLocalType);
          }
          fctx.body.push({ op: "local.set", index: restIdx });
        }
      }
      continue;
    }

    // Nested patterns: skip for strings
    if (
      ts.isBindingElement(element) &&
      (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
    ) {
      ensureBindingLocals(ctx, fctx, element.name);
      continue;
    }

    if (!ts.isIdentifier(element.name)) continue;
    const localName = element.name.text;
    const localIdx = allocLocal(fctx, localName, strType);

    // Call charAt(str, i)
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "call", funcIdx: charAtIdx });
    fctx.body.push({ op: "local.set", index: localIdx });
  }

  // Close null guard
  fctx.body = savedBody;
  if (isNullable && destructInstrs.length > 0) {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: destructInstrs });
  } else {
    fctx.body.push(...destructInstrs);
  }
}

// Register delegates in shared.ts so index.ts can call these without
// importing statements/destructuring.ts directly (which would create cycles).
registerEnsureBindingLocals(ensureBindingLocals);
registerEmitNestedBindingDefault(emitNestedBindingDefault);
registerEmitDefaultValueCheck(emitDefaultValueCheck);
