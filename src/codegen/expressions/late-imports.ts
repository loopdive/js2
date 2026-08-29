// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Late import management and undefined emission utilities.
 *
 * Provides helpers for adding imports after compilation has started
 * (late imports), shifting function indices when imports are added,
 * and emitting the JS `undefined` value.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { reportErrorNoNode } from "../context/errors.js";
import { addImport } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";
import { addUnionImportsViaRegistry } from "../shared.js";
import { emitUndefinedExtern } from "../any-helpers.js";
import { ensureObjectRuntime, OBJECT_RUNTIME_HELPER_NAMES } from "../object-runtime.js";
import { ensureSymbolCarrier, usesNativeSymbolProvider } from "../symbol-native.js";
// (#3100 S4) Native standalone iteration substrate: the four `__iterator*`
// protocol ops, the bounded materializer `__array_from_iter_n`, and the
// rest-slice `__extern_slice` all have Wasm-native DEFINED implementations.
import {
  ensureNativeArrayFromIterN,
  ensureNativeExternSlice,
  ensureNativeIteratorRuntime,
} from "../iterator-native.js";
import { shiftAsyncSideChannelFuncIdxs } from "../async-scheduler.js";
import { inLiveShiftRange } from "../../emit/resolve-layout.js";
import { emitWasiErrorConstructor, isWasiErrorName } from "../registry/error-types.js";

/**
 * #1471: helper names that `addUnionImports` provides Wasm-native
 * implementations for under no-JS-host mode (WASI / standalone). When any of
 * these is requested via `ensureLateImport` while there is no JS host, route
 * through `addUnionImports` (which emits in-module funcs registered in
 * `ctx.funcMap`) instead of adding an unsatisfiable `env::*` host import.
 */
const UNION_NATIVE_HELPER_NAMES = new Set([
  "__box_number",
  "__unbox_number",
  "__box_boolean",
  "__unbox_boolean",
  "__is_truthy",
  "__typeof_number",
  "__typeof_boolean",
  "__typeof_string",
  "__typeof_undefined",
  "__typeof_object",
  "__typeof_function",
  "__typeof",
  // #2508 — native Strict Equality / SameValueZero over boxed externrefs, so
  // standalone `any[].indexOf/lastIndexOf/includes` need no JS host import.
  // Synthesised by addUnionImportsAsNativeFuncs alongside the typeof/unbox set.
  "__host_eq",
  "__same_value_zero",
]);

/**
 * #1472 Phase A — open-object / dynamic-shape property operations have no
 * Wasm-native runtime yet (that's Phase B). Under `--target standalone` there
 * is no JS host to satisfy these imports, so instead of leaking an
 * `env::__extern_*` / `env::__object_*` import that fails at instantiation with
 * an opaque "unknown import" linker error, we refuse at compile time with a
 * message that points the user at the supported fast path (typed object
 * literals / class instances compile to `struct.get`/`struct.set` with zero
 * host calls) and at the follow-up issue.
 *
 * Closed-shape struct access never reaches this gate — it emits struct ops
 * directly and never calls ensureLateImport for these names.
 */
const STANDALONE_REFUSED_IMPORT = (name: string): boolean =>
  name.startsWith("__extern_") ||
  name.startsWith("__object_") ||
  name.startsWith("__for_in_") ||
  name.startsWith("__defineProperty") ||
  name.startsWith("__defineProperties") ||
  name.startsWith("__getOwn") ||
  name.startsWith("__getPrototypeOf") ||
  name.startsWith("__proto_method_call") ||
  name.startsWith("__get_builtin") ||
  name.startsWith("__register_prototype") ||
  name.startsWith("__register_class_object") ||
  name.startsWith("__proxy_") ||
  name === "__new_plain_object" ||
  name === "__delete_property" ||
  name === "__hasOwnProperty" ||
  name === "__propertyIsEnumerable" ||
  name === "__isPrototypeOf" ||
  name === "__object_hasOwn";

/**
 * Emit the #1472 Phase A standalone refusal for a dynamic-shape object/property
 * operation, deduplicated per import name so a single source construct doesn't
 * spam the error list. Returns true if the import was refused (caller should
 * still proceed so codegen doesn't crash; the queued error — prefixed with
 * "Codegen error:" — forces `success: false` and an empty module in
 * compiler.ts).
 */
function refuseStandaloneObjectImport(ctx: CodegenContext, name: string): boolean {
  if (!ctx.standalone || !STANDALONE_REFUSED_IMPORT(name)) return false;
  if (!ctx.standaloneRefusedImports) ctx.standaloneRefusedImports = new Set<string>();
  if (ctx.standaloneRefusedImports.has(name)) return true;
  ctx.standaloneRefusedImports.add(name);
  // Prefix with "Codegen error:" so compiler.ts treats this as a hard failure
  // (success: false, empty module) rather than a warning that leaves a
  // half-working module with a leaked host import (#1472 acceptance criteria:
  // "no silent fall-back to a half-working runtime").
  reportErrorNoNode(
    ctx,
    `Codegen error: '${name}' (dynamic-shape object/property operation) is not ` +
      `yet supported in --target standalone (#1472 Phase B). Use a typed object ` +
      `literal or class instance for fast-path codegen, which compiles to ` +
      `struct.get/struct.set with no JS host imports.`,
  );
  return true;
}

