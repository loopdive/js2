// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// init-class-dispatch-helpers.ts — (#5202) hand the JS runtime the module's own
// CLASS-METHOD DISPATCH exports from inside the wasm `start` section.
//
// ## The window this closes
//
// This is the second facet of the #5193 window. In the JS-host lane top-level
// code runs via the wasm `start` section, i.e. DURING `WebAssembly.instantiate`,
// so `callbackState.getExports()` is `undefined` for the whole of module init.
//
// #5193 closed the MARSHALLING facet (`__vec_len` & friends). The facet left
// open is METHOD DISPATCH: a compiled class's methods are not JS properties of
// any prototype object — `__set_subclass_proto` synthesizes a bare
// `class Sub extends Parent {}` whose prototype carries only `constructor`, and
// `_resolveClassMemberOnInstance` (src/runtime/class-method-host-bridge.ts)
// answers `obj.m()` by reading the compiler-emitted dispatch EXPORTS
// (`__class_call_*`, `__member_kind_*`, `__member_arity_*`, `__call_get_*`).
// Those are exports, so during init they are all unreachable and the resolver
// bails at its first line (`if (exports === undefined) return miss`).
//
// The visible failure was a plain top-level method call on an instance of a
// class extending a builtin:
//
//     class D extends Array { __clzmsd() { return 7; } }
//     const AT_INIT = f(new D(1, false));   // TypeError: __clzmsd is not a function
//     export function test() { return f(new D(1, false)); }   // 7
//
// Same source, same wiring — only the TIMING differs. That is jsbi's
// `JSBI.__clzmsd`, called from `JSBI.__absoluteDivLarge` during module init,
// which is why the @js-temporal/polyfill bundle never finished initializing
// (#4628 Option A, blocker 4 of 4).
//
// ## Wire shape — why a CSV, not one string per name
//
// #5193's registry is a fixed, positional, append-only array of six helper
// names, so an `i32` id was enough. The dispatch surface is neither fixed nor
// small: it is one export per (class, method, arity), unbounded and different
// per module. Encoding each name as its own string constant would add one
// imported `string_constants` global PER NAME (hundreds on a Temporal-sized
// bundle). So the module registers ONE comma-separated name list and then
// indexes into it:
//
//     __register_init_class_export(namesCsv, index, ref.func $export)
//
// One new pooled string, one new import, four instructions per export. The
// runtime splits the CSV once (cached by string identity) and stores
// `name -> fn` in the same start-export registry #5193 introduced.
//
// As in #5193 this is a pure TIMING shim: a `funcref` produced by `ref.func`
// and passed to a JS import materializes as the SAME JS function object the
// export later yields, so the runtime gets identical callables, just earlier.
// The registry stays OUT of `getExports()`; the late `__setInstance` path is
// untouched and remains authoritative once instantiation returns.
//
// ## Placement contract
//
// Called from `generateWasm`'s finalize sequence, immediately AFTER
// `emitInitMarshalHelperRegistration` and BEFORE `finalizeInModuleInitFlag`:
//   * AFTER `emitIteratorMethodExport` (which emits every dispatch export), so
//     the functions being registered exist;
//   * BEFORE dead-import elimination, so the added import is seen as live;
//   * BEFORE the #1984 index-space freeze, so `ensureLateImport` is legal;
//   * BEFORE `finalizeInModuleInitFlag`, which allocates the `__in_module_init`
//     global "now that every import global has settled" — the pooled CSV string
//     is an imported global, so it must land first.
//
// (#5205) The same channel now also carries the STRUCT-READ family
// (`__sget_*`, `__struct_field_names`, `__is_data_struct`) — see
// `STRUCT_READ_EXPORT_PREFIXES` below. Per-field getter names are module
// dependent, so they cannot live in #5193's fixed positional ABI; this CSV
// exists for exactly that reason.
//
// Gated on the module having BOTH a compiler-created module initializer (i.e.
// top-level code — no init, no window) and at least one dispatch export, so
// every other module's bytes are unchanged. Standalone/WASI never reach here.

import type { IrUnitId } from "../ir/identity.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncHandleOf } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { addStringConstantGlobal } from "./registry/imports.js";

const REGISTER_IMPORT = "__register_init_class_export";

/**
 * Export-name prefixes that `_resolveClassMemberOnInstance` reads. Keep in
 * lock-step with `src/runtime/class-method-host-bridge.ts`.
 */
