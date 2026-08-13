// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) `JS2WASM_LAZY_STR_FLATTEN` — stop forcing rope materialization where
 * the consumer does not need a flat buffer. **Default ON** since the tuned-set
 * flip; `=0` ⇒ the emitted binary is byte-identical to the flag-less compiler.
 *
 * ## What "forced but not required" means here
 *
 * The native-string backend is already a rope representation
 * (`$AnyString` ⊃ {`$NativeString`(flat), `$ConsString`(rope), `$Utf8String`}),
 * and `__str_flatten` is already an identity fast-return for an
 * already-flat input — the first thing in its body is
 * `ref.test $NativeString` → `ref.cast` → return
 * (`native-strings-core.ts`, `emitStrFlattenHelpers`). So neither "make
 * flatten cheap when already flat" nor "memoize the flattened form on the
 * rope" is available work: the identity return landed with the rope
 * representation, and `flattenConsBody` has memoized the cons in place
 * (`left = flat, right = ""`) since #3673.
 *
 * What is left is the two places the compiler materializes a rope to answer a
 * question that does not need one:
 *
 * 1. **`__str_equals` flattens BOTH operands before it looks at either.**
 *    Its params are `ref $AnyString` and its body is built through
 *    `wrapBodyWithFlatten(body, [0, 1])`, which prepends the guarded flatten
 *    preamble to the TOP of the function — ahead of the `ref.eq` identity
 *    check, ahead of the length compare, and ahead of the hash fast-reject.
 *    None of those three needs a flat buffer:
 *      - identity is `ref.eq` on the operands as given;
 *      - length is `$AnyString` field 0, which is the JS-visible code-unit
 *        count on **all three** subtypes (`ConsString` keeps the total across
 *        the in-place memoization rewrite — the field is immutable;
 *        `Utf8String` field 0 is the UTF-16 length, not the byte length);
 *      - the hash reject only fires when both sides are `$HashedString`,
 *        which a rope never is, so moving it ahead of the flatten cannot
 *        change its verdict.
 *    Only the character loop needs `off`/`data`, so that is where the flatten
 *    belongs. With the flag ON, `bigRopeA === bigRopeB` with differing lengths
 *    answers in O(1) instead of copying both ropes into fresh buffers first.
 *
 * 2. **`__extern_get` flattens its KEY unconditionally**, in the
 *    `stringKeyArms` preamble (`object-runtime.ts`), before the hash dispatch.
 *    Nothing downstream of it needs flat: `ref.test`/`ref.cast $HashedString`
 *    and the baked-hash `struct.get` are `$AnyString`-compatible, `__obj_hash`
 *    is called with the ORIGINAL externref key (not the flattened one), and
 *    the per-bucket probes call `__str_equals`, which flattens its own params.
 *    So the call is pure overhead on every key that reaches the dispatch.
 *
 * ## Why the caller-side flatten before a self-flattening helper is redundant
 *
 * `wrapBodyWithFlatten` gives `__str_equals`, `__str_charAt`, `__str_slice`,
 * `__str_substring`, `__str_substr`, `__str_compare`, `__str_indexOf`,
 * `__str_split`, `__str_replace` (and their siblings) a guarded flatten
 * preamble on their own string params. A `call $__str_flatten` at the call
 * site therefore only pre-computes what the callee's `ref.test` would skip:
 * it never changes the value, it costs one extra call plus a `ref.test`/
 * `ref.cast` per operand, and — the part that matters — it defeats (1) by
 * handing the callee a flat string, so the lazy ordering inside never sees a
 * rope.
 *
 * ## Spelling
 *
 * The `src/perf-flags.ts` token rule: unset ⇒ ON, `0`/`off`/`false`/`no`/empty
 * ⇒ OFF, anything else ⇒ ON. The byte-identity guarantee now hangs off the OFF
 * position rather than off absence — this flag shipped opt-in specifically so a
 * typo could not enable it, and after the flip the same reasoning runs the
 * other way: a typo must not silently DISABLE a measured default.
 */
import type { Instr } from "../ir/types.js";
import { tunedFlagEnabled } from "../perf-flags.js";

export function lazyStrFlattenEnabled(): boolean {
  return tunedFlagEnabled(process.env.JS2WASM_LAZY_STR_FLATTEN);
}

/**
 * The `call $__str_flatten` for a call site whose IMMEDIATE callee already
 * flattens that parameter — empty under the flag, unchanged without it.
 *
 * Self-flattening (built through `wrapBodyWithFlatten`, so safe to elide):
 * `__str_equals`, `__str_compare`, `__str_charAt`, `__str_charAt_cp`,
 * `__str_slice`, `__str_substring`, `__str_substr`, `__str_indexOf`,
 * `__str_lastIndexOf`, `__str_includes`, `__str_split`,
 * `__str_toLowerCase_ascii`, `__str_toUpperCase_ascii`, `__str_replace`,
 * `__str_replaceAll`, `__str_getSubstitution`.
 *
 * Note `native-strings-basics.ts` documents `__str_equals` as taking
 * `ref $NativeString`. That is its LOGICAL contract, not its emitted signature
 * — `native-strings-shared.ts` defines one `strRef` over `anyStrTypeIdx` and
 * uses it for ALL helper params and results. Reading the comment rather than
 * the emitter makes eliding a caller-side flatten look like a type error; it is
 * not.
 *
 * NOT self-flattening — keep the call site's flatten: `__str_repeat`,
 * `__str_padStart`, `__str_padEnd`, `__str_isWellFormed`,
 * `__str_toWellFormed`, `__str_to_extern`, `__str_from_extern`. Also keep it
 * wherever the emitted code itself reads `struct.get $NativeString` off the
 * result (`String.prototype.at`, `codePointAt`), where the flat type is
 * load-bearing rather than incidental.
 */
export function redundantFlattenCall(flattenIdx: number): Instr[] {
  return lazyStrFlattenEnabled() ? [] : [{ op: "call", funcIdx: flattenIdx }];
}

/**
 * The guarded flatten preamble `wrapBodyWithFlatten` prepends, reproduced
 * **byte-for-byte** so a helper can splice it at a LATER point in its own body
 * instead. Empty when `enabled` is false, in which case the caller keeps
 * passing its param indices to `wrapBodyWithFlatten` and nothing moves.
 *
 * The relocation is the whole point: identical instructions, different
 * position, so the ON/OFF difference is WHERE the materialization happens and
 * never WHAT it computes. Splice it immediately before the first read of
 * `off`/`data` — every check above that point (`ref.eq` identity, the
 * `$AnyString` length compare, the `$HashedString` hash reject) is answerable
 * on a rope, and is exactly what the top-of-function placement was preventing.
 *
 * `getFlattenIdx` is a thunk because `__str_flatten` is registered mid-sequence
 * by `ensureNativeStringHelpers`; reading it eagerly can bake a stale index.
 */
export function relocatedFlattenPreamble(
  enabled: boolean,
  strTypeIdx: number,
  getFlattenIdx: () => number,
  paramIndices: readonly number[],
): Instr[] {
  if (!enabled) return [];
  return paramIndices.flatMap<Instr>((index) => [
    { op: "local.get", index },
    { op: "ref.test", typeIdx: strTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index },
        { op: "call", funcIdx: getFlattenIdx() },
        { op: "local.set", index },
      ],
    },
  ]);
}