/**
 * #1806 Phase 0 — the abstract operation ToPrimitive (§7.1.1) is dispatched to
 * the JS-host `env::__to_primitive` import for objects with a dynamic
 * `[Symbol.toPrimitive]` / `valueOf` / `toString` (see
 * `toPrimitiveHostCallInstrs` in type-coercion.ts). In `--target standalone`
 * there is no JS host, so leaking this import either fails at instantiation
 * with an opaque "module is not an object or function" linker error
 * (runtime_error), or the JS-host runtime path throws the bare
 * "Cannot convert object to primitive value" with no tracking cite — the
 * 2,136-test #1806 failure cluster.
 *
 * Until a Wasm-native numeric/string-hint ToPrimitive over the `$Object`
 * struct lands (#1806 Phase 1), refuse the import at compile time with a clear,
 * trackable message. This converts the whole cluster (839 CE + 1,297 runtime)
 * into compile errors that all cite #1806. Crucially the message does NOT begin
 * with "Cannot " / "Invalid ", so the test262 classifier buckets it as a
 * compile_error rather than a stray runtime_error.
 *
 * Deduplicated per import name via the shared `standaloneRefusedImports` set so
 * a single source construct queues at most one error. Returns true if refused.
 */
function refuseStandaloneToPrimitive(ctx: CodegenContext, name: string): boolean {
  if (!ctx.standalone || name !== "__to_primitive") return false;
  if (!ctx.standaloneRefusedImports) ctx.standaloneRefusedImports = new Set<string>();
  if (ctx.standaloneRefusedImports.has(name)) return true;
  ctx.standaloneRefusedImports.add(name);
  reportErrorNoNode(
    ctx,
    `Codegen error: __toPrimitive (Symbol.toPrimitive / valueOf coercion) is not ` +
      `yet supported in standalone mode (#1806). A Wasm-native numeric/string-hint ` +
      `ToPrimitive over the $Object struct is Phase 1 of #1806.`,
  );
  return true;
}

/**
 * Shift function indices after a late import addition. This must update all
 * already-compiled function bodies, the current function body, any saved bodies
 * from the savedBody swap pattern, and export descriptors.
 */