export const CLASS_DISPATCH_EXPORT_PREFIXES: readonly string[] = [
  "__class_call_",
  "__member_kind_",
  "__member_arity_",
  "__call_get_",
];

/**
 * (#5203) The CLOSURE-dispatch family — the third facet of the same window.
 *
 * #5202 closed instance-method dispatch, which resolves a method by EXPORT
 * NAME. A STATIC method never goes through that surface: the compiler hands
 * the host the raw closure struct via `__register_class_static_method`, and
 * the host turns it into a callable in `_wrapWasmClosureUnknownArity` — which
 * bails on `if (!exports) return null`, because it needs the `__call_fn_*`
 * dispatchers to actually invoke the closure. So `c.clz()` on a class VALUE
 * threw "clz is not a function" at init while the identical call after init
 * returned. jsbi's `JSBI.__clz30(t)` is exactly this shape.
 *
 * Registering the closure dispatchers on the same start-export channel is the
 * "route init-window closure wrapping through the registered funcrefs" arm of
 * the issue, and it deliberately does NOT widen what `_wrapForHost` is given:
 * its `exports` argument feeds a large amount of unrelated behaviour, so only
 * the closure-bridge's own export source moves.
 *
 * Prefix-matched so a new arity is covered automatically:
 *   `__call_fn_<N>`, `__call_fn_method_<N>`, and the NUL-named
 *   `__\0js2_call_fn_method_argc_<N>` argc wrappers.
 */
const CLOSURE_DISPATCH_EXPORT_PREFIXES: readonly string[] = ["__call_fn_", "__\0js2_call_fn_method_argc_"];

/** Exact closure-bridge names the host wrapper probes (arity / discriminators). */
const CLOSURE_DISPATCH_EXPORT_NAMES: ReadonlySet<string> = new Set([
  "__closure_arity",
  "__is_closure",
  "__closure_has_rest",
  "__is_ctor_closure",
]);

/**
 * (#5205) The STRUCT-READ family — the fourth facet of the same window.
 *
 * A compiled `[key, value]` pair of mixed types is a TUPLE struct whose fields
 * are `_0`, `_1`; the host reads them through `__struct_field_names` plus the
 * per-field `__sget_*` getters (`src/runtime.ts` `_convertIterableForHost` /
 * `__make_iterable`'s `convertToJS`). Those are exports too, so during init a
 * tuple pair decoded to `undefined` — measured on the Temporal bundle, where
 * `Object.fromEntries(nt.map((e) => [e[0], e[1]]))` at module top level built
 * `{ undefined: undefined }` instead of the ten-key table. Silently-wrong data,
 * not a throw, which is why it is worth registering rather than detecting.
 *
 * `__vec_*` already comes through #5193's positional registry; this covers the
 * heterogeneous-tuple half that has per-field, module-dependent names.
 */
const STRUCT_READ_EXPORT_PREFIXES: readonly string[] = ["__sget_"];

/** Exact struct-read discriminator names the host probes. */
const STRUCT_READ_EXPORT_NAMES: ReadonlySet<string> = new Set(["__struct_field_names", "__is_data_struct"]);

/**
 * (#5209) The CALLBACK-BRIDGE family — the fifth facet of the same window.
 *
 * `__make_callback(id, caps)` hands the host a JS function whose body is
 * `exports.__cb_<id>(caps, …args)`. During init that export was unreachable, so
 * `createNativeFunctionCallbackBridge` took its "park it until exports exist"
 * arm: the bridge returned `undefined` IMMEDIATELY and ran the real callback
 * later, out of order.
 *
 * For an ASYNCHRONOUS consumer (a settled-promise reaction — the case that arm
 * was written for) that is fine. For a SYNCHRONOUS one it is silently wrong:
 * `t.filter(cb)` at module top level saw `undefined` for every element, kept
 * nothing, and returned `[]` — the Temporal polyfill's
 * `n.filter((e) => null != e.reverseOf).length > 1` era guard read an empty
 * table. Registering `__cb_*` here lets the bridge dispatch for real, in order,
 * and leaves the defer as the fallback for a callback whose export genuinely is
 * not reachable yet.
 */
const CALLBACK_BRIDGE_EXPORT_PREFIXES: readonly string[] = ["__cb_"];

