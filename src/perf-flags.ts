// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) The TUNED SET — the eleven emission flags flipped to default-ON, and
 * the one token rule the boolean-shaped members of the family share.
 *
 * ## What changed, and what it costs
 *
 * Every one of these shipped default-OFF behind a *byte-identity-when-unset*
 * guarantee: with the variable absent the compiler emitted exactly the bytes it
 * emitted before the flag existed. The 2026-08-13 wall measurement (entry 34 of
 * `plan/issues/4157-close-the-acorn-node-performance-gap.md`) put the selected
 * eleven at **−12.0 % wall** on the acorn self-parse lane, order-reversed, with
 * a completed `-O4` on every block — the largest improvement recorded in that
 * issue — so the project lead flipped them on.
 *
 * **The byte-identity guarantee therefore INVERTS.** Unset now means tuned-ON.
 * The legacy emission is still reachable, and reaching it is the *only* revert:
 * set every flag in the table below to `0`. `=0`-everything is asserted
 * sha256-identical to the pre-flip unset build (2,487,935 B,
 * `d70f9e3a7099d4997fcc5ebb3f7a25fe502c752d3edfc0731b526ef6ea80879c`, workload
 * checksum 422).
 *
 * | flag | default when unset | OFF | notes |
 * | --- | --- | --- | --- |
 * | `JS2WASM_INLINE_PROP_IC` | `8` | `0` | candidate ceiling; `=N` still selects N |
 * | `JS2WASM_INLINE_TRUTHY_IC` | `1` | `0` | the two-arm `anyval,boxbool` profile — **not** `all` |
 * | `JS2WASM_IR_INLINE` | `on` | `0` | adapters + single-caller + loop-leaf + specialise |
 * | `JS2WASM_FUSED_TONUMBER` | on | `0` | boolean |
 * | `JS2WASM_SMI_FASTPATH` | `all` | `0` | `=1` still selects the cheap i32-only level |
 * | `JS2WASM_LAZY_STR_FLATTEN` | on | `0` | boolean |
 * | `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` | on | `0` | boolean |
 * | `JS2WASM_INLINE_HINTS` | `1` | `0` | the `cold` wasm-opt profile |
 * | `JS2WASM_SET_MEMBER_F64` | on | `0` | boolean |
 * | `JS2WASM_RECEIVER_CSE` | on | `0` | boolean |
 * | `JS2WASM_EXTERN_GET_IC` | `1` | `0` | `=census` still selects the counting mode |
 *
 * `JS2WASM_INLINE_TRUTHY_IC` is deliberately `1` and not `all`: entry (23)
 * measured the `boxnum` and `bigint` arms firing **zero** times on acorn while
 * costing +121 KB between them, and entry (29) measured arm maximisation as a
 * net wall REGRESSION. The default is a selection, not a maximum.
 *
 * ## The token rule
 *
 * Unset ⇒ the tuned default. `0` / `off` / `false` / `no` / empty ⇒ OFF.
 * Case-insensitive, whitespace-trimmed. **Anything else — including a typo —
 * is the tuned default**, never a partially-enabled state.
 *
 * The asymmetry is the same one `src/derivation-flags.ts` documents and is
 * deliberate in the same direction: a malformed value fails to *disable*, which
 * for a flag whose OFF position exists to be a one-variable revert is the safe
 * failure. Empty (`JS2WASM_X=`, the shape a shell emits for an unset variable it
 * forwards anyway) disables, because an empty string is far more likely to mean
 * "I tried to turn this off".
 *
 * This module is a LEAF with no imports, so nothing can cycle through it — the
 * same constraint `derivation-flags.ts` is built under, and the reason the two
 * are separate files: that family gates *analyses* whose OFF position is a
 * revert of a derivation, this one gates *emission* on hot paths.
 */

/** Values that mean "off" under the tuned-set token rule. */
const OFF_TOKENS = new Set(["", "0", "off", "false", "no"]);

/**
 * The family's shared token rule: `false` only for an explicit off-token.
 * Exported for the tests that pin the spelling; production code should call the
 * named predicate its own module exposes.
 */
export function tunedFlagEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !OFF_TOKENS.has(raw.trim().toLowerCase());
}

/**
 * Did the operator actually ask for this flag, as opposed to inheriting the
 * tuned default?
 *
 * Used only to keep the per-pass "the mechanism fired" summary lines off a
 * DEFAULT build's stderr. Those lines exist because #4157 twice recorded a
 * confident null from a mechanism that was never enabled; that evidence is
 * worth printing when someone is deliberately experimenting with a flag and is
 * pure noise on every ordinary compile now that the passes run by default.
 */
export function tunedFlagExplicit(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() !== "";
}

/**
 * (#4405) The OPT-IN member of the same family: unset ⇒ **OFF**.
 *
 * The tuned eleven above inverted their default because they were measured and
 * flipped. A flag that has not been through that gate must not inherit the
 * inverted default — a new mechanism shipping ON-when-unset is exactly the
 * shape that makes "byte-identical when off" untestable, because there is no
 * "off" until someone sets a variable they do not know exists.
 *
 * The OFF tokens are the family's, so a flag can be turned off the same way
 * whichever default it carries; only the treatment of `undefined` differs.
 */
export function optInFlagEnabled(raw: string | undefined): boolean {
  return tunedFlagExplicit(raw) && tunedFlagEnabled(raw);
}
