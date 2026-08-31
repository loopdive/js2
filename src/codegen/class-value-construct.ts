// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// class-value-construct.ts — (#5242) `new <compiled class value>(…)` through the
// host, i.e. the CONSTRUCT twin of #5239's instance-minting fix.
//
// ## The gap this closes
//
// A compiled class that reaches the host as a VALUE is presented by
// `_makeClassCtorMirrorForHost` (runtime.ts) as a constructible function proxy.
// Its `[[Construct]]` trap had exactly one way back into Wasm: the GENERIC
// closure bridge `__call_fn_<N>`, which
//
//   * is emitted only for N ≤ 4 — every constructor with five or more
//     parameters is unreachable, and `@js-temporal/polyfill`'s `Duration` takes
//     TEN (`new Duration(years, months, weeks, days, hours, …)`);
//   * is emitted at all only when the module happens to need generic closure
//     dispatch for some other reason, so a module with none had no bridge for
//     ANY arity.
//
// Both misses surface as the same TypeError — `compiled class constructor
// Duration bridge unavailable` — which is what
// `Temporal.PlainDate.from("2020-03-04").subtract({days: 1})` threw in the
// SINGLE-MODULE lane (no linker, no provider seam), because the polyfill
// constructs `Duration` through its intrinsics registry:
// `new (ce("%Temporal.Duration%"))(…)`.
//
// ## Shape
//
// One export per registered class:
//
//     __class_construct_<Class>_<arity>(a0, …, aN-1) -> externref
//
// `(externref × arity) -> externref`, the same ABI the #5204 externref-backed
// METHOD bridges use, with the same per-parameter coercion (a numeric formal is
// unboxed at the boundary) and the same result boxing. The arity is in the NAME
// so the runtime can discover the bridge without a second metadata export —
// there is exactly one constructor per class, so the family has one member.
//
// ## Gate
//
// `ctx.classCtorHostRegistered` — the classes whose singleton actually reached
// `__register_class_ctor`, i.e. exactly those whose class object can cross to
// the host. A module that never lets a class escape as a value emits identical
// bytes. Classes whose constructor takes a rest parameter, or a formal whose
// type has no externref boundary coercion, are skipped: they keep today's
// generic-closure behaviour rather than getting a bridge that would lie about
// its ABI.

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { exportFunc } from "./emit-helpers.js";
import { funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { addFuncType } from "./registry/types.js";

/** Prefix of the per-class constructor bridge; the runtime resolves by it. */
export const CLASS_CONSTRUCT_EXPORT_PREFIX = "__class_construct_";

export interface ClassValueConstructHelpers {
  /** Instructions turning one incoming externref into the callee's formal. */
  paramCoercion: (ctx: CodegenContext, param: ValType) => Instr[] | undefined;
  /** Append the boxing that turns the callee's result into an externref. */
  boxResult: (ctx: CodegenContext, body: Instr[], resultType: ValType | undefined) => boolean;
}

/**
 * Emit `__class_construct_<Class>_<arity>` for every class the host may
 * construct. Idempotent per class; a class it cannot express is skipped.
 */
export function emitClassValueConstructExports(ctx: CodegenContext, helpers: ClassValueConstructHelpers): void {
  if (ctx.wasi || ctx.standalone || noJsHost(ctx)) return;
  if (ctx.classCtorHostRegistered.size === 0) return;

  for (const className of [...ctx.classCtorHostRegistered].sort()) {
    const ctorFullName = `${className}_new`;
    // A rest-parameter constructor takes a typed GC vector, which no
    // fixed-arity externref bridge can express.
    if (ctx.funcRestParams.has(ctorFullName)) continue;
    const ctorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorFullName));
    if (ctorIdx === undefined) continue;
    // (#1916 S3) `ctorIdx` is a stable HANDLE, not a live position — never do
    // `mod.functions[idx - numImportFuncs]` on it.
    const ctorType = funcSignatureOf(ctx, ctorIdx);
    if (ctorType === undefined) continue;

    const params = ctorType.params;
    const coercions: Instr[][] = [];
    let expressible = true;
    for (const param of params) {
      const coercion = helpers.paramCoercion(ctx, param);
      if (coercion === undefined) {
        expressible = false;
        break;
      }
      coercions.push(coercion);
    }
    if (!expressible) continue;

    const exportName = `${CLASS_CONSTRUCT_EXPORT_PREFIX}${className}_${params.length}`;
    if (ctx.funcMap.has(exportName)) continue;

    const body: Instr[] = [];
    for (let index = 0; index < params.length; index++) {
      body.push({ op: "local.get", index }, ...coercions[index]!);
    }
    body.push({ op: "call", funcIdx: ctorIdx });
    if (!helpers.boxResult(ctx, body, ctorType.results.length > 0 ? ctorType.results[0] : undefined)) continue;

    const typeIdx = addFuncType(
      ctx,
      params.map(() => ({ kind: "externref" as const })),
      [{ kind: "externref" }],
      `$${exportName}_type`,
    );
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name: exportName, typeIdx, locals: [], body, exported: true } as WasmFunction);
    exportFunc(ctx.mod, exportName, funcIdx);
    ctx.funcMap.set(exportName, funcIdx);
  }
}
