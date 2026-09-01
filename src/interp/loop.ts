// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the register+accumulator dispatch loop + the AOT↔interp call
// protocol (`__interp_enter`). Authored in the js2wasm-compilable subset; the
// pieces that necessarily differ between Node and Wasm are marked as the E1↔E2
// SEAM (see below).
//
// ── Frame-stack machine (doc §"calls", constraint 3 — suspension-ready) ───────
// interp→interp calls do NOT recurse the host stack: a `Call` to an interpreted
// callee pushes a `$Frame` and swaps the loop's cached state, exactly as
// `src/ir/backend/bytecode-vm.ts::runProgram` does (save/restore code+consts+
// regs+pc on Call/Return; call-site-PC rescan on Throw). Only the host boundary
// (host→interp entry, interp→host builtin/callback) uses host recursion. This is
// the shape #2929 suspends by writing pc+regs into the heap `$Frame`.
//
// ── Exception model (side table, not opcodes) ─────────────────────────────────
// The loop wraps dispatch in a `try` (the Node analogue of the Wasm `try_table`
// E4 will use). On catch it scans the current frame's `exnTable` for the
// innermost row covering the throwing PC; on a hit it writes the caught value
// into `regs[handlerReg]` and jumps to `handlerPC`; on a miss it unwinds one
// frame (rescanning the caller at its call-site PC) and, if the stack empties,
// rethrows across the host boundary. `Op.Throw` throws the raw acc value;
// genuine interpreter-invariant violations use {@link InterpInternalError} and
// bypass routing so a loop bug can never be masked by a program `try/catch`.
//
// ── E1↔E2 SEAM ────────────────────────────────────────────────────────────────
// (1) Interpreted-function value: in E1 a *branded JS function* (WeakMap) that
//     calls `interpEnter`; in E2 an ordinary closure struct whose code pointer is
//     the exported `__interp_enter` trampoline and whose capture slot holds the
//     `$FuncMeta` (doc §"Call protocol") — indistinguishable from a compiled
//     closure, so codegen needs zero interpreter-awareness. (2) Host dispatch
//     (`callee.apply`, fixed-arity positional construction) is E1's stand-in
//     for the #3098 classifier / `__apply_closure`. (3) The global env backing
//     (`Object.create(globalThis)`) is E1's stand-in for the module globalThis
//     `$Object` (#369). None of these three change the opcode semantics.

import {
  Builtin,
  BUILTIN_ASSIGN_OUTER_NAME,
  BUILTIN_DYNAMIC_IMPORT,
  BUILTIN_DIRECT_EVAL,
  BUILTIN_DEFINE_CLASS_METHOD,
  BUILTIN_FINALIZE_CLASS,
  BUILTIN_FOR_IN_KEYS,
  BUILTIN_FOR_OF_VALUES,
  BUILTIN_PUSH_FUNCTION_ENV,
  BUILTIN_OBJECT_DEFINE_PROPERTY,
  BUILTIN_PUSH_OBJECT_ENV,
  BUILTIN_PUSH_LEXICAL_ENV,
  BUILTIN_REGEXP_CREATE,
  BUILTIN_RESTORE_ENV,
  BUILTIN_SAVE_ENV,
  OP_MASK,
  Op,
  OPERAND_MASK,
  WIDE_FLAG,
} from "./opcodes.js";
import {
  buildArrayLiteral,
  buildForInKeys,
  buildForOfValues,
  buildObjectLiteral,
  buildRegExpLiteral,
  anyAdd,
  anyBitAnd,
  anyBitOr,
  anyBitXor,
  anyDiv,
  anyDelete,
  anyGe,
  anyGet,
  anyGt,
  anyLe,
  anyLogicalNot,
  anyLooseEq,
  anyLt,
  anyMod,
  anyMul,
  anyNeg,
  anySet,
  anyShl,
  anyShr,
  anyShrU,
  anyStrictEq,
  anySub,
  anyTypeof,
  isTruthy,
} from "./runtime-ops.js";
import {
  createLexicalEnvironment,
  createFunctionEnvironment,
  createObjectEnvironment,
  createRuntimeEvalGlobalEnvironment,
  deleteOwnEnvironmentBinding,
  directEvalActivationStateBindingCell,
  directEvalActivationStateFor,
  EVAL_TDZ,
  setEvalVariableEnvironmentBinding,
  variableEnvironmentFor,
} from "./eval-environment.js";
import {
  ENV_DECLARATIVE,
  ENV_GLOBAL,
  EXN_ROW,
  FLAG_CLASS_CONSTRUCTOR,
  FLAG_RUNTIME_EVAL,
  FLAG_RUNTIME_FUNCTION,
  FLAG_STRICT,
  EnvRec,
  Frame,
  FuncMeta,
  RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY,
  type EvalBindingCell,
  type JSValue,
  type Regs,
} from "./types.js";
import { constructValue, describe, intrinsicErrorConstructor } from "./call-helpers.js";

/** A genuine interpreter-invariant violation (bad opcode, stalled decode). Never
 * routed through the exception table, so program try/catch cannot mask it. */
export class InterpInternalError extends Error {
  constructor(message: string) {
    super(`interp/loop: ${message}`);
    this.name = "InterpInternalError";
  }
}

/** Bounded step guard — a malformed stream (bad backpatch, missing Return) fails
 *  loud instead of hanging. */
const MAX_STEPS = 100000000;

// ── The interpreted-closure brand (E1↔E2 SEAM #1) ────────────────────────────
// A WeakMap keeps the FuncMeta+envRec off the function object itself (so the
// interpreted value's own `name`/`length` stay clean for introspection).
interface InterpBinding {
  meta: FuncMeta;
  envRec: EnvRec | null;
}
const INTERP_BINDINGS: WeakMap<object, InterpBinding> = new WeakMap();
const INTERP_BOUNDARY_VALUES: WeakMap<object, JSValue> = new WeakMap();

/** Direct eval needs the parser owned by the runtime provider, but importing
 * dynamic-function.ts here would form a loop. Keep one realm-local callback
 * beside the intrinsic function identity; dynamic-function.ts installs both
 * before entering interpreted code. */
export type RuntimeDirectEvalHook = (
  source: JSValue,
  lexicalEnv: EnvRec | null,
  variableEnv: EnvRec | null,
  thisArg: JSValue,
  callerStrict: boolean,
) => JSValue;

/** Realm-local implementation of the `%Function%` constructor. Keeping the
 * parser callback outside loop.ts avoids a dynamic-function↔loop import cycle. */
export type RuntimeFunctionHook = (args: JSValue[]) => JSValue;

/** Loader-neutral metadata supplied to a realm's dynamic-import hook. ESTree
 * locations use one-based lines and zero-based columns. `options` is the raw
 * second ImportCall argument after ordinary expression evaluation. */
export interface RuntimeDynamicImportMetadata {
  referrer: JSValue;
  line: JSValue;
  column: JSValue;
  options: JSValue;
}

/** Realm-local dynamic-import policy. The interpreter owns evaluation,
 * ToString, and Promise conversion; the hook owns resolution and loading. */
export type RuntimeDynamicImportHook = (specifier: string, metadata: RuntimeDynamicImportMetadata) => JSValue;

const RUNTIME_EVAL_INTRINSICS: WeakMap<object, JSValue> = new WeakMap();
const RUNTIME_DIRECT_EVAL_HOOKS: WeakMap<object, RuntimeDirectEvalHook> = new WeakMap();
const RUNTIME_FUNCTION_INTRINSICS: WeakMap<object, JSValue> = new WeakMap();
const RUNTIME_FUNCTION_HOOKS: WeakMap<object, RuntimeFunctionHook> = new WeakMap();
const RUNTIME_DYNAMIC_IMPORT_HOOKS: WeakMap<object, RuntimeDynamicImportHook> = new WeakMap();
const RUNTIME_ARRAY_PROTOTYPES: WeakMap<object, JSValue> = new WeakMap();
const RUNTIME_PROMISE_PROTOTYPES: WeakMap<object, JSValue> = new WeakMap();

/** Install or replace the loader for one runtime-eval realm. Replacing is
 * intentional: repeated script entries share a realm, while an embedder may
 * update loader state without rebuilding already-emitted bytecode. */
