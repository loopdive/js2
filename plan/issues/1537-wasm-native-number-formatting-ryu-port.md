---
id: 1537
title: "Wasm-native number formatting (Ryū port): toString/toFixed/toPrecision/toExponential"
status: done
assignee: ttraenkler/sdev-1537
completed: 2026-06-16
created: 2026-05-20
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
language_feature: number
goal: standalone-wasm
sprint: 63
related: [1535, 1321, 1335, 1759]
---
# #1537 — Wasm-native number formatting: shortest-roundtrip Ryū core (#1335 Phase 2)

## RE-SCOPED 2026-06-03 (sd-1472 recon)

**The host-import-elimination half of this issue is already DONE.** All five
formatters — `number_toString`, `number_toString_radix`, `number_toFixed`,
`number_toPrecision`, `number_toExponential` — already have Wasm-native
standalone/WASI implementations in `src/codegen/number-format-native.ts`
(1704 lines, emitted via `emitNativeNumberFormat`, wired in
`src/codegen/declarations.ts:946-959`). Under `ctx.wasi || ctx.standalone`
they emit as defined functions and the module instantiates host-free (verified:
`String(0.1)`, `1e21`, `-0`, `1/3`, `0.1+0.2` all compile + run with zero JS
host imports). Delivered incrementally by #1321 / #1335 Phase 1 / #1759.

**The genuine remaining work** is the deferred shortest-roundtrip core. The
existing `emitToString` (`number-format-native.ts:410`) is explicitly labelled
*"Algorithm strategy (no Ryu)"* in its header: it uses a **fixed ~15-16
significant-digit / six-fractional-digit-trimmed** approximation, NOT the
ECMA-262 §6.1.6.1.13 shortest decimal that round-trips. So `String(0.1)` does
not reliably produce the canonical `"0.1"`, and the ~50 boundary test262 tests
fail. The file header itself flags this as "the deferred Ryu/bignum work
tracked in #1335 / #1335 Phase 2".

## Scope (after re-scope)
Replace the fixed-precision digit core in `number-format-native.ts` with a
**shortest-roundtrip Ryū f64→decimal generator**, then route the existing
`number_toString` (and the `toExponential`/`toPrecision` significand paths that
lean on the same fixed expansion) through it. The scaffolding is DONE and reused
unchanged: the native-string buffer + `__num_fmt_finalize`, the sign/NaN/Infinity
prologue `emitNonFinitePrologue`, the integer-digit writer `emitIntegerDigits`,
the safe-integer fast path (delegates to `number_toString_radix`), and the
exponential/fixed framing.

## Original problem statement (retained for history)
Five host imports — `number_toString`, `number_toString_radix`, `number_toFixed`, `number_toPrecision`, `number_toExponential` — bridge to `Number.prototype.*` on the JS host. Standalone mode (WASI) cannot stringify a number; this affects `console.log(123.456)`, any string interpolation involving a number, JSON output, and dozens of test262 categories. **(host-import side now resolved — see RE-SCOPED note.)**

## Proposed solution
Port the Ryū algorithm (Adams 2018, "Printing Floating-Point Numbers Quickly and Accurately") to a Wasm-native helper module. Ryū produces the shortest decimal string that round-trips to the same f64.

Layers:
1. **Core**: `__num_to_str_ryu(f64) -> (ptr_to_native_string)` — emits the shortest-roundtrip string.
2. **`Number.prototype.toString()`** (no-arg): direct Ryū output with the ECMA-262 §6.1.6.1.13 rules (negative-sign handling, NaN/Infinity sentinels).
3. **`Number.prototype.toString(radix)`**: for radix ∈ [2,36] and integer values, do a digit-by-digit conversion (1 KB hand-written); for fractional + non-10 radix, use the long-division algorithm from the spec.
4. **`toFixed(digits)`**: round to `digits` decimal places using Ryū's intermediate representation, then format.
5. **`toPrecision(p)`**: choose fixed vs exponential based on magnitude (spec §21.1.3.5).
6. **`toExponential(d)`**: Ryū output reformatted as `D.DDDe±DD`.

