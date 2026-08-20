// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// closure-exports.ts — the `__call_fn_<N>` / `__call_fn_method_<N>` host-dispatch
// exports plus the is-closure / closure-arity / is-data-struct / standalone
// `typeof`-classification exports (#3272, extracted verbatim from index.ts).
// One cohesive subsystem: it lets a JS host invoke and classify WasmGC closures
// via ref.test/ref.cast shape dispatch. Called only by the compile driver
// (generateModule), which imports these back.

import { ts } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { addUnionImports } from "./registry/imports.js";
import { collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import { CLOSURE_ARITY_FIELD_IDX, getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js";
import {
  buildTransferredNativeProtoCallInstrs,
  collectTransferredNativeProtoReceivers,
  resolveClosureBaseWrapperTypeIdx,
} from "./closures/transferred-native-proto.js";
import { ensureArgcGlobal, ensureCurrentThisGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import { ensureAnyToExternHelper, isAnyValue } from "./any-helpers.js";
import { buildClosureResultBoxing } from "./closures/result-boxing.js";
import { buildMethodDispatchPrologue } from "./closures/method-dispatch-prologue.js";
import { isSyntheticStructName } from "./emit-helpers.js";
export { buildTransferredCharAtApplyArm } from "./char-at-transfer.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "./program-abi-planning.js";
import { DATA_STRUCT_HOST_BRIDGE_ORDINAL, publishDataStructHostBridge } from "./data-struct-host-bridge.js";
import { definedFuncHandleOf } from "./func-space.js";
import {
  STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT,
  STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT,
  STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT,
  STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC,
  STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_MARKER_EXPORT,
  STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE,
} from "../timer-capability-contract.js";

const CLOSURE_HOST_BRIDGE_ROLE = "closure-host-bridge";
const CLOSURE_HOST_BRIDGE_MANIFEST_NAME = "__\0js2_closure_host_bridge";
const CLOSURE_HOST_BRIDGE_MANIFEST_PHYSICAL_BASE = "$cm";
const CLOSURE_HOST_BRIDGE_MARKER_NAME = "__\0js2_closure_host_bridge_marker";
const CLOSURE_HOST_BRIDGE_MARKER_PHYSICAL_BASE = "$ct";
const CLOSURE_HOST_BRIDGE_BINDINGS_NAME = "__\0js2_closure_host_bridge_bindings";
const CLOSURE_HOST_BRIDGE_BINDINGS_PHYSICAL_BASE = "$cu";
const CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC = 0x5a200000;
const publishedClosureHostBridgeBits = new WeakMap<CodegenContext, number>();
const publishedClosureHostBridgeFuncs = new WeakMap<CodegenContext, Map<number, WasmFunction>>();
const publishedClosureHostBridgeManifests = new WeakSet<CodegenContext>();
const publishedStandaloneTimerCallbackManifests = new WeakSet<CodegenContext>();

const CLOSURE_HOST_BRIDGE_ORDINAL = Object.freeze({
  directCall0: 0,
  directCall1: 1,
  directCall2: 2,
  directCall3: 3,
  directCall4: 4,
  methodCall0: 5,
  methodCall1: 6,
  methodCall2: 7,
  methodCall3: 8,
  methodCall4: 9,
  methodCall5: 10,
  closureArity: 11,
  isClosure: 12,
  closureHasRest: 13,
} as const);

/**
 * Reserved physical export family for closure helpers.
 *
 * Keep the physical family independent from the Program ABI ordinals: method
 * dispatchers 6..8 remain runtime-visible but are intentionally outside the
 * bounded C31 structural-ownership slice.
 */
function closureHostBridgeDefinition(logicalName: string): { physicalBase: string; bit: number } {
  const direct = /^__call_fn_([0-4])$/.exec(logicalName);
  if (direct) {
    const bit = Number(direct[1]);
    return { physicalBase: `$c${bit.toString(36)}`, bit };
  }
  const method = /^__call_fn_method_([0-8])$/.exec(logicalName);
  if (method) {
    const bit = 5 + Number(method[1]);
    return { physicalBase: `$c${bit.toString(36)}`, bit };
  }
  if (logicalName === "__closure_arity") return { physicalBase: "$ce", bit: 14 };
  if (logicalName === "__is_closure") return { physicalBase: "$cf", bit: 15 };
  if (logicalName === "__closure_has_rest") return { physicalBase: "$cg", bit: 16 };
  throw new Error(`unknown closure host bridge ${logicalName}`);
}

/**
 * Publish one closure host helper from its exact allocator object.
 *
 * The historical logical label remains the public fast path. Every compiler
 * helper also owns the terminal alias in its reserved short family; when a user
 * already owns that label or prefix, preserve each user export and append the
 * exact helper. The runtime authenticates that alias without replacing public
 * names.
 */
function publishClosureHostBridge(ctx: CodegenContext, func: WasmFunction, derivedOrdinal: number | undefined): number {
  ctx.mod.functions.push(func);
  const ref =
    derivedOrdinal === undefined
      ? undefined
      : planProgramAbiEntrySourceSupportCallable(ctx, {
          role: CLOSURE_HOST_BRIDGE_ROLE,
          roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.closureHostBridge,
          derivedOrdinal,
          displayName: func.name,
          func,
        });
  const funcIdx = resolveProgramAbiSupportCallableHandle(ctx, ref, func);
  if (funcIdx === undefined) {
    throw new Error(`closure host bridge ${func.name} lost its exact allocator object`);
  }
  const definition = closureHostBridgeDefinition(func.name);
  const occupied = new Set(ctx.mod.exports.map((entry) => entry.name));
  const physicalBase = definition.physicalBase;
  let maxOccupiedSuffix = -1;
  for (const name of occupied) {
    if (!name.startsWith(physicalBase)) continue;
    const suffix = name.slice(physicalBase.length);
    if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
  }
  const logicalNameOccupied = occupied.has(func.name);
  if (!logicalNameOccupied) {
    ctx.mod.exports.push({
      name: func.name,
      desc: { kind: "func", index: funcIdx },
    });
    occupied.add(func.name);
  }
  for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
    const physicalName = `${physicalBase}${"$".repeat(suffixLength)}`;
    if (occupied.has(physicalName)) continue;
    ctx.mod.exports.push({
      name: physicalName,
      desc: { kind: "func", index: funcIdx },
    });
    occupied.add(physicalName);
  }
  publishedClosureHostBridgeBits.set(ctx, (publishedClosureHostBridgeBits.get(ctx) ?? 0) | (1 << definition.bit));
  let publishedFuncs = publishedClosureHostBridgeFuncs.get(ctx);
  if (!publishedFuncs) {
    publishedFuncs = new Map();
    publishedClosureHostBridgeFuncs.set(ctx, publishedFuncs);
  }
  publishedFuncs.set(definition.bit, func);
  return funcIdx;
}

/**
 * Publish one immutable compiler-authored availability manifest.
 *
 * The bitset distinguishes compiler helpers from user-controlled names. An
 * empty marker table authenticates the metadata, and a fixed funcref table
 * binds each availability bit to the exact helper object. Every physical family
 * is collision-safe; the logical names use reserved NUL-containing labels that
 * ordinary TypeScript exports cannot declare accidentally.
 */
function emitClosureHostBridgeManifest(ctx: CodegenContext): void {
  if (publishedClosureHostBridgeManifests.has(ctx)) return;
  const bits = publishedClosureHostBridgeBits.get(ctx) ?? 0;
  // Exact one-shot host callbacks publish only __call_fn_0: they never escape
  // as raw values, so __is_closure is deliberately absent. The availability
  // manifest authenticates every published helper independently through its
  // terminal alias and table binding; requiring the classifier bit here made
  // the runtime hide that genuine exact-only dispatcher.
  if (bits === 0) return;
  publishedClosureHostBridgeManifests.add(ctx);

  const bindingsTableIdx =
    ctx.mod.imports.filter((entry) => entry.desc.kind === "table").length + ctx.mod.tables.length;
  ctx.mod.tables.push({ elementType: "funcref", min: 17, max: 17 });
  const markerTableIdx = bindingsTableIdx + 1;
  ctx.mod.tables.push({ elementType: "funcref", min: 0, max: 0 });
  for (const [bit, func] of publishedClosureHostBridgeFuncs.get(ctx) ?? []) {
    const funcOffset = ctx.mod.functions.indexOf(func);
    if (funcOffset < 0) throw new Error(`closure host bridge manifest lost helper bit ${bit}`);
    ctx.mod.elements.push({
      tableIdx: bindingsTableIdx,
      offset: [{ op: "i32.const", value: bit }],
      funcIndices: [ctx.numImportFuncs + funcOffset],
    });
  }
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: CLOSURE_HOST_BRIDGE_MANIFEST_NAME,
    type: { kind: "i32" },
    mutable: false,
    init: [{ op: "i32.const", value: CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC | bits }],
  });

  const publishManifestExport = (
    logicalName: string,
    physicalBase: string,
    desc: { kind: "table" | "global"; index: number },
  ): void => {
    const occupied = new Set(ctx.mod.exports.map((entry) => entry.name));
    if (!occupied.has(logicalName)) {
      ctx.mod.exports.push({ name: logicalName, desc });
      occupied.add(logicalName);
    }
    let maxOccupiedSuffix = -1;
    for (const name of occupied) {
      if (!name.startsWith(physicalBase)) continue;
      const suffix = name.slice(physicalBase.length);
      if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
    }
    for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
      const physicalName = `${physicalBase}${"$".repeat(suffixLength)}`;
      if (occupied.has(physicalName)) continue;
      ctx.mod.exports.push({ name: physicalName, desc });
      occupied.add(physicalName);
    }
  };

  publishManifestExport(CLOSURE_HOST_BRIDGE_MARKER_NAME, CLOSURE_HOST_BRIDGE_MARKER_PHYSICAL_BASE, {
    kind: "table",
    index: markerTableIdx,
  });
  publishManifestExport(CLOSURE_HOST_BRIDGE_BINDINGS_NAME, CLOSURE_HOST_BRIDGE_BINDINGS_PHYSICAL_BASE, {
    kind: "table",
    index: bindingsTableIdx,
  });
  publishManifestExport(CLOSURE_HOST_BRIDGE_MANIFEST_NAME, CLOSURE_HOST_BRIDGE_MANIFEST_PHYSICAL_BASE, {
    kind: "global",
    index: globalIdx,
  });
}

