// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6788) JS-host ToPrimitive for a compiled ARRAY carrier — and the ToString
 * tail for any struct carrier that reaches the host unreduced.
 *
 * ## The defect
 *
 * On the JS-host lane a `number[]` is a WasmGC vec struct. Measured 2026-09-30
 * against Node, several primitive-expecting entry points treated that struct
 * as if it were already a primitive:
 *
 * ```js
 * const arr: number[] = [0, 9, 0];
 * String(arr);       // the array itself — must be "0,9,0"
 * `${arr}`;          // the array itself
 * +[1];              // NaN — must be 1
 * Number([5]);       // NaN — must be 5
 * [] + [];           // NaN — must be ""
 * [1, 2] == "1,2";   // false — must be true
 * [10] < [9];        // false — must be true (two STRING primitives compare lexically)
 * ```
 *
 * String()/template ran the string-hint coercion, found no in-Wasm `toString`
 * on the vec, and returned the carrier. ToNumber handed the RAW vec to the host
 * `__to_primitive`, whose struct walker answers "[object Object]" → NaN. The
 * `+`/relational/`==` lowerings never ran the ToPrimitive step at all: they
 * applied ToNumber to the raw operand.
 *
 * ## The fix: OrdinaryToPrimitive of an array is its join
 *
 * For an array, `valueOf` returns the object itself, so OrdinaryToPrimitive
 * (any hint) reaches `Array.prototype.toString` — `join(",")`. The JS-host lane
 * already owns a value-level join that stringifies every element kind the vec
 * can hold, including struct and nested-vec elements: `__extern_join_str`,
 * the element stringifier `arr.join()`/`arr.toString()` use (#1998/#3637). On
 * a vec it recurses into `join(",")`. {@link emitHostArrayToPrimitive} applies
 * it, and each entry point then performs only its own final conversion:
 *
 *   - ToNumber (unary `+`, `Number()`, `-`/`*`/`**`/bitwise) — host ToNumber of
 *     the joined string ({@link emitHostArrayCarrierToNumber});
 *   - ToString (`String()`, template substitution, `String.raw`) — the joined
 *     string itself; a non-array struct with no in-Wasm `toString` gets the
 *     host ToString instead ({@link emitHostCarrierToStringTail});
 *   - `+`, relational, loose `==` — both operands are evaluated first, then the
 *     array side is reduced and the host operator applies the rest of
 *     §13.15.3 / §7.2.13 / §7.2.15 ({@link emitHostArrayCarrierBinary}).
 *
 * The `__make_iterable` host MIRROR is deliberately not the reduction path: it
 * keeps struct elements raw, and a host `join` over a raw WasmGC struct throws
 * "Cannot convert object to primitive value".
 *
 * ## Scope
 *
 * JS-host lane only ({@link hostLane}); standalone already reduces a vec
 * in-module (`array-to-primitive.ts`, #2358). The binary arms admit an operand
 * whose static fact is an ARRAY and never an `any`/`unknown`/string/bigint one,
 * so `arr + ""` (the reference spelling), `any + x` and BigInt arithmetic keep
 * their existing lowering. Loose equality is admitted only against a
 * primitive-typed other side: two objects compare by identity and never reach
 * ToPrimitive (§7.2.15 step 1), and `arr == null` keeps its nullish path.
 *
 * Known residue: a `boolean[]` vec stores i32 elements, so the value-level join
 * renders `[true]` as "1" — the same answer `arr + ""` gives today. The static
 * `arr.toString()` lowering, which can see the element type, is unaffected.
 */

/** The host operator an array-carrier binary expression needs (see {@link hostArrayCarrierBinaryArm}). */
export type HostArrayCarrierArm = "add" | "relational" | "loose-eq" | "identity";