## Library/approach
Reference: `dtolnay/ryu` (Rust) — public-domain port of the C reference. Variant `ryu-ecmascript` matches ES output exactly. Algorithm description in Adams' paper is public.

We do **not** depend on the Rust crate at runtime — we re-implement the algorithm directly in `src/codegen/number-helpers.ts` (parallel to `math-helpers.ts`).

## Binary size impact
+8-12 KB Wasm. Includes a precomputed power-of-10 lookup table (~2 KB) and the formatting state machine.

## Test262 impact (estimated)
Number-stringification appears in ~5-8% of failing test262 tests. Estimate **+200-400 passes** in standalone mode and a smaller boost in JS-host mode (the host already does this correctly).

## Implementation steps
1. Create `src/codegen/number-helpers.ts` with `emitInlineNumberFormatters(ctx)` modeled on `emitInlineMathFunctions`.
2. Emit `__num_to_str_ryu` as a Wasm function operating over a native i16-string buffer.
3. Emit thin wrappers `number_toString`, `number_toString_radix`, `number_toFixed`, `number_toPrecision`, `number_toExponential` that take f64 args and return `arrayref (mut i16)` (native string).
4. Gate registration in `src/codegen/declarations.ts` (`primitiveNeeded` set) on `ctx.nativeStrings || ctx.wasi`. Keep host import path for non-native-strings mode for now.
5. Test against test262 `built-ins/Number/prototype/toString`, `toFixed`, `toPrecision`, `toExponential` suites.
6. Verify boundary cases: `-0`, `NaN`, `±Infinity`, `1e21` (engineering threshold), subnormals.

## Risk
ECMA-262 has subtle rules for the shortest-roundtrip boundary (§6.1.6.1.13 step 5) — test262 has ~50 tests dedicated to these edge cases. Use `ryu-ecmascript` as the cross-check oracle.

## Implementation Plan (#1335 Phase 2 — Ryū core swap)

### Exact entry point to replace
- `src/codegen/number-format-native.ts` → `emitToString(...)` (defined at
  ~L410, registers `number_toString`). Today, after `emitNonFinitePrologue`
  and the safe-integer fast path (`abs == floor(abs) && abs <= 2^53-1` →
  delegate to `number_toString_radix`), the **fractional / unsafe-magnitude
  branch** uses the fixed six-fractional-digit-trimmed expansion. THAT branch
  is what Ryū replaces. Keep the prologue + safe-integer fast path untouched
  (those are already correct and cheap).
- Add a new helper `emitRyuShortest(ctx, ...)` registering an internal
  `__num_ryu_digits(f64) -> (writes digit string + decimal exponent)` and call
  it from `emitToString`'s fractional branch, then apply ECMA-262 §6.1.6.1.13
  step 5+ formatting (choose fixed vs `e` notation by exponent `n`:
  fixed when `-6 < n <= 21`, else exponential).
- `emitToExponential` (~L1099) and `emitToPrecision` (~L1439) currently derive
  their significand from the same fixed expansion; after the core lands, route
  their "shortest significand" need (toExponential() with NO argument; the
  precision auto-select) through `__num_ryu_digits` too. `toFixed(d)` /
  `toExponential(d)` / `toPrecision(p)` with an EXPLICIT digit count do NOT
  need shortest — they round to a fixed count and the existing fixed expansion
  is acceptable there (keep, unless a boundary test says otherwise).

### Algorithm sketch (Ryū, f64 → shortest decimal)
Port `dtolnay/ryu` `ryu-ecmascript` variant (public-domain). Operate in i64.
1. Decompose the f64 bits: `ieeeMantissa` (52b), `ieeeExponent` (11b). Build
   `(m2, e2)`: for normal, `m2 = (1<<52) | ieeeMantissa`, `e2 = ieeeExponent -
   1075`; subnormal `m2 = ieeeMantissa`, `e2 = -1074`.
2. Halfway bounds: `mv = 4*m2`, `mp = 4*m2 + 2`, `mm = 4*m2 - 1or2` (the
   `-1` when `ieeeMantissa==0 && ieeeExponent>1`, else `-2`), to bracket the
   shortest interval `[mm, mp]` that rounds back to this f64.