export function shiftLateImportIndices(
  ctx: CodegenContext,
  fctx: FunctionContext | null,
  importsBefore: number,
  added: number,
): void {
  if (added <= 0) return;
  // Track ALL instruction arrays (top-level AND nested) to prevent
  // double-shifting. When fctx.body is a nested block (e.g., a then-array)
  // that is also reachable from a savedBody via recursive walk, we must
  // ensure it is only shifted once (#1109).
  const shifted = new Set<Instr[]>();
  function shiftInstrs(instrs: Instr[]): void {
    if (shifted.has(instrs)) return;
    shifted.add(instrs);
    for (const instr of instrs) {
      if ("funcIdx" in instr && typeof (instr as any).funcIdx === "number") {
        if (inLiveShiftRange((instr as any).funcIdx, importsBefore)) {
          (instr as any).funcIdx += added;
        }
      }
      const a = instr as any;
      if (a.body && Array.isArray(a.body)) shiftInstrs(a.body);
      if (a.then && Array.isArray(a.then)) shiftInstrs(a.then);
      if (a.else && Array.isArray(a.else)) shiftInstrs(a.else);
      if (a.catches && Array.isArray(a.catches)) {
        for (const c of a.catches) {
          if (Array.isArray(c.body)) shiftInstrs(c.body);
        }
      }
      if (a.catchAll && Array.isArray(a.catchAll)) shiftInstrs(a.catchAll);
    }
  }
  for (const func of ctx.mod.functions) {
    shiftInstrs(func.body);
  }
  // fctx may be null for fctx-less flushes (#2039: flushing a pending batch
  // before native defined-function registration). ctx.currentFunc / funcStack /
  // liveBodies / parentBodiesStack below provide the same coverage addUnionImports
  // has always relied on for its own fctx-less internal shift.
  if (fctx) {
    shiftInstrs(fctx.body);
    for (const sb of fctx.savedBodies) {
      shiftInstrs(sb);
    }
  }
  // (#1384) Walk ctx.currentFunc.body too. When fctx ≠ ctx.currentFunc — which
  // happens during compileArrowAsCallback's param-coercion phase (closures.ts
  // line 2470) where fctx=cbFctx but ctx.currentFunc=outer-fctx — the outer
  // function's body would otherwise be missed (it's not yet reachable via
  // funcStack because the savedFunc swap hasn't happened, and `func.body =
  // fctx.body` in compileFunctionBody only runs AFTER compilation completes,
  // so ctx.mod.functions[outer].body is still the empty initial array). The
  // `shifted` Set dedupes when fctx === ctx.currentFunc.
  if (ctx.currentFunc) {
    shiftInstrs(ctx.currentFunc.body);
    for (const sb of ctx.currentFunc.savedBodies) {
      shiftInstrs(sb);
    }
  }
  for (const parentFctx of ctx.funcStack) {
    shiftInstrs(parentFctx.body);
    for (const sb of parentFctx.savedBodies) {
      shiftInstrs(sb);
    }
  }
  for (const pb of ctx.parentBodiesStack) {
    shiftInstrs(pb);
  }
  // (#1384) Walk all live (allocated but not yet attached to mod.functions)
  // FunctionContext bodies — covers cbFctx.body / liftedFctx.body during
  // their captures-extraction + param-coercion setup phases, BEFORE the
  // savedFunc swap puts them on funcStack/parentBodiesStack.
  for (const lb of ctx.liveBodies) {
    shiftInstrs(lb);
  }
  if (ctx.pendingInitBody) {
    shiftInstrs(ctx.pendingInitBody);
  }
  // Shift funcMap entries for defined functions (not import entries).
  // Defined functions had indices >= importsBefore (before the shift) and need
  // to move up by `added`. Import entries (indices < numImportFuncs after addition)
  // are already correct and must not be shifted.
  // Build set of import function names for fast lookup.
  const importNames = new Set<string>();
  for (const imp of ctx.mod.imports) {
    if (imp.desc.kind === "func") importNames.add(imp.name);
  }
  for (const [name, idx] of ctx.funcMap) {
    if (importNames.has(name)) continue; // skip all imports
    if (inLiveShiftRange(idx, importsBefore)) {
      ctx.funcMap.set(name, idx + added);
    }
  }
  // (#1677) Keep `nativeStrHelpers` in lockstep with the defined-function shift.
  // Unlike funcMap, this map is read directly by string-lowering call sites
  // (e.g. `__str_concat` in user code, the deferred WASI write helpers) AND by
  // helper emitters that look up sibling helpers. It is NOT a separate copy of
  // funcMap (most helper names are not in funcMap), so it must be shifted on
  // its own. All entries are DEFINED functions (indices >= numImportFuncs), so
  // every entry >= importsBefore moves up by `added`.
  for (const [name, idx] of ctx.nativeStrHelpers) {
    if (inLiveShiftRange(idx, importsBefore)) {
      ctx.nativeStrHelpers.set(name, idx + added);
    }
  }
  // (#1913) Same lockstep for `nativeRegexHelpers` — the regex lowering call
  // sites (exec/test/match/split/replace in regexp-standalone.ts) read this
  // map directly when baking `call` funcIdx. Leaving it stale-low meant any
  // late import landing BETWEEN two regex call sites made the second site
  // call one function too early; stack-balance then "fixed" the args against
  // the wrong callee signature and emitted invalid ref.casts.
  for (const [name, idx] of ctx.nativeRegexHelpers) {
    if (inLiveShiftRange(idx, importsBefore)) {
      ctx.nativeRegexHelpers.set(name, idx + added);
    }
  }
  // (#2162) Same lockstep for `mapHelpers` — the Map/Set/WeakMap/WeakSet
  // lowering call sites (`__map_get`/`__map_has`/`__map_set`/`__weakset_add`/…
  // in map-runtime.ts + weak-collections-runtime.ts) bake `call` funcIdx
  // straight from this map. Leaving it stale-low meant a late import landing
  // BETWEEN the helper registration and the call (e.g. `__box_number` pulled in
  // while compiling a numeric Map/WeakMap key or value) shifted every defined
  // function up by `added` but NOT these entries — so the call landed one
  // function too early (`wm.has` → `__map_get`, returning anyref where i32 was
  // expected) and the module failed validation. WeakMap exposes it because its
  // first method call is often the first `__box_number` trigger; plain Map
  // usually imports `__box_number` earlier and dodged the window.
  for (const [name, idx] of ctx.mapHelpers) {
    if (inLiveShiftRange(idx, importsBefore)) {
      ctx.mapHelpers.set(name, idx + added);
    }
  }
  // (#2039 slice 2) Re-base the native-string finalize-shift regime. The loop
  // above plus the mod.functions body walk fully repaired the helpers for the
  // `added` imports of this batch, so the helpers are now consistent with the
  // CURRENT import count. Without this, the next
  // `reconcileNativeStrFinalizeShift` computes `added = numImportFuncs - base`
  // over the SAME imports and applies the delta a second time — `__str_flatten`'s
  // internal `call __str_copy_tree` ended one slot high (calling itself), the
  // ~165-test `__str_flatten call[0]` standalone invalid-Wasm bucket. Mirrors
  // the re-base addUnionImports' inline shift has done since #1677-fast-path.
  if (ctx.nativeStrHelperImportBase >= 0) {
    ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
  }
  // (#1525b) Trampolines registered via emitObjectMethodAsClosure /
  // emitCachedMethodClosureAccess capture the method's funcIdx and the
  // trampoline's own funcIdx as plain numbers in pendingMethodTrampolines.
  // This walker only walks Instr arrays — these side-channel numbers must be
  // shifted too, otherwise finalizeMethodTrampolines later calls
  // getFuncSignature on a stale index that now points at a late-added import
  // (e.g. __typeof_string), corrupting the rebuilt body.
  for (const t of ctx.pendingMethodTrampolines) {
    if (inLiveShiftRange(t.methodFuncIdx, importsBefore)) t.methodFuncIdx += added;
    if (inLiveShiftRange(t.trampolineFuncIdx, importsBefore)) t.trampolineFuncIdx += added;
  }
  // (#2941) Same lockstep for the native SYNC-generator resume-function indices.
  // `ctx.nativeGenerators[].resumeFuncIdx` is a plain cached number read at every
  // `.next()`/`.return()`/`.throw()`/for-of + `yield*` bake site (via
  // `ensureNativeGeneratorResumeFunction`). It is NOT `funcMap` and was walked by
  // NO shift pass, so a late import landing after a resume function was emitted
  // left the cache stale-low — a NEW bake reading it targeted one function too
  // early (`call[…] need N got 1` invalid module; the #2938 class-static-generator
  // merge_group regression). `ensureNativeGeneratorResumeFunction` now re-reads
  // funcMap on cached hits (the primary fix); this keeps the cached field itself
  // in lockstep for any direct reader — mirrors the trampoline / async
  // side-channel walks above. Inert unless native generators were emitted.
  if (ctx.nativeGenerators) {
    for (const info of ctx.nativeGenerators.values()) {
      if (typeof info.resumeFuncIdx === "number" && inLiveShiftRange(info.resumeFuncIdx, importsBefore)) {
        info.resumeFuncIdx += added;
      }
    }
  }
  // (#2632 / #2918) Same lockstep for the async-scheduler / event-loop helper
  // func indices AND the Promise.all/race combinator helper indices. They are
  // stored as plain numbers on `ctx.asyncScheduler` / `ctx.__promiseCombinators`
  // and read directly when baking `call`/`ref.func` funcIdx at timer/microtask/
  // stdin-reactor + `.then`/combinator call sites. A late import landing AFTER
  // the helper registration but BEFORE/BETWEEN a call site (e.g. `__str_concat`
  // pulled in while compiling a callback body, or an object-runtime helper for a
  // `{}` literal that precedes a native `.then`) shifts every defined function up
  // by `added` but NOT these stored numbers — so the call landed one function too
  // early, producing "not enough arguments on the stack for call" / "expected i64
  // but nothing on stack" invalid Wasm. Centralised so all three shifters use the
  // SAME complete key list (the previous inline list here omitted
  // `promiseResolveValueFuncIdx` + every combinator idx — the #2918 −601 bug).
  shiftAsyncSideChannelFuncIdxs(ctx, importsBefore, added);
  // Shift export descriptors
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func" && inLiveShiftRange(exp.desc.index, importsBefore)) {
      exp.desc.index += added;
    }
  }
  // Shift table elements
  for (const elem of ctx.mod.elements) {
    if (elem.funcIndices) {
      for (let i = 0; i < elem.funcIndices.length; i++) {
        if (inLiveShiftRange(elem.funcIndices[i]!, importsBefore)) {
          elem.funcIndices[i]! += added;
        }
      }
    }
  }
  // Shift declared func refs
  if (ctx.mod.declaredFuncRefs.length > 0) {
    ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) =>
      inLiveShiftRange(idx, importsBefore) ? idx + added : idx,
    );
  }
  // (#1712) The module start function index also moves if it was a defined
  // function at or above the insertion point. Mirrors the startFuncIdx shift
  // in addStringImports / addUnionImports (index.ts) — without it, a late
  // import added through ensureLateImport / flushLateImportShifts (e.g.
  // __box_number for a boxed numeric struct field) shifts every defined-func
  // index up by one but leaves `(start N)` pointing at the function that USED
  // to live at __module_init's index (now an exported user function with a
  // result type), producing "invalid start function: non-zero parameter or
  // return count".
  if (ctx.mod.startFuncIdx !== undefined && inLiveShiftRange(ctx.mod.startFuncIdx, importsBefore)) {
    ctx.mod.startFuncIdx += added;
  }
}