function directClosureHostBridgeOrdinal(arity: number): number | undefined {
  return arity >= 0 && arity <= 4 ? CLOSURE_HOST_BRIDGE_ORDINAL.directCall0 + arity : undefined;
}

function methodClosureHostBridgeOrdinal(arity: number): number | undefined {
  return arity >= 0 && arity <= 5 ? CLOSURE_HOST_BRIDGE_ORDINAL.methodCall0 + arity : undefined;
}

/**
 * Emit __call_fn_0 export (#851): call a zero-arg WasmGC closure from JS.
 * (#1712) Thin alias over the generic N-arg emitter, which carries the
 * per-shape funcref extraction (capture-struct coverage), the #820l
 * argc/extras plumbing, and the #1896 arg coercion. The historical
 * hand-rolled body tested only one representative base-wrapper struct type,
 * which silently excluded capture-carrying closures from dispatch (their
 * struct types have no Wasm subtype relation to the 1-field base wrapper).
 */
export function emitClosureCallExport(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 0);
}

/**
 * Retain the exact zero-argument dispatcher needed by the standalone timer
 * capability without retaining the general JavaScript closure host bridge.
 *
 * The dispatcher is resolved from the compiler-owned allocator object, never
 * from a public/user-controlled export label. `stripHostBridgeExports` removes
 * the ordinary `__call_fn_0`/`$c0` names later, while this reserved alias stays
 * as the sole callback entry point.
 */
export function publishStandaloneTimerCallbackDispatch(ctx: CodegenContext): void {
  if (!ctx.requiresStandaloneTimerCallbackDispatch) return;
  if (publishedStandaloneTimerCallbackManifests.has(ctx)) return;
  const dispatcher = publishedClosureHostBridgeFuncs.get(ctx)?.get(CLOSURE_HOST_BRIDGE_ORDINAL.directCall0);
  if (!dispatcher) {
    throw new Error("standalone timer callback dispatcher was requested but __call_fn_0 was not emitted");
  }
  const funcIdx = definedFuncHandleOf(ctx, dispatcher);
  if (funcIdx === undefined) {
    throw new Error("standalone timer callback dispatcher lost its compiler-owned function handle");
  }
  const publishFamily = (
    logicalName: string,
    physicalBase: string,
    desc: { kind: "func" | "global" | "table"; index: number },
  ): void => {
    const occupied = new Set(ctx.mod.exports.map(({ name }) => name));
    if (!occupied.has(logicalName)) {
      ctx.mod.exports.push({ name: logicalName, desc });
      occupied.add(logicalName);
    }
    let maxOccupiedSuffix = -1;
    for (const name of occupied) {
      if (!name.startsWith(physicalBase)) continue;
      const suffix = name.slice(physicalBase.length);
      if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
    }
    for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
      const name = `${physicalBase}${"$".repeat(suffixLength)}`;
      if (occupied.has(name)) continue;
      ctx.mod.exports.push({ name, desc });
      occupied.add(name);
    }
  };

  const bindingsTableIdx =
    ctx.mod.imports.filter((entry) => entry.desc.kind === "table").length + ctx.mod.tables.length;
  ctx.mod.tables.push({ elementType: "funcref", min: 1, max: 1 });
  const markerTableIdx = bindingsTableIdx + 1;
  ctx.mod.tables.push({ elementType: "funcref", min: 0, max: 0 });
  ctx.mod.elements.push({
    tableIdx: bindingsTableIdx,
    offset: [{ op: "i32.const", value: 0 }],
    funcIndices: [funcIdx],
  });
  const manifestGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT,
    type: { kind: "i32" },
    mutable: false,
    init: [{ op: "i32.const", value: STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC }],
  });

  publishFamily(STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT, STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE, {
    kind: "func",
    index: funcIdx,
  });
  publishFamily(STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT, STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE, {
    kind: "global",
    index: manifestGlobalIdx,
  });
  publishFamily(STANDALONE_TIMER_CALLBACK_MARKER_EXPORT, STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE, {
    kind: "table",
    index: markerTableIdx,
  });
  publishFamily(STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT, STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE, {
    kind: "table",
    index: bindingsTableIdx,
  });
  // These names deliberately omit `host_bridge`: #4035 strips the general JS
  // inspection bridge but must retain this explicit platform-capability path.
  publishedStandaloneTimerCallbackManifests.add(ctx);
}

/**
 * Emit __call_fn_1 export (#1090): call a one-arg WasmGC closure from JS.
 * (#1712) Thin alias over the generic N-arg emitter. Besides the per-shape
 * funcref extraction fix, this widens coverage from exactly-arity-1 to
 * arity <= 1, matching the documented `_maybeWrapCallableUnknownArity`
 * contract ("the __call_fn_N dispatcher iterates closures of arity <= N"):
 * the runtime wraps property-stored closures with the HIGHEST available
 * dispatcher, so __call_fn_1 must be able to invoke a zero-arg closure
 * (extra args dropped, #820l argc/extras plumbing included).
 */
export function emitClosureCallExport1(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 1);
}

/**
 * Emit __call_fn_2 export — wraps the generic N-arg helper at arity 2.
 * Kept as a thin alias so the call-site name in `compile()` stays
 * descriptive when reading the dispatch sequence.
 */
export function emitClosureCallExport2(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 2);
}

/**
 * Emit __call_fn_3 export (#1382 Phase 2): call a three-arg WasmGC closure
 * from JS. Same dispatch as __call_fn_2 but with one extra positional
 * arg, matching Array HOF callbacks `(value, index, array)`.
 */
export function emitClosureCallExport3(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 3);
}

/**
 * Emit __call_fn_4 export (#1382 Phase 2): call a four-arg WasmGC closure
 * from JS. Used for `Array.prototype.reduce(cb, initial)` which invokes
 * `cb(accumulator, currentValue, currentIndex, array)`.
 */
export function emitClosureCallExport4(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 4);
}

/**
 * #1896 — Decide whether a host-supplied `externref` closure-call argument must
 * be lowered out of the extern domain before it feeds the closure's `call_ref`.
 *
 * The `__call_fn_<arity>` / `__call_fn_method_<arity>` exports take all user
 * args as `externref` (the host ABI). The lifted closure funcref, however,
 * declares each user param with the closure's *internal* ValType. Under the
 * native-strings backends a `string` param lowers to `(ref null $AnyString)`
 * (a concrete struct ref), so the raw `externref` arg mismatches `call_ref`
 * and the module fails validation. In `wasm:js-string` (gc) mode the string
 * param ValType *is* `externref`, so no conversion is needed.
 *
 * Returns true for non-extern reference param kinds (`anyref`/`eqref`/`ref`/
 * `ref_null`); false for `externref`/`ref_extern` (already extern-side) and for
 * the numeric/value kinds (handled by the f64/i32 unbox branches at the call
 * site, or simply not reference args).
 */
function needsExternToAnyForClosureParam(paramType: ValType): boolean {
  switch (paramType.kind) {
    case "anyref":
    case "eqref":
    case "ref":
    case "ref_null":
      return true;
    default:
      // externref / ref_extern (already extern), funcref, and value types.
      return false;
  }
}