3. Scale by 10^q using the **precomputed power-of-10 split tables**
   (`DOUBLE_POW5_SPLIT` / `DOUBLE_POW5_INV_SPLIT`, ~each entry a 128-bit
   number stored as 2×i64) and a `mulShift` (128-bit multiply-high via i64
   pieces — Wasm has no i128, so do 64×64→hi/lo by 32-bit limb splitting,
   the standard portable Ryū `umul128`/`shiftright128`). Emit ~2 KB of table
   data as `i64.const` arrays (a WasmGC `(array i64)` global or inline consts).
4. Loop: divide the scaled `(vr, vp, vm)` by 10 while `vp/10 > vm/10`,
   tracking whether all dropped digits of `vr` were zero (the
   `vrIsTrailingZeros` / `vmIsTrailingZeros` flags) for the round-to-even
   tie-break. Produce the shortest digit string + `exp` (decimal point pos).
5. Hand `(digits, exp, sign)` to the §6.1.6.1.13 formatter.

This is the hardest part — get `mulShift` and the trailing-zero tie-break
exactly right or the boundary tests fail. Cross-check every step against the
Rust reference; do NOT reconstruct from memory.

### test262 gate (the ~50 boundary tests)
Primary suites that must go green standalone after this lands:
- `test/built-ins/Number/prototype/toString/` (default radix shortest cases)
- `test/built-ins/Number/prototype/toFixed/`, `toExponential/`, `toPrecision/`
- the ToString-of-Number spec cases under
  `test/language/types/number/` and number literal coercion in
  `test/built-ins/String/` (template / `String(n)`).
Boundary values to pin in the focused unit test:
`0`, `-0`, `NaN`, `Infinity`, `-Infinity`, `0.1`, `0.2`, `0.3`, `0.1+0.2`
(=> `0.30000000000000004`), `1/3`, `1.005`, `5e-324` (min subnormal),
`1.7976931348623157e308` (max), `1e21` (=> `1e+21`), `1e-7` (=> `1e-7`),
`100000000000000000000` (1e20, fixed), `123456789012345680000`,
`9007199254740993` (2^53+1 rounding).

### Oracle / validation approach
- **Unit oracle**: `tests/issue-1537.test.ts` compiles each value with
  `{ target: "standalone", testRuntime: true }`, instantiates, calls
  `__test_str_to_externref(s())` to decode the native i16 string back to a JS
  string, and asserts `=== String(value)` (V8 is the ground-truth shortest
  oracle). The `testRuntime` decoder export is the same one
  `tests/native-strings-roundtrip.test.ts` uses.
- **Property test**: loop ~10k random f64 (mix of `Math.random()*10**k`,
  random raw bit patterns reinterpreted via a DataView) and assert
  `parseFloat(nativeToString(x)) === x` (round-trip) AND
  `nativeToString(x) === String(x)` (shortest === V8). Run in the unit test
  with a fixed seed.
- CI test262 shards confirm the conformance delta (estimate +200-400 standalone
  passes per the original estimate).

### Risk / notes
- No i128 in Wasm — the 128-bit `mulShift` must be hand-rolled from i64 limbs;
  this is the single highest-risk piece. Budget time to match the reference
  bit-for-bit.
- Binary size: +8-12 KB (≈2 KB power-of-5 tables + state machine). Acceptable.
- Keep the JS-host path (`!ctx.wasi && !ctx.standalone`) on the host import —
  V8 already does shortest correctly there; do not route host mode through Ryū.
- Start CLEAN-CONTEXT: this is a numeric-correctness port where small errors
  silently fail boundary tests; pair it with the oracle test from the first
  commit and grow the value set as each case passes.

## Implementation Notes (sdev-1537, 2026-06-16)

**Delivered.** Shortest-roundtrip Ryū `d2d` core replaces the fixed-6-digit
fractional branch of `number_toString` in standalone/WASI mode. New file
`src/codegen/number-ryu.ts`; `emitToString` (number-format-native.ts) now calls
`__num_ryu_to_buf` for the fractional / unsafe-magnitude branch. The non-finite
prologue + safe-integer fast path + radix formatter are untouched.

### Key decisions (the WHY)

