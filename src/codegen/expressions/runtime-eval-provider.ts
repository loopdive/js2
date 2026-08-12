// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Standalone runtime-eval provider ABI and direct-eval caller bridge. */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { ensureAnyHelpers } from "../any-helpers.js";
import { emitCachedFuncClosureAccess } from "../closures.js";
import { emitBuiltinNamespaceObject } from "../builtin-static-globals.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  currentDirectEvalBindings,
  ensureDirectEvalActivationStatePoolLocal,
  emitEnsureDirectEvalActivationStatePoolInitialized,
} from "../direct-eval-environment.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import {
  emitGlobalEnvironmentKey,
  emitGlobalEnvironmentObject,
  emitRuntimeEvalSharedValueUnwrap,
  ensureGlobalEnvironmentOperation,
} from "../global-environment.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders } from "../object-runtime.js";
import { emitWasiErrorConstructor, isWasiErrorName } from "../registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag, localGlobalIdx, nextModuleGlobalIdx } from "../registry/imports.js";
import { addFuncType, getOrRegisterRefCellType } from "../registry/types.js";
import {
  emitRuntimeEvalAotCallableAdapter,
  emitRuntimeEvalInterpretedCallableAdapterIfCallable,
  ensureRuntimeEvalCallableWrapHelper,
  refreshRuntimeEvalCallableTrampolines,
  RUNTIME_EVAL_WRAP_CALLABLE,
} from "../runtime-eval-callable.js";
import { buildRuntimeEvalValueUnwrap, ensureRuntimeEvalProviderActiveGlobal } from "../runtime-eval-boundary.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/** Core-Wasm provider namespace owned by #2928/#2527. */
export const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

const RUNTIME_EVAL_PUSH_GLOBALS = "__runtime_eval_push_globals";
const RUNTIME_EVAL_PULL_GLOBALS = "__runtime_eval_pull_globals";
export const HOST_RUNTIME_EVAL_VEC_LEN = "__runtime_eval_vec_len";
export const HOST_RUNTIME_EVAL_VEC_GET = "__runtime_eval_vec_get";
export const HOST_RUNTIME_EVAL_CELL_GET = "__runtime_eval_cell_get";
export const HOST_RUNTIME_EVAL_CELL_SET = "__runtime_eval_cell_set";
export const HOST_RUNTIME_DIRECT_EVAL_IMPORT = "__extern_direct_eval";
/** Private global-object slot carrying `[name, EvalBindingCell, ...]`. The
 * provider reads the structurally canonical cells into ENV_GLOBAL.names/slots;
 * the slot itself is deliberately non-enumerable and non-configurable. */
export const RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY = "__js2wasm_runtime_eval_global_lexical_cells__";
/**
 * (#4308 slice C) One extra activation-seed entry emitted at every
 * FUNCTION-scoped direct-eval call site, so a provider can tell an activation
 * apart from the global environment record.
 *
 * It exists because the three binding layers alone cannot: a declaration-free
 * ARROW caller has no `arguments` and no locals, so it arrives with all three
 * empty — byte-identical to global code inside a block, which also reaches this
 * entry (`directEvalRunsAtScriptGlobal` stops at Block). A provider that guesses
 * "empty ⇒ global" puts the arrow's eval-created `var`s on the global object
 * instead of its varEnv, silently and with green tests. Costing one name/cell
 * pair per call site buys the distinction outright.
 *
 * It is a SIGNAL, not a binding: no source can reference it (the `__js2wasm`
 * prefix is reserved), and the QuickJS provider drops it before the snapshot.
 * Keep byte-for-byte aligned with `RUNTIME_EVAL_NON_GLOBAL_SENTINEL` in
 * scripts/quickjs-eval-provider.mjs.
 */
export const RUNTIME_EVAL_NON_GLOBAL_SENTINEL = "__js2wasm_eval_nonglobal__";

/**
 * Is this direct eval's call site inside a function (of any kind, arrows
 * included)? Purely syntactic — no checker query, so no oracle involvement.
 */
function directEvalCallerIsFunctionScoped(call: ts.CallExpression): boolean {
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isSourceFile(node)) return false;
    if (ts.isFunctionLike(node)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Export the narrow main-realm bridge needed by an isolated JS-host evaluator.
 *
 * The Worker never receives these WasmGC references. `buildImports` invokes the
 * four exports in the AOT module's host realm and exposes only opaque binding
 * ids/value handles to the evaluator. Dedicated exports keep the bridge alive
 * when the general host-inspection surface is disabled.
 */
function ensureReifiedHostEvalBridgeExports(ctx: CodegenContext, cellTypeIdx: number): void {
  const vecTypeIdx = ensureReifiedHostEvalVecType(ctx);
  const externref: ValType = { kind: "externref" };

  const register = (
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void => {
    if (ctx.funcMap.has(name)) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: true });
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  };

  register(
    HOST_RUNTIME_EVAL_VEC_LEN,
    [externref],
    [{ kind: "i32" }],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "array.len" },
    ],
  );
  register(
    HOST_RUNTIME_EVAL_VEC_GET,
    [externref, { kind: "i32" }],
    [externref],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "local.get", index: 1 },
      { op: "array.get", typeIdx: vecTypeIdx },
    ],
  );
  register(
    HOST_RUNTIME_EVAL_CELL_GET,
    [externref],
    [externref],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: cellTypeIdx },
      { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
    ],
  );
  register(
    HOST_RUNTIME_EVAL_CELL_SET,
    [externref, externref],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: cellTypeIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.set", typeIdx: cellTypeIdx, fieldIdx: 0 },
    ],
    [{ name: "__cell", type: { kind: "ref", typeIdx: cellTypeIdx } }],
  );
}

