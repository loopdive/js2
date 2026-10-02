// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H6) A Proxy on the standalone ARRAY-LIKE substrate.
 *
 * The §23.1.3 generics, and every other array-like consumer (`Array.from`,
 * CreateListFromArrayLike, the `__arrprod_*` producers), read an operand with
 * three natives: `__extern_length` (§7.3.18 `ToLength(? Get(O, "length"))`),
 * `__extern_get_idx` (`? Get(O, ToString(k))`) and `__extern_has_idx`
 * (`? HasProperty(O, ToString(k))`). Each had an arm for an array-like
 * `$Object` — and a `$Proxy` is not an `$Object`, so all three answered
 * `0` / `undefined` / `false` for EVERY proxy. Measured on base, standalone:
 * `Array.prototype.map.call(<revoked proxy>, cb)` returned an empty array
 * instead of throwing, a `get` trap answering `length: 2 ** 32` never ran, and
 * `[1].concat(new Proxy([7, 8], {}))` had length 1.
 *
 * The fix is to let a `$Proxy` take the `$Object` arm: the arm's work is
 * `__extern_get` / `__extern_has` with a string key, and those two natives
 * already own the §10.5.8 / §10.5.7 dispatch (revocation check, trap call,
 * invariant checks, trap-absent forwarding). Nothing proxy-specific is
 * re-implemented here.
 *
 * Gated on `ctx.proxyDirty` (the pre-scan saw the identifier `Proxy`), so a
 * Proxy-free module keeps its bytes.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** The `$Proxy` type index when the array-like arms should admit proxies. */
export function proxyArrayLikeTypeIdx(ctx: CodegenContext): number | undefined {
  return ctx.proxyDirty ? ctx.objectRuntimeTypes?.proxyTypeIdx : undefined;
}

/**
 * `local.get anyLocal; ref.test $Proxy; i32.or` — widens an `$Object` test
 * already on the stack to "`$Object` or `$Proxy`". Empty when the gate is off.
 */
export function orProxyArrayLikeTest(ctx: CodegenContext, anyLocal: number): Instr[] {
  const proxyTypeIdx = proxyArrayLikeTypeIdx(ctx);
  if (proxyTypeIdx === undefined) return [];
  return [{ op: "local.get", index: anyLocal }, { op: "ref.test", typeIdx: proxyTypeIdx }, { op: "i32.or" }];
}
