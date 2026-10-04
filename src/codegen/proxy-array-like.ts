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
import { ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./helpers/core-delegates.js"; // (#6797) late-bound core
import { arrayCtorThisCallSeen } from "./array/array-ctor-this.js"; // (#6771 S7)

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

/** `Array.prototype` members whose standalone `.call(p, …)` reads a Proxy `p` through the MOP. */
const PROXY_READING_BORROWS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "slice",
  "splice",
  "concat",
  "copyWithin",
]);

/** `Array.prototype.<m>` or `[].<m>` — the two spellings the borrow compiler claims. */
function borrowedArrayMethodName(callee: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const owner = callee.expression;
  const isArrayProto =
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "prototype" &&
    ts.isIdentifier(owner.expression) &&
    owner.expression.text === "Array";
  const isEmptyLiteral = ts.isArrayLiteralExpression(owner) && owner.elements.length === 0;
  return isArrayProto || isEmptyLiteral ? callee.name.text : undefined;
}

/**
 * (#6651 H6) Does `call` consume its argument `arg` through a standalone lowering
 * that reads a Proxy VALUE via the MOP? Then handing a Proxy binding to it is
 * not an ESCAPE in the #2615 sense (a typed consumer that `ref.cast`s the
 * externref carrier back to the target's struct), and the binding may keep the
 * open externref slot. Keeping the struct slot instead MATERIALIZES the proxy
 * into a copy at its declaration — every later trap, revocation and
 * `constructor` read then misses (`{map,filter,slice,splice,concat}/create-proxy.js`,
 * the `*-invalid-len.js` RangeError rows).
 *
 *  - `Array.prototype.<m>.call(p, …)` for `m` in {@link PROXY_READING_BORROWS},
 *    `p` the receiver: slice/splice/copyWithin take the array-like algorithm
 *    (`array-proxy-receiver.ts`), concat the §23.1.3.1 spec loop, map/filter
 *    read the receiver through the array-like trio and its `constructor` from
 *    the receiver itself;
 *  - any operand of `Array.prototype.concat.call(r, …)` or of `<array>.concat(…)`:
 *    the spec loop reads every operand (`concatOperandMayBeProxy`).
 *
 * Standalone only — the gc/host lane keeps its #2615 answer.
 */
export function arrayMethodReadsProxyOperand(
  ctx: CodegenContext,
  call: ts.CallExpression | ts.NewExpression,
  arg: ts.Expression,
): boolean {
  if (!ctx.standalone || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const argIndex = call.arguments.indexOf(arg);
  if (argIndex < 0) return false;
  const callee = call.expression;
  if (callee.name.text === "call") {
    const method = borrowedArrayMethodName(callee.expression);
    if (method === undefined || !PROXY_READING_BORROWS.has(method)) return false;
    return argIndex === 0 || method === "concat";
  }
  const fact = ctx.oracle.typeFactOf(callee.expression).kind;
  return callee.name.text === "concat" && (fact === "array" || fact === "tuple");
}

/**
 * (#6651 H6) Two readers turn an array-like's `__extern_length` into an Array
 * of that length: the externref→vec materializer (`buildVecFromExternref`) and
 * the array-like `map` loop (its result is ArraySpeciesCreate(O, len)). For a
 * Proxy the length is now the trapped `ToLength(Get(O, "length"))` — up to
 * 2^53 − 1 — and no Array can be longer than 2^32 − 1: §10.4.2.2 ArrayCreate
 * throws a RangeError, which is the answer the §23.1.3 producers give
 * (`{map,splice}/create-species-undef-invalid-len.js`, a `get` trap answering
 * `length: 2 ** 32`). Without the guard the saturating truncation fed
 * `array.new_default` 2^31 − 1 (a TRAP) or ran 2^31 loop iterations.
 *
 * Expects the f64 length on the stack and leaves it there. Empty unless the
 * module can hold a Proxy (`ctx.proxyDirty`) on the standalone lane. Call it
 * BEFORE the caller's late-import flush: the throw may register its
 * constructor.
 */
export function arrayLikeLengthLimitGuard(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  if (!ctx.standalone || !ctx.proxyDirty) return [];
  const lenF64 = allocLocal(fctx, `__vec_lenf_${fctx.locals.length}`, { kind: "f64" });
  const rangeError = buildThrowJsErrorInstrs(ctx, "RangeError", "Invalid array length", { flush: fctx });
  return [
    { op: "local.tee", index: lenF64 },
    { op: "f64.const", value: 4294967295 },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: rangeError },
    { op: "local.get", index: lenF64 },
  ];
}

/**
 * (#6651 H6) May a value TypeScript types as an Array be something else at run
 * time? `Object.getPrototypeOf(<Array-typed>)` is folded to `%Array.prototype%`
 * from the checker's type, and that fold is only sound while every
 * Array-typed value really is an Array. Two things break it, and the pre-scan
 * sees both:
 *
 *  - `ArraySpeciesCreate` (`ctx.arraySpeciesDirty`): `map`/`filter`/`slice`/
 *    `splice`/`concat` return whatever `constructor[@@species]` builds, still
 *    typed `T[]` — `Object.getPrototypeOf(Array.prototype.map.call(p, f))` is
 *    `Ctor.prototype` in `{map,filter,slice,splice,concat}/create-proxy.js`;
 *  - a Proxy (`ctx.proxyDirty`), typed as its target, whose [[GetPrototypeOf]]
 *    may be trapped.
 *
 * In such a standalone module the fold declines and the read happens at run
 * time, where `__getPrototypeOf`'s array arm (#6651 R1) still answers the
 * `%Array.prototype%` singleton for a genuine array.
 */
export function arrayTypedValueMayNotBeArray(ctx: CodegenContext): boolean {
  // (#6771 S7) …and a constructor-`this` `Array.from`/`Array.of` (array-ctor-this.ts).
  return ctx.standalone && (ctx.arraySpeciesDirty || ctx.proxyDirty === true || arrayCtorThisCallSeen(ctx));
}