function ensureReifiedHostEvalVecType(ctx: CodegenContext): number {
  if (ctx.hostRuntimeEvalVecTypeIdx !== undefined) return ctx.hostRuntimeEvalVecTypeIdx;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$HostRuntimeEvalVec",
    element: { kind: "externref" },
    mutable: false,
  });
  ctx.hostRuntimeEvalVecTypeIdx = typeIdx;
  return typeIdx;
}
const RUNTIME_EVAL_GLOBAL_LEXICAL_CELL_GLOBAL_PREFIX = "\0runtime-eval-global-lexical-cell:";
const RUNTIME_EVAL_INTRINSIC_GLOBALS = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
];

function runtimeEvalGlobalBindingNames(ctx: CodegenContext): string[] {
  const names: string[] = [];
  const append = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  for (const name of ctx.globalObjectVarBindings ?? []) append(name);
  for (const name of ctx.topLevelFunctionNames) append(name);
  for (const name of RUNTIME_EVAL_INTRINSIC_GLOBALS) append(name);
  return names;
}

function runtimeEvalGlobalLexicalBindingNames(ctx: CodegenContext): string[] {
  return [...(ctx.globalLexicalBindings ?? [])];
}

function runtimeEvalGlobalLexicalCellGlobalKey(name: string): string {
  return RUNTIME_EVAL_GLOBAL_LEXICAL_CELL_GLOBAL_PREFIX + name;
}

function ensureRuntimeEvalGlobalLexicalCell(
  ctx: CodegenContext,
  name: string,
): { globalIdx: number; refCellTypeIdx: number } {
  const key = runtimeEvalGlobalLexicalCellGlobalKey(name);
  const existing = ctx.moduleGlobals.get(key);
  const refCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "externref" });
  if (existing !== undefined) return { globalIdx: existing, refCellTypeIdx };
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: `__runtime_eval_global_lexical_cell_${ctx.mod.globals.length}`,
    type: { kind: "ref_null", typeIdx: refCellTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: refCellTypeIdx }],
  });
  // Keep the private entry in moduleGlobals so the established late imported-
  // global fixup shifts it together with every source-level module global.
  ctx.moduleGlobals.set(key, globalIdx);
  return { globalIdx, refCellTypeIdx };
}