/**
 * #1896 — Lower an `externref` closure-call arg into the internal ref domain
 * expected by the closure funcref's declared param ValType. `any.convert_extern`
 * moves externref → anyref (engine-level identity); for a *concrete* ref param
 * (`ref`/`ref_null` to a struct type, e.g. `(ref null $AnyString)`) a following
 * `ref.cast` narrows anyref → the exact param type so `call_ref` typechecks.
 * `anyref`/`eqref` params need no cast. Caller must have checked
 * `needsExternToAnyForClosureParam(paramType)` first.
 */
function externToClosureParamRef(paramType: ValType): Instr[] {
  const ops: Instr[] = [{ op: "any.convert_extern" }];
  if (paramType.kind === "ref") {
    ops.push({ op: "ref.cast", typeIdx: paramType.typeIdx });
  } else if (paramType.kind === "ref_null") {
    ops.push({ op: "ref.cast_null", typeIdx: paramType.typeIdx });
  }
  return ops;
}

/** Preserve explicit host `undefined` for numeric default-parameter checks. */
function externToClosureF64(argLocalIdx: number, unboxIdx: number, isUndefinedIdx?: number): Instr[] {
  const unbox: Instr[] = [
    { op: "local.get", index: argLocalIdx },
    { op: "call", funcIdx: unboxIdx },
  ];
  if (isUndefinedIdx === undefined) return unbox;
  return [
    { op: "local.get", index: argLocalIdx },
    { op: "call", funcIdx: isUndefinedIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }],
      else: unbox,
    },
  ];
}

/** Lower a host argument into the closure's native i64 carrier. */
function externToClosureI64(
  ctx: CodegenContext,
  argLocalIdx: number,
  paramType: Extract<ValType, { kind: "i64" }>,
): Instr[] {
  if (paramType.bigint === true) {
    const toBigintIdx = ctx.funcMap.get("__to_bigint");
    if (toBigintIdx !== undefined) {
      return [
        { op: "local.get", index: argLocalIdx },
        { op: "call", funcIdx: toBigintIdx },
      ];
    }
  }
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx !== undefined) {
    return [{ op: "local.get", index: argLocalIdx }, { op: "call", funcIdx: unboxIdx }, { op: "i64.trunc_sat_f64_s" }];
  }
  return [{ op: "i64.const", value: 0n }];
}

/**
 * Number of positional host arguments consumed before a source rest
 * parameter. The lifted Wasm function still has one additional vec formal for
 * `...rest`; the host bridge materializes that vec from the remaining
 * positional arguments instead of counting it as a JavaScript argument.
 */
function closureHostArity(info: { paramTypes: ValType[]; hasRestParam?: boolean }): number {
  return info.hasRestParam === true ? Math.max(0, info.paramTypes.length - 1) : info.paramTypes.length;
}

/**
 * Emit __call_fn_<arity> export (#1382): call an N-arg WasmGC closure from
 * JS. Takes (externref closure, externref arg0, ..., externref arg<arity-1>)
 * and returns externref. Used by `__array_from`, `__proto_method_call`, and
 * other host shims that pass Wasm closures as JS callbacks.
 *
 * Dispatch: iterate ALL closure types whose user arity ≤ N. For each
 * matching closure, push only as many args as it declared (matches JS
 * spec's "extra args ignored" semantics for over-arity calls). Funcref-
 * type dispatch is required because V8 isorecursive canonicalization
 * collapses base wrapper struct types — only funcref types remain
 * distinct per signature.
 *
 * Locals layout:
 *   0..arity-1 = positional externref params (closure + user args)
 *   arity      = anyref (__any) — converted closure externref
 *   arity+1    = (ref null $baseWrapper) (__struct)
 *   arity+2    = funcref (__funcref)
 *
 * Returns early when no closures of arity ≤ N exist (no export emitted).
 */