/**
 * Add a late import if it does not already exist, deferring the index shift.
 * Records ctx.pendingLateImportShift.importsBefore on the first deferred addition
 * so that flushLateImportShifts() can do a single O(B) traversal for all imports
 * added in the batch, instead of O(I*B) for I individual additions.
 * Returns the funcIdx of the import (looked up after addImport).
 */
export function ensureLateImport(
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  module = "env",
): number | undefined {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  // #1984 — freeze-point discipline. A name already in funcMap is a pure
  // lookup (handled above, always safe). Reaching here means this call would
  // REGISTER a new import — which after the index-space freeze is a producer
  // bug that shifts already-emitted indices. Throw at the producer site (its
  // own stack) rather than silently poisoning the import space. The throw is
  // caught by the generate* try/catch and surfaced as a `Codegen error:`.
  if (ctx.indexSpaceFrozen) {
    throw new Error(
      `import space frozen (#1984): late import '${name}' requested after finalize — ` +
        `this producer must register its import before the freeze point or refuse loudly`,
    );
  }
  // #1471/#4397: native semantic providers implement the
  // box/unbox/typeof/is_truthy helpers in Wasm via addUnionImports. Route there
  // so the module needs no semantic `env::*` import. addUnionImports is
  // idempotent and registers every name in UNION_NATIVE_HELPER_NAMES, so a
  // single call resolves this lookup. These names are disjoint from the
  // #1472 object/property refusal family below.
  if (ctx.targetProfile.semanticProviders === "native-first" && UNION_NATIVE_HELPER_NAMES.has(name)) {
    addUnionImportsViaRegistry(ctx);
    return ctx.funcMap.get(name);
  }
  if (ctx.targetProfile.semanticProviders === "native-first" && name.startsWith("__new_")) {
    const errorName = name.slice("__new_".length);
    if (isWasiErrorName(errorName)) {
      emitWasiErrorConstructor(ctx, errorName, paramTypes.length);
      return ctx.funcMap.get(name);
    }
  }
  // #1472 Phase B / #4397 — with native semantic providers, open-object ops
  // (__new_plain_object / __extern_get / __extern_set) have Wasm-native
  // implementations emitted by ensureObjectRuntime (object-runtime.ts), backed
  // by a $Object/$PropMap/$PropEntry open-hash-map instead of the JS-host
  // WeakMap sidecars. Route here so the module needs no semantic `env::*`
  // host import. ensureObjectRuntime is idempotent and registers every name in
  // OBJECT_RUNTIME_HELPER_NAMES in funcMap as a DEFINED function (no import is
  // added, so no index shift is required — same invariant as the #1471 boxing
  // helpers above). This keeps every existing externref-based call site
  // unchanged.
  //
  // #2748 — WASI is ALSO host-free (`ctx.strictNoHostImports` is true for
  // `--target wasi`), so it MUST take the SAME native object-runtime path, NOT
  // the `env::*` host import below. The deferred "WASI not routed yet" note here
  // predated the now-proven standalone path; leaving WASI on the host import
  // leaked an unsatisfiable `env::__extern_get` / `env::__extern_is_undefined`
  // the moment an `any`/externref receiver reached a dynamic `.length` / indexed
  // read — exactly the bun/tsc-transpiled `nm_js2wasm_deno.js` symptom (the `Uint8Array`
  // param types were stripped, so `out.length` / `out[i]` lower through the
  // polymorphic dyn-read dispatch whose host-object MISS arm calls
  // `__extern_get`). The Deno `fd_read`/`fd_write` stdio lowering itself already
  // fires on the type-stripped shape and is unaffected; this is purely the shared
  // dyn-read / object-runtime host-import gate. Mirrors the `ctx.wasi ||
  // ctx.standalone` routing of UNION_NATIVE_HELPER_NAMES above and the #2609
  // `__object_is` host-free (`ctx.standalone || ctx.wasi`) registration inside
  // ensureObjectRuntime.
  if (ctx.targetProfile.semanticProviders === "native-first" && OBJECT_RUNTIME_HELPER_NAMES.has(name)) {
    ensureObjectRuntime(ctx);
    return ctx.funcMap.get(name);
  }
  // #2866 — under no-JS-host mode `__box_symbol` has a Wasm-native carrier
  // builder (`ensureSymbolCarrier`) that boxes a symbol-handle i32 into a real
  // `$Symbol` GC struct → externref, instead of the unsatisfiable host-only
  // `env::__box_symbol`. Registered as a DEFINED function (no import → no index
  // shift), same invariant as the boxing/object-runtime helpers above. This is
  // the leak fix: before #2866, a standalone `o[sym] = v` / `symbol[]` read
  // reached the `addImport("env","__box_symbol")` fallthrough below and emitted
  // an `env::__box_symbol` import that failed at instantiation.
  if (usesNativeSymbolProvider(ctx) && name === "__box_symbol") {
    ensureSymbolCarrier(ctx);
    return ctx.funcMap.get(name);
  }
  // #3100 S4 — under no-JS-host mode the iteration-protocol ops (`__iterator`,
  // `__iterator_next`, `__iterator_return`, `__iterator_rest`), the bounded
  // iterable materializer `__array_from_iter_n` (#2904), and the rest-element
  // slice `__extern_slice` are all emitted as native DEFINED functions
  // (iterator-native.ts). Route by NAME at this single chokepoint so EVERY
  // consumer — assignment array-destructuring, the custom-iterable drain,
  // the literals rest drain, for-of rest — binds native with no per-site
  // gating. Before this, each un-gated consumer leaked the `env::` import
  // (e.g. `[a, b] = <any>` leaked `env::__array_from_iter_n`, the 60-row
  // assignment/dstr cluster of the standalone JSONL; rest patterns leaked
  // `env::__extern_slice`), breaking zero-import instantiation. MUST run
  // BEFORE `refuseStandaloneObjectImport` — `__extern_slice` matches its
  // `__extern_` refusal prefix. Registration is append-only (defined funcs,
  // no import-index shift), the same invariant as the routes above.
  if (ctx.standalone || ctx.wasi) {
    if (name === "__array_from_iter_n") {
      ensureNativeArrayFromIterN(ctx);
      return ctx.funcMap.get(name);
    }
    if (name === "__extern_slice") {
      ensureNativeExternSlice(ctx);
      return ctx.funcMap.get(name);
    }
    if (
      name === "__iterator" ||
      name === "__iterator_next" ||
      name === "__iterator_return" ||
      name === "__iterator_rest"
    ) {
      ensureNativeIteratorRuntime(ctx);
      return ctx.funcMap.get(name);
    }
  }
  // #1472 Phase A — refuse dynamic-shape object/property host imports under
  // --target standalone with a clear compile error. We still register the
  // import below so downstream codegen (which dereferences the returned
  // funcIdx) doesn't crash; the queued error makes the compile fail and the
  // module is never instantiated.
  refuseStandaloneObjectImport(ctx, name);
  // #1806 Phase 0 — refuse the JS-host ToPrimitive dispatch (`__to_primitive`)
  // under --target standalone with a trackable compile error, replacing the
  // bare "Cannot convert object to primitive value" runtime failure / opaque
  // instantiation linker error. Same register-anyway-then-fail contract.
  refuseStandaloneToPrimitive(ctx, name);
  // Record importsBefore on the FIRST deferred addition in this batch
  if (ctx.pendingLateImportShift === null) {
    // (#2936) Settle any un-reconciled RAW-import drift BEFORE opening a
    // deferred batch. Raw `addImport` additions (the finalize regime — e.g.
    // `__make_callback` in finalizeUnifiedCollector) leave every defined-func
    // reference baked under `nativeStrHelperImportBase` stale-low, with the
    // repair deferred to `reconcileNativeStrFinalizeShift`. If a deferred batch
    // opens while that repair is still pending, the two shift regimes mix
    // irrecoverably: the batch flush (a) shifts only refs >= importsBefore —
    // missing base-regime refs whose stale value sits BELOW the raw imports'
    // insertion point (e.g. `__str_flatten`'s baked `call __str_copy_tree` at
    // index 0) — and (b) re-bases `nativeStrHelperImportBase` (#1903),
    // permanently CANCELLING the pending raw repair. The baked call then
    // resolves to a host import (`__str_flatten call[1] expected externref,
    // found i32` — the #2936 invalid-module blocker for #2933's no-yield native
    // generators). Whether it fired depended on whether an interleaved pass like
    // addUnionImportsAsNativeFuncs happened to run the reconcile in between —
    // on main the hole is hit by a native-CANDIDATE generator that captures an
    // outer local (candidate ⇒ the decl skips the `unionFound` trigger, so no
    // union finalize reconcile; capture ⇒ sourceNeedsGeneratorHostImports still
    // pulls the host gen-suite batch right after the raw `__make_callback`).
    // Settling here puts every map/body on the current-numImportFuncs basis, so
    // recording `importsBefore` below is consistent and the #1903 re-base is
    // sound. No-op (added=0) unless a raw import actually landed since the last
    // settle, and a hard no-op on the JS-host/GC path (base stays -1) — so
    // gc/host and gap-free standalone output is byte-identical.
    reconcileNativeStrFinalizeShift(ctx);
    ctx.pendingLateImportShift = { importsBefore: ctx.numImportFuncs };
  }
  const typeIdx = addFuncType(ctx, paramTypes, resultTypes);
  addImport(ctx, module, name, { kind: "func", typeIdx });
  return ctx.funcMap.get(name);
}