function runtimeEvalSyncFunctionContext(name: string): FunctionContext {
  return {
    name,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

function reserveRuntimeEvalGlobalBindingSync(ctx: CodegenContext): void {
  if (ctx.runtimeEvalGlobalSyncReserved) return;
  const typeIdx = addFuncType(ctx, [], [], "$runtime_eval_global_sync_type");
  for (const name of [RUNTIME_EVAL_PUSH_GLOBALS, RUNTIME_EVAL_PULL_GLOBALS]) {
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [],
      body: [],
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  }
  ctx.runtimeEvalGlobalSyncReserved = true;
  refreshRuntimeEvalCallableTrampolines(ctx);
}

function emitRuntimeEvalGlobalBindingPushBody(ctx: CodegenContext, fctx: FunctionContext): void {
  const names = runtimeEvalGlobalBindingNames(ctx);
  const lexicalNames = runtimeEvalGlobalLexicalBindingNames(ctx);
  if (names.length === 0 && lexicalNames.length === 0) return;
  if (lexicalNames.length > 0) {
    addStringConstantGlobal(ctx, RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY);
    for (const name of lexicalNames) addStringConstantGlobal(ctx, name);
    ensureObjVecBuilders(ctx);
  }
  const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
  const defineIdx = ensureLateImport(
    ctx,
    "__defineProperty_value",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined || emitGlobalEnvironmentObject(ctx, fctx) === null) return;
  const globalLocal = allocLocal(fctx, `__runtime_eval_global_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: globalLocal });

  if (lexicalNames.length > 0) {
    const cellsLocal = allocLocal(fctx, `__runtime_eval_global_lexical_cells_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! }, { op: "local.set", index: cellsLocal });
    for (const name of lexicalNames) {
      const { globalIdx: cellGlobalIdx, refCellTypeIdx } = ensureRuntimeEvalGlobalLexicalCell(ctx, name);
      const valueLocal = allocLocal(fctx, `__runtime_eval_global_lexical_value_${name}_${fctx.locals.length}`, {
        kind: "externref",
      });
      const sourceGlobalIdx = ctx.moduleGlobals.get(name);
      if (sourceGlobalIdx === undefined) {
        emitUndefined(ctx, fctx);
      } else {
        const sourceType = ctx.mod.globals[localGlobalIdx(ctx, sourceGlobalIdx)]?.type ?? { kind: "externref" };
        fctx.body.push({ op: "global.get", index: sourceGlobalIdx });
        if (sourceType.kind !== "externref") coerceType(ctx, fctx, sourceType, { kind: "externref" });
      }
      fctx.body.push(
        { op: "local.set", index: valueLocal },
        { op: "global.get", index: cellGlobalIdx },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: valueLocal },
            { op: "struct.new", typeIdx: refCellTypeIdx },
            { op: "global.set", index: cellGlobalIdx },
          ],
          else: [
            { op: "global.get", index: cellGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: valueLocal },
            { op: "struct.set", typeIdx: refCellTypeIdx, fieldIdx: 0 },
          ],
        },
        { op: "local.get", index: cellsLocal },
        ...stringConstantExternrefInstrs(ctx, name),
        { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
        { op: "local.get", index: cellsLocal },
        { op: "global.get", index: cellGlobalIdx },
        { op: "ref.as_non_null" },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
      );
    }
    fctx.body.push({ op: "local.get", index: globalLocal });
    emitGlobalEnvironmentKey(ctx, fctx, RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY);
    fctx.body.push(
      { op: "local.get", index: cellsLocal },
      // has-value + explicitly writable:true, enumerable:false,
      // configurable:false. Later pushes may replace only the carrier value.
      { op: "f64.const", value: 0xb9 },
      { op: "call", funcIdx: ctx.funcMap.get("__defineProperty_value") ?? defineIdx! },
      { op: "drop" },
    );
  }

  const wrapCallableIdx = ensureRuntimeEvalCallableWrapHelper(ctx);
  for (const name of names) {
    let valueType: ValType | null = null;
    let needsAotAdapter = false;
    let wrapGlobalName: string | undefined;
    if (ctx.topLevelFunctionNames.has(name)) {
      const liveGlobalIdx = ctx.liveFuncBindingGlobals?.has(name) ? ctx.moduleGlobals.get(name) : undefined;
      if (liveGlobalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: liveGlobalIdx });
        valueType = { kind: "externref" };
      } else {
        const declaration = ctx.topLevelFunctionDeclarations.get(name);
        const funcIdx = ctx.funcMap.get(name);
        if (declaration && funcIdx !== undefined) {
          const isOrdinary =
            declaration.asteriskToken === undefined &&
            !(declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
          valueType = emitCachedFuncClosureAccess(ctx, fctx, name, funcIdx, isOrdinary);
          needsAotAdapter = true;
        }
      }
    } else {
      const globalIdx = ctx.moduleGlobals.get(name);
      if (globalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: globalIdx });
        valueType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type ?? { kind: "externref" };
        // (#4307) `var f = function () {…}` at script scope is a plain module
        // global, not a `topLevelFunctionNames` declaration, so the AOT-callable
        // adapter above never ran for it and the closure crossed raw. Wrap it
        // and write the carrier BACK into the global: a per-push wrap would mint
        // a fresh carrier on every provider entry and break `f === f` across two
        // evaluations, exactly the way a live function binding avoids by holding
        // its carrier in the module global permanently (declarations.ts, #2928).
        // Externref-typed globals only — a typed closure global would reject the
        // store, and its AOT reads are static enough not to need the carrier.
        if (valueType.kind === "externref") wrapGlobalName = name;
      } else if (RUNTIME_EVAL_INTRINSIC_GLOBALS.includes(name)) {
        // Provider-originated native Error payloads cross as externrefs. Give
        // this module the structurally canonical `$Error_struct` and register
        // each ctor as an emitted family member even when AOT never constructs
        // one itself. `fillExternGetErrorProps` uses that membership to add the
        // dynamic `name`/`message`/`constructor` arms, so
        // `assert.throws(Expected, callback)` observes the caller's canonical
        // constructor identity after the exception-tag bridge rethrows here.
        if (isWasiErrorName(name)) emitWasiErrorConstructor(ctx, name, 1);
        // The runtime provider is a separate zero-import module, so its own
        // lazily reified Error constructor carrier is not identity-equal to
        // the caller realm's carrier. Seed the caller's canonical singleton
        // onto the shared global object before eval/new Function enters the
        // provider. First-class reads such as `assert.throws(ReferenceError,
        // fn)` then preserve constructor identity across the module seam.
        valueType = emitBuiltinNamespaceObject(ctx, fctx, name);
      }
    }
    if (valueType === null) continue;
    if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });
    if (needsAotAdapter) emitRuntimeEvalAotCallableAdapter(ctx, fctx);
    const liveWrapGlobalIdx = wrapGlobalName === undefined ? undefined : ctx.moduleGlobals.get(wrapGlobalName);
    if (liveWrapGlobalIdx !== undefined) {
      fctx.body.push(
        { op: "call", funcIdx: ctx.funcMap.get(RUNTIME_EVAL_WRAP_CALLABLE) ?? wrapCallableIdx },
        { op: "global.set", index: liveWrapGlobalIdx },
        { op: "global.get", index: liveWrapGlobalIdx },
      );
    }
    const valueLocal = allocLocal(fctx, `__runtime_eval_global_${name}_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: valueLocal }, { op: "local.get", index: globalLocal });
    emitGlobalEnvironmentKey(ctx, fctx, name);
    fctx.body.push({ op: "local.get", index: valueLocal });
    const isScriptBinding = (ctx.globalObjectVarBindings?.has(name) ?? false) || ctx.topLevelFunctionNames.has(name);
    const liveDefineIdx = ctx.funcMap.get("__defineProperty_value") ?? defineIdx;
    if (liveDefineIdx !== undefined) {
      // ScriptDeclarationInstantiation creates top-level var/function bindings
      // as writable+enumerable but non-configurable. Intrinsic constructors are
      // writable+non-enumerable+configurable. The has-value bit updates the
      // current value on later entries, while leaving the "specified" bits
      // clear preserves any existing attributes.
      // Script bindings also specify configurable:false. The compiler may have
      // already mirrored the module global through an ordinary set before the
      // first eval entry; making this transition explicit repairs that
      // synthetic configurable property to the descriptor ScriptDeclaration-
      // Instantiation created conceptually. Writable/enumerable stay
      // unspecified on updates so user changes to those attributes survive.
      const attributes = isScriptBinding ? 0x23 : 0x05;
      fctx.body.push(
        { op: "f64.const", value: 0x80 | attributes },
        { op: "call", funcIdx: liveDefineIdx },
        { op: "drop" },
      );
    } else {
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? setIdx });
    }
  }
}

function emitRuntimeEvalGlobalBindingPullBody(ctx: CodegenContext, fctx: FunctionContext): void {
  const names = runtimeEvalGlobalBindingNames(ctx).filter((name) => ctx.moduleGlobals.has(name));
  const lexicalNames = runtimeEvalGlobalLexicalBindingNames(ctx).filter((name) => ctx.moduleGlobals.has(name));
  if (names.length === 0 && lexicalNames.length === 0) return;
  for (const name of lexicalNames) {
    const sourceGlobalIdx = ctx.moduleGlobals.get(name);
    if (sourceGlobalIdx === undefined) continue;
    const { globalIdx: cellGlobalIdx, refCellTypeIdx } = ensureRuntimeEvalGlobalLexicalCell(ctx, name);
    const sourceType = ctx.mod.globals[localGlobalIdx(ctx, sourceGlobalIdx)]?.type ?? { kind: "externref" };
    fctx.body.push(
      { op: "global.get", index: cellGlobalIdx },
      // Every runtime call executes the push helper first, which lazily
      // materializes this persistent cell. A null here is therefore an ABI
      // invariant violation and should trap rather than silently lose a write.
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: refCellTypeIdx, fieldIdx: 0 },
    );
    emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
    emitRuntimeEvalInterpretedCallableAdapterIfCallable(ctx, fctx);
    if (sourceType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, sourceType);
    fctx.body.push({ op: "global.set", index: sourceGlobalIdx });
  }
  if (names.length === 0) return;
  const getIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_get");
  if (getIdx === undefined || emitGlobalEnvironmentObject(ctx, fctx) === null) return;
  const globalLocal = allocLocal(fctx, `__runtime_eval_global_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: globalLocal });
  for (const name of names) {
    const globalIdx = ctx.moduleGlobals.get(name);
    if (globalIdx === undefined) continue;
    const globalType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type ?? { kind: "externref" };
    fctx.body.push({ op: "local.get", index: globalLocal });
    emitGlobalEnvironmentKey(ctx, fctx, name);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? getIdx });
    emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
    // Eval may assign an interpreted function to any existing script-global
    // binding, including a `var` whose initial value was not callable. Adapt
    // by the runtime carrier shape rather than by the declaration's static
    // kind; ordinary values and caller-owned AOT carriers pass through
    // byte-for-byte.
    emitRuntimeEvalInterpretedCallableAdapterIfCallable(ctx, fctx);
    if (globalType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, globalType);
    fctx.body.push({ op: "global.set", index: ctx.moduleGlobals.get(name) ?? globalIdx });
  }
}

