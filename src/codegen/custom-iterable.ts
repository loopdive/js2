// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared lowering for **user-defined iterables** — an object literal / value
 * whose struct carries a `[Symbol.iterator]()` method (registered as
 * `${structName}_@@iterator`), e.g.
 *
 *   const obj = { [Symbol.iterator]() { return { next: () => … }; } };
 *
 * `for-of` already drives these via the iterator protocol
 * (`__iterator` + `__iterator_next`, the JS-host bridge that calls
 * `obj[Symbol.iterator]()` then `iter.next()` at runtime). Spread (`[...obj]`)
 * and array-destructuring (`const [a, b] = obj`) historically did NOT: spread
 * fell into the generic vec-struct path and read the iterator-closure field as
 * an i32 length (invalid wasm — `i32.add expected i32, found externref`), and
 * destructuring read non-existent numeric struct fields (NaN). Spec
 * §13.2.4.1 / §8.6.2: both are GetIterator consumers, exactly like for-of.
 *
 * This module exposes a "drain the iterable into a fresh vec via the iterator
 * protocol" emitter so spread routes through the same
 * `__iterator`/`__iterator_next` primitives for-of uses. Destructuring does
 * NOT use it (#7424): a pattern takes only `elements.length` steps and must
 * IteratorClose an unfinished iterator, which the bounded
 * `__array_from_iter_n` drive does and this full drain cannot.
 *
 * Scope: this targets the JS-host iterator bridge (`__iterator` /
 * `__iterator_next`), which handles arbitrary iterable shapes (arrow-`next`
 * iterators, Map/Set, etc.). The standalone/WASI native iterator runtime only
 * covers canonical `$Vec` producers today (#1320 Slice 1), so a generic object
 * iterable still traps there under for-of as well — out of scope here.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import type { Instr, ValType } from "../ir/types.js";
import { coerceType, getVecInfo } from "./type-coercion.js";
import { collectInstrs } from "./statements/shared.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * True when `srcType` is a `ref`/`ref_null` to a struct that defines a
 * `[Symbol.iterator]()` method (registered as `${structName}_@@iterator`), and
 * is therefore a user-defined iterable that should be drained through the
 * iterator protocol rather than treated as a vec.
 *
 * Known vecs, native generators, native strings and externref JS iterables are
 * handled by earlier branches at the call sites; this only fires for the
 * object-literal / class-instance iterable case those branches don't cover.
 */
export function isCustomIterable(ctx: CodegenContext, srcType: ValType): boolean {
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return false;
  const structTypeIdx = srcType.typeIdx;
  let structName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === structTypeIdx) {
      structName = name;
      break;
    }
  }
  if (!structName) return false;
  // A registered `@@iterator` method is the brand of a user-defined iterable.
  return ctx.funcMap.has(`${structName}_@@iterator`);
}

/**
 * (#7424) When `type` is a user-defined iterable, copy an externref view of the
 * value in `local` into a fresh local and return that local; otherwise return
 * `undefined` and emit nothing. Array destructuring hands the view to its
 * externref lane, whose bounded `__array_from_iter_n` drive steps the pattern
 * and IteratorCloses an unfinished iterator.
 */
