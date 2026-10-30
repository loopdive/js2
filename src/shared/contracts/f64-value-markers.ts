// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The f64 `undefined` and absence markers, shared by the legacy codegen
// (`codegen/value-tags.ts` re-exports them) and the IR lowering, which reads and
// writes the same vec slots (#7106). One definition, so the two can never
// disagree on a bit pattern.

/**
 * The undefined-in-f64 sentinel. It is a SIGNALING NaN — JS arithmetic only
 * ever produces the quiet NaN `0x7FF8000000000000`, so this bit pattern can
 * carry "undefined" through an f64 carrier without colliding with a computed
 * NaN. Observers in unsound contexts (`=== undefined`, `??`, `typeof`,
 * ToString) test for it; sound contexts (arithmetic, relational, ToBoolean)
 * ignore it because it already behaves as NaN.
 */
export const UNDEF_F64_BITS = 0x7ff00000deadc0den;

/**
 * (#4491 T11) The **absence** twin of {@link UNDEF_F64_BITS}: a second,
 * distinct signaling-NaN payload meaning *this index is not present*, as
 * opposed to *this index holds the value `undefined`*.
 *
 * The two must be distinct because they answer PRESENCE differently:
 * `[0, , 2]` and `[0, undefined, 2]` agree on every VALUE question (`x[1]` is
 * `undefined` for both, `join` renders `""` for both) and disagree on every
 * PRESENCE question (`1 in x`, `x.hasOwnProperty("1")`, `Object.keys(x)`, and
 * the §23.1.3 HOF hole-skip). One payload cannot carry both answers.
 *
 * Same signaling-NaN exponent as `UNDEF_F64_BITS`, so the same "JS arithmetic
 * only ever produces the QUIET NaN `0x7FF8000000000000`" argument applies: the
 * pattern cannot collide with a computed value.
 *
 * **Invariant** (inherited from `array-holes.ts`): a hole is never observed AS
 * the marker. Every value-producing read of a slot that may hold it maps
 * `HOLE → UNDEF` at the read boundary (`vec-f64-hole-presence.ts`), so the
 * existing `UNDEF_F64_BITS` observers keep working unchanged.
 */
export const HOLE_F64_BITS = 0x7ff00000deadc01en;