function emitClosureCallExportN(ctx: CodegenContext, arity: number): void {
  const mod = ctx.mod;
  const exportName = `__call_fn_${arity}`;

  // Local index conventions for the dispatcher body. `arity` positional
  // params (closure + user args 0..arity-1) come first; auxiliary locals
  // are appended after the params.
  //
  //   0           = closure externref
  //   1..arity-1  = user arg externrefs
  //   anyLocal    = anyref (closure-as-anyref after extern.convert_any)
  //   structLocal = (ref null $baseWrapper) for the cast struct
  //   funcLocal   = funcref extracted from struct field 0
  const anyLocal = arity + 1;
  // arity + 2 is the declared-but-now-unused `__struct` slot (kept so the
  // local layout and funcLocal index stay stable after the #1712 per-shape
  // extraction removed the single representative struct cast).
  const funcLocal = arity + 3;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  // Each entry tracks how many user args the closure declared
  // (closureArity ≤ arity). The host always invokes the dispatcher with
  // `arity` user args; when a closure declared fewer, the dispatch arm
  // drops the extra args. Matches JS spec's "extra args ignored at call
  // time" semantics.
  const entries: {
    funcTypeIdx: number;
    returnType: ValType | null;
    selfTypeIdx: number;
    closureArity: number;
    rest?: {
      matchTypeIdx: number;
      vecTypeIdx: number;
      arrTypeIdx: number;
      elemType: ValType;
    };
  }[] = [];
  const restEntries: (typeof entries)[number][] = [];

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    // A one-shot host callback is invoked only through __call_fn_0 by the
    // compiler-owned -2 wrapper. It cannot be returned, over-applied, or used
    // as a method, so wider generic dispatchers would be dead artifact weight.
    if (info.domCallbackOnly === true || (info.hostOneShotOnly === true && arity !== 0)) continue;
    const hostArity = closureHostArity(info);
    if (hostArity > arity) continue;

    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;

    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }

    const funcTypeDef = mod.types[info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : typeIdx;

    if (info.hasRestParam === true && funcTypeDef?.kind === "func") {
      const restParam = funcTypeDef.params[hostArity + 1];
      if (restParam && (restParam.kind === "ref" || restParam.kind === "ref_null")) {
        const vecTypeIdx = restParam.typeIdx;
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        const arrDef = mod.types[arrTypeIdx];
        if (arrDef?.kind === "array") {
          restEntries.push({
            funcTypeIdx: info.funcTypeIdx,
            returnType: info.returnType,
            selfTypeIdx,
            closureArity: hostArity,
            rest: { matchTypeIdx: typeIdx, vecTypeIdx, arrTypeIdx, elemType: arrDef.element },
          });
          continue;
        }
      }
    }

    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: hostArity,
      });
    }
  }
  // Rest arms are shape-qualified and must run before a same-signature normal
  // vec parameter arm. `funcrefDispatch` is prepended below, so append them.
  entries.push(...restEntries);

  if (entries.length === 0) return;

  // Fall back to the module's canonical wrapper root if no target-arity entry
  // selected it. Shared signature wrappers are distinct children, not
  // canonicalized peers; only the permanently-open root admits every shared
  // signature wrapper for the initial ref.test + struct.get.
  baseWrapperIdx = resolveClosureBaseWrapperTypeIdx(ctx, arity, baseWrapperIdx);
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");

  // #820l — globals for argc + extras-argv plumbing into the callee's
  // `arguments` object. Both globals are mode-agnostic; ensureExtrasArgvGlobal
  // also returns the vec struct typeIdx whose `data` field is an externref
  // array (the same shape used by emitArgumentsVecBody on the receive side).
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasArgvGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);

  // __call_fn_<arity>(closure: externref, arg0: externref, ..., arg<arity-1>: externref) → externref
  const params: ValType[] = [];
  for (let i = 0; i < arity + 1; i++) params.push({ kind: "externref" });
  const exportFuncTypeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$${exportName}_type`);
  const bwIdx = baseWrapperIdx;

  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: anyLocal });

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" }];

  // `funcrefDispatch` is built by prepending each arm, so reverse the
  // priority order returned by `orderClosureDispatchEntries` to keep the
  // broad-signature arm first at runtime.
  const dispatchEntries = orderClosureDispatchEntries(ctx, entries);
  for (const entry of [...dispatchEntries].reverse()) {
    const funcTypeDef = mod.types[entry.funcTypeIdx];

    const buildArgConversion = (argLocalIdx: number, paramType: ValType | undefined): Instr[] => {
      const ops: Instr[] = [{ op: "local.get", index: argLocalIdx }];
      if (paramType) {
        if (paramType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            return externToClosureF64(argLocalIdx, unboxIdx, isUndefinedIdx);
          }
        } else if (paramType.kind === "i32") {
          // A host boolean may arrive as the engine's i31 numeric carrier in
          // standalone mode. __unbox_number recognizes i31, boxed-number, and
          // boxed-boolean values; __unbox_boolean recognizes only the latter
          // and turned true conditions into false across the closure bridge.
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx });
            ops.push({ op: "i32.trunc_sat_f64_s" });
          }
        } else if (paramType.kind === "i64") {
          return externToClosureI64(ctx, argLocalIdx, paramType);
        } else if (needsExternToAnyForClosureParam(paramType)) {
          // The host-facing param is `externref`, but the closure funcref
          // declares this reference param as a non-extern ref type (anyref or
          // a WasmGC struct ref — e.g. a native-strings `string` lowers to
          // `(ref null $AnyString)`). Lower the host externref to the internal
          // ref domain so the subsequent `call_ref` typechecks. In
          // `wasm:js-string` (gc) mode string params ARE externref, so this
          // branch is skipped and the arg passes raw.
          ops.push(...externToClosureParamRef(paramType));
        }
        // externref param: no conversion
      }
      return ops;
    };

    // Push self + fixed user args. For a source rest parameter, materialize its
    // final Wasm vec formal from every remaining positional host argument.
    const argInstrs: Instr[] = [];
    for (let i = 0; i < entry.closureArity; i++) {
      const paramType =
        funcTypeDef?.kind === "func" && funcTypeDef.params.length >= i + 2 ? funcTypeDef.params[i + 1] : undefined;
      argInstrs.push(...buildArgConversion(i + 1, paramType));
    }
    if (entry.rest) {
      const restCount = arity - entry.closureArity;
      argInstrs.push({ op: "i32.const", value: restCount });
      for (let i = entry.closureArity; i < arity; i++) {
        argInstrs.push(...buildArgConversion(i + 1, entry.rest.elemType));
      }
      argInstrs.push({ op: "array.new_fixed", typeIdx: entry.rest.arrTypeIdx, length: restCount });
      argInstrs.push({ op: "struct.new", typeIdx: entry.rest.vecTypeIdx });
    }

    // #820l — argc/extras-argv plumbing so the callee's `arguments` object
    // observes the *actual* host-passed arg count, not just `closureArity`.
    // The host invokes the dispatcher with `arity` user args at locals
    // [1..arity]; the closure declares `closureArity ≤ arity` formals. The
    // receive-side (emitArgumentsVecBody) reads __argc + __extras_argv to
    // build `arguments` with all `arity` slots populated.
    //
    // (#2745) `__argc` follows the CLAMPED-to-formals convention that
    // `emitArgumentsVecBody` (`totalLen = argc + extrasLen`),
    // `maybeSetArgcForKnownCall` (`min(actual, paramCount)`) and the inline
    // array-method plumbing all use: it is the count of FORMAL params filled
    // (`closureArity`), NOT the raw dispatcher arity. The overflow args go to
    // `__extras_argv`, so `arguments.length = argc + extrasLen = arity`. Setting
    // `__argc = arity` here instead double-counted the extras (e.g. an arity-0
    // closure called via `__call_fn_3` reported `arguments.length === 6`), which
    // broke bound-function over-arity forwarding (the bound `[[Call]]` prepends
    // partial args, so the target sees more args than its declared formals).
    const setupInstrs: Instr[] = [
      { op: "i32.const", value: entry.closureArity },
      { op: "global.set", index: argcGlobalIdx },
    ];
    if (arity > entry.closureArity) {
      // vec struct field order: (length: i32, data: arrRef). Push len first.
      const extrasCount = arity - entry.closureArity;
      setupInstrs.push({ op: "i32.const", value: extrasCount });
      for (let i = entry.closureArity; i < arity; i++) {
        setupInstrs.push({ op: "local.get", index: i + 1 });
      }
      setupInstrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount });
      setupInstrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    } else {
      // No extras for this arm — reset to avoid stale data from a prior call.
      setupInstrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    }

    const callBody: Instr[] = [
      ...setupInstrs,
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: entry.selfTypeIdx },
      ...argInstrs,
      { op: "local.get", index: funcLocal },
      { op: "ref.cast", typeIdx: entry.funcTypeIdx },
      { op: "call_ref", typeIdx: entry.funcTypeIdx },
    ];

    // (#4082) Coerce result to externref — one shared decision, see
    // buildClosureResultBoxing.
    callBody.push(...buildClosureResultBoxing(ctx, entry.returnType, boxNumberIdx));

    const entryMatches: Instr[] = entry.rest
      ? [
          { op: "local.get", index: anyLocal },
          { op: "ref.test", typeIdx: entry.rest.matchTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: funcLocal },
              { op: "ref.test", typeIdx: entry.funcTypeIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ]
      : [
          { op: "local.get", index: funcLocal },
          { op: "ref.test", typeIdx: entry.funcTypeIdx },
        ];
    funcrefDispatch = [
      ...entryMatches,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      },
    ];
  }

  // (#1712) Funcref extraction must succeed for EVERY self-carrier shape in the
  // dispatch entries. Shared capture structs now subtype their signature
  // wrapper and canonical root, but private/named function-expression structs
  // retain unrelated concrete self types. Mirror `__is_closure`
  // (collectClosureBaseWrapperTypeIdxs): chain a `ref.test` per distinct self
  // shape, extracting field 0 from whichever matches. `funcLocal` stays null
  // when nothing matches and the dispatch falls through as before.
  body.push(...buildFuncrefExtraction(ctx, dispatchEntries, anyLocal, funcLocal));
  body.push(...funcrefDispatch);

  publishClosureHostBridge(
    ctx,
    {
      name: exportName,
      typeIdx: exportFuncTypeIdx,
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
        { name: "__funcref", type: { kind: "funcref" } },
      ],
      body,
      exported: true,
    } as WasmFunction,
    directClosureHostBridgeOrdinal(arity),
  );
}

/**
 * (#1712) Build the funcref-extraction preamble shared by the
 * `__call_fn_<arity>` / `__call_fn_method_<arity>` dispatchers: for each
 * distinct closure self-struct shape among the dispatch entries, test the
 * anyref against the shape and, on match, store its field-0 funcref into
 * `funcLocal`. Every lifted closure struct has field 0 = funcref by
 * construction, so a value matching several canonically-equal shapes just
 * re-extracts the same funcref. Non-closure inputs match nothing and leave
 * `funcLocal` as null funcref (the dispatch chain's `ref.test`s all fail on
 * null and yield the `ref.null.extern` fallthrough).
 */
function buildFuncrefExtraction(
  ctx: CodegenContext,
  entries: { selfTypeIdx: number }[],
  anyLocal: number,
  funcLocal: number,
): Instr[] {
  // (#3673) Root-collapse: every shared-signature wrapper AND every
  // capture-carrying closure struct subtypes the canonical root wrapper
  // (mintClosureStructTypes / getOrCreateFuncRefWrapperTypes), and field 0 is
  // funcref on the root itself — so ONE `ref.test <root>` arm extracts the
  // funcref for all of them. Only shapes with no path to the root (named
  // function expressions, wrapper-less fallbacks) keep per-shape arms. The
  // old one-arm-per-shape ladder ran per dynamic call/arity-probe and scaled
  // with the number of closures in the program (hundreds for acorn).
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const isRootDescendant = (typeIdx: number): boolean => {
    if (rootIdx === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdx) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = ctx.mod.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const out: Instr[] = [];
  const seenShape = new Set<number>();
  let needRootArm = false;
  const ladderShapes: number[] = [];
  for (const entry of entries) {
    if (seenShape.has(entry.selfTypeIdx)) continue;
    seenShape.add(entry.selfTypeIdx);
    if (isRootDescendant(entry.selfTypeIdx)) needRootArm = true;
    else ladderShapes.push(entry.selfTypeIdx);
  }
  if (needRootArm) {
    out.push({ op: "local.get", index: anyLocal });
    out.push({ op: "ref.test", typeIdx: rootIdx! });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdx! },
        { op: "struct.get", typeIdx: rootIdx!, fieldIdx: 0 },
        { op: "local.set", index: funcLocal },
      ],
    });
  }
  for (const selfTypeIdx of ladderShapes) {
    out.push({ op: "local.get", index: anyLocal });
    out.push({ op: "ref.test", typeIdx: selfTypeIdx });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: selfTypeIdx },
        { op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: funcLocal },
      ],
    });
  }
  return out;
}

/**
 * Order overlapping funcref signatures before emitting a dynamic dispatcher.
 *
 * Wasm function-reference subtyping is contravariant in parameters.  That
 * means a closure whose parameter is `externref` can also satisfy a
 * `ref.test` for a closure whose parameter is a narrower GC reference.  The
 * old insertion order consequently let a `(self, ref $Vec)` arm claim a
 * `(self, externref)` closure first; its argument conversion then attempted
 * to cast an ordinary host event object to `$Vec` and trapped.  Put broad
 * parameter signatures first (and concrete result signatures first), while
 * keeping rest-parameter arms ahead of ordinary vec arms.  The method
 * dispatcher uses this order directly; the plain dispatcher reverses it when
 * constructing its nested if ladder below.
 */
function orderClosureDispatchEntries<T extends { funcTypeIdx: number; rest?: unknown }>(
  ctx: CodegenContext,
  entries: T[],
): T[] {
  const breadth = (type: ValType | undefined): number =>
    type?.kind === "externref" || type?.kind === "anyref" ? 1 : 0;
  const score = (entry: T) => {
    const def = ctx.mod.types[entry.funcTypeIdx];
    if (!def || def.kind !== "func") return { params: 0, results: 0 };
    // Skip the lifted self parameter. Host dispatch only converts user args.
    const params = def.params.slice(1).reduce((sum, type) => sum + breadth(type), 0);
    const results = def.results.reduce((sum, type) => sum + breadth(type), 0);
    return { params, results };
  };
  const ordered = entries
    .map((entry, index) => ({ entry, index, score: score(entry) }))
    .sort((a, b) => {
      // Shape-qualified rest entries must win over a same-signature ordinary
      // vec entry.  The stable index tie-break preserves deterministic output.
      const restOrder = Number(Boolean(b.entry.rest)) - Number(Boolean(a.entry.rest));
      if (restOrder !== 0) return restOrder;
      // Function-parameter contravariance: broad host-facing parameters first.
      if (a.score.params !== b.score.params) return b.score.params - a.score.params;
      // Function-result covariance: concrete results first, broad externref
      // results last, so a broad result arm cannot claim a narrower closure.
      if (a.score.results !== b.score.results) return a.score.results - b.score.results;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
  return ordered;
}

/**
 * Emit `__call_fn_method_<arity>` export (#1636-S1): call an N-arg WasmGC
 * closure from JS with a host-supplied `this`-value. Signature is
 * `(thisVal: externref, closure: externref, arg0..arg<arity-1>) -> externref`.
 *
 * Dispatch shape mirrors `emitClosureCallExportN` (same funcref-type
 * iteration, same arg-coercion + return-boxing). The only difference is
 * that `thisVal` is stored in the `__current_this` module global before the
 * inner `call_ref` and restored after, so `ThisKeyword` resolution in the
 * closure body observes the host's receiver instead of the previous null
 * fallback (see `ensureCurrentThisGlobal`).
 *
 * Returns early when no closures of arity ≤ N exist (no export emitted).
 */
export function emitClosureMethodCallExportN(ctx: CodegenContext, arity: number): void {
  const mod = ctx.mod;
  const exportName = `__call_fn_method_${arity}`;

  // Local index conventions for the dispatcher body:
  //   0           = thisVal externref
  //   1           = closure externref
  //   2..arity+1  = user arg externrefs (arity slots)
  //   anyLocal    = anyref (closure-as-anyref after extern.convert_any)
  //   structLocal = (ref null $baseWrapper) for the cast struct
  //   funcLocal   = funcref extracted from struct field 0
  //   prevThis    = externref save slot for nested invocations
  const totalParams = arity + 2; // thisVal + closure + N user args
  const anyLocal = totalParams;
  // totalParams + 1 is the declared-but-now-unused `__struct` slot (see the
  // #1712 per-shape extraction note in emitClosureCallExportN).
  const funcLocal = totalParams + 2;
  const prevThisLocal = totalParams + 3;
  const resultSaveLocal = prevThisLocal + 1;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  const entries: {
    funcTypeIdx: number;
    returnType: ValType | null;
    selfTypeIdx: number;
    closureArity: number;
    rest?: {
      matchTypeIdx: number;
      vecTypeIdx: number;
      arrTypeIdx: number;
      elemType: ValType;
    };
  }[] = [];
  const restEntries: (typeof entries)[number][] = [];
  // (#3992) Every native-proto METHOD closure of this arity — see the collector.
  const nativeProtoReceiverEntries = collectTransferredNativeProtoReceivers(ctx, arity);

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.hostOneShotOnly === true || info.domCallbackOnly === true) continue;
    const hostArity = closureHostArity(info);
    if (hostArity > arity) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }
    const funcTypeDef = mod.types[info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : typeIdx;

    if (info.hasRestParam === true && funcTypeDef?.kind === "func") {
      const restParam = funcTypeDef.params[hostArity + 1];
      if (restParam && (restParam.kind === "ref" || restParam.kind === "ref_null")) {
        const vecTypeIdx = restParam.typeIdx;
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        const arrDef = mod.types[arrTypeIdx];
        if (arrDef?.kind === "array") {
          restEntries.push({
            funcTypeIdx: info.funcTypeIdx,
            returnType: info.returnType,
            selfTypeIdx,
            closureArity: hostArity,
            rest: { matchTypeIdx: typeIdx, vecTypeIdx, arrTypeIdx, elemType: arrDef.element },
          });
          continue;
        }
      }
    }

    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: hostArity,
      });
    }
  }
  entries.push(...restEntries);
  if (entries.length === 0 && nativeProtoReceiverEntries.length === 0) return;

  baseWrapperIdx = resolveClosureBaseWrapperTypeIdx(ctx, arity, baseWrapperIdx);
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  // (#2745) Same #820l argc/extras plumbing as `emitClosureCallExportN`, so a
  // method-dispatched closure's `arguments` object observes over-arity args
  // (the receiver-bound bound-function `[[Call]]` / `[[Construct]]` path, and
  // any `o.m(...extra)` method call). Without this the method dispatch left
  // `__argc`/`__extras_argv` untouched, so a bound target reading
  // `arguments[i]` past its formals (e.g. `func.bind(obj)` then `newFunc(1)`)
  // never saw the extra args.
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasArgvGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);

  const params: ValType[] = [];
  for (let i = 0; i < totalParams; i++) params.push({ kind: "externref" });
  const exportFuncTypeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$${exportName}_type`);
  const bwIdx = baseWrapperIdx;

  // Closure externref → anyref, then (#4197) the runtime-eval carrier
  // front-guard, then the `__current_this` save/install. That order is a
  // contract — see `buildMethodDispatchPrologue`.
  const body: Instr[] = buildMethodDispatchPrologue(ctx, arity, anyLocal, prevThisLocal, currentThisGlobalIdx);

  const npArgs = {
    anyLocal,
    resultSaveLocal,
    prevThisLocal,
    currentThisGlobalIdx,
    // (#4082) The arm must lower its callee's real result to externref, exactly
    // as the generic dispatch arms below do.
    boxNumberIdx,
  };
  body.push(...buildTransferredNativeProtoCallInstrs(ctx, nativeProtoReceiverEntries, arity, npArgs));

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" }];
  // (#3673 round 10) per-entry callBody capture for the arity-bucketed
  // dispatch built after the loop.
  const callBodyByEntry: { entry: (typeof entries)[number]; callBody: Instr[] }[] = [];

  // The method dispatcher emits the arity bucket as a flat, ordered ladder;
  // keep its priority order directly.  The fallback nested ladder below is
  // assembled by prepending, so it reverses this sequence once more.
  const dispatchEntries = orderClosureDispatchEntries(ctx, entries);
  // The fallback ladder is built by prepending arms, whereas the arity bucket
  // below consumes `callBodyByEntry` in sequence. Build the nested ladder in
  // reverse and restore the flat list afterward so both paths agree.
  for (const entry of [...dispatchEntries].reverse()) {
    const funcTypeDef = mod.types[entry.funcTypeIdx];

    const buildArgConversion = (argLocalIdx: number, formalIndex: number, paramType: ValType | undefined): Instr[] => {
      const ops: Instr[] = [{ op: "local.get", index: argLocalIdx }];
      if (paramType) {
        if (paramType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            return externToClosureF64(argLocalIdx, unboxIdx, isUndefinedIdx);
          }
        } else if (paramType.kind === "i32") {
          // Mirror the free-call bridge above: standalone host booleans can be
          // i31 numeric carriers, so the numeric coercion is the lossless union
          // decoder for both booleans and integer-valued arguments here.
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx });
            ops.push({ op: "i32.trunc_sat_f64_s" });
          }
        } else if (paramType.kind === "i64") {
          return externToClosureI64(ctx, argLocalIdx, paramType);
        } else if (needsExternToAnyForClosureParam(paramType)) {
          // See emitClosureCallExportN: a non-extern reference param (anyref /
          // WasmGC struct ref, e.g. a native-strings `string`) needs the host
          // externref lowered into the internal ref domain before `call_ref`.
          // Skipped in gc mode where string params are already externref.
          ops.push(...externToClosureParamRef(paramType));
        }
      }
      // The widened dispatcher receives a real JS `undefined` carrier in each
      // padded externref slot. That value cannot be `ref.cast` to a nullable
      // closed struct even though the callee's internal representation for an
      // omitted optional object is exactly `ref.null $T`. Preserve dynamic
      // coercion for supplied arguments (notably numeric undefined -> NaN),
      // but materialize omission in the nullable reference domain before the
      // cast. `__argc` still contains the raw call-site count at this point.
      if (paramType?.kind !== "ref_null") return ops;
      return [
        { op: "global.get", index: argcGlobalIdx },
        { op: "i32.const", value: formalIndex },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: paramType },
          then: ops,
          else: [{ op: "ref.null", typeIdx: paramType.typeIdx }],
        },
      ];
    };

    // User args occupy locals [2..arity+1]. Push fixed formals, then build the
    // rest vec formal (when present) from the remaining positional args.
    const argInstrs: Instr[] = [];
    for (let i = 0; i < entry.closureArity; i++) {
      const paramType =
        funcTypeDef?.kind === "func" && funcTypeDef.params.length >= i + 2 ? funcTypeDef.params[i + 1] : undefined;
      argInstrs.push(...buildArgConversion(i + 2, i, paramType));
    }
    if (entry.rest) {
      const restCount = arity - entry.closureArity;
      argInstrs.push({ op: "i32.const", value: restCount });
      for (let i = entry.closureArity; i < arity; i++) {
        argInstrs.push(...buildArgConversion(i + 2, i, entry.rest.elemType));
      }
      argInstrs.push({ op: "array.new_fixed", typeIdx: entry.rest.arrTypeIdx, length: restCount });
      argInstrs.push({ op: "struct.new", typeIdx: entry.rest.vecTypeIdx });
    }

    // (#2745) #820l argc/extras plumbing (clamped-to-formals convention; see
    // emitClosureCallExportN). User args are at locals [2..arity+1]; formal i is
    // at local i+2, extras are args[closureArity..arity) at locals
    // [closureArity+2 .. arity+2).
    // Dynamic callers may widen an under-applied call to the closure's declared
    // arity so this dispatcher can match it. They seed __argc with the ACTUAL
    // call-site count first; preserve min(actual, formals) in every target mode.
    // Callers without an exact count leave the -1 sentinel and retain the
    // historical declared-arity fallback.
    const setupInstrs: Instr[] = [
      { op: "global.get", index: argcGlobalIdx },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "global.get", index: argcGlobalIdx },
          { op: "i32.const", value: entry.closureArity },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "global.get", index: argcGlobalIdx }],
            else: [{ op: "i32.const", value: entry.closureArity }],
          },
        ],
        else: [{ op: "i32.const", value: entry.closureArity }],
      },
      { op: "global.set", index: argcGlobalIdx },
    ];
    if (arity > entry.closureArity) {
      const extrasCount = arity - entry.closureArity;
      setupInstrs.push({ op: "i32.const", value: extrasCount });
      for (let i = entry.closureArity; i < arity; i++) {
        setupInstrs.push({ op: "local.get", index: i + 2 });
      }
      setupInstrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount });
      setupInstrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    } else {
      setupInstrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx });
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx });
    }

    const callBody: Instr[] = [
      ...setupInstrs,
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: entry.selfTypeIdx },
      ...argInstrs,
      { op: "local.get", index: funcLocal },
      { op: "ref.cast", typeIdx: entry.funcTypeIdx },
      { op: "call_ref", typeIdx: entry.funcTypeIdx },
    ];

    // (#4082) One shared decision — see buildClosureResultBoxing.
    callBody.push(...buildClosureResultBoxing(ctx, entry.returnType, boxNumberIdx));

    const entryMatches: Instr[] = entry.rest
      ? [
          { op: "local.get", index: anyLocal },
          { op: "ref.test", typeIdx: entry.rest.matchTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: funcLocal },
              { op: "ref.test", typeIdx: entry.funcTypeIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ]
      : [
          { op: "local.get", index: funcLocal },
          { op: "ref.test", typeIdx: entry.funcTypeIdx },
        ];
    funcrefDispatch = [
      ...entryMatches,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      },
    ];
    callBodyByEntry.push({ entry, callBody });
  }
  callBodyByEntry.reverse();

  // (#1712) Per-shape funcref extraction — same rationale as
  // `emitClosureCallExportN` / `buildFuncrefExtraction`: shared captures pass
  // the canonical-root test, while private/named closure self structs still
  // require their own shape arms. The funcref dispatch below leaves its
  // externref result on the stack (null fallthrough when `funcLocal` stayed
  // null because no shape matched).
  body.push(...buildFuncrefExtraction(ctx, dispatchEntries, anyLocal, funcLocal));

  // (#3673 round 10) Arity-bucketed signature dispatch. The full ladder below
  // is one funcref `ref.test` per DISTINCT closure func type (≈48 in compiled
  // acorn) per dynamic call. The closure's `$arity` field (round 6, root
  // wrapper field 1) equals its func type's declared param count at every
  // compiler allocation site, so an i32 compare narrows the ladder to the
  // (small) same-arity bucket first. The arity field is NOT trusted for
  // correctness: builtin-fn metas stamp the SPEC length (e.g. a variadic
  // `JSON.stringify` value closure declares 1 vec param but `.length` 3), so
  // a bucket MISS — or a receiver with no root-readable arity — falls through
  // to the unchanged full ladder. `br 2` exits the wrapping externref block
  // from inside (entry-if ⊂ bucket-if ⊂ block) carrying the call result.
  const rootIdxForArity = getFuncRefWrapperRootTypeIdx(ctx);
  if (rootIdxForArity !== undefined && callBodyByEntry.length > 4) {
    const declaredLocal = prevThisLocal + 2; // extra i32 local appended below
    body.push({ op: "i32.const", value: -1 });
    body.push({ op: "local.set", index: declaredLocal });
    body.push({ op: "local.get", index: anyLocal });
    body.push({ op: "ref.test", typeIdx: rootIdxForArity });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdxForArity },
        { op: "struct.get", typeIdx: rootIdxForArity, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
        { op: "local.set", index: declaredLocal },
      ],
    });
    const buckets = new Map<number, { entry: (typeof callBodyByEntry)[number]["entry"]; callBody: Instr[] }[]>();
    for (const item of callBodyByEntry) {
      let bucket = buckets.get(item.entry.closureArity);
      if (!bucket) {
        bucket = [];
        buckets.set(item.entry.closureArity, bucket);
      }
      bucket.push(item);
    }
    const bucketArms: Instr[] = [];
    for (const [closureArity] of buckets) {
      // A rest closure accepts every host arity at or above its fixed prefix.
      // Its Wasm funcref often has the same vec signature as an ordinary
      // callback, so leaving it in only the prefix bucket lets the ordinary
      // arm claim it first (and cast a host argument to the vec). Include rest
      // entries in every compatible bucket and keep the dispatch order from
      // `callBodyByEntry`, where rest arms precede ordinary vec arms.
      const items = callBodyByEntry.filter(
        ({ entry }) => entry.rest !== undefined || entry.closureArity === closureArity,
      );
      bucketArms.push(
        { op: "local.get", index: declaredLocal },
        { op: "i32.const", value: closureArity },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: items.flatMap(({ entry, callBody }): Instr[] => [
            ...(entry.rest
              ? [
                  { op: "local.get", index: anyLocal } as Instr,
                  { op: "ref.test", typeIdx: entry.rest.matchTypeIdx } as Instr,
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      { op: "local.get", index: funcLocal },
                      { op: "ref.test", typeIdx: entry.funcTypeIdx },
                    ],
                    else: [{ op: "i32.const", value: 0 }],
                  } as Instr,
                ]
              : [
                  { op: "local.get", index: funcLocal } as Instr,
                  { op: "ref.test", typeIdx: entry.funcTypeIdx } as Instr,
                ]),
            {
              op: "if",
              blockType: { kind: "empty" },
              // Deep-clone: the same Instr OBJECTS also live in the full
              // ladder below, and shared instr identities get double-remapped
              // by finalize walks (see
              // `reference_shared_instr_object_dce_double_remap`).
              then: [...(structuredClone(callBody) as Instr[]), { op: "br", depth: 2 }],
            },
          ]),
        },
      );
    }
    body.push({
      op: "block",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: [...bucketArms, ...funcrefDispatch],
    });
  } else {
    body.push(...funcrefDispatch);
  }

  // Restore __current_this. The result value remains on the stack as the
  // function's return value — we tee it through a local so we can restore
  // the global without disturbing the return value.
  // Stack at this point: [result : externref]
  // Strategy: store result in a local, restore global, reload result.
  // Reuse `prevThisLocal` is not safe since we still need its contents;
  // use `anyLocal` is also not safe (externref vs anyref). Add a dedicated
  // result-save slot at index `prevThisLocal + 1`.
  body.push({ op: "local.set", index: resultSaveLocal });
  body.push({ op: "local.get", index: prevThisLocal });
  body.push({ op: "global.set", index: currentThisGlobalIdx });
  body.push({ op: "local.get", index: resultSaveLocal });

  const funcIdx = publishClosureHostBridge(
    ctx,
    {
      name: exportName,
      typeIdx: exportFuncTypeIdx,
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
        { name: "__funcref", type: { kind: "funcref" } },
        { name: "__prev_this", type: { kind: "externref" } },
        { name: "__result", type: { kind: "externref" } },
        // (#3673 round 10) declared arity read off the root wrapper for the
        // arity-bucketed signature dispatch (-1 = not root-readable).
        { name: "__declared_arity", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction,
    methodClosureHostBridgeOrdinal(arity),
  );

  // (#1719 CPR) Register in funcMap so the in-Wasm `__drive_proto_iterator`
  // driver (filled in post-processing) can resolve `__call_fn_method_0` by name
  // and `call` it to drive a captured `Array.prototype[@@iterator]` override.
  // No-op for existing JS-host callers (they dispatch by export name).
  ctx.funcMap.set(exportName, funcIdx);

  // A JS caller may supply fewer arguments than the closure declares. The
  // host wrapper widens to this dispatcher arity so the closure remains
  // selectable, but `arguments.length` must still observe the original call.
  // Keep that count in a compiler-reserved wrapper export: one host→Wasm call
  // seeds __argc, invokes the ordinary method dispatcher, and clears the
  // protocol slot before returning. A NUL-containing export name cannot
  // collide with a source-level JavaScript identifier.
  const argcExportName = `__\0js2_call_fn_method_argc_${arity}`;
  const argcParams: ValType[] = [{ kind: "i32" }];
  for (let i = 0; i < arity + 2; i++) argcParams.push({ kind: "externref" });
  const argcTypeIdx = addFuncType(ctx, argcParams, [{ kind: "externref" }], `$${argcExportName}_type`);
  const argcFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const argcBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "global.set", index: argcGlobalIdx },
  ];
  for (let i = 0; i < arity + 2; i++) {
    argcBody.push({ op: "local.get", index: i + 1 });
  }
  argcBody.push(
    { op: "call", funcIdx },
    { op: "local.set", index: arity + 3 },
    { op: "i32.const", value: -1 },
    { op: "global.set", index: argcGlobalIdx },
    { op: "local.get", index: arity + 3 },
  );
  ctx.mod.functions.push({
    name: argcExportName,
    typeIdx: argcTypeIdx,
    locals: [{ name: "__result", type: { kind: "externref" } }],
    body: argcBody,
    exported: true,
  } as WasmFunction);
  ctx.mod.exports.push({
    name: argcExportName,
    desc: { kind: "func", index: argcFuncIdx },
  });
}