/**
 * #1677: reconcile native-string helper function indices at the end of the
 * import-collection finalize phase.
 *
 * The native-string runtime helpers (`__str_flatten` & co.) are emitted as
 * DEFINED functions *mid-finalize* (the first `ensureNativeStringHelpers`
 * call), recording `ctx.nativeStrHelperImportBase` = the import count at that
 * instant. Finalize then continues and adds more imports via raw `addImport`
 * (string methods, parseInt, Promise statics, iterator/generator bridges, …).
 * Raw `addImport` does NOT shift defined-function indices (the #618 revert
 * deliberately removed that), so every helper body's internal `call` to a
 * sibling helper — and every `nativeStrHelpers` map entry — is now stale-low by
 * exactly `(numImportFuncs - base)`.
 *
 * This reconciliation runs once, after finalize is otherwise complete, and
 * applies that single uniform delta via the same `shiftLateImportIndices`
 * walker the compilation-phase late-import path uses — unifying the two shift
 * regimes (#1666 root cause). It is a no-op unless native-string helpers were
 * emitted, so the default GC path is never touched; and because it shifts
 * `funcIdx >= base` (sibling-helper calls) but not `funcIdx < base` (calls to
 * imports added before the helpers), it cannot corrupt the Math.* host
 * trampoline path that the #618 naive `addImport` shift broke.
 */
