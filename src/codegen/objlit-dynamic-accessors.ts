// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5318 r5) Object-literal ACCESSOR members whose ComputedPropertyName is only
 * known when the literal is evaluated.
 *
 * `literals.ts`'s accessor pre-pass pairs `get x()` with `set x(v)` by resolving
 * each key to a compile-time string (`resolveAccessorPropName`). A key it cannot
 * fold — a symbol-valued variable, a call, `x || "k"` — used to be skipped
 * outright ("arbitrary computed key: out of scope"), so `{ get [s]() {} }`
 * installed NOTHING: the read answered `undefined`, and a later `A[s] = v`
 * quietly created a plain DATA property where the spec has an accessor. Nothing
 * threw; the object simply behaved as if the member had not been written.
 *
 * This is the object-literal twin of the mechanism #5318 r4 built for classes.
 * Two properties carry it:
 *
 *  - **No compile-time pairing.** Only the literal's evaluation knows which key
 *    expressions produce the same property key, so each half installs itself
 *    alone, at its own source position, evaluating its own key exactly once —
 *    which is also what §13.2.5.5 wants (`get [f()]` and `set [f()]` call `f`
 *    twice).
 *  - **Per-half "specified" bits.** The flag word marks WHICH half this call
 *    defines (bits 8/9), so §10.1.6.3 merges it into a live accessor under the
 *    same evaluated key instead of replacing both slots. Without them a
 *    `set [k]` following a `get [k]` blanks the getter — the same defect the
 *    class lane hit (`class-proto-accessors.ts::classAccessorInstallFlags`).
 *
 * A literal whose accessor keys all fold keeps the legacy encoding and its
 * modules are byte-identical on host, wasi and standalone.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";

/**
 * `__defineProperty_accessor` flags for an object-literal accessor:
 * `{enumerable: true, configurable: true}` (writable is N/A for an accessor
 * descriptor) — `computeRuntimeFlags(undefined, true, true, false)` from
 * `object-ops.ts`. Bits: enumerable_specified (1<<4) | enumerable_value (1<<1)
 * | configurable_specified (1<<5) | configurable_value (1<<2).
 */
export const OBJLIT_ACCESSOR_FLAGS = (1 << 4) | (1 << 1) | (1 << 5) | (1 << 2);

/** "This call defines the getter half" — see the module header. */
const ACCESSOR_GET_SPECIFIED = 1 << 8;
/** "This call defines the setter half". */
const ACCESSOR_SET_SPECIFIED = 1 << 9;

/**
 * The literal's accessor halves whose key does NOT fold at compile time, in
 * source order. `resolveKey` is injected (rather than imported from
 * `literals.ts`) to keep this module out of that file's import cycle; callers
 * pass the same `resolveAccessorPropName` the pairing pre-pass used, so the two
 * partitions of the literal's accessors are exactly complementary.
 */
export function collectDynamicAccessorHalves(
  ctx: CodegenContext,
  expr: ts.ObjectLiteralExpression,
  resolveKey: (ctx: CodegenContext, name: ts.PropertyName) => string | undefined,
): ts.AccessorDeclaration[] {
  const out: ts.AccessorDeclaration[] = [];
  for (const p of expr.properties) {
    if (!ts.isGetAccessorDeclaration(p) && !ts.isSetAccessorDeclaration(p)) continue;
    if (resolveKey(ctx, p.name) !== undefined) continue;
    if (!ts.isComputedPropertyName(p.name)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Emit one dynamic-keyed accessor half's install, leaving nothing on the stack.
 *
 * `emitKey` evaluates the ComputedPropertyName to an externref property key;
 * `emitHalf` compiles the accessor function to a callable externref and reports
 * whether it managed to. Both are injected for the same import-cycle reason as
 * {@link collectDynamicAccessorHalves}.
 *
 * On a declined half the key's side effects have already run (spec evaluation
 * order) and the property is simply not defined — the same decline the
 * runtime-keyed METHOD arm takes. A half-written install is NOT an option here:
 * with only one "specified" bit set, a null in the other slot reads as "this
 * half is absent", not "leave the sibling alone".
 */
export function emitDynamicObjectLiteralAccessorHalf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  half: ts.AccessorDeclaration,
  objLocal: number,
  defineAccessorIdx: () => number,
  emitKey: (expression: ts.Expression) => void,
  emitHalf: (half: ts.AccessorDeclaration, isGetter: boolean) => boolean,
): void {
  if (!ts.isComputedPropertyName(half.name)) return;
  const isGetter = ts.isGetAccessorDeclaration(half);
  const push = (instr: Instr): void => {
    fctx.body.push(instr);
  };
  push({ op: "local.get", index: objLocal });
  emitKey(half.name.expression);
  if (!emitHalf(half, isGetter)) {
    push({ op: "drop" });
    push({ op: "drop" });
    return;
  }
  // The stack must read [obj, key, getter|null, setter|null, flags]. A getter
  // half is already in its slot and only needs the null setter after it; a
  // setter half sits in the GETTER slot, so park it and re-push it after the
  // null.
  if (isGetter) {
    push({ op: "ref.null.extern" });
  } else {
    const tmp = allocLocal(fctx, `__objlit_dynset_${fctx.locals.length}`, { kind: "externref" });
    push({ op: "local.set", index: tmp });
    push({ op: "ref.null.extern" });
    push({ op: "local.get", index: tmp });
  }
  push({
    op: "f64.const",
    value: OBJLIT_ACCESSOR_FLAGS | (isGetter ? ACCESSOR_GET_SPECIFIED : ACCESSOR_SET_SPECIFIED),
  });
  push({ op: "call", funcIdx: defineAccessorIdx() });
  push({ op: "drop" }); // the helper returns the target; discard
}