function ensureRuntimeEvalGlobalBindingSync(ctx: CodegenContext): void {
  reserveRuntimeEvalGlobalBindingSync(ctx);
  if (ctx.runtimeEvalGlobalSyncFilled) return;
  const pushFctx = runtimeEvalSyncFunctionContext(RUNTIME_EVAL_PUSH_GLOBALS);
  emitRuntimeEvalGlobalBindingPushBody(ctx, pushFctx);
  const pullFctx = runtimeEvalSyncFunctionContext(RUNTIME_EVAL_PULL_GLOBALS);
  emitRuntimeEvalGlobalBindingPullBody(ctx, pullFctx);
  const pushFn = definedFuncAt(ctx, ctx.funcMap.get(RUNTIME_EVAL_PUSH_GLOBALS)!);
  const pullFn = definedFuncAt(ctx, ctx.funcMap.get(RUNTIME_EVAL_PULL_GLOBALS)!);
  if (pushFn) {
    pushFn.locals = pushFctx.locals;
    pushFn.body = pushFctx.body;
  }
  if (pullFn) {
    pullFn.locals = pullFctx.locals;
    pullFn.body = pullFctx.body;
  }
  ctx.runtimeEvalGlobalSyncFilled = true;
  refreshRuntimeEvalCallableTrampolines(ctx);
}