export function reconcileNativeStrFinalizeShift(ctx: CodegenContext): void {
  const base = ctx.nativeStrHelperImportBase;
  if (base < 0) return; // helpers never emitted (default GC path or no strings)
  const added = ctx.numImportFuncs - base;
  // Re-base for the next incremental call so repeated invocations only apply
  // the NEW imports added since the previous reconcile. (Imports are inserted
  // between finalize and body compilation at several points — the
  // register-prototype block, the deferred WASI helper emitters, etc. — and
  // each batch drifts the indices further.)
  ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
  if (added <= 0) return;

  // Uniform defined-function index shift, restricted to the native-string
  // finalize regime.
  //
  // At the point this runs (mid/end of finalize, before `collectDeclarations`),
  // EVERY function already in `ctx.mod.functions` is an eagerly-emitted runtime
  // helper (the native-string helpers AND their dependencies: `__box_number`,
  // `__unbox_number`, `__toUint32`, …). They were all emitted while
  // `numImportFuncs == base`, so their absolute index is `base + arrayPos` and
  // any `call`/`ref.func funcIdx >= base` they baked points at a *sibling*
  // defined function under that same regime. Adding `added` finalize imports
  // (string methods, parseInt, Promise statics, …) bumps every defined
  // function's true absolute index by `added` but leaves the baked call targets
  // and the `funcMap` entries stale-low. We repair ALL of them uniformly by
  // `added` for `funcIdx >= base`.
  //
  // Earlier versions shifted only `nativeStrHelpers`-named functions; that
  // missed dependency helpers like `__box_number` (registered via
  // `addUnionImportsAsNativeFuncs`, not tracked in `nativeStrHelpers`), whose
  // stale-low `funcMap` entry made later callers (e.g. `__vec_get`) target the
  // wrong function — `call[k] not enough arguments on the stack`.
  //
  // #618 safety: gated on `base >= 0`, which is set only inside
  // `ensureNativeStringHelpers` (native-strings path: wasi/standalone or
  // explicit `--nativeStrings`). On the default JS-host GC path the helpers are
  // never emitted, `base` stays -1, and this is a hard no-op — so the
  // Math.*-trampoline corruption the #608 `addImport` shift caused cannot recur.
  // The `funcIdx < base` guard further protects calls into pre-helper imports
  // (the host trampolines) from ever being shifted.
  const seen = new Set<Instr[]>();
  function shiftBody(instrs: Instr[]): void {
    if (seen.has(instrs)) return;
    seen.add(instrs);
    for (const instr of instrs) {
      const a = instr as any;
      if (
        (instr.op === "call" || instr.op === "return_call" || instr.op === "ref.func") &&
        typeof a.funcIdx === "number" &&
        inLiveShiftRange(a.funcIdx, base)
      ) {
        a.funcIdx += added;
      }
      if (Array.isArray(a.body)) shiftBody(a.body);
      if (Array.isArray(a.then)) shiftBody(a.then);
      if (Array.isArray(a.else)) shiftBody(a.else);
      if (Array.isArray(a.catches)) {
        for (const c of a.catches) if (Array.isArray(c.body)) shiftBody(c.body);
      }
      if (Array.isArray(a.catchAll)) shiftBody(a.catchAll);
    }
  }
  for (const fn of ctx.mod.functions) {
    shiftBody(fn.body);
  }
  // Shift `funcMap` entries for DEFINED functions only. The `added` imports we
  // just inserted now occupy indices `[base, base+added)`, which collides by
  // value with stale defined-function entries (also `>= base`). We cannot
  // disambiguate by index value, so we gate on the function NAME being a
  // defined function (present in `ctx.mod.functions`). Import names are never
  // in that set, so their (correct) entries are left untouched.
  const definedNames = new Set<string>();
  for (const fn of ctx.mod.functions) {
    const n = (fn as { name?: string }).name;
    if (n) definedNames.add(n);
  }
  for (const [name, idx] of ctx.funcMap) {
    if (inLiveShiftRange(idx, base) && definedNames.has(name)) ctx.funcMap.set(name, idx + added);
  }
  // Keep the helper-name map (read directly by string lowering) in lockstep —
  // every entry is a defined function by construction.
  for (const [name, idx] of ctx.nativeStrHelpers) {
    if (inLiveShiftRange(idx, base)) ctx.nativeStrHelpers.set(name, idx + added);
  }
  // (#1913) Regex helper map moves in lockstep too — see the comment in
  // addLateImportBatch above.
  for (const [name, idx] of ctx.nativeRegexHelpers) {
    if (inLiveShiftRange(idx, base)) ctx.nativeRegexHelpers.set(name, idx + added);
  }
  // Shift export descriptors. Exports only ever reference defined functions in
  // this regime (helpers/runtime exports like `__vec_get`); a func export with
  // `index >= base` is a defined function whose true slot moved by `added`.
  for (const exp of ctx.mod.exports) {
    if (exp.desc.kind === "func" && inLiveShiftRange(exp.desc.index, base)) {
      exp.desc.index += added;
    }
  }
}

