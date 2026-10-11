// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster G, slice G4) Array destructuring ASSIGNMENT over a value that
 * is not iterable must throw (§13.15.5.2 → §7.4.1 GetIterator step 3.b: the
 * `@@iterator` method is undefined → TypeError), standalone / WASI.
 *
 * The native materialiser `__array_from_iter_n` intentionally passes a
 * non-drainable source through to the indexed readers (#2904 — array-likes,
 * typed vecs and native strings are read positionally there), so it can never
 * be the place that decides "not iterable". Two sources reach it that are
 * NEVER array-like and must throw instead of binding `undefined`:
 *
 * 1. a `$Symbol` carrier (`for ([,] of [Symbol()])`,
 *    `for-of/dstr/array-elision-val-symbol.js`) — a runtime test, emitted only
 *    when the module already registered the carrier type;
 * 2. a closed WasmGC struct whose static type PROVABLY has no `[Symbol.iterator]`
 *    member (`[a] = { x: 1 }`) — a compile-time fact from
 *    `ctx.oracle.wellKnownSymbolMemberOf`, which answers `false` only when every
 *    constituent type was resolvable and none declares the member. The fact is
 *    not trusted when the module could make ANY object iterable after the fact:
 *    an `Object.prototype[…]` / `Array.prototype[…]` write or descriptor define
 *    (`ctx.protoIndexDirty`), or dynamic code (`ctx.dynamicCodeDirty`), both set
 *    by the `scanForArrayHoles` pre-pass before bodies compile — nor when the
 *    file's text could install one on this object (see `LATE_ITERATOR_INSTALL`).
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureNonIterableThrowDeps, nonIterableThrowInstrs } from "./iterator-errors.js";

/** Text through which a program could give `Symbol` values an `@@iterator`. */
const SYMBOL_PROTO_REACH = /Symbol\.prototype|setPrototypeOf|__proto__/;

/**
 * Throw `TypeError` when the externref in `local` is a `$Symbol` carrier.
 * Emits nothing outside standalone / WASI or when no symbol carrier exists.
 */
export function emitSymbolNotIterableGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  local: number,
  site: ts.Node,
): void {
  if ((!ctx.standalone && !ctx.wasi) || ctx.symbolTypeIdx < 0) return;
  // GetIterator(symbol) consults `%Symbol.prototype%` / `%Object.prototype%`:
  // a program that can reach either can make symbols iterable.
  if (ctx.protoIndexDirty === true || ctx.dynamicCodeDirty === true) return;
  if (SYMBOL_PROTO_REACH.test(site.getSourceFile().text)) return;
  ensureNonIterableThrowDeps(ctx);
  const throwInstrs = nonIterableThrowInstrs(ctx);
  if (throwInstrs === undefined) return;
  fctx.body.push(
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] },
  );
}

/**
 * Text that could install an `@@iterator` on an object AFTER the checker typed
 * it: an expando / `defineProperty` / `Object.assign` keyed by the well-known
 * symbol (every spelling names `iterator`), or a prototype swap. The checker
 * does not see a symbol-keyed expando on a JS object literal — measured:
 * `var q = { x: 1 }; q[Symbol.iterator] = f; [a, b] = q` types `q` as
 * `{ x: number }` and iterates at run time.
 */
const LATE_ITERATOR_INSTALL = /\biterator\b|setPrototypeOf|__proto__/;

const lateInstallCache = new WeakMap<ts.SourceFile, boolean>();

function fileMayInstallIteratorLate(sf: ts.SourceFile): boolean {
  let v = lateInstallCache.get(sf);
  if (v === undefined) {
    v = LATE_ITERATOR_INSTALL.test(sf.text);
    lateInstallCache.set(sf, v);
  }
  return v;
}

/**
 * True when `value` (the RHS of an array assignment pattern, already lowered
 * to a non-vec, non-tuple struct) can be proved non-iterable at compile time.
 * Deliberately narrow: the source file must not mention `iterator` or a
 * prototype swap anywhere, so no statement can have given the object an
 * `@@iterator` the static type does not show.
 */
export function isProvablyNonIterableStructSource(ctx: CodegenContext, value: ts.Expression): boolean {
  if (!ctx.standalone && !ctx.wasi) return false;
  if (ctx.protoIndexDirty === true || ctx.dynamicCodeDirty === true) return false;
  if (fileMayInstallIteratorLate(value.getSourceFile())) return false;
  return ctx.oracle.wellKnownSymbolMemberOf(value, "iterator") === false;
}
