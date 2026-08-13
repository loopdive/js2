// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-free `value instanceof Object` / `value instanceof Function` for the
 * `noJsHost` (standalone / WASI) lane.
 *
 * ## Why the membership list could not answer these two
 *
 * `nativeBuiltinInstanceOfTypeIdxs` (#2916) answers a builtin RHS by OR-ing
 * `ref.test` over the backing struct types that builtin can produce. That works
 * for a builtin with ONE backing struct (`$__Date`, `$Promise`, …). It cannot
 * work for these two, for two independent reasons:
 *
 * 1. **`Object` has no finite backing-struct list.** EVERY non-primitive
 *    representation in the module is an `instanceof Object`: `$Object`, vecs,
 *    closures, `$Error_struct`, `$__Date`, `$__StandaloneRegExp`, `$Promise`,
 *    `$Map`, the three wrapper structs, every per-class and per-fnctor struct.
 *    #2916 therefore returned `undefined` for `Object` and the site fell back to
 *    a conservative `i32.const 0`, i.e. a hard `false`. The complement is what
 *    is enumerable, and it is short: null/undefined and the boxed primitives.
 *
 * 2. **The list is a SNAPSHOT taken at expression-lowering time.** Closures are
 *    registered in `ctx.closureInfoByTypeIdx` as their bodies are compiled, so
 *    `closureRootTypeIdxsFor(ctx)` at an `x instanceof Function` site that
 *    lowers BEFORE the relevant closure is registered returns `[]` — which the
 *    #2916 return contract reads as "no value can be an instance ⇒ definite
 *    `0`". Same hazard for the three wrapper structs (`ctx.wrapperNumberTypeIdx`
 *    is `-1` until `ensureWrapperTypes` runs). The answer was therefore
 *    ORDER-DEPENDENT: `f instanceof Function` answered `true` or `false`
 *    depending on where in the module the test appeared. This is exactly the
 *    hazard `fillStandaloneTypeofClosureArms` (#1896/#2175/#4120) exists to fix
 *    for the `typeof` natives — by rewriting the helper BODIES at finalize,
 *    once every closure is registered.
 *
 * ## The fix: reuse the finalize-corrected `typeof` natives
 *
 * `x instanceof Object` is, over the value representations this backend can
 * produce, exactly "`x` is not a primitive and not null/undefined" — i.e.
 * `typeof x === "object" (x !== null) || typeof x === "function"`. Both halves
 * already exist as standalone natives with complete, finalize-corrected
 * classifiers (`__typeof_object` / `__typeof_function`, `registry/imports.ts`
 * + `typeof-natives-finalize.ts`). Calling them keeps ONE classifier for the
 * whole backend instead of a second, silently-diverging copy — the same
 * argument `fillStandaloneTypeofClosureArms` makes for keeping the three
 * `typeof` natives in lockstep.
 *
 * `ensureLateImport` routes both names through `addUnionImportsViaRegistry`
 * under `noJsHost`, which registers them as DEFINED functions — no `env::`
 * import is added, so the module stays host-free and no index shift is
 * required (the #1471 invariant).
 *
 * ## Deliberate divergences from §7.3.20, and why they are safe here
 *
 * - **A null-prototype object** (`Object.create(null)`, `o.__proto__ = null`)
 *   is `typeof "object"` but NOT `instanceof Object`. This predicate answers
 *   `true` for it. Accepted: the alternative is the chain walk, which needs a
 *   runtime handle on `Object.prototype` that the standalone object model does
 *   not expose (the same gap `native-ordinary-instanceof.ts` documents for
 *   `FACTORY.prototype`).
 * - **Symbols** are primitives, so `sym instanceof Object` is `false`, but
 *   `__typeof_object` does not exclude the `$Symbol` carrier. We subtract it
 *   explicitly when the module registered one.
 *
 * ## Primitive wrappers use an internal-slot predicate, not this type list
 *
 * A historical experiment force-registered `$WrapperNumber` / `$WrapperString`
 * / `$WrapperBoolean` and regressed strict `fun.call(false)`. The corrected
 * diagnosis is representation-level: standalone constructors allocate a
 * `$Object` branded by the FLAG_INTERNAL `[[PrimitiveValue]]` slot, while strict
 * primitive receivers use native one-field box carriers. WasmGC structural type
 * equivalence made the obsolete `$WrapperBoolean` membership test match that
 * primitive carrier. The #4276 wrapper follow-up therefore lives in
 * `object-runtime.ts`: it requires the real `$Object` plus internal slot and
 * classifies the slot value. No phantom wrapper type is registered, so strict
 * primitive `this` remains false while real wrapper objects answer true.
 *
 * ## Why this cannot regress a passing test
 *
 * Same argument as #2916 / #3962, plus one addition:
 *  - the branch runs ONLY under `noJsHost`; the JS-host lane never enters this
 *    module and is byte-identical (asserted by sha256 A/B in the test suite);
 *  - under `noJsHost` the site it replaces emitted a hard `i32.const 0` for
 *    `Object` (a definite WRONG answer for every object) — anything is an
 *    improvement, and no `true`-expecting test can newly fail;
 *  - for `Function` the caller passes the old membership list as
 *    `fallbackTypeIdxs` and this emitter ORs it in, so the emitted predicate is
 *    pointwise ≥ the old one. A test that passed on the old `ref.test` list
 *    still gets `1` from that same list.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { noJsHost } from "./js-errors.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** The two builtin RHS names this module answers. */
export type ObjectFamilyCtorName = "Object" | "Function";

export function isObjectFamilyCtorName(name: string): name is ObjectFamilyCtorName {
  return name === "Object" || name === "Function";
}

/**
 * Emit `expr.left instanceof <Object|Function>` as a host-free i32 (0/1), or
 * return `null` to decline (the caller then keeps its existing lowering).
 *
 * `fallbackTypeIdxs` is the #2916 membership list the caller would otherwise
 * have used; it is OR-ed into the answer so the emitted predicate is never
 * weaker than the one it replaces. Pass `undefined` when there is none.
 */
export function tryEmitNativeObjectFamilyInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  ctorName: ObjectFamilyCtorName,
  fallbackTypeIdxs: number[] | undefined,
): ValType | null {
  if (!noJsHost(ctx)) return null;

  // Register (or look up) the finalize-corrected classifiers. Under `noJsHost`
  // these resolve to DEFINED functions, never to an `env::` import.
  const typeofFunctionIdx = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  const typeofObjectIdx =
    ctorName === "Object" ? ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]) : undefined;
  if (typeofFunctionIdx === undefined) return null;
  if (ctorName === "Object" && typeofObjectIdx === undefined) return null;
  flushLateImportShifts(ctx, fctx);

  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType && (leftType.kind === "i32" || leftType.kind === "f64" || leftType.kind === "i64")) {
    // §7.3.20 step 3 — an unboxed numeric/boolean primitive is never an object.
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, EXTERNREF);
  }
  // A FRESH ValType object per local — the shared `EXTERNREF` singleton is used
  // only for the (read-only) signature and coercion arguments.
  const valLocal = allocLocal(fctx, `__io_fam_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  const then: Instr[] = [{ op: "i32.const", value: 0 }];
  const otherwise: Instr[] = buildPredicate(
    ctx,
    valLocal,
    ctorName,
    typeofObjectIdx,
    typeofFunctionIdx,
    fallbackTypeIdxs,
  );

  // A null externref is JS `null` (and, outside the #2106-S1 regime, also
  // `undefined`). Neither is an object, and `typeof null === "object"` makes
  // `__typeof_object` answer 1 for it under S1 — so the null test must come
  // FIRST and separately.
  fctx.body.push({ op: "local.get", index: valLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then, else: otherwise });
  return { kind: "i32" };
}

function buildPredicate(
  ctx: CodegenContext,
  valLocal: number,
  ctorName: ObjectFamilyCtorName,
  typeofObjectIdx: number | undefined,
  typeofFunctionIdx: number,
  fallbackTypeIdxs: number[] | undefined,
): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: valLocal },
    { op: "call", funcIdx: typeofFunctionIdx },
  ];
  if (ctorName === "Object" && typeofObjectIdx !== undefined) {
    // A callable IS an object (`__typeof_object` deliberately excludes closures
    // so `typeof` answers "function"), so `instanceof Object` is the union.
    out.push({ op: "local.get", index: valLocal });
    out.push({ op: "call", funcIdx: typeofObjectIdx });
    out.push({ op: "i32.or" });
    // A symbol is a primitive; `__typeof_object` does not subtract the `$Symbol`
    // carrier, so do it here. `ref.test` on a non-matching anyref is 0 and never
    // traps.
    if (ctx.symbolTypeIdx >= 0) {
      out.push({ op: "local.get", index: valLocal });
      out.push({ op: "any.convert_extern" });
      out.push({ op: "ref.test", typeIdx: ctx.symbolTypeIdx });
      out.push({ op: "i32.eqz" });
      out.push({ op: "i32.and" });
    }
  }
  // Never weaker than the membership list this replaces (see the module header).
  for (const typeIdx of fallbackTypeIdxs ?? []) {
    if (typeIdx < 0) continue;
    out.push({ op: "local.get", index: valLocal });
    out.push({ op: "any.convert_extern" });
    out.push({ op: "ref.test", typeIdx });
    out.push({ op: "i32.or" });
  }
  return out;
}