/**
 * Emit __is_closure(externref) -> i32 (#1504). Returns 1 if the value is a
 * registered Wasm closure struct, 0 otherwise. Used by the JS-side
 * `wrapExports` to discriminate closures from named structs / vecs so it can
 * choose between callable-wrapping (#1308) and `_wasmToPlain` marshaling
 * (#1504). No-op when the module has no closures.
 */
/* (#2175 V2-S1) `collectClosureBaseWrapperTypeIdxs` moved to the leaf module
 * `closure-classifier.ts` so `index.ts` and `dyn-read.ts` share ONE list (see
 * that file). Imported at the top of this module. */

export function emitIsClosureExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect base wrapper struct types (deduped). Concrete closure subtypes
  // share their funcref signature with the base wrapper post-V8 canonicalisation,
  // so ref.test against the base catches all of them.
  const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  if (baseTypeIdxs.length === 0) return;

  const isClosureTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$is_closure_type");

  // body: convert extern→any, then chained ref.test → return 1 on first match.
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const closureType of baseTypeIdxs) {
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.test", typeIdx: closureType });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: 0 });

  publishClosureHostBridge(
    ctx,
    {
      name: "__is_closure",
      typeIdx: isClosureTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as WasmFunction,
    CLOSURE_HOST_BRIDGE_ORDINAL.isClosure,
  );
}

/**
 * Emit `__closure_arity(externref) -> i32` (#2623 P-7 / B-1). Returns the
 * DECLARED formal-parameter count of a registered Wasm closure struct, or -1
 * when the value is not a closure. Used by the JS-side dynamic bridge
 * (`_wrapWasmClosureUnknownArity`) to dispatch a host→wasm method callback at
 * `max(args.length, realArity)` instead of always the HIGHEST emitted
 * `__call_fn_method_N`: dispatching at max-N padded the arg vector with
 * undefineds that the #820l argc/extras plumbing cannot distinguish from real
 * arguments, so the callee's `arguments.length` reported the dispatcher arity
 * (V8's native `.finally` invokes a patched `then` with exactly 2 args; the
 * wasm-side `then` observed `arguments.length === 5` — the test262
 * `Promise/prototype/finally/invokes-then-with-*` assert-#3 failure and the
 * #2614 assert-#2 finding).
 *
 * Dispatch shape mirrors `__call_fn_N` (per-shape funcref extraction via
 * {@link buildFuncrefExtraction}, then a `ref.test` chain over the distinct
 * closure FUNC types — the func type determines the formal count). No-op when
 * the module has no closures, exactly like `__is_closure`.
 */
function collectClosureArityEntries(
  ctx: CodegenContext,
): { funcTypeIdx: number; selfTypeIdx: number; closureArity: number }[] {
  const mod = ctx.mod;
  const seenFuncTypeIdx = new Set<number>();
  const entries: { funcTypeIdx: number; selfTypeIdx: number; closureArity: number }[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.hostOneShotOnly === true || info.domCallbackOnly === true) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    if (seenFuncTypeIdx.has(info.funcTypeIdx)) continue;
    seenFuncTypeIdx.add(info.funcTypeIdx);
    const funcTypeDef = mod.types[info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : typeIdx;
    entries.push({ funcTypeIdx: info.funcTypeIdx, selfTypeIdx, closureArity: closureHostArity(info) });
  }
  return entries;
}

/**
 * (#3592) INLINE twin of {@link emitClosureArityExport} for the IN-WASM dynamic
 * call bridge `__apply_closure`. Leaves an `i32` on the stack: the DECLARED
 * formal count of the closure in `valueLocal`, or `-1` when it is not a
 * registered closure. Returns `undefined` when the module has no closures (the
 * caller then keeps its arg-count-only dispatch, byte-identical).
 *
 * Emitted inline rather than as a `call` to the `__closure_arity` EXPORT because
 * that export is minted at index.ts:3975 — AFTER `fillApplyClosure` runs at
 * :3817 — and minting a function inside that finalize window is the
 * #1839/#117/#1886 late-registration index-shift hazard the whole "S1 pulls no
 * new machinery" carve-out in `fillApplyClosure` exists to avoid. Inlining
 * costs a duplicated `ref.test` chain and shifts nothing.
 *
 * `anyLocal` must be an `anyref` slot and `funcLocal` a `funcref` slot; both are
 * clobbered.
 */
function buildClosureArityProbe(
  ctx: CodegenContext,
  valueLocal: number,
  anyLocal: number,
  funcLocal: number,
): Instr[] | undefined {
  const entries = collectClosureArityEntries(ctx);
  if (entries.length === 0) return undefined;
  // (#3673) Root fast path: every closure struct in the wrapper hierarchy
  // carries its declared arity as field CLOSURE_ARITY_FIELD_IDX, so ONE
  // `ref.test <root>` + `struct.get` answers the probe — the per-func-type
  // `ref.test` chain (90 arms on compiled acorn) survives only for closure
  // shapes OUTSIDE the hierarchy (e.g. fnctor ctor closures).
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const isRootDescendant = (typeIdx: number): boolean => {
    if (rootIdx === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdx) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = ctx.mod.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const ladderEntries = entries.filter((e) => !isRootDescendant(e.selfTypeIdx));
  // Nested if/else so exactly ONE arm wins (the export twin uses early `return`,
  // which is unavailable mid-body).
  let chain: Instr[] = [{ op: "i32.const", value: -1 }];
  for (let i = ladderEntries.length - 1; i >= 0; i--) {
    chain = [
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: ladderEntries[i]!.funcTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: ladderEntries[i]!.closureArity }],
        else: chain,
      },
    ];
  }
  const slowPath: Instr[] = [
    { op: "ref.null.func" },
    { op: "local.set", index: funcLocal },
    ...buildFuncrefExtraction(ctx, ladderEntries, anyLocal, funcLocal),
    ...chain,
  ];
  if (rootIdx === undefined) {
    return [
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      ...slowPath,
    ];
  }
  return [
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: rootIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: rootIdx },
        { op: "struct.get", typeIdx: rootIdx, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
      ],
      else: slowPath,
    },
  ];
}