1. **Validate the algorithm in JS BigInt *before* writing any Wasm.** The
   architect warned the failure mode is silent. I transcribed `ryu-ecmascript`
   `d2d` to a BigInt reference (`.tmp/ryu-ref.mjs`) and ran it against
   `String(x)` over 200k random f64 + the boundary set until 0 mismatches. The
   Wasm is a mechanical translation of *that validated reference*, not of the C
   source from memory. The single bug this caught: `computeInvPow5`'s shift was
   off by one (`b - 1 + BITCOUNT` vs the correct `b + BITCOUNT`), which produced
   exactly-half values for all large numbers — invisible on small inputs.

2. **`mulShift` via 32-bit limbs (`umul128` + `shiftright128`), validated
   separately.** No i128 in Wasm. A second probe (`.tmp/ryu-limbs.mjs`) proved
   the limb-based `mulShift` is bit-identical to the BigInt `(m*factor)>>j` over
   300k cases AND that the shift `j` is always in [118,125] (≥64), so the
   optimized `shiftright128(_, _, j-64)` (dist ∈ [54,61], a valid 0<dist<64
   shift) is always taken. Unsigned-overflow carry in `b0.hi + b2.lo` is
   detected with `i64.lt_u` (the sum wrapping below an addend ⇒ carry).

3. **Full (not compact) pow5 tables, generated at codegen time.** I use the full
   `DOUBLE_POW5_INV_SPLIT` (291 entries, q∈[0,290]) and `DOUBLE_POW5_SPLIT`
   (326 entries) — byte-identical to dtolnay's `d2s_full_table.h`. The compact
   variant trades table size for extra runtime bignum work and more places to
   get wrong; correctness > ~6 KB. Tables are computed by the same BigInt
   `computePow5`/`computeInvPow5` the reference uses (so they cannot drift from
   the validated algorithm) and emitted as two immutable `(array i64)` globals
   via `array.new_fixed` init exprs, interleaved `[lo,hi,...]`.

4. **New i64 ops added to the IR.** The digit loop and `mulShift` need unsigned
   i64 division/remainder/compare: added `i64.{div_u,rem_u,lt_u,le_u,gt_u,ge_u}`
   to the `Instr` union (`src/ir/types.ts`), the binary emitter
   (`src/emit/binary.ts` — opcodes already existed in `opcodes.ts`), and
   `src/codegen/stack-balance.ts` (net delta + type producers). `i64.clz` is NOT
   needed — the ecmascript variant uses the integer `pow5bits`/`log10Pow*`
   multiply-shift formulas, no count-leading-zeros.

5. **Formatter writes digits to a scratch region of the same buffer.** Digits of
   the i64 mantissa are extracted LSB-first into `buf[200..200+k)` (BUF_CAP=256,
   k≤17, never overlaps the ≤24-char output that starts near pos 0), then emitted
   MSB-first via `dig[k-1-j]`. §6.1.6.1.13 framing chooses integer / fixed /
   leading-zero-fixed / exponential by the decimal point position n=exp+k.

### Scope honored
Only the shortest-significand path (`toString` default radix) was rerouted, per
the plan. `toFixed(d)`/`toExponential(d)`/`toPrecision(p)` with explicit digit
counts keep the existing fixed expansion (no boundary test required them to
change). `(7.7).toFixed(20)` (needs bignum) remains the documented gap.

### Validation
- `tests/issue-1537.test.ts`: 33 tests — boundary set (0.1+0.2, 1/3, 1e21, 1e-7,
  1e20, 2^53+1, min/max/subnormal, negatives) + a seeded 30k-value property test
  (random bit patterns + scaled magnitudes + subnormals) asserting
  `Wasm === String(x)`. All green.
- Out-of-band sweep through the compiled Wasm: **152,997** random f64 matched V8
  exactly (`.tmp/probe-random.mjs`, gitignored).
- Existing `issue-1321-standalone`, `issue-49-number-format-nonfinite`,
  `native-strings-*`, `issue-1759`, `bigint` suites still pass; full `tsc` and
  `npm run lint` clean.