/** Materialize source-level script var/function bindings on the native realm
 * object before interpreted global code runs. The AOT compiler normally keeps
 * these values in Wasm locals/globals, while indirect eval and Function bodies
 * correctly resolve them through GlobalEnvironmentRecord. Seeding the shared
 * object closes the AOT→interpreter visibility half without exposing compiler
 * helper globals or requiring a second provider-side callable ABI. */
export function emitRuntimeEvalGlobalBindingSeed(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone) return;
  ensureRuntimeEvalGlobalBindingSync(ctx);
  const pushIdx = ctx.funcMap.get(RUNTIME_EVAL_PUSH_GLOBALS);
  if (pushIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pushIdx });
  emitRuntimeEvalProviderActive(ctx, fctx, true);
}

/** Mark whether carrier calls are executing across the provider boundary. */
export function emitRuntimeEvalProviderActive(ctx: CodegenContext, fctx: FunctionContext, active: boolean): void {
  const globalIdx = ensureRuntimeEvalProviderActiveGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: active ? 1 : 0 }, { op: "global.set", index: globalIdx });
}

/**
 * Unwrap the provider's `[ok, value]` result vector. A provider-side throw uses
 * that vector because Wasm exception tags are module instances, not
 * structurally canonical values: throwing the provider's private tag directly
 * cannot be caught by the user module. Re-throwing `value` through the caller's
 * own tag restores ordinary AOT try/catch behavior. The vector is intentional:
 * unlike a source-inferred plain object, the canonical externref vec carrier is
 * structurally shared by both modules.
 */
export function emitRuntimeEvalResultUnwrap(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const envelopeLocal = allocLocal(fctx, `__runtime_eval_result_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: envelopeLocal });
  ensureRuntimeEvalGlobalBindingSync(ctx);
  const pullIdx = ctx.funcMap.get(RUNTIME_EVAL_PULL_GLOBALS);
  if (pullIdx !== undefined) fctx.body.push({ op: "call", funcIdx: pullIdx });
  emitRuntimeEvalProviderActive(ctx, fctx, false);

  const externref: ValType = { kind: "externref" };
  const getIdx = ensureLateImport(ctx, "__extern_get_idx", [externref, { kind: "f64" }], [externref]);
  const truthyIdx = ensureLateImport(ctx, "__is_truthy", [externref], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const liveGetIdx = ctx.funcMap.get("__extern_get_idx") ?? getIdx;
  const liveTruthyIdx = ctx.funcMap.get("__is_truthy") ?? truthyIdx;
  if (liveGetIdx === undefined || liveTruthyIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return externref;
  }

  // Primitive boxes belong to the module that created them. Decode the
  // provider's canonical value before branching so BOTH successful values and
  // thrown payloads cross as caller-local representations.
  ensureAnyHelpers(ctx);
  const getField = (index: 0 | 1 | 2): Instr[] => [
    { op: "local.get", index: envelopeLocal },
    { op: "f64.const", value: index },
    { op: "call", funcIdx: liveGetIdx },
  ];
  fctx.body.push(...getField(1), ...buildRuntimeEvalValueUnwrap(ctx, fctx.locals, fctx.params.length));
  const decodedLocal = allocLocal(fctx, `__runtime_eval_decoded_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: decodedLocal });

  fctx.body.push(...getField(0), { op: "call", funcIdx: liveTruthyIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: externref },
    then: [{ op: "local.get", index: decodedLocal }],
    else: [
      { op: "local.get", index: decodedLocal },
      { op: "throw", tagIdx: ensureExnTag(ctx) },
    ],
  });
  return externref;
}

/**
 * (#4307) Carrier-wrap a direct-eval binding cell IN PLACE when its current
 * value is a raw module-local closure.
 *
 * In-place rather than wrapping a copy, for two reasons: the cell IS the
 * interpreter's write-back target, so a copy would silently drop assignments
 * made inside the evaluated source; and the carrier is itself AOT-callable
 * (`__apply_closure`'s #2928 arm, `__call_fn_method_N`'s #4197 front-guard, and
 * `emitRuntimeEvalCarrierUnwrapAny` on the static closure-call fast path), so
 * the compiled side keeps calling the binding normally afterwards. The helper
 * is a no-op for every non-closure value AND for a value that is already a
 * carrier, which is what keeps reference identity stable across evaluations.
 */