/**
 * (#3592) Build `__apply_closure`'s UNDER-APPLICATION widening: replace the
 * bridge's dispatch index `n` (the raw argument count) with
 * `max(n, declaredArity(fn))`, appending the three probe locals to `locals`.
 * Returns `[]` — and appends nothing — when the module has no closures, so such
 * modules stay byte-identical.
 *
 * WHY: `__call_fn_method_N` carries only closures with `formals <= N`, so an
 * arity-3 closure dispatched at `n = 2` matched no arm and fell through to the
 * bridge's undefined sentinel — the call SILENTLY DID NOT HAPPEN. That is the
 * shape of the entire test262 assert harness (`assert.sameValue(found, expected,
 * message)` invoked with two args), so every under-applied `assert.*` scored a
 * VACUOUS PASS in the standalone/WASI lanes. The JS-host lane fixed the same bug
 * in JS at #2623 P-7 (`max(args.length, __closure_arity(fn))`); the in-Wasm
 * bridge never did.
 *
 * WHY `max` AND NOT PADDING: widening only to the callee's OWN declared count
 * keeps `N === closureArity`, where the #820l plumbing sets `__argc =
 * closureArity` with a null `__extras_argv` — byte-for-byte what an arity-matched
 * call sets, so `arguments.length` reflection is untouched. Padding the arg
 * vector to the highest emitted dispatcher instead fills `__extras_argv` with
 * synthetic `undefined`s, which is precisely the regression #2623 P-7 removed.
 *
 * Non-closures probe as `-1`, so over-application, exact-arity and
 * not-a-function all keep their existing dispatch index.
 *
 * Lives here rather than in `fillApplyClosure` so the widening sits next to the
 * `__call_fn_method_N` emitter whose arity filter it compensates for (and so the
 * `object-runtime.ts` god-file does not grow).
 */