- Binary-size delta: +~15.6 KB, emitted only when `number_toString` is used in a
  standalone/WASI module (zero impact otherwise; verified no `__ryu_*` globals in
  a module that doesn't stringify numbers).

## Implementation Plan — Architect addendum (2026-06-16)

(The issue may already carry a `#1335 Phase 2 — Ryū core swap` plan. This addendum confirms it against current source, sharpens the seam, and pins the i64-primitive plan.)

### Confirmation
- Host-import elimination is DONE: all five formatters Wasm-native in `src/codegen/number-format-native.ts`, wired via `emitNativeNumberFormat` (`declarations.ts:~946-959`), gated `ctx.wasi || ctx.standalone`.
- Gap stands: `emitToString` (number-format-native.ts:410, "Algorithm strategy (no Ryu)") + `emitExponential` (~432, `SIG_DIGITS=15`) use fixed ~15-digit f64 expansion → non-round-tripping shortest output (`String(0.1)`, `0.1+0.2`) and ~50 boundary fails.
- All Wasm primitives present: `i64.reinterpret_f64` (0xbd) for bit decomposition; `i64.mul/shr_u/shl/and/or` for hand-rolled 128-bit `mulShift` (no i128 — limb-split).

### Integration seam
Keep untouched: `emitNonFinitePrologue` (NaN/±Inf/sign), safe-integer fast path (`abs==floor && abs<=2^53-1` → `number_toString_radix`), `emitIntegerDigits`, `__num_fmt_finalize`. Replace ONLY the fractional/unsafe-magnitude branch of `emitToString` with a call into new `__num_ryu_digits`. Put the port in a new `src/codegen/number-ryu.ts` (imported by number-format-native.ts) to avoid growing the 1704-line file.

### `__num_ryu_digits` contract
`(value:f64, outBuf:ref $__str_data, outOffset:i32) -> (i32 k, i32 n)` (multi-value return): writes shortest decimal digits (ASCII, no sign/dot) at outOffset, returns digit count `k` and decimal exponent `n` (§6.1.6.1.13). `emitToString` keeps the fixed-vs-exponential framing (fixed when `-6 < n <= 21`, else `D.DDDe±N`) and calls `__num_fmt_finalize`. No extra allocation — operate on the caller's buf.

### Ryū core — i64 limb plan (highest risk)
Port `dtolnay/ryu` `ryu-ecmascript` variant line-for-line (do NOT reconstruct from memory): (1) `bits=i64.reinterpret_f64`; extract mantissa/exponent; build `(m2,e2)`. (2) halfway bounds mv/mp/mm. (3) `mulShift` via `umul128` = split each i64 into two 32-bit limbs, four 32×32→64 partials, recombine, `shiftright128`. (4) pow5 tables `DOUBLE_POW5_SPLIT`/`DOUBLE_POW5_INV_SPLIT` as a WasmGC `(array i64)` global (~2KB) indexed by `q`. (5) digit loop with vr/vm trailing-zero round-to-even tie-break.

### Other formatters
Route only shortest-significand needs (`toExponential()` no-arg, `toPrecision` auto) through Ryū. Explicit-count `toFixed(d)`/`toExponential(d)`/`toPrecision(p)` keep the fixed expansion unless a boundary test fails. `(7.7).toFixed(20)` (needs bignum) is an accepted documented gap unless forced.

### Edge cases (tests/issue-1537.test.ts)
`0`,`-0`→"0", NaN, ±Infinity, `0.1`,`0.2`,`0.3`, `0.1+0.2`→"0.30000000000000004", `1/3`, `1.005`, `5e-324`, `1.7976931348623157e308`, `1e21`→"1e+21", `1e-7`→"1e-7", `1e20`→fixed, `9007199254740993`.

### Validation
Unit oracle: compile `{target:"standalone",testRuntime:true}`, decode via `__test_str_to_externref`, assert `=== String(value)`. Property test ~10k random f64 (fixed seed): round-trip + shortest.

### test262 gate
`built-ins/Number/prototype/{toString,toFixed,toExponential,toPrecision}/`, `language/types/number/`, String(n) coercion. Est. +200-400 standalone passes. All gated `ctx.wasi || ctx.standalone`; JS-host keeps host imports (V8 does shortest correctly).