export function customIterableExternrefView(
  ctx: CodegenContext,
  fctx: FunctionContext,
  local: number,
  type: ValType,
): number | undefined {
  if (!isCustomIterable(ctx, type)) return undefined;
  const view = allocLocal(fctx, `__dparam_iter_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: local }, { op: "extern.convert_any" }, { op: "local.set", index: view });
  return view;
}

/**
 * Drain a user-defined iterable into a freshly built vec struct of element type
 * `vecTypeIdx` via the iterator protocol, leaving `ref_null $vec` on the stack.
 * The iterable value must already be stored in `iterableLocal` (a `ref`/
 * `ref_null` to the iterable struct).
 *
 * Emits (using the `__iterator` / `__iterator_next` JS-host bridge):
 *   iter = __iterator(extern(obj))        // calls obj[Symbol.iterator]()
 *   cap = 4; data = new arr[cap]; len = 0
 *   loop:
 *     (done, val) = __iterator_next(iter)
 *     if done break
 *     if len == cap: grow (double, array.copy)
 *     data[len] = coerce(val: externref -> elemType); len++
 *   struct.new $vec { len, data }
 *
 * Mirrors the doubling-array drain the #1749 override-spread path uses. Returns
 * `false` (emitting nothing) when the vec type can't be resolved or the
 * iterator imports are unavailable, so the caller can fall back.
 */
export function emitDrainCustomIterableToVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  iterableLocal: number,
  iterableType: ValType,
  vecTypeIdx: number,
): boolean {
  const vecInfo = getVecInfo(ctx, vecTypeIdx);
  if (!vecInfo) return false;
  const arrTypeIdx = vecInfo.arrTypeIdx;
  const elemType = vecInfo.elemType;

  // Register the iterator-protocol imports (no-op if already present, e.g. a
  // for-of earlier in the function pulled them in). These shift function
  // indices, so flush before emitting any `call`.
  const iterIdx = ensureLateImport(ctx, "__iterator", [{ kind: "externref" }], [{ kind: "externref" }]);
  const nextIdx = ensureLateImport(
    ctx,
    "__iterator_next",
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (iterIdx === undefined || nextIdx === undefined) return false;

  const iterLocal = allocLocal(fctx, `__citer_iter_${fctx.locals.length}`, { kind: "externref" });
  const capLocal = allocLocal(fctx, `__citer_cap_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__citer_len_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__citer_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const growLocal = allocLocal(fctx, `__citer_grow_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const doneLocal = allocLocal(fctx, `__citer_done_${fctx.locals.length}`, { kind: "i32" });
  const valLocal = allocLocal(fctx, `__citer_val_${fctx.locals.length}`, { kind: "externref" });

  // Build the value-coercion template (externref -> elemType) FIRST: coerceType
  // may register late imports (e.g. __unbox_number for an f64 vec) that shift
  // indices, so they must be registered + flushed before we emit the drive's
  // `call __iterator_next` (whose funcIdx would otherwise be stale). (#1749)
  const valueCoerce = collectInstrs(fctx, () => {
    fctx.body.push({ op: "local.get", index: valLocal });
    coerceType(ctx, fctx, { kind: "externref" }, elemType);
  });
  flushLateImportShifts(ctx, fctx);
  // Re-read funcIdx after the coerce template's potential import additions.
  const driveIterIdx = ctx.funcMap.get("__iterator") ?? iterIdx;
  const driveNextIdx = ctx.funcMap.get("__iterator_next") ?? nextIdx;

  // iter = __iterator(extern(obj))
  fctx.body.push({ op: "local.get", index: iterableLocal });
  coerceType(ctx, fctx, iterableType, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: driveIterIdx });
  fctx.body.push({ op: "local.set", index: iterLocal });

  // cap = 4; data = new arr[cap]; len = 0
  fctx.body.push({ op: "i32.const", value: 4 });
  fctx.body.push({ op: "local.set", index: capLocal });
  fctx.body.push({ op: "local.get", index: capLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // grow: cap *= 2; grow = new arr[cap]; array.copy grow[0..len] = data; data = grow
  const growInstrs = collectInstrs(fctx, () => {
    fctx.body.push({ op: "local.get", index: capLocal });
    fctx.body.push({ op: "i32.const", value: 2 });
    fctx.body.push({ op: "i32.mul" });
    fctx.body.push({ op: "local.set", index: capLocal });
    fctx.body.push({ op: "local.get", index: capLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: growLocal });
    fctx.body.push({ op: "local.get", index: growLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.get", index: growLocal });
    fctx.body.push({ op: "local.set", index: dataLocal });
  });

  // loop body: (done, val) = __iterator_next(iter); if done break; grow if full;
  // data[len] = coerce(val); len++.
  const loopBody: Instr[] = [];
  loopBody.push({ op: "local.get", index: iterLocal });
  loopBody.push({ op: "call", funcIdx: driveNextIdx });
  loopBody.push({ op: "local.set", index: valLocal }); // value (top of multi-value)
  loopBody.push({ op: "local.set", index: doneLocal }); // done (below)
  loopBody.push({ op: "local.get", index: doneLocal });
  loopBody.push({ op: "br_if", depth: 1 }); // done → break
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "local.get", index: capLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] });
  loopBody.push({ op: "local.get", index: dataLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  for (const instr of valueCoerce) loopBody.push(instr);
  loopBody.push({ op: "array.set", typeIdx: arrTypeIdx });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: lenLocal });
  loopBody.push({ op: "br", depth: 0 }); // continue

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Trim `data` to exactly `len`. The growable buffer is over-allocated (its
  // `array.len` is the doubled capacity, ≥ len), but the canonical `$vec`
  // invariant is `array.len(data) === $length` — vec consumers such as the
  // typed-array destructure read out-of-bounds against `array.len`, not the
  // `$length` field, so a capacity-padded backing array would mask
  // out-of-range elements as default-fill values instead of `undefined`
  // (breaking binding defaults like `const [a, b, c, d = 99] = obj`). Copy the
  // live prefix into a right-sized array.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: growLocal });
  fctx.body.push({ op: "local.get", index: growLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });

  // struct.new $vec { len, trimmed-data } — leave ref $vec on the stack.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: growLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return true;
}
