// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5357) The reference-equality arm of `===` / `!==` (and `==` / `!=`) for an
 * operand pair whose §6.1 `Type()` cannot be decided from the static types —
 * in ONE place for both lanes, so a scalar that meets a reference is compared
 * by the language's own algorithm instead of a ToNumber collapse.
 *
 * ## The defect
 *
 * `x === false` answered `true` when `x` was a nullish REFERENCE. The tail of
 * the externref-equality block in `binary-ops-typed-dispatch.ts` widened the
 * Boolean to `f64`, put the reference through `__unbox_number` (§7.1.4
 * ToNumber: `null → 0`, `"0" → 0`, `true → 1`, `[0] → 0`) and compared with
 * `f64.eq` — `Number(null) === Number(false)`. §7.2.16 step 1 says
 * `Type(x) ≠ Type(y)` ⇒ `false`, with no coercion at all. The arm that
 * implements that — `__host_eq` (JS `===`) in the host lane, the #1776 tag
 * dispatch under `semanticProviders === "native-first"` — excluded the pair
 * twice: once because a Boolean scalar is an `i32`, not an `externref`, and
 * once because its static type IS Boolean. So a `const n = null`, a call typed
 * `null | string`, and above all an `any`-typed `onEnter?.(doc) === false`
 * (prettier's `traverseDoc`; `tests/unit/is-empty-doc.js` 7/16) all fell into
 * the collapse. The same collapse made `x === true` answer `true` for an `x`
 * holding the number `1`.
 *
 * ## The fix
 *
 * Box the scalar by its BRAND — a Boolean through `__box_boolean`, so its
 * runtime tag stays Boolean (`coerceType`'s #2785 arm; the bare number box
 * turns `true` into `1`, which is exactly the `x === true` defect one level
 * down) — then compare in the lane's reference arm:
 *
 * - host lane: `__host_eq` / `__host_loose_eq`, emitted by
 *   `emitHostEqualityFromStack` (coercion-engine.ts), which stays the single
 *   place that names those imports;
 * - native-first: `__extern_strict_eq` (#1461 — `ref.eq` identity, then the
 *   `$AnyValue` primitive comparison) for `===`, and `__any_eq` through
 *   `emitAnyEqFromExternTemps` for `==`.
 *
 * The typed dispatch's native tag-dispatch block returns for every externref
 * pair before the collapse is reached (measured: the whole #5357 matrix already
 * answers correctly under `--target standalone` and `native-first`), so today
 * only the host lane reaches the new call site. The native branch keeps the
 * semantics in one place should that gate ever move.
 *
 * Loose equality has the same nullish hole one step over: §7.2.15 steps 9-10
 * ToNumber the Boolean and recurse, and steps 2-3 make `null` / `undefined`
 * loosely equal only each other — but the collapse read `Number(null)` as `0`,
 * so `null == false` and `null == 0` answered `true`.
 * `emitLooseScalarVsReferenceEquality` decides the nullish case with
 * `ref.is_null` and keeps the (otherwise correct) ToNumber comparison for a
 * non-nullish reference.
 */
