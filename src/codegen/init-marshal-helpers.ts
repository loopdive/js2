// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// init-marshal-helpers.ts — (#5193) hand the JS runtime the module's own
// compiled→host marshalling helpers from INSIDE the wasm `start` section.
//
// ## The window this closes
//
// In the JS-host lane top-level code runs via the wasm `start` section, i.e.
// DURING `WebAssembly.instantiate`. The host cannot call `setInstance` until
// that returns, so for the whole of module init `callbackState.getExports()`
// is `undefined`. Every probe the runtime uses to decode a compiled value —
// `__vec_len`, `__vec_get`, `__is_vec`, `__dv_byte_len`, `__dv_byte_get`,
// `__ab_max_len` — is an EXPORT, so during init they are all unreachable.
//
// The visible failure was a plain `new Float64Array(new ArrayBuffer(8))`
// written at module top level: `_marshalHostConstructArg` could not decode the
// compiled ArrayBuffer struct and refused with "cannot marshal opaque compiled
// value to host Float64Array constructor". That is exactly jsbi's
// `JSBI.__kBitConversionBuffer`, which is why the @js-temporal/polyfill bundle
// compiled and validated but never finished module init (#4628 Option A).
//
// ## Why funcrefs
//
// A `funcref` produced by `ref.func` and passed to a JS import materializes as
// the SAME JS function object the export would later yield (verified against
// V8: `received === instance.exports.f`). So registering the helpers at the
// top of `__module_init` is a pure TIMING shim — the runtime gets the identical
// callables, just earlier. No copying, no second ABI, no behaviour change for
// anything that runs after instantiation.
//
// The registry is deliberately kept OUT of `getExports()`: the runtime has many
// `getExports() !== undefined` branches that mean "post-instantiation", and
// only the marshalling paths consult `getStartExports()`.
//
// ## Placement contract
//
// Called from `generateWasm`'s finalize sequence, immediately before
// `finalizeInModuleInitFlag`:
//   * AFTER `emitVecAccessExports` / `emitDataViewByteExports` /
//     `emitResizableAbExports`, so every helper function object exists;
//   * BEFORE dead-import elimination, so the added import is seen as live (it
//     is called) and is not pruned;
//   * BEFORE the #1984 index-space freeze, so `ensureLateImport` is legal.
// Emission is gated on `ctx.needsInitMarshalHelpers`, so a module that never
// takes the host TypedArray construct bridge is byte-identical.

import type { IrUnitId } from "../ir/identity.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { definedFuncHandleOf } from "./func-space.js";
import { noJsHost } from "./js-errors.js";

/**
 * Runtime contract: keep in lock-step with `_INIT_MARSHAL_HELPER_NAMES` in
 * `src/runtime.ts`. The ARRAY POSITION is the wire id — append only.
 */
export const INIT_MARSHAL_HELPERS: readonly string[] = [
  "__vec_len",
  "__vec_get",
  "__is_vec",
  "__dv_byte_len",
  "__dv_byte_get",
  "__ab_max_len",
  // (#5208) The Date carrier's classifier + reader — see the runtime twin.
  "__\0js2_is_date",
  "__\0js2_date_value",
];

const REGISTER_IMPORT = "__register_init_export";

/**
 * (#5209) Does this module dispatch a DYNAMIC method call through the host?
 *
 * `__extern_method_call*` hands the runtime a receiver and arguments it must
 * decode — i.e. it is a marshalling site, exactly like #5193's construct bridge
 * and #5205's `Object.fromEntries`. A compiled vec reaching it during the start
 * section could not be given its host Array facade (that facade needs
 * `__is_vec`/`__vec_len`/`__vec_get`), so it fell back to the generic object
 * proxy and `t.filter(cb)` threw "filter is not a function" — the tenth Temporal
 * module-init blocker.
 *
 * Deciding this from the IMPORT LIST rather than from each of the ~20 emitting
 * call sites keeps the trigger in one reviewable place; the cost when it fires
 * is the 3-instruction-per-helper prologue and nothing else.
 */
function usesDynamicExternMethodCall(ctx: CodegenContext): boolean {
  return ctx.mod.imports.some((imp) => imp.desc.kind === "func" && /^__extern_method_call(_[0-4])?$/.test(imp.name));
}

/**
 * (#5208) Does this module own a `Date` carrier?
 *
 * A compiled `Date` reaches the host as an argument of a TYPED extern-class
 * method (`Intl_DateTimeFormat_formatToParts`), which is neither a host
 * construct bridge (#5193's trigger) nor `__extern_method_call` (#5209's) — so
 * neither existing trigger fires, and a `new Date(…)` formatted at module top
 * level stayed undecodable while the same code after init worked.
 *
 * Keyed on the carrier's own classifier export rather than on the import list:
 * a module that never built a `$__Date` cannot leak one, and one that did can
 * leak it through any host call, so this is both the necessary and the
 * sufficient condition. Cost when it fires is two 3-instruction prologue
 * entries.
 */
function ownsDateCarrier(ctx: CodegenContext): boolean {
  return helperFunc(ctx, "__\0js2_is_date") !== undefined;
}

/** The defined function object exporting `name`, if this module emitted one. */
function helperFunc(ctx: CodegenContext, name: string): WasmFunction | undefined {
  return ctx.mod.functions.find((fn) => fn.name === name);
}

/**
 * Prepend `__register_init_export(<id>, ref.func <helper>)` for every
 * marshalling helper this module actually emitted onto `__module_init`.
 *
 * No-op unless a call site set `ctx.needsInitMarshalHelpers` and the module is
 * a JS-host module with a compiler-created module initializer.
 */
export function emitInitMarshalHelperRegistration(ctx: CodegenContext, preferredUnitId?: IrUnitId): void {
  if (!ctx.needsInitMarshalHelpers && !usesDynamicExternMethodCall(ctx) && !ownsDateCarrier(ctx)) return;
  if (ctx.wasi || noJsHost(ctx)) return;
  // Same initializer selection as `finalizeInModuleInitFlag` (index.ts), so the
  // multi-source pipeline patches the exact prepared unit it owns.
  const initFn =
    preferredUnitId !== undefined
      ? ctx.programAbiModuleInitCallables?.functionForUnit(preferredUnitId)
      : ctx.programAbiModuleInitCallables?.firstFunction();
  if (!initFn) return;

  // Nothing to hand over ⇒ leave the module byte-identical.
  const present = INIT_MARSHAL_HELPERS.map((name, id) => ({ id, fn: helperFunc(ctx, name) })).filter(
    (entry): entry is { id: number; fn: WasmFunction } => entry.fn !== undefined,
  );
  if (present.length === 0) return;

  const params: ValType[] = [{ kind: "i32" }, { kind: "funcref" }];
  const registerIdx = ensureLateImport(ctx, REGISTER_IMPORT, params, []);
  if (registerIdx === undefined) return;
  // Settle the index shift this import caused BEFORE resolving helper handles
  // and baking the calls — otherwise every index below is one batch stale.
  flushLateImportShifts(ctx, null);
  const finalRegisterIdx = ctx.funcMap.get(REGISTER_IMPORT) ?? registerIdx;

  const prologue: Instr[] = [];
  for (const entry of present) {
    const handle = definedFuncHandleOf(ctx, entry.fn);
    if (handle === undefined) continue;
    prologue.push({ op: "i32.const", value: entry.id });
    prologue.push({ op: "ref.func", funcIdx: handle });
    prologue.push({ op: "call", funcIdx: finalRegisterIdx });
  }
  if (prologue.length === 0) return;
  initFn.body = [...prologue, ...initFn.body];
}