/**
 * Flush any pending late import shifts. Performs a single traversal of all
 * function bodies to shift indices, instead of one traversal per import.
 * Must be called after a batch of ensureLateImport() calls before any
 * funcIdx values are used in emitted instructions.
 */
export function flushLateImportShifts(ctx: CodegenContext, fctx: FunctionContext | null): void {
  const pending = ctx.pendingLateImportShift;
  if (pending === null) return;
  const added = ctx.numImportFuncs - pending.importsBefore;
  ctx.pendingLateImportShift = null;
  if (added <= 0) return;
  shiftLateImportIndices(ctx, fctx, pending.importsBefore, added);

  // #1903 — re-base the native-string helper snapshot after the batch shift.
  //
  // `shiftLateImportIndices` just moved EVERY defined-function reference at or
  // above `importsBefore` by `added` — including the native-string helper
  // bodies and their `nativeStrHelpers` / `funcMap` map entries. The helpers
  // are therefore now consistent with the post-batch `numImportFuncs`. But
  // `ctx.nativeStrHelperImportBase` still records the import count from before
  // this batch, so a later `reconcileNativeStrFinalizeShift` (the index.ts
  // finalize passes, or the addUnionImports settle) would compute a non-zero
  // `added = numImportFuncs - base` and shift the (already-correct) helpers a
  // SECOND time — the exact double-shift that off-by-ones `__str_flatten`'s
  // baked `__str_copy_tree` sibling call and emits invalid wasm (observed as
  // `call[0] expected type (ref null N), found i32.const` on e.g. a private
  // accessor that throws, or any string op compiled after a body-time import
  // batch). Re-basing here makes that reconcile a no-op for the drift this
  // flush already settled.
  //
  // Guard `>= 0`: only touch the snapshot when native-string helpers were
  // actually emitted (the default GC path leaves it -1, untouched). We rebase
  // unconditionally on helper presence — not just when `base >= importsBefore`
  // — because helper references in `[base, importsBefore)` sit BELOW the
  // insertion point and were (correctly) left unmoved by
  // `shiftLateImportIndices`, so `numImportFuncs` is the right new floor for
  // them too.
  if (ctx.nativeStrHelperImportBase >= 0) {
    ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
  }
}

/**
 * Ensure the __get_undefined host import exists, returning its funcIdx.
 * This import returns the actual JS `undefined` value as externref,
 * allowing Wasm to distinguish null from undefined at runtime.
 *
 * Under native-strings mode (auto-on for `--target standalone`/`wasi`) there is
 * no JS host to satisfy this import, and undefined is conflated with null (same
 * convention as `__extern_is_undefined` → bare `ref.is_null`). Returning
 * `undefined` here makes callers fall back to the native `ref.null.extern`
 * sentinel via `emitUndefined`, which (a) keeps standalone host-import-free and
 * (b) avoids adding a late import *after* the native-string helpers were emitted
 * — that post-helper import otherwise drives `reconcileNativeStrFinalizeShift`
 * an extra time and off-by-ones the baked `__str_flatten`→`__str_copy_tree`
 * call (#329: `let g: any; g = function(){…}; g()` invalid wasm).
 */