/**
 * (#5239) The OBJECT-CREATE facet. A minified library builds its instances as
 * `Object.create(<class value>.prototype)`, and the polyfill bundles that
 * motivated this do it while their module is still initialising. The runtime's
 * `__object_create` asks this export whether the requested prototype is one of
 * the module's compiled class prototypes; unreachable during init, it would
 * silently hand back a plain host object for every instance built at top level.
 */
const OBJECT_CREATE_EXPORT_NAMES: ReadonlySet<string> = new Set(["__object_create_class_instance"]);

/**
 * (#5242) The CONSTRUCT facet — the twin of the object-create one above. The
 * same minified library that mints instances with `Object.create` also builds
 * them with `new (ce("%Temporal.Duration%"))(…)`, at top level, while its
 * module is still initialising. The host mirror's `[[Construct]]` trap answers
 * that through `__class_construct_<Class>_<arity>`, so without this the
 * init-window `new` on a class VALUE throws "bridge unavailable" while the
 * identical call after init succeeds.
 */
const CLASS_CONSTRUCT_EXPORT_PREFIXES: readonly string[] = ["__class_construct_"];

function isClassDispatchExport(name: string | undefined): name is string {
  if (name === undefined) return false;
  if (CLASS_DISPATCH_EXPORT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (CLOSURE_DISPATCH_EXPORT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (STRUCT_READ_EXPORT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (CALLBACK_BRIDGE_EXPORT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (CLASS_CONSTRUCT_EXPORT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (STRUCT_READ_EXPORT_NAMES.has(name)) return true;
  if (OBJECT_CREATE_EXPORT_NAMES.has(name)) return true;
  return CLOSURE_DISPATCH_EXPORT_NAMES.has(name);
}

/**
 * Prepend `__register_init_class_export(csv, <index>, ref.func <dispatcher>)`
 * for every class-method dispatch export this module emitted onto
 * `__module_init`.
 */
export function emitInitClassDispatchRegistration(ctx: CodegenContext, preferredUnitId?: IrUnitId): void {
  if (ctx.wasi || noJsHost(ctx)) return;
  // Same initializer selection as `finalizeInModuleInitFlag` (index.ts), so the
  // multi-source pipeline patches the exact prepared unit it owns.
  const initFn =
    preferredUnitId !== undefined
      ? ctx.programAbiModuleInitCallables?.functionForUnit(preferredUnitId)
      : ctx.programAbiModuleInitCallables?.firstFunction();
  if (!initFn) return;

  const dispatchers: WasmFunction[] = [];
  for (const fn of ctx.mod.functions) {
    if (fn.exported && isClassDispatchExport(fn.name)) dispatchers.push(fn);
  }
  if (dispatchers.length === 0) return;
  // Deterministic order: the CSV index is positional, so the list must not
  // depend on incidental function-table ordering across compiles.
  dispatchers.sort((a, b) => (a.name! < b.name! ? -1 : a.name! > b.name! ? 1 : 0));

  const csv = dispatchers.map((fn) => fn.name!).join(",");
  addStringConstantGlobal(ctx, csv);
  const csvGlobal = ctx.stringGlobalMap.get(csv);
  // `-1` is the documented nativeStrings sentinel ("no host `string_constants`
  // global") — there is no JS host to register with in that mode anyway.
  if (csvGlobal === undefined || csvGlobal < 0) return;

  const params: ValType[] = [{ kind: "externref" }, { kind: "i32" }, { kind: "funcref" }];
  const registerIdx = ensureLateImport(ctx, REGISTER_IMPORT, params, []);
  if (registerIdx === undefined) return;
  // Settle the index shift this import caused BEFORE resolving dispatcher
  // handles and baking the calls — otherwise every index below is one batch
  // stale (the #5193 emitter's lesson, same hazard here).
  flushLateImportShifts(ctx, null);
  const finalRegisterIdx = ctx.funcMap.get(REGISTER_IMPORT) ?? registerIdx;

  const prologue: Instr[] = [];
  for (let index = 0; index < dispatchers.length; index++) {
    const handle = definedFuncHandleOf(ctx, dispatchers[index]!);
    if (handle === undefined) continue;
    prologue.push({ op: "global.get", index: csvGlobal });
    prologue.push({ op: "i32.const", value: index });
    prologue.push({ op: "ref.func", funcIdx: handle });
    prologue.push({ op: "call", funcIdx: finalRegisterIdx });
  }
  if (prologue.length === 0) return;
  initFn.body = [...prologue, ...initFn.body];
}