export function buildApplyClosureArityWidening(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  fnLocal: number,
  nLocal: number,
  paramCount: number,
): Instr[] {
  const declLocal = paramCount + locals.length;
  const probe = buildClosureArityProbe(ctx, fnLocal, declLocal + 1, declLocal + 2);
  if (!probe) return [];
  locals.push(
    { name: "__decl_arity", type: { kind: "i32" } },
    { name: "__arity_any", type: { kind: "anyref" } },
    { name: "__arity_func", type: { kind: "funcref" } },
  );
  return [
    ...probe,
    { op: "local.set", index: declLocal },
    { op: "local.get", index: declLocal },
    { op: "local.get", index: nLocal },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: declLocal },
        { op: "local.set", index: nLocal },
      ],
    },
  ];
}

export function emitClosureArityExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  const entries = collectClosureArityEntries(ctx);
  if (entries.length === 0) return;

  const arityTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$closure_arity_type");

  // Locals: 0 = value externref (param), 1 = anyref, 2 = funcref.
  const anyLocal = 1;
  const funcLocal = 2;
  // (#3673) Root fast path — mirror of buildClosureArityProbe: one
  // struct.get on the wrapper root answers every in-hierarchy closure; the
  // per-func-type chain survives only for shapes outside the hierarchy.
  const rootIdxForExport = getFuncRefWrapperRootTypeIdx(ctx);
  const isRootDescendantExport = (typeIdx: number): boolean => {
    if (rootIdxForExport === undefined) return false;
    let cur: number | undefined = typeIdx;
    let guard = 0;
    while (cur !== undefined && cur >= 0 && guard++ < 64) {
      if (cur === rootIdxForExport) return true;
      const t: { kind: string; superTypeIdx?: number } | undefined = ctx.mod.types[cur];
      cur = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    }
    return false;
  };
  const ladderEntriesExport = entries.filter((e) => !isRootDescendantExport(e.selfTypeIdx));
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  if (rootIdxForExport !== undefined) {
    body.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: rootIdxForExport },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: rootIdxForExport },
          { op: "struct.get", typeIdx: rootIdxForExport, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
          { op: "return" },
        ],
      },
    );
  }
  body.push(...buildFuncrefExtraction(ctx, ladderEntriesExport, anyLocal, funcLocal));
  for (const entry of ladderEntriesExport) {
    body.push({ op: "local.get", index: funcLocal });
    body.push({ op: "ref.test", typeIdx: entry.funcTypeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: entry.closureArity }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: -1 });

  const funcIdx = publishClosureHostBridge(
    ctx,
    {
      name: "__closure_arity",
      typeIdx: arityTypeIdx,
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__funcref", type: { kind: "funcref" } },
      ],
      body,
      exported: true,
    } as WasmFunction,
    CLOSURE_HOST_BRIDGE_ORDINAL.closureArity,
  );
  // Native in-module callers (notably `__apply_closure`) need the same
  // classifier the JS wrapper uses. Register the canonical function index so
  // reserve-then-fill runtimes can call it without introducing another ABI.
  ctx.funcMap.set("__closure_arity", funcIdx);
}