export function ensureGetUndefined(ctx: CodegenContext): number | undefined {
  if (ctx.nativeStrings) return undefined;
  return ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
}

/**
 * Emit instructions that push the JS `undefined` value onto the stack.
 * Uses the __get_undefined host import when available; falls back to
 * ref.null.extern (indistinguishable from null) in standalone mode — unless
 * the (#2106 S1) `undefinedSingleton` regime is active, in which case the
 * distinct extern-wrapped tag-1 `$undefined` singleton is pushed instead
 * (a GLOBAL read, not a func import, so the #329 late-import finalize shift
 * is never driven — see the S1.0 reservation in `ensureAnyValueType`).
 */
export function emitUndefined(ctx: CodegenContext, fctx: FunctionContext): void {
  const funcIdx = ensureGetUndefined(ctx);
  if (funcIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx });
  } else if (emitUndefinedExtern(ctx, fctx)) {
    // (#2106 S1) flag regime: `global.get $undefined; extern.convert_any`.
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

/**
 * Ensure the __extern_is_undefined host import exists, returning its funcIdx.
 * This import checks if an externref value is JS `undefined` (not null).
 */
export function ensureExternIsUndefinedImport(ctx: CodegenContext): number | undefined {
  return ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
}

/**
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions for that type by inserting a default value
 * instruction immediately before each struct.new.  This ensures the
 * operand count matches the (now larger) field list.
 */
export function patchStructNewForAddedField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeIdx: number,
  fieldType: ValType,
): void {
  function defaultInstrFor(ft: ValType): Instr {
    switch (ft.kind) {
      case "f64":
        return { op: "f64.const", value: 0 };
      case "i32":
        return { op: "i32.const", value: 0 };
      case "externref":
        return { op: "ref.null.extern" };
      case "ref":
      case "ref_null":
        return { op: "ref.null", typeIdx: (ft as { typeIdx: number }).typeIdx };
      default:
        if ((ft as any).kind === "i64") {
          return { op: "i64.const", value: 0n };
        }
        if ((ft as any).kind === "eqref") {
          return { op: "ref.null.eq" };
        }
        return { op: "i32.const", value: 0 };
    }
  }

  // Iterative to avoid composing JS call-stack depth with the enclosing
  // codegen stack: same reasoning as walkInstructions (#1087).
  function patchInstrs(root: Instr[]): void {
    const work: Instr[][] = [root];
    while (work.length > 0) {
      const arr = work.pop()!;
      for (let i = arr.length - 1; i >= 0; i--) {
        const instr = arr[i]!;
        if (instr.op === "struct.new" && (instr as any).typeIdx === typeIdx) {
          // Insert a default value right before the struct.new. The inserted
          // instr has no nested blocks, so enqueueing children of `instr`
          // below is still correct — `instr` is captured by reference.
          arr.splice(i, 0, defaultInstrFor(fieldType));
        }
        if ("body" in instr && Array.isArray((instr as any).body)) {
          work.push((instr as any).body);
        }
        if ("then" in instr && Array.isArray((instr as any).then)) {
          work.push((instr as any).then);
        }
        if ("else" in instr && Array.isArray((instr as any).else)) {
          work.push((instr as any).else);
        }
        if ("catches" in instr && Array.isArray((instr as any).catches)) {
          for (const c of (instr as any).catches) {
            if (Array.isArray(c.body)) work.push(c.body);
          }
        }
        if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
          work.push((instr as any).catchAll);
        }
      }
    }
  }

  // Patch all already-compiled function bodies
  const patched = new Set<Instr[]>();
  for (const func of ctx.mod.functions) {
    patchInstrs(func.body);
    patched.add(func.body);
  }
  // Patch current function body (if not already part of mod.functions)
  if (!patched.has(fctx.body)) {
    patchInstrs(fctx.body);
    patched.add(fctx.body);
  }
  // Patch saved bodies from the savedBody swap pattern
  for (const sb of fctx.savedBodies) {
    if (!patched.has(sb)) {
      patchInstrs(sb);
      patched.add(sb);
    }
  }
  // (#2503) Patch DETACHED live bodies — buffers temporarily swapped onto
  // `fctx.body` via a plain JS-local swap (not `pushBody`, so absent from
  // `fctx.savedBodies`) and registered in `ctx.liveBodies` for exactly this
  // coverage window (mirrors the late-import-shift walk at line ~212). The
  // destructuring-param nested-pattern default path (destructuring-params.ts)
  // builds a default object literal into such a detached `if.then` buffer; when
  // a LATER same-shape object grows that struct's field set, the field-pad
  // `patchStructNewForAddedField` previously could not reach the earlier
  // struct.new sitting in the orphaned buffer, leaving it one operand short of
  // the grown 3-field type → invalid Wasm ("struct.new need 3, got 2"). Same bug
  // class as #2158 (late-import shift) but for the field-pad patch.
  for (const lb of ctx.liveBodies) {
    if (!patched.has(lb)) {
      patchInstrs(lb);
      patched.add(lb);
    }
  }
}
