// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1888 S5c) Struct-accessor capturing-closure rework — shared C1 layer.
 *
 * ## Why
 * `Object.defineProperty(o,k,{get(){…}})` / `{ get x(){} }` on `const o:any={}`
 * route to the static-struct accessor path (#1629 S3, object-ops.ts ~958-1171),
 * which compiles `${structName}_get_${prop}` as a BARE `(this) -> result` Wasm
 * function with NO closure-capture environment. A getter/setter body that closes
 * over OUTER scope therefore reads those captures as 0 (sd-1888 root cause). S5c
 * re-represents such accessors as host-free CLOSURES (capturing env via
 * `compileArrowAsClosure`, `this` via `__current_this`), dispatched through the
 * S5b `__call_accessor_get/set` drivers at the read/write sites.
 *
 * ## Representation (arch-s5c spec, signed off by sd-1888)
 * - STORAGE: per-(struct,prop) nullable `(mut externref)` module globals
 *   `$__acc_get_<struct>_<prop>` / `$__acc_set_<struct>_<prop>` holding the boxed
 *   `$Closure` (same shape as S5b's `$PropEntry.$get/$set`). Module globals — NOT
 *   struct slots — so the closed-struct layout / #1472-R2 fast path is untouched.
 * - CAPTURE-THREADING: NOT at the call site. Captures are baked into the
 *   closure's `$self` by `compileArrowAsClosure`; `this` via `__current_this`
 *   (#1636-S1). The dispatched value IS the capture-bearing wrapper — exactly
 *   what fixes the `__call_fn_method_N` mismatch (defect-1).
 * - REGRESSION SCOPE: ONLY the `Object.defineProperty` struct arm + the
 *   object-literal-standalone arm migrate. Class-accessor emission
 *   (#459/#1680/#1681/#1605) stays on the proven bare-fn path — the read/write
 *   sites gate dispatch on `ctx.structAccessorClosure.has(key)`.
 *
 * ## Flag
 * `S5C_STRUCT_ACCESSOR_CLOSURE` is now **true** (C1-C5 wired + validated: 4 S5c
 * tests green, 3 S5b regression-guard tests green, GC-mode byte-identical). It
 * landed dark (false) through C1-C5 and was flipped on in the C3/C4/C5 PR.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileArrowAsClosure } from "./shared.js";

/**
 * (#1888 S5c) Master gate — keep the struct-accessor closure rework DARK until
 * C1-C5 are wired + validated. Flip to `true` in the C5 PR once the S5c RED
 * tests pass and S5b/GC regression guards hold.
 */
export const S5C_STRUCT_ACCESSOR_CLOSURE = true;

/** Module-global name for a struct accessor's getter closure slot. */
export function structAccessorGetGlobalName(structName: string, propName: string): string {
  return `$__acc_get_${structName}_${propName}`;
}

/** Module-global name for a struct accessor's setter closure slot. */
export function structAccessorSetGlobalName(structName: string, propName: string): string {
  return `$__acc_set_${structName}_${propName}`;
}

/**
 * Compile a struct accessor getter/setter as a host-free CLOSURE and leave its
 * externref (capture-bearing `$Closure`, ready to box into a per-(struct,prop)
 * global) on the stack. Returns `false` when the lift could not be performed
 * (caller falls back). Mirrors the standalone branch of object-ops.ts
 * `emitAccessorFn` so the open-`$Object` S5b arm and the struct arm share one
 * lift; only the storage target differs (S5b → `__defineProperty_accessor`
 * arg; S5c struct → `global.set $__acc_get/set_…`).
 *
 * The closure's body captures outer-scope reads into its `$self` struct
 * (compileArrowAsClosure) and observes `this` via `__current_this` at invoke
 * time (#1636-S1) — so the dispatched value carries the env the bare-fn lacked.
 */
export function buildAccessorClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  const closureType = compileArrowAsClosure(ctx, fctx, fn);
  if (!closureType) return false;
  // compileArrowAsClosure leaves a closure-struct ref; the closure globals + the
  // S5b __call_accessor_get/set drivers take externref. Convert unless already so.
  if (closureType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  return true;
}

/**
 * Reserve (idempotently) the per-(struct,prop) nullable `(mut externref)` module
 * global holding a struct accessor's getter or setter closure, and record it in
 * `ctx.structAccessorClosure[key]`. Returns the global index. Initialised to
 * `ref.null.extern`; the C2 define-site `global.set`s the lifted closure.
 *
 * `kind` selects the get vs set slot. Reusing an already-reserved slot (e.g. a
 * redefine of the same accessor) returns the existing index.
 */
export function ensureStructAccessorGlobal(
  ctx: CodegenContext,
  structName: string,
  propName: string,
  kind: "get" | "set",
): number {
  const key = `${structName}_${propName}`;
  let entry = ctx.structAccessorClosure.get(key);
  if (!entry) {
    entry = {};
    ctx.structAccessorClosure.set(key, entry);
  }
  const existing = kind === "get" ? entry.getGlobal : entry.setGlobal;
  if (existing !== undefined) return existing;

  const name =
    kind === "get"
      ? structAccessorGetGlobalName(structName, propName)
      : structAccessorSetGlobalName(structName, propName);
  // ABSOLUTE global index — `global.get`/`global.set` instruction operands index
  // the imported-globals space first, then defined globals. Mirror the
  // async-scheduler convention (`baseGlobalIdx = ctx.numImportGlobals +
  // ctx.mod.globals.length`, async-scheduler.ts:263). Returning the bare
  // `ctx.mod.globals.length` (relative) would mis-address when any host global
  // is imported (e.g. the string-import base under non-strict modes).
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name,
    type: { kind: "externref" } as ValType,
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  if (kind === "get") entry.getGlobal = globalIdx;
  else entry.setGlobal = globalIdx;
  return globalIdx;
}

/*
 * ── C3/C4/C5 dispatch-site map (sd-1888 scope, await arch-s5c line-level spec) ──
 *
 * C2 (DONE) populates `ctx.structAccessorClosure[key]` + the per-(struct,prop)
 * globals at the `Object.defineProperty` struct define-site. The remaining
 * slices flip a closure-routing branch at each dispatch site, gated on
 * `ctx.structAccessorClosure.has(`${structName}_${propName}`)` (so ONLY the
 * migrated open-`any`/struct accessors route through the closure; class
 * accessors stay on the bare-fn path — arch-s5c "do NOT migrate class-accessor").
 * All routes call the SAME S5b drivers (`__call_accessor_get/set` →
 * `__call_fn_method_0/1`), boxing the receiver struct ref to externref first.
 *
 * C3 — READ. The struct-getter bare-fn call lives at
 *   property-access.ts:870-882 (`accessorKey=${structName}_${propName}`,
 *   `getterName=${structName}_get_${propName}`, `classAccessorSet.has && call
 *   getterIdx`). Parallel read arms that resolve the same accessorKey and would
 *   also need the gate when the receiver is a migrated struct: property-access.ts
 *   1689, 2410, 3369, 3426 (class-only, skip), 3642. Closure route: box recv→
 *   externref, `global.get` the get-slot, `call __call_accessor_get(recv,getter)`.
 *
 * C4 — WRITE. The struct-setter bare-fn call lives at
 *   expressions/assignment.ts:2334-2375 (`accessorKey=${typeName}_${fieldName}`,
 *   `setterName=${typeName}_set_${fieldName}`, `emitSetterCallWithDummy`).
 *   Parallel write arms: assignment.ts 2592, 2630 (class-only, skip), 2696, 2966.
 *   Closure route: box recv→externref, `global.get` the set-slot,
 *   `call __call_accessor_set(recv,setter,value)`.
 *
 * C5 — OBJLIT. The object-literal `{ get x() {} }` accessor compile-site is
 *   literals.ts:~1409/1497 (`${typeName}_get/set_${propName}` + classAccessorSet.add).
 *   Mirror C2 there (lift via buildAccessorClosure → global.set under the flag +
 *   the regime flag). NOTE: the objlit-standalone S5c test currently surfaces a
 *   separate `u32 out of range: -1` emit error in this path — diagnose as part of
 *   C5, it is pre-existing and unrelated to the closure rework.
 */

/**
 * (#3076) Is this object literal the RECEIVER argument of an
 * `Object.defineProperty/defineProperties` (or `Reflect` twin) call?
 *
 * Why it matters: the standalone runtime descriptor store
 * (`__defineProperty_value` / `__defineProperty_accessor`) is a lenient no-op
 * on a non-`$Object` receiver. TS's generic `defineProperty<T>(o: T, …)` gives
 * an inline `{}` receiver a CONCRETE empty contextual type, so
 * `compileObjectLiteral`'s any-context arm never fires and the literal lowers
 * to a closed struct — the accessor is then silently dropped, and every later
 * read (member read AND destructuring GetV, §13.3.3.7 step 4) returns
 * undefined instead of firing a poisoned getter (the canonical test262
 * `dstr/*obj-ptrn-*get-value-err` / `*ary-ptrn-*-iter-val-err` shapes).
 * `compileObjectLiteral` uses this predicate (standalone/wasi only) to build
 * such a receiver as an open `$Object` via `__new_plain_object`, which the
 * native store and the `__extern_get` accessor dispatch (#1888 S5b) service
 * end-to-end. The JS-host import stores descriptors in an identity-keyed
 * sidecar, so the host lanes never need this routing — the predicate returns
 * false outside standalone/wasi, keeping those lanes byte-identical.
 */
export function isDefinePropertyReceiverLiteral(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  let node: ts.Node = expr;
  while (
    node.parent &&
    (ts.isAsExpression(node.parent) || ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent))
  ) {
    node = node.parent;
  }
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
    (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
  );
}