/**
 * Emit `__closure_has_rest(externref) -> i32` for the narrow host-accessor
 * bridge. A returned rest closure cannot be exposed through the generic
 * host-call dispatcher: its single Wasm formal is the materialized rest vec,
 * while V8 supplies the call's positional host arguments. Treating the first
 * host argument as that vec causes an uncatchable concrete-struct `ref.cast`.
 *
 * The source-shape bit lives on `ClosureInfo`; captured rest closures retain a
 * concrete subtype, while no-capture closures can reuse a signature-keyed
 * wrapper. The latter means an identical vec-signature non-rest closure is
 * conservatively left raw too. Modules without rest closures emit nothing.
 */
export function emitClosureHasRestExport(ctx: CodegenContext): void {
  const restTypes = [...ctx.closureInfoByTypeIdx]
    .filter(([, info]) => info.hasRestParam === true)
    .map(([typeIdx]) => typeIdx);
  if (restTypes.length === 0) {
    emitClosureHostBridgeManifest(ctx);
    return;
  }

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$closure_has_rest_type");
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const restType of new Set(restTypes)) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: restType },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });

  publishClosureHostBridge(
    ctx,
    {
      name: "__closure_has_rest",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as WasmFunction,
    CLOSURE_HOST_BRIDGE_ORDINAL.closureHasRest,
  );
  emitClosureHostBridgeManifest(ctx);
}

/**
 * Emit `__is_data_struct(externref) -> i32` (#2794). Returns 1 when the value is
 * a registered **named DATA struct** (a class instance, an object literal, an AST
 * Node — anything the host can read fields off via `__sget_<field>`), 0 otherwise.
 *
 * This is the POSITIVE data-vs-closure discriminator the `_wrapForHost` proxy
 * needs (mirrors the proven `__is_vec`): its `get` trap masks ANY non-vec wasm
 * struct field value as a callable `closureBridge` whenever generic `__call_fn_N`
 * dispatchers exist, which wrongly presented acorn's `decl.id` (an Identifier
 * Node) as a function — `expr.type` read `undefined` and var-declaration parses
 * threw "Binding rvalue". `__is_closure` cannot gate the bridge because it
 * FALSE-NEGATIVES on some genuine closures (a capture-less arrow read 0 → would
 * be wrongly diverted to an object proxy → "not a function"). A POSITIVE
 * data-struct marker has no such failure mode: closure wrapper structs are NOT
 * registered in `structFields` (they live only in `closureInfoByTypeIdx`), so a
 * `ref.test` against the data-struct set returns 0 for every closure and 1 only
 * for genuine data. The set mirrors `_emitStructFieldGettersInner` exactly (the
 * same skip-list), so a struct presents as an object iff the host already has
 * field getters for it. No-op when the module has no eligible data structs.
 */
export function emitIsDataStructExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect data-struct type indices (deduped), mirroring the getter emitter's
  // skip-list so the marker and the `__sget_<field>` getters cover one set.
  const dataTypeIdxs: number[] = [];
  const seen = new Set<number>();
  for (const [structName] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    seen.add(typeIdx);
    dataTypeIdxs.push(typeIdx);
  }
  if (dataTypeIdxs.length === 0) return;

  const isDataTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$is_data_struct_type");
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  for (const dataType of dataTypeIdxs) {
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.test", typeIdx: dataType });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    });
  }
  body.push({ op: "i32.const", value: 0 });

  publishDataStructHostBridge(
    ctx,
    {
      name: "__is_data_struct",
      typeIdx: isDataTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as WasmFunction,
    DATA_STRUCT_HOST_BRIDGE_ORDINAL.isDataStruct,
  );
}

// (#4120) `fillStandaloneTypeofClosureArms` now lives in its own subsystem
// module (typeof-natives-finalize.ts). Re-exported here so `index.ts` — and any
// other caller — keeps its existing import path.
export { fillStandaloneTypeofClosureArms } from "./typeof-natives-finalize.js";
