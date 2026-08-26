---
id: 3305
title: "Self-host stdlib: convert parse-number-native.ts + number-format-native.ts hand-emitted Instr[] to TS (family #2)"
status: in-progress
sprint: current
priority: high
horizon: xl
feasibility: hard
model: gpt-5.6-sol
reasoning_effort: ultra
task_type: refactor
area: codegen, stdlib, ir
language_feature: compiler-internals
goal: ir-full-coverage
created: 2026-07-16
updated: 2026-08-26
assignee: ttraenkler/codex
branch: codex/3305-parsefloat-plan
depends_on: [3256]
related: [2654, 3141, 3256, 3257, 4234]
origin: "#3257 re-scope (2026-07-16) — array-methods.ts measured net-negative-infeasible; family #2 verified as the real Tier-2 target"
---

# #3305 — Self-host the parse/format family (`parse-number-native.ts` + `number-format-native.ts`)

## Problem

`src/codegen/parse-number-native.ts` (1,924 LOC) and
`src/codegen/number-format-native.ts` (1,535 LOC) are family #2 of
`plan/self-hosting-scale-up.md` (est. **−2.8k net**) — and, per the #3257
measurement, the LARGEST remaining self-host target whose units actually
qualify under the net-negative rule
(`reference_selfhost_netnegative_needs_full_elemkind_dialect`): unlike
`array-methods.ts` (call-site inline emitters, re-scoped in #3257 §Result),
these files register **9 discrete fixed-ABI funcMap helpers with pure
algorithm bodies**:

- `parse-number-native.ts`: `parseFloat` (~:149), `__str_to_number` (~:512,
  ~360-line body), `parseInt` (~:1482, ~970-line region).
- `number-format-native.ts`: `__num_fmt_finalize` (~:144),
  `number_toString` (~:507), `number_toString_radix` (~:848),
  `number_toFixed` (~:1075), `number_toExponential` (~:1414),
  `number_toPrecision` (~:1691) — 230–360 LOC each.

## Why it is dialect-ready TODAY (verified 2026-07-16)

The #3256 Tier-1 groundwork covers everything these bodies need — zero new
resolver machinery:

- **Parse direction**: `s.charCodeAt(i)` scans (on-demand `__str_charCodeAt`
  via the driver's resolveFunc arm) + pure f64 arithmetic + `s.length` +
  `.substring`. Whitespace skipping can reuse the self-hosted
  `__sh_str_isWs` (declared `(f64) -> i32` callee).
- **Format direction**: string building via substring-of-literal digit
  tables (`"0123456789abcdefghijklmnopqrstuvwxyz".substring(d, d + 1)`) +
  `+` concat + `""` literals (`emitStringConst` landed in #3256); f64
  decomposition via `Math_floor`/`Math_abs`-style sibling callees (the
  self-hosted Math family is funcMap-registered).
- **ABI preservation**: same thunk discipline as #3256 for any i32
  params/results in the legacy signatures (widen `f64.convert_i32_s` /
  narrow `i32.trunc_sat_f64_s`); string params/results are
  `(ref $AnyString)` on both sides.

## Scope (leaf-first, measure per unit)

1. Convert ONE leaf first (recommend `number_toString_radix` or
   `parseFloat`'s scanner) — prove end-to-end, measure net LOC +
   containment, exactly like #3256 step 2.
2. Then the rest of the 9 helpers, one-or-few per commit, keeping any
   precision-critical kernel hand-written where bit-exactness demands it
   (the escape hatch works both ways — scale-up plan §mechanism 3).
3. Refresh `scripts/godfile-profile-baseline.json` per conversion
   (`node scripts/profile-godfiles.mjs --update`) so the gate ratchets.

## Acceptance

- ≥1 helper self-hosted with hand `Instr[]` deleted and measured net −LOC;
  target the full family (est. −2.5k+).
- Validation: numeric round-trip A/B vs JS semantics (host lane) on a corpus
  incl. ±0, NaN, ±Infinity, denormals, radix 2..36, exponent boundaries,
  `toFixed`/`toPrecision` digit-count edges; standalone + wasi lanes green;
  host lane byte-identical (containment SHA — these helpers only emit in
  native/standalone modes, mirroring #3256's containment shape).
- Both pure-Wasm lanes zero host imports.
- Update `plan/self-hosting-scale-up.md` row 2 with measured compression.

## Non-goals

- `array-methods.ts` (re-scoped, see #3257 §Result), object/map/iterator
  families (Tier-3, #3258 and later).
- `number_toString` (no-radix): delegates to Ryu (`number-ryu.ts`) —
  precision-critical shortest-representation kernel, stays hand-written per
  the escape hatch (scale-up plan §mechanism 3).

## Slice 1 — number_toString_radix (2026-07-16, sendev-3256)

**Landed:** `__sh_num_toString_radix` TS source (`src/stdlib/number-format.ts`)

- the shared `__nfd_*` f64-ABI buffer micro-kernels and emission glue
  (`src/codegen/number-format-selfhost.ts`) + 4-instr legacy thunk. Hand
  `emitToStringRadix` deleted: `number-format-native.ts` 1,712 → 1,361 (−351);
  additions +302, of which ~130 (emitFunc + `__nfd_new/get/set/fin` +
  `__num_fmt_trap`) is family-shared infrastructure that amortizes over the
  remaining units. **Slice net −49; expected family net strongly negative from
  unit 2 on** (same shape as #3256: the strings family's driver cost amortized
  the same way).

**Validation:**

- **Bit-exact hand-equivalence**: 6,195-case A/B hash sweep (main-built vs
  branch-built compilers, same probe source; 177 values incl. NaN/±Inf/±0/
  denormals/MAX_SAFE_INTEGER-trap parity × radices 2..36) — 0 diffs
  (`.tmp/probe-3305-ab.mts`).
- `tests/issue-3305.test.ts`: in-wasm V8-exact corpus, standalone + wasi.
- Existing suites green: issue-1335-standalone, issue-1836(-exp),
  issue-1321(-standalone), issue-1759 (83 tests).
- Host-mode containment: byte-identical SHA (helpers only emit in
  native/standalone modes).
- Known pre-existing V8 divergence inherited unchanged (full f64 fraction
  expansion vs shortest-roundtrip tail, e.g. `(0.1).toString(3)`,
  `(42.42).toString(36)`) — verified failing identically on main; tracked
  under #1335 Phase 2, NOT a regression.

**Dialect notes for the remaining units:** `Math.floor` lowers to the
`f64.floor` intrinsic (#1371 whitelist — no funcMap dependency); the
`__num_fmt_trap()` micro-kernel preserves hand `unreachable` parity; defs
carry the ctx-bound `$__str_data` typeIdx in callee sigs ⇒ no memoKey.

**Remaining units:** `number_toFixed`, `number_toExponential`,
`number_toPrecision` (format side — reuse `__nfd_*`); `parseFloat`,
`__str_to_number`, `parseInt` (parse side — charCodeAt scans, needs the
#3256 string dialect flag).

## HANDOFF (2026-07-16, sendev-3256 → developer; coordinator-directed)

Units 2-6 are handed to a regular developer — the pattern is de-risked and
this file is the spec. sendev-3256 keeps ONLY the slice-1 PR (#3125, draft
until predecessor #3122 lands; sendev un-drafts and self-merges it). The
issue-assignments claim is RELEASED — re-claim with your own agent name.

**Resume instructions:**

1. Branch from `origin/main` AFTER PR #3125 lands (watch for it), or stack
   on the real branch `issue-3305-selfhost-parse-format` if you must start
   sooner (then enqueue only after #3125 merges).
2. Work ONE unit per PR, in this order: `number_toFixed` →
   `number_toExponential` → `number_toPrecision` → `parseFloat` →
   `__str_to_number` → `parseInt` (leaf-first; toPrecision calls
   toFixed/toExponential by funcMap name — keep those callees registered
   before it, which `emitNativeNumberFormat`'s ordering already guarantees).
3. Per unit: mirror the hand body OP-FOR-OP in TS (see
   `TOSTRING_RADIX_SOURCE` in src/stdlib/number-format.ts as the template),
   emit via `emitSelfHostedFunc` + legacy-ABI thunk in
   number-format-selfhost.ts, DELETE the hand emitter, then run the
   VALIDATION LADDER: (a) the 6,195-style main-vs-branch A/B hash sweep
   (adapt `.tmp/probe-3305-ab.mts` — it is the acceptance oracle; V8-exact
   only where main already matched), (b) existing suites
   (issue-1335/1321/1759/1836), (c) host-containment SHA, (d)
   `node scripts/profile-godfiles.mjs --update`.

**Unit-2 recon (toFixed, already done — emitToFixed at
number-format-native.ts:529-745):** structure is prologue → 1e21 ToString
fallback → scale=10^fdig loop → scaled=floor(abs*scale+0.5)
(round-half-away) → int/frac split → '-' → integer digits
(`emitIntegerDigits` — SHARED with toExponential/toPrecision; convert it as
a `__sh_*` sibling or keep hand until its last user converts) → '.' + fdig
fractional digits via pow=scale/10 descending loop. TRAP-PARITY note: none
(no unreachable arm). **ABI gotcha:** the §21.1.3.3 step-5 fallback calls
`number_toString` (returns externref) — an sh body returning `string`
cannot type that call; keep the 1e21 check + `number_toString` call in the
LEGACY THUNK (hand instrs, ~10) and let the sh body handle only the
|x| < 1e21 path.

**Parse-side notes:** sources need `dialect: "native-strings"` on the def
(charCodeAt/substring method plans) — see src/stdlib/strings.ts; whitespace
skip can declare the self-hosted `__sh_str_isWs` `(f64) -> i32` callee
(registered by ensureNativeStringHelpers, which parse-number emission
already runs after). parseInt's radix-36 digit table and sign/prefix scan
are pure charCodeAt f64 loops.

## Slice 2 execution lock — `parseFloat` scanner (2026-08-26, Codex)

This section supersedes the July handoff wherever the two disagree. It is
spec'd against `origin/main @ c4cda3922aa754374faaf09c86b5afd8c35be9bb`
(including the linked-runtime-provider merge and the #3521 parser projection).
Re-resolve symbols before editing; line numbers below are descriptive, not an
API.

The next independently reviewable checkpoint moves only `parseFloat(string)`
and its longest-valid-decimal-prefix scanner. `__str_to_number` and `parseInt`
remain hand-emitted. This is deliberately one public helper per PR: prove the
precision carrier and scan-performance seam before moving the stricter
StringToNumber grammar or radix prefixes. The already-self-hosted
`number_toString_radix` and all current number-format work remain byte-inert.

### Current-main facts and the actual dialect boundary

The July instruction to mirror the hand body op-for-op in ordinary TS is too
broad. Current main carries the significant decimal mantissa as `i64` and uses
`i64.mul`/`i64.add`/`i64.lt_u`. The self-host front end intentionally exposes no
TS `bigint`/i64 arithmetic surface: `typeNodeToIr` accepts the ordinary
number/boolean/string subset, generic IR binary operations do not provide this
i64 scanner algebra, and `stdlib-selfhost.resolveGlobal` deliberately throws.
A direct port would widen inference and lowering for one builtin, which is
outside this migration.

Keep that boundary. The ordinary TS source carries the exact significant
mantissa as two non-negative integer-valued f64 limbs in base 1,000,000,000:

```text
tmp   = lo * 10 + digit
carry = floor(tmp / 1e9)
lo    = tmp - carry * 1e9
hi    = hi * 10 + carry
```

Those four append expressions remain exactly representable f64 integers.
`mant = hi * 1e9 + lo` is only the conceptual identity; evaluating that formula
in f64 would lose integer precision above `2^53`, so reconstruction happens only
with i64 inside `__pnd_finish`. Current main admits a digit when the pre-append
mantissa is `< 900000000000000000`; the exact limb predicate is
`hi < 900000000`. This includes the possible final 19th digit below `9e18` and
`2^63`. Past the cap, integer digits increment `intDrop`; consumed fractional
digits do not increment `fracCount`.

One private fixed-f64-ABI finalizer in `parse-number-native.ts` reconstructs the
i64 only at the backend boundary:

```text
__pnd_finish(hi, lo, sign, fracCount, intDrop, exp, expSign) -> f64
```

It truncates the validated limbs, computes
`i64(hi) * 1_000_000_000 + i64(lo)`, then calls the existing file-local
`emitApplyDecimalExp` path unchanged. That preserves the #2654 integer
mantissa, the #4234 immutable 309-entry `__pow10_f64` table, one table load plus
one multiply/divide for `|totalExp| <= 308`, and the staged tail beyond 308.
This narrow precision kernel is the intended self-host escape hatch. Do not
extract/move the sensitive table code merely for organization.

Exponent accumulation must keep current i32 wrapping semantics exactly with
`(exp * 10 + digit) | 0` (or an equivalently proven fixed-ABI operation). Do not
silently replace it with an unbounded f64 counter. Source must spell exceptional
values without globals (`0 / 0`, `sign * (1 / 0)`); `NaN` and `Infinity`
identifiers must continue to fail the throwing global resolver.

### Exact files and emission order

The implementation checkpoint owns only:

- new `src/stdlib/parse-number.ts` — the ordinary TS source and one
  native-strings self-host descriptor;
- `src/codegen/parse-number-native.ts` — private finalizer, self-host emission,
  canonical public thunk, and deletion of the old `parseFloat` instruction
  body; retain `__str_to_number`, `parseInt`, and their shared helpers;
- new `tests/issue-3305-parsefloat-selfhost.test.ts` plus narrowly relevant
  existing #1836/#2652/#2654/#3305 tests;
- this issue and `plan/self-hosting-scale-up.md` for measured results.

Keep the checkpoint out of `src/codegen/index.ts`, `src/codegen/context/types.ts`,
`src/ir/types.ts`, `src/ir/from-ast.ts`, `src/ir/integration.ts`,
`src/codegen/stdlib-selfhost.ts`, and `src/codegen/number-format-native.ts`.
Current-main work in those hot files makes collision avoidance valuable, but
the stronger reason is architectural: no generic compiler capability is
needed. The runtime-provider cache key includes the compiler bundle hash and is
therefore expected to rotate; containment means its generated Wasm bytes and
export/ABI projection stay identical, not that cache provenance text does.

Emission is leaf-first and fail-closed:

1. `ensureNativeStringHelpers(ctx)` establishes the native string types and
   helpers.
2. Materialize `__pnd_finish` under an exact seven-f64-to-f64 signature.
3. Build/lower the `dialect: "native-strings"`, no-`memoKey` self-host body.
   Follow the existing strings seam: accept the logical string, bind
   `let s: string = __str_flatten(str0)`, derive `len = s.length`, and start at
   `__str_ws_start(s, 0, len)`. Declare exact callee types. Guarded
   `charCodeAt` is already supported, but #3899 measured its generic guarded
   scan at roughly 25 Wasm operations per code unit plus a non-inlined helper.
   Use WAT call census and throughput to decide, not intuition. If that cost is
   present, add only a private
   `__pnd_cu((ref $AnyString), f64) -> f64` wrapper which truncates an already
   bounds-checked index, calls the existing `__str_flat_charCodeAt`, and widens
   its result. Do not add a generic reader/resolver arm.
4. Only after every private dependency succeeds, mint/publish the canonical
   `(externref) -> f64` `parseFloat` thunk. It casts to `$AnyString` and calls
   the self-host body; it does not scan or flatten independently.

Do not reserve the public `parseFloat` name before the private graph is valid.
The ensure path is idempotent. Optimized standalone/WASI output must retain one
effective flatten, no per-call scanner-state allocation, one immutable 309-entry
pow10 table per module, one table load and scaling operation inside its range,
and zero JS-host imports. `optimize: false` is a correctness control. Measure
the optimized `charCodeAt` call density and scan throughput; a material
per-character regression is a HOLD, not a reason to widen the dialect.

### Semantic and structural contract

The new body skips leading StrWhiteSpace, consumes an optional sign, recognizes
the exact `Infinity` spelling, and returns the longest matching
StrDecimalLiteral prefix. Trailing junk and an incomplete exponent do not
invalidate the preceding prefix. It preserves raw-bit behavior for `NaN`,
`+0`, `-0`, finite/subnormal results, signed overflow, the significant-digit
cap, integer-drop compensation, fraction counts, and wrapped exponents.
Non-NaN results compare as raw f64 bits; NaN results compare by classification,
not payload-bit identity.

The retained `__str_to_number` must be bit- and artifact-equivalent after the
nearby edit. Its full-consumption, empty-string, whitespace, signed-prefix, and
`0x`/`0o`/`0b` behavior are not part of this conversion. Poisoning/removing the
old direct `parseFloat` instruction arm must prove the new body is the only
canonical owner; the retained StringToNumber and parseInt bodies must remain
runnable.

### Stages and stop conditions

1. **Carrier proof before deletion.** Prove base-1e9 limb append/carry and cap
   boundaries in isolation, plus the exact finalizer call plan through
   `SelfHostedFuncDef.calleeTypes`. Before publishing the public name, assert
   locally that the materialized finalizer's Wasm type is exactly seven f64
   params to one f64 result. Wrong source arity/type and unknown callees must
   fail during self-host build; a materialized leaf-signature drift must fail
   this assertion; any source global must still hit the throwing resolver.
2. **Add source and leaf finalizer.** Match current main before deleting the old
   body. Prove both pure-Wasm lanes and structural invariants.
3. **Switch one public name and delete.** Remove only the hand `parseFloat`
   scanner. Keep the table/scaling helpers file-local and keep both retained
   parse functions stable through normal stable-regime reconciliation.
4. **Measure before committing.** Production `src/**` must be net-negative and
   `parse-number-native.ts` must shrink materially. If the one-helper slice is
   net-positive, hand `Instr[]` grows outside the bounded finalizer/thunk, or a
   generic resolver/type-system change appears necessary, stop and amend this
   issue. Do not hide the result behind a LOC allowance or silently bundle the
   next public helper.

### Required oracle and fail-closed mutations

Compare a compiler built from the exact current-main base with the candidate,
not merely with V8 where current main has known one-ulp behavior. Compare raw
f64 bits for non-NaNs (including signed zero), NaN classification,
compile/trap result, and selected artifact invariants in standalone and WASI.
Include:

- empty/all-whitespace/all supported StrWhiteSpace; `+0`, `-0`, exact
  `Infinity`/`+Infinity`/`-Infinity`, and near-miss spellings;
- decimal forms with 1–19 significant digits, every dot placement, optional
  signs, incomplete exponents, and leading/trailing junk;
- #2654 cases such as `9007199254740993`, long mixed mantissas, long fractional
  overflow, and exact cap boundaries `899999999999999999`,
  `900000000000000000`, and `8999999999999999999`;
- #4234 indices 0, 1, 22, 23, 307, and 308, then staged-tail cases `1e309`,
  `1e400`, `1e-309`, `1e-320`, and `5e-324`;
- a deterministic large sweep of 1–17 digit mantissas with exponents
  `-400..400`, plus randomized valid/incomplete/trailing-junk forms.

Run a separate current-main-vs-candidate corpus over `__str_to_number` to prove
non-regression of empty/full-consumption/radix behavior. Preserve #4234's
randomized at-most-one-ulp characterization where V8 exactness is not already a
current-main promise.

Mutations must kill at least: a single-f64 mantissa; wrong limb base/carry/cap;
lost `intDrop` or `fracCount`; missing exponent `|0`; stepwise scaling inside
`|exp| <= 308`; missing/duplicated pow10 table; wrong/missing finalizer
name/arity/type; illegal source global; bad public cast; duplicate effective
flatten; allocated scanner state; and resurrection of the old direct body.

### Validation and publication gates

- Focused new test plus `tests/issue-2654.test.ts`, `tests/issue-3305.test.ts`,
  `tests/issue-1836.test.ts`, `tests/issue-1836-exp.test.ts`, and
  `tests/issue-2652.test.ts`.
- Main-vs-candidate A/B in standalone and WASI; the same host-lane fixture's
  compiled Wasm SHA exact; linked-runtime-provider generated Wasm and export/ABI
  projection exact (cache key/manifest provenance may rotate).
- Structural WAT/artifact assertions for one effective flatten, no allocation,
  one immutable 309-entry table, exact private/public ABIs, and zero host
  imports.
- Scan-throughput benchmark versus current main with median and dispersion. A
  material regression is a HOLD even when values match.
- TS 7 and TS 5 typechecks, formatting/lint, IR fallback and strict/hybrid
  readiness gates, all equivalence shards, focused root tests, function-size
  oracle, god-file profile, and LOC-regrowth ratchet.
- Immediately before commit, recheck the strict finite/non-negative one-minute
  gate (`load < logicalCores - 2`), run `pnpm run check:loc-budget`, and run the
  complete precommit hook. Push normally with the complete prepush hook; never
  skip either hook.

Publish this implementation as its own ready, non-draft checkpoint PR. Record
the exact base/head, production LOC delta, A/B digests/counts, performance
numbers, host/runtime-provider containment hashes, and full hook results here
before requesting merge. `__str_to_number`, `parseInt`, and the remaining
number-format helpers stay scheduled as later independent checkpoints.

### Slice 2 measured HOLD and raw-descriptor carrier amendment (2026-08-26, Codex)

The first implementation attempt validates the semantic carrier but fails both
publication stops above. It is diagnostic evidence, not an acceptance
checkpoint, and remains uncommitted in the implementation worktree based on
`c3178e5911e677f8b64141e913d9c5af8ca484b1` (source parent
`c4cda3922aa754374faaf09c86b5afd8c35be9bb`):

- the base-1e9 source scanner, seven-f64 finalizer, standalone/WASI paths, and
  raw-result oracle pass the focused 7/7 tests; #2654 **Standalone: parseFloat /
  Number(string) decimal fraction precision** passes 35/35; TS 7 passes;
- the generic guarded reader measured 6.138 ms median against the hand
  baseline's 1.253 ms, or 4.90×. The bounded
  `__pnd_cu(ref $AnyString, f64)` wrapper still measured 5.048 ms, or 4.03×;
- in the 50,000-call, 21-sample optimized-standalone length control, hand
  medians for 1/8/20/60 digits were 0.378/0.695/1.073/2.154 ms, while the
  wrapper checkpoint measured 0.597/1.765/3.965/7.916 ms. The significant-limb
  `(20-8)/12` and post-cap `(60-20)/40` slopes remain materially worse;
- production code is net +19 lines (`parse-number-native.ts` −122 plus the new
  source +141). No LOC allowance, baseline update, commit, push, or PR exists.

The hot-path cause is exact: `__str_flat_charCodeAt` retains the logical string
carrier so every code unit pays a proven `ref.cast`, two `struct.get` loads, an
offset add, and the f64-to-i32 index truncation. That design is correct for a
general prepared IR unit, but this private stdlib-selfhost graph is emitted
directly and already supports context-bound raw reference parameters when it
has no `memoKey`. Slice 1 uses the same supported mechanism for its private
`$__str_data` buffer kernels. Do not widen JS inference, the generic IR type
surface, prepared-component reference support, or a backend resolver to repair
this private scanner.

This amendment supersedes only emission-order steps 3–4 and the fixed
`__pnd_cu(ref $AnyString, f64)` clause above. The semantic, precision,
containment, fail-closed, net-negative, and load/hook gates remain literal.

#### Exact raw carrier and publication boundary

1. Make `parseFloatSelfHostedDef(dataRef)` context-bound and keep it without a
   process `memoKey`. Its private source signature is
   `__sh_parseFloat(flat: string, data: unknown, off: number, len: number) ->
   number`; the exact initial descriptor types are
   `[string, ref $__str_data, f64, f64] -> f64`. `unknown` is the intentional TS
   spelling for the override-authoritative raw reference. Remove the source's
   `__str_flatten` call and `.length` read. The existing
   `__str_ws_start(flat, 0, len)` remains the exact StrWhiteSpace oracle; its
   result is a logical index, so every digit read uses absolute
   `off + logicalIndex` and the scan end is `off + len`.
2. Change the private reader to
   `__pnd_cu(ref $__str_data, f64 absoluteIndex) -> f64`. Its complete body is
   the exact raw load projection: get the data ref, truncate the already-proven
   in-range absolute index once, `array.get_u`, and widen the code unit. It must
   contain no flatten, cast, struct access, allocation, bounds branch, global,
   import, or indirect call. The optimized scanner must inline or otherwise
   eliminate the per-code-unit helper call so its digit/fraction/exponent loops
   contain the same direct raw-load kernel as the retained hand body.
3. Move the one materializing flatten to the canonical public
   `(externref) -> f64` thunk. After extern-to-`$AnyString`, bind exactly one
   `$NativeString` local, call `__str_flatten` once, and read `.data`, `.off`,
   and `.len` once each. Pass those exact values plus the flat logical carrier
   to the private source body. A whitespace helper may receive that already-flat
   carrier, but it must not allocate or materialize a second representation;
   no digit/fraction/exponent loop may reload the descriptor. Publish the public
   `parseFloat` name only after the raw reader, finalizer, self-hosted body, and
   public thunk signature all validate.
4. Preserve nonzero substring-view offsets exactly. Absolute `i` and `end`
   retain current signed-i32 index/addition semantics; neither a logical index
   nor `len` may be used directly against the raw array. Keep one immutable
   pow10 table, the exact i64 reconstruction/scaling kernel, zero scanner-state
   allocation, and zero JS-host imports.

Add exact materialized-signature checks for the raw reader and four-parameter
self-hosted body beside the existing seven-f64 finalizer check. Mutations must
reject a foreign/raw-data type index, nullable or wrong raw ref, logical instead
of absolute index, swapped/missing `off` or `len`, source/descriptor arity or
type drift, a public thunk that extracts from a different flat object, duplicate
flatten/descriptor loads, a retained cast/struct load in the hot reader, a
stale private funcMap identity, and any partial public-name publication. Add a
nonzero-offset view control and retain every earlier carrier/precision mutation.

#### Performance-preserving prototype ladder

The raw descriptor is necessary but may not be sufficient: the current TS body
still carries `i`/`end` as f64, so every read truncates its index and every loop
uses f64 compare/increment. Existing canonical char-read-loop promotion does
not apply to this multi-loop helper-call scanner. Prototype in this exact order,
without committing either failed stage:

1. **Raw/f64 stage.** Implement the contract above and run the full interleaved
   benchmark against the exact source base.
2. **Raw/i32 stage if needed.** If any slope gate fails, change only the private
   reader ABI to `(ref $__str_data, i32) -> f64` and make absolute `i`/`end`
   provably i32 in the ordinary source with one conversion after whitespace
   start and explicit `| 0` preservation on initialization and every write.
   Do not change mantissa limbs or widen generic i32 inference. Optimized WAT
   must then contain no per-read `i32.trunc_sat_f64_s` and must use i32
   comparison/increment in every scan loop.

For each stage, interleave exact hand base, the rejected AnyString checkpoint,
and candidate runs under the strict finite/non-negative
`oneMinuteLoad < logicalCores - 2` gate. Use the same compiler options, fixture,
warmup, 50,000-call samples, and 21 samples at 1/8/20/60 digits; record median,
p25, p75, checksum, raw result bits, and exact WAT operation/call census. Also
cover leading whitespace, fraction-heavy, exponent, Infinity, and trailing-junk
paths so a faster digit-only special case cannot hide another lost scan
optimization.

Advance only when all candidate results match the hand base, every 8/20/60
median ratio and both `(20-8)/12` and `(60-20)/40` slope ratios are at most
1.10, and their paired-bootstrap 95% upper bounds are at most 1.15. The 1-digit
control must show only bounded fixed call/thunk cost, not a per-character
descriptor cost. Independently require optimized WAT to retain one effective
flatten, one descriptor extraction, direct `array.get_u` reads, and no
per-character cast/struct load/allocation; performance alone cannot excuse a
structural optimization loss. A failed raw/i32 stage leaves Slice 2 on HOLD.

Finally remeasure production LOC. The accepted slice must remain honestly
net-negative and materially shrink `parse-number-native.ts`; do not minify the
ordinary source, move executable text into tests/generated data, grant a LOC
allowance, or silently add `__str_to_number`/`parseInt` to amortize a positive
result. If correctness and performance pass but LOC is still nonnegative,
record the exact residual and amend the issue before changing unit scope.