function directEvalCellWrapInstrs(
  ctx: CodegenContext,
  cellLocal: number,
  cellTypeIdx: number,
  wrapCallableIdx: number,
): Instr[] {
  // A cell local can legitimately still be null here (`arguments` in a function
  // that never materialized it), so the null test is required — a bare
  // `ref.as_non_null` traps on that path.
  return [
    { op: "local.get", index: cellLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cellLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: cellLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
        { op: "call", funcIdx: ctx.funcMap.get(RUNTIME_EVAL_WRAP_CALLABLE) ?? wrapCallableIdx },
        { op: "struct.set", typeIdx: cellTypeIdx, fieldIdx: 0 },
      ],
    },
  ];
}

/**
 * Direct eval route. The caller supplies three name/cell vector
 * pairs: a persistent current-activation environment, fresh call-site lexical
 * shadows, and captured outer bindings. Standalone links those records into
 * its runtime provider. The opt-in JS-host lane sends the same canonical cells
 * to a main-realm bridge; an isolated evaluator sees only opaque binding ids.
 */
export function emitStandaloneDirectEvalRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): ValType | undefined {
  const reifiedHost = !ctx.standalone && ctx.directEvalMode === "reified-host";
  if (!ctx.standalone && !reifiedHost) return undefined;
  const args = call.arguments;
  if (args.length === 0) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  const callerStrict = isStrictContext(call, ctx.inferModuleStrictArguments);
  const externref: ValType = { kind: "externref" };
  if (!callerStrict && !reifiedHost) {
    ensureLateImport(ctx, "__extern_is_undefined", [externref], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
  }
  emitRuntimeEvalGlobalBindingSeed(ctx, fctx);

  // Register the builders before emitting argument expressions: doing so can
  // mint functions, and keeping that mutation ahead of the call operands makes
  // late-index repair straightforward.
  const hostVecTypeIdx = reifiedHost ? ensureReifiedHostEvalVecType(ctx) : undefined;
  if (!reifiedHost) ensureObjVecBuilders(ctx);
  const bindings = currentDirectEvalBindings(ctx, fctx);
  for (const layer of [bindings.activation, bindings.lexical, bindings.outer]) {
    for (const binding of layer) addStringConstantGlobal(ctx, binding.name);
  }
  const functionScopedCaller = directEvalCallerIsFunctionScoped(call);
  if (functionScopedCaller && !reifiedHost) addStringConstantGlobal(ctx, RUNTIME_EVAL_NON_GLOBAL_SENTINEL);

  const sourceLocal = allocLocal(fctx, `__runtime_direct_eval_source_${fctx.locals.length}`, externref);
  const sourceType = compileExpression(ctx, fctx, args[0]!);
  if (sourceType === null) {
    emitUndefined(ctx, fctx);
  } else if (sourceType.kind !== "externref") {
    coerceType(ctx, fctx, sourceType, externref);
  }
  fctx.body.push({ op: "local.set", index: sourceLocal });
  for (let i = 1; i < args.length; i++) {
    const extraType = compileExpression(ctx, fctx, args[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }

  // Argument compilation may add late imports and shift defined function
  // indices. funcMap is the authoritative post-shift lookup.
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;

  const wrapCallableIdx = reifiedHost ? undefined : ensureRuntimeEvalCallableWrapHelper(ctx);
  const bindingPushInstrs = (namesLocal: number, slotsLocal: number, layer: typeof bindings.activation): Instr[] => {
    const instrs: Instr[] = [];
    const cellTypeIdx = fctx.directEvalRefCellTypeIdx;
    for (const binding of layer) {
      if (cellTypeIdx !== undefined && wrapCallableIdx !== undefined) {
        instrs.push(...directEvalCellWrapInstrs(ctx, binding.cellLocal, cellTypeIdx, wrapCallableIdx));
      }
      instrs.push(
        { op: "local.get", index: namesLocal },
        ...stringConstantExternrefInstrs(ctx, binding.name),
        { op: "call", funcIdx: objVecPushIdx },
        { op: "local.get", index: slotsLocal },
        { op: "local.get", index: binding.cellLocal },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: objVecPushIdx },
      );
    }
    return instrs;
  };

  const freshLayer = (label: string, layer: typeof bindings.activation): [number, number] => {
    const namesLocal = allocLocal(fctx, `__runtime_direct_eval_${label}_names_${fctx.locals.length}`, externref);
    const slotsLocal = allocLocal(fctx, `__runtime_direct_eval_${label}_slots_${fctx.locals.length}`, externref);
    if (hostVecTypeIdx !== undefined) {
      for (const binding of layer) fctx.body.push(...stringConstantExternrefInstrs(ctx, binding.name));
      fctx.body.push(
        { op: "array.new_fixed", typeIdx: hostVecTypeIdx, length: layer.length },
        { op: "extern.convert_any" },
        { op: "local.set", index: namesLocal },
      );
      for (const binding of layer) {
        fctx.body.push({ op: "local.get", index: binding.cellLocal }, { op: "extern.convert_any" });
      }
      fctx.body.push(
        { op: "array.new_fixed", typeIdx: hostVecTypeIdx, length: layer.length },
        { op: "extern.convert_any" },
        { op: "local.set", index: slotsLocal },
      );
      return [namesLocal, slotsLocal];
    }
    fctx.body.push(
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: namesLocal },
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: slotsLocal },
      ...bindingPushInstrs(namesLocal, slotsLocal, layer),
    );
    return [namesLocal, slotsLocal];
  };
  const state = reifiedHost
    ? ensureDirectEvalActivationStatePoolLocal(ctx, fctx)
    : emitEnsureDirectEvalActivationStatePoolInitialized(ctx, fctx);
  const stateCellTypeIdx = state.cellTypeIdx;
  fctx.directEvalRefCellTypeIdx = stateCellTypeIdx;
  const activationStatePoolLocal = state.poolLocal;
  if (reifiedHost) {
    // Eval-created declaration persistence is a provider-owned concern. The
    // first host slice bridges existing canonical caller cells only, so avoid
    // allocating standalone's provider-owned state pool in every AOT activation.
    fctx.body.push({ op: "ref.null.extern" }, { op: "local.set", index: activationStatePoolLocal });
  }
  const [activationNamesLocal, activationSlotsLocal] = freshLayer("activation_seed", bindings.activation);
  // (#4308 slice C) The caller-kind sentinel. Its cell is FRESH rather than
  // borrowed from the state pool: nothing writes the sentinel binding, but a
  // shared cell would make that assumption load-bearing for the pool's own
  // name/value pairs.
  if (functionScopedCaller && !reifiedHost) {
    fctx.body.push(
      { op: "local.get", index: activationNamesLocal },
      ...stringConstantExternrefInstrs(ctx, RUNTIME_EVAL_NON_GLOBAL_SENTINEL),
      { op: "call", funcIdx: objVecPushIdx },
      { op: "local.get", index: activationSlotsLocal },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: stateCellTypeIdx },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: objVecPushIdx },
    );
  }
  const [lexicalNamesLocal, lexicalSlotsLocal] = freshLayer("lexical", bindings.lexical);
  const [outerNamesLocal, outerSlotsLocal] = freshLayer("outer", bindings.outer);

  // Preserve the compiler's mapped-arguments decision at the interpreter
  // boundary. Each vector index corresponds to arguments[index] and carries
  // the canonical parameter binding name, or null when that index is
  // unmapped. Keep one vector local alive for the whole AOT activation: the
  // interpreter nulls entries after delete/defineProperty, and later eval/AOT
  // writes must observe that severed state instead of rebuilding the map.
  const mappedParamNamesLocal = allocLocal(
    fctx,
    `__runtime_direct_eval_mapped_param_names_${fctx.locals.length}`,
    externref,
  );
  const mappedArgsInfo = fctx.mappedArgsInfo;
  if (reifiedHost) {
    fctx.body.push({ op: "ref.null.extern" }, { op: "local.set", index: mappedParamNamesLocal });
  } else if (mappedArgsInfo) {
    if (mappedArgsInfo.runtimeMappedNamesLocalIdx === undefined) {
      mappedArgsInfo.runtimeMappedNamesLocalIdx = allocLocal(
        fctx,
        `__runtime_direct_eval_mapped_param_state_${fctx.locals.length}`,
        externref,
      );
    }
    const persistentMapLocal = mappedArgsInfo.runtimeMappedNamesLocalIdx;
    const initializeMap: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: persistentMapLocal },
    ];
    for (let i = 0; i < mappedArgsInfo.paramCount; i += 1) {
      const paramName = fctx.params[mappedArgsInfo.paramOffset + i]?.name;
      let duplicateLater = false;
      if (paramName !== undefined) {
        for (let j = i + 1; j < mappedArgsInfo.paramCount; j += 1) {
          if (fctx.params[mappedArgsInfo.paramOffset + j]?.name === paramName) {
            duplicateLater = true;
            break;
          }
        }
      }
      const isMapped = paramName !== undefined && !duplicateLater && !mappedArgsInfo.unmappedIndices?.has(i);
      initializeMap.push({ op: "local.get", index: persistentMapLocal });
      if (isMapped) {
        addStringConstantGlobal(ctx, paramName);
        initializeMap.push(
          { op: "local.get", index: mappedArgsInfo.argsLocalIdx },
          { op: "struct.get", typeIdx: mappedArgsInfo.vecTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: i },
          { op: "i32.gt_s" },
          {
            op: "if",
            blockType: { kind: "val", type: externref },
            then: stringConstantExternrefInstrs(ctx, paramName),
            else: [{ op: "ref.null.extern" }],
          },
        );
      } else {
        initializeMap.push({ op: "ref.null.extern" });
      }
      initializeMap.push({ op: "call", funcIdx: objVecPushIdx });
    }
    fctx.body.push(
      { op: "local.get", index: persistentMapLocal },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: initializeMap, else: [] },
      { op: "local.get", index: persistentMapLocal },
      { op: "local.set", index: mappedParamNamesLocal },
    );
  } else {
    fctx.body.push({ op: "call", funcIdx: objVecNewIdx }, { op: "local.set", index: mappedParamNamesLocal });
  }

  fctx.body.push({ op: "local.get", index: sourceLocal });
  if (reifiedHost) {
    // The isolated evaluator owns its global object, and host values need a
    // separate reverse membrane. Keep both ABI positions explicit without
    // constructing standalone's native global-object/callable substrate.
    fctx.body.push({ op: "ref.null.extern" }, { op: "ref.null.extern" });
  } else {
    if (emitGlobalEnvironmentObject(ctx, fctx) === null) fctx.body.push({ op: "ref.null.extern" });
    const globalLocal = allocLocal(fctx, `__runtime_direct_eval_global_${fctx.locals.length}`, externref);
    fctx.body.push({ op: "local.tee", index: globalLocal });
    const thisType = compileExpression(ctx, fctx, ts.factory.createThis());
    if (thisType === null) {
      emitUndefined(ctx, fctx);
    } else if (thisType.kind !== "externref") {
      coerceType(ctx, fctx, thisType, externref);
    }
    if (!callerStrict) {
      const thisLocal = allocLocal(fctx, `__runtime_direct_eval_this_${fctx.locals.length}`, externref);
      const liveIsUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
      fctx.body.push(
        { op: "local.set", index: thisLocal },
        { op: "local.get", index: thisLocal },
        { op: "ref.is_null" },
      );
      if (liveIsUndefinedIdx !== undefined) {
        fctx.body.push(
          { op: "local.get", index: thisLocal },
          { op: "call", funcIdx: liveIsUndefinedIdx },
          { op: "i32.or" },
        );
      }
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "local.get", index: globalLocal }],
        else: [{ op: "local.get", index: thisLocal }],
      });
    }
  }
  fctx.body.push(
    { op: "local.get", index: activationStatePoolLocal },
    { op: "local.get", index: activationNamesLocal },
    { op: "local.get", index: activationSlotsLocal },
    { op: "local.get", index: lexicalNamesLocal },
    { op: "local.get", index: lexicalSlotsLocal },
    { op: "local.get", index: outerNamesLocal },
    { op: "local.get", index: outerSlotsLocal },
    { op: "i32.const", value: callerStrict ? 1 : 0 },
    { op: "local.get", index: mappedParamNamesLocal },
  );

  if (reifiedHost) ensureReifiedHostEvalBridgeExports(ctx, stateCellTypeIdx);
  const importName = reifiedHost ? HOST_RUNTIME_DIRECT_EVAL_IMPORT : "__runtime_direct_eval";
  const evalIdx = ensureLateImport(
    ctx,
    importName,
    [
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      externref,
      { kind: "i32" },
      externref,
    ],
    [externref],
    reifiedHost ? "env" : RUNTIME_EVAL_IMPORT_MODULE,
  );
  flushLateImportShifts(ctx, fctx);
  if (evalIdx === undefined) {
    fctx.body.push(
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "ref.null.extern" },
    );
    if (!reifiedHost) emitRuntimeEvalProviderActive(ctx, fctx, false);
    return externref;
  }
  const liveIdx = ctx.funcMap.get(importName) ?? evalIdx;
  fctx.body.push({ op: "call", funcIdx: liveIdx });
  if (reifiedHost) return externref;
  return emitRuntimeEvalResultUnwrap(ctx, fctx);
}