export function installRuntimeDynamicImportHook(globalObject: JSValue, hook: RuntimeDynamicImportHook): void {
  RUNTIME_DYNAMIC_IMPORT_HOOKS.set(globalObject as object, hook);
}

/** Install one stable `%eval%` identity for a realm. Re-entering the provider
 * must not overwrite a later source-level assignment to `globalThis.eval`, so
 * only the first installation writes the global property. */
export function installRuntimeEvalRealm(
  globalObject: JSValue,
  intrinsicEval: JSValue,
  directEval: RuntimeDirectEvalHook,
  intrinsicFunction: JSValue,
  dynamicFunction: RuntimeFunctionHook,
): JSValue {
  const key = globalObject as object;
  const existing = RUNTIME_EVAL_INTRINSICS.get(key);
  if (existing !== undefined) return existing;
  // Interpreted arrays reach their methods through the generic vec property
  // reader. Retaining the realm's intrinsic prototype makes standalone builds
  // materialize and seed that reader's Array-prototype companion before a call
  // such as `[1].every(callback)` crosses the boundary.
  RUNTIME_ARRAY_PROTOTYPES.set(key, Array.prototype);
  // Dynamic import is specified to return a Promise, and interpreted property
  // reads resolve `.then`/`.catch`/`.finally` through the generic carrier path.
  // Retain the intrinsic prototype so standalone provider compilation emits
  // and seeds its native-prototype companion just as it does for arrays.
  RUNTIME_PROMISE_PROTOTYPES.set(key, Promise.prototype);
  const realmFunction = __runtime_eval_wrap_intrinsic_function_callback(intrinsicFunction, "Function", 1);
  const realmEval = __runtime_eval_wrap_intrinsic_callback(intrinsicEval, "eval", 1, realmFunction);
  RUNTIME_EVAL_INTRINSICS.set(key, realmEval);
  RUNTIME_DIRECT_EVAL_HOOKS.set(key, directEval);
  RUNTIME_FUNCTION_INTRINSICS.set(key, realmFunction);
  RUNTIME_FUNCTION_HOOKS.set(key, dynamicFunction);
  if (
    intrinsicFunction !== null &&
    (typeof intrinsicFunction === "object" || typeof intrinsicFunction === "function")
  ) {
    INTERP_BOUNDARY_VALUES.set(intrinsicFunction as object, realmFunction);
  }
  if (intrinsicEval !== null && (typeof intrinsicEval === "object" || typeof intrinsicEval === "function")) {
    INTERP_BOUNDARY_VALUES.set(intrinsicEval as object, realmEval);
  }
  // Materialize the realm data properties that declaration-instantiation must
  // treat as non-definable globals. The AOT compiler normally folds these
  // identifiers instead of storing them on its synthetic global object, but
  // interpreted code and CanDeclareGlobalFunction operate on that object.
  for (const entry of [
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["undefined", undefined],
  ]) {
    const name = entry[0] as string;
    if (Object.getOwnPropertyDescriptor(globalObject, name) === undefined) {
      Object.defineProperty(globalObject, name, {
        value: entry[1],
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
  }
  Object.defineProperty(globalObject, "eval", {
    value: realmEval,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(globalObject, "Function", {
    value: realmFunction,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return realmEval;
}

/** Query without creating a realm; used by dynamic-function.ts to avoid
 * allocating a fresh intrinsic closure on every eval call. */
export function runtimeEvalIntrinsic(globalObject: JSValue): JSValue {
  return RUNTIME_EVAL_INTRINSICS.get(globalObject as object);
}

/** Query the current realm's stable first-class `%Function%` identity. */
export function runtimeFunctionIntrinsic(globalObject: JSValue): JSValue {
  return RUNTIME_FUNCTION_INTRINSICS.get(globalObject as object);
}

/** A direct-eval import is emitted only after the AOT compiler has resolved the
 * caller's IdentifierReference as intrinsic eval. Capture that exact
 * declarative-cell carrier so aliases created inside interpreted source can be
 * recognized without conflating a later global/property reassignment. */
export function registerRuntimeEvalCallerIntrinsic(env: EnvRec | null): void {
  const globalEnv = globalEnvironment(env);
  if (globalEnv === null) return;
  const intrinsic = RUNTIME_EVAL_INTRINSICS.get(globalEnv.backing as object);
  if (intrinsic === undefined) return;
  let current = env;
  for (;;) {
    if (current === null) return;
    if (current.kind === ENV_DECLARATIVE) {
      const cell = ownEnvCell(current, "eval");
      if (cell !== null) {
        cell.value = intrinsic;
        return;
      }
    } else if ("eval" in current.backing) {
      current.backing.eval = intrinsic;
      return;
    }
    current = current.parent;
  }
}

/** Callable carrier shared with the standalone generic closure ABI. */
export type InterpCallable = (
  a0?: JSValue,
  a1?: JSValue,
  a2?: JSValue,
  a3?: JSValue,
  a4?: JSValue,
  a5?: JSValue,
  a6?: JSValue,
  a7?: JSValue,
) => JSValue;

/** Is `v` an interpreted-function value (a branded closure)? */
export function isInterpClosure(v: JSValue): boolean {
  return v !== null && (typeof v === "object" || typeof v === "function") && INTERP_BINDINGS.has(v as object);
}

/** Build an interpreted-function value from a FuncMeta + captured env record. */
export function makeInterpClosure(meta: FuncMeta, envRec: EnvRec | null): InterpCallable {
  // A regular (non-arrow) function so `.prototype` exists for
  // construct/instanceof. Keep eight explicit formal slots: the standalone
  // generic closure dispatcher classifies a rest-only function as arity zero,
  // which would discard the AOT call's arguments before this trampoline runs.
  // Eight is the shared Phase-1 closure ABI ceiling (#3310). Keep the body free
  // of `arguments`: the standalone compiler already pads under-applied closure
  // calls to their declared arity, and its `arguments` side channel belongs to
  // `__apply_closure`, not a statically typed returned closure.
  // Keep this expression anonymous. A named expression currently takes the
  // standalone fnctor-escape path and loses the returned closure carrier.
  const closure: InterpCallable = function (
    this: JSValue,
    a0?: JSValue,
    a1?: JSValue,
    a2?: JSValue,
    a3?: JSValue,
    a4?: JSValue,
    a5?: JSValue,
    a6?: JSValue,
    a7?: JSValue,
  ): JSValue {
    if ((meta.flags & FLAG_RUNTIME_FUNCTION) !== 0) {
      const runtimeArgs: JSValue[] = [];
      // biome-ignore lint/style/noArguments: Function distinguishes zero, one, and many call-site arguments before any declared-arity padding.
      const argc = arguments.length;
      if (argc > 0) runtimeArgs.push(a0);
      if (argc > 1) runtimeArgs.push(a1);
      if (argc > 2) runtimeArgs.push(a2);
      if (argc > 3) runtimeArgs.push(a3);
      if (argc > 4) runtimeArgs.push(a4);
      if (argc > 5) runtimeArgs.push(a5);
      if (argc > 6) runtimeArgs.push(a6);
      if (argc > 7) runtimeArgs.push(a7);
      return interpEnter(meta, envRec, this, runtimeArgs);
    }
    if ((meta.flags & FLAG_CLASS_CONSTRUCTOR) !== 0) {
      throw new TypeError("Class constructor cannot be invoked without 'new'");
    }
    const receiver = (meta.flags & FLAG_STRICT) !== 0 ? this : normalizeSloppyThis(envRec, this);
    return interpEnter(meta, envRec, receiver, [a0, a1, a2, a3, a4, a5, a6, a7]);
  };
  const nm = typeof meta.name === "string" ? meta.name : "";
  try {
    Object.defineProperty(closure, "name", { value: nm, configurable: true });
    Object.defineProperty(closure, "length", { value: meta.paramCount, configurable: true });
  } catch {
    // Non-configurable in some engines — introspection is best-effort in E1.
  }
  INTERP_BINDINGS.set(closure, { meta, envRec });
  return closure;
}

/** Build the realm's intrinsic `%eval%` as an ordinary interpreted closure.
 * The private metadata flag lets every alias follow the proven closure brand
 * and callback bridge while dispatching to global-only eval instead of a
 * bytecode body. No callable or FuncMeta layout changes are required. */
export function makeRuntimeEvalIntrinsic(globalObject: JSValue): InterpCallable {
  const env = createRuntimeEvalGlobalEnvironment(globalObject);
  const meta = new FuncMeta([], [], 2, 1, null, "eval", FLAG_RUNTIME_EVAL);
  return makeInterpClosure(meta, env);
}

/** Build the realm's callable/constructable `%Function%` intrinsic. Calls and
 * construction both dispatch through the realm hook installed by
 * dynamic-function.ts; the empty bytecode body is never entered. */
export function makeRuntimeFunctionIntrinsic(globalObject: JSValue): InterpCallable {
  const env = createRuntimeEvalGlobalEnvironment(globalObject);
  const meta = new FuncMeta([], [], 2, 1, null, "Function", FLAG_RUNTIME_FUNCTION);
  return makeInterpClosure(meta, env);
}

/**
 * Invoke a non-interpreted callable at the runtime boundary.
 *
 * In ordinary TypeScript/Node execution this is exactly Function#apply. The
 * standalone compiler recognizes this deliberately private intrinsic name and
 * lowers it straight to `__apply_closure(callee, receiver, args)`, avoiding a
 * second dynamic lookup of the foreign carrier's `.apply` property.
 */
export function __runtime_eval_apply_callable(
  callee: (...a: JSValue[]) => JSValue,
  receiver: JSValue,
  args: JSValue[],
): JSValue {
  return callee.apply(receiver, args);
}

/** Invoke a provider-local interpreted callback with the exact argument vector
 * supplied by the cross-module envelope. Runtime intrinsics need the true
 * call-site count (Function distinguishes zero, one, and many arguments),
 * while the ordinary eight-slot closure ABI intentionally pads calls. */
export function applyRuntimeEvalCallable(callee: JSValue, receiver: JSValue, args: JSValue[]): JSValue {
  const normalized = __runtime_eval_unwrap_interpreted_callback(callee);
  if (isInterpClosure(normalized)) {
    const binding = INTERP_BINDINGS.get(normalized as object)!;
    const globalEnv = globalEnvironment(binding.envRec);
    if ((binding.meta.flags & FLAG_RUNTIME_FUNCTION) !== 0) {
      if (globalEnv === null) throw new InterpInternalError("runtime Function closure has no realm");
      const hook = RUNTIME_FUNCTION_HOOKS.get(globalEnv.backing as object);
      if (hook === undefined) throw new InterpInternalError("runtime Function realm has no constructor hook");
      return hook(args);
    }
    if ((binding.meta.flags & FLAG_RUNTIME_EVAL) !== 0) {
      if (globalEnv === null) throw new InterpInternalError("runtime eval closure has no realm");
      const hook = RUNTIME_DIRECT_EVAL_HOOKS.get(globalEnv.backing as object);
      if (hook === undefined) throw new InterpInternalError("runtime eval realm has no eval hook");
      return hook(args.length > 0 ? args[0] : undefined, null, null, globalEnv.backing, false);
    }
  }
  return __runtime_eval_apply_callable(normalized, receiver, args);
}

/**
 * Node execution keeps callback identity unchanged. The standalone compiler
 * recognizes this private intrinsic and replaces the value with the canonical
 * branded cross-module callback carrier used by the exception-envelope bridge.
 */
export function __runtime_eval_wrap_interpreted_callback(
  callee: JSValue,
  _name: JSValue,
  _length: number,
  _constructor: JSValue,
): JSValue {
  return callee;
}

/** Keep the realm's intrinsic `%eval%` on the same callback carrier as other
 * interpreted functions while giving it a structural kind that survives the
 * provider/AOT boundary. Node execution keeps the carrier transparent. */
export function __runtime_eval_wrap_intrinsic_callback(
  callee: JSValue,
  _name: JSValue,
  _length: number,
  _constructor: JSValue,
): JSValue {
  return callee;
}

/** Give `%Function%` its own structural callback kind. The marker's
 * `constructor` getter can then return the marker itself without constructing
 * a cyclic WasmGC value. */
export function __runtime_eval_wrap_intrinsic_function_callback(
  callee: JSValue,
  _name: JSValue,
  _length: number,
): JSValue {
  return callee;
}

/** Test the structural intrinsic-eval callback kind. The standalone compiler
 * replaces this body with the canonical marker test; the Node fallback checks
 * the private FuncMeta flag on the transparent interpreted closure. */
export function __runtime_eval_is_intrinsic_callback(callee: JSValue): boolean {
  if (!isInterpClosure(callee)) return false;
  const binding = INTERP_BINDINGS.get(callee as object);
  return binding !== undefined && (binding.meta.flags & FLAG_RUNTIME_EVAL) !== 0;
}

/** Node keeps runtime-eval result values transparent. The standalone compiler
 * lowers this intrinsic to the canonical provider→caller value carrier. */
export function __runtime_eval_wrap_result(value: JSValue): JSValue {
  return value;
}

/** Provider-local inverse used by ABI canaries. Caller modules perform the
 * same structural decode directly at their result-envelope boundary. */
export function __runtime_eval_unwrap_result(value: JSValue): JSValue {
  return value;
}

/** Node keeps the marker transparent. The standalone compiler lowers this
 * private intrinsic to an exact type+brand test and extracts the raw provider
 * closure before the interpreter consumes a binding again. */
export function __runtime_eval_unwrap_interpreted_callback(callee: JSValue): JSValue {
  return callee;
}

/** Test the cross-module AOT callable carrier. Node execution keeps the
 * carrier opaque; standalone compilation replaces this private intrinsic
 * with its structural type-and-brand check so an adapter can preserve
 * [[Call]] when a compiled closure crosses into an evaluated realm. */
export function __runtime_eval_is_aot_callable(_callee: JSValue): boolean {
  return false;
}

/** Return one stable, structurally canonical provider→AOT function marker.
 * Reusing the marker is required for `f === f` and for aliases of one Annex B
 * function that cross the boundary through different binding cells. */
export function exposeRuntimeEvalValue(value: JSValue): JSValue {
  if (!isInterpClosure(value)) return value;
  const existing = INTERP_BOUNDARY_VALUES.get(value as object);
  if (existing !== undefined) return existing;
  const binding = INTERP_BINDINGS.get(value as object)!;
  const name = typeof binding.meta.name === "string" ? binding.meta.name : "";
  const globalEnv = globalEnvironment(binding.envRec);
  const runtimeFunction = globalEnv === null ? undefined : RUNTIME_FUNCTION_INTRINSICS.get(globalEnv.backing as object);
  const exposed = __runtime_eval_wrap_interpreted_callback(value, name, binding.meta.paramCount, runtimeFunction);
  INTERP_BOUNDARY_VALUES.set(value as object, exposed);
  return exposed;
}

/** Expose a value stored in a caller-owned realm object/cell. Unlike a result
 * envelope, this storage remains shared across later provider entries, so
 * normalize an existing carrier first and wrap primitive payloads exactly
 * once. Interpreted closures retain their callable callback marker. */
export function exposeRuntimeEvalSharedValue(value: JSValue): JSValue {
  const normalized = normalizeRuntimeEvalSharedValue(value);
  if (isInterpClosure(normalized)) return exposeRuntimeEvalValue(normalized);
  return __runtime_eval_wrap_result(normalized);
}

/** Import one value read from caller-owned shared storage into the provider's
 * primitive domain. A caller module's private undefined singleton can cross as
 * a genuine reference when it was written before the boundary carrier was
 * installed. It remains observably undefined to `typeof`, but letting that
 * foreign singleton flow into provider-owned objects makes later provider-
 * local null fast paths conflate it with null. Re-materialize only that
 * primitive; null and all genuine references retain their exact identity. */
function normalizeRuntimeEvalSharedValue(value: JSValue): JSValue {
  const normalized = __runtime_eval_unwrap_result(value);
  return typeof normalized === "undefined" ? undefined : normalized;
}

/** Replace provider-owned closures stored on the shared realm object with
 * their stable boundary markers without touching ordinary realm values. */
export function exposeRuntimeEvalObject(object: JSValue): void {
  if (object === undefined || object === null) return;
  const keys = Object.keys(object);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    object[key] = exposeRuntimeEvalSharedValue(object[key]);
  }
}

/** Expose provider-owned values written into caller-owned global lexical cells.
 * The carrier property is non-enumerable, so the ordinary Object.keys realm
 * exposure pass intentionally cannot reach these cells. */
export function exposeRuntimeEvalGlobalLexicalCells(globalObject: JSValue): void {
  if (globalObject === undefined || globalObject === null) return;
  const carrier: JSValue = globalObject[RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY];
  if (carrier === undefined || carrier === null) return;
  for (let i = 1; i < carrier.length; i += 2) {
    const cell = carrier[i] as EvalBindingCell;
    cell.value = exposeRuntimeEvalSharedValue(cell.value);
  }
}

/** Normalize captured environment cells after an AOT call through the
 * interpreted-function bridge. The closure may have assigned another
 * interpreted function into a caller-owned cell; that value must be exposed
 * before AOT observes it. Internal eval reads unwrap the marker again. */
export function exposeRuntimeEvalCallableEnvironment(callable: JSValue): void {
  if (!isInterpClosure(callable)) return;
  const binding = INTERP_BINDINGS.get(callable as object);
  if (binding === undefined) return;
  let env = binding.envRec;
  for (;;) {
    if (env === null) return;
    if ((env.kind === ENV_DECLARATIVE || env.kind === ENV_GLOBAL) && env.slots !== null) {
      for (let i = 0; i < env.slots.length; i += 1) {
        const cell = env.slots[i] as EvalBindingCell;
        cell.value = exposeRuntimeEvalSharedValue(cell.value);
      }
    }
    if (env.kind !== ENV_DECLARATIVE) {
      exposeRuntimeEvalObject(env.backing);
    }
    env = env.parent;
  }
}

/**
 * `__interp_enter` — the single exported AOT↔interp trampoline (doc §"Call
 * protocol"). Allocates the bottom `$Frame` (regs from `regCount`), seeds
 * regs[0]=thisArg and regs[1..1+paramCount)=args, runs the loop, returns `acc`.
 */
export function interpEnter(meta: FuncMeta, envRec: EnvRec | null, thisArg: JSValue, args: JSValue[]): JSValue {
  if ((meta.flags & FLAG_RUNTIME_EVAL) !== 0) {
    const globalEnv = globalEnvironment(envRec);
    if (globalEnv === null) throw new InterpInternalError("runtime eval closure has no realm");
    const hook = RUNTIME_DIRECT_EVAL_HOOKS.get(globalEnv.backing as object);
    if (hook === undefined) throw new InterpInternalError("runtime eval realm has no eval hook");
    return hook(args.length > 0 ? args[0] : undefined, null, null, globalEnv.backing, false);
  }
  if ((meta.flags & FLAG_RUNTIME_FUNCTION) !== 0) {
    const globalEnv = globalEnvironment(envRec);
    if (globalEnv === null) throw new InterpInternalError("runtime Function closure has no realm");
    const hook = RUNTIME_FUNCTION_HOOKS.get(globalEnv.backing as object);
    if (hook === undefined) throw new InterpInternalError("runtime Function realm has no constructor hook");
    return hook(args);
  }
  const regs: Regs = new Array(meta.regCount);
  for (let i = 0; i < meta.regCount; i += 1) regs[i] = undefined;
  regs[0] = thisArg;
  const np = args.length < meta.paramCount ? args.length : meta.paramCount;
  for (let i = 0; i < np; i += 1) regs[1 + i] = args[i];
  return run(new Frame(meta, 0, regs, envRec, null));
}

// ── environment resolution (doc §14; Phase 1 = global record only) ────────────
/**
 * Resolve the intrinsic Error-family constructor values that exist on every JS
 * realm but are absent from the deliberately sparse standalone global-object
 * carrier.  Bare constructor values matter to runtime eval: Test262 passes
 * `ReferenceError` into `assert.throws`, whose identity check must observe the
 * same constructor carrier as an error thrown by the interpreter.
 *
 * A real binding on an environment record always wins; this is only consulted
 * after the complete chain misses.  `null` is the private "not intrinsic"
 * sentinel because none of these constructor values can itself be null.
 */
function envLookup(env: EnvRec | null, name: JSValue): JSValue {
  let e = env;
  for (;;) {
    if (e === null) {
      const intrinsic = intrinsicErrorConstructor(name);
      if (intrinsic !== null) return intrinsic;
      throw new ReferenceError(`${String(name)} is not defined`);
    }
    const cell = ownEnvCell(e, name);
    if (cell !== null) {
      const value = normalizeRuntimeEvalSharedValue(cell.value);
      if (value === EVAL_TDZ) throw new ReferenceError(`${String(name)} is not initialized`);
      if (runtimeEvalEnvironment(env, value) !== null) return value;
      return __runtime_eval_unwrap_interpreted_callback(value);
    }
    if (e.kind !== ENV_DECLARATIVE && name in e.backing) {
      const value = normalizeRuntimeEvalSharedValue(e.backing[name]);
      if (runtimeEvalEnvironment(env, value) !== null) return value;
      return __runtime_eval_unwrap_interpreted_callback(value);
    }
    e = e.parent;
  }
}

/** Phase-1 functions are non-strict unless/until directive flags land. A bare
 * call therefore substitutes the captured realm's global object for a
 * null/undefined receiver; explicit method receivers pass through unchanged. */
function normalizeSloppyThis(env: EnvRec | null, receiver: JSValue): JSValue {
  if (receiver !== undefined && receiver !== null) return receiver;
  let e = env;
  let globalBacking: JSValue = undefined;
  for (;;) {
    if (e === null) break;
    if (e.kind === ENV_GLOBAL) globalBacking = e.backing;
    e = e.parent;
  }
  return globalBacking;
}

/** Find the realm record shared by eval/Function for an active lexical chain. */
function globalEnvironment(env: EnvRec | null): EnvRec | null {
  let current = env;
  let globalEnv: EnvRec | null = null;
  for (;;) {
    if (current === null) return globalEnv;
    if (current.kind === ENV_GLOBAL) globalEnv = current;
    current = current.parent;
  }
}

/** Match the active realm's stable branded `%eval%` carrier. */
function runtimeEvalEnvironment(env: EnvRec | null, value: JSValue): EnvRec | null {
  const globalEnv = globalEnvironment(env);
  if (globalEnv === null || !__runtime_eval_is_intrinsic_callback(value)) return null;
  return globalEnv;
}

/** Read a property from an interpreted callback marker through its provider-
 * local closure. `constructor` is realm-owned rather than host Function, so it
 * resolves to the stable `%Function%` marker installed beside `%eval%`. */
function interpretedPropertyGet(env: EnvRec | null, value: JSValue, key: JSValue): JSValue {
  const normalized = __runtime_eval_unwrap_interpreted_callback(value);
  if (isInterpClosure(normalized)) {
    if (key === "constructor") {
      const binding = INTERP_BINDINGS.get(normalized as object);
      const globalEnv = binding === undefined ? null : globalEnvironment(binding.envRec);
      const runtimeFunction =
        globalEnv === null ? undefined : RUNTIME_FUNCTION_INTRINSICS.get(globalEnv.backing as object);
      if (runtimeFunction !== undefined) return runtimeFunction;
    }
    return anyGet(normalized, key);
  }
  return anyGet(normalized, key);
}

/** Return one binding cell owned by a declarative record. */
function ownEnvCell(env: EnvRec, name: JSValue): EvalBindingCell | null {
  if ((env.kind !== ENV_DECLARATIVE && env.kind !== ENV_GLOBAL) || env.slots === null) return null;
  // A retained eval closure's provider-local names vector is only a snapshot.
  // Resolve through the caller-owned canonical name cells so a later delete or
  // slot reuse cannot make stale `x` alias the new binding stored in that slot.
  if (directEvalActivationStateFor(env) !== null) {
    return directEvalActivationStateBindingCell(env, name);
  }
  const names: JSValue = env.names;
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === name) return env.slots[i] as EvalBindingCell;
  }
  return null;
}

/** Mirror a write to a mapped parameter into its live arguments object. The
 * activation record's otherwise-unused `backing` field carries a vector whose
 * indices match arguments indices and whose values are parameter names. */
function mirrorMappedParameterWrite(env: EnvRec, name: JSValue, value: JSValue): void {
  const mappedNames: JSValue = env.backing;
  if (mappedNames === undefined || mappedNames === null) return;
  const argumentsCell = ownEnvCell(env, "arguments");
  if (argumentsCell === null) return;
  for (let i = 0; i < mappedNames.length; i += 1) {
    if (mappedNames[i] === name) anySet(argumentsCell.value, i, value);
  }
}

function mappedArgumentKeyMatches(key: JSValue, index: number): boolean {
  return key === index || key === String(index);
}

/** Mirror a write through the actual mapped arguments object back into the
 * canonical parameter cell. Object identity prevents an unrelated array write
 * from touching the activation. */
function mirrorMappedArgumentsWrite(env: EnvRec | null, object: JSValue, key: JSValue, value: JSValue): void {
  let e = env;
  for (;;) {
    if (e === null) return;
    if (e.kind === ENV_DECLARATIVE && e.backing !== undefined && e.backing !== null) {
      const argumentsCell = ownEnvCell(e, "arguments");
      if (argumentsCell !== null && argumentsCell.value === object) {
        const mappedNames: JSValue = e.backing;
        for (let i = 0; i < mappedNames.length; i += 1) {
          const paramName = mappedNames[i];
          if (paramName !== undefined && paramName !== null && mappedArgumentKeyMatches(key, i)) {
            const paramCell = ownEnvCell(e, paramName);
            if (paramCell !== null) paramCell.value = value;
            return;
          }
        }
        return;
      }
    }
    e = e.parent;
  }
}

/** Find the declarative activation that owns this exact mapped arguments
 * object. The map itself stays in EnvRec.backing so no frozen GC layout grows. */
function mappedArgumentsActivation(env: EnvRec | null, object: JSValue): EnvRec | null {
  let e = env;
  for (;;) {
    if (e === null) return null;
    if (e.kind === ENV_DECLARATIVE && e.backing !== undefined && e.backing !== null) {
      const argumentsCell = ownEnvCell(e, "arguments");
      if (argumentsCell !== null && argumentsCell.value === object) return e;
    }
    e = e.parent;
  }
}

/** Delete a property and sever a successful mapped-arguments correspondence.
 * The standalone compiler represents its arguments object as a WasmGC vec;
 * its existing mapped-delete lowering clears the slot to `undefined` because
 * that carrier has no hole bitmap. Reflect.deleteProperty can reject that vec
 * at the generic boundary, so use the same bounded fallback after checking the
 * descriptor's configurability. Ordinary objects retain a real [[Delete]]. */
function deletePropertyWithMappedArguments(env: EnvRec | null, object: JSValue, key: JSValue): boolean {
  const activation = mappedArgumentsActivation(env, object);
  if (activation === null) return anyDelete(object, key);
  const mappedNames: JSValue = activation.backing;
  let mappedIndex = -1;
  for (let i = 0; i < mappedNames.length; i += 1) {
    if (mappedNames[i] !== undefined && mappedNames[i] !== null && mappedArgumentKeyMatches(key, i)) {
      mappedIndex = i;
      break;
    }
  }
  if (mappedIndex < 0) return anyDelete(object, key);
  const descriptor: JSValue = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor !== undefined && descriptor.configurable === false) return false;
  try {
    if (!anyDelete(object, key)) return false;
  } catch {
    anySet(object, key, undefined);
  }
  mappedNames[mappedIndex] = null;
  return true;
}

/** Apply Arguments Exotic Object [[DefineOwnProperty]] correspondence after
 * the underlying ordinary definition succeeds. Reading the resulting native
 * descriptor avoids re-running getters on the user-supplied descriptor. */
function definePropertyWithMappedArguments(
  env: EnvRec | null,
  object: JSValue,
  key: JSValue,
  descriptor: JSValue,
): JSValue {
  Object.defineProperty(object, key, descriptor);
  const activation = mappedArgumentsActivation(env, object);
  if (activation === null) return object;
  const mappedNames: JSValue = activation.backing;
  for (let i = 0; i < mappedNames.length; i += 1) {
    const paramName = mappedNames[i];
    if (paramName === undefined || paramName === null || !mappedArgumentKeyMatches(key, i)) continue;
    const applied: JSValue = Object.getOwnPropertyDescriptor(object, key);
    if (applied === undefined) return object;
    // Native descriptor objects always carry boolean `writable` for data
    // properties and omit it for accessors. Accessors sever without changing
    // the parameter; data descriptors first update the parameter value.
    if (typeof applied.writable === "boolean") {
      const paramCell = ownEnvCell(activation, paramName);
      if (paramCell !== null) paramCell.value = applied.value;
      if (!applied.writable) mappedNames[i] = null;
    } else {
      mappedNames[i] = null;
    }
    return object;
  }
  return object;
}

/** Delete an identifier reference through the current environment chain. */
function envDelete(env: EnvRec | null, name: JSValue): boolean {
  let e = env;
  for (;;) {
    if (e === null) return true;
    const ownBindingResult = deleteOwnEnvironmentBinding(e, name);
    if (ownBindingResult >= 0) return ownBindingResult === 1;
    if (e.kind !== ENV_DECLARATIVE && name in e.backing) {
      return anyDelete(e.backing, name);
    }
    e = e.parent;
  }
}

function envAssign(env: EnvRec | null, name: JSValue, value: JSValue, strict: boolean): void {
  let e = env;
  let root: EnvRec | null = null;
  for (;;) {
    if (e === null) break;
    const cell = ownEnvCell(e, name);
    if (cell !== null) {
      if (cell.value === EVAL_TDZ) throw new ReferenceError(`${String(name)} is not initialized`);
      cell.value = value;
      if (e.kind === ENV_DECLARATIVE) mirrorMappedParameterWrite(e, name, value);
      return;
    }
    if (e.kind !== ENV_DECLARATIVE && name in e.backing) {
      e.backing[name] = value;
      return;
    }
    root = e;
    e = e.parent;
  }
  if (strict) throw new ReferenceError(`${String(name)} is not defined`);
  if (root !== null && root.kind !== ENV_DECLARATIVE) root.backing[name] = value;
}

function envInitialize(env: EnvRec | null, name: JSValue, value: JSValue): void {
  let e = env;
  for (;;) {
    if (e === null) break;
    if (e.kind === ENV_DECLARATIVE) {
      const cell = ownEnvCell(e, name);
      if (cell !== null) {
        cell.value = value;
        return;
      }
    }
    e = e.parent;
  }
  envAssign(env, name, value, false);
}
function typeofName(env: EnvRec | null, name: JSValue): JSValue {
  // `typeof <undeclared>` must be "undefined", never ReferenceError.
  let e = env;
  for (;;) {
    if (e === null) return intrinsicErrorConstructor(name) === null ? "undefined" : "function";
    const cell = ownEnvCell(e, name);
    if (cell !== null) {
      const value = cell.value;
      if (value === EVAL_TDZ) throw new ReferenceError(`${String(name)} is not initialized`);
      if (runtimeEvalEnvironment(env, value) !== null) return "function";
      const unwrapped = __runtime_eval_unwrap_interpreted_callback(value);
      if (runtimeEvalEnvironment(env, unwrapped) !== null) return "function";
      return typeof unwrapped;
    }
    if (e.kind !== ENV_DECLARATIVE && name in e.backing) {
      const value = e.backing[name];
      if (runtimeEvalEnvironment(env, value) !== null) return "function";
      const unwrapped = __runtime_eval_unwrap_interpreted_callback(value);
      if (runtimeEvalEnvironment(env, unwrapped) !== null) return "function";
      return typeof unwrapped;
    }
    e = e.parent;
  }
}

interface Handler {
  pc: number;
  reg: number;
}

function findHandler(exnTable: number[] | null, throwPc: number): Handler {
  if (exnTable === null) return { pc: -1, reg: -1 };
  let bestPc = -1;
  let bestReg = -1;
  let bestSpan = Number.POSITIVE_INFINITY;
  let i = 0;
  const n = exnTable.length;
  for (;;) {
    if (i + EXN_ROW > n) break;
    const start = exnTable[i]!;
    const end = exnTable[i + 1]!;
    if (start <= throwPc && throwPc < end) {
      const span = end - start;
      if (span < bestSpan) {
        bestSpan = span;
        bestPc = exnTable[i + 2]!;
        bestReg = exnTable[i + 3]!;
      }
    }
    i += EXN_ROW;
  }
  return { pc: bestPc, reg: bestReg };
}

class DispatchState {
  readonly frames: Frame[] = [];
  readonly callSites: number[] = [];
  frame: Frame;
  meta: FuncMeta;
  code: number[];
  consts: JSValue[];
  regs: Regs;
  pc: number;
  acc: JSValue;
  curInstrPc: number;
  steps: number;

  constructor(bottom: Frame) {
    this.frame = bottom;
    this.meta = bottom.meta;
    this.code = bottom.meta.code;
    this.consts = bottom.meta.consts;
    this.regs = bottom.regs;
    this.pc = bottom.pc;
    this.acc = undefined;
    this.curInstrPc = 0;
    this.steps = 0;
  }
}

function installActiveFrame(state: DispatchState, frame: Frame, pc: number): void {
  state.frame = frame;
  state.meta = frame.meta;
  state.code = frame.meta.code;
  state.consts = frame.meta.consts;
  state.regs = frame.regs;
  state.pc = pc;
}

// These intentionally remain separate, substantial opcode-family functions.
// The runtime-eval provider self-compiles this interpreter; folding every
// opcode back into `run` creates a Wasm body too large for V8's optimizing tier.
function dispatchValueAndOperatorOp(state: DispatchState, op: number, a: number, b: number): void {
  const consts = state.consts;
  const regs = state.regs;
  let acc = state.acc;

  switch (op) {
    // ── const / register moves ──
    case Op.LdaConst:
      acc = consts[a];
      break;
    case Op.LdaUndef:
      acc = undefined;
      break;
    case Op.LdaNull:
      acc = null;
      break;
    case Op.LdaTrue:
      acc = true;
      break;
    case Op.LdaFalse:
      acc = false;
      break;
    case Op.LdaZero:
      acc = 0;
      break;
    case Op.Star:
      regs[a] = acc;
      break;
    case Op.Ldar:
      acc = regs[a];
      break;
    case Op.Mov:
      regs[b] = regs[a];
      break;

    // ── arithmetic / comparison (acc = op(regs[a], acc)) ──
    case Op.Add:
      acc = anyAdd(regs[a], acc);
      break;
    case Op.Sub:
      acc = anySub(regs[a], acc);
      break;
    case Op.Mul:
      acc = anyMul(regs[a], acc);
      break;
    case Op.Div:
      acc = anyDiv(regs[a], acc);
      break;
    case Op.Mod:
      acc = anyMod(regs[a], acc);
      break;
    case Op.Shl:
      acc = anyShl(regs[a], acc);
      break;
    case Op.Shr:
      acc = anyShr(regs[a], acc);
      break;
    case Op.ShrU:
      acc = anyShrU(regs[a], acc);
      break;
    case Op.BitOr:
      acc = anyBitOr(regs[a], acc);
      break;
    case Op.BitAnd:
      acc = anyBitAnd(regs[a], acc);
      break;
    case Op.BitXor:
      acc = anyBitXor(regs[a], acc);
      break;
    case Op.Neg:
      acc = anyNeg(acc);
      break;
    case Op.Not:
      acc = anyLogicalNot(acc);
      break;
    case Op.TypeOf:
      acc = runtimeEvalEnvironment(state.frame.envRec, acc) === null ? anyTypeof(acc) : "function";
      break;
    case Op.Eq:
      acc = anyLooseEq(regs[a], acc);
      break;
    case Op.StrictEq:
      acc = anyStrictEq(regs[a], acc);
      break;
    case Op.Lt:
      acc = anyLt(regs[a], acc);
      break;
    case Op.Le:
      acc = anyLe(regs[a], acc);
      break;
    case Op.Gt:
      acc = anyGt(regs[a], acc);
      break;
    case Op.Ge:
      acc = anyGe(regs[a], acc);
      break;
    default:
      throw new InterpInternalError(`unexpected value/operator opcode ${op} at pc ${state.curInstrPc}`);
  }

  state.acc = acc;
}

function dispatchPropertyAndEnvironmentOp(state: DispatchState, op: number, a: number, b: number): void {
  const frame = state.frame;
  const meta = state.meta;
  const consts = state.consts;
  const regs = state.regs;
  let acc = state.acc;

  switch (op) {
    // ── property (the shared dynamic MOP) ──
    case Op.GetProp:
      acc = interpretedPropertyGet(frame.envRec, acc, consts[a]);
      break;
    case Op.GetElem:
      acc = interpretedPropertyGet(frame.envRec, acc, regs[a]);
      break;
    case Op.SetProp:
      acc = anySet(regs[b], consts[a], acc);
      mirrorMappedArgumentsWrite(frame.envRec, regs[b], consts[a], acc);
      break;
    case Op.SetElem:
      acc = anySet(regs[b], regs[a], acc);
      mirrorMappedArgumentsWrite(frame.envRec, regs[b], regs[a], acc);
      break;
    case Op.DeleteProp: {
      const object = acc;
      const deleted = deletePropertyWithMappedArguments(frame.envRec, object, consts[a]);
      if (!deleted && (meta.flags & FLAG_STRICT) !== 0) throw new TypeError("Cannot delete property");
      acc = deleted;
      break;
    }
    case Op.DeleteElem: {
      const object = acc;
      const key = regs[a];
      const deleted = deletePropertyWithMappedArguments(frame.envRec, object, key);
      if (!deleted && (meta.flags & FLAG_STRICT) !== 0) throw new TypeError("Cannot delete property");
      acc = deleted;
      break;
    }
    case Op.DeleteName:
      acc = envDelete(frame.envRec, consts[a]);
      break;

    // ── variables (env-record chain, doc §14) ──
    case Op.LdGlobal:
    case Op.LdName:
      acc = envLookup(frame.envRec, consts[a]);
      break;
    case Op.StGlobal:
    case Op.StName:
      envAssign(frame.envRec, consts[a], acc, (meta.flags & FLAG_STRICT) !== 0);
      break;
    case Op.InitName:
      envInitialize(frame.envRec, consts[a], acc);
      break;
    default:
      throw new InterpInternalError(`unexpected property/environment opcode ${op} at pc ${state.curInstrPc}`);
  }

  state.acc = acc;
}

function dispatchCallOp(state: DispatchState, op: number, a: number, b: number): void {
  const frame = state.frame;
  const regs = state.regs;
  let acc = state.acc;

  switch (op) {
    case Op.Call: {
      const base = a;
      const argc = b;
      const originalCallee = acc;
      const evalEnv = runtimeEvalEnvironment(frame.envRec, originalCallee);
      const callee = evalEnv === null ? __runtime_eval_unwrap_interpreted_callback(originalCallee) : originalCallee;
      if (evalEnv !== null) {
        const hook = RUNTIME_DIRECT_EVAL_HOOKS.get(evalEnv.backing as object);
        if (hook === undefined) throw new InterpInternalError("runtime eval realm has no eval hook");
        acc = hook(argc > 0 ? regs[base + 1] : undefined, null, null, evalEnv.backing, false);
      } else if (isInterpClosure(callee)) {
        const binding = INTERP_BINDINGS.get(callee as object)!;
        const cm = binding.meta;
        if ((cm.flags & FLAG_RUNTIME_EVAL) !== 0) {
          const globalEnv = globalEnvironment(binding.envRec);
          if (globalEnv === null) throw new InterpInternalError("runtime eval closure has no realm");
          const hook = RUNTIME_DIRECT_EVAL_HOOKS.get(globalEnv.backing as object);
          if (hook === undefined) throw new InterpInternalError("runtime eval realm has no eval hook");
          acc = hook(argc > 0 ? regs[base + 1] : undefined, null, null, globalEnv.backing, false);
        } else if ((cm.flags & FLAG_RUNTIME_FUNCTION) !== 0) {
          const globalEnv = globalEnvironment(binding.envRec);
          if (globalEnv === null) throw new InterpInternalError("runtime Function closure has no realm");
          const hook = RUNTIME_FUNCTION_HOOKS.get(globalEnv.backing as object);
          if (hook === undefined) throw new InterpInternalError("runtime Function realm has no constructor hook");
          const args: JSValue[] = new Array(argc);
          for (let i = 0; i < argc; i += 1) args[i] = regs[base + 1 + i];
          acc = hook(args);
        } else if ((cm.flags & FLAG_CLASS_CONSTRUCTOR) !== 0) {
          throw new TypeError("Class constructor cannot be invoked without 'new'");
        } else {
          const cregs: Regs = new Array(cm.regCount);
          for (let i = 0; i < cm.regCount; i += 1) cregs[i] = undefined;
          cregs[0] = (cm.flags & FLAG_STRICT) !== 0 ? regs[base] : normalizeSloppyThis(binding.envRec, regs[base]);
          const np = argc < cm.paramCount ? argc : cm.paramCount;
          for (let i = 0; i < np; i += 1) cregs[1 + i] = regs[base + 1 + i];
          // Suspend the caller, install the callee frame (no host recursion).
          frame.pc = state.pc;
          state.frames.push(frame);
          state.callSites.push(state.curInstrPc);
          installActiveFrame(state, new Frame(cm, 0, cregs, binding.envRec, frame), 0);
        }
      } else {
        // Host boundary (E1↔E2 SEAM #2). TypeError on a non-callable is a
        // real JS exception → routed through the exn table.
        if (typeof callee !== "function") {
          throw new TypeError(`${describe(callee)} is not a function`);
        }
        const recv = regs[base];
        const args: JSValue[] = new Array(argc);
        for (let i = 0; i < argc; i += 1) {
          // A closure written through the erased register vector can be carried
          // as `$AnyValue` in a standalone build. Normalize that carrier before
          // testing the provider-local closure identity; otherwise an inline HOF
          // callback crosses as a non-callable raw value instead of its marker.
          const arg = __runtime_eval_unwrap_interpreted_callback(regs[base + 1 + i]);
          args[i] = isInterpClosure(arg) ? exposeRuntimeEvalValue(arg) : arg;
        }
        acc = __runtime_eval_apply_callable(callee as (...a: JSValue[]) => JSValue, recv, args);
      }
      break;
    }
    case Op.Construct: {
      const base = a;
      const argc = b;
      const originalCallee = acc;
      const args: JSValue[] = new Array(argc);
      for (let i = 0; i < argc; i += 1) args[i] = regs[base + 1 + i];
      if (runtimeEvalEnvironment(frame.envRec, originalCallee) !== null) {
        throw new TypeError("eval is not a constructor");
      }
      const callee = __runtime_eval_unwrap_interpreted_callback(originalCallee);
      if (isInterpClosure(callee)) {
        const binding = INTERP_BINDINGS.get(callee as object)!;
        if ((binding.meta.flags & FLAG_RUNTIME_EVAL) !== 0) {
          throw new TypeError("eval is not a constructor");
        }
        if ((binding.meta.flags & FLAG_RUNTIME_FUNCTION) !== 0) {
          const globalEnv = globalEnvironment(binding.envRec);
          if (globalEnv === null) throw new InterpInternalError("runtime Function closure has no realm");
          const hook = RUNTIME_FUNCTION_HOOKS.get(globalEnv.backing as object);
          if (hook === undefined) throw new InterpInternalError("runtime Function realm has no constructor hook");
          acc = hook(args);
        } else {
          const proto = (callee as { prototype?: JSValue }).prototype;
          const self: JSValue = Object.create(proto && typeof proto === "object" ? proto : Object.prototype);
          const r = interpEnter(binding.meta, binding.envRec, self, args); // boundary recursion (Phase 1)
          acc = r !== null && (typeof r === "object" || typeof r === "function") ? r : self;
        }
      } else if (typeof callee === "function") {
        acc = constructValue(callee, args);
      } else {
        throw new TypeError(`${describe(callee)} is not a constructor`);
      }
      break;
    }
    case Op.CallBuiltin: {
      const builtinId = a;
      const base = b;
      const argc = state.code[state.pc]!;
      state.pc += 1;
      acc = callBuiltin(builtinId, regs, base, argc, frame);
      break;
    }
    default:
      throw new InterpInternalError(`unexpected call opcode ${op} at pc ${state.curInstrPc}`);
  }

  state.acc = acc;
}

/** Return true only when the bottom activation has completed. */
function dispatchControlOp(state: DispatchState, op: number, a: number): boolean {
  if (op === Op.Jump) state.pc = a;
  else if (op === Op.JumpIfTrue) {
    if (isTruthy(state.acc)) state.pc = a;
  } else if (op === Op.JumpIfFalse) {
    if (!isTruthy(state.acc)) state.pc = a;
  } else if (op === Op.Return) {
    const result = state.acc;
    if (state.frames.length === 0) return true;
    const caller = state.frames.pop()!;
    state.callSites.pop();
    installActiveFrame(state, caller, caller.pc);
    state.acc = result;
  } else if (op === Op.Throw) throw new ThrowSignal(state.acc);
  else throw new InterpInternalError(`unexpected control opcode ${op} at pc ${state.curInstrPc}`);
  return false;
}

/** Decode and execute one bytecode instruction. Returns true on bottom Return. */
function dispatchNext(state: DispatchState): boolean {
  state.steps += 1;
  if (state.steps > MAX_STEPS) throw new InterpInternalError("step budget exceeded (malformed bytecode?)");
  state.curInstrPc = state.pc;
  const word = state.code[state.pc]!;
  state.pc += 1;
  const op = word & OP_MASK;
  const b = (word >>> 20) & OPERAND_MASK;
  let a: number;
  if ((word & WIDE_FLAG) !== 0) {
    a = state.code[state.pc]!;
    state.pc += 1;
  } else {
    a = (word >>> 8) & OPERAND_MASK;
  }

  if (
    op <= Op.Le ||
    op === Op.Gt ||
    op === Op.Ge ||
    op === Op.Shl ||
    op === Op.Shr ||
    op === Op.BitOr ||
    op === Op.BitAnd ||
    op === Op.BitXor ||
    op === Op.ShrU
  ) {
    dispatchValueAndOperatorOp(state, op, a, b);
    return false;
  }
  if (
    (op >= Op.GetProp && op <= Op.StName) ||
    op === Op.InitName ||
    op === Op.DeleteProp ||
    op === Op.DeleteElem ||
    op === Op.DeleteName
  ) {
    dispatchPropertyAndEnvironmentOp(state, op, a, b);
    return false;
  }
  if (op >= Op.Call && op <= Op.CallBuiltin) {
    dispatchCallOp(state, op, a, b);
    return false;
  }
  if (op >= Op.Jump && op <= Op.Throw) {
    return dispatchControlOp(state, op, a);
  }
  throw new InterpInternalError(`unknown opcode ${op} at pc ${state.curInstrPc}`);
}

function routeException(state: DispatchState, error: unknown): void {
  if (error instanceof InterpInternalError) throw error;
  const value: JSValue = error instanceof ThrowSignal ? error.value : error;
  let throwPc = state.curInstrPc;
  for (;;) {
    const handler = findHandler(state.meta.exnTable, throwPc);
    if (handler.pc >= 0) {
      state.regs[handler.reg] = value;
      state.pc = handler.pc;
      return;
    }
    if (state.frames.length === 0) throw value;
    const caller = state.frames.pop()!;
    const callSite = state.callSites.pop()!;
    installActiveFrame(state, caller, caller.pc);
    throwPc = callSite;
  }
}

/** Run a whole activation to completion, returning its `Return` value. */
function run(bottom: Frame): JSValue {
  // Explicit frame stack (suspended callers) + parallel call-site PCs (needed for
  // correct exn-region coverage on unwind — the return PC is one past the Call,
  // which would fall on `tryEnd` and miss the half-open interval).
  const state = new DispatchState(bottom);

  for (;;) {
    try {
      if (dispatchNext(state)) return state.acc;
    } catch (e) {
      routeException(state, e);
    }
  }
}

class ThrowSignal {
  readonly value: JSValue;
  constructor(value: JSValue) {
    this.value = value;
  }
}

/** Dispatch an interpreter-intrinsic builtin. Args are regs[base..base+argc). */
function callBuiltin(builtinId: number, regs: Regs, base: number, argc: number, frame: Frame): JSValue {
  switch (builtinId) {
    case Builtin.ObjectLiteral: {
      const pairs: JSValue[] = new Array(argc);
      for (let i = 0; i < argc; i += 1) pairs[i] = regs[base + i];
      return buildObjectLiteral(pairs);
    }
    case Builtin.ArrayLiteral: {
      const elems: JSValue[] = new Array(argc);
      for (let i = 0; i < argc; i += 1) elems[i] = regs[base + i];
      return buildArrayLiteral(elems);
    }
    case Builtin.MakeClosure:
      return makeInterpClosure(regs[base] as FuncMeta, frame.envRec);
    case Builtin.GlobalThis: {
      const globalEnv = globalEnvironment(frame.envRec);
      return globalEnv !== null ? globalEnv.backing : undefined;
    }
    case Builtin.TypeofName:
      return typeofName(frame.envRec, regs[base]);
    case Builtin.Error:
      return argc === 0 ? new Error() : new Error(String(regs[base]));
    case Builtin.TypeError:
      return argc === 0 ? new TypeError() : new TypeError(String(regs[base]));
    case Builtin.RangeError:
      return argc === 0 ? new RangeError() : new RangeError(String(regs[base]));
    case Builtin.SyntaxError:
      return argc === 0 ? new SyntaxError() : new SyntaxError(String(regs[base]));
    case Builtin.ReferenceError:
      return argc === 0 ? new ReferenceError() : new ReferenceError(String(regs[base]));
    case Builtin.Number:
      return argc === 0 ? 0 : Number(regs[base]);
    case Builtin.MathMax:
      return builtinMathExtremum(regs, base, argc, true);
    case Builtin.MathMin:
      return builtinMathExtremum(regs, base, argc, false);
    case Builtin.MathAbs:
      return Math.abs(Number(regs[base]));
    case Builtin.MathFloor:
      return Math.floor(Number(regs[base]));
    case Builtin.MathCeil:
      return Math.ceil(Number(regs[base]));
    case Builtin.MathRound:
      return Math.round(Number(regs[base]));
    case BUILTIN_PUSH_LEXICAL_ENV: {
      const parent = frame.envRec;
      frame.envRec = createLexicalEnvironment(parent, regs[base]);
      return parent;
    }
    case BUILTIN_PUSH_FUNCTION_ENV:
      frame.envRec = createFunctionEnvironment(frame.envRec, regs[base], regs[base + 1], frame.regs);
      return undefined;
    case BUILTIN_PUSH_OBJECT_ENV: {
      const parent = frame.envRec;
      frame.envRec = createObjectEnvironment(parent, regs[base]);
      return parent;
    }
    case BUILTIN_SAVE_ENV:
      return frame.envRec;
    case BUILTIN_RESTORE_ENV:
      frame.envRec = regs[base] as EnvRec | null;
      return undefined;
    case BUILTIN_ASSIGN_OUTER_NAME: {
      // B.3.3's synthetic assignment targets the VariableEnvironment binding
      // created during declaration instantiation. If an intervening lexical
      // binding cancelled that synthetic var, the assignment is a no-op; an
      // ordinary environment-chain write would incorrectly overwrite the
      // caller's same-named let/const cell.
      const variableEnv = variableEnvironmentFor(frame.envRec);
      if (variableEnv !== null) {
        setEvalVariableEnvironmentBinding(variableEnv, regs[base + 1], regs[base]);
      }
      return regs[base];
    }
    case BUILTIN_DEFINE_CLASS_METHOD: {
      const classConstructor = regs[base];
      const target = isTruthy(regs[base + 4]) ? classConstructor : regs[base + 1];
      anySet(target, regs[base + 2], regs[base + 3]);
      return classConstructor;
    }
    case BUILTIN_FINALIZE_CLASS:
      anySet(regs[base + 1], "constructor", regs[base]);
      anySet(regs[base], "prototype", regs[base + 1]);
      return regs[base];
    case BUILTIN_OBJECT_DEFINE_PROPERTY:
      return definePropertyWithMappedArguments(frame.envRec, regs[base], regs[base + 1], regs[base + 2]);
    case BUILTIN_REGEXP_CREATE:
      return buildRegExpLiteral(regs[base], regs[base + 1]);
    case BUILTIN_DYNAMIC_IMPORT:
      return callRuntimeDynamicImport(
        frame.envRec,
        regs[base],
        regs[base + 1],
        regs[base + 2],
        regs[base + 3],
        regs[base + 4],
      );
    case BUILTIN_FOR_IN_KEYS:
      return buildForInKeys(regs[base]);
    case BUILTIN_FOR_OF_VALUES:
      return buildForOfValues(regs[base]);
    case BUILTIN_DIRECT_EVAL: {
      // window[0] is the already-resolved IdentifierReference; the remaining
      // slots are the already-evaluated call arguments. This preserves the
      // required callee-before-arguments order and avoids resolving through a
      // possibly-mutated `with` object twice.
      const callee = regs[base];
      const globalEnv = runtimeEvalEnvironment(frame.envRec, callee);
      const globalObject = globalEnv === null ? undefined : globalEnv.backing;
      if (globalEnv !== null) {
        const hook = RUNTIME_DIRECT_EVAL_HOOKS.get(globalObject as object);
        if (hook === undefined) throw new InterpInternalError("runtime eval realm has no direct-eval hook");
        const variableEnv = variableEnvironmentFor(frame.envRec);
        return hook(
          argc > 1 ? regs[base + 1] : undefined,
          frame.envRec,
          variableEnv === null ? globalEnv : variableEnv,
          frame.regs[0],
          (frame.meta.flags & FLAG_STRICT) !== 0,
        );
      }

      // A syntactic eval call whose resolved value is not %eval% is an ordinary
      // Call with an undefined receiver. All source arguments have already run.
      if (typeof callee !== "function") throw new TypeError(`${describe(callee)} is not a function`);
      const callArgc = argc - 1;
      const args: JSValue[] = new Array(callArgc);
      for (let i = 0; i < callArgc; i += 1) {
        const arg = regs[base + 1 + i];
        args[i] = isInterpClosure(arg) ? exposeRuntimeEvalValue(arg) : arg;
      }
      return __runtime_eval_apply_callable(callee as (...a: JSValue[]) => JSValue, undefined, args);
    }
    default:
      throw new InterpInternalError(`unknown builtin id ${builtinId}`);
  }
}

/** Perform ImportCall's host boundary. Argument-expression errors have already
 * propagated synchronously before this builtin runs. From this point onward,
 * ToString and loader failures reject the returned promise, while a returned
 * value/thenable is assimilated through Promise.resolve. */
function callRuntimeDynamicImport(
  env: EnvRec | null,
  specifier: JSValue,
  referrer: JSValue,
  line: JSValue,
  column: JSValue,
  options: JSValue,
): JSValue {
  try {
    // String(symbol) is a deliberately forgiving constructor call, whereas
    // ImportCall uses the abstract ToString operation, which rejects Symbols.
    if (typeof specifier === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    const request = String(specifier);
    const globalEnv = globalEnvironment(env);
    if (globalEnv === null) throw new TypeError("Dynamic import requires a runtime-eval realm");
    const hook = RUNTIME_DYNAMIC_IMPORT_HOOKS.get(globalEnv.backing as object);
    if (hook === undefined) throw new TypeError("Dynamic import requires a realm loader hook");
    const metadata: RuntimeDynamicImportMetadata = { referrer, line, column, options };
    return Promise.resolve(hook(request, metadata));
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Host-free Math.max/min over the bytecode argument window. The signed-zero
 * tie-breaks match ECMA-262: max prefers +0 and min prefers -0. */
function builtinMathExtremum(regs: Regs, base: number, argc: number, wantMax: boolean): JSValue {
  let result = wantMax ? -Infinity : Infinity;
  let i = 0;
  for (;;) {
    if (i >= argc) break;
    const value = Number(regs[base + i]);
    if (Number.isNaN(value)) return NaN;
    if (wantMax) {
      if (value > result || (value === 0 && result === 0 && 1 / value === Infinity)) result = value;
    } else if (value < result || (value === 0 && result === 0 && 1 / value === -Infinity)) {
      result = value;
    }
    i += 1;
  }
  return result;
}