/**
 * (#4195) The user-facing wording for a dynamic-eval call that cannot be
 * served, chosen by the condition that actually applies.
 *
 * `--standalone` is the ONE no-JS-host target that supports dynamic eval — the
 * gate is `if (!ctx.standalone) return undefined` in this module, so a
 * standalone build emits the `js2wasm:runtime-eval` imports and never reaches
 * the refusal. Until this issue the refusal read "not supported in --target
 * standalone/wasi", which named the working flag as broken and sent at least
 * one user looking for a new release instead of a different target.
 *
 * `noJsHost()` is `wasi || standalone`, so the refusal IS reachable under
 * standalone — but only on a genuine provider-materialization failure, which
 * is a different condition and gets its own wording.
 */
export function dynamicEvalRefusalMessages(ctx: CodegenContext): { warning: string; thrown: string } {
  if (ctx.wasi) {
    return {
      warning:
        "Warning: dynamic eval is not supported by --target wasi — WASI has no " +
        "runtime-eval host to import, so this eval call throws at runtime. " +
        "Recompile with --standalone to emit the js2wasm:runtime-eval provider " +
        "imports instead, if your embedder can supply them " +
        "(tracking: runtime-eval goal, bytecode interpreter #2928)",
      thrown: "dynamic eval is not supported by --target wasi (#2928)",
    };
  }
  return {
    warning:
      "Warning: could not materialize the js2wasm:runtime-eval provider ABI for this " +
      "dynamic eval call, so it throws at runtime. --standalone normally supports " +
      "dynamic eval; reaching this path means the provider route bailed for this " +
      "call site (tracking: runtime-eval goal, bytecode interpreter #2928)",
    thrown: "dynamic eval provider ABI unavailable for this call site (#2928)",
  };
}
